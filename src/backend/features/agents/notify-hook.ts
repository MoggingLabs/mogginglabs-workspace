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

// Claude Code's Notification hook is MULTIPLEXED: one event carrying eleven different
// 'type's, from "I need permission" to "<label> finished". Mapping the whole event to
// needs-input painted COMPLETED panes red - 'agent_completed' fires the instant an agent
// finishes, and raced the Stop hook's green (both ~130ms process spawns; last one wins,
// and attention is a latch, so red stuck). 'idle_prompt' is worse: an idle TIMER, so a
// finished green pane turned red a minute later just by sitting there.
// So: WHITELIST the types that are genuinely blocked on a human. Everything else is not
// an alert and says nothing. Verified against the 2.1.207 bundle's notificationType
// producers. The 'type' field ONLY - message/title never leave this process (ADR 0002).
const notifTypeToEvent = (type) => {
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
      // An unrecognized type is a GUESS, and guesses take the bell's held-for-contradiction
      // path - never a direct red latch. The old default (needs-input) red-locked every pane
      // whose CLI learned a new notification type before this list did: the /goal system
      // shipped types this list never saw, Claude fires notifications mostly for UNFOCUSED
      // panes, and so four background agents that had just ACHIEVED their goals latched red
      // the moment the achieve notice landed (found live, 2026-07-15 - green check, then
      // red, only on the panes Pedro wasn't watching). As a 'notice' the daemon holds it
      // for BELL_CONFIRM_MS: on a pane wearing 'done' it is swallowed as that turn's own
      // news; mid-turn with no done behind it, it still rings - a genuinely new BLOCKING
      // type keeps surfacing, a beat later.
      return 'notice'
  }
}

// The payload rides stdin. Bounded: a TTY (a human running this by hand) or no payload
// within 400ms keeps the argv event; a hook must never hang its agent.
const readStdinType = () =>
  new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve(null)
    let buf = ''
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      try {
        // 'notification_type' is the REAL discriminator -- VERIFIED against a live Claude Code
        // turn, which hands a Notification hook exactly this:
        //   {"hook_event_name":"Notification","notification_type":"idle_prompt",
        //    "message":"Claude is waiting for your input","session_id":..,"cwd":..}
        // The docs call it 'type'. It is not. Reading 'type' yielded undefined, undefined fell
        // through to the argv event ('needs-input'), and so EVERY notification still painted the
        // pane red -- completions included. That was the entire bug, and no unit test could have
        // caught it: the tests fed the same wrong shape the code read. Only a live turn did.
        // 'type' stays as a fallback for any other dialect that uses it.
        const p = JSON.parse(buf)
        resolve(p.notification_type ?? p.type ?? null)
      } catch {
        resolve(null)
      }
    }
    const t = setTimeout(done, 400)
    t.unref?.()
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => { buf += c })
    process.stdin.on('end', () => { clearTimeout(t); done() })
    process.stdin.on('error', () => { clearTimeout(t); done() })
  })
// Only the Notification hook is ambiguous - don't stall any other event on stdin.
if (event === 'needs-input') {
  const type = await readStdinType()
  if (type !== null) {
    const mapped = notifTypeToEvent(type)
    if (mapped === null) process.exit(0) // a completion / info notice: never an alert
    event = mapped
  }
}

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
 *  Notification = the agent is waiting on you (permission prompt / idle prompt) —
 *  rings attention (red) until you type. Stop = the turn ended — lands as idle, which
 *  the attention port turns into the sticky green finished halo (until the pane is
 *  clicked). Two events, two distinct color stories: red = blocked, green = done.
 *  SubagentStart/SubagentStop feed the tracker's pending counter — a GATE, never a
 *  source: alerts stay the MAIN agent's story. A parent parked on its subagents goes
 *  neither green (that Stop is DROPPED — the green belongs to its next, real done) nor
 *  red (the idle_prompt Notification — which the script splits off the payload's type
 *  field — is dropped while work is in flight). UserPromptSubmit resets the counter, so
 *  a stop lost to a hard kill can't strand the pane on busy past the next prompt. */
