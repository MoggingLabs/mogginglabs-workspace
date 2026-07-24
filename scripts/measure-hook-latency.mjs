// Measures the REAL cost of one notify-hook fire: a cold `node` spawn running the shipped
// notify artifact through its full daemon handshake (hello -> welcome -> notify -> notified)
// against a fixture endpoint — the exact critical-path work a synchronous agent hook adds.
//
// This exists to settle the tool-signal decision in docs/21-agent-state-signals.md §7 with
// numbers instead of estimates: Claude hooks run synchronously (the agent waits), so the
// per-fire latency multiplied by each candidate's fire count IS the per-turn cost:
//   PostToolBatch              ~1 fire per model step   (~N_steps fires / turn)
//   PreToolUse + PostToolUse   2 fires per tool call    (~2 x N_tools fires / turn)
//
// Usage: node scripts/measure-hook-latency.mjs [iterations]   (default 40)
// Run on a QUIET machine — a loaded box inflates cold-spawn times (see the perf-gate house
// rule). Prints per-fire median/p95/max and the modeled per-turn cost of each candidate.

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import * as net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ITER = Number(process.argv[2]) || 40
const dir = join(tmpdir(), `mogging-hookcost-${process.pid}`)
mkdirSync(dir, { recursive: true })

const address =
  process.platform === 'win32' ? `\\\\.\\pipe\\mogging-hookcost-${process.pid}` : join(dir, 'cost.sock')

// Just enough daemon: hello -> welcome, notify -> notified (the notifyparity fixture's shape).
const server = net.createServer((sock) => {
  sock.setEncoding('utf8')
  let buf = ''
  sock.on('data', (chunk) => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line) continue
      let m
      try {
        m = JSON.parse(line)
      } catch {
        continue
      }
      if (m.t === 'hello') sock.write(JSON.stringify({ t: 'welcome' }) + '\n')
      else if (m.t === 'notify') sock.write(JSON.stringify({ t: 'notified', ok: true }) + '\n')
    }
  })
  sock.on('error', () => {})
})

const endpointFile = join(dir, 'endpoint.json')

/** One cold fire, wall-clock spawn -> exit. Serial on purpose: hooks fire serially on the
 *  agent's critical path, and parallel spawns would only measure scheduler contention. */
function fireOnce(cli) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint()
    const p = spawn('node', [cli, 'notify', '--event', 'busy'], {
      env: { ...process.env, MOGGING_PANE_ID: '7', MOGGING_DAEMON_ENDPOINT: endpointFile },
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true
    })
    p.on('error', reject)
    p.on('exit', () => resolve(Number(process.hrtime.bigint() - t0) / 1e6))
  })
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]

server.listen(address, async () => {
  writeFileSync(endpointFile, JSON.stringify({ address, version: 1, token: 'cost-token' }))
  const cli = join(process.cwd(), 'bin', 'mogging.mjs')
  try {
    await fireOnce(cli) // warm the OS file cache once; every measured fire is still a cold spawn
    const samples = []
    for (let i = 0; i < ITER; i++) samples.push(await fireOnce(cli))
    samples.sort((a, b) => a - b)
    const median = pct(samples, 50)
    const p95 = pct(samples, 95)
    const stats = {
      iterations: ITER,
      perFireMs: { median: +median.toFixed(1), p95: +p95.toFixed(1), max: +samples[samples.length - 1].toFixed(1) },
      // The audit's reference turn: ~100 tool calls across ~100 model steps (§7).
      perTurnMs: {
        postToolBatch_100steps: +(median * 100).toFixed(0),
        prePlusPostToolUse_100tools: +(median * 200).toFixed(0)
      }
    }
    console.log(JSON.stringify(stats, null, 2))
  } finally {
    server.close()
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
})
