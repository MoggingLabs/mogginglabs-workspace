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
})
