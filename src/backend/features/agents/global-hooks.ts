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
