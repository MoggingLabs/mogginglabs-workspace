import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ConfigMutationCoordinator, ConfigMutationError } from '@backend/core/config-files'
import { makeTempDir, removeTempDirs } from './temp-dir'

// EDITING A FILE THE USER ALSO OWNS.
//
// These are the user's own agent-CLI config files — `~/.claude.json` and friends. The app is a
// second writer, never the only one, so every rule here is about not destroying an edit made
// somewhere else: a compare-and-swap against the bytes actually on disk, one queue per file so
// two of our own writes cannot interleave, and byte-level preservation of the things a naive
// rewrite silently normalizes (a BOM, CRLF, a trailing newline).
//
// ADR 0011 names these as its gate; the fixtures did not exist.

const dirs: string[] = []
afterAll(() => removeTempDirs(dirs))
const tempFile = (name: string, contents?: string | Buffer): string => {
  const d = makeTempDir('mutate-')
  dirs.push(d)
  const p = join(d, name)
  if (contents !== undefined) writeFileSync(p, contents)
  return p
}

const coordinator = new ConfigMutationCoordinator()

describe('reading a config file', () => {
  it('reports absent rather than empty', () => {
    return coordinator.read(tempFile('nope.json')).then((snap) => {
      // "no file yet" and "a file containing nothing" are different states — one may be
      // created, the other must be edited in place.
      expect(snap.text).toBeNull()
      expect(snap.hash).toBeNull()
    })
  })

  it('notices a BOM, and CRLF, and a trailing newline', async () => {
    const snap = await coordinator.read(tempFile('bom.json', '﻿{"a":1}\r\n'))
    expect(snap.bom).toBe(true)
    expect(snap.eol).toBe('\r\n')
    expect(snap.trailingNewline).toBe(true)
  })

  it('reports LF and no BOM for the ordinary case', async () => {
    const snap = await coordinator.read(tempFile('plain.json', '{"a":1}\n'))
    expect(snap.bom).toBe(false)
    expect(snap.eol).toBe('\n')
  })
})

describe('the compare-and-swap', () => {
  it('writes when the file is what we last saw', async () => {
    const f = tempFile('cas.json', '{"a":1}')
    const before = await coordinator.read(f)
    const res = await coordinator.mutate({
      file: f,
      expectedHash: before.hash,
      transform: () => '{"a":2}',
      validate: () => undefined
    })
    expect(res.changed).toBe(true)
    expect(readFileSync(f, 'utf8')).toContain('"a":2')
  })

  // THE rule. Someone else edited the file between our read and our write; overwriting would
  // destroy their edit silently.
  it('REFUSES when the file moved under us', async () => {
    const f = tempFile('cas2.json', '{"a":1}')
    const before = await coordinator.read(f)
    writeFileSync(f, '{"a":"someone else"}') // an edit from outside the app

    await expect(
      coordinator.mutate({ file: f, expectedHash: before.hash, transform: () => '{"a":2}', validate: () => undefined })
    ).rejects.toBeInstanceOf(ConfigMutationError)

    expect(readFileSync(f, 'utf8'), "the other writer's bytes survive").toContain('someone else')
  })

  it('omitting expectedHash is an explicit opt-out, not an accident', async () => {
    const f = tempFile('cas3.json', '{"a":1}')
    await coordinator.read(f)
    writeFileSync(f, '{"a":"moved"}')
    const res = await coordinator.mutate({ file: f, transform: () => '{"a":3}', validate: () => undefined })
    expect(res.changed).toBe(true)
  })

  it('an expectedHash of null means "I expect no file"', async () => {
    const f = tempFile('cas4.json')
    const res = await coordinator.mutate({
      file: f,
      expectedHash: null,
      transform: () => '{"new":true}',
      validate: () => undefined
    })
    expect(res.changed).toBe(true)
    expect(readFileSync(f, 'utf8')).toContain('new')
  })
})

describe('validation runs before a byte reaches disk', () => {
  it('a rejected transform leaves the file untouched', async () => {
    const f = tempFile('val.json', '{"a":1}')
    await expect(
      coordinator.mutate({
        file: f,
        transform: () => 'not json at all',
        validate: () => {
          throw new Error('invalid')
        }
      })
    ).rejects.toBeTruthy()
    expect(readFileSync(f, 'utf8'), 'the original must survive a refused write').toBe('{"a":1}')
  })
})

describe('a no-op write is reported as one', () => {
  it('transforming to the same bytes does not claim a change', async () => {
    const f = tempFile('noop.json', '{"a":1}')
    const res = await coordinator.mutate({ file: f, transform: (c) => c.text ?? '', validate: () => undefined })
    expect(res.changed, 'callers invalidate caches on `changed`').toBe(false)
  })
})

describe('one queue per file', () => {
  // Two of our own writes must not interleave: both read, both decide, and the loser's
  // decision was made against bytes that no longer exist.
  it('serializes concurrent mutations of the same file', async () => {
    const f = tempFile('race.json', '0')
    const bump = () =>
      coordinator.mutate({
        file: f,
        transform: (c) => String(Number(c.text ?? '0') + 1),
        validate: () => undefined
      })

    await Promise.all([bump(), bump(), bump(), bump(), bump()])
    // Interleaved, every writer would read 0 and write 1.
    expect(readFileSync(f, 'utf8')).toBe('5')
  })
})

describe('byte-level preservation', () => {
  it('keeps a BOM the app never asked for', async () => {
    const f = tempFile('keep-bom.json', '﻿{"a":1}')
    await coordinator.mutate({ file: f, transform: () => '{"a":2}', validate: () => undefined })
    expect(readFileSync(f)[0], 'a stripped BOM is a diff in the user’s repo').toBe(0xef)
  })

  it('does not add a BOM to a file that had none', async () => {
    const f = tempFile('no-bom.json', '{"a":1}')
    await coordinator.mutate({ file: f, transform: () => '{"a":2}', validate: () => undefined })
    expect(readFileSync(f)[0]).not.toBe(0xef)
  })
})
