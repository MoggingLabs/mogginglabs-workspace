import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { httpsOrLoopbackUrl, validateAuthServerMetadata } from '@backend/core/net/url-guard'

// A REMOTE STRING REACHING shell.openExternal.
//
// `shell.openExternal` hands a string to the OPERATING SYSTEM, which picks a program by
// scheme. `ms-msdt:`, `file:`, `search-ms:` are not "a page that fails to load" — they are
// another program, launched with an argument the remote side chose.
//
// Two OAuth sinks took one. `authorization_endpoint` is fully remote-supplied: discovery
// follows the 401's resource_metadata pointer to an authorization server, and the only check
// was that the field was PRESENT. `verification_uri` comes raw from a device-code RESPONSE
// BODY — the request host is pinned by the provider catalog, the response content is not.
//
// Three near-identical predicates already existed in this repo and none guarded either sink.

describe('httpsOrLoopbackUrl', () => {
  it('accepts https anywhere', () => {
    expect(httpsOrLoopbackUrl('https://auth.example.com/authorize')).toBe('https://auth.example.com/authorize')
    expect(httpsOrLoopbackUrl('HTTPS://Auth.Example.com/x'), 'scheme is case-insensitive').toBeTruthy()
  })

  it('accepts http ONLY on loopback — that is our own redirect receiver', () => {
    expect(httpsOrLoopbackUrl('http://127.0.0.1:51234/cb')).toBeTruthy()
    expect(httpsOrLoopbackUrl('http://localhost/cb')).toBeTruthy()
    expect(httpsOrLoopbackUrl('http://evil.example.com/cb')).toBeNull()
  })

  // THE point. Every one of these launches a program, not a page.
  it('refuses a scheme that names another program', () => {
    for (const bad of [
      'ms-msdt:/id PCWDiagnostic',
      'file:///C:/Windows/System32/calc.exe',
      'search-ms:query=x',
      'javascript:alert(1)',
      'data:text/html,<script>1</script>',
      'vbscript:msgbox',
      'ftp://example.com/x'
    ]) {
      expect(httpsOrLoopbackUrl(bad), bad).toBeNull()
    }
  })

  it('refuses what is not a URL at all', () => {
    for (const bad of ['', '   ', 'not a url']) expect(httpsOrLoopbackUrl(bad), bad).toBeNull()
  })

  // Returning the parsed href rather than a boolean is deliberate: it stops a caller
  // re-parsing the raw string, which is how a check and its subject drift apart.
  it('hands back the normalized href, not a boolean', () => {
    expect(httpsOrLoopbackUrl(' https://x.test/a ')).toBe('https://x.test/a')
  })
})

describe('validateAuthServerMetadata', () => {
  const ok = { authorization_endpoint: 'https://a.test/auth', token_endpoint: 'https://a.test/token' }

  it('accepts a well-formed server', () => {
    expect(validateAuthServerMetadata(ok)).toEqual({ ok: true })
  })

  it('refuses a non-https authorize endpoint, naming the field', () => {
    const v = validateAuthServerMetadata({ ...ok, authorization_endpoint: 'ms-msdt:x' })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toContain('authorization_endpoint')
  })

  it('refuses a non-https token endpoint too', () => {
    expect(validateAuthServerMetadata({ ...ok, token_endpoint: 'http://a.test/token' }).ok).toBe(false)
  })

  it('still requires presence', () => {
    expect(validateAuthServerMetadata({ token_endpoint: 'https://a.test/token' }).ok).toBe(false)
    expect(validateAuthServerMetadata(null).ok).toBe(false)
  })

  // An ABSENT optional endpoint is a server that does not offer that grant — fine. A MALFORMED
  // one is a server we must not follow.
  it('ignores an absent optional endpoint but checks a present one', () => {
    expect(validateAuthServerMetadata({ ...ok, device_authorization_endpoint: undefined }).ok).toBe(true)
    expect(validateAuthServerMetadata({ ...ok, device_authorization_endpoint: 'file:///x' }).ok).toBe(false)
    expect(validateAuthServerMetadata({ ...ok, registration_endpoint: 'javascript:1' }).ok).toBe(false)
  })
})

describe('the guard is applied where it matters', () => {
  // Structural: connections.ts and oauth.ts carry electron and network dependencies. What
  // matters is that no `shell.openExternal` is reached with an unchecked string — a predicate
  // checked only once is only correct until someone adds a caller.
  const conn = readFileSync(resolve(import.meta.dirname, '../../src/main/connections.ts'), 'utf8')
  const oauth = readFileSync(resolve(import.meta.dirname, '../../src/backend/features/integrations/oauth.ts'), 'utf8')

  it('every openExternal in connections.ts takes a guarded value', () => {
    const args = [...conn.matchAll(/shell\.openExternal\(([^)]*)\)/g)].map((m) => m[1].trim())
    expect(args.length, 'the sinks moved — re-anchor rather than delete').toBeGreaterThan(0)
    for (const arg of args) expect(arg, `unguarded openExternal argument: ${arg}`).toMatch(/^(authorizeUrl|deviceUrl)$/)
  })

  it('discovery refuses metadata on arrival, not just at the sink', () => {
    expect(oauth).toMatch(/validateAuthServerMetadata\(meta\)\.ok/)
    expect(oauth, 'presence was the entire check').not.toMatch(/meta\?\.authorization_endpoint && meta\.token_endpoint/)
  })

  it('the device grant carries only checked URLs', () => {
    expect(oauth).toMatch(/verificationUri: safeVerificationUri/)
    expect(oauth).toMatch(/verificationUriComplete: safeComplete/)
  })

  it('the pasted-URL check delegates rather than restating the rule', () => {
    expect(conn).toMatch(/const validConnectionUrl = \(url: string\): boolean => httpsOrLoopbackUrl\(url\) !== null/)
  })
})
