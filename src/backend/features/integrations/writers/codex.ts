import { join } from 'node:path'
import { MCP_MANAGED_BY, type McpServerEntry } from '@contracts'
import type { CliHomes, McpConfigWriter } from './index'

// Codex dialect: `<CODEX_HOME|~/.codex>/config.toml`, `[mcp_servers.<id>]`
// tables. NO parser dependency, by design: a managed entry is a whole table
// TAGGED with our comment, and add/remove is a LINE SPLICE from the tag to
// the next `[` header (or EOF — our table being last is the risk-#1 case).
// Foreign lines — inline `#` comments included — are never re-serialized;
// byte-preservation is structural, not hoped-for.

const TAG = `# managed-by: ${MCP_MANAGED_BY}`
const header = (id: string): string => `[mcp_servers.${id}]`

/** TOML basic-string: escape backslashes (Windows paths) + quotes. */
const tstr = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

function block(entry: McpServerEntry): string {
  const lines = [TAG, header(entry.id)]
  if (entry.transport === 'http') {
    lines.push(`url = ${tstr(entry.url ?? '')}`)
  } else {
    lines.push(`command = ${tstr(entry.command ?? '')}`)
    if (entry.args?.length) lines.push(`args = [${entry.args.map(tstr).join(', ')}]`)
  }
  if (entry.env && Object.keys(entry.env).length) {
    lines.push(`env = { ${Object.entries(entry.env).map(([k, v]) => `${k} = ${tstr(v)}`).join(', ')} }`)
  }
  return lines.join('\n')
}

/** Locate our managed block for `id`: [startLine, endLineExclusive], or null.
 *  Start = the tag line immediately above our header; end = the first BLANK
 *  or `[` header line after our contiguous key lines (we write no blanks
 *  inside a block) — a user's later comments/tables are never inside. */
function locate(lines: string[], id: string): [number, number] | null {
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].trim() !== TAG || lines[i + 1].trim() !== header(id)) continue
    let end = i + 2
    while (end < lines.length && lines[end].trim() !== '' && !lines[end].trim().startsWith('[')) end++
    return [i, end]
  }
  return null
}

export const codexWriter: McpConfigWriter = {
  cli: 'codex',
  targetFile: (homes: CliHomes) => join(homes.codexDir, 'config.toml'),
  renderBlock: (entry) => block(entry),
  canonical: (entry) => block(entry),
  readCanonical: (text, id) => {
    const lines = text.split('\n')
    const at = locate(lines, id)
    if (!at) return null
    // The canonical form is the block's lines, verbatim (no blanks inside).
    return lines.slice(at[0], at[1]).join('\n')
  },
  upsert: (text, entry) => {
    const removed = text ? codexWriter.remove(text, entry.id) : ''
    if (!removed.trim()) return block(entry) + '\n'
    const base = removed.endsWith('\n') ? removed : removed + '\n'
    return base + '\n' + block(entry) + '\n'
  },
  remove: (text, id) => {
    const lines = text.split('\n')
    const at = locate(lines, id)
    if (!at) return text
    let [start, end] = at
    // Also take the ONE separator blank line we added above the tag.
    if (start > 0 && lines[start - 1].trim() === '') start--
    const kept = [...lines.slice(0, start), ...lines.slice(end)]
    return kept.join('\n')
  }
}
