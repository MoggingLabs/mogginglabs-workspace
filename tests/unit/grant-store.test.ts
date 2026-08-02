import { describe, expect, it } from 'vitest'
import {
  clearGrant,
  grantedWriteToolNames,
  isBlockedActOrigin,
  normalizeActOrigin,
  readGrant,
  sanitizeGrant,
  writeGrant
} from '@backend/features/integrations/grant-store'
import { MCP_WRITE_TOOL_NAMES } from '@contracts'

// THE AGENT-BROWSING AND MCP-WRITE CONSENT BOUNDARY.
//
// This module decides what an agent may write and which sites it may act on. Everything it
// returns is derived from persisted, user-editable JSON, so the sanitizer is the only thing
// between a hand-edited settings row and a granted capability.
//
// Workspace ids are REUSED, and `workspaceIdForPane` resolves by ordinal — so a surviving row
// hands a brand-new workspace the deleted one's consent. That is what `clearGrant` is for.

/** A settings KV with real delete, which is what the app ships. */
const kvWithDel = () => {
  const map = new Map<string, string>()
  return {
    map,
    get: (k: string) => map.get(k) ?? null,
    set: (k: string, v: string) => void map.set(k, v),
    del: (k: string) => void map.delete(k)
  }
}

/** A KV that cannot delete — the fallback path, where a row of defaults IS the revoke. */
const kvNoDel = () => {
  const map = new Map<string, string>()
  return { map, get: (k: string) => map.get(k) ?? null, set: (k: string, v: string) => void map.set(k, v) }
}

describe('normalizeActOrigin', () => {
  it('makes a bare host into an https origin', () => {
    expect(normalizeActOrigin('github.com')).toBe('https://github.com')
  })

  it('drops path, query and fragment — a grant is per ORIGIN', () => {
    expect(normalizeActOrigin('https://github.com/some/repo?x=1#y')).toBe('https://github.com')
  })

  it('refuses what is not an origin at all', () => {
    for (const bad of ['', '   ', 'not a host']) expect(normalizeActOrigin(bad), bad).toBeNull()
  })
})

describe('isBlockedActOrigin', () => {
  it('blocks a sensitive origin however it is spelled', () => {
    expect(isBlockedActOrigin('https://chase.com')).toBe(true)
    expect(isBlockedActOrigin('HTTPS://CHASE.COM')).toBe(true)
  })

  it('lets an ordinary origin through', () => {
    expect(isBlockedActOrigin('https://github.com')).toBe(false)
  })
})

describe('sanitizeGrant', () => {
  it('a non-object is the closed fist, not a crash', () => {
    for (const raw of [null, undefined, 42, 'nope', []]) {
      const g = sanitizeGrant('ws', raw)
      expect(g.workspaceId, JSON.stringify(raw)).toBe('ws')
      expect(g.writeTools).toBe('none')
    }
  })

  it('coerces an unknown web level to the default rather than storing it', () => {
    expect(sanitizeGrant('ws', { web: 'nonsense' }).web).toBe(sanitizeGrant('ws', {}).web)
  })

  it('keeps only tool names the catalog knows', () => {
    const g = sanitizeGrant('ws', { writeTools: [MCP_WRITE_TOOL_NAMES[0], 'rm_minus_rf'] })
    expect(g.writeTools).toEqual([MCP_WRITE_TOOL_NAMES[0]])
  })

  it('an explicitly empty list is the closed fist — one spelling for it', () => {
    expect(sanitizeGrant('ws', { writeTools: [] }).writeTools).toBe('none')
  })

  it('normalizes act origins and drops duplicates', () => {
    const g = sanitizeGrant('ws', { actOrigins: ['github.com', 'https://github.com/x', 'https://gitlab.com'] })
    expect(g.actOrigins).toEqual(['https://github.com', 'https://gitlab.com'])
  })

  // The editor end of the both-ends rule. Dispatch re-checks independently, but a blocked
  // origin must never reach persistence in the first place.
  it('refuses to persist a blocked origin', () => {
    expect(sanitizeGrant('ws', { actOrigins: ['chase.com', 'github.com'] }).actOrigins).toEqual([
      'https://github.com'
    ])
  })

  it('caps the origin list', () => {
    const many = Array.from({ length: 250 }, (_, i) => `https://h${i}.example.com`)
    expect(sanitizeGrant('ws', { actOrigins: many }).actOrigins).toHaveLength(200)
  })
})

