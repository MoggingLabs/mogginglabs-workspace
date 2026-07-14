#!/usr/bin/env node
// The `mogging` CLI.
//   mogging [<dir>]                  open/focus a MoggingLabs Workspace for a directory (default)
//   mogging notify --event <e> ...   raise the CURRENT pane's attention (Phase-2/04)
//   mogging list                     enumerate live panes (id, size, state, title)   (Phase-3/01)
//   mogging send <pane> <text...>    type into a pane (appends Enter unless --no-enter)
//   mogging send-key <pane> <key>    press a named key (enter, c-c, up, tab, ...)
//   mogging capture <pane>           print a pane's scrollback tail to stdout [--lines N]
//   mogging cwd [path]               declare this pane's active agent directory
//
// Auth is never brokered here (ADR 0002) — `open` launches a deep link; everything else
// talks to the LOCAL daemon over its authed socket (token from the 0600 endpoint file;
// nothing listens on TCP). Control verbs carry labels/names/bytes-to-type only; `capture`
// output goes to YOUR stdout and nowhere else.
import { execFileSync, spawn } from 'node:child_process'
import { resolve, join } from 'node:path'
import { closeSync, openSync, readFileSync, realpathSync, statSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import net from 'node:net'

// Keep in sync with DAEMON_PROTOCOL_VERSION in src/contracts/daemon/protocol.ts
// (this file is plain Node — it cannot import the TS contract). It is BOTH the handshake
// version and the runtime directory this CLI looks in, so a stale value here does not
// degrade — it makes every `mogging` verb miss the daemon entirely.
const PROTOCOL_VERSION = 8

// Release channel (keep in sync with contracts/daemon/protocol.ts, ReleaseChannel — gated by
// scripts/check-protocol-version.mjs). A repo checkout runs on its own channel: run/dev-v4 and
// mogging-dev:// instead of run/v4 and mogging://, so dev and an installed release never answer
// each other's commands. Inside a dev pane MOGGING_CHANNEL=dev is inherited from the daemon, so
// hooks and `mogging notify` target the right app with no flags; outside one, pass --dev.
const CHANNEL = process.argv.includes('--dev') || process.env.MOGGING_CHANNEL === 'dev' ? 'dev' : 'prod'
const RUN_SEGMENT = (CHANNEL === 'dev' ? 'dev-v' : 'v') + PROTOCOL_VERSION
const SCHEME = CHANNEL === 'dev' ? 'mogging-dev' : 'mogging'

const argv = process.argv.slice(2).filter((a) => a !== '--dev')
const cmd = argv[0]

if (cmd === 'usage') runUsage(argv.slice(1))
else if (cmd === 'notify') runNotify(argv.slice(1)).catch(() => process.exit(0)) // a hook must never fail its agent
else if (cmd === 'cwd') runCwd(argv.slice(1))
else if (cmd === 'list') runList()
else if (cmd === 'send') runSend(argv.slice(1))
else if (cmd === 'send-key') runSendKey(argv.slice(1))
else if (cmd === 'capture') runCapture(argv.slice(1))
else if (cmd === 'mail') runMail(argv.slice(1))
else if (cmd === 'role') runRole(argv.slice(1))
else if (cmd === 'claim') runClaim(argv.slice(1))
else if (cmd === 'release') runRelease(argv.slice(1))
else if (cmd === 'owners') runOwners(argv.slice(1))
else if (cmd === 'approve') runApprove(argv.slice(1))
else if (cmd === 'approvals') runApprovals(argv.slice(1))
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
    'usage: mogging [<dir>] | notify --event <e> | cwd [path] | list | send <pane> <text...> [--no-enter]\n' +
      '       mogging send-key <pane> <key> | capture <pane> [--lines N]\n' +
      '       mogging open <dir> [--panes N] | layout <N> | focus <pane>\n' +
      '       mogging expand <pane> [full|col|row] | close-pane <pane>   (each: [--no-launch])\n' +
      '       mogging mail send [--to <pane>|all] <text...> | mail read [--since <id>] [--json]\n' +
      '       mogging role <pane> <architect|worker|reviewer>\n' +
      '       mogging claim <pattern> | release <pattern|--all> | owners [--json]   (in-pane)\n' +
      '       mogging approve <branch> (reviewer pane only) | approvals [--json]\n' +
      '       mogging usage [--json] | usage cost [--provider <id|all>] [--json]\n' +
      '       mogging usage providers [--json] | usage refresh [--provider <id>]\n' +
      '       mogging usage set-key --provider <id> --stdin | usage clear-key --provider <id>\n' +
      '       any verb: --dev   target a repo-checkout (dev-channel) app instead of the installed\n' +
      '                 release. Inside dev panes MOGGING_CHANNEL=dev is inherited — no flag needed.\n'
  )
  process.exit(code)
}

