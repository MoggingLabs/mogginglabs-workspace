import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { isMemorySlug, memorySlug, memoryWikilinkRe } from '@contracts'

// The memory FORMAT (ADR 0018 step 09, Phase 2.5): `.memory/<slug>.md` — plain
// markdown files the TEAM owns, in the repo, synced by git like any other file.
// Frontmatter is a strict one-line-per-key subset (name = the slug, description,
// optional tags); the body is markdown whose `[[wikilinks]]` target other slugs.
// A link to an unwritten slug is VALID — it marks wanted knowledge, and the
// serve layer reports it dangling rather than hiding it. Plain files only: no
// db, no index, no dotfile machinery inside `.memory/` — byte-portable,
// diff-reviewable, mergeable. The INDEX (store tables + FTS5) is derived state;
// deleting the brain db loses nothing because these files are the truth.
//
// Everything here is pure: bytes in, rows out. Reading a checkout's memory dir
// is a flat, sorted, capped enumeration — no recursion (slugs are filenames by
// law), no watcher, no parser pool. Hostile names sanitize through ONE slugger,
// which is also what makes a hostile `[[link]]` inert: it either kebab-cases
// into a plain slug or it is no link at all.

export const MEMORY_DIR = '.memory'
/** The draft quarantine (ADR 0018 revision C): auto-captured memories live in
 *  `.memory/drafts/` — the ONE subdirectory that is ours, scanned by its own
 *  flat pass and never counted a foreign skip. Everything else about the
 *  format is identical: `<slug>.md`, the same frontmatter law, props carrying
 *  the capture provenance (`auto`, `source`, `distilled`, …). */
export const MEMORY_DRAFTS_DIRNAME = 'drafts'
/** Flat-dir cap: past it the scan stops and says so (`capped`), never silently. */
export const MEMORY_MAX_FILES = 2000
export const MEMORY_MAX_FILE_BYTES = 256 * 1024
export const MEMORY_NAME_MAX = 200
export const MEMORY_DESCRIPTION_MAX = 500
export const MEMORY_MAX_TAGS = 16
// Properties (ADR 0018 revision B): frontmatter lines beyond the reserved
// three are Obsidian-convention `key: value` PROPERTIES — inert bytes, parsed
// under a fixed law: last occurrence wins, values control-stripped and capped,
// keys SORTED, the first MEMORY_MAX_PROPS kept. A malformed KEY line is still
// a whole-file invalid (the parse law is unchanged).
export const MEMORY_RESERVED_KEYS = ['name', 'description', 'tags'] as const
export const MEMORY_MAX_PROPS = 32
export const MEMORY_PROP_VALUE_MAX = 500

// The slug law + wikilink pattern moved to @contracts (10): the Brain view's
// reader must re-find links with the SAME slugger and pattern the indexer used.
// Re-exported so every existing importer keeps its door.
export { isMemorySlug, memorySlug, MEMORY_SLUG_MAX } from '@contracts'

/** `[[wikilink]]` targets in `body`, sanitized through the ONE slugger, deduped,
 *  sorted, self-links dropped. A target that sanitizes to nothing is no link. */
export function memoryLinksOf(body: string, selfSlug: string): string[] {
  const out = new Set<string>()
  for (const m of body.matchAll(memoryWikilinkRe())) {
    const slug = memorySlug(m[1])
    if (slug && slug !== selfSlug) out.add(slug)
  }
  return [...out].sort()
}

export interface ParsedMemory {
  name: string
  description: string
  tags: string[]
  /** Non-reserved head keys, SORTED, first MEMORY_MAX_PROPS — inert bytes. */
  props: Record<string, string>
  body: string
}

/**
 * Parse one memory file's text: `---` frontmatter (one `key: value` per line;
 * `tags: [a, b]`), then the body. Strict but forgiving where it must be:
 * unknown keys become PROPERTIES (revision B — and update preserves them by
 * never rewriting the head), junk structure is a null — the scan counts it,
 * the row does not exist, and the file on disk is untouched.
 */