describe('grantedWriteToolNames', () => {
  it("'none' serves nothing and 'all' serves the catalog", () => {
    expect(grantedWriteToolNames(sanitizeGrant('ws', { writeTools: 'none' }))).toEqual([])
    expect(grantedWriteToolNames(sanitizeGrant('ws', { writeTools: 'all' }))).toEqual([...MCP_WRITE_TOOL_NAMES])
  })

  it('a list serves exactly that list', () => {
    const one = MCP_WRITE_TOOL_NAMES[0]!
    expect(grantedWriteToolNames(sanitizeGrant('ws', { writeTools: [one] }))).toEqual([one])
  })
})

describe('a cleared workspace does not come back', () => {
  it('round-trips a written grant', () => {
    const kv = kvWithDel()
    writeGrant(kv, sanitizeGrant('ws', { writeTools: 'all', actOrigins: ['github.com'] }))
    const back = readGrant(kv, 'ws')
    expect(back.writeTools).toBe('all')
    expect(back.actOrigins).toEqual(['https://github.com'])
  })

  it('migrates the legacy 6/05b consent row exactly once', () => {
    const kv = kvWithDel()
    kv.map.set('browser.agentControl.ws', '1')
    expect(readGrant(kv, 'ws').web).toBe('public')
    // The migration writes a real grant row, so it does not re-run.
    expect(kv.map.has('integrations.grant.ws')).toBe(true)
  })

  // THE regression. clearGrant's own doc says it "stops the legacy-consent migration from
  // re-opening web behind the user's back" — but with a KV that can delete, it removed only
  // the grant row, readGrant found nothing, fell through to the legacy key and migrated
  // `web:'public'` straight back onto a brand-new workspace holding a reused id.
  it('clearing does not let the legacy row re-open web access', () => {
    const kv = kvWithDel()
    kv.map.set('browser.agentControl.ws', '1')
    readGrant(kv, 'ws') // migrate
    clearGrant(kv, 'ws')
    expect(readGrant(kv, 'ws').web, 'a reused id must not inherit browsing consent').not.toBe('public')
  })

  it('holds on a KV that cannot delete, where defaults ARE the revoke', () => {
    const kv = kvNoDel()
    kv.map.set('browser.agentControl.ws', '1')
    readGrant(kv, 'ws')
    clearGrant(kv, 'ws')
    expect(readGrant(kv, 'ws').web).not.toBe('public')
  })

  it('clearing drops the write tools too', () => {
    const kv = kvWithDel()
    writeGrant(kv, sanitizeGrant('ws', { writeTools: 'all' }))
    clearGrant(kv, 'ws')
    expect(grantedWriteToolNames(readGrant(kv, 'ws'))).toEqual([])
  })

  it('clears only the workspace it was asked about', () => {
    const kv = kvWithDel()
    writeGrant(kv, sanitizeGrant('keep', { writeTools: 'all' }))
    writeGrant(kv, sanitizeGrant('drop', { writeTools: 'all' }))
    clearGrant(kv, 'drop')
    expect(readGrant(kv, 'keep').writeTools).toBe('all')
  })

  it('ignores an empty workspace id rather than clearing something else', () => {
    const kv = kvWithDel()
    writeGrant(kv, sanitizeGrant('ws', { writeTools: 'all' }))
    clearGrant(kv, '')
    expect(readGrant(kv, 'ws').writeTools).toBe('all')
  })
})
