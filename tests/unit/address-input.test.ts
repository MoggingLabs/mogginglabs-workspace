import { describe, expect, it } from 'vitest'
import { resolveAddressInput, searchUrlFor } from '@contracts'

// The omnibox rule (F3): a URL opens, a search searches, and a scheme-less host is
// https-first EXCEPT a dev server (localhost / IP / explicit port), which is http.
// Comet/Chrome behavior, made deterministic so the address bar can't regress into
// the old "everything is http, non-URLs are refused" behavior.

describe('resolveAddressInput', () => {
  it('opens an explicit http(s) url verbatim', () => {
    expect(resolveAddressInput('https://github.com/a/b')).toEqual({ kind: 'url', url: 'https://github.com/a/b' })
    expect(resolveAddressInput('http://example.com')).toEqual({ kind: 'url', url: 'http://example.com/' })
  })

  it('defaults a scheme-less public host to https', () => {
    expect(resolveAddressInput('github.com')).toEqual({ kind: 'url', url: 'https://github.com/' })
    expect(resolveAddressInput('example.org/path?q=1')).toEqual({ kind: 'url', url: 'https://example.org/path?q=1' })
  })

  it('keeps a dev server on http (localhost, IP, explicit port)', () => {
    expect(resolveAddressInput('localhost:3000')).toEqual({ kind: 'url', url: 'http://localhost:3000/' })
    expect(resolveAddressInput('localhost')).toEqual({ kind: 'url', url: 'http://localhost/' })
    expect(resolveAddressInput('127.0.0.1:5173')).toEqual({ kind: 'url', url: 'http://127.0.0.1:5173/' })
    expect(resolveAddressInput('example.com:8080')).toEqual({ kind: 'url', url: 'http://example.com:8080/' })
  })

  it('treats words and queries as searches', () => {
    expect(resolveAddressInput('how to center a div')).toEqual({ kind: 'search', query: 'how to center a div' })
    expect(resolveAddressInput('react')).toEqual({ kind: 'search', query: 'react' })
    expect(resolveAddressInput('what is 2+2')).toEqual({ kind: 'search', query: 'what is 2+2' })
  })

  it('searches a non-web scheme rather than opening it', () => {
    expect(resolveAddressInput('mailto:a@b.com')).toEqual({ kind: 'search', query: 'mailto:a@b.com' })
    expect(resolveAddressInput('about:blank')).toEqual({ kind: 'search', query: 'about:blank' })
  })

  it('returns null for empty/whitespace', () => {
    expect(resolveAddressInput('')).toBeNull()
    expect(resolveAddressInput('   ')).toBeNull()
  })

  it('builds an encoded search url from a template', () => {
    expect(searchUrlFor('https://duckduckgo.com/?q=%s', 'a b&c')).toBe('https://duckduckgo.com/?q=a%20b%26c')
  })
})