export function parseMemoryText(text: string): ParsedMemory | null {
  const lines = text.split(/\r?\n/)
  if (lines[0] !== '---') return null
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      end = i
      break
    }
  }
  if (end < 0) return null
  let name = ''
  let description = ''
  let tags: string[] = []
  const rawProps = new Map<string, string>()
  for (const line of lines.slice(1, end)) {
    if (!line.trim()) continue
    const m = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (!m) return null
    if (m[1] === 'name') name = m[2].trim()
    else if (m[1] === 'description') description = m[2].trim()
    else if (m[1] === 'tags') {
      const inner = m[2].trim().replace(/^\[/, '').replace(/\]$/, '')
      tags = [...new Set(inner.split(',').map((t) => memorySlug(t)).filter((t): t is string => !!t))].sort()
    } else {
      // Last occurrence wins (a Map.set), value cleaned then capped.
      rawProps.set(m[1], cleanLine(m[2]).slice(0, MEMORY_PROP_VALUE_MAX))
    }
  }
  if (!name) return null
  const props: Record<string, string> = {}
  for (const key of [...rawProps.keys()].sort().slice(0, MEMORY_MAX_PROPS)) {
    props[key] = rawProps.get(key) as string
  }
  const body = lines.slice(end + 1).join('\n').replace(/^\n+/, '')
  return { name, description, tags, props, body }
}

const cleanLine = (s: string): string => s.replace(/[\x00-\x1f\x7f]+/g, ' ').trim()

/** The house serialization — what create_memory writes, byte-exactly. LF only;
 *  one blank line separates frontmatter from the body (the house convention),
 *  and the body lands verbatim (inert bytes) with a guaranteed trailing
 *  newline. The blank line is deliberate: it makes create's output byte-equal
 *  to what replaceMemoryBody (update) produces, so the FIRST edit of a
 *  just-created memory is a clean body diff — never a spurious separator churn. */
export function serializeMemory(m: { slug: string; description: string; tags: string[]; body: string }): string {
  const head = ['---', `name: ${m.slug}`, `description: ${cleanLine(m.description)}`]
  if (m.tags.length) head.push(`tags: [${m.tags.join(', ')}]`)
  head.push('---', '', '')
  let body = m.body.replace(/\r\n/g, '\n')
  if (!body.endsWith('\n')) body += '\n'
  return head.join('\n') + body
}

/**
 * Swap the BODY under an existing head, byte-preserving the head verbatim —
 * update_memory never reformats frontmatter it did not write (unknown keys, a
 * human's spacing, CRLF heads all round-trip). Null = no parseable frontmatter.
 */
export function replaceMemoryBody(current: string, body: string): string | null {
  const lines = current.split(/(?<=\n)/)
  if (!/^---\r?\n$/.test(lines[0] ?? '')) return null
  let offset = lines[0].length
  let headEnd = -1
  for (let i = 1; i < lines.length; i++) {
    if (/^---\r?\n?$/.test(lines[i])) {
      headEnd = offset + lines[i].length
      break
    }
    offset += lines[i].length
  }
  if (headEnd < 0) return null
  let next = body.replace(/\r\n/g, '\n')
  if (!next.endsWith('\n')) next += '\n'
  const head = current.slice(0, headEnd)
  return (head.endsWith('\n') ? head : head + '\n') + '\n' + next
}

export interface MemoryFileRow {
  slug: string
  name: string
  description: string
  tags: string[]
  /** Sorted, capped properties (revision B) — the file's inert extra head. */
  props: Record<string, string>
  body: string
  /** sha256 of the file's bytes — update_memory's CAS witness. */
  hash: string
  mtime: number
  bytes: number
}

export interface MemoryScan {
  rows: MemoryFileRow[]
  links: { src: string; dst: string }[]
  /** Honest skip counts — a file that is not a row is still accounted for. */
  skipped: { invalid: number; tooLarge: number; foreign: number }
  capped: boolean
}

