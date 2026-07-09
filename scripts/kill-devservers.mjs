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
// ORDER MATTERS. `timeout` kills only `npm`; the tree it spawned survives:
//     npm run dev -> electron-vite -> electron (+ esbuild)
// electron-vite is a supervisor — kill electron first and it cheerfully respawns
// it. So reap PARENT FIRST (electron-vite), then electron, then esbuild, and loop
// until a pass finds nothing. Killing the child first is why the old
// `kill_electron` left a 50-77% CPU floor that starved MILESTONE's 16 PTY spawns.
//
// SAFETY: only processes whose command line names THIS repository are killed
// (electron and esbuild live in its node_modules, so their argv[0] carries the
// path). Another project's vite/next dev server is never touched.
import { execFileSync } from 'node:child_process'

const repo = process.cwd()
const isWin = process.platform === 'win32'
const quiet = process.argv.includes('--quiet')
const want = repo.replace(/\//g, '\\').toLowerCase()

/** Parent-first: the supervisor, then what it would respawn.
 *  The DETACHED PTY DAEMON is spared even though it is this repo's electron.exe: it is not
 *  part of any dev-server tree (ADR 0006 — it outlives apps on purpose, holding live agent
 *  sessions). Sweeping it here is how "run the smokes" used to murder the user's real
 *  sessions; a smoke's own isolated daemon is reaped by qa-smokes' kill_daemon via the pid
 *  in its endpoint.json, which is the only scoped way to name one. */
const isDaemon = (c) => c.includes('daemon.js')
const TIERS = [
  { name: 'electron-vite', match: (n, c) => n === 'node.exe' && c.includes('electron-vite') },
  { name: 'electron', match: (n, c) => n === 'electron.exe' && !isDaemon(c) },
  { name: 'esbuild', match: (n) => n === 'esbuild.exe' }
]

/** Every running process of this repo, as {pid, name, cmd}. */
function snapshot() {
  try {
    if (isWin) {
      const ps = `Get-CimInstance Win32_Process | Where-Object { $_.Name -in 'node.exe','electron.exe','esbuild.exe' } | ForEach-Object { "$($_.ProcessId)|$($_.Name)|$($_.CommandLine)" }`
      const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
      return out
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [pid, name, ...rest] = l.split('|')
          return { pid: Number(pid), name: (name ?? '').toLowerCase(), cmd: rest.join('|').toLowerCase() }
        })
        .filter((p) => p.pid && p.cmd.includes(want))
    }
    const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.includes(repo) && !l.includes('kill-devservers'))
      .map((l) => {
        const pid = Number(l.split(/\s+/)[0])
        const cmd = l.toLowerCase()
        const name = cmd.includes('electron-vite') ? 'node.exe' : cmd.includes('esbuild') ? 'esbuild.exe' : 'electron.exe'
        return { pid, name, cmd }
      })
      .filter((p) => p.pid)
  } catch {
    return [] // no powershell / no ps — nothing we can do, and nothing we should break
  }
}

/** PIDs of this repo's dev-tree processes, parent-first. */
function find() {
  const procs = snapshot()
  const out = []
  for (const tier of TIERS) for (const p of procs) if (tier.match(p.name, p.cmd)) out.push(p.pid)
  return out
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// Kill in a loop, not once-then-wait: a dying electron-vite can still be forking
// (esbuild service, the renderer's vite server), so a process that did not exist
// at the first pass can exist at the second.
let killed = 0
const deadline = Date.now() + 15_000
let left = 0
for (;;) {
  const pids = find() // parent-first, so the supervisor dies before its child
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
  sleep(150) // let the OS reap before we re-check, or we kill the same pid twice
}

if (!quiet && (killed || left)) console.log(`  reaped ${killed} dev-tree process(es)${left ? `, ${left} STILL ALIVE` : ''}`)
process.exit(left ? 1 : 0)
