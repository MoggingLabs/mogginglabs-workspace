import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { detectAgents, isOnPath } from '@backend/features/agents/detect'
import { makeTempDir, removeTempDir } from './temp-dir'

// detectAgents is a full PATH × PATHEXT stat walk per adapter, on the launch path AND
// the renderer's 15s poll AND every focus change. It is cached — and the cache's
// honesty is the whole question: it must never outlive a PATH repair (the setup flow
// mutates process.env.PATH mid-run), must be bypassable for the post-install verdict,
// and must never hand out a mutable reference to its own state.

const scratch = makeTempDir('detect-cache-')
afterAll(() => {
  process.env.PATH = ORIGINAL_PATH
  removeTempDir(scratch)
})

const ORIGINAL_PATH = process.env.PATH ?? ''
/** `claude` is AGENT_ADAPTERS' first bin; an extensionless file satisfies the scan's
 *  empty-ext probe on every platform (POSIX additionally needs +x, hence 0o755). */
const fakeBin = join(scratch, 'claude')

const claudeInstalled = (opts?: { maxAgeMs?: number }): boolean =>
  detectAgents(opts).find((a) => a.id === 'claude')?.installed === true

/** A PATH nobody has scanned yet — each test gets its own so the module-level cache
 *  starts cold for it (the key IS the PATH). */
let uniq = 0
const freshPath = (): string => {
  const spacer = join(scratch, `spacer-${uniq++}`)
  return `${scratch}${process.platform === 'win32' ? ';' : ':'}${spacer}`
}

beforeEach(() => {
  writeFileSync(fakeBin, '#!/bin/sh\n', { mode: 0o755 })
})

describe('detectAgents caching', () => {
  it('serves a repeat call from cache — a bin deleted under it is not noticed', () => {
    process.env.PATH = freshPath()
    expect(claudeInstalled()).toBe(true)
    rmSync(fakeBin)
    expect(isOnPath('claude'), 'the uncached probe sees the truth').toBe(false)
    expect(claudeInstalled(), 'the cached answer holds within the TTL').toBe(true)
  })

  it('maxAgeMs:0 bypasses the cache (the post-install verdict path)', () => {
    process.env.PATH = freshPath()
    expect(claudeInstalled()).toBe(true)
    rmSync(fakeBin)
    expect(claudeInstalled({ maxAgeMs: 0 })).toBe(false)
  })

  it('a PATH change invalidates immediately — a live PATH repair is never stale', () => {
    process.env.PATH = freshPath()
    expect(claudeInstalled()).toBe(true)
    rmSync(fakeBin)
    // Same instant, different PATH: the cache key moved, so the scan must re-run.
    process.env.PATH = freshPath()
    expect(claudeInstalled()).toBe(false)
  })

  it('hands out copies — a caller mutating the result cannot corrupt the cache', () => {
    process.env.PATH = freshPath()
    const first = detectAgents()
    const claude = first.find((a) => a.id === 'claude')
    expect(claude?.installed).toBe(true)
    claude!.installed = false
    claude!.name = 'tampered'
    const second = detectAgents().find((a) => a.id === 'claude')
    expect(second?.installed).toBe(true)
    expect(second?.name).not.toBe('tampered')
  })

  it('reports every adapter, cached or not', () => {
    process.env.PATH = freshPath()
    const ids = detectAgents().map((a) => a.id)
    expect(ids).toContain('claude')
    expect(ids.length).toBe(detectAgents({ maxAgeMs: 0 }).length)
  })
})