// --- mogging usage (Phase-7/11) --------------------------------------------------------------------
// Usage verbs ride the APP endpoint (the 6/05b token-authed local socket that
// already carries browser control) — one more request type, NOT a new listener;
// the daemon protocol stays at v3, untouched. Verdict + reset strings arrive
// pre-formatted from the app's ONE formatter (7/02, 7/10) and print VERBATIM.
// Keys travel stdin -> one authed frame -> the 0007.a write-only vault; there
// is no get-key verb, by design. Exit codes: 0 ok · 1 rejected · 2 usage ·
// 3 app-not-running · 4 auth refused.

function runUsage(args) {
  const sub = args[0] && !args[0].startsWith('--') ? args[0] : null
  if (sub === 'cost') runUsageCost(args.slice(1))
  else if (sub === 'providers') runUsageProviders(args.slice(1))
  else if (sub === 'refresh') runUsageRefresh(args.slice(1))
  else if (sub === 'set-key') runUsageSetKey(args.slice(1))
  else if (sub === 'clear-key') runUsageClearKey(args.slice(1))
  else if (sub === null) runUsageSnapshot(args)
  else usage(2) // no get-key, no surprises — unknown subverbs are usage errors
}

function appEndpointFilePath() {
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
      : process.env.XDG_RUNTIME_DIR || join(homedir(), 'Library', 'Application Support')
  return join(base, 'MoggingLabs', 'run', RUN_SEGMENT, 'browser-control.json')
}

/** An authed session against the APP endpoint (promise-based calls, so a
 *  verb can make several). Same handshake the MCP server uses; the token
 *  never leaves this process except in the hello frame. */
function withApp(onReady, { timeoutMs = 15000 } = {}) {
  let ep
  try {
    ep = JSON.parse(readFileSync(appEndpointFilePath(), 'utf8'))
  } catch {
    process.stderr.write('mogging usage: app not running (no app endpoint found)\n')
    process.exit(3)
  }
  const sock = net.connect(ep.address)
  sock.setEncoding('utf8')
  let buf = ''
  let settled = false
  let nextId = 1
  const waiters = new Map()
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
    process.stderr.write('mogging usage: app did not respond in time\n')
    finish(3)
  }, timeoutMs)
  const api = {
    call: (name, args) =>
      new Promise((res) => {
        const id = nextId++
        waiters.set(id, res)
        sock.write(JSON.stringify({ t: 'call', id, name, args }) + '\n')
      }),
    finish
  }
  sock.on('connect', () => {
    sock.write(JSON.stringify({ t: 'hello', token: ep.token }) + '\n')
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
      if (m.t === 'welcome') void onReady(api)
      else if (m.t === 'error') {
        // Only `auth` is a refused token (exit 4). Any other error frame is the app
        // REJECTING the request — reporting every one as an auth failure sent people
        // hunting a token problem they did not have.
        const why = m.reason || 'error'
        if (why === 'auth') {
          process.stderr.write('mogging usage: app refused the token (auth)\n')
          finish(4)
        } else {
          process.stderr.write('mogging usage: app rejected the request (' + why + ')\n')
          finish(1)
        }
      } else if (m.t === 'result') {
        const w = waiters.get(m.id)
        waiters.delete(m.id)
        if (w) w(m)
      }
    }
  })
  sock.on('error', (e) => {
    process.stderr.write('mogging usage: ' + e.message + '\n')
    finish(3)
  })
}

function usageFlag(args, name) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

/** One line per (provider, plan): windows + reset + THE verdict + health. */
function printPlans(plans) {
  if (!plans.length) {
    process.stdout.write('no usage sources enabled\n')
    return
  }
  for (const p of plans) {
    const windows = p.windows
      .map((w) => `${w.label} ${Math.round(w.usedPct)}%${w.resetText ? ` (${w.resetText})` : ''}`)
      .join(' · ')
    const verdict = p.pace ? p.pace.text : (p.reason ?? '')
    const parts = [`${p.providerId}/${p.profileId}`, p.planLabel, windows, verdict, `[${p.health}]`].filter(Boolean)
    process.stdout.write(parts.join(' · ') + '\n')
  }
}

