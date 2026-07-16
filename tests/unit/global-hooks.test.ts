import { describe, expect, it } from 'vitest'
import {
  applyGlobalHooks,
  globalHooksState,
  isOurHookCommand,
  removeGlobalHooks
} from '../../src/backend/features/agents/global-hooks'

// The pure half of the global Claude alert hooks (the hand-typed-launch gap). The rules that
// matter: every user key and user hook entry survives a rewrite byte-for-value; OUR entries —
// any vintage — are replaced, never stacked; junk we cannot faithfully rewrite is refused; and
// removal strips exactly ours, dropping the husks it empties.

const INV = 'node "C:\\Users\\p\\AppData\\Roaming\\app\\notify-hook\\notify.mjs"'
const STALE_INV = 'node "C:\\old-install\\userData\\notify-hook\\notify.mjs"'
const EVENTS = ['Notification', 'Stop', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit']

describe('isOurHookCommand', () => {
  it('matches the generated invocation at any install path, and nothing else', () => {
    expect(isOurHookCommand(`${INV} --event done`)).toBe(true)
    expect(isOurHookCommand(`${STALE_INV} --event needs-input`)).toBe(true)
    expect(isOurHookCommand('node /home/p/.config/app/notify-hook/notify.mjs --event done')).toBe(true)
    expect(isOurHookCommand('mogging notify --event needs-input')).toBe(false) // the user's own manual wiring is THEIRS
    expect(isOurHookCommand('node notify.mjs --event done')).toBe(false) // not under a notify-hook dir
    expect(isOurHookCommand(undefined)).toBe(false)
  })
})

describe('applyGlobalHooks', () => {
  it('wires all five events into an absent file', () => {
    const next = JSON.parse(applyGlobalHooks(null, INV)) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
    for (const event of EVENTS) {
      expect(next.hooks[event]).toHaveLength(1)
      expect(isOurHookCommand(next.hooks[event][0].hooks[0].command)).toBe(true)
    }
    expect(next.hooks.Stop[0].hooks[0].command).toBe(`${INV} --event done`)
  })

  it('preserves every user key and every user hook entry', () => {
    const current = JSON.stringify({
      model: 'claude-fable-5[1m]',
      permissions: { defaultMode: 'bypassPermissions' },
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'my-own-stop-logger' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-guard' }] }]
      }
    })
    const next = JSON.parse(applyGlobalHooks(current, INV)) as Record<string, unknown>
    expect(next.model).toBe('claude-fable-5[1m]')
    expect((next.permissions as { defaultMode: string }).defaultMode).toBe('bypassPermissions')
    const hooks = next.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>
    expect(hooks.PreToolUse).toHaveLength(1) // an event we do not own is untouched
    expect(hooks.Stop).toHaveLength(2) // theirs first, ours appended
    expect(hooks.Stop[0].hooks[0].command).toBe('my-own-stop-logger')
    expect(hooks.Stop[1].hooks[0].command).toBe(`${INV} --event done`)
  })

  it('replaces a stale install path instead of stacking a second copy', () => {
    const stale = applyGlobalHooks(null, STALE_INV)
    const next = JSON.parse(applyGlobalHooks(stale, INV)) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
    for (const event of EVENTS) expect(next.hooks[event]).toHaveLength(1)
    expect(next.hooks.Stop[0].hooks[0].command).toBe(`${INV} --event done`)
  })

  it('is idempotent', () => {
    const once = applyGlobalHooks(null, INV)
    expect(applyGlobalHooks(once, INV)).toBe(once)
  })

  it('refuses JSON it cannot faithfully rewrite', () => {
    expect(() => applyGlobalHooks('{ not json', INV)).toThrow()
    expect(() => applyGlobalHooks('[1,2,3]', INV)).toThrow()
  })
})

describe('globalHooksState', () => {
  it('walks the ladder: not-applied -> applied -> partial when the path goes stale', () => {
    expect(globalHooksState(null, INV)).toBe('not-applied')
    expect(globalHooksState('{}', INV)).toBe('not-applied')
    const applied = applyGlobalHooks(null, INV)
    expect(globalHooksState(applied, INV)).toBe('applied')
    // The same file read by a NEWER install whose userData moved: ours, but stale.
    expect(globalHooksState(applied, STALE_INV)).toBe('partial')
    expect(globalHooksState('{ nope', INV)).toBe('unreadable')
  })

  it('reads a manually pruned file as partial, not applied', () => {
    const applied = JSON.parse(applyGlobalHooks(null, INV)) as { hooks: Record<string, unknown> }
    delete applied.hooks.Stop
    expect(globalHooksState(JSON.stringify(applied), INV)).toBe('partial')
  })
})

describe('removeGlobalHooks', () => {
  it('strips exactly ours and drops the husks', () => {
    const mixed = applyGlobalHooks(
      JSON.stringify({
        theme: 'dark',
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'my-own-stop-logger' }] }] }
      }),
      INV
    )
    const next = JSON.parse(removeGlobalHooks(mixed)!) as { theme: string; hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
    expect(next.theme).toBe('dark')
    expect(next.hooks.Stop).toHaveLength(1) // theirs survives
    expect(next.hooks.Stop[0].hooks[0].command).toBe('my-own-stop-logger')
    for (const event of EVENTS.filter((e) => e !== 'Stop')) expect(next.hooks[event]).toBeUndefined()
  })

  it('drops the hooks map entirely when ours were all it held', () => {
    const next = JSON.parse(removeGlobalHooks(applyGlobalHooks(null, INV))!) as Record<string, unknown>
    expect(next.hooks).toBeUndefined()
  })

  it('reports nothing to do on files without our entries', () => {
    expect(removeGlobalHooks(null)).toBeNull()
    expect(removeGlobalHooks('{}')).toBeNull()
    expect(removeGlobalHooks(JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'theirs' }] }] } }))).toBeNull()
  })
})
