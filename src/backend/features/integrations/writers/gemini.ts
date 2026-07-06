import { join } from 'node:path'
import { MCP_MANAGED_BY, type McpServerEntry } from '@contracts'
import type { CliHomes, McpConfigWriter } from './index'
import { envOf, managedEntry, parseConfig, removeEntry, upsertEntry, type JsonEntryShape } from './json-dialect'

// Gemini CLI dialect: `<GEMINI_CONFIG_DIR|~/.gemini>/settings.json`,
// `mcpServers` key. THE quirk: remote servers use `httpUrl`, not `url` —
// hardcoding the wrong spelling is exactly the drift the fixtures guard.

function shape(entry: McpServerEntry): JsonEntryShape {
  if (entry.transport === 'http') {
    const h: JsonEntryShape = { httpUrl: entry.url }
    if (entry.headers && Object.keys(entry.headers).length) h.headers = { ...entry.headers }
    h._managedBy = MCP_MANAGED_BY
    return h
  }
  const s: JsonEntryShape = { command: entry.command }
  if (entry.args?.length) s.args = [...entry.args]
  const env = envOf(entry)
  if (env) s.env = env
  s._managedBy = MCP_MANAGED_BY
  return s
}

export const geminiWriter: McpConfigWriter = {
  cli: 'gemini',
  targetFile: (homes: CliHomes) => join(homes.geminiDir, 'settings.json'),
  renderBlock: (entry) => JSON.stringify({ mcpServers: { [entry.id]: shape(entry) } }, null, 2),
  canonical: (entry) => JSON.stringify(shape(entry)),
  readCanonical: (text, id) => {
    const found = managedEntry(parseConfig(text), id)
    return found ? JSON.stringify(found) : null
  },
  upsert: (text, entry) => upsertEntry(text, entry.id, shape(entry)),
  remove: (text, id) => removeEntry(text, id)
}