export function claudeNotifyHooks(invocation: string): Record<string, unknown> {
  const hook = (event: string): unknown[] => [
    { hooks: [{ type: 'command', command: `${invocation} --event ${event}` }] }
  ]
  return {
    Notification: hook('needs-input'),
    Stop: hook('done'),
    SubagentStart: hook('subagent-start'),
    SubagentStop: hook('subagent-stop'),
    UserPromptSubmit: hook('turn-start')
  }
}

// The other adapters ring via their CLI's own terminal-notification channel — OSC 9
// (or BEL) straight onto the PTY output stream, which the OscParser already latches
// as attention. No script, no shell-quoting, works even without `node`. Verified
// against each CLI's docs 2026-07-10; an older CLI without the key ignores it and
// the OSC/output-activity baseline still applies.

/** Codex speaks BOTH channels, and it needs both — that is the whole trick.
 *
 *  Its TUI notification (OSC 9) fires on turn-complete AND when it wants approval, so on
 *  its own it is ambiguous, and the OscParser's only reading of it was "attention". That
 *  left every COMPLETED Codex pane stuck red, with green unreachable. Its `notify` program,
 *  by contrast, fires ONLY on turn-complete (verified against the 0.144 binary: it emits
 *  `{"type":"agent-turn-complete"}` and has no approval event at all). So wire both and the
 *  pair becomes a discriminator, resolved by the tracker's bell window:
 *      turn complete  -> OSC 9 (guess) + notify `done` -> the done cancels the guess -> GREEN
 *      wants approval -> OSC 9 (guess) alone, nothing contradicts it          -> RED
 *
 *  Quoting: the notify value is a TOML array, which needs quoted strings — and escaping "
 *  through cmd.exe (the default pane shell) vs sh vs PowerShell is a minefield. TOML
 *  LITERAL strings (single quotes) need no escaping in any of the three. The spaces inside
 *  the array are load-bearing: buildLaunchCommand double-quotes any arg containing
 *  whitespace, and that outer quoting is what keeps the single quotes literal in sh — do
 *  not "tidy" them away. Verified end-to-end with `codex doctor` (config parse ok, auth
 *  untouched) through both cmd.exe and PowerShell.
 *
 *  `always`: the default `unfocused` suppresses the ring exactly when the pane is focused —
 *  but the DOT must flip regardless of focus. The other values stay bare TOML (no quotes,
 *  no spaces) so they survive every shell verbatim.
 *
 *  `notifyScript` is the generated notify.mjs (null when it could not be written, or when
 *  its path contains a `'` — a TOML literal cannot escape one, and a launch must never
 *  break over the bell). Without it Codex keeps the OSC-9 baseline. */
export function codexBellArgs(notifyScript?: string): string[] {
  const args = [
    '-c', 'tui.notifications=true',
    '-c', 'tui.notification_method=osc9',
    '-c', 'tui.notification_condition=always'
  ]
  const p = notifyScript?.replace(/\\/g, '/')
  if (p && !p.includes("'")) args.push('-c', `notify=[ 'node', '${p}' ]`)
  return args
}

/** Gemini needs both channels too, for exactly Codex's reason.
 *
 *  `enableNotifications` is one switch covering BOTH halves of the story — its own schema
 *  says "terminal run-event notifications for action-required prompts AND session
 *  completion" — so read as attention it painted completed panes red. Its hook system
 *  supplies the missing verdict: `AfterAgent` ("after agent loop completes") is the done.
 *      completes    -> notification (guess) + AfterAgent `done` -> the done wins  -> GREEN
 *      needs a human -> notification (guess) alone, uncontradicted                -> RED
 *
 *  AfterAgent is the MAIN loop only — verified against the 0.50 bundle: its sole firing
 *  site is GeminiClient.sendMessageStream, keyed by the user's prompt_id, and subagents run
 *  through LocalAgentExecutor, which fires no Agent hooks at all. So subagents stay
 *  invisible here by construction, which is the house rule anyway (activity.ts).
 *  BeforeAgent is the turn boundary — it resets the pending-subagent counter.
 *
 *  Hooks are ON by default (`enableHooks ?? true`), so no extra switch is needed. The
 *  notification METHOD is deliberately left alone: `auto` resolves to OSC 9, OSC 777;notify
 *  or a bare BEL depending on the terminal, and the OscParser reads all three — so pinning
 *  it would override a user's choice for no gain.
 *
 *  `existing` is the machine's real system settings (if any), merged through so pointing the
 *  env var at our file never masks an admin's policy. Hook arrays CONCAT (the schema's own
 *  mergeStrategy), so an admin's hooks survive alongside ours. `notifyInvocation` is null
 *  when the script could not be written — Gemini then keeps the notification-only baseline. */
