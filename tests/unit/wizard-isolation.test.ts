import { describe, expect, it } from 'vitest'
import { isolationView, type IsolationProbe } from '@ui/features/wizard/isolation-state'

// FOUR MEANINGS OF null, ONE OF THEM UNRESOLVABLE.
//
// The wizard held `isolatePreflight: WorktreePreflight | null`, and null meant: not asked yet,
// asked and waiting, cache cleared, and *no probe will ever run* — the last because a remote
// host owns the cwd and probeIsolation returns early without sending any IPC. All four
// rendered as the optimistic "Checking…", so a remote target sat permanently pending with
// nothing in flight. That is the unknown taking the permissive branch, applied to a state that
// cannot resolve.
//
// Second defect, in the same pair of functions: `syncIsolate` did `if (!usable) isolate = false`
// — writing a transient unknown into durable intent.

const answered = (reason: string, ok = false, detail?: string): IsolationProbe =>
  ({ kind: 'answered', preflight: { ok, reason, ...(detail ? { detail } : {}) } }) as IsolationProbe

describe('only a probe that is actually in flight says "Checking…"', () => {
  it('pending does', () => {
    expect(isolationView({ probe: { kind: 'pending' }, want: false }).hint).toBe('Checking…')
  })

  // THE regression. A remote host owns the cwd; isolation is local-only, so no probe will
  // ever run and the wait can never end.
  it('a remote target does NOT — it states the scope instead', () => {
    const view = isolationView({ probe: { kind: 'not-applicable' }, want: true })
    expect(view.hint).not.toMatch(/Checking/)
    expect(view.hint).toMatch(/this machine/i)
    expect(view.enabled).toBe(false)
    expect(view.fix, 'nothing is broken, so there is nothing to fix').toBeNull()
  })

  it('no folder does not either', () => {
    expect(isolationView({ probe: { kind: 'no-folder' }, want: false }).hint).not.toMatch(/Checking/)
  })
})

describe('intent survives an unknown verdict', () => {
  // Every folder change nulls the verdict. Writing `isolate = false` there meant switching
  // folders silently un-ticked the box, and coming back to a folder that CAN isolate left it
  // unchecked — the user's answer overwritten by a fact about the filesystem.
  it('carries want through pending and back', () => {
    const ok = isolationView({ probe: answered('ok', true), want: true })
    expect([ok.enabled, ok.checked, ok.want]).toEqual([true, true, true])

    const waiting = isolationView({ probe: { kind: 'pending' }, want: ok.want })
    expect(waiting.checked, 'nothing is offered while we do not know').toBe(false)
    expect(waiting.want, 'but the intent is not destroyed').toBe(true)

    const again = isolationView({ probe: answered('ok', true), want: waiting.want })
    expect(again.checked, 'the folder can isolate again, so the box comes back ticked').toBe(true)
  })

  it('carries want through a refusal too', () => {
    for (const reason of ['no-git', 'not-a-repo', 'no-commits', 'not-writable', 'unsupported']) {
      const view = isolationView({ probe: answered(reason), want: true })
      expect(view.checked, reason).toBe(false)
      expect(view.want, `${reason} must not overwrite what the user asked for`).toBe(true)
    }
  })

  it('never ticks a box the user did not tick', () => {
    expect(isolationView({ probe: answered('ok', true), want: false }).checked).toBe(false)
  })
})

describe('every refusal offers a way to ask again', () => {
  // The verdict is cached per folder. Only 'no-git' had a button, so a repository that became
  // isolable mid-session — first commit made, permissions fixed — stayed refused until the
  // folder changed.
  it('no-git offers the PATH repair', () => {
    expect(isolationView({ probe: answered('no-git'), want: false }).fix).toBe('path')
  })

  it('the other refusals offer a plain recheck', () => {
    for (const reason of ['not-a-repo', 'no-commits', 'not-writable', 'unsupported']) {
      expect(isolationView({ probe: answered(reason), want: false }).fix, reason).toBe('recheck')
    }
  })

  it('a working folder offers nothing — there is nothing wrong', () => {
    expect(isolationView({ probe: answered('ok', true), want: true }).fix).toBeNull()
  })

  it('names the obstacle rather than restating the feature', () => {
    expect(isolationView({ probe: answered('no-commits'), want: false }).hint).toMatch(/commit/i)
    expect(isolationView({ probe: answered('not-writable'), want: false }).hint).toMatch(/read-only/i)
    expect(isolationView({ probe: answered('unsupported', false, 'boom'), want: false }).hint).toContain('boom')
  })
})

describe('the toggle is only enabled when isolation can actually work', () => {
  it('enabled exactly on ok', () => {
    expect(isolationView({ probe: answered('ok', true), want: false }).enabled).toBe(true)
    for (const probe of [
      { kind: 'pending' } as const,
      { kind: 'no-folder' } as const,
      { kind: 'not-applicable' } as const,
      answered('no-git'),
      answered('not-a-repo')
    ]) {
      expect(isolationView({ probe, want: true }).enabled, JSON.stringify(probe)).toBe(false)
    }
  })

  it('a disabled toggle is never drawn ticked', () => {
    for (const probe of [{ kind: 'pending' } as const, { kind: 'not-applicable' } as const, answered('no-git')]) {
      const view = isolationView({ probe, want: true })
      expect(view.enabled && !view.checked, JSON.stringify(probe)).toBe(false)
      expect(view.checked).toBe(false)
    }
  })
})
