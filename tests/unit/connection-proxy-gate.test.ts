import { describe, expect, it } from 'vitest'
import { connectionProxyRefusal } from '@backend/features/integrations/rest-bridge'
import { bodyOf, sourceOf } from './source-body'

// THE HOUSE PROXY TO AN OAUTH-CONNECTED SERVICE.
//
// `handleConnectionRpc` has two branches. The REST one resolves `writeGranted` from the
// caller's pane → workspace → grant, and `resolveWriteAllGranted` returns false for a paneless
// caller — fail-closed, as its own comment says.
//
// The MCP-proxy branch beside it resolved nothing and checked nothing. It forwarded arbitrary
// JSON-RPC upstream with the connection's DECRYPTED access token attached. Any same-user
// process that could read the 0600 endpoint file could call every tool on every connected
// service, as the user, with no workspace and therefore no grant to answer to.

describe('connectionProxyRefusal', () => {
  it('lets a pane-bound caller through', () => {
    expect(connectionProxyRefusal({ pane: '101' })).toBeNull()
  })

  // A caller with no pane has no workspace, so there is no grant to check it against. That is
  // "we cannot ask", not "allow" — the shape this whole audit keeps turning up.
  it('refuses a caller bound to no pane', () => {
    expect(connectionProxyRefusal({})).toBeTruthy()
    expect(connectionProxyRefusal({ pane: undefined })).toBeTruthy()
  })

  it('refuses an empty pane id — that is absence, not a pane', () => {
    expect(connectionProxyRefusal({ pane: '' })).toBeTruthy()
  })

  it('says what the caller must be, not just no', () => {
    const reason = connectionProxyRefusal({})
    expect(reason).toMatch(/pane/i)
    expect(reason).toMatch(/workspace/i)
  })
})

describe('both branches of the bridge are gated', () => {
  const src = sourceOf('src/main/mcp-endpoint.ts')
  const body = bodyOf(src, 'async function handleConnectionRpc(')

  it('the MCP proxy refuses before it resolves an upstream', () => {
    expect(body).toContain('connectionProxyRefusal({ pane: boundPane })')
    // Before, not after: resolving the upstream is what decrypts the token.
    expect(body.indexOf('connectionProxyRefusal')).toBeLessThan(body.indexOf('await connectionUpstream('))
  })

  it('and it returns rather than falling through', () => {
    expect(body).toMatch(/if \(refusal\) return \{ ok: false, reason: refusal \}/)
  })

  it('the REST branch still resolves the grant for its own write gate', () => {
    expect(body).toContain('writeGranted: resolveWriteAllGranted(boundPane)')
  })
})