function runUsageSnapshot(args) {
  const asJson = args.includes('--json')
  withApp(async (api) => {
    const m = await api.call('usage.list', {})
    if (!m.ok) {
      process.stderr.write('mogging usage: ' + (m.reason || 'error') + '\n')
      api.finish(1)
      return
    }
    if (asJson) process.stdout.write(JSON.stringify(m.plans) + '\n')
    else printPlans(m.plans ?? [])
    api.finish(0)
  })
}

function runUsageCost(args) {
  const asJson = args.includes('--json')
  const provider = usageFlag(args, '--provider') ?? 'all'
  withApp(async (api) => {
    const m = await api.call('usage.cost', { provider })
    if (!m.ok) {
      process.stderr.write('mogging usage cost: ' + (m.reason || 'error') + '\n')
      api.finish(1)
      return
    }
    const scans = m.scans ?? []
    if (asJson) {
      process.stdout.write(JSON.stringify(scans) + '\n')
    } else {
      for (const scan of scans) {
        process.stdout.write(scan.providerId + (scan.reason ? ` — ${scan.reason}` : '') + '\n')
        let total = 0
        for (const d of scan.days) {
          total += d.spend
          process.stdout.write(`  ${d.date}  ${scan.currency} ${d.spend.toFixed(2)}  ${d.tokens.toLocaleString()} tokens\n`)
        }
        if (scan.days.length) process.stdout.write(`  total ${scan.currency} ${total.toFixed(2)}\n`)
      }
    }
    api.finish(0)
  })
}

function runUsageProviders(args) {
  const asJson = args.includes('--json')
  withApp(async (api) => {
    const m = await api.call('usage.providers', {})
    if (!m.ok) {
      process.stderr.write('mogging usage providers: ' + (m.reason || 'error') + '\n')
      api.finish(1)
      return
    }
    const rows = m.providers ?? []
    if (asJson) {
      process.stdout.write(JSON.stringify(rows) + '\n')
    } else {
      for (const r of rows) {
        process.stdout.write(
          `${r.id}  ${r.klass}  ${r.enabled ? 'enabled' : 'disabled'}  key:${r.key ?? 'none'}  ${r.health ?? ''}\n`
        )
      }
    }
    api.finish(0)
  })
}

function runUsageRefresh(args) {
  const provider = usageFlag(args, '--provider')
  const started = Date.now()
  withApp(async (api) => {
    const poke = await api.call('usage.refresh', provider ? { provider } : {})
    if (!poke.ok) {
      process.stderr.write('mogging usage refresh: ' + (poke.reason || 'error') + '\n')
      api.finish(1)
      return
    }
    // Bounded wait for the NEXT snapshot (a fetchedAt at/after the poke).
    for (;;) {
      const m = await api.call('usage.list', {})
      const plans = m.ok ? (m.plans ?? []) : []
      const fresh = plans.some((p) => p.fetchedAt >= started)
      if (fresh || Date.now() - started > 10_000) {
        printPlans(plans)
        api.finish(0)
        return
      }
      await new Promise((r) => setTimeout(r, 400))
    }
  })
}

function runUsageSetKey(args) {
  const provider = usageFlag(args, '--provider')
  if (!provider || !args.includes('--stdin')) usage(2)
  // The key travels stdin -> ONE authed frame -> the 0007.a write-only vault.
  // Never an argv, never echoed, never readable back (no get-key exists).
  let data = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (c) => (data += c))
  process.stdin.on('end', () => {
    const value = data.replace(/\r?\n$/, '')
    if (!value) {
      process.stderr.write('mogging usage set-key: empty key on stdin\n')
      process.exit(2)
    }
    withApp(async (api) => {
      const m = await api.call('usage.setKey', { provider, value })
      if (m.ok) {
        process.stdout.write(`mogging: key for ${provider} stored (write-only)\n`)
        api.finish(0)
      } else {
        process.stderr.write('mogging usage set-key: refused — ' + (m.reason || 'error') + '\n')
        api.finish(1)
      }
    })
  })
}

