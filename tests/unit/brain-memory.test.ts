import { describe, expect, it } from 'vitest'
import {
  memoryLinksOf,
  parseMemoryFilter,
  parseMemoryText,
  replaceMemoryBody,
  serializeMemory
} from '@backend/features/brain/memory'

// TEAM MEMORIES ARE THE USER'S OWN MARKDOWN FILES.
//
// `update_memory` is an agent-callable write into a file a human also edits, so the rule that
// matters is the one the module states about itself: the frontmatter it did not write is
// preserved verbatim — unknown keys, a human's spacing, CRLF heads all round-trip. Reformatting
// someone's file as a side effect of an unrelated edit is the failure this guards.

describe('parseMemoryText', () => {
  it('reads name, description and tags', () => {
    const parsed = parseMemoryText('---\nname: my-note\ndescription: A thing\ntags: [alpha, beta]\n---\n\nBody here\n')
    expect(parsed).toBeTruthy()
    expect(parsed!.name).toBe('my-note')
    expect(parsed!.description).toBe('A thing')
    expect(parsed!.tags).toEqual(['alpha', 'beta'])
    expect(parsed!.body.trim()).toBe('Body here')
  })

  it('reads a CRLF file exactly as it reads an LF one', () => {
    const lf = parseMemoryText('---\nname: n\ndescription: d\n---\n\nBody\n')
    const crlf = parseMemoryText('---\r\nname: n\r\ndescription: d\r\n---\r\n\r\nBody\r\n')
    // Compared against a LITERAL, not against each other: two `undefined`s are equal, so a
    // field-name typo on both sides would pass this row while proving nothing.
    expect(lf?.name).toBe('n')
    expect(crlf?.name).toBe('n')
    expect(crlf?.description).toBe(lf?.description)
    expect(crlf?.body.trim()).toBe('Body')
  })

  it('refuses a file with no frontmatter rather than inventing one', () => {
    expect(parseMemoryText('Just a markdown file\n')).toBeNull()
    expect(parseMemoryText('---\nname: unterminated\n')).toBeNull()
    expect(parseMemoryText('')).toBeNull()
  })

  it('refuses a malformed frontmatter line instead of silently dropping it', () => {
    expect(parseMemoryText('---\nname: n\nthis is not a key\n---\n\nBody\n')).toBeNull()
  })

  it('dedupes and sorts tags', () => {
    const parsed = parseMemoryText('---\nname: n\ndescription: d\ntags: [beta, alpha, beta]\n---\n\nB\n')
    expect(parsed!.tags).toEqual(['alpha', 'beta'])
  })
})

describe('serializeMemory round-trips through parseMemoryText', () => {
  it('what it writes, it can read back', () => {
    const text = serializeMemory({ slug: 'my-note', description: 'A thing', tags: ['alpha'], body: 'Body\n' })
    const parsed = parseMemoryText(text)
    expect(parsed!.name).toBe('my-note')
    expect(parsed!.description).toBe('A thing')
    expect(parsed!.tags).toEqual(['alpha'])
  })

  it('omits the tags line entirely when there are none', () => {
    expect(serializeMemory({ slug: 'n', description: 'd', tags: [], body: 'B\n' })).not.toContain('tags:')
  })

  it('always ends the body with a newline', () => {
    expect(serializeMemory({ slug: 'n', description: 'd', tags: [], body: 'no trailing newline' })).toMatch(/\n$/)
  })
})

describe('replaceMemoryBody preserves the head byte-for-byte', () => {
  // THE rule. update_memory must not reformat frontmatter it did not write.
  it('keeps an unknown key a human added', () => {
    const original = '---\nname: n\ndescription: d\nauthor: pedro\n---\n\nold body\n'
    const next = replaceMemoryBody(original, 'new body')
    expect(next).toBeTruthy()
    expect(next!, "someone else's key must survive an unrelated edit").toContain('author: pedro')
    expect(next!).toContain('new body')
    expect(next!).not.toContain('old body')
  })

  it('keeps a CRLF head as CRLF', () => {
    const next = replaceMemoryBody('---\r\nname: n\r\ndescription: d\r\n---\r\n\r\nold\r\n', 'new')
    expect(next).toBeTruthy()
    expect(next!.slice(0, next!.indexOf('new')), 'the head is copied, not re-serialized').toContain('\r\n')
  })

  it("keeps a human's spacing", () => {
    const original = '---\nname:    n\ndescription:  d\n---\n\nold\n'
    expect(replaceMemoryBody(original, 'new')!).toContain('name:    n')
  })

  it('refuses a file with no parseable head rather than prepending one', () => {
    expect(replaceMemoryBody('no frontmatter here\n', 'new')).toBeNull()
    expect(replaceMemoryBody('---\nname: unterminated\n', 'new')).toBeNull()
  })

  it('normalizes the BODY it was handed, and terminates it', () => {
    const next = replaceMemoryBody('---\nname: n\n---\n\nold\n', 'a\r\nb')
    expect(next!).toContain('a\nb')
    expect(next!).toMatch(/\n$/)
  })
})

describe('memoryLinksOf', () => {
  it('finds wiki links and drops the self-reference', () => {
    expect(memoryLinksOf('see [[other-note]] and [[me]]', 'me')).toEqual(['other-note'])
  })

  it('dedupes repeated links', () => {
    expect(memoryLinksOf('[[a]] then [[a]] again', 'me')).toEqual(['a'])
  })

  it('is empty when there are none', () => {
    expect(memoryLinksOf('no links at all', 'me')).toEqual([])
  })
})

describe('parseMemoryFilter', () => {
  it('accepts the forms it documents', () => {
    for (const good of ['#tag', 'key', 'key=value']) {
      expect(parseMemoryFilter(good), good).not.toHaveProperty('error')
    }
  })

  // An honest error beats a filter that silently matches everything.
  it('refuses a form it does not support, with a reason', () => {
    const out = parseMemoryFilter('tags:a')
    expect(out).toHaveProperty('error')
    if ('error' in out) expect(out.error.length).toBeGreaterThan(0)
  })
})
