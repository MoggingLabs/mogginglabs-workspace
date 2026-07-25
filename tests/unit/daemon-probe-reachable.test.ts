import { afterEach, describe, expect, it } from 'vitest'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'
import { probeReachable } from '../../src/main/daemon-client'
import { DAEMON_PROTOCOL_VERSION } from '../../src/contracts'

// probeReachable decides whether a discovered endpoint is a LIVE daemon or a CORPSE, and the
// caller UNLINKS the endpoint on false. So a false negative is not a retry — it deletes a
// living daemon's endpoint.json, the rival spawn is refused by the still-held lock, nothing
// ever rewrites the file, and the run ends on the in-proc backend with no Retry.
//
// The rule this pins: a COMPLETED CONNECT already proves the wire. A corpse (a dead unix
// socket file, an absent pipe) answers ECONNREFUSED/ENOENT and can never complete one — so
// "connected but silent" is UNDECIDED, not gone, and pid.ts states the binding rule for
// exactly this decision: "Only 'definitely gone' … may kill it; every other answer keeps the
// undecided default and lets connect() be the judge."
//
// Pre-fix the timeout reported false unconditionally, so a live-but-slow daemon read as a
// corpse. F024's corpse is untouched by the fix and is asserted here as the other direction.

const sockPath = (): string =>
  process.platform === 'win32'
    ? `\\\\.\\pipe\\mogging-test-${randomBytes(6).toString('hex')}`
    : path.join(os.tmpdir(), `mogging-test-${randomBytes(6).toString('hex')}.sock`)

const endpoint = (address: string) => ({
  address,
  pid: process.pid,
  version: DAEMON_PROTOCOL_VERSION,
  token: 'test-token'
})

const servers: net.Server[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
})

/** A listener that ACCEPTS and then says nothing — a real daemon wedged or merely slow. */
const silentServer = async (): Promise<string> => {
  const address = sockPath()
  const server = net.createServer(() => {
    /* accept, answer nothing */
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(address, resolve))
  return address
}

describe('probeReachable', () => {
  it('does NOT report a corpse for a listener that accepts but stays silent', async () => {
    // The whole finding: this used to resolve false at the timeout, and the caller unlinks
    // a live daemon's endpoint on false.
    const address = await silentServer()
    await expect(probeReachable(endpoint(address), 300)).resolves.toBe(true)
  })

  it('still reports a corpse when nothing is listening (F024 is not weakened)', async () => {
    // A unix socket file that outlived its daemon / a pipe that is simply gone: connect
    // fails outright, which is the ONLY answer that means "definitely gone".
    await expect(probeReachable(endpoint(sockPath()), 300)).resolves.toBe(false)
  })

  it('reports live for a listener that answers, without waiting out the timeout', async () => {
    const address = sockPath()
    const server = net.createServer((sock) => {
      sock.write(JSON.stringify({ t: 'welcome' }) + '\n')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(address, resolve))
    const started = Date.now()
    await expect(probeReachable(endpoint(address), 3000)).resolves.toBe(true)
    expect(Date.now() - started).toBeLessThan(2000) // answered, not timed out
  })
})