const emptyScan = (): MemoryScan => ({ rows: [], links: [], skipped: { invalid: 0, tooLarge: 0, foreign: 0 }, capped: false })

/**
 * Enumerate ONE flat memory dir — sorted, capped. Only `<slug>.md` files
 * become rows; anything else (subdirs, foreign extensions, byte-hostile names
 * that are not a slug, binaries, unparseable frontmatter) is a COUNTED skip.
 * Deterministic: the same bytes always produce the same rows and links.
 * `ownDirs` names subdirectories that are OURS (the draft quarantine) — they
 * are neither rows nor skips here; their own scan owns them.
 */
function scanFlatMemoryDir(dir: string, ownDirs: readonly string[]): MemoryScan {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return emptyScan() // no dir — an empty lens, not an error
  }
  const scan = emptyScan()
  let taken = 0
  for (const entry of entries.sort()) {
    const abs = path.join(dir, entry)
    let st
    try {
      st = statSync(abs)
    } catch {
      scan.skipped.invalid++
      continue
    }
    if (st.isDirectory() && ownDirs.includes(entry)) continue
    // A literal `.gitignore` is vault plumbing, not vault content: the app
    // writes one to keep the draft quarantine out of git (revision C), and a
    // user's own is their configuration. Inert either way — never a "foreign
    // file" warning.
    if (st.isFile() && entry === '.gitignore') continue
    if (!st.isFile() || !entry.endsWith('.md')) {
      scan.skipped.foreign++
      continue
    }
    const slug = entry.slice(0, -3)
    if (!isMemorySlug(slug)) {
      scan.skipped.invalid++
      continue
    }
    if (taken >= MEMORY_MAX_FILES) {
      scan.capped = true
      break
    }
    taken++
    if (st.size > MEMORY_MAX_FILE_BYTES) {
      scan.skipped.tooLarge++
      continue
    }
    let bytes: Buffer
    try {
      bytes = readFileSync(abs)
    } catch {
      scan.skipped.invalid++
      continue
    }
    if (bytes.subarray(0, 8192).includes(0)) {
      scan.skipped.invalid++
      continue
    }
    const parsed = parseMemoryText(bytes.toString('utf8'))
    if (!parsed) {
      scan.skipped.invalid++
      continue
    }
    scan.rows.push({
      slug,
      name: parsed.name,
      description: parsed.description,
      tags: parsed.tags,
      props: parsed.props,
      body: parsed.body,
      hash: createHash('sha256').update(bytes).digest('hex'),
      mtime: Math.floor(st.mtimeMs),
      bytes: bytes.length
    })
    for (const dst of memoryLinksOf(parsed.body, slug)) scan.links.push({ src: slug, dst })
  }
  return scan
}

/** One checkout's `.memory/` — the curated lens. The draft quarantine is the
 *  ONE subdir that is ours (neither a row nor a foreign skip here). */
export function scanMemoryDir(root: string): MemoryScan {
  return scanFlatMemoryDir(path.join(root, MEMORY_DIR), [MEMORY_DRAFTS_DIRNAME])
}

/** One checkout's `.memory/drafts/` — the quarantine (ADR 0018 revision C).
 *  Same laws, same skips accounting; links are scanned but the quarantine is
 *  excluded from suggestions and recall BY CONSTRUCTION (separate tables). */
export function scanMemoryDrafts(root: string): MemoryScan {
  return scanFlatMemoryDir(path.join(root, MEMORY_DIR, MEMORY_DRAFTS_DIRNAME), [])
}

/** FTS5 MATCH expression from a free-text query: bare terms, each quoted (no
 *  FTS syntax ever reaches the parser — junk cannot crash, `NEAR(` is just a
 *  word), implicit AND, capped at 12 terms. Null when nothing searchable. */
