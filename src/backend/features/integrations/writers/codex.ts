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

/** TOML basic-string: escape backslashes (Windows paths), quotes, and control chars —
 *  a raw newline inside a basic string is invalid TOML (and breaks the line splice). */
const tstr = (s: string): string =>
  `"${s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\u0000-\u001f\u007f]/g, (c) =>
      c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
    )}"`

function block(entry: McpServerEntry): string {
  const lines = [TAG, header(entry.id)]
  if (entry.transport === 'http') {
    lines.push(`url = ${tstr(entry.url ?? '')}`)
    // Codex speaks bearer-env auth for remotes: exactly one Authorization
    // header of the `Bearer ${VAR}` shape maps to bearer_token_env_var; any
    // other header shape is a capability gap, not a silent drop.
    const headers = Object.entries(entry.headers ?? {})
    if (headers.length) {
      const bearer = headers.length === 1 && headers[0][0].toLowerCase() === 'authorization'
        ? /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(headers[0][1])
        : null
      if (!bearer) throw new Error('codex supports bearer env auth only (Authorization: Bearer ${VAR})')
      lines.push(`bearer_token_env_var = ${tstr(bearer[1])}`)
    }
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

/** TOML truth: a table owns every line up to the NEXT `[` header — blank lines
 *  and comments do NOT end it. So a blank line the user typed INSIDE our block
 *  stops locate() early, and splicing at that point would ORPHAN the key lines
 *  below it (`env = {…}`) onto whatever table precedes them. Detect exactly that:
 *  a key line still inside our table after the block we located. */
function keysOrphanedAfter(lines: string[], end: number): boolean {
  for (let i = end; i < lines.length; i++) {
    const t = lines[i].trim()
    if (!t || t.startsWith('#')) continue // blanks + comments belong to nobody
    return !t.startsWith('[') // a `[` header opens the next table; anything else is still ours
  }
  return false
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
    // A FOREIGN (untagged, hand-written) `[mcp_servers.<id>]` table must refuse the
    // upsert: remove() only splices TAGGED blocks, so appending ours would leave two
    // definitions of the same table — invalid TOML, and codex drops its WHOLE config.
    const h = header(entry.id)
    const foreign = removed.split('\n').some((l, i, ls) => l.trim() === h && (i === 0 || ls[i - 1].trim() !== TAG))
    if (foreign) throw new Error(`config.toml already defines ${h} (not managed by this app) — remove or rename it first`)
    if (!removed.trim()) return block(entry) + '\n'
    const base = removed.endsWith('\n') ? removed : removed + '\n'
    return base + '\n' + block(entry) + '\n'
  },
  remove: (text, id) => {
    const lines = text.split('\n')
    const at = locate(lines, id)
    if (!at) return text
    let [start, end] = at
    if (keysOrphanedAfter(lines, end)) {
      throw new Error(`${header(id)} was hand-edited (a blank line inside the block) — splicing it would orphan its keys onto another table; remove it by hand`)
    }
    // Also take the ONE separator blank line we added above the tag.
    if (start > 0 && lines[start - 1].trim() === '') start--
    const kept = [...lines.slice(0, start), ...lines.slice(end)]
    return kept.join('\n')
  },
  hasEntry: (text, id) => text.split('\n').some((l) => l.trim() === header(id)),
  isManagedScoped: (text) => {
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim()
      if (!t) continue
      if (t !== TAG) return false // a foreign line: comment, key, or an untagged table
      // Our tag ALWAYS sits immediately above one of our headers; the keys that
      // follow (to the next blank or `[`) are the rest of the block.
      if (!/^\[mcp_servers\.[^\]]+\]$/.test((lines[i + 1] ?? '').trim())) return false
      i++
      while (i + 1 < lines.length && lines[i + 1].trim() !== '' && !lines[i + 1].trim().startsWith('[')) i++
    }
    return true
  },
  composeScoped: (entries) => entries.map((e) => block(e)).join('\n\n') + '\n'
}
