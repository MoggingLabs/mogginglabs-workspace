import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The terminal faces' readiness predicate — the gate that decides whether a pane may
 * PUBLISH a grid at all.
 *
 * xterm measures its cell at term.open(), against whatever face is resolved in that
 * instant, and exposes no readiness signal of its own: its metrics seam returns a number
 * as soon as anything has been measured, fallback face included. So a pane's whole
 * "is this measurement real?" question reduces to this one boolean, and the two properties
 * that make it safe to gate on — it settles even when the font pipeline never does, and it
 * is monotonic — are exactly what no live smoke can demonstrate. Pinned here instead.
 */

type FakeDoc = { fonts?: { load?: (...a: unknown[]) => Promise<unknown> } }

const setDocument = (doc: FakeDoc | undefined): void => {
  ;(globalThis as { document?: unknown }).document = doc
}

afterEach(() => {
  vi.useRealTimers()
  setDocument(undefined)
  vi.resetModules()
})

describe('terminalFontsReady', () => {
  it('is false until primed — a pane that has not asked has not waited', async () => {
    setDocument({ fonts: { load: () => new Promise(() => undefined) } })
    const { terminalFontsReady } = await import('@ui/core/terminal/font-port')
    expect(terminalFontsReady()).toBe(false)
  })

  it('settles at the bound when the faces never activate', async () => {
    // The failure this bound exists for is not "one pane measured a fallback" — it is "NO
    // pane in the app is ever measured", so no pty is ever sized and no deferred agent
    // launch ever types. A readiness gate with no escape hatch converts a font-pipeline
    // problem into a dead app.
    vi.useFakeTimers()
    setDocument({ fonts: { load: () => new Promise(() => undefined) } })
    const { primeTerminalFonts, terminalFontsReady } = await import('@ui/core/terminal/font-port')

    void primeTerminalFonts()
    expect(terminalFontsReady()).toBe(false)
    vi.advanceTimersByTime(1499)
    expect(terminalFontsReady()).toBe(false)
    vi.advanceTimersByTime(1)
    expect(terminalFontsReady()).toBe(true)
  })

  it('resolves the prime when the faces do activate, without waiting out the bound', async () => {
    vi.useFakeTimers()
    setDocument({ fonts: { load: () => Promise.resolve(undefined) } })
    const { primeTerminalFonts, terminalFontsReady } = await import('@ui/core/terminal/font-port')

    await primeTerminalFonts()
    expect(terminalFontsReady()).toBe(true)
    expect(vi.getTimerCount()).toBe(0) // the bound was cleared, not left to fire
  })

  it('is ready immediately where there is no FontFaceSet to wait for', async () => {
    setDocument({})
    const { primeTerminalFonts, terminalFontsReady } = await import('@ui/core/terminal/font-port')
    void primeTerminalFonts()
    expect(terminalFontsReady()).toBe(true)
  })

  it('primes ONCE however many callers ask — every pane calls it', async () => {
    const specs: unknown[] = []
    setDocument({
      fonts: {
        load: (spec: unknown) => {
          specs.push(spec)
          return Promise.resolve(undefined)
        }
      }
    })
    const { primeTerminalFonts } = await import('@ui/core/terminal/font-port')

    await Promise.all([primeTerminalFonts(), primeTerminalFonts(), primeTerminalFonts()])
    // Four faces — regular, bold, italic, and the unicode-range-scoped symbols face — and
    // one load apiece no matter how many panes mounted.
    expect(specs).toHaveLength(4)
    await primeTerminalFonts()
    expect(specs).toHaveLength(4)
  })

  it('is MONOTONIC — the property that makes it legal to gate a published grid on', async () => {
    // A readiness condition that can un-become-true (a pane's CURRENT renderer, say) forces
    // you to re-publish on every flip. This one only ever moves false -> true.
    setDocument({ fonts: { load: () => Promise.resolve(undefined) } })
    const { primeTerminalFonts, terminalFontsReady } = await import('@ui/core/terminal/font-port')

    await primeTerminalFonts()
    expect(terminalFontsReady()).toBe(true)
    setDocument({ fonts: { load: () => new Promise(() => undefined) } }) // faces "go away"
    await primeTerminalFonts()
    expect(terminalFontsReady()).toBe(true)
  })
})
