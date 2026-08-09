import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ConfigMutationCoordinator, ConfigMutationError } from '@backend/core/config-files'
import { makeTempDir, removeTempDirs } from './temp-dir'

// The CAS ordering rule. `read()` is deliberately UNQUEUED, so an expectedHash token goes stale
// the moment a sibling writes — and the common sibling is a second launch for the same
// (workspace, cli) applying the IDENTICAL value: the wizard lineup requests every pane's agent
// in one synchronous pass. Refusing that is refusing an edit that is ALREADY SATISFIED, and the
// user saw "The config changed before the edit could be applied" about a config now in exactly
// the requested state — with the launch refused and every row persisted status:'error'.
//
// So the no-op short-circuit must be evaluated BEFORE the CAS: asking for what is already there
// is not a conflict. A genuinely DIVERGENT edit must still reject — that is the other direction,
// and it is asserted here so the fix cannot be mistaken for "CAS disabled".

const dirs: string[] = []
afterAll(() => removeTempDirs(dirs))
const tmpFile = (contents: string): string => {
  const dir = makeTempDir('mogging-cas-')
  dirs.push(dir)
  const p = join(dir, 'config.json')
  writeFileSync(p, contents)
  return p
}

describe('ConfigMutationCoordinator CAS', () => {
  it('accepts a stale token when the edit is already satisfied (the sibling applied OUR value)', async () => {
    const c = new ConfigMutationCoordinator()
    const file = tmpFile('{"a":1}')
    const snapshot = await c.read(file) // our token

    // A sibling launch writes the SAME value we are about to ask for.
    await c.mutate({ file, transform: () => '{"a":2}' })

    // Our mutate now carries a stale hash, but our transform is a no-op against the new bytes.
    const res = await c.mutate({ file, expectedHash: snapshot.hash, transform: () => '{"a":2}' })
    expect(res.changed).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('{"a":2}')
  })

  it('still rejects a stale token when the edit genuinely DIVERGES (CAS is not disabled)', async () => {
    const c = new ConfigMutationCoordinator()
    const file = tmpFile('{"a":1}')
    const snapshot = await c.read(file)

    await c.mutate({ file, transform: () => '{"a":2}' }) // out-of-band writer

    await expect(
      c.mutate({ file, expectedHash: snapshot.hash, transform: () => '{"a":99}' })
    ).rejects.toMatchObject({ code: 'changed-under-us' })
    expect(readFileSync(file, 'utf8')).toBe('{"a":2}') // the divergent edit did NOT land
  })

  it('a matching token still applies a real change', async () => {
    const c = new ConfigMutationCoordinator()
    const file = tmpFile('{"a":1}')
    const snapshot = await c.read(file)
    const res = await c.mutate({ file, expectedHash: snapshot.hash, transform: () => '{"a":3}' })
    expect(res.changed).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('{"a":3}')
  })

  it('ConfigMutationError is what a divergent edit throws', async () => {
    const c = new ConfigMutationCoordinator()
    const file = tmpFile('{"a":1}')
    const snapshot = await c.read(file)
    await c.mutate({ file, transform: () => '{"a":2}' })
    const err = await c
      .mutate({ file, expectedHash: snapshot.hash, transform: () => '{"a":99}' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConfigMutationError)
  })
})