function runUsageClearKey(args) {
  const provider = usageFlag(args, '--provider')
  if (!provider) usage(2)
  withApp(async (api) => {
    const m = await api.call('usage.clearKey', { provider })
    if (m.ok) {
      process.stdout.write(`mogging: key for ${provider} cleared\n`)
      api.finish(0)
    } else {
      process.stderr.write('mogging usage clear-key: ' + (m.reason || 'error') + '\n')
      api.finish(1)
    }
  })
}

// --- mogging approve/approvals (Phase-4/03 reviewer gate) -----------------------------------------
// Only a pane whose DAEMON-SIDE role is `reviewer` may approve; the payload carries
// the pane binding, never a role claim. Exit codes: 0 ok · 2 usage · 3/4 as usual ·
// **6 notreviewer**.
//
// MOGGING_PANE_TOKEN is the pane's own secret: the daemon mints one per session and injects
// it into that pane's env and nowhere else. Sending it PROVES we are the pane named in `from`
// — a pane id is public (`mogging list` prints it) and every pane can read the endpoint file
// and authenticate, so `from` alone was a claim rather than a fact. Approval requires BOTH
// credentials, fails closed outside a live pane, and carries the immutable snapshot the merge
// re-validates against — a branch name alone is not what was reviewed (audit findings 1 and 4).

function runApprove(args) {
  const branch = args[0]
  if (!branch) usage(2)
  const from = paneIdentityOrUsage()
  const token = process.env.MOGGING_PANE_TOKEN
  if (!token) {
    process.stderr.write('mogging approve: run this inside the reviewer pane (pane credential missing)\n')
    process.exit(6)
  }
  const flag = (name) => {
    const i = args.indexOf(name)
    return i >= 0 && typeof args[i + 1] === 'string' ? args[i + 1] : undefined
  }
  const repo = resolve(flag('--repo') || process.cwd())
  const git = (gitArgs) => {
    try {
      return String(execFileSync('git', ['-C', repo, ...gitArgs], {
        encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024
      })).trim()
    } catch {
      return ''
    }
  }
  let common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (common && !/^(?:[A-Za-z]:[\\/]|\/)/.test(common)) common = resolve(repo, common)
  try { common = realpathSync.native(common) } catch { common = resolve(common || repo) }
  const repoIdRaw = common.replace(/\\/g, '/').replace(/\/+$/, '')
  const repoId = process.platform === 'win32' ? repoIdRaw.toLowerCase() : repoIdRaw
  const base = flag('--base') || git(['rev-parse', '--abbrev-ref', 'HEAD'])
  const head = git(['rev-parse', `${branch}^{commit}`])
  const baseHead = git(['rev-parse', `${base}^{commit}`])
  const mergeBase = head && baseHead ? git(['merge-base', baseHead, head]) : ''
  const oid = /^[0-9a-f]{40,64}$/i
  if (!repoId || !base || !oid.test(head) || !oid.test(baseHead) || !oid.test(mergeBase)) {
    process.stderr.write('mogging approve: could not resolve the repository, base, and branch snapshot\n')
    process.exit(2)
  }
  const snapshot = { repoId, branch, head, base, baseHead, mergeBase }
  withDaemon(
    (welcome, api) => {
      api.send({ t: 'approve', snapshot, from, token })
    },
    (m, api) => {
      if (m.t === 'approved') {
        process.stdout.write('mogging: ' + m.branch + ' approved by pane ' + m.byPaneId + '\n')
        api.finish(0)
      } else if (m.t === 'error') {
        if (m.reason === 'notreviewer') {
          process.stderr.write('mogging approve: this pane is not the reviewer\n')
          api.finish(6)
        } else {
          process.stderr.write('mogging approve: rejected (' + m.reason + ')\n')
          api.finish(m.reason === 'nopane' ? 1 : 2)
        }
      }
    }
  )
}

