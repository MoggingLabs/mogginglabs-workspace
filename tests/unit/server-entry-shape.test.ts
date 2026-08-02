import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { serverEntryFor, validateServerEntry } from '@backend/features/integrations/registry'

// WHAT A CLI CONFIG ENTRY MAY NAME.
//
// A stored server entry outlives the release that wrote it: the line sits in the user's own
// ~/.claude.json (or equivalent) and nothing rewrites it on update. So the command it names
// must be PROTOCOL-NEUTRAL.
//
// The house row has always done that — `{command: executable, args: [mcpEntry]}`, where
// mcpEntry is a stable launcher under run/mcp. The connection row hand-built its own shape and
// named `connectionShim`, which lives in the VERSION-PINNED run/v<N>/bin. After a protocol bump
// that path is gone and every connection the user had configured stops resolving — silently,
// in their CLI, with no app involved.

const runtime = { executable: '/rt/mogging-node', launcher: '/rt/mcp/mogging-connection.mjs' }

describe('serverEntryFor', () => {
  it('names the executable and the stable launcher', () => {
    const entry = serverEntryFor(runtime, { id: 'sentry', label: 'Sentry', args: ['--connection', 'sentry'] })
    expect(entry.command).toBe(runtime.executable)
    expect(entry.args).toEqual([runtime.launcher, '--connection', 'sentry'])
    expect(entry.transport).toBe('stdio')
  })

  it('never carries an env map', () => {
    // The entry validator refuses any env value that is not a `${VAR}` reference, deliberately,
    // so no credential literal can reach a CLI config. A builder that cannot express env cannot
    // be talked into one.
    const entry = serverEntryFor(runtime, { id: 'x', label: 'X' })
    expect('env' in entry).toBe(false)
  })

  it('omits builtIn unless asked', () => {
    expect('builtIn' in serverEntryFor(runtime, { id: 'x', label: 'X' })).toBe(false)
    expect(serverEntryFor(runtime, { id: 'x', label: 'X', builtIn: true }).builtIn).toBe(true)
  })

  it('produces an entry the validator accepts', () => {
    // The two must agree: a builder that emits something saveServer would refuse is worse than
    // hand-building, because the refusal arrives at write time.
    const v = validateServerEntry(serverEntryFor(runtime, { id: 'sentry', label: 'Sentry', args: ['--connection', 'sentry'] }))
    expect(v.ok, v.ok ? '' : v.reason).toBe(true)
  })
})

describe('both rows are built the same way', () => {
  // The connection row and the house row are the only two entries this app writes. They
  // diverged once; a shared builder is what stops them diverging again.
  const conn = readFileSync(resolve(import.meta.dirname, '../../src/main/connections.ts'), 'utf8')
  const manager = readFileSync(resolve(import.meta.dirname, '../../src/main/mcp-manager.ts'), 'utf8')

  it('the connection row uses the builder', () => {
    expect(conn).toMatch(/serverEntryFor\(/)
  })

  it('the connection row names connectionEntry, not connectionShim', () => {
    const body = (() => {
      const at = conn.indexOf('export function registerConnectionServer(')
      expect(at, 'registerConnectionServer not found').toBeGreaterThan(-1)
      // Comments stripped: the code here is commented with the very word being refused, and a
      // test its own explanation can satisfy — or fail — proves nothing either way.
      return conn.slice(at, conn.indexOf('\n}', at)).replace(/^\s*\/\/.*$/gm, '')
    })()
    expect(body).toMatch(/launcher: runtime\.connectionEntry/)
    expect(body).toMatch(/executable: runtime\.executable/)
    // Anchored on the WHOLE body, not on the old hand-built shape: the shim is version-pinned
    // (run/v<N>/bin) and must not reach a CLI config in ANY field. An assertion that names the
    // shape it is replacing stops biting the moment that shape is gone.
    expect(body, 'connectionShim is version-pinned — it must not reach a CLI config').not.toContain(
      'connectionShim'
    )
  })

  it('the house row uses the same builder', () => {
    expect(manager).toMatch(/serverEntryFor\(/)
    expect(manager, 'hand-building is how the two shapes drifted apart').not.toMatch(
      /transport: 'stdio',\s*\n\s*command: runtime\.executable/
    )
  })
})
