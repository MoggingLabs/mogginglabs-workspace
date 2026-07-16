import { MCP_MANAGED_BY } from '@contracts'
import { tstr } from '../integrations/writers/codex'
import { parseConfig, stringifyConfig } from '../integrations/writers/json-dialect'
import { claudeNotifyHooks } from './notify-hook'

// GLOBAL Claude alert hooks — closing the hand-typed-launch gap.
//
// The bell layer rides each LAUNCH: an app-launched claude carries a generated `--settings`
// overlay whose hooks speak `mogging notify` to the daemon. A claude the user types at the
// pane's own prompt gets none of that — the typed-launch detector adopts it (dot, git chip,
// gauge), but its hooks never fire, so the pane is verdict-mute: no busy, no green, no red,
// forever. Found live 2026-07-16: a hand-typed claude worked through a 15-minute turn while
// its pane rested on the daemon's replayed default — a working agent wearing idle.
//
// The fix is the one hooks/README.md already documents by hand: put the SAME hook entries in
// the user's GLOBAL Claude settings. That is safe everywhere by construction — the generated
// notify script resolves MOGGING_PANE_ID / MOGGING_DAEMON_ENDPOINT from its environment and
// exits 0 silently when they are absent, so outside a MoggingLabs pane (a plain terminal, an
// editor, CI) a global hook is a no-op; inside ANY pane — typed, launched, restored — it
// rings the pane. (The app's own background claude runs — the usage refresh — scrub the pane
// env first for exactly this reason, so they stay silent too.)
//
// House rule: the app never writes a user-owned config file except on an EXPLICIT user
// action, with a backup, atomically, refusing concurrent edits (the MCP manager's discipline,
// ADR 0008.b — the app wiring in src/main/claude-global-hooks.ts reuses its exact helpers).
// This module is the pure half: derive the merged/stripped settings text and read the applied
// state; no filesystem, no Electron, unit-tested directly.
//
// DOUBLE WIRING IS SAFE, so the launch overlay keeps its hooks even once the global set is
// applied: both then fire per event, and the tracker is idempotent under the duplication —
// same-state applies coalesce, latches are latches, and the subagent counter moves ±2 in
// balanced pairs. The overlay must stay: profile launches point CLAUDE_CONFIG_DIR at a
// different home, where the global file (and these hooks) may not exist.