function runApprovals(args) {
  const asJson = args.includes('--json')
  withDaemon(
    (welcome, api) => {
      api.send({ t: 'approvals' })
    },
    (m, api) => {
      if (m.t !== 'approvals') return
      if (asJson) {
        process.stdout.write(JSON.stringify(m.list) + '\n')
      } else if (!m.list.length) {
        process.stdout.write('no approvals\n')
      } else {
        for (const a of m.list) {
          process.stdout.write(a.branch + ' — approved by pane ' + a.byPaneId + '\n')
        }
      }
      api.finish(0)
    }
  )
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

/** Is the APP up? --no-launch exists to keep a control verb from cold-starting the whole app, so
 *  the daemon's endpoint is the WRONG gate: the daemon deliberately OUTLIVES the app (ADR 0006),
 *  so after you quit the window `mogging focus 3 --no-launch` still passed and launched it — and
 *  under the in-proc fallback (MOGGING_INPROC) a RUNNING app has no daemon endpoint and was
 *  refused. The app publishes browser-control.json for as long as it runs (6/05b) and unlinks it
 *  on quit; a crash can leave the file, so connect too — a dead pipe/socket answers instantly. */
function appRunning(timeoutMs = 1500) {
  let ep
  try {
    ep = JSON.parse(readFileSync(appEndpointFilePath(), 'utf8'))
  } catch {
    return Promise.resolve(false)
  }
  return new Promise((res) => {
    const sock = net.connect(ep.address)
    const done = (alive) => {
      clearTimeout(timer)
      try {
        sock.destroy()
      } catch {
        /* ignore */
      }
      res(alive)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    sock.on('connect', () => done(true))
    sock.on('error', () => done(false))
  })
}

/** Mirror main's sanitizeControl bounds (src/main/deep-link.ts): out of range there is a SILENT
 *  drop of the WHOLE command, so a CLI that printed "opening … (20 panes)" opened nothing. */
function boundedOrUsage(label, n, min, max) {
  if (!Number.isInteger(n) || n < min || n > max) {
    process.stderr.write(`mogging: ${label} must be a whole number ${min}-${max}\n`)
    process.exit(2)
  }
}

/** Launch/signal the app with a validated-shape control command via the deep link.
 *  Main re-validates against the closed union before the UI ever sees it. */
async function sendControl(command, opts = {}) {
  if (opts.noLaunch && !(await appRunning())) {
    process.stderr.write('mogging: app not running (--no-launch)\n')
    process.exit(3)
  }
  const url = `${SCHEME}://control?c=${encodeURIComponent(JSON.stringify(command))}`
  const platform = process.platform
  if (platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url.replace(/&/g, '^&')], { detached: true, stdio: 'ignore' }).unref()
  } else if (platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
  }
}

async function runControl(command, rawArgs) {
  const noLaunch = rawArgs.includes('--no-launch')
  if (command.verb === 'layout') boundedOrUsage('panes', command.panes, 1, 16)
  else if (command.paneId !== undefined) boundedOrUsage('pane', command.paneId, 1, 99999)
  if (command.mode !== undefined && !['full', 'col', 'row'].includes(command.mode)) {
    process.stderr.write('mogging: mode must be one of: full, col, row\n')
    process.exit(2)
  }
  await sendControl(command, { noLaunch })
  process.stdout.write(`mogging: ${command.verb} sent\n`)
}

async function runControlOpen(args) {
  const noLaunch = args.includes('--no-launch')
  const rest = args.filter((a) => a !== '--no-launch')
  const dir = rest[0]
  if (!dir) usage(2)
  const pi = rest.indexOf('--panes')
  const panes = pi >= 0 ? Number(rest[pi + 1]) : undefined
  if (pi >= 0) boundedOrUsage('panes', panes, 1, 16)
  const command = { verb: 'open', cwd: resolve(dir) }
  if (panes) command.panes = panes
  await sendControl(command, { noLaunch })
  process.stdout.write(`mogging: opening ${command.cwd}${panes ? ` (${panes} panes)` : ''}\n`)
}

// --- mogging . / mogging <dir> ------------------------------------------------------------------

