import { describe, expect, it } from 'vitest'
import { bodyWithoutComments, sourceOf } from './source-body'

// The New-terminals modal paints WHERE terminals go on a live workspace. Its correctness
// properties are about wiring — which apply path, which delivery, which guards — and both
// files touch the DOM, so they are asserted over source with anchors that fail loudly.

const controller = sourceOf('src/ui/features/workspace/controller.ts')
const modal = sourceOf('src/ui/features/workspace/new-terminal-modal.ts')
const css = sourceOf('src/ui/styles/global.css')

describe('the painted plan is applied as ONE relayout', () => {
  const body = bodyWithoutComments(controller, 'async createTerminalsFromSpec(')

  it('goes through applyRegions over the ONE resolved set', () => {
    expect(body).toMatch(/applyRegions\(plan\.spec, resolved\)/)
    expect(body.match(/\.resolveTemplate\(/g) ?? [], 'two resolutions can disagree').toHaveLength(1)
    // The added slots come off that same value, not off a second read.
    expect(body).toMatch(/resolved\.slots\.slice\(plan\.liveIds\.length\)/)
  })

  it('does NOT split panes one at a time', () => {
    // splitPane cannot express placement: it splits the focused pane along its longer
    // axis and refocuses the result, so a batch cascades off itself.
    expect(body).not.toMatch(/this\.splitPane\(/)
  })

  it('launches through the port, typed — never deliver:spawn', () => {
    // A spawn-armed request is emitted before the pane exists, and noteAgentLaunch cannot
    // resolve a slot for a pane the layout does not hold yet: the lineup would launch and
    // then silently fail to persist, so a restore would bring back plain shells.
    expect(body).toMatch(/requestAgentLaunch\(/)
    expect(body).not.toMatch(/deliver/)
  })

  it('refuses a plan whose locked prefix no longer NAMES the same terminals', () => {
    // A count check passes a simultaneous open+close while every locked tile has come to
    // mean a different terminal.
    expect(body, 'a count check is not a set check').not.toMatch(/paneIds\(\)\.length !== plan\.liveCount/)
    expect(body).toMatch(/lineupNow\.every\(\(id, i\) => id === plan\.liveIds\[i\]\)/)
  })

  it('takes its worktrees back out when the apply does not land', () => {
    expect(body).toMatch(/if \(out !== 'applied'\)/)
    const afterRefusal = body.slice(body.indexOf("if (out !== 'applied')"))
    expect(afterRefusal).toMatch(/rollbackWorktrees/)
  })

  it('settles every worktree job before judging any of them', () => {
    // A rollback that ran on the first rejection could not name the worktrees still
    // being created — the wizard's contract, and the reason this is Promise.all.
    expect(body).toMatch(/await Promise\.all\(/)
  })
})

describe('the seeded cwd survives the manifest scrub', () => {
  const body = bodyWithoutComments(controller, 'private applyResolvedLayout(')

  it('scrubs with the seed rather than clearing it', () => {
    // The scrub writes '' into paneCwds, which is exactly the override an isolated new
    // pane has to spawn in.
    expect(body).toMatch(/scrubManifestSlot\(a\.meta, local - 1, seedCwd\?\.\(local\) \?\? ''\)/)
  })
})

describe('the modal is the painter, not a pill strip', () => {
  it('locks the terminals that already exist', () => {
    expect(modal).toMatch(/lockedCount:/)
    expect(modal).toMatch(/createGridPainter\(/)
  })

  it('has dropped the strip that could not say WHERE anything went', () => {
    expect(modal).not.toMatch(/ntm-slot/)
  })

  it('shares the wizard palette rather than copying it', () => {
    expect(modal).toMatch(/createPlacementPalette\(/)
    expect(modal, 'a second copy of the chip markup').not.toMatch(/wizard-chip-menu/)
  })

  it('remembers the lineup but never the geometry or the command text', () => {
    expect(modal).toMatch(/mogging\.newTerminals\.last/)
    const write = bodyWithoutComments(modal, 'function writeLast(')
    expect(write).not.toMatch(/spec|rows|cols|customCmd/)
  })
})

describe('the modal re-seeds when the workspace changes under it', () => {
  it('is handed a re-resolver, and never reads the slots port itself', () => {
    expect(modal).toMatch(/subscribeLive\?:/)
    expect(modal, 'pane identity, order and headroom are the controller’s knowledge').not.toMatch(
      /onSlots\(|layout\.paneIds/
    )
  })

  it('disposes it on close, like the roster subscription', () => {
    expect(bodyWithoutComments(modal, 'onClose: () =>')).toMatch(/unsubLive\(\)/)
  })

  it('re-seeds the canvas and the tiles it stands for in the SAME breath', () => {
    // slotOfTile is keyed on live.length: a spec with fewer regions than the live set
    // reads as all-locked and silently drops open terminals off the canvas.
    const body = bodyWithoutComments(modal, 'const onLive =')
    expect(body.indexOf('live = next.live')).toBeLessThan(body.indexOf('painter.set(spec)'))
    expect(body, 'setBody replaces the subtree and does not re-enter focus').not.toMatch(/setBody/)
  })

  it('a pure re-publish changes nothing, and a reorder only relabels', () => {
    const body = bodyWithoutComments(modal, 'const onLive =')
    expect(body, 'the slots port republishes on every rebuild').toMatch(/beforeIds === afterIds/)
    // Same count, different order: relabel and KEEP the merges.
    expect(body).toMatch(/before\.length === live\.length/)
    expect(bodyWithoutComments(controller, 'private subscribeLivePanes(')).toMatch(
      /if \(signature === last\) return/
    )
  })

  it('the painter reads its ceilings as thunks, since both move', () => {
    expect(modal).toMatch(/maxPanes: \(\) =>/)
    expect(modal).toMatch(/lockedCount: \(\) =>/)
  })
})

describe('the shared control height reaches every host', () => {
  it('--wz-ctl is a :root token, not scoped to .wizard', () => {
    // Scoped to .wizard it was invalid at computed-value time everywhere else, and every
    // borrowed chip/select/stepper silently collapsed to `height: auto`.
    const root = css.slice(css.indexOf(':root'), css.indexOf('--page-max'))
    expect(root).toMatch(/--wz-ctl:\s*28px/)
    expect(css).not.toMatch(/\.wizard \{[^}]*--wz-ctl/)
  })

  it('no rule READS a radius token that was never defined', () => {
    // .ntm-slot did: `border-radius: var(--r-2)` — invalid at computed-value time, so
    // every slot tile rendered as a hard square beside a palette of pills.
    expect(css).not.toMatch(/var\(--r-2\b/)
    // …and the defined stops are still all there, so this can't pass by deleting them.
    for (const stop of ['--r-xs', '--r-sm', '--r-md', '--r-lg', '--r-full']) {
      expect(css, stop).toMatch(new RegExp(`${stop}:`))
    }
  })
})
