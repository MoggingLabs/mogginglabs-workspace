#!/usr/bin/env node
// Reap this repo's lingering `electron-vite dev` processes (Phase-8.5/02).
//
// THE RACE this closes. `npm run dev` returns as soon as the smoke calls
// app.exit(), but the electron-vite process it spawned stays alive for a few
// more seconds tearing down its watcher. qa-smokes.sh then starts the NEXT gate
// immediately; that gate's electron-vite rebuilds out/main/index.js, and the
// dying one — still watching out/ — clears it. Electron launches into the gap:
//
//     start electron app...
//     App threw an error during load
//     Error: ENOENT: no such file or directory, open '...\out\main\index.js'
//
// The gate never runs, writes no result JSON, and reads as MISSING. It is
// intermittent (it needs the two to overlap), which is why an idle machine
// sweeps 52/52 and a busy one loses three gates. `kill_electron` never caught it:
// the straggler is node.exe, not electron.exe.
//
// SAFETY: only node processes whose command line names electron-vite AND this
// repository are killed. Another project's vite/next dev server is never touched.
import { execFileSync } from 'node:child_process'

const repo = process.cwd()
const isWin = process.platform === 'win32'
const quiet = process.argv.includes('--quiet')

/** PIDs of this repo's electron-vite processes. */
function find() {
  try {
    if (isWin) {
      // The command line is `"node" "<repo>\node_modules\electron-vite\bin\electron-vite.js" dev`,
      // so it names both. Match on both; compare paths case-insensitively.
      const ps = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*electron-vite*' } | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }`
      const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
      const want = repo.replace(/\//g, '\\').toLowerCase()
      return out
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const i = l.indexOf('|')
          return { pid: Number(l.slice(0, i)), cmd: l.slice(i + 1) }
        })
        .filter((p) => p.pid && p.cmd.toLowerCase().includes(want))
        .map((p) => p.pid)
    }
    const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out
      .split('\n')
      .filter((l) => l.includes('electron-vite') && l.includes(repo) && !l.includes('kill-devservers'))
      .map((l) => Number(l.trim().split(/\s+/)[0]))
      .filter(Boolean)
  } catch {
    return [] // no powershell / no ps — nothing we can do, and nothing we should break
  }
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// Kill in a loop, not once-then-wait: a dying electron-vite can still be forking
// (esbuild service, the renderer's vite server), so a process that did not exist
// at the first sweep can exist at the second. Keep killing until a full pass
// finds nothing, or we run out of patience.
let killed = 0
const deadline = Date.now() + 10_000
let left = 0
for (;;) {
  const pids = find()
  left = pids.length
  if (!left || Date.now() > deadline) break
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
      killed++
    } catch {
      /* already gone — that is the good case */
    }
  }
  sleep(100)
}

if (!quiet && (killed || left)) console.log(`  reaped ${killed} lingering electron-vite process(es)${left ? `, ${left} STILL ALIVE` : ''}`)
process.exit(left ? 1 : 0)
