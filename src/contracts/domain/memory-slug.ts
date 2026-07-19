/**
 * The memory SLUG law (ADR 0018 step 09) — in the shared seam because BOTH
 * sides must speak it byte-identically: the indexer sanitizes `[[wikilinks]]`
 * through this ONE slugger, and the Brain view's reader (10) re-finds the same
 * links in the same body with the same pattern. Two copies of a sanitizer is
 * how a hostile link becomes inert on one side and live on the other.
 */

export const MEMORY_SLUG_MAX = 80

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

/** The `[[wikilink]]` pattern, fresh per call (a /g regex is stateful). The
 *  indexer's memoryLinksOf and the reader's tokenizer both run exactly this. */
export const memoryWikilinkRe = (): RegExp => /\[\[([^[\]\n]+)\]\]/g
