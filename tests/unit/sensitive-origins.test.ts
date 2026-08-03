import { describe, expect, it } from 'vitest'
import { SENSITIVE_ORIGIN_PATTERNS, isSensitiveOrigin } from '@contracts'

// THE BLOCKLIST THAT LOOKED COMPLETE, pinned.
//
// No agent act and no usage store-read may touch a bank, mailbox or government session —
// actOrigins never overrides this list. The list contained 'bank', which covers
// bankofamerica and every host with the word in it, and that is exactly why it read as
// thorough. The institutions that do NOT say "bank" are most of the ones a person actually
// holds money at, and every one of them was reachable: citi, fidelity, schwab, vanguard,
// robinhood, capitalone, amex.
//
// A list is only as good as the enumeration behind it, so the enumeration is the test.

const BLOCKED = [
  // The gap that prompted this — none of these contain the word "bank".
  'https://www.citi.com',
  'https://www.fidelity.com',
  'https://www.schwab.com',
  'https://investor.vanguard.com',
  'https://robinhood.com',
  'https://www.capitalone.com',
  'https://www.americanexpress.com',
  'https://www.etrade.com',
  // Already covered, and must stay covered.
  'https://www.bankofamerica.com',
  'https://chase.com',
  'https://www.paypal.com',
  'https://mail.google.com',
  'https://outlook.office.com',
  'https://www.irs.gov',
  'https://appleid.apple.com',
  // Identity providers: a session here mints sessions everywhere else.
  'https://accounts.google.com',
  'https://login.microsoftonline.com',
  // Non-US, because the product is not US-only.
  'https://www.hsbc.co.uk',
  'https://www.barclays.co.uk',
  'https://monzo.com',
  'https://www.gov.uk'
]

// Ordinary developer destinations. Blocking these would make the feature useless, which
// is the failure mode a widened blocklist actually risks.
const ALLOWED = [
  'https://github.com',
  'https://stackoverflow.com',
  'https://developer.mozilla.org',
  'https://news.ycombinator.com',
  'https://registry.npmjs.org',
  'https://docs.rs',
  'https://localhost:3000',
  'https://example.com'
]

describe('isSensitiveOrigin', () => {
  it('refuses every financial, mail, government and identity origin enumerated', () => {
    for (const o of BLOCKED) expect(isSensitiveOrigin(o), o).toBe(true)
  })

  it('leaves ordinary developer destinations alone', () => {
    for (const o of ALLOWED) expect(isSensitiveOrigin(o), o).toBe(false)
  })

  it('matches case-insensitively', () => {
    expect(isSensitiveOrigin('HTTPS://WWW.SCHWAB.COM')).toBe(true)
  })

  it('has no pattern containing a slash — an origin carries no path', () => {
    // The file's own comment states this rule; a pattern with a '/' can never fire, so it
    // is a silent hole that reads like coverage.
    expect(SENSITIVE_ORIGIN_PATTERNS.filter((p) => p.includes('/'))).toEqual([])
  })

  it('has no empty or whitespace pattern — one would match every origin', () => {
    expect(SENSITIVE_ORIGIN_PATTERNS.filter((p) => !p.trim())).toEqual([])
  })
})