function runOpen(args) {
  const dir = resolve(args[0] ?? '.')
  const url = `${SCHEME}://open?cwd=${encodeURIComponent(dir)}`
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
  return join(base, 'MoggingLabs', 'run', RUN_SEGMENT, 'endpoint.json')
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

// --- mogging cwd [path] ---------------------------------------------------------------------------

/** The private PTY fallback. It carries no pane token: PTY output is retained in scrollback and
 * the session store, while the PTY stream itself is already bound to exactly one pane. */
function cwdOsc(path) {
  return `\x1b]633;P;MoggingCwd=${encodeURIComponent(path)}\x1b\\`
}

/** Write a private control sequence to the process's controlling terminal, not stdout. Agent
 * shell tools commonly capture stdout; `/dev/tty` / `CONOUT$` still names this pane's PTY. */
function writeCwdOsc(osc) {
  const tty = process.platform === 'win32' ? '\\\\.\\CONOUT$' : '/dev/tty'
  let fd
  try {
    fd = openSync(tty, 'w')
    const bytes = Buffer.from(osc + 'mogging: cwd declared via terminal fallback\n', 'utf8')
    let offset = 0
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset)
      if (written <= 0) throw new Error('terminal write made no progress')
      offset += written
    }
    return true
  } catch {
    // A directly-invoked interactive shell may expose only stdout as its terminal.
    if (process.stdout.isTTY) {
      process.stdout.write(osc + 'mogging: cwd declared via terminal fallback\n')
      return true
    }
    return false
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* terminal already closed */
      }
    }
  }
}

/**
 * Declare the calling pane's active agent directory. The daemon socket is primary: its endpoint
 * token authenticates the local client and MOGGING_PANE_TOKEN binds the declaration to this pane.
 * When no daemon transport exists (the supported in-process PTY fallback), emit one private OSC
 * on this pane's own output stream. A daemon rejection is authoritative and never bypassed by OSC.
 */
function runCwd(args) {
  const pathArgs = args[0] === '--' ? args.slice(1) : args
  if (pathArgs.length > 1) usage(2)
  const cwd = resolve(pathArgs[0] ?? '.')
  if (cwd.length > 32 * 1024 || /[\x00-\x1f\x7f]/.test(cwd)) {
    process.stderr.write('mogging cwd: control characters and oversized paths are not supported\n')
    process.exit(2)
  }
  try {
    if (!statSync(cwd).isDirectory()) throw new Error('not a directory')
  } catch {
    process.stderr.write('mogging cwd: directory does not exist or is not accessible\n')
    process.exit(2)
  }
  let osc
  try {
    osc = cwdOsc(cwd)
  } catch {
    process.stderr.write('mogging cwd: path cannot be encoded\n')
    process.exit(2)
  }

  const fallback = () => {
    if (!process.env.MOGGING_PANE_ID && process.env.MOGGING_PTY !== '1') {
      process.stderr.write('mogging cwd: not inside a MoggingLabs pane\n')
      process.exitCode = 2
      return
    }
    if (writeCwdOsc(osc)) process.exitCode = 0
    else {
      process.stderr.write('mogging cwd: no daemon or controlling terminal is available\n')
      process.exitCode = 3
    }
  }
  // Pane-scoped cwd must not discover an arbitrary same-user daemon through the well-known
  // path: an in-process pane intentionally has no endpoint, while a detached pane always gets
  // its exact endpoint file injected. Absence here selects OSC on this PTY, not another daemon.
  let ep
  try {
    ep = process.env.MOGGING_DAEMON_ENDPOINT
      ? JSON.parse(readFileSync(process.env.MOGGING_DAEMON_ENDPOINT, 'utf8'))
      : null
  } catch {
    ep = null
  }
  if (!ep || typeof ep.address !== 'string' || typeof ep.token !== 'string') {
    fallback()
    return
  }
  const paneId = process.env.MOGGING_PANE_ID
  const paneToken = process.env.MOGGING_PANE_TOKEN
  if (!paneId || !paneToken) {
    process.stderr.write('mogging cwd: pane credentials unavailable for daemon reporting\n')
    process.exit(2)
  }

  const sock = net.connect(ep.address)
  sock.setEncoding('utf8')
  let buf = ''
  let settled = false
  const observedAt = Date.now()
  const finish = (code, message) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    try {
      sock.destroy()
    } catch {
      /* peer already gone */
    }
    if (message) (code === 0 ? process.stdout : process.stderr).write(message)
    process.exitCode = code
  }
  const transportFallback = () => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    try {
      sock.destroy()
    } catch {
      /* peer already gone */
    }
    fallback()
  }
  const timer = setTimeout(transportFallback, 1500)

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
        sock.write(
          JSON.stringify({
            t: 'cwd-report',
            id: String(paneId),
            token: paneToken,
            cwd,
            observedAt
          }) + '\n'
        )
      } else if (m.t === 'cwd-reported') {
        finish(0, 'mogging: cwd declared\n')
      } else if (m.t === 'error') {
        const auth = m.reason === 'auth'
        finish(auth ? 4 : 1, `mogging cwd: rejected (${m.reason || 'error'})\n`)
      }
    }
  })
  sock.on('error', () => {
    // A connect/write failure is absence of the primary transport, not a declaration verdict.
    transportFallback()
  })
  sock.on('close', () => {
    // Closing after welcome but before an answer still supplied no authoritative verdict.
    if (!settled) transportFallback()
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
        remote: p.remoteName ?? '',
        title: p.title ?? ''
      }))
      const w = (k, h) => Math.max(h.length, ...rows.map((r) => r[k].length))
      const wid = w('id', 'ID'),
        wsz = w('size', 'SIZE'),
        wst = w('state', 'STATE'),
        wrm = w('remote', 'REMOTE')
      const line = (a, b, c, d, e) =>
        a.padEnd(wid) + '  ' + b.padEnd(wsz) + '  ' + c.padEnd(wst) + '  ' + d.padEnd(wrm) + '  ' + e + '\n'
      process.stdout.write(line('ID', 'SIZE', 'STATE', 'REMOTE', 'TITLE'))
      for (const r of rows) process.stdout.write(line(r.id, r.size, r.state, r.remote, r.title))
      api.finish(0)
    },
    // A non-auth error frame used to be dropped on the floor: the daemon HAD answered, and
    // `mogging list` still died 5 s later on the timeout, blaming a daemon that "did not respond".
    (m, api) => {
      if (m.t === 'error') {
        process.stderr.write('mogging list: rejected (' + (m.reason || 'error') + ')\n')
        api.finish(1)
      }
    }
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

