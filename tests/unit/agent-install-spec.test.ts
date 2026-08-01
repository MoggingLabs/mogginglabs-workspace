import { describe, expect, it } from 'vitest'
import { AGENT_CLI_REGISTRY, type AgentCliDefinition } from '@backend/core/agent-clis'
// The SUBPATH, never the barrel: @backend/features/agents re-exports install.ts, whose
// import chain reaches node-pty — a native module the CI unit job does not build. The
// barrel import loaded fine on this Windows box and killed the suite on Ubuntu at
// import time (run 30680097418), which is exactly why every unit test here imports the
// module it tests directly.
import { signInTarget } from '@backend/features/agents/adapters'

/**
 * ONE FACT, TWO SHAPES — and a gate so they cannot drift apart.
 *
 * `installHint` is prose a human reads and copies. `installSpec` is the same command as
 * argv, so one-click setup can spawn it without a shell (no quoting surface, real exit
 * codes, and the freedom to resolve `npm` to `npm.cmd` on Windows before spawning it).
 * Carrying the same fact twice is a deliberate trade; a silent divergence between them
 * would mean the button and the copyable command install DIFFERENT THINGS, which is the
 * one failure nobody would think to check for.
 */
describe('agent install specs', () => {
  const definitions = AGENT_CLI_REGISTRY as readonly AgentCliDefinition[]

  it('gives every CLI with a hint a runnable spec', () => {
    for (const definition of definitions) {
      if (!definition.installHint) continue
      expect(definition.installSpec, `${definition.id} has a hint but no spec`).toBeTruthy()
      expect(definition.installSpec!.steps.length).toBeGreaterThan(0)
    }
  })

  it('every spec step names a runtime the setup service knows how to find', () => {
    // The runner resolves these LOGICAL names on the live PATH. A name outside this set
    // would resolve to null at run time and fail the install with "could not find …".
    const known = new Set(['npm', 'python', 'aider-install'])
    for (const definition of definitions) {
      for (const step of definition.installSpec?.steps ?? []) {
        expect(known.has(step.file), `${definition.id} names unknown runtime ${step.file}`).toBe(true)
      }
    }
  })

  it('the spec spells the same package the hint tells the user to install', () => {
    for (const definition of definitions) {
      const hint = definition.installHint
      const spec = definition.installSpec
      if (!hint || !spec) continue
      const spelled = spec.steps.flatMap((step) => [step.file, ...step.args])
      for (const token of spelled) {
        // Every token of the argv must appear in the prose, so a package rename in one
        // place cannot quietly survive in the other.
        expect(hint, `${definition.id}: “${token}” is in the spec but not the hint`).toContain(token)
      }
    }
  })

  it('declares the runtime each install actually needs', () => {
    for (const definition of definitions) {
      const spec = definition.installSpec
      if (!spec) continue
      const usesNpm = spec.steps.some((step) => step.file === 'npm')
      expect(spec.requires).toBe(usesNpm ? 'node' : 'python')
    }
  })
})

describe('signInTarget', () => {
  it('hands back the provider’s OWN verb, never an invented one', () => {
    expect(signInTarget('codex')).toMatchObject({ agentId: 'codex', shell: 'codex login' })
    expect(signInTarget('claude')).toMatchObject({ agentId: 'claude', inSession: '/login', shell: 'claude' })
    expect(signInTarget('opencode')).toMatchObject({ shell: 'opencode auth login' })
  })

  it('is null for a provider that authenticates by API key', () => {
    // aider has no login verb. Offering a sign-in button that types a command aider does
    // not have would be worse than offering nothing.
    expect(signInTarget('aider')).toBeNull()
  })

  it('is null for an unknown provider', () => {
    expect(signInTarget('nope')).toBeNull()
  })
})
