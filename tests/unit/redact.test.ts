import { describe, expect, it } from 'vitest'
import { REDACTED, redactSecrets } from '@backend/features/review/redact'

// The review pane's no-leak pass, exercised headless. Every case here is a shape the
// module's own comments name — token families, auth headers, key=value scrubbing with
// segment-matched keys — plus the negative space (identifiers that merely CONTAIN a
// keyword substring must survive).
describe('redactSecrets', () => {
  it('redacts token families and keeps the surrounding text', () => {
    const { text, redactions } = redactSecrets('key AKIAABCDEFGHIJKLMNOP in config')
    expect(text).toBe(`key ${REDACTED} in config`)
    expect(redactions).toBe(1)
  })

  it('redacts a PEM block whole', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIB\nlines\n-----END RSA PRIVATE KEY-----'
    const { text, redactions } = redactSecrets(`before\n${pem}\nafter`)
    expect(text).toBe(`before\n${REDACTED}\nafter`)
    expect(redactions).toBe(1)
  })

  it('keeps the auth scheme, replaces the credential', () => {
    const { text } = redactSecrets('Authorization: Bearer abcdef123456789')
    expect(text).toContain('Authorization')
    expect(text).toContain('Bearer ')
    expect(text).toContain(REDACTED)
    expect(text).not.toContain('abcdef123456789')
  })

  it('scrubs SCREAMING_SNAKE secret names (segment match, not prefix)', () => {
    const { text } = redactSecrets('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI')
    expect(text).toBe(`AWS_SECRET_ACCESS_KEY=${REDACTED}`)
  })

  it('scrubs quoted values with spaces', () => {
    const { text } = redactSecrets('password = "two words"')
    expect(text).toBe(`password = "${REDACTED}"`)
  })

  it('leaves keyword-substring identifiers alone', () => {
    const line = 'author = someone; monotonic = 12345'
    const { text, redactions } = redactSecrets(line)
    expect(text).toBe(line)
    expect(redactions).toBe(0)
  })

  it('counts every hit', () => {
    const { redactions } = redactSecrets('a=ghp_abcdefghij0123456789 b: sk-abcdefghij0123456789')
    expect(redactions).toBe(2)
  })

  // The .npmrc line, which is what an agent running `npm login` leaves behind. `_` is a
  // WORD character, so a leading `\b([A-Za-z]` could not match a key starting with one at
  // any position — the single most common credential file in a JS repo walked through the
  // scrub untouched, and the review pane, the copy-hunks clipboard and the renderer all
  // got the real token.
  it('scrubs a leading-underscore key (.npmrc _authToken)', () => {
    const { text, redactions } = redactSecrets('//registry.npmjs.org/:_authToken=abc123def456ghi789')
    expect(text).toContain('_authToken')
    expect(text).not.toContain('abc123def456ghi789')
    expect(redactions).toBe(1)
  })

  it('redacts the GitHub token siblings, not just ghp_', () => {
    // gho_ is what `gh auth login` writes — the one an agent in a repo is likeliest to hold.
    for (const t of [
      'gho_abcdefghij0123456789AB',
      'ghu_abcdefghij0123456789AB',
      'ghs_abcdefghij0123456789AB',
      'ghr_abcdefghij0123456789AB'
    ]) {
      const { text, redactions } = redactSecrets(`token ${t} here`)
      expect(text, t).toBe(`token ${REDACTED} here`)
      expect(redactions, t).toBe(1)
    }
  })

  it('redacts npm and GitLab token shapes', () => {
    const npm = 'npm_' + 'a'.repeat(36)
    expect(redactSecrets(`x ${npm}`).text).toBe(`x ${REDACTED}`)
    expect(redactSecrets('x glpat-abcdefghij0123456789').text).toBe(`x ${REDACTED}`)
  })

  // The widening must not start eating ordinary code. Every one of these contains a
  // token-ish prefix or a keyword substring and must survive verbatim.
  it('leaves near-miss identifiers and prose alone', () => {
    for (const line of [
      'const ghost = 1',
      'ghp_short=ab',
      'import { tokenizer } from "./tokenizer"',
      'authorship = "shared"',
      '_authorName = someone',
      'npm_config_registry = https://registry.npmjs.org',
      'glpat = 3'
    ]) {
      const { text, redactions } = redactSecrets(line)
      expect(text, line).toBe(line)
      expect(redactions, line).toBe(0)
    }
  })
})