export function geminiSystemSettings(
  existing: unknown,
  notifyInvocation?: string,
  session: Record<string, unknown> = {}
): string {
  const base = (existing && typeof existing === 'object' ? existing : {}) as Record<string, unknown>
  const desired = (session && typeof session === 'object' ? session : {}) as Record<string, unknown>
  const general = (base.general && typeof base.general === 'object' ? base.general : {}) as Record<string, unknown>
  const out: Record<string, unknown> = {
    ...desired,
    ...base,
    general: {
      ...(desired.general && typeof desired.general === 'object' ? desired.general as Record<string, unknown> : {}),
      ...general,
      enableNotifications: true
    }
  }
  if (notifyInvocation) {
    const hooks = (base.hooks && typeof base.hooks === 'object' ? base.hooks : {}) as Record<string, unknown>
    const prior = (name: string): unknown[] => (Array.isArray(hooks[name]) ? (hooks[name] as unknown[]) : [])
    const hook = (event: string): unknown => ({
      hooks: [{ type: 'command', command: `${notifyInvocation} --event ${event}` }]
    })
    out.hooks = {
      ...hooks,
      BeforeAgent: [...prior('BeforeAgent'), hook('turn-start')],
      AfterAgent: [...prior('AfterAgent'), hook('done')]
    }
  }
  return JSON.stringify(out)
}

/** OpenCode: OPENCODE_TUI_CONFIG points at an app-generated tui.json. `existing` is
 *  the user's own tui.json (if any) — merged through so their sound/theme prefs
 *  survive; we only force the attention channel on (and never sound: that plays on
 *  the machine's speakers, while the OSC notification is what the pane parses).
 *
 *  This channel is ambiguous like all the others — its own event vocabulary is
 *  ["default","question","permission","error","done","subagent_done"], so it chimes for
 *  COMPLETION (and for a mere subagent finishing) exactly as it does for a question. The
 *  plugin below supplies the verdicts that disambiguate it. */
export function opencodeTuiConfig(existing: unknown, session: Record<string, unknown> = {}): string {
  const base = (existing && typeof existing === 'object' ? existing : {}) as Record<string, unknown>
  const desired = (session && typeof session === 'object' ? session : {}) as Record<string, unknown>
  const baseAttention = (base.attention && typeof base.attention === 'object' ? base.attention : {}) as Record<string, unknown>
  const desiredAttention = (desired.attention && typeof desired.attention === 'object' ? desired.attention : {}) as Record<string, unknown>
  return JSON.stringify({ ...base, ...desired, attention: { ...baseAttention, ...desiredAttention, enabled: true, notifications: true } })
}

/** OpenCode has no hook config — its only verdict channel is a PLUGIN, so we generate one.
 *
 *  It listens for `session.idle` and speaks the house vocabulary:
 *    - the ROOT session going idle is the main agent finishing  -> `done`  -> GREEN
 *    - a CHILD session going idle is a subagent finishing       -> `subagent-stop`, which
 *      authors no state at all; it exists only to cancel the `subagent_done` chime the TUI
 *      fires at that same instant, which would otherwise ring the pane RED for a subagent.
 *  A question/permission chime has nothing behind it and still rings red, as it should.
 *
 *  Root vs child is `parentID` — OpenCode's own idiom is `list().find(s => !s.parentID)`,
 *  and the plugin uses the same SDK call. If the lookup fails we fall back to treating the
 *  session as the root: a missed green is recoverable, a pane stuck busy forever is not.
 *
 *  The plugin must never throw — an exception here would surface inside the user's agent —
 *  so every path is wrapped and failure is silent. It shells out to the generated notify
 *  script rather than reimplementing the daemon handshake: one wire format, one place to
 *  fix. `node` (not process.execPath, which is OpenCode's own Bun binary). */
