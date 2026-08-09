import { describe, expect, it } from 'vitest'
import { bodyOf, bodyWithoutComments, sourceOf } from './source-body'

// FOUR CHROME DEFECTS THAT ARE ABOUT WIRING, NOT ABOUT A DECISION.
//
// There is no pure function under any of these — each is a listener talking to the DOM at call
// time, and tests/unit has no browser. So they are asserted over the source, in this repo's
// existing idiom (wizard-controls.test.ts, settings-search-index.test.ts), with anchors that
// throw loudly when the shape moves rather than degrading into an empty haystack.
//
//   F006  the titlebar-press replay dispatched only `pointerdown`, so the dismissers that
//         listen on `click` (the layout popover, the browser dock's trail and sites menus)
//         never heard it — half the popovers this feature exists to close stayed open.
//   F008  Ctrl+, fired through a BLOCKING modal: #app is inert, so it swapped the whole
//         top-level view behind the dialog and stranded the user on Settings, grid gone.
//   F009  the rail toggle stayed live while the LAYOUT had auto-collapsed the rail. Both
//         classes resolve to the same width, so the click changed nothing on screen and still
//         WROTE railCollapsed=1 — widening the window later left the rail folded.
//   F013  the danger confirm's "Don't ask again this session" was keyed scope-BLIND, so
//         ticking it for one project silenced the same permission-bypass setting at
//         All-projects — machine-wide, reached with no prompt.
//   F020  dock-budget read the rail's width the instant it toggled `rail-auto-collapsed`,
//         i.e. the PRE-fold width, and nothing recomputed when the 260ms fold settled.

const appShell = sourceOf('src/ui/shell/app-shell.ts')
const settings = sourceOf('src/ui/features/settings/index.ts')
const agentConfig = sourceOf('src/ui/features/settings/agent-config.ts')
const dockBudget = sourceOf('src/ui/core/layout/dock-budget.ts')

/** The code following an anchor, comments stripped — a test its own explanation can satisfy
 *  proves nothing, and every one of these sites is commented with the words being asserted. */
function after(src: string, anchor: string, chars = 500): string {
  const i = src.indexOf(anchor)
  if (i === -1) throw new Error(`anchor not found — ${anchor}`)
  return src.slice(i, i + chars).replace(/^\s*\/\/.*$/gm, '')
}

// ── F006 ─────────────────────────────────────────────────────────────────────────────────────
describe('the titlebar-press replay', () => {
  const replay = bodyWithoutComments(appShell, 'getBridge().on(ShellChannels.chromePress,')

  it('dispatches a pointerdown — the dismissers that listen for one', () => {
    expect(replay).toContain("new PointerEvent('pointerdown'")
  })

  // THE DEFECT: a synthetic pointerdown never produces a click, and the layout popover — the
  // one this feature's own comment names as its target — listens on click.
  it('and a click, for the ones that listen for THAT', () => {
    expect(replay).toContain("new MouseEvent('click'")
  })

  it('both bubble, or nothing outside the menu ever hears them', () => {
    expect([...replay.matchAll(/bubbles: true/g)].length).toBe(2)
  })
})

// ── F008 ─────────────────────────────────────────────────────────────────────────────────────
describe('Ctrl+, while a blocking modal owns the keyboard', () => {
  const handler = after(settings, "e.key === ','", 900)

  it('asks shortcutsBlocked before doing anything', () => {
    expect(handler).toContain('shortcutsBlocked(e.target)')
  })

  it('and asks it BEFORE the view swap, not after', () => {
    // Both needles asserted present first: an indexOf that answers -1 would make the ordering
    // comparison pass for the wrong reason — and a MISSING guard answers -1, so without this
    // the ordering test would have gone green on the exact bytes it exists to refuse.
    expect(handler, 'the window must actually reach the swap').toContain("setActiveView('settings')")
    expect(handler, 'the guard must be in the window at all').toContain('shortcutsBlocked')
    expect(handler.indexOf('shortcutsBlocked')).toBeLessThan(handler.indexOf("setActiveView('settings')"))
  })

  it('the guard is imported from the one module that owns the rule', () => {
    expect(settings).toContain("import { shortcutsBlocked } from '../../core/commands/context'")
  })
})

