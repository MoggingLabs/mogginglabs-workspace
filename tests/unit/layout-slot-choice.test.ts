import { describe, expect, it } from 'vitest'
import { computeLayout, leafIds, splitLine, treeForGrid } from '@ui/features/layout/layout-tree'
import { orderLiveSlots } from '@ui/features/layout/slot-selection'
import { bodyWithoutComments, sourceOf } from './source-body'

// The RULE for choosing slots is pure and tested in slot-selection.test.ts. What cannot be
// imported is the WIRING: grid-layout.ts renders the DOM and controller.ts owns GridLayout,
// so the properties that keep the rule connected to live state are asserted over source.

const gridLayout = sourceOf('src/ui/features/layout/grid-layout.ts')
const controller = sourceOf('src/ui/features/workspace/controller.ts')

describe('templateLocals defers to the tested rule', () => {
  const body = bodyWithoutComments(gridLayout, 'private templateLocals(')

  it('calls selectLayoutSlots', () => {
    expect(body).toMatch(/selectLayoutSlots\(/)
  })

  it('hands it the CURRENT geometry — position ordering is the whole point', () => {
    expect(body).toMatch(/rects: this\.leafRects/)
  })

  it('no longer walks the slot numbers itself', () => {
    // The ascending "live OR free" walk is the defect: it took a free hole ahead of a
    // live slot and killed a running terminal on a reshape that opened nothing.
    expect(body).not.toMatch(/for \(let local = 1/)
  })

  it('treats a detached leaf as taken — its pane moved out and kept its id', () => {
    expect(body).toMatch(/!this\.detached\.has\(local\)/)
  })
})

describe('tree order is not reading order', () => {
  // Split pane 1 to the right, then split pane 1 downward: h[ v[1,3], 2 ]. `leafIds` walks
  // depth-first and yields 1,3,2; the screen reads 1,2,3. Any surface that LABELS tiles
  // from paneIds() and LANDS them through templateLocals names the wrong terminals — which
  // is exactly what the New-terminals painter's locked prefix did.
  const nested = splitLine(treeForGrid([1, 2], 2), 1, 3, 'v')
  const rects = computeLayout(nested, { x: 0, y: 0, w: 1200, h: 800 }, 4).leaves

  it('they genuinely diverge — the fix is not guarding a hypothetical', () => {
    expect(leafIds(nested)).toEqual([1, 3, 2])
    expect(orderLiveSlots(leafIds(nested), rects)).toEqual([1, 2, 3])
  })

  it('reading order really is what the rects say', () => {
    const byReading = orderLiveSlots(leafIds(nested), rects).map((id) => rects.get(id)!)
    // Pane 2 is the whole right column, so it starts to the right of 1 and above 3.
    expect(byReading[0]!.x).toBeLessThan(byReading[1]!.x)
    expect(byReading[1]!.y).toBeLessThan(byReading[2]!.y)
  })
})

describe('the painter labels its locked tiles in the order it draws them', () => {
  const body = bodyWithoutComments(controller, 'private livePaneTiles(')

  it('reads liveOrder(), not paneIds()', () => {
    expect(body).toMatch(/liveOrder\(\)/)
    expect(body, 'paneIds() is tree order — see the divergence above').not.toMatch(/paneIds\(\)/)
  })

  it('liveOrder defers to the tested ordering rule', () => {
    expect(bodyWithoutComments(gridLayout, 'liveOrder(): PaneId[]')).toMatch(/orderLiveSlots\(/)
  })
})

describe('the reorganize door', () => {
  const body = bodyWithoutComments(controller, 'openReorganize(): void')

  it('never opens seeded below the panes the workspace already runs', () => {
    expect(body).toMatch(/Math\.max\(view\.layout\.paneCount/)
  })

  it('takes the count and the shape from ONE number', () => {
    expect(body).toMatch(/specForCount\(seed/)
    expect(body).toMatch(/TEMPLATES\[seed\]/)
    expect(body, 'shape from the unclamped count').not.toMatch(/TEMPLATES\[view\.layout\.paneCount\]/)
  })
})

describe('the plan cap is enforced at the layout doors, not just at split', () => {
  // panes-layout/F2: templateLocals clamps to the GRID's budget (limit()) and knows nothing
  // about the entitlement, so the palette's "Layout: 16 panes" row, the control API and the
  // dev handle all reached a 16-pane grid on a plan that allows 4.
  it.each([['async requestApplyTemplate('], ['async requestReorganize(']])('%s refuses over the cap', (door) => {
    const body = bodyWithoutComments(controller, door)
    expect(body).toMatch(/effectiveMaxPanes\(view\)/)
    expect(body).toMatch(/refusePaneCap\(view, plan\)/)
    // Floored at the current count: rearranging what already exists allocates nothing.
    expect(body).toMatch(/Math\.max\(view\.layout\.paneCount, plan\)/)
  })

  it('the palette rows grey themselves rather than toasting an apology', () => {
    const index = sourceOf('src/ui/features/workspace/index.ts')
    const rows = index.slice(index.indexOf('TEMPLATE_COUNTS.map('))
    expect(rows).toMatch(/enabled: \(ctx: CommandContext\)/)
    expect(rows).toMatch(/requiresGrid\(ctx\)/)
    expect(rows).toMatch(/layoutCeiling\(\)/)
  })

  it('layoutCeiling stays lean — the palette calls it per keystroke, per row', () => {
    // layoutStatus() walks every pane through the liveness ports; this must not.
    expect(bodyWithoutComments(controller, 'layoutCeiling(): number | null')).not.toMatch(/inspectLive|layoutStatus/)
  })
})

// THE MOVE DOOR CHARGED THE MACHINE TWICE FOR ONE PANE.
//
// `GridLayout.capacity()` derives the destination's headroom as
// `livePaneCount() - this.paneIds().length` — panes running ELSEWHERE. At a move door the pane
// being moved is still live in the SOURCE, so it is inside that term; charging the destination
// for it as well made the refusal reduce to `totalLivePanes >= machineBudget`. Once the machine
// budget was reached, EVERY cross-workspace move was refused and the picker rendered every row
// "Full" — for an operation that neither creates nor destroys a terminal. The inner `adoptPane`
// gate never had the bug, because it runs AFTER `detachPane`, when the count is already one
// lower: two gates on one door, and only the outer one was wrong.
//
// The ARITHMETIC is pinned in pane-capacity.test.ts. This is the WIRING — that the discount
// actually reaches both doors, and reaches them with the same value, since a picker that offers
// a move this door then refuses is the same bug wearing a different face.
describe('a move is charged once, not twice', () => {
  it('capacity() and limit() carry the discount down to the machine term', () => {
    const capacity = bodyWithoutComments(gridLayout, 'capacity(discountElsewhere = 0): PaneCapacity')
    expect(capacity).toMatch(/livePaneCount\(\) - this\.paneIds\(\)\.length - Math\.max\(0, discountElsewhere\)/)
    // Clamped at both ends: a negative discount must not INFLATE the elsewhere term, and the
    // term itself must not go below zero.
    expect(capacity).toMatch(/Math\.max\(0, livePaneCount\(\)/)
    expect(bodyWithoutComments(gridLayout, 'limit(discountElsewhere = 0): number')).toMatch(
      /this\.capacity\(discountElsewhere\)\.maxPanes/
    )
    expect(bodyWithoutComments(controller, 'private effectiveMaxPanes(')).toMatch(
      /view\.layout\.limit\(discountElsewhere\)/
    )
  })

  it.each([
    ['the picker', 'moveTargets(paneId: number): MoveTarget[]'],
    ['the move itself', 'movePaneToWorkspace(paneId: number, dstId: string): boolean']
  ])('%s discounts the mover', (_name, signature) => {
    const body = bodyWithoutComments(controller, signature)
    const at = body.search(/effectiveMaxPanes\(/)
    expect(at, `${signature} no longer gates on the effective cap`).toBeGreaterThan(-1)
    expect(body.slice(at)).toMatch(/^effectiveMaxPanes\((?:v|dst), 1\)/)
  })

  it('the doors are the ONLY discounted callers — nothing else creates a free pane', () => {
    // A split, a template apply, a reorganize all CREATE a terminal; discounting there would
    // hand the machine one pane more than it budgeted for, at every workspace.
    expect(controller.match(/effectiveMaxPanes\([^)]*,\s*1\)/g)).toHaveLength(2)
  })
})

// A WORKSPACE CLOSED MID-DRAG LEFT THE DRAG RUNNING.
//
// dispose() cleared seamPersistTimer and left two siblings alive: the pulse timers (a mid-swell
// 1400 ms timer holding the detached slot AND this GridLayout), and the in-flight drag's window
// mousemove/mouseup listeners, which are removed only by their own `up`. Close a workspace while
// the user holds a seam (a close-pane control command will do it) and the listeners leaked,
// `body.resizing` latched forever, and the leaked mouseup could re-publish slots into a DETACHED
// grid — reviving pane ids, and their PTYs, that nobody can see.
describe('dispose leaves nothing running', () => {
  const body = bodyWithoutComments(gridLayout, '  dispose(): void')

  it('aborts an in-flight drag and clears the pulse timers, not just the seam timer', () => {
    expect(body).toMatch(/this\.seamPersistTimer/)
    expect(body).toMatch(/this\.activeDragCleanup\?\.\(\)/)
    expect(body).toMatch(/this\.pulseTimers\.clear\(\)/)
    expect(body).toMatch(/clearTimeout\(t\)/)
  })

  it('BOTH drags register the cleanup — a seam drag and a pane drag leak identically', () => {
    for (const signature of ['private startGutterDrag(', 'private wirePaneDrag(): void']) {
      const drag = bodyWithoutComments(gridLayout, signature)
      expect(drag, `${signature} must publish its teardown`).toMatch(/this\.activeDragCleanup = teardown/)
      // The teardown NULLS the field, so a drag that ended normally leaves dispose nothing to
      // call — otherwise dispose would re-run a stale teardown against the next drag's state.
      expect(drag).toMatch(/this\.activeDragCleanup = null/)
    }
  })

  it('a drop is applied only by a drag that ended on its own', () => {
    // dispose() nulls the field rather than calling `up`, so the aborted drag's zone is never
    // resolved — the detached grid must not re-publish slots.
    const drag = bodyWithoutComments(gridLayout, 'private wirePaneDrag(): void')
    expect(drag).toMatch(/if \(wasActive && zone\) this\.applyDrop\(/)
  })
})

describe('the manifest records what landed', () => {
  const body = bodyWithoutComments(controller, 'private applyResolvedLayout(')

  it('reads the pane count back off the layout, not off the request', () => {
    // templateLocals can return fewer slots than asked when the id space runs out; a
    // manifest claiming the larger count makes parseTree reject the whole tree on restore.
    expect(body).toMatch(/a\.meta\.paneCount = a\.layout\.paneCount/)
  })
})