export function opencodePluginSource(notifyScript: string): string {
  return `// MoggingLabs Workspace notify plugin - GENERATED, do not edit (rewritten on app start).
// Turns OpenCode's ambiguous attention chime into an honest pane state. Event labels only:
// no prompt text, no credentials (ADR 0002). Never throws; outside a pane it no-ops.
import { spawn } from 'node:child_process'

const SCRIPT = ${JSON.stringify(notifyScript)}

const fire = (event) => {
  if (!process.env.MOGGING_PANE_ID || !process.env.MOGGING_DAEMON_ENDPOINT) return
  try {
    const p = spawn('node', [SCRIPT, '--event', event], { stdio: 'ignore', windowsHide: true })
    p.on('error', () => {})
    p.unref?.()
  } catch {}
}

export const MoggingNotify = async ({ client }) => ({
  event: async ({ event }) => {
    try {
      if (event?.type !== 'session.idle') return
      const id = event.properties?.sessionID ?? event.properties?.sessionId
      let isChild = false
      try {
        const sessions = (await client.session.list())?.data ?? []
        isChild = !!sessions.find((s) => s.id === id)?.parentID
      } catch {}
      fire(isChild ? 'subagent-stop' : 'done')
    } catch {}
  }
})
`
}

/** The generated OpenCode config that loads the plugin. OPENCODE_CONFIG is APPENDED to
 *  OpenCode's config list (verified: \`if (env.OPENCODE_CONFIG) files.push(env.OPENCODE_CONFIG)\`),
 *  it does not replace the user's — and \`plugin\` arrays CONCAT across configs (verified with
 *  \`opencode debug config\`), so their own plugins survive and we add ours. Never write to the
 *  user's config, and never copy it: it is still loaded on its own.
 *
 *  The spec MUST be a file:// URL. A bare path is treated as an npm package and OpenCode
 *  HANGS trying to fetch it — that would freeze every launch (found live, 2026-07-11). */
function configRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function mergeOpenCodeConfig(base: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(next)) {
    const prior = out[key]
    out[key] = configRecord(prior) && configRecord(value) ? mergeOpenCodeConfig(prior, value) : value
  }
  if (Array.isArray(base.instructions) && Array.isArray(next.instructions)) {
    out.instructions = [...new Set([...base.instructions, ...next.instructions])]
  }
  return out
}

export function opencodeConfig(
  pluginPath: string | undefined,
  session: Record<string, unknown> = {},
  inherited: Record<string, unknown> = {}
): string {
  const merged = mergeOpenCodeConfig(inherited, session)
  const inheritedPlugins = Array.isArray(inherited.plugin) ? inherited.plugin : []
  const sessionPlugins = Array.isArray(session.plugin) ? session.plugin : []
  const plugin = pluginPath ? 'file:///' + pluginPath.replace(/\\/g, '/').replace(/^\/+/, '') : undefined
  const plugins = [...new Set([...inheritedPlugins, ...sessionPlugins, ...(plugin ? [plugin] : [])])]
  return JSON.stringify({ ...merged, $schema: merged.$schema ?? 'https://opencode.ai/config.json', ...(plugins.length ? { plugin: plugins } : {}) })
}

/** Aider: env-var config (v0.76+), fires when the LLM finished and waits for input.
 *  The COMMAND must always be set: with none, aider's Windows default notification
 *  is a BLOCKING MessageBox dialog. It runs via the platform shell and its stdout is
 *  captured (never the PTY), so it must be the notify script — a printed BEL would
 *  not reach the pane. */
export function aiderBellEnv(invocation: string): Record<string, string> {
  return { AIDER_NOTIFICATIONS: 'true', AIDER_NOTIFICATIONS_COMMAND: `${invocation} --event done` }
}