// ── F009 ─────────────────────────────────────────────────────────────────────────────────────
describe('the rail toggle during an auto-collapse', () => {
  const toggle = bodyWithoutComments(appShell, 'const toggleRail = (): void =>')

  // The VERB refuses, so the chord path is covered too — not only the button.
  it('the verb refuses while rail-auto-collapsed is on', () => {
    expect(toggle).toContain("app.classList.contains('rail-auto-collapsed')")
    // The refusal must come before the persisted write — the write IS the defect.
    expect(toggle, 'the verb must still persist on the paths it allows').toContain('localStorage.setItem')
    expect(toggle.indexOf("contains('rail-auto-collapsed')")).toBeLessThan(toggle.indexOf('localStorage.setItem'))
  })

  it('the BUTTON reads disabled for it too, so it never looks live', () => {
    const sync = bodyWithoutComments(appShell, 'const syncRailToggle = (): void =>')
    expect(sync).toContain("app.classList.contains('rail-auto-collapsed')")
    expect(sync).toContain('railToggle.disabled = none || auto')
  })

  // `rail-auto-collapsed` landing on an ALREADY-collapsed rail does not change the fold, so the
  // observer's early return would skip the sync entirely and leave the button enabled.
  it('and the class observer syncs it FIRST, before its own early return', () => {
    const obs = bodyWithoutComments(appShell, 'new MutationObserver(')
    expect(obs).toContain('syncRailToggle()')
    expect(obs.indexOf('syncRailToggle()')).toBeLessThan(obs.indexOf('return'))
  })

  it('Ctrl+Shift+B asks the modal guard as well', () => {
    const chord = after(appShell, "e.key.toLowerCase() === 'b'")
    expect(chord).toContain('shortcutsBlocked(e.target)')
    expect(chord.indexOf('shortcutsBlocked')).toBeLessThan(chord.indexOf('toggleRail()'))
  })
})

// ── F013 ─────────────────────────────────────────────────────────────────────────────────────
describe('the danger confirm’s “Don’t ask again this session” key', () => {
  const key = after(agentConfig, 'rememberKey: `agentcfg:${setting.id}', 120)

  it('is keyed by the SCOPE the message claims the change is limited to', () => {
    expect(key).toContain('${targetKey(currentSnapshot.target)}')
  })

  it('and targetKey is the same scope identity the scope picker compares by', () => {
    // Not a second copy of the rule: the picker's selected-row test uses this exact function,
    // so a key built from it can never drift from what the user sees selected.
    expect(agentConfig).toContain('targetKey(entry.target) === targetKey(target)')
  })
})

// ── F020 ─────────────────────────────────────────────────────────────────────────────────────
describe('the dock budget and the rail’s 260ms fold', () => {
  const install = bodyOf(dockBudget, 'export function onDockLayoutChange')

  it('recomputes when the rail’s WIDTH transition ends', () => {
    const body = install.replace(/^\s*\/\/.*$/gm, '')
    expect(body).toContain("document.getElementById('rail')")
    expect(body).toContain("addEventListener('transitionend'")
    expect(body).toContain("e.propertyName === 'width'")
    expect(body).toContain('requestDockLayout()')
  })

  // Width only. `transitionend` fires per property, and the rail animates more than one —
  // recomputing on every one of them would put a layout read on each.
  it('and only for width', () => {
    const listener = after(dockBudget, "addEventListener('transitionend'", 160)
    expect(listener).toContain("propertyName === 'width'")
  })

  it('the recompute is the throttled door, not a direct budget read', () => {
    const listener = after(dockBudget, "addEventListener('transitionend'", 160)
    expect(listener).not.toContain('dockLayoutBudget()')
  })
})
