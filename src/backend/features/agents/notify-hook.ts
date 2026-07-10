// The generated notify hook — the "always rings the bell" layer. Every agent CLI the
// app launches gets wired, session-scoped, to run this script on its own notify/hook
// events (Claude Code hooks, Codex notify, …), so the pane's attention state never
// depends on the user having configured their CLI (hooks/README.md documents the
// manual, out-of-app variant of the same snippets). Same shape as the context
// RELAY_SOURCE next door: the SOURCE is generated into userData by main (nothing to
// package, dev and installed builds identical) and needs `node` on PATH — without it
// the hook silently does nothing and the OSC/bell baseline still applies.
//
// The script is a standalone re-cut of `mogging notify` (bin/mogging.mjs): pane
// identity + endpoint from the env the daemon injects (MOGGING_PANE_ID /
// MOGGING_DAEMON_ENDPOINT), authed socket handshake, an event LABEL only — never
// prompt/PTY content or credentials (ADR 0002). A hook must never fail its agent:
// every path exits 0, and outside an app pane it no-ops.

export const NOTIFY_HOOK_SOURCE = `// MoggingLabs Workspace notify hook - GENERATED, do not edit (rewritten on app start).
// Raises the current pane's attention over the daemon's authed socket. Event label
// only: no prompt text, no credentials. Always exits 0 (a hook must never fail its
// agent); outside a MoggingLabs pane it silently no-ops.
import { readFileSync } from 'node:fs'
import * as net from 'node:net'

const args = process.argv.slice(2)
const opts = { _: [] }
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--event' || a === '-e') opts.event = args[++i]
  else if (a === '--message' || a === '-m') opts.message = args[++i]
  else if (a === '--pane' || a === '-p') opts.pane = args[++i]
  else opts._.push(a)
}

// Codex appends its event as a JSON blob; map its type to the house vocabulary.
const codexTypeToEvent = (type) => {
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

const paneId = opts.pane ?? process.env.MOGGING_PANE_ID
const endpointFile = process.env.MOGGING_DAEMON_ENDPOINT
const raw = opts.event ?? opts._[0] ?? ''
let event = raw
if (typeof raw === 'string' && raw.trim().startsWith('{')) {
  // Take ONLY the event type - never the message content riding in the blob.
  try {
    event = codexTypeToEvent(JSON.parse(raw).type)
  } catch {
    event = 'needs-input'
  }
}
if (!event) event = 'needs-input'
if (!paneId || !endpointFile) process.exit(0)

let ep
try {
  ep = JSON.parse(readFileSync(endpointFile, 'utf8'))
} catch {
  process.exit(0)
}

const sock = net.connect(ep.address)
sock.setEncoding('utf8')
let buf = ''
const finish = () => {
  try {
    sock.destroy()
  } catch {}
  process.exit(0)
}
const timer = setTimeout(finish, 4000) // never hang a hook
sock.on('connect', () => {
  sock.write(JSON.stringify({ t: 'hello', v: ep.version, token: ep.token }) + '\\n')
})
sock.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
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
      sock.write(JSON.stringify({ t: 'notify', id: String(paneId), event, message: opts.message }) + '\\n')
    } else if (m.t === 'notified' || m.t === 'error') {
      clearTimeout(timer)
      finish()
    }
  }
})
sock.on('error', finish)
`

/** Claude Code `hooks` settings fragment (rides the generated --settings file — a
 *  session overlay that MERGES with the user's own hooks, never a file of theirs).
 *  Notification = the agent is waiting on you (permission prompt / idle prompt);
 *  Stop = the turn ended. Both map to attention — the pane rings until you type. */
export function claudeNotifyHooks(invocation: string): Record<string, unknown> {
  const hook = (event: string): unknown[] => [
    { hooks: [{ type: 'command', command: `${invocation} --event ${event}` }] }
  ]
  return { Notification: hook('needs-input'), Stop: hook('done') }
}

// The other adapters ring via their CLI's own terminal-notification channel — OSC 9
// (or BEL) straight onto the PTY output stream, which the OscParser already latches
// as attention. No script, no shell-quoting, works even without `node`. Verified
// against each CLI's docs 2026-07-10; an older CLI without the key ignores it and
// the OSC/output-activity baseline still applies.

/** Codex: TUI notifications cover BOTH agent-turn-complete and approval-requested
 *  (the `notify` program only fires on turn-complete, and Codex hooks need an
 *  interactive /hooks trust pass — wrong tool for silent session wiring). Values are
 *  deliberately bare TOML (no quotes, no spaces) so they survive cmd/PowerShell/sh
 *  verbatim. `always`: the default `unfocused` suppresses the ring exactly when the
 *  pane is focused — but the DOT must flip regardless of focus. */
export function codexBellArgs(): string[] {
  return [
    '-c', 'tui.notifications=true',
    '-c', 'tui.notification_method=osc9',
    '-c', 'tui.notification_condition=always'
  ]
}

/** Gemini: no per-session flag exists; GEMINI_CLI_SYSTEM_SETTINGS_PATH points the
 *  CLI's SYSTEM overrides at an app-generated file. `existing` is the machine's real
 *  system settings (if any) — merged through so pointing the env var at our file
 *  never masks an admin's policy, only adds the notification switch. */
export function geminiSystemSettings(existing: unknown): string {
  const base = (existing && typeof existing === 'object' ? existing : {}) as Record<string, unknown>
  const general = (base.general && typeof base.general === 'object' ? base.general : {}) as Record<string, unknown>
  return JSON.stringify({ ...base, general: { ...general, enableNotifications: true } })
}

/** OpenCode: OPENCODE_TUI_CONFIG points at an app-generated tui.json. `existing` is
 *  the user's own tui.json (if any) — merged through so their sound/theme prefs
 *  survive; we only force the attention channel on (and never sound: that plays on
 *  the machine's speakers, while the OSC notification is what the pane parses). */
export function opencodeTuiConfig(existing: unknown): string {
  const base = (existing && typeof existing === 'object' ? existing : {}) as Record<string, unknown>
  const attention = (base.attention && typeof base.attention === 'object' ? base.attention : {}) as Record<string, unknown>
  return JSON.stringify({ ...base, attention: { ...attention, enabled: true, notifications: true } })
}

/** Aider: env-var config (v0.76+), fires when the LLM finished and waits for input.
 *  The COMMAND must always be set: with none, aider's Windows default notification
 *  is a BLOCKING MessageBox dialog. It runs via the platform shell and its stdout is
 *  captured (never the PTY), so it must be the notify script — a printed BEL would
 *  not reach the pane. */
export function aiderBellEnv(invocation: string): Record<string, string> {
  return { AIDER_NOTIFICATIONS: 'true', AIDER_NOTIFICATIONS_COMMAND: `${invocation} --event done` }
}
