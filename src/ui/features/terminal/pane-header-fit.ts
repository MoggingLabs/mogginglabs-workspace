/**
 * THE BAR FITS — MEASURED, NEVER DERIVED.
 *
 * The pane header used to decide what to retire from hand-derived pixel thresholds
 * (`@container pane-bar (max-width: 820px)` and friends). That model budgeted the left
 * cluster and the action buttons — and never budgeted the branch chip at all. So the
 * grid, which hands the title's column its full `max-content` and expands the chip's
 * `1fr` column LAST, could squeeze that column to nothing while the chip's `flex: none`
 * children kept their width and painted straight over the ⋯/×/gauge. Measured on a live
 * 900px pane with every chip lit: the chip's box was 24px (its padding), its content
 * 370px — 346px of branch text rendered on top of the action cluster.
 *
 * No threshold can fix that, because the deficit depends on things width cannot see: how
 * long the agent's OSC title is, how long the branch name is, whether the MCP chip says
 * "mcp 3" or "restart +2". So the bar now MEASURES what it needs and gives up what it
 * cannot afford, in the order the header has always declared (global.css):
 *
 *   0. the title yields its EXCESS first — down to a soft floor (~18 characters). Free:
 *      the full name lives in the tooltip and the ⋯ menu. This is the common case, and
 *      the only one most panes ever reach.
 *   1. the gauge's "% used" text        (the disc keeps the color ramp + sweep)
 *   2. git worktree · 3. staged · 4. base comparison · 5. uncommitted count
 *   6. the expand trio
 *   7. mcp · 8. claims · 9. role · 10. remote
 *   11. the title comes down to its 6ch hard floor
 *   12. the branch chip — branch identity is the last thing the chip gives up
 *   13. the title, into the ⋯ menu    14. the gauge disc itself
 *
 * The four anchors (state glyph, agent mark, ⋯, ×) are never in the ladder. Everything
 * retired here is stated in full by the ⋯ menu, so a narrow pane relocates information
 * and never destroys it.
 *
 * The container rungs left in global.css (mcp 590, claims 525, role 470, remote 355,
 * trio 415, chip 225, title 200, disc 135) still stand UNDER this pass: below 200px the
 * bar switches to its compact form, the action cluster dissolves into the grid, and this
 * pass hands the row over to them (see the bail in fit()). They are a floor, not the
 * decision — and where the two disagree, this pass has measured and they have guessed.
 *
 * WHY THIS IS SAFE TO RUN ON EVERY RESIZE: one read pass (offsetWidth/scrollWidth on ~12
 * nodes), then one write pass, coalesced into a frame. The writes touch the header's
 * CHILDREN, never the header's own box, so the ResizeObserver cannot re-trigger itself.
 * Every number is intrinsic (scrollWidth for the title's full text, cached widths for
 * what is currently retired), so the verdict is a pure function of content + width — it
 * cannot oscillate between two states at a boundary.
 *
 * The clipping in global.css (`.pane-header`, `.pane-git`) is the BELT, not the fix: if
 * this pass is ever wrong, the bar clips like a normal box. It can never overlap again.
 */

/** The title's soft floor: ~18 characters of the bar's 18px face. Above this the name
 *  yields freely; below it the branch chip starts shedding detail instead, because a name
 *  clipped to "Review au…" tells you less than "4 uncommitted" does. */
const TITLE_SOFT_FLOOR = 160

export interface PaneHeaderFitHandle {
  /** Re-fit before the next paint (coalesced). Call whenever a header fact changes. */
  schedule(): void
  dispose(): void
}

export interface PaneHeaderFitParts {
  grid: HTMLElement
  left: HTMLElement
  title: HTMLElement
  git: HTMLElement
  branch: HTMLElement
  /** Retirement order — worktree, staged, base comparison, uncommitted count. */
  gitDetail: HTMLElement[]
  actions: HTMLElement
  ctx: HTMLElement
  ctxPct: HTMLElement
  expandBtns: HTMLElement[]
  /** Left-cluster chips, in retirement order — mcp, claims, role, remote. */
  leftChips: HTMLElement[]
}

const num = (value: string): number => {
  const n = parseFloat(value)
  return Number.isFinite(n) ? n : 0
}

