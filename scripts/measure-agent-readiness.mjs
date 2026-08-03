// Measures WHEN an agent CLI's TUI actually starts accepting keystrokes, against the
// signals we could dismiss a loading overlay on. This exists to settle one question with
// numbers instead of folklore: is there a signal we can observe that means "the pane is
// the user's now"?
//
// WHY IT MATTERS. The launch overlay covers a pane and blocks input while the CLI boots.
// Dismissing it too early loses the user's first keystrokes (claude clears stdin during
// its splash — anthropics/claude-code#23513, closed *not planned*, no readiness signal
// offered). Dismissing it on a timer is a lie that breaks on a slow machine. So the
// overlay may only ship for a CLI where a real signal provably lands at-or-after the
// moment input starts working.
//
// WHAT IT MEASURES, all from one PTY session:
//   · TUI protocol markers, timestamped: alternate screen (?1049h/?1047h/?47h), kitty
//     keyboard (ESC[>Nu), cursor-shape negotiation (ESC[>Nq), synchronized output
//     (ESC[?2026h). These are what agentlaunch-smoke already uses to detect a live TUI.
//   · claude's own session registration file (~/.claude/sessions/<PID>.json): when it
//     appears, and when it first carries a `status` key.
//   · THE GROUND TRUTH — input readiness, bracketed. A distinct token is typed on a
//     schedule and, at the end, we look at what SURVIVED in the CLI's input box. An
//     echo alone proves nothing: before the CLI takes the tty the SHELL echoes the same
//     bytes, and characters typed into a booting TUI are echoed and then eaten when it
//     clears stdin and repaints. Only "still in the input box at the end" proves the
//     keystroke was kept. The earliest surviving token bounds readiness from above; the
//     last token that vanished bounds it from below. Nothing is ever submitted (no
//     Enter), so no turn runs and no tokens are spent; the process is killed at the end.
//
// READING THE RESULT: a signal is USABLE only if its timestamp is >= the upper bracket
// of input readiness (it may fire later — the overlay just lifts a touch late; it must
// never fire earlier, which would hand over a pane that eats keystrokes).
//
// Usage:  ELECTRON_RUN_AS_NODE=1 <electron> scripts/measure-agent-readiness.mjs [claude|<bin>] [ms]
// node-pty is a native module built for this app's runtime, hence Electron-as-node.

import { spawn } from 'node-pty'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BIN = process.argv[2] || 'claude'
const BUDGET_MS = Number(process.argv[3] || 30_000)

