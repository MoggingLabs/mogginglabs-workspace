import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// TWO SILENT FAILURES IN THE DAEMON'S DISPATCH.
//
// transport.ts cannot be imported here: it pulls @backend/platform/pty-host, which calls
// requireNative('node-pty') at module top level. So these are structural assertions over its
// source, anchored on the switch cases themselves.

const src = readFileSync(resolve(import.meta.dirname, '../../src/pty-daemon/transport.ts'), 'utf8')

/** One `case '<verb>':` arm, up to its `break`. */
const caseArm = (verb: string): string => {
  const at = src.indexOf(`case '${verb}':`)
  expect(at, `case '${verb}' not found`).toBeGreaterThan(-1)
  const end = src.indexOf('\n          break', at)
  expect(end, `case '${verb}' has no break`).toBeGreaterThan(at)
  return src.slice(at, end)
}

describe('a spawn that cannot be honoured answers', () => {
  // `sessions.ensure` throws on a spec it cannot honour (an invalid remote). Unguarded, that
  // unwound through sock.on('data') into the process-level uncaughtException handler — which
  // only logs — so the REST of that chunk's frames were dropped with no reply, and the
  // client's spawn waiter hung until its own timeout.
  const spawn = (() => {
    const at = src.indexOf('const spawn = (): void => {')
    expect(at, 'the spawn closure not found').toBeGreaterThan(-1)
    return src.slice(at, src.indexOf('\n          }', at))
  })()

  it('guards the throwing call', () => {
    expect(spawn).toMatch(/try\s*\{[\s\S]{0,200}sessions\.ensure\(/)
    expect(spawn).toMatch(/catch\s*\(/)
  })

  it('replies with an error frame naming the pane', () => {
    // The `badremote` send a few lines above proves this channel already existed.
    expect(spawn).toMatch(/send\(\{\s*t:\s*'error',\s*reason:\s*'spawnfailed',\s*id:\s*m\.id\s*\}\)/)
  })

  it('does not fall through and reply `spawned` anyway', () => {
    // The `return` must follow the error frame: without it, control reaches the `spawned`
    // reply and the client is told a session exists that does not.
    expect(spawn, 'the catch must stop, not continue into the spawned reply').toMatch(
      /reason: 'spawnfailed', id: m\.id \}\)\s*\n\s*return\b/
    )
  })

  it('records why, so the failure is diagnosable after the fact', () => {
    expect(spawn).toMatch(/log\(/)
  })
})

describe('a generation-refused frame leaves a trace', () => {
  // v11's `gen` is a staleness guard: pane ids are reused, so a stale generation's late input
  // must not type into the id's successor. The gate was right; its silence was not. A refusal
  // left no log, no frame and no counter, so "my keystrokes vanished" was undiagnosable —
  // while the neighbouring boundToPane refusal logs.
  for (const verb of ['input', 'resize']) {
    it(`${verb} logs the refusal`, () => {
      const arm = caseArm(verb)
      expect(arm, `${verb} silently discards a stale frame`).toMatch(/else if \(pane\) log\(/)
      expect(arm).toContain('REFUSED')
    })

    // The live client rejects any PENDING SPAWN carrying the same pane id, so answering here
    // with an error frame would kill a spawn in flight for that pane — trading a silent drop
    // for a louder bug. This row exists so that reasoning is not quietly undone.
    it(`${verb} does NOT answer with an error frame`, () => {
      expect(caseArm(verb), 'an error frame keyed on the pane id fails the pending spawn').not.toMatch(
        /send\(\{\s*t:\s*'error'/
      )
    })

    it(`${verb} still applies the frame when the generation matches`, () => {
      expect(caseArm(verb)).toMatch(/typeof m\.gen !== 'number' \|\| m\.gen === pane\.gen/)
    })
  }
})