/** The five hook events the bell layer wires (one source: claudeNotifyHooks). */
const HOOK_EVENTS = ['Notification', 'Stop', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit'] as const

export type GlobalHooksState =
  | 'applied' // every event carries OUR entry with the CURRENT invocation
  | 'partial' // our entries present but incomplete or pointing at a stale script path
  | 'not-applied'
  | 'unreadable' // the settings file exists but is not JSON we are willing to rewrite

/** OURS, any vintage: the generated script lives at `<userData>/notify-hook/notify.mjs` and
 *  is invoked as `node "<path>" --event <e>`. userData moves between installs and channels,
 *  so identity is the SHAPE (the notify-hook dir + script name + the --event flag), never one
 *  absolute path — a stale entry from an old install must still read as ours, or apply would
 *  stack a second copy beside it instead of replacing it. */
export function isOurHookCommand(command: unknown): boolean {
  return (
    typeof command === 'string' &&
    /notify-hook[\\/]notify\.mjs/.test(command) &&
    command.includes('--event')
  )
}

interface HookMatcherEntry {
  hooks?: unknown
  [key: string]: unknown
}

function entryIsOurs(entry: unknown): boolean {
  const hooks = (entry as HookMatcherEntry | null)?.hooks
  if (!Array.isArray(hooks)) return false
  return hooks.some((h) => isOurHookCommand((h as { command?: unknown } | null)?.command))
}

function parseSettings(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function hooksMap(obj: Record<string, unknown>): Record<string, unknown> {
  const hooks = obj.hooks
  return hooks && typeof hooks === 'object' && !Array.isArray(hooks) ? (hooks as Record<string, unknown>) : {}
}

/** Entries for one event, tolerant of a hand-edited single object where an array belongs. */
function eventEntries(hooks: Record<string, unknown>, event: string): unknown[] {
  const value = hooks[event]
  if (Array.isArray(value)) return value
  return value === undefined ? [] : [value]
}

/** What the file says, against the invocation the CURRENT app would write. */
export function globalHooksState(text: string | null, invocation: string): GlobalHooksState {
  if (text === null) return 'not-applied'
  const obj = parseSettings(text)
  if (!obj) return 'unreadable'
  const hooks = hooksMap(obj)
  const expected = claudeNotifyHooks(invocation) as Record<string, Array<{ hooks: Array<{ command: string }> }>>
  let exact = 0
  let ours = 0
  for (const event of HOOK_EVENTS) {
    const entries = eventEntries(hooks, event)
    const mine = entries.filter(entryIsOurs)
    if (mine.length) ours++
    const want = expected[event]?.[0]?.hooks?.[0]?.command
    const current = mine.some((entry) =>
      (entry as HookMatcherEntry).hooks &&
      Array.isArray((entry as HookMatcherEntry).hooks) &&
      ((entry as { hooks: Array<{ command?: unknown }> }).hooks).some((h) => h?.command === want)
    )
    if (current) exact++
  }
  if (exact === HOOK_EVENTS.length) return 'applied'
  if (ours > 0) return 'partial'
  return 'not-applied'
}

/** The merged settings text: every user key and every user hook entry survives byte-for-value;
 *  OUR entries (any vintage) are replaced, never stacked. Throws on JSON we cannot faithfully
 *  rewrite — the caller refuses rather than clobbers (same stance as the MCP writers). */
export function applyGlobalHooks(text: string | null, invocation: string): string {
  const obj = text === null ? {} : parseSettings(text)
  if (!obj) throw new Error('settings.json is not an object we can faithfully rewrite')
  const hooks = { ...hooksMap(obj) }
  const expected = claudeNotifyHooks(invocation) as Record<string, unknown[]>
  for (const event of HOOK_EVENTS) {
    const kept = eventEntries(hooks, event).filter((entry) => !entryIsOurs(entry))
    hooks[event] = [...kept, ...(expected[event] ?? [])]
  }
  return JSON.stringify({ ...obj, hooks }, null, 2) + '\n'
}

/** The stripped settings text, or null when there is nothing of ours to remove. Empty arrays
 *  and an emptied `hooks` map are dropped rather than left as husks in the user's file. */
export function removeGlobalHooks(text: string | null): string | null {
  if (text === null) return null
  const obj = parseSettings(text)
  if (!obj) throw new Error('settings.json is not an object we can faithfully rewrite')
  const hooks = { ...hooksMap(obj) }
  let changed = false
  for (const event of Object.keys(hooks)) {
    const entries = eventEntries(hooks, event)
    const kept = entries.filter((entry) => !entryIsOurs(entry))
    if (kept.length !== entries.length) {
      changed = true
      if (kept.length) hooks[event] = kept
      else delete hooks[event]
    }
  }
  if (!changed) return null
  const next: Record<string, unknown> = { ...obj }
  if (Object.keys(hooks).length) next.hooks = hooks
  else delete next.hooks
  return JSON.stringify(next, null, 2) + '\n'
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// THE OTHER THREE CLIs — same treatment, each in its own dialect.
//
// Codex, Gemini and OpenCode typed at a pane's own prompt are chime-less the same way a
// hand-typed claude was hook-less: their bell config rides the LAUNCH (codex `-c` flags, the
// GEMINI_CLI_SYSTEM_SETTINGS_PATH overlay, OPENCODE_TUI_CONFIG/OPENCODE_CONFIG_CONTENT), so a
// typed launch carries none of it. The global equivalents below write the user's OWN config
// files — explicit consent, backup, atomic, refusal over clobber, exactly like the claude
// half above and the MCP writers these dialects are borrowed from.
//
// The DOUBLE-WIRING story per CLI, since app launches keep their session-scoped config:
//   codex     `-c` overrides win over config.toml — one notify invocation, same TUI values.
//   gemini    system settings merge OVER user settings and hook arrays CONCAT — both copies
//             fire, and the tracker is idempotent under duplication (turn-start/done pairs).
//   opencode  plugin specs are deduped by VALUE where configs merge; even loaded twice, its
//             events are `done`/`subagent-stop`, both safe duplicated (stray-stop guard).
//
// CONFLICT is a state here, not an error code: codex has exactly ONE `notify` slot and ONE
// value per tui key — a user who set their own is not drift to heal, it is their machine.
// We refuse, name the line, and the UI shows why there is no Apply.

export type GlobalHookProviderId = 'claude' | 'codex' | 'gemini' | 'opencode'

export type GlobalWiringState = GlobalHooksState | 'conflict'

/** Our inline line tag for the TOML dialect — the same marker the MCP writers use. */
const CODEX_LINE_TAG = `# managed-by: ${MCP_MANAGED_BY}`

const codexTagged = (line: string): boolean => new RegExp(`#\\s*managed-by:\\s*${MCP_MANAGED_BY}\\s*$`).test(line.trim())

/** `key = value` with our tag; value rendering is the caller's (already TOML-escaped). */
const codexLine = (key: string, value: string): string => `${key} = ${value} ${CODEX_LINE_TAG}`

/** The value of a `key = …` TOML line with any trailing comment stripped — a tiny scanner
 *  that respects double quotes, for comparing the SIMPLE scalars we own (true/"osc9"/…). */
export function tomlLineValue(line: string): string {
  const eq = line.indexOf('=')
  if (eq === -1) return ''
  const rest = line.slice(eq + 1)
  let out = ''
  let inString = false
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i]
    if (c === '"' && rest[i - 1] !== '\\') inString = !inString
    if (c === '#' && !inString) break
    out += c
  }
  return out.trim()
}

const CODEX_TUI_KEYS: ReadonlyArray<{ key: string; value: string }> = [
  { key: 'notifications', value: 'true' },
  { key: 'notification_method', value: '"osc9"' },
  { key: 'notification_condition', value: '"always"' }
]

const keyLineRe = (key: string): RegExp => new RegExp(`^\\s*${key}\\s*=`)
/** OUR notify program, any vintage — the generated script's shape (the path may be written
 *  with forward slashes, single backslashes, or TOML-escaped double backslashes). */
const notifyValueIsOurs = (value: string): boolean => /notify-hook[/\\]{1,2}notify\.mjs/.test(value)

interface CodexRegions {
  lines: string[]
  /** Exclusive end of the top-level key region (the first `[` header, or EOF). */
  topEnd: number
  /** [tui] table: header line index and exclusive end (next `[` header / EOF), or null. */
  tui: { header: number; end: number } | null
}

function codexRegions(text: string): CodexRegions {
  const lines = text.split('\n')
  let topEnd = lines.length
  let tui: CodexRegions['tui'] = null
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (!t.startsWith('[')) continue
    if (topEnd === lines.length) topEnd = i
    if (t === '[tui]' && !tui) {
      let end = i + 1
      while (end < lines.length && !lines[end].trim().startsWith('[')) end++
      tui = { header: i, end }
    }
  }
  return { lines, topEnd, tui }
}

