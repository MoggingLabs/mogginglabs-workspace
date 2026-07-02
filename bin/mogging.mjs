#!/usr/bin/env node
// The `mogging` CLI.
//   mogging [<dir>]                  open/focus a MoggingLabs Workspace for a directory (default)
//   mogging notify --event <e> ...   raise the CURRENT pane's attention (Phase-2/04)
//   mogging list                     enumerate live panes (id, size, state, title)   (Phase-3/01)
//   mogging send <pane> <text...>    type into a pane (appends Enter unless --no-enter)
//   mogging send-key <pane> <key>    press a named key (enter, c-c, up, tab, ...)
//   mogging capture <pane>           print a pane's scrollback tail to stdout [--lines N]
//
// Auth is never brokered here (ADR 0002) — `open` launches a deep link; everything else
// talks to the LOCAL daemon over its authed socket (token from the 0600 endpoint file;
// nothing listens on TCP). Control verbs carry labels/names/bytes-to-type only; `capture`
// output goes to YOUR stdout and nowhere else.
import { spawn } from 'node:child_process'
import { resolve, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import net from 'node:net'

// Keep in sync with DAEMON_PROTOCOL_VERSION in src/contracts/daemon/protocol.ts
// (this file is plain Node — it cannot import the TS contract).
const PROTOCOL_VERSION = 3

const argv = process.argv.slice(2)
const cmd = argv[0]

if (cmd === 'notify') runNotify(argv.slice(1))
else if (cmd === 'list') runList()
else if (cmd === 'send') runSend(argv.slice(1))
else if (cmd === 'send-key') runSendKey(argv.slice(1))
else if (cmd === 'capture') runCapture(argv.slice(1))
else if (cmd === 'mail') runMail(argv.slice(1))
else if (cmd === 'role') runRole(argv.slice(1))
else if (cmd === 'claim') runClaim(argv.slice(1))
else if (cmd === 'release') runRelease(argv.slice(1))
else if (cmd === 'owners') runOwners(argv.slice(1))
else if (cmd === 'open') runControlOpen(argv.slice(1))
else if (cmd === 'layout') runControl({ verb: 'layout', panes: Number(argv[1]) }, argv)
else if (cmd === 'focus') runControl({ verb: 'focus', paneId: Number(argv[1]) }, argv)
else if (cmd === 'expand')
  runControl({ verb: 'expand', paneId: Number(argv[1]), mode: argv[2] && !argv[2].startsWith('--') ? argv[2] : 'full' }, argv)
else if (cmd === 'close-pane') runControl({ verb: 'close-pane', paneId: Number(argv[1]) }, argv)
else if (cmd === '--help' || cmd === '-h' || cmd === 'help') usage(0)
else runOpen(argv)

function usage(code) {
  process.stderr.write(
    'usage: mogging [<dir>] | notify --event <e> | list | send <pane> <text...> [--no-enter]\n' +
      '       mogging send-key <pane> <key> | capture <pane> [--lines N]\n' +
      '       mogging open <dir> [--panes N] | layout <N> | focus <pane>\n' +
      '       mogging expand <pane> [full|col|row] | close-pane <pane>   (each: [--no-launch])\n' +
      '       mogging mail send [--to <pane>|all] <text...> | mail read [--since <id>] [--json]\n' +
      '       mogging role <pane> <architect|worker|reviewer>\n' +
      '       mogging claim <pattern> | release <pattern|--all> | owners [--json]   (in-pane)\n'
  )
  process.exit(code)
}

// --- mogging claim/release/owners (Phase-4/02 ownership ledger) -----------------------------------
// Claims are made by AGENTS from inside their panes (identity = MOGGING_PANE_ID);
// a claim from outside a pane is a usage error — humans own the gate, not territory.
// Exit codes: 0 granted/ok · 2 usage/not-in-a-pane · 5 DENIED (owner on stderr).

function paneIdentityOrUsage() {
  const id = process.env.MOGGING_PANE_ID
  if (!id) {
    process.stderr.write('mogging: not inside a pane (claims are per-agent; humans own the gate)\n')
    process.exit(2)
  }
  return id
}

function runClaim(args) {
  const pattern = args[0]
  if (!pattern) usage(2)
  const from = paneIdentityOrUsage()
  withDaemon(
    (welcome, api) => {
      api.send({ t: 'claim', pattern, from })
    },
    (m, api) => {
      if (m.t === 'claimed') {
        process.stdout.write('mogging: claim #' + m.id + ' granted\n')
        api.finish(0)
      } else if (m.t === 'claim-denied') {
        process.stderr.write(
          'mogging claim: DENIED — overlaps "' + m.pattern + '" owned by pane ' + m.ownerPaneId + '\n'
        )
        api.finish(5)
      } else if (m.t === 'error') {
        process.stderr.write('mogging claim: rejected (' + m.reason + ')\n')
        api.finish(m.reason === 'badpattern' ? 2 : 1)
      }
    }
  )
}

function runRelease(args) {
  const all = args.includes('--all')
  const pattern = args.find((a) => a !== '--all')
  if (!all && !pattern) usage(2)
  const from = paneIdentityOrUsage()
  withDaemon(
    (welcome, api) => {
      api.send({ t: 'release', pattern, all, from })
    },
    (m, api) => {
      if (m.t === 'released') {
        process.stdout.write('mogging: released ' + m.count + '\n')
        api.finish(0)
      } else if (m.t === 'error') {
        process.stderr.write('mogging release: rejected (' + m.reason + ')\n')
        api.finish(1)
      }
    }
  )
}

function runOwners(args) {
  const asJson = args.includes('--json')
  withDaemon(
    (welcome, api) => {
      api.send({ t: 'owners' })
    },
    (m, api) => {
      if (m.t !== 'owners') return
      if (asJson) {
        process.stdout.write(JSON.stringify(m.claims) + '\n')
      } else if (!m.claims.length) {
        process.stdout.write('no claims\n')
      } else {
        for (const c of m.claims) {
          const who = 'pane ' + c.paneId + (c.role ? ':' + c.role : '')
          process.stdout.write('#' + c.id + ' ' + who + ' owns ' + c.pattern + '\n')
        }
      }
      api.finish(0)
    }
  )
}

// --- mogging mail send/read + mogging role (Phase-4/01 swarm substrate) --------------------------
// Mail bodies are user/agent content: they travel this authed socket and the caller's
// stdout ONLY. Inside a pane, identity is implicit via MOGGING_PANE_ID.

function runMail(args) {
  const sub = args[0]
  if (sub === 'send') runMailSend(args.slice(1))
  else if (sub === 'read') runMailRead(args.slice(1))
  else usage(2)
}

function runMailSend(args) {
  let to = 'all'
  const ti = args.indexOf('--to')
  if (ti >= 0) {
    to = args[ti + 1]
    if (!to) usage(2)
    args = args.slice(0, ti).concat(args.slice(ti + 2))
  }
  const body = args.join(' ')
  if (!body) usage(2)
  const from = process.env.MOGGING_PANE_ID || '0'
  withDaemon(
    (welcome, api) => {
      api.send({ t: 'mail-send', from, to: String(to), body })
    },
    (m, api) => {
      if (m.t === 'mailed') {
        process.stdout.write('mogging: mail #' + m.id + ' sent\n')
        api.finish(0)
      } else if (m.t === 'error') {
        process.stderr.write('mogging mail: rejected (' + m.reason + ')\n')
        api.finish(1)
      }
    }
  )
}

function runMailRead(args) {
  const asJson = args.includes('--json')
  let since = 0
  const si = args.indexOf('--since')
  if (si >= 0) {
    since = Number(args[si + 1])
    if (!Number.isInteger(since) || since < 0) usage(2)
  }
  const forPane = process.env.MOGGING_PANE_ID // implicit identity; unset = human view
  withDaemon(
    (welcome, api) => {
      api.send({ t: 'mail-read', since, for: forPane })
    },
    (m, api) => {
      if (m.t !== 'mail') return
      if (asJson) {
        process.stdout.write(JSON.stringify(m.messages) + '\n')
      } else if (!m.messages.length) {
        process.stdout.write('no mail\n')
      } else {
        for (const msg of m.messages) {
          const who = msg.from === '0' ? 'human' : 'pane ' + msg.from + (msg.role ? ':' + msg.role : '')
          process.stdout.write('#' + msg.id + ' [' + who + ' -> ' + msg.to + '] ' + msg.body + '\n')
        }
      }
      api.finish(0)
    }
  )
}

function runRole(args) {
  const pane = args[0]
  const role = args[1]
  if (!pane || !role) usage(2)
  withDaemon(
    (welcome, api) => {
      api.send({ t: 'set-role', id: String(pane), role })
    },
    (m, api) => {
      if (m.t === 'role-set') {
        if (!m.ok) {
          process.stderr.write('mogging role: unknown pane or role (roles: architect, worker, reviewer)\n')
        }
        api.finish(m.ok ? 0 : 1)
      }
    }
  )
}

// --- layout control verbs (Phase-3/02): ride the mogging:// relay ---------------------------------

/** Launch/signal the app with a validated-shape control command via the deep link.
 *  Main re-validates against the closed union before the UI ever sees it. */
function sendControl(command, opts = {}) {
  if (opts.noLaunch && !readEndpoint()) {
    process.stderr.write('mogging: app/daemon not running (--no-launch)\n')
    process.exit(3)
  }
  const url = `mogging://control?c=${encodeURIComponent(JSON.stringify(command))}`
  const platform = process.platform
  if (platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url.replace(/&/g, '^&')], { detached: true, stdio: 'ignore' }).unref()
  } else if (platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
  }
}

