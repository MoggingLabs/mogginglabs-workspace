import { join } from 'node:path'
import { MCP_MANAGED_BY, type McpServerEntry } from '@contracts'
import type { CliHomes, McpConfigWriter } from './index'
import {
  envOf,
  hasJsonEntry,
  isManagedScopedJson,
  managedEntry,
  parseConfig,
  removeEntry,
  upsertEntry,
  type JsonEntryShape
} from './json-dialect'

// Claude Code dialect: `~/.claude.json`, top-level `mcpServers` (today's
// vintage — the file also holds unrelated CLI state; we touch ONE key of ONE
// object inside it and nothing else, credential keys least of all). An absent
// file is the other vintage the fixtures cover: we create a minimal one.

function shape(entry: McpServerEntry): JsonEntryShape {
  if (entry.transport === 'http') {
    const h: JsonEntryShape = { type: 'http', url: entry.url }
    if (entry.headers && Object.keys(entry.headers).length) h.headers = { ...entry.headers }
    h._managedBy = MCP_MANAGED_BY
    return h
  }
  const s: JsonEntryShape = { type: 'stdio', command: entry.command }
  if (entry.args?.length) s.args = [...entry.args]
  const env = envOf(entry)
  if (env) s.env = env
  s._managedBy = MCP_MANAGED_BY
  return s
}

export const claudeWriter: McpConfigWriter = {
  cli: 'claude-code',
  targetFile: (homes: CliHomes) => join(homes.home, '.claude.json'),
  renderBlock: (entry) => JSON.stringify({ mcpServers: { [entry.id]: shape(entry) } }, null, 2),
  canonical: (entry) => JSON.stringify(shape(entry)),
  readCanonical: (text, id) => {
    const found = managedEntry(parseConfig(text), id)
    return found ? JSON.stringify(found) : null
  },
  upsert: (text, entry) => upsertEntry(text, entry.id, shape(entry)),
  remove: (text, id) => removeEntry(text, id),
  hasEntry: (text, id) => hasJsonEntry(text, id),
  isManagedScoped: (text) => isManagedScopedJson(text),
  composeScoped: (entries) => JSON.stringify({ mcpServers: Object.fromEntries(entries.map((e) => [e.id, shape(e)])) }, null, 2)
}