const codexNotifyValue = (scriptPath: string): string => `[ "node", ${tstr(scriptPath)} ]`

class WiringConflictError extends Error {}
export const isWiringConflict = (e: unknown): e is WiringConflictError => e instanceof WiringConflictError

/** What the user's config.toml says about the bell wiring. `reason` names a conflict. */
export function codexGlobalState(text: string | null, scriptPath: string): { state: GlobalWiringState; reason?: string } {
  if (text === null) return { state: 'not-applied' }
  const { lines, topEnd, tui } = codexRegions(text)
  let exact = 0
  let ours = 0
  const want = [codexNotifyValue(scriptPath), ...CODEX_TUI_KEYS.map((k) => k.value)]
  const found: Array<string | null> = []
  const notifyLine = lines.slice(0, topEnd).find((l) => keyLineRe('notify').test(l)) ?? null
  found.push(notifyLine)
  for (const { key } of CODEX_TUI_KEYS) {
    found.push(tui ? lines.slice(tui.header + 1, tui.end).find((l) => keyLineRe(key).test(l)) ?? null : null)
  }
  for (let i = 0; i < found.length; i++) {
    const line = found[i]
    if (line === null) continue
    const value = tomlLineValue(line)
    if (codexTagged(line)) {
      ours++
      if (value === want[i]) exact++
      continue
    }
    // Untagged: the user's own. Equal value (or, for notify, their own wiring of OUR script)
    // is satisfied; anything else is THEIR machine speaking — a conflict, never drift.
    if (value === want[i] || (i === 0 && notifyValueIsOurs(value))) {
      exact++
      continue
    }
    const key = i === 0 ? 'notify' : `tui.${CODEX_TUI_KEYS[i - 1].key}`
    return { state: 'conflict', reason: `config.toml already sets ${key} = ${value} (not managed by this app)` }
  }
  if (exact === found.length) return { state: 'applied' }
  if (ours > 0) return { state: 'partial' }
  return { state: 'not-applied' }
}

