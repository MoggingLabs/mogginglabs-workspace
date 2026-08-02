import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// THE BROWSER-CONTROL ENDPOINT'S LIFECYCLE.
//
// mcp-endpoint.ts imports electron, so it cannot be instantiated here; these are structural
// assertions over its source. Each one names a capability that outlived the thing that granted
// it — the same shape as the pane-marks finding, one layer down.

const src = readFileSync(resolve(import.meta.dirname, '../../src/main/mcp-endpoint.ts'), 'utf8')

const bodyOf = (signature: string, endMarker = '\n}'): string => {
  const at = src.indexOf(signature)
  expect(at, `${signature} not found`).toBeGreaterThan(-1)
  return src.slice(at, src.indexOf(endMarker, at)).replace(/^\s*\/\/.*$/gm, '')
}

describe('stopping the endpoint stops the endpoint', () => {
  const stop = bodyOf('export function stopMcpEndpoint(): void {')

  // `server.close()` stops ACCEPT and nothing else. A socket that authenticated before the
  // stop keeps every capability it had — and what it holds here is a proxy that attaches
  // decrypted OAuth tokens to outbound calls on the user's behalf.
  it('destroys the sockets that already authenticated', () => {
    expect(stop).toContain('server?.close()')
    expect(stop, 'close() only stops new connections').toMatch(/for \(const sock of authedSocks\)[\s\S]{0,120}destroy\(\)/)
    expect(stop).toContain('authedSocks.clear()')
  })

  it('clears the token, so the next server does not accept the last one’s clients', () => {
    expect(stop).toMatch(/token = ''/)
  })

  it('removes the endpoint file AND the socket it names', () => {
    expect(stop).toContain('unlinkSync(endpointFile())')
    // The address embeds our pid, so nothing else will ever collide with it — and nothing
    // ever swept it either. A crashed run leaves browser-<oldpid>.sock behind forever.
    expect(stop).toContain('unlinkSync(socketAddress())')
  })
})

describe('the endpoint file describes something that is actually there', () => {
  const listen = bodyOf('server.listen(address, () => {', '\n  })')

  // A crash-stale file was byte-identical to a live one; a reader could only find out by
  // connecting and timing out. daemon-client's endpointLive() has always checked a pid.
  it('records the pid', () => {
    expect(listen).toMatch(/pid: process\.pid/)
  })

  // A direct write is not atomic. A reader arriving mid-write gets truncated JSON, and
  // `JSON.parse` failing is indistinguishable from "no app running".
  it('publishes by rename, not by writing in place', () => {
    expect(listen).toContain('renameSync(tmp, target)')
    expect(listen, 'the payload must land in the temp file, never the real one').not.toMatch(
      /writeFileSync\(\s*endpointFile\(\)/
    )
  })

  it('keeps the file 0600', () => {
    expect(listen).toContain('mode: 0o600')
  })

  // docs/06 promises "a 0600 unix socket". This one was created at the default umask, so on a
  // shared macOS box any local account could connect and spend the auth budget. Named pipes
  // reject remote clients by default and the runtime dir is per-user ACL-protected, so win32
  // needs nothing — and must not pay for a chmod that is a no-op there.
  it('hardens the unix socket, and only on POSIX', () => {
    expect(listen).toMatch(/chmodSync\(address, 0o600\)/)
    const guard = listen.slice(0, listen.indexOf('chmodSync'))
    expect(guard, 'chmod on a named pipe is meaningless').toMatch(/process\.platform !== 'win32'/)
  })
})
