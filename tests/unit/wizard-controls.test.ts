import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Two wizard defects that are about WIRING, not about a decision — so there is no pure
// function to extract and the property is asserted over the source. src/ui is renderer code:
// tests/unit is Electron-free and has no DOM.

const src = readFileSync(resolve(import.meta.dirname, '../../src/ui/features/wizard/index.ts'), 'utf8')

describe('changing the grid repaints the agent controls', () => {
  // `painter.set()` does NOT fire the painter's onChange, so nothing else repaints the palette.
  // `refreshAgents()` only moves the meter — the Shell chip's "x N" and the palette's
  // "Fill N empty" label are rendered by renderPalette, which only renderAgentControls() calls.
  //
  // The second site is the one that matters most: wizardLayout.setGrid is the path the
  // WIZLAYOUT gate drives, so a gate was exercising this bug and reporting green.
  // A fixed window after each call, not a lazy brace match — the two sites end differently
  // (one closes the handler, one returns paneCount) and a lazy match clipped one of them.
  // Comments are stripped before matching: the code at these sites is commented with the very
  // words being asserted, and a test that its own explanation can satisfy proves nothing.
  const afterSet = [...src.matchAll(/painter\.set\(gridSpec\)/g)].map((m) =>
    src
      .slice(m.index + 'painter.set(gridSpec)'.length, m.index + 600)
      .replace(/^\s*\/\/.*$/gm, '')
  )

  it('finds both call sites', () => {
    // Three, not two: the audit named the Reset-grid handler and wizardLayout.setGrid; applying
    // a PRESET is a third site with the same defect.
    expect(afterSet.length, 'painter.set(gridSpec) call sites').toBe(3)
  })

  it('each one calls renderAgentControls', () => {
    for (const [i, block] of afterSet.entries()) {
      expect(block, `painter.set site #${i} must repaint the palette`).toContain('renderAgentControls()')
    }
  })

  it('none of them settles for refreshAgents alone', () => {
    for (const [i, block] of afterSet.entries()) {
      expect(block, `painter.set site #${i} must not stop at the meter`).not.toMatch(/^\s*refreshAgents\(\)/m)
    }
  })
})

describe('a failed preset write says so', () => {
  // Every neighbouring wizard IPC call catches; these two did not. wizard.client.ts is a bare
  // `getBridge().invoke`, so nothing absorbed the rejection: no card appeared, no error was
  // shown, and an unhandled rejection fired. The user pressed Save and the app did nothing it
  // could account for.
  const chain = (method: string): string => {
    const at = src.indexOf(`.${method}(`)
    expect(at, `${method} call not found`).toBeGreaterThan(-1)
    return src.slice(at, at + 700)
  }

  for (const method of ['savePreset', 'removePreset']) {
    it(`${method} handles rejection`, () => {
      expect(chain(method)).toMatch(/\.catch\(/)
    })

    it(`${method} surfaces the reason rather than swallowing it`, () => {
      // `.catch(() => undefined)` is fine for a background refresh; it is not fine for an
      // action the user just took and is waiting on.
      const body = chain(method)
      expect(body).toContain('presetError =')
      expect(body).not.toMatch(/\.catch\(\(\) => undefined\)/)
    })
  }

  it('renderPresets shows the error, as an alert, and clears it', () => {
    const at = src.indexOf('function renderPresets(): void {')
    expect(at).toBeGreaterThan(-1)
    const body = src.slice(at, at + 600)
    expect(body).toContain('presetError')
    expect(body, 'a failure the screen reader never hears is not reported').toContain("role: 'alert'")
    expect(body, 'a stale error must not outlive the next render').toMatch(/presetError = ''/)
  })
})

describe('a successful launch releases what the wizard held', () => {
  // `leave()` did teardown AND navigation. After a successful launch the opener has already
  // switched the app to the live grid, so `if (activeView() === 'wizard') leave()` was false on
  // every success and NONE of the teardown ran: one generation of selection subscribers,
  // cd-line timers and setup-panel AgentChannels subscriptions leaked per launch, on detached
  // DOM, with `launching` stuck true.
  //
  // The chain that makes the guard false is synchronous inside the awaited call — open-service
  // -> controller.openFromTemplate -> create -> switch -> setActiveView('grid') — so this is
  // not a race, it never ran.
  const launchTail = (() => {
    const at = src.indexOf('// The workspace opener switches the app to the live grid')
    expect(at, 'the launch tail moved — re-anchor rather than delete').toBeGreaterThan(-1)
    return src.slice(at, at + 400).replace(/^\s*\/\/.*$/gm, '')
  })()

  it('tears down unconditionally', () => {
    expect(launchTail).toMatch(/^\s*disposeWizard\(\)/m)
  })

  it('leaves only the NAVIGATION conditional', () => {
    expect(launchTail).toMatch(/if \(activeView\(\) === 'wizard'\) goBack\(\)/)
    expect(launchTail, 'the guard must not gate the teardown again').not.toMatch(
      /if \(activeView\(\) === 'wizard'\) leave\(\)/
    )
  })

  it('disposeWizard releases every handle, and leave() still navigates', () => {
    const at = src.indexOf('function disposeWizard(): void {')
    expect(at, 'disposeWizard not found').toBeGreaterThan(-1)
    const body = src.slice(at, src.indexOf('function leave(): void {', at))
    for (const held of ['openGeneration++', 'selection?.dispose()', 'cdLine?.dispose()', 'setupPanels.splice(0)', 'launching = false']) {
      expect(body, `${held} must move with the teardown`).toContain(held)
    }
    expect(body, 'navigation is leave()’s job, not the teardown’s').not.toContain('goBack()')
    expect(src.slice(src.indexOf('function leave(): void {'), src.indexOf('function leave(): void {') + 120)).toContain(
      'goBack()'
    )
  })
})