/** The rewritten config.toml. Line splices only — foreign lines are never re-serialized
 *  (the MCP codex writer's discipline). Throws WiringConflictError where the user's own
 *  values occupy a slot; parse-free, so any text is safe to leave untouched on refusal. */
export function applyCodexGlobal(text: string | null, scriptPath: string): string {
  const state = codexGlobalState(text, scriptPath)
  if (state.state === 'conflict') throw new WiringConflictError(state.reason)
  const base = text ?? ''
  const { lines, topEnd, tui } = codexRegions(base)
  const out = [...lines]
  const notifyWanted = codexLine('notify', codexNotifyValue(scriptPath))

  // notify: replace OUR line, keep a satisfied user line, else insert into the top-level region.
  const notifyIdx = out.slice(0, topEnd).findIndex((l) => keyLineRe('notify').test(l))
  let insertedAboveTui = 0
  if (notifyIdx !== -1) {
    if (codexTagged(out[notifyIdx])) out[notifyIdx] = notifyWanted
  } else {
    // End of the top-level region, before the blank line(s) that precede the first table.
    let at = topEnd
    while (at > 0 && out[at - 1].trim() === '') at--
    out.splice(at, 0, notifyWanted)
    insertedAboveTui = 1
  }

  // [tui]: replace our tagged lines, keep satisfied user lines, insert what is missing.
  if (!tui) {
    while (out.length && out[out.length - 1].trim() === '') out.pop()
    if (out.length && out[out.length - 1].trim() !== '') out.push('')
    out.push('[tui]', ...CODEX_TUI_KEYS.map(({ key, value }) => codexLine(key, value)))
  } else {
    const header = tui.header + insertedAboveTui
    let end = tui.end + insertedAboveTui
    for (const { key, value } of CODEX_TUI_KEYS) {
      const region = out.slice(header + 1, end)
      const rel = region.findIndex((l) => keyLineRe(key).test(l))
      if (rel === -1) {
        out.splice(header + 1, 0, codexLine(key, value))
        end++
      } else if (codexTagged(region[rel])) {
        out[header + 1 + rel] = codexLine(key, value)
      }
      // untagged + equal value: satisfied, leave the user's line alone
    }
  }
  const joined = out.join('\n')
  return joined.endsWith('\n') ? joined : joined + '\n'
}

/** Strip OUR tagged lines (a bare `[tui]` header we may leave behind is valid, empty TOML).
 *  Null when nothing of ours is present. */
export function removeCodexGlobal(text: string | null): string | null {
  if (text === null) return null
  const lines = text.split('\n')
  const kept = lines.filter((l) => !codexTagged(l))
  if (kept.length === lines.length) return null
  return kept.join('\n')
}

// ── Gemini: the user's own settings.json ───────────────────────────────────────────────────
//
// general.enableNotifications is the chime (their schema: action-required prompts AND session
// completion — one switch), the BeforeAgent/AfterAgent hooks are the verdicts that make it
// legible. Hook entries carry our command shape, so ours are identifiable; the BOOLEAN cannot
// carry a marker, so apply() returns a MEMO of what it displaced ('absent' | 'false' | 'true')
// and remove() restores from it — without a memo the value is left alone, honestly: we cannot
// know whether it was ours.

export interface GeminiWiringMemo {
  enableNotifications: 'absent' | 'false' | 'true'
}