function runControl(command, rawArgs) {
  const noLaunch = rawArgs.includes('--no-launch')
  if (
    (command.verb === 'layout' && !Number.isInteger(command.panes)) ||
    (command.verb !== 'layout' && command.paneId !== undefined && !Number.isInteger(command.paneId))
  ) {
    usage(2)
  }
  sendControl(command, { noLaunch })
  process.stdout.write(`mogging: ${command.verb} sent\n`)
}

function runControlOpen(args) {
  const noLaunch = args.includes('--no-launch')
  const rest = args.filter((a) => a !== '--no-launch')
  const dir = rest[0]
  if (!dir) usage(2)
  const pi = rest.indexOf('--panes')
  const panes = pi >= 0 ? Number(rest[pi + 1]) : undefined
  if (pi >= 0 && !Number.isInteger(panes)) usage(2)
  const command = { verb: 'open', cwd: resolve(dir) }
  if (panes) command.panes = panes
  sendControl(command, { noLaunch })
  process.stdout.write(`mogging: opening ${command.cwd}${panes ? ` (${panes} panes)` : ''}\n`)
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

// --- daemon endpoint discovery + authed connection (shared) --------------------------------------

/** Inside a pane MOGGING_DAEMON_ENDPOINT is injected; from any other shell we use the
 *  well-known per-user runtime path (mirrors src/pty-daemon/lifecycle.ts). */
function endpointFilePath() {
  if (process.env.MOGGING_DAEMON_ENDPOINT) return process.env.MOGGING_DAEMON_ENDPOINT
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
      : process.env.XDG_RUNTIME_DIR || join(homedir(), 'Library', 'Application Support')
  return join(base, 'MoggingLabs', 'run', 'v' + PROTOCOL_VERSION, 'endpoint.json')
}

function readEndpoint() {
  try {
    return JSON.parse(readFileSync(endpointFilePath(), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Open an authed connection. `onMessage(m, api)` runs per server message AFTER welcome;
 * call api.send(obj) / api.finish(code). Exit codes: 3 = no daemon/timeout, 4 = auth refused.
 */
function withDaemon(onWelcome, onMessage, { timeoutMs = 5000 } = {}) {
  const ep = readEndpoint()
  if (!ep) {
    process.stderr.write('mogging: no daemon endpoint found (is the app or a pane running?)\n')
    process.exit(3)
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
  const timer = setTimeout(() => {
    process.stderr.write('mogging: daemon did not respond in time\n')
    finish(3)
  }, timeoutMs)
  const api = { send: (obj) => sock.write(JSON.stringify(obj) + '\n'), finish }

  sock.on('connect', () => {
    api.send({ t: 'hello', v: ep.version, token: ep.token })
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
      if (m.t === 'welcome') onWelcome(m, api)
      else if (m.t === 'error' && m.reason === 'auth') {
        process.stderr.write('mogging: daemon refused the token (auth)\n')
        finish(4)
      } else onMessage(m, api)
    }
  })
  sock.on('error', (e) => {
    process.stderr.write('mogging: ' + e.message + '\n')
    finish(3)
  })
}

// --- mogging list ---------------------------------------------------------------------------------

function runList() {
  withDaemon(
    (welcome, api) => {
      const panes = welcome.panes ?? []
      if (!panes.length) {
        process.stdout.write('no live panes\n')
        api.finish(0)
        return
      }
      const rows = panes.map((p) => ({
        id: String(p.id),
        size: `${p.cols}x${p.rows}`,
        state: p.state ?? 'idle',
        title: p.title ?? ''
      }))
      const w = (k, h) => Math.max(h.length, ...rows.map((r) => r[k].length))
      const wid = w('id', 'ID'),
        wsz = w('size', 'SIZE'),
        wst = w('state', 'STATE')
      const line = (a, b, c, d) =>
        a.padEnd(wid) + '  ' + b.padEnd(wsz) + '  ' + c.padEnd(wst) + '  ' + d + '\n'
      process.stdout.write(line('ID', 'SIZE', 'STATE', 'TITLE'))
      for (const r of rows) process.stdout.write(line(r.id, r.size, r.state, r.title))
      api.finish(0)
    },
    () => {}
  )
}

// --- mogging send <pane> <text...> [--no-enter] ---------------------------------------------------

function runSend(args) {
  const noEnter = args.includes('--no-enter')
  const rest = args.filter((a) => a !== '--no-enter')
  const pane = rest[0]
  const text = rest.slice(1).join(' ')
  if (!pane || !text) usage(2)
  withDaemon(
    (welcome, api) => {
      if (!(welcome.panes ?? []).some((p) => String(p.id) === String(pane))) {
        process.stderr.write(`mogging send: unknown pane ${pane}\n`)
        api.finish(1)
        return
      }
      api.send({ t: 'input', id: String(pane), data: text + (noEnter ? '' : '\r') })
      api.send({ t: 'ping' }) // ordered stream: pong => the input was processed
    },
    (m, api) => {
      if (m.t === 'pong') api.finish(0)
    }
  )
}

// --- mogging send-key <pane> <key> ----------------------------------------------------------------

function runSendKey(args) {
  const pane = args[0]
  const key = args[1]
  if (!pane || !key) usage(2)
  withDaemon(
    (welcome, api) => {
      api.send({ t: 'send-key', id: String(pane), key })
    },
    (m, api) => {
      if (m.t === 'sent') api.finish(m.ok ? 0 : 1)
      else if (m.t === 'error') {
        process.stderr.write(
          m.reason === 'badkey'
            ? `mogging send-key: unknown key "${key}" (allowed: enter, tab, escape, backspace, space, up, down, left, right, home, end, page-up, page-down, c-c, c-d, c-z, c-l, c-u, c-r)\n`
            : `mogging send-key: unknown pane ${pane}\n`
        )
        api.finish(m.reason === 'badkey' ? 2 : 1)
      }
    }
  )
}

// --- mogging capture <pane> [--lines N] -----------------------------------------------------------

function runCapture(args) {
  const pane = args[0]
  let lines
  const li = args.indexOf('--lines')
  if (li >= 0) lines = Number(args[li + 1])
  if (!pane || (li >= 0 && (!Number.isFinite(lines) || lines <= 0))) usage(2)
  withDaemon(
    (welcome, api) => {
      api.send({ t: 'capture', id: String(pane), lastLines: lines })
    },
    (m, api) => {
      if (m.t === 'captured') {
        process.stdout.write(m.data.endsWith('\n') ? m.data : m.data + '\n')
        api.finish(0)
      } else if (m.t === 'error') {
        process.stderr.write(`mogging capture: unknown pane ${pane}\n`)
        api.finish(1)
      }
    }
  )
}

// --- mogging notify -------------------------------------------------------------------------------

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