/** Claude Code's `Notification` hook is MULTIPLEXED: one event carrying eleven different `type`s,
 *  from "I need permission" to "<label> finished". Mapping the whole event to needs-input painted
 *  COMPLETED panes red — `agent_completed` fires the instant an agent finishes and raced the Stop
 *  hook's green (both ~130ms process spawns; last one wins, and attention is a latch, so the red
 *  stuck). `idle_prompt` is worse: an idle TIMER, so a finished green pane turned red a minute
 *  later just by sitting there. So WHITELIST the types that genuinely block on a human; everything
 *  else is not an alert and says nothing. Verified against the 2.1.207 bundle's notificationType
 *  producers. The `type` field ONLY: message/title never leave the process (ADR 0002). */
function notifTypeToEvent(type) {
  switch (type) {
    case 'permission_prompt':
    case 'worker_permission_prompt':
    case 'agent_needs_input':
    case 'elicitation_dialog':
      return 'needs-input' // a human is genuinely blocking the agent -> red
    case 'idle_prompt':
      return 'idle-prompt' // "waiting for your input" nudge -> parked, not blocked
    case 'agent_completed':
    case 'auth_success':
    case 'elicitation_complete':
    case 'elicitation_response':
    case 'computer_use_enter':
    case 'computer_use_exit':
    case 'push_notification':
      return null // not an alert at all -> stay silent
    default:
      return 'needs-input' // an unrecognized notification is still worth surfacing
  }
}

/** The hook payload rides stdin. Bounded: a TTY (a human running this by hand) or no payload
 *  within 400ms keeps the argv event; a hook must never hang the agent it's attached to. */
function readStdinType() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve(null)
    let buf = ''
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      try {
        // 'notification_type' is the REAL discriminator -- verified against a live Claude Code
        // turn (the docs call it 'type'; it is not). Reading 'type' yielded undefined, which fell
        // through to the argv event 'needs-input', so every notification -- completions included
        // -- still painted the pane red. 'type' stays only as a fallback for other dialects.
        const p = JSON.parse(buf)
        resolve(p.notification_type ?? p.type ?? null)
      } catch {
        resolve(null)
      }
    }
    const timer = setTimeout(done, 400)
    timer.unref?.()
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => {
      buf += c
    })
    process.stdin.on('end', () => {
      clearTimeout(timer)
      done()
    })
    process.stdin.on('error', () => {
      clearTimeout(timer)
      done()
    })
  })
}

async function runNotify(args) {
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

  // Only the Notification hook is ambiguous — don't stall any other event on stdin.
  if (event === 'needs-input') {
    const type = await readStdinType()
    if (type !== null) {
      const mapped = notifTypeToEvent(type)
      if (mapped === null) process.exit(0) // a completion / info notice: never an alert
      event = mapped
    }
  }

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
