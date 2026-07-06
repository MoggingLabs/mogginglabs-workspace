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

export function parseConfig(text: string | null): Record<string, unknown> {
  if (!text || !text.trim()) return {}
  const parsed = JSON.parse(text) as unknown
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
  const servers = (typeof obj.mcpServers === 'object' && obj.mcpServers !== null ? obj.mcpServers : {}) as Record<string, unknown>
  servers[id] = shape
  obj.mcpServers = servers
  return stringifyConfig(obj, text)
}

export function removeEntry(text: string, id: string): string {
  const obj = parseConfig(text)
  if (!managedEntry(obj, id)) return text // ours only — a foreign twin stays
  delete (obj.mcpServers as Record<string, unknown>)[id]
  return stringifyConfig(obj, text)
}

/** env passes through as-is: values were validated to be ${VAR} references. */
export function envOf(entry: McpServerEntry): Record<string, string> | undefined {
  return entry.env && Object.keys(entry.env).length ? { ...entry.env } : undefined
}
