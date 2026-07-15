import { MCP_MANAGED_BY, type McpServerEntry } from '@contracts'

// Shared mechanics for the two JSON dialects (Claude Code + Gemini):
// parse -> mutate ONLY our key -> stringify with the file's own detected
// indent. JS object key order is stable, so foreign keys keep their
// positions; realistic formatting round-trips byte-identical (exotic
// formatting normalizes — the backup + diff preview is the safety net,
// and docs/14 says so).

export type JsonEntryShape = Record<string, unknown>

/** Detect the file's indent unit (default two spaces). */
export function detectIndent(text: string): string {
  const m = /\n([ \t]+)"/.exec(text)
  return m ? m[1] : '  '
}

/** Comments or a trailing comma — the JSONC shapes `JSON.parse` chokes on.
 *  Only ever consulted on a file that ALREADY failed to parse, so a loose match
 *  costs nothing but a better sentence. */
const looksLikeJsonc = (text: string): boolean => /(^|\s)\/\/|\/\*|,\s*[}\]]/.test(text)

export function parseConfig(text: string | null): Record<string, unknown> {
  if (!text || !text.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch (e) {
    // Gemini's settings.json officially TOLERATES JSONC. We refuse rather than
    // "fix" it: parsing and re-serializing would silently delete the user's
    // comments — a worse betrayal than an honest no. Say which no it is.
    if (looksLikeJsonc(text)) {
      throw new Error('this config has comments or trailing commas — editing it here would delete them; add the server by hand, or remove them and retry', { cause: e })
    }
    throw e
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('config root is not an object')
  return parsed as Record<string, unknown>
}

export function stringifyConfig(obj: Record<string, unknown>, originalText: string | null): string {
  const indent = originalText ? detectIndent(originalText) : '  '
  const out = JSON.stringify(obj, null, indent)
  // Preserve the file's trailing-newline convention (absent file -> newline).
  const trailing = originalText === null || originalText.endsWith('\n')
  return trailing ? out + '\n' : out
}

/** Read the managed entry (ours ONLY — marked) from a config object. */
export function managedEntry(obj: Record<string, unknown>, id: string): JsonEntryShape | null {
  const servers = obj.mcpServers
  if (typeof servers !== 'object' || servers === null) return null
  const entry = (servers as Record<string, unknown>)[id]
  if (typeof entry !== 'object' || entry === null) return null
  if ((entry as Record<string, unknown>)._managedBy !== MCP_MANAGED_BY) return null
  return entry as JsonEntryShape
}

export function upsertEntry(
  text: string | null,
  id: string,
  shape: JsonEntryShape
): string {
  const obj = parseConfig(text)
  // An ARRAY here would accept the property set and then have JSON.stringify silently
  // drop it — "applied ok" with nothing written. Refuse loudly instead.
  if (Array.isArray(obj.mcpServers)) throw new Error('mcpServers is an array, not an object')
  const servers = (typeof obj.mcpServers === 'object' && obj.mcpServers !== null ? obj.mcpServers : {}) as Record<string, unknown>
  // A user's own (unmanaged) entry under this id must not be silently overwritten,
  // claimed as ours, and later deleted by Remove. Symmetric with removeEntry's guard.
  const existing = servers[id]
  if (
    typeof existing === 'object' &&
    existing !== null &&
    (existing as Record<string, unknown>)._managedBy !== MCP_MANAGED_BY
  ) {
    throw new Error(`a '${id}' server already exists in this config and is not managed by this app — remove or rename it first`)
  }
  servers[id] = shape
  obj.mcpServers = servers
  return stringifyConfig(obj, text)
}

export function removeEntry(text: string, id: string): string {
  const obj = parseConfig(text)
  // Ours only — a foreign twin stays (and an ARRAY-shaped `mcpServers` has no
  // keyed entry to find, so it falls through here untouched: no hole to plug,
  // and hasJsonEntry keeps the caller honest about what's still in the file).
  if (!managedEntry(obj, id)) return text
  delete (obj.mcpServers as Record<string, unknown>)[id]
  return stringifyConfig(obj, text)
}

/** Is `id` defined here AT ALL — managed, hand-written, or half-edited? */
export function hasJsonEntry(text: string, id: string): boolean {
  try {
    const servers = parseConfig(text).mcpServers
    if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return false
    return (servers as Record<string, unknown>)[id] !== undefined
  } catch {
    return false // unparseable — the caller already has a louder reason than this
  }
}

/** Nothing but OUR entries under the ONE key we write (or a blank file) — the
 *  test for "this scoped config is ours to overwrite". A user's own settings.json
 *  carries other keys (theme, contextFileName…) and fails it, as it should. */
export function isManagedScopedJson(text: string): boolean {
  if (!text.trim()) return true
  let obj: Record<string, unknown>
  try {
    obj = parseConfig(text)
  } catch {
    return false
  }
  const keys = Object.keys(obj)
  if (keys.length !== 1 || keys[0] !== 'mcpServers') return false
  const servers = obj.mcpServers
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return false
  return Object.values(servers as Record<string, unknown>).every(
    (e) => typeof e === 'object' && e !== null && (e as Record<string, unknown>)._managedBy === MCP_MANAGED_BY
  )
}

/** Env passes through as-is: stored rows were validated as ${VAR} references; the trusted
 *  built-in house row carries only the non-secret Electron-as-Node launch switch. */
export function envOf(entry: McpServerEntry): Record<string, string> | undefined {
  return entry.env && Object.keys(entry.env).length ? { ...entry.env } : undefined
}