/** The TUI-takeover markers, in the same repertoire agentlaunch-smoke.ts recognizes. */
const MARKERS = [
  ['alt-screen', /\x1b\[\?(?:1049|1047|47)h/],
  ['kitty-keyboard', /\x1b\[>\d*u/],
  ['cursor-shape', /\x1b\[>\d*q/],
  ['sync-output', /\x1b\[\?2026h/],
  ['bracketed-paste', /\x1b\[\?2004h/],
  ['mouse-tracking', /\x1b\[\?100[0-9]h/]
]

/** Typed probes: rare enough not to collide with the CLI's own chrome, and each one
 *  identifies the exact instant it was typed. */
const PROBE_EVERY_MS = 250
const probeToken = (n) => `zq${n}`

const t0 = Date.now()
const at = () => Date.now() - t0

const firstSeen = new Map() // marker/probe -> ms
const typedAt = new Map() // probe token -> ms
let raw = ''

// Claude's session registration file, watched for creation and for its first `status`.
const sessionsDir = join(homedir(), '.claude', 'sessions')
const before = new Set(existsSync(sessionsDir) ? readdirSync(sessionsDir) : [])
let sessionFile = null

function pollSessionFile() {
  try {
    if (!sessionFile) {
      for (const name of readdirSync(sessionsDir)) {
        if (before.has(name)) continue
        sessionFile = join(sessionsDir, name)
        firstSeen.set('sessions/<pid>.json created', at())
        break
      }
    }
    if (sessionFile && !firstSeen.has('sessions/<pid>.json has status')) {
      const j = JSON.parse(readFileSync(sessionFile, 'utf8'))
      if (j && typeof j.status === 'string') firstSeen.set('sessions/<pid>.json has status', at())
    }
  } catch {
    /* mid-write or absent — try again next tick */
  }
}

// Strip the nesting markers: launched from inside a Claude session, claude would think it
// is a nested child and change its own behavior (it disables transcript saving).
const env = { ...process.env }
for (const k of Object.keys(env)) {
  if (/^CLAUDE(CODE)?(_|$)/i.test(k) && !/^CLAUDE_CONFIG_DIR$/i.test(k)) delete env[k]
}

const pty = spawn(process.platform === 'win32' ? 'cmd.exe' : 'sh', [], {
  name: 'xterm-256color',
  cols: 120,
  rows: 30,
  cwd: process.cwd(),
  env
})

let launched = false
pty.onData((chunk) => {
  raw += chunk
  // Markers only count AFTER our launch line is typed: the host shell and ConPTY emit
  // their own mode-setting noise at startup, which is not the agent's TUI coming up.
  if (!launched) return
  for (const [name, re] of MARKERS) {
    if (!firstSeen.has(name) && re.test(chunk)) firstSeen.set(name, at())
  }
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const run = async () => {
  // The shell needs a beat, then we type the launch line exactly as the app does.
  await sleep(400)
  pty.write(`${BIN}\r`)
  launched = true
  const launchAt = at()

  let n = 0
  const poll = setInterval(pollSessionFile, 100)
  while (at() < BUDGET_MS) {
    const token = probeToken(n++)
    typedAt.set(token, at())
    pty.write(token) // never Enter: nothing is ever submitted
    await sleep(PROBE_EVERY_MS)
  }
  clearInterval(poll)

  // THE MEASUREMENT: let the TUI settle, then ask what is still on screen. Tokens the
  // CLI kept are sitting in its input box; tokens typed too early were echoed by the
  // shell (or by the booting TUI) and then wiped by the first full repaint.
  await sleep(1200)
  const finalScreen = raw.slice(-20_000)
  // THE LOSS WINDOW IS IN THE MIDDLE, NOT AT THE FRONT. Measured against claude: the
  // keystrokes typed BEFORE the CLI starts reading are buffered by the pty and arrive
  // intact, then a run of keystrokes typed DURING the TUI mount is swallowed when it
  // takes the terminal and repaints, and everything after that is kept. So the bound
  // that matters is the LAST loss anywhere, not the last loss before the first success
  // — a front-only scan reports "nothing was lost" while three keystrokes vanished.
  let lastLost = null
  let firstKept = null
  const lost = []
  // The final probes are excluded: a keystroke typed a moment before the capture may
  // simply not have been rendered yet, and counting it as "lost" invents a loss window
  // seconds after the real one (observed: a bogus 8.9s bound from the very last probe).
  const settleCutoff = at() - 1500
  for (const [token, when] of typedAt) {
    if (finalScreen.includes(token)) {
      if (firstKept === null) firstKept = { token, when }
    } else if (when <= settleCutoff) {
      lastLost = { token, when }
      lost.push(token)
    }
  }

  const rows = [...firstSeen.entries()]
    .filter(([k]) => !k.startsWith('zq'))
    .sort((a, b) => a[1] - b[1])

  console.log(`\n=== ${BIN} readiness (ms from process start; launch typed at ${launchAt}ms) ===`)
  for (const [name, ms] of rows) console.log(`  ${String(ms).padStart(6)}  ${name}`)
  console.log('\n--- INPUT READINESS (ground truth: what survived in the input box) ---')
  console.log(`  keystrokes LOST      : ${lost.length ? `${lost.length} (${lost.join(' ')})` : 'none'}`)
  console.log(`  LAST loss (the bound): ${lastLost ? `${lastLost.when}ms (${lastLost.token})` : 'none — every keystroke was kept'}`)
  console.log(`  first keystroke KEPT : ${firstKept ? `${firstKept.when}ms (${firstKept.token})` : 'NONE — nothing survived in budget'}`)
  console.log('\n--- VERDICT PER SIGNAL (usable = fires at or after the last LOST keystroke) ---')
  if (!firstKept) {
    console.log('  nothing survived — cannot validate any signal from this run')
  } else {
    for (const [name, ms] of rows) {
      const usable = ms >= (lastLost?.when ?? 0)
      console.log(`  ${usable ? 'USABLE   ' : 'TOO EARLY'} ${name} @${ms}ms`)
    }
    console.log(`\n  (a signal at >= ${lastLost ? lastLost.when : 0}ms never hands over a pane that eats keystrokes)`)
  }
  if (process.env.READINESS_DUMP) {
    // The honesty check on this experiment: see the screen the verdict was read from.
    const plain = finalScreen
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\r/g, '')
      .split('\n')
      .map((l) => l.trimEnd())
      .filter(Boolean)
    console.log('\n--- FINAL SCREEN (tail) ---')
    console.log(plain.slice(-14).join('\n'))
    console.log(`--- probes typed: ${typedAt.size}, present in final screen: ${[...typedAt.keys()].filter((t) => finalScreen.includes(t)).length}`)
  }
  try {
    pty.kill()
  } catch {
    /* already gone */
  }
  process.exit(0)
}

run().catch((e) => {
  console.error('experiment failed:', e)
  try {
    pty.kill()
  } catch {
    /* ignore */
  }
  process.exit(1)
})