export function createPaneHeaderFit(
  header: HTMLElement,
  parts: PaneHeaderFitParts
): PaneHeaderFitHandle {
  let frame = 0
  let disposed = false
  // Two TEXT widths (scrollWidth), not box widths — kept apart from `widths` for that
  // reason, and remembered for the same one: both read as zero the instant the thing they
  // live in leaves the layout, and a rung that reads as free gets restored into a row that
  // cannot hold it.
  let branchText = 0
  let titleText = 0
  // What a retired element WOULD cost to bring back. Measured while it was still on
  // screen (retirement always happens from a rendered state, so this is never a guess),
  // and refreshed every time it is rendered again.
  const widths = new WeakMap<Element, number>()

  /** What an element costs the row — and the four states it can be in, which is the whole
   *  difficulty here:
   *
   *    absent   it carries no data (`hidden`): not on the bar, and not ours to bring back.
   *    live     rendered: measure it, and remember the width.
   *    retired  WE took it (or the chip it lives in): it costs nothing now, but bringing
   *             it back costs what it last measured — a retired element has no layout box,
   *             so it must be remembered or it reads as free and gets restored into a row
   *             that cannot hold it. (This is exactly how the chip came back 23px too wide:
   *             once retired, its branch's scrollWidth read 0 and the chip "needed" 67px.)
   *    gone     a container rung took it (the trio below 415px, the chip below 225px). It
   *             costs nothing AND retiring it frees nothing — counting its cached width as
   *             a saving would be 105 phantom pixels of headroom.
   *
   *  getBoundingClientRect, NOT offsetWidth: the chip's leading glyph is an SVG, and
   *  offsetWidth is an HTMLElement property — on an SVGElement it is `undefined`, so the
   *  icon (20px) and its gap (6px) budgeted as zero. Rects also keep the sub-pixel widths
   *  this bar is really laid out on. */
  const widthOf = (el: Element, retiredByProxy = false): number => {
    if (el instanceof HTMLElement && el.hidden) return 0 // absent
    const w = el.getBoundingClientRect().width
    if (w > 0) {
      widths.set(el, w) // live
      return w
    }
    const ours = retiredByProxy || el.hasAttribute('data-retired')
    return ours ? (widths.get(el) ?? 0) : 0 // retired (remembered) vs gone (a rung took it)
  }

  // IDEMPOTENT, and that is load-bearing: a settled bar must write NOTHING. A write is a
  // layout invalidation, a layout invalidation re-fires the ResizeObserver, and the bar
  // then re-fits forever ("ResizeObserver loop completed with undelivered notifications",
  // measured — it burned a core and hung the renderer). It also means an open ⋯ menu is
  // not torn down by a resize: the menu closes on any header mutation (terminal-pane.ts),
  // and a bar that re-stamped its own attributes every frame would slam it shut.
  const retire = (el: HTMLElement, off: boolean): void => {
    if (off === el.hasAttribute('data-retired')) return
    if (off) el.setAttribute('data-retired', '')
    else el.removeAttribute('data-retired')
  }

  const retirable = (): HTMLElement[] => [
    parts.ctxPct,
    parts.git,
    parts.title,
    parts.ctx,
    ...parts.gitDetail,
    ...parts.expandBtns,
    ...parts.leftChips
  ]

  const clear = (): void => {
    for (const el of retirable()) el.removeAttribute('data-retired')
    parts.title.style.removeProperty('max-width')
  }

  const fit = (): void => {
    if (disposed || !header.isConnected) return
    const gridWidth = parts.grid.clientWidth
    const actionsStyle = getComputedStyle(parts.actions)
    // Below 200px the bar switches to its compact form: the action cluster dissolves into
    // the grid (display: contents) and the container ladder owns every rung. Nothing here
    // has a box to budget against, so hand the bar over intact.
    if (gridWidth === 0 || actionsStyle.display === 'contents') {
      clear()
      return
    }

    // ── read ────────────────────────────────────────────────────────────────────
    const gridGap = num(getComputedStyle(parts.grid).columnGap)
    const actionsGap = num(actionsStyle.columnGap)
    const leftGap = num(getComputedStyle(parts.left).columnGap)
    const chipStyle = getComputedStyle(parts.git)
    const chipGap = num(chipStyle.columnGap)
    const chipPad = num(chipStyle.paddingLeft) + num(chipStyle.paddingRight)
    const ctxGap = num(getComputedStyle(parts.ctx).columnGap)
    const titleHardFloor = num(getComputedStyle(parts.title).minWidth)

    // The chip's need, from its PARTS rather than its box — the box is exactly what the
    // grid has already starved. The branch is the one shrinkable child, so its need is
    // its full text (scrollWidth), capped by the 28ch ellipsis budget it renders under.
    const branchStyle = getComputedStyle(parts.branch)
    const branchMax = branchStyle.maxWidth === 'none' ? Infinity : num(branchStyle.maxWidth)
    // The chip is OURS to bring back only if we are the reason it is gone; if a container
    // rung retired it, it costs nothing and frees nothing.
    const chipRetired = parts.git.hasAttribute('data-retired')
    const chipGone = !chipRetired && parts.git.getBoundingClientRect().width === 0
    const chipEligible = parts.git.classList.contains('has-git') && !chipGone
    let chipNeed = 0
    if (chipEligible) {
      // The branch is the chip's one shrinkable child, so what it NEEDS is its whole name
      // — and scrollWidth reads 0 the moment the chip is retired, so remember it.
      const liveBranch = parts.branch.scrollWidth
      if (liveBranch > 0) branchText = liveBranch
      const branchNeed = branchText > 0 ? Math.min(branchText + 1, branchMax) : 0
      let shown = 0
      for (const child of Array.from(parts.git.children)) {
        const w = child === parts.branch ? branchNeed : widthOf(child, chipRetired)
        if (w <= 0) continue
        chipNeed += w
        shown += 1
      }
      if (shown > 0) chipNeed += chipPad + chipGap * (shown - 1)
    }

    // EVERY term below is the bar AT FULL DRESS — what it would render if this pass
    // retired nothing. That is the only sound basis for the walk, because the walk decides
    // retirement from scratch each time: measuring the row as it currently stands would
    // price a restore at zero (the thing is not on screen to be measured) and the bar would
    // "discover" it fits, restore it, and be overfull by exactly what it forgot.
    const titleRetired = parts.title.hasAttribute('data-retired')
    const liveTitle = parts.title.scrollWidth
    if (liveTitle > 0) titleText = liveTitle
    const titleWant = titleText

    // The left cluster without its title box, plus back whatever WE took out of it.
    let leftRigid = parts.left.scrollWidth - parts.title.clientWidth
    for (const chip of parts.leftChips) {
      if (chip.hasAttribute('data-retired')) leftRigid += widthOf(chip) + leftGap
    }
    // A rendered title's own gap is already inside that scrollWidth; a retired one took its
    // gap with it, so restoring the name costs the gap too.
    const titleGap = titleRetired ? leftGap : 0

    // Same story on the right: add back the gauge text, the trio and the gauge itself if
    // this pass is the reason they are not there.
    const pctCost = widthOf(parts.ctxPct) > 0 ? widthOf(parts.ctxPct) + ctxGap : 0
    let trioCost = 0
    for (const b of parts.expandBtns) {
      const w = widthOf(b)
      if (w > 0) trioCost += w + actionsGap
    }
    // The gauge is only ever retired AFTER its "% used" text (rung 1 precedes rung 14), so
    // what a retired gauge remembers is its bare disc — and the text is priced separately,
    // by its own rung. The two never double-count.
    const gaugeRetired = parts.ctx.hasAttribute('data-retired')
    const gaugeCost = widthOf(parts.ctx) > 0 ? widthOf(parts.ctx) + actionsGap : 0
    const actionsFull =
      parts.actions.getBoundingClientRect().width +
      (parts.ctxPct.hasAttribute('data-retired') ? pctCost : 0) +
      (parts.expandBtns.some((b) => b.hasAttribute('data-retired')) ? trioCost : 0) +
      (gaugeRetired ? gaugeCost : 0)

    // ── decide ──────────────────────────────────────────────────────────────────
    // SLOP: scrollWidth/clientWidth are integers while this bar lays out on sub-pixels.
    // Two pixels of headroom keeps a rounding error from becoming a one-pixel clip.
    let deficit =
      leftRigid + titleWant + titleGap + chipNeed + actionsFull + 2 * gridGap + 2 - gridWidth
    let titleMax = titleWant

    // 0. The name gives up its EXCESS before anything is taken off the bar — it ellipsises
    //    down to ~18 characters and nothing else moves. This is the rung that fixes the
    //    common case, and the only one most panes ever reach.
    if (deficit > 0 && titleWant > 0) {
      const give = Math.max(0, titleWant - Math.max(TITLE_SOFT_FLOOR, titleHardFloor))
      const taken = Math.min(deficit, give)
      titleMax -= taken
      deficit -= taken
    }

    // 1‥10. Then the ladder, least-identifying first. Each rung frees its own width plus
    // the gap it takes with it — and a rung a container query already took frees NOTHING
    // (widthOf reports it `gone`), so the arithmetic never spends the same pixels twice.
    const retirePct = deficit > 0 && pctCost > 0
    if (retirePct) deficit -= pctCost

    const retiredDetail = new Set<HTMLElement>()
    for (const detail of parts.gitDetail) {
      if (deficit <= 0) break
      const w = widthOf(detail, chipRetired)
      if (w <= 0) continue
      retiredDetail.add(detail)
      chipNeed -= w + chipGap
      deficit -= w + chipGap
    }

    const retireTrio = deficit > 0 && trioCost > 0
    if (retireTrio) deficit -= trioCost

    // 7‥10. The left cluster's chips — mcp, claims, role, remote — in that order. Their
    // widths are content, not geometry ("restart +2" is 48px wider than "mcp 3"), which is
    // exactly why a width query was never able to price them.
    const retiredChips = new Set<HTMLElement>()
    for (const chip of parts.leftChips) {
      if (deficit <= 0) break
      const w = widthOf(chip)
      if (w <= 0) continue
      retiredChips.add(chip)
      deficit -= w + leftGap
    }

    // 11. The name comes down to its 6ch hard floor — still ellipsis, still never a clip.
    if (deficit > 0 && titleWant > 0) {
      const give = Math.max(0, titleMax - titleHardFloor)
      const taken = Math.min(deficit, give)
      titleMax -= taken
      deficit -= taken
    }

    // 12. Branch identity is the chip's last stand — when even that will not fit, the whole
    //     chip goes rather than clipping "ma…" into the gauge. The chip yields BEFORE the
    //     name: that is the order the shipped rungs have always encoded (the chip's own
    //     container rung fires at 225px, the name's at 200px), and it is the order a pane
    //     wants — a terminal you cannot name is worth less than a branch you can read in ⋯.
    const retireChip = deficit > 0 && chipEligible && chipNeed > 0
    if (retireChip) deficit -= chipNeed

    // 13. The name itself. If the row cannot hold six characters beside the four anchors,
    //     it goes to the ⋯ menu whole rather than having its box cut off mid-glyph — which
    //     is what the guessed 200px rung actually did: measured, a lit gauge moves that
    //     threshold to ~237px, and between the two the title was clipped by 33px.
    const retireTitle = deficit > 0 && titleWant > 0 && titleMax <= titleHardFloor
    if (retireTitle) deficit -= titleMax + leftGap

    // 13. The gauge disc outlives everything above it — the arc never lies, and 16px is the
    //     cheapest signal on the bar. Below even that, only the four anchors remain.
    const discCost = widthOf(parts.ctx) > 0 ? widthOf(parts.ctx) + actionsGap : 0
    const retireGauge = deficit > 0 && discCost > 0
    if (retireGauge) deficit -= discCost

    // ── write ───────────────────────────────────────────────────────────────────
    retire(parts.ctxPct, retirePct)
    for (const detail of parts.gitDetail) retire(detail, retiredDetail.has(detail))
    for (const b of parts.expandBtns) retire(b, retireTrio)
    for (const chip of parts.leftChips) retire(chip, retiredChips.has(chip))
    retire(parts.title, retireTitle)
    retire(parts.git, retireChip)
    retire(parts.ctx, retireGauge)
    const cap = titleMax >= titleWant || titleWant === 0 ? '' : `${Math.round(titleMax)}px`
    if (parts.title.style.maxWidth !== cap) parts.title.style.maxWidth = cap
  }

  const schedule = (): void => {
    if (disposed || frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      fit()
    })
  }

  // The pane's width is the only thing the header cannot be told about — everything else
  // that moves this row (a new title, a git push, an MCP chip changing its wording) calls
  // schedule() itself. So this listens for a WIDTH CHANGE and nothing else: a notification
  // that reports the width we already fitted is our own layout coming back to us, and
  // acting on it is how an observer loop starts.
  let fittedWidth = -1
  const observer = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect.width ?? header.clientWidth
    if (Math.abs(width - fittedWidth) < 0.5) return
    fittedWidth = width
    schedule()
  })
  observer.observe(header)
  // A late webfont swap changes every width in the bar and fires no resize.
  void document.fonts?.ready.then(schedule).catch(() => undefined)
  schedule()

  return {
    schedule,
    dispose(): void {
      disposed = true
      if (frame) cancelAnimationFrame(frame)
      frame = 0
      observer.disconnect()
    }
  }
}