export function memorySearchExpr(query: string): string | null {
  const tokens = query.match(/[A-Za-z0-9_]+/g)
  if (!tokens || !tokens.length) return null
  return tokens.slice(0, 12).map((t) => `"${t}"`).join(' ')
}

// ── The property filter (ADR 0018 revision B): a CLOSED grammar, data not code ─

/** Comma-joined AND clauses, at most this many. */
export const MEMORY_FILTER_MAX_CLAUSES = 8

export type MemoryFilterClause =
  | { kind: 'tag'; tag: string }
  | { kind: 'has'; key: string }
  | { kind: 'eq'; key: string; value: string }

const MEMORY_PROP_KEY_RE = /^[A-Za-z][A-Za-z0-9_-]*$/

/**
 * Parse a `search_memories` filter string. The grammar is CLOSED and the
 * validator speaks its primitives back: `#tag` (tag membership) · `key`
 * (property presence) · `key=value` (exact; the value runs to the comma).
 * Reserved head keys and junk are typed errors — teaching, never a guess.
 */
export function parseMemoryFilter(filter: string): { clauses: MemoryFilterClause[] } | { error: string } {
  const parts = filter.split(',')
  if (parts.length > MEMORY_FILTER_MAX_CLAUSES) {
    return { error: `a filter takes at most ${MEMORY_FILTER_MAX_CLAUSES} comma-joined clauses` }
  }
  const clauses: MemoryFilterClause[] = []
  for (const part of parts) {
    const clause = part.trim()
    if (!clause) return { error: 'an empty filter clause says nothing — clauses are #tag, key, or key=value' }
    if (clause.startsWith('#')) {
      const raw = clause.slice(1)
      if (!isMemorySlug(raw)) {
        const norm = memorySlug(raw)
        return { error: norm ? `"#${raw.slice(0, 80)}" is not a tag — did you mean "#${norm}"?` : 'a tag filter is #tag with a kebab-case tag (a-z, 0-9, dashes)' }
      }
      clauses.push({ kind: 'tag', tag: raw })
      continue
    }
    const eq = clause.indexOf('=')
    const key = (eq < 0 ? clause : clause.slice(0, eq)).trim()
    if (!MEMORY_PROP_KEY_RE.test(key)) {
      return { error: `"${clause.slice(0, 80)}" is not a filter clause — clauses are #tag, key, or key=value` }
    }
    if ((MEMORY_RESERVED_KEYS as readonly string[]).includes(key)) {
      return { error: `"${key}" is frontmatter, not a property — search matches name/description already, and tags filter as #tag` }
    }
    if (eq < 0) {
      clauses.push({ kind: 'has', key })
      continue
    }
    // The value runs to the comma — cleaned exactly as indexing cleaned it,
    // so what the file said is what the filter matches.
    const value = cleanLine(clause.slice(eq + 1)).slice(0, MEMORY_PROP_VALUE_MAX)
    if (!value) return { error: `"${key}=" has no value — use bare "${key}" to filter on presence` }
    clauses.push({ kind: 'eq', key, value })
  }
  return { clauses }
}

/** Fixed suggestion weights (ADR 0018.i: an unexplainable ranking is a bug) —
 *  served back inside every breakdown so the arithmetic is auditable. */
export const MEMORY_SUGGEST_WEIGHTS = { link: 3, tag: 2, term: 1 } as const

/** The hybrid blend (ADR 0018 revision A): fixed-weight reciprocal-rank fusion
 *  of the FTS list and the cosine list — each side contributes
 *  `weight / (K + rank)`, the two components sum to the score, and the whole
 *  breakdown is served back per hit. Auditable even when fuzzy. */
export const MEMORY_HYBRID_WEIGHTS = { fts: 1, semantic: 1 } as const
export const MEMORY_HYBRID_RRF_K = 60

/** Lowercased word tokens of a display name — the title-term half of suggest. */
export const memoryNameTerms = (name: string): string[] =>
  [...new Set(name.normalize('NFKD').toLowerCase().match(/[a-z0-9]+/g) ?? [])].sort()