const geminiHookEvents = (invocation: string): Array<{ event: string; command: string }> => [
  { event: 'BeforeAgent', command: `${invocation} --event turn-start` },
  { event: 'AfterAgent', command: `${invocation} --event done` }
]

function geminiGeneral(obj: Record<string, unknown>): Record<string, unknown> {
  const general = obj.general
  return general && typeof general === 'object' && !Array.isArray(general) ? (general as Record<string, unknown>) : {}
}

export function geminiGlobalState(text: string | null, invocation: string): { state: GlobalWiringState; reason?: string } {
  if (text === null) return { state: 'not-applied' }
  let obj: Record<string, unknown>
  try {
    obj = parseConfig(text)
  } catch (e) {
    return { state: 'unreadable', reason: String((e as Error).message) }
  }
  const hooks = hooksMap(obj)
  let exact = 0
  let ours = 0
  for (const { event, command } of geminiHookEvents(invocation)) {
    const entries = eventEntries(hooks, event)
    const mine = entries.filter(entryIsOurs)
    if (mine.length) ours++
    if (mine.some((entry) => (entry as { hooks?: Array<{ command?: unknown }> }).hooks?.some((h) => h?.command === command))) exact++
  }
  const chimeOn = geminiGeneral(obj).enableNotifications === true
  if (exact === 2 && chimeOn) return { state: 'applied' }
  if (ours > 0) return { state: 'partial' }
  return { state: 'not-applied' }
}

export function applyGeminiGlobal(text: string | null, invocation: string): { text: string; memo: GeminiWiringMemo } {
  const obj = text === null ? {} : parseConfig(text)
  const general = { ...geminiGeneral(obj) }
  const prior = general.enableNotifications
  const memo: GeminiWiringMemo = {
    enableNotifications: prior === true ? 'true' : prior === false ? 'false' : 'absent'
  }
  general.enableNotifications = true
  const hooks = { ...hooksMap(obj) }
  for (const { event, command } of geminiHookEvents(invocation)) {
    const kept = eventEntries(hooks, event).filter((entry) => !entryIsOurs(entry))
    hooks[event] = [...kept, { hooks: [{ type: 'command', command }] }]
  }
  return { text: stringifyConfig({ ...obj, general, hooks }, text), memo }
}

export function removeGeminiGlobal(text: string | null, memo: GeminiWiringMemo | null): string | null {
  if (text === null) return null
  const obj = parseConfig(text)
  const hooks = { ...hooksMap(obj) }
  let changed = false
  for (const event of Object.keys(hooks)) {
    const entries = eventEntries(hooks, event)
    const kept = entries.filter((entry) => !entryIsOurs(entry))
    if (kept.length !== entries.length) {
      changed = true
      if (kept.length) hooks[event] = kept
      else delete hooks[event]
    }
  }
  const general = { ...geminiGeneral(obj) }
  if (memo && memo.enableNotifications !== 'true' && general.enableNotifications === true) {
    changed = true
    if (memo.enableNotifications === 'false') general.enableNotifications = false
    else delete general.enableNotifications
  }
  if (!changed) return null
  const next: Record<string, unknown> = { ...obj }
  if (Object.keys(hooks).length) next.hooks = hooks
  else delete next.hooks
  if (Object.keys(general).length) next.general = general
  else delete next.general
  return stringifyConfig(next, text)
}

// ── OpenCode: tui.json (the chime) + opencode.json (the verdict plugin) ────────────────────
//
// Two files because OpenCode splits them: the attention chime lives in tui.json, and the only
// verdict channel is a PLUGIN listed in opencode.json — a file:// spec pointing at the
// generated plugin in userData (a bare path is fetched as an npm package and HANGS the
// launch). The plugin's own fire() checks the pane env, so globally listed means inert
// outside panes. Booleans again cannot carry markers, so tui.json apply/remove rides a memo;
// the plugin spec IS its own marker (…/notify-hook/opencode-notify-plugin.mjs).

export interface OpencodeTuiMemo {
  enabled: 'absent' | 'false' | 'true'
  notifications: 'absent' | 'false' | 'true'
}

const OUR_PLUGIN_RE = /notify-hook\/opencode-notify-plugin\.mjs$/

