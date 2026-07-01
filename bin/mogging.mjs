#!/usr/bin/env node
// The `mogging` CLI. Two subcommands:
//   mogging [<dir>]                 open/focus a MoggingLabs Workspace for a directory (default)
//   mogging notify --event <e> ...  raise the CURRENT pane's attention (Phase-2/04)
// Auth is never brokered here (ADR 0002) — `open` just launches a deep link; `notify` sends an
// event LABEL to the local daemon over its authed socket (no credentials, no PTY content).
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import net from 'node:net'

const argv = process.argv.slice(2)

if (argv[0] === 'notify') {
  runNotify(argv.slice(1))
} else {
  runOpen(argv)
}

// --- mogging . / mogging <dir> ------------------------------------------------------------------

function runOpen(args) {
  const dir = resolve(args[0] ?? '.')
  const url = `mogging://open?cwd=${encodeURIComponent(dir)}`
  const platform = process.platform
  if (platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
  } else if (platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
  }
  process.stdout.write(`mogging: opening workspace for ${dir}\n`)
}

// --- mogging notify -----------------------------------------------------------------------------

/** Parse `--event X --message Y --pane Z` plus bare positionals. */
function parseFlags(args) {
  const out = { _: [] }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--event' || a === '-e') out.event = args[++i]
    else if (a === '--message' || a === '-m') out.message = args[++i]
    else if (a === '--pane' || a === '-p') out.pane = args[++i]
    else out._.push(a)
  }
  return out
}

/** Codex passes its notify payload as a JSON blob; map its `type` to our event vocabulary. */
function codexTypeToEvent(type) {
  switch (type) {
    case 'agent-turn-complete':
      return 'done'
    case 'approval-requested':
    case 'approval_requested':
      return 'needs-input'
    default:
      return 'needs-input'
  }
}

function bail(msg) {
  // A hook must never fail the agent it's attached to: warn on stderr, exit 0.
  process.stderr.write('mogging notify: ' + msg + '\n')
  process.exit(0)
}

function runNotify(args) {
  const opts = parseFlags(args)
  const paneId = opts.pane ?? process.env.MOGGING_PANE_ID
  const endpointFile = process.env.MOGGING_DAEMON_ENDPOINT

  // Resolve the event. Codex hands us a JSON blob (via --event or a positional); Claude/Gemini
  // and manual use pass a plain label. Detect JSON and translate; carry a short message only.
  const raw = opts.event ?? opts._[0] ?? ''
  // `message` is only ever an explicit, caller-supplied label — never agent/PTY content.
  const message = opts.message
  let event = raw
  if (typeof raw === 'string' && raw.trim().startsWith('{')) {
    // Codex hands us its event JSON; take ONLY the event type, never the message content that
    // rides along in it (no PTY/agent output crosses the wire — ADR 0002 / Phase-2/04 guardrail).
    try {
      event = codexTypeToEvent(JSON.parse(raw).type)
    } catch {
      event = 'needs-input'
    }
  }
  if (!event) event = 'needs-input'

  if (!paneId || !endpointFile) {
    bail('not inside a MoggingLabs pane (MOGGING_PANE_ID / MOGGING_DAEMON_ENDPOINT unset); skipping')
  }

  let ep
  try {
    ep = JSON.parse(readFileSync(endpointFile, 'utf8'))
  } catch {
    bail('cannot read the daemon endpoint file; skipping')
    return
  }

  const sock = net.connect(ep.address)
  sock.setEncoding('utf8')
  let buf = ''
  let settled = false
  const finish = (code) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    try {
      sock.destroy()
    } catch {
      /* ignore */
    }
    process.exit(code)
  }
  const timer = setTimeout(() => finish(0), 4000) // never hang a hook

  sock.on('connect', () => {
    sock.write(JSON.stringify({ t: 'hello', v: ep.version, token: ep.token }) + '\n')
  })
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
      if (m.t === 'welcome') {
        sock.write(JSON.stringify({ t: 'notify', id: String(paneId), event, message }) + '\n')
      } else if (m.t === 'notified') {
        if (!m.ok) process.stderr.write('mogging notify: unknown pane ' + paneId + '\n')
        finish(0)
      } else if (m.t === 'error') {
        process.stderr.write('mogging notify: ' + (m.reason || 'error') + '\n')
        finish(0)
      }
    }
  })
  sock.on('error', (e) => {
    process.stderr.write('mogging notify: ' + e.message + '\n')
    finish(0)
  })
}
