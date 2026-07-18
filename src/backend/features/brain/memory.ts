import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import * as path from 'node:path'

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
/** Flat-dir cap: past it the scan stops and says so (`capped`), never silently. */
export const MEMORY_MAX_FILES = 2000
export const MEMORY_MAX_FILE_BYTES = 256 * 1024
export const MEMORY_SLUG_MAX = 80
export const MEMORY_NAME_MAX = 200
export const MEMORY_DESCRIPTION_MAX = 500
export const MEMORY_MAX_TAGS = 16

/** Kebab-case, filename-safe, from ANY name — `"; rm -rf / [[x]]"` becomes
 *  `rm-rf-x`, inert. Null when nothing survives sanitizing. */
export function memorySlug(name: string): string | null {
  const tokens = name.normalize('NFKD').toLowerCase().match(/[a-z0-9]+/g)
  if (!tokens) return null
  let slug = tokens.join('-')
  if (slug.length > MEMORY_SLUG_MAX) slug = slug.slice(0, MEMORY_SLUG_MAX).replace(/-+$/, '')
  return slug || null
}

/** A string that already IS a slug — the only shape reads accept and writes mint. */
export const isMemorySlug = (s: string): boolean =>
  s.length <= MEMORY_SLUG_MAX && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)

/** `[[wikilink]]` targets in `body`, sanitized through the ONE slugger, deduped,
 *  sorted, self-links dropped. A target that sanitizes to nothing is no link. */
export function memoryLinksOf(body: string, selfSlug: string): string[] {
  const out = new Set<string>()
  for (const m of body.matchAll(/\[\[([^[\]\n]+)\]\]/g)) {
    const slug = memorySlug(m[1])
    if (slug && slug !== selfSlug) out.add(slug)
  }
  return [...out].sort()
}

export interface ParsedMemory {
  name: string
  description: string
  tags: string[]
  body: string
}

/**
 * Parse one memory file's text: `---` frontmatter (one `key: value` per line;
 * `tags: [a, b]`), then the body. Strict but forgiving where it must be:
 * unknown keys are tolerated (forward-compat, and update preserves them by
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
  for (const line of lines.slice(1, end)) {
    if (!line.trim()) continue
    const m = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (!m) return null
    if (m[1] === 'name') name = m[2].trim()
    else if (m[1] === 'description') description = m[2].trim()
    else if (m[1] === 'tags') {
      const inner = m[2].trim().replace(/^\[/, '').replace(/\]$/, '')
      tags = [...new Set(inner.split(',').map((t) => memorySlug(t)).filter((t): t is string => !!t))].sort()
    }
  }
  if (!name) return null
  const body = lines.slice(end + 1).join('\n').replace(/^\n+/, '')
  return { name, description, tags, body }
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
 * Enumerate ONE checkout's `.memory/` — flat, sorted, capped. Only `<slug>.md`
 * files become rows; anything else (subdirs, foreign extensions, byte-hostile
 * names that are not a slug, binaries, unparseable frontmatter) is a COUNTED
 * skip. Deterministic: the same bytes always produce the same rows and links.
 */
export function scanMemoryDir(root: string): MemoryScan {
  const dir = path.join(root, MEMORY_DIR)
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return emptyScan() // no .memory/ — an empty lens, not an error
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
      body: parsed.body,
      hash: createHash('sha256').update(bytes).digest('hex'),
      mtime: Math.floor(st.mtimeMs),
      bytes: bytes.length
    })
    for (const dst of memoryLinksOf(parsed.body, slug)) scan.links.push({ src: slug, dst })
  }
  return scan
}

/** FTS5 MATCH expression from a free-text query: bare terms, each quoted (no
 *  FTS syntax ever reaches the parser — junk cannot crash, `NEAR(` is just a
 *  word), implicit AND, capped at 12 terms. Null when nothing searchable. */
export function memorySearchExpr(query: string): string | null {
  const tokens = query.match(/[A-Za-z0-9_]+/g)
  if (!tokens || !tokens.length) return null
  return tokens.slice(0, 12).map((t) => `"${t}"`).join(' ')
}

/** Fixed suggestion weights (ADR 0018.i: an unexplainable ranking is a bug) —
 *  served back inside every breakdown so the arithmetic is auditable. */
export const MEMORY_SUGGEST_WEIGHTS = { link: 3, tag: 2, term: 1 } as const

/** Lowercased word tokens of a display name — the title-term half of suggest. */
export const memoryNameTerms = (name: string): string[] =>
  [...new Set(name.normalize('NFKD').toLowerCase().match(/[a-z0-9]+/g) ?? [])].sort()