function opencodeAttention(obj: Record<string, unknown>): Record<string, unknown> {
  const attention = obj.attention
  return attention && typeof attention === 'object' && !Array.isArray(attention) ? (attention as Record<string, unknown>) : {}
}

const tuiMemoOf = (value: unknown): 'absent' | 'false' | 'true' =>
  value === true ? 'true' : value === false ? 'false' : 'absent'

export function applyOpencodeTui(text: string | null): { text: string; memo: OpencodeTuiMemo } {
  const obj = text === null ? {} : parseConfig(text)
  const attention = { ...opencodeAttention(obj) }
  const memo: OpencodeTuiMemo = { enabled: tuiMemoOf(attention.enabled), notifications: tuiMemoOf(attention.notifications) }
  attention.enabled = true
  attention.notifications = true
  return { text: stringifyConfig({ ...obj, attention }, text), memo }
}

export function removeOpencodeTui(text: string | null, memo: OpencodeTuiMemo | null): string | null {
  if (text === null || !memo) return null // without a memo we cannot know what was theirs
  const obj = parseConfig(text)
  const attention = { ...opencodeAttention(obj) }
  let changed = false
  for (const key of ['enabled', 'notifications'] as const) {
    const prior = memo[key]
    if (prior !== 'true' && attention[key] === true) {
      changed = true
      if (prior === 'false') attention[key] = false
      else delete attention[key]
    }
  }
  if (!changed) return null
  const next: Record<string, unknown> = { ...obj }
  if (Object.keys(attention).length) next.attention = attention
  else delete next.attention
  return stringifyConfig(next, text)
}

/** The file:// spec for the generated plugin — opencodeConfig()'s own rendering. */
export const opencodePluginSpec = (pluginPath: string): string =>
  'file:///' + pluginPath.replace(/\\/g, '/').replace(/^\/+/, '')

export function applyOpencodePlugin(text: string | null, pluginPath: string): string {
  const obj = text === null ? {} : parseConfig(text)
  if (obj.plugin !== undefined && !Array.isArray(obj.plugin)) {
    throw new Error('opencode.json `plugin` is not an array — fix it by hand first')
  }
  const spec = opencodePluginSpec(pluginPath)
  const kept = ((obj.plugin as unknown[] | undefined) ?? []).filter((p) => !(typeof p === 'string' && OUR_PLUGIN_RE.test(p)))
  const next: Record<string, unknown> = { ...obj, plugin: [...kept, spec] }
  if (!('$schema' in next)) next.$schema = 'https://opencode.ai/config.json'
  return stringifyConfig(next, text)
}

export function removeOpencodePlugin(text: string | null): string | null {
  if (text === null) return null
  const obj = parseConfig(text)
  if (!Array.isArray(obj.plugin)) return null
  const kept = obj.plugin.filter((p) => !(typeof p === 'string' && OUR_PLUGIN_RE.test(p)))
  if (kept.length === obj.plugin.length) return null
  const next: Record<string, unknown> = { ...obj }
  if (kept.length) next.plugin = kept
  else delete next.plugin
  return stringifyConfig(next, text)
}

export function opencodeGlobalState(
  tuiText: string | null,
  configText: string | null,
  pluginPath: string
): { state: GlobalWiringState; reason?: string } {
  let tuiOn = false
  let pluginExact = false
  let pluginOurs = false
  try {
    if (tuiText !== null) {
      const attention = opencodeAttention(parseConfig(tuiText))
      tuiOn = attention.enabled === true && attention.notifications === true
    }
    if (configText !== null) {
      const plugin = parseConfig(configText).plugin
      const specs = Array.isArray(plugin) ? plugin.filter((p): p is string => typeof p === 'string') : []
      const ours = specs.filter((p) => OUR_PLUGIN_RE.test(p))
      pluginOurs = ours.length > 0
      pluginExact = ours.includes(opencodePluginSpec(pluginPath))
    }
  } catch (e) {
    return { state: 'unreadable', reason: String((e as Error).message) }
  }
  if (tuiOn && pluginExact) return { state: 'applied' }
  if (pluginOurs || tuiOn) return { state: 'partial' }
  return { state: 'not-applied' }
}
