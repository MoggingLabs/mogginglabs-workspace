import { BOARD_LANES, BOARD_PRIORITIES, type BoardCard, type BoardLane, type BoardPriority } from '@contracts'
import {
  Button,
  CountBadge,
  EmptyState,
  closeContextMenu,
  el,
  icon,
  openContextMenu
} from '../../components'
import { cardEl, cardMenuItems, LANE_LABELS, type CardContext } from './card'
import type { BoardModel } from './model'

/**
 * The board's render pipeline. render() is a teardown (replaceChildren + full
 * rebuild) that runs on every EXTERNAL push — link status, attention, approval,
 * cwd, roster, a board:changed — so it must put back what a rebuild destroys
 * (finding 37): which lane was scrolled where, which control held focus (and
 * the filter's caret), and it must close a menu anchored to a card it is about
 * to destroy. Capture-and-restore, NOT reconciliation — and it no-ops silently
 * when the target is gone.
 */

export interface BoardFilter {
  text: string
  priority: BoardPriority | null
}

export const filterMatches = (f: BoardFilter, card: BoardCard): boolean => {
  if (f.priority && card.priority !== f.priority) return false
  const q = f.text.trim().toLowerCase()
  if (!q) return true
  return (
    card.title.toLowerCase().includes(q) ||
    card.notes.toLowerCase().includes(q) ||
    card.labels.some((l) => l.toLowerCase().includes(q))
  )
}

export interface BoardViewDeps {
  model: BoardModel
  cardContext(): CardContext
  filter: BoardFilter
  onFilterChange(): void
  addCard(lane: BoardLane): void
  openBoardMenu(trigger: HTMLElement): void
  /** Extra head chips (queue state, repo ref) — rendered after the sub line. */
  headExtras(): (HTMLElement | null)[]
}

const PRIORITY_FILTER_LABELS: Record<BoardPriority, string> = {
  urgent: 'Urgent',
  high: 'High',
  normal: 'Normal',
  low: 'Low'
}

export interface BoardView {
  root: HTMLElement
  render(): void
  /** True while a board context menu is open (menu bookkeeping for ⋯ toggling). */
  menuOpenFor(): string | null
}

export function createBoardView(deps: BoardViewDeps): BoardView {
  const { model, filter } = deps
  const root = el('div', {})
  root.id = 'view-board'

  /** Which card's menu is up, and the ⋯ it hangs from. null = no board menu open. */
  let openMenu: { cardId: string; trigger: HTMLElement } | null = null
  /** The ⋯ whose OWN pointerdown just dismissed its menu (capture-order dance —
   *  see the mount-scoped listener below). Time-boxed so an abandoned press
   *  cannot swallow a later keyboard Enter. */
  let dismissed: { cardId: string; at: number } | null = null
  document.addEventListener(
    'pointerdown',
    (e) => {
      // Registered ONCE, at mount — BEFORE any menu's own outside-close among
      // capture listeners, which is the point: this is the last moment the
      // menu being closed is still observably open.
      const trigger = e.target instanceof Element ? e.target.closest<HTMLElement>('.board-card-more') : null
      const cardId = trigger?.closest<HTMLElement>('.board-card')?.dataset.cardId ?? null
      dismissed = cardId && cardId === openMenu?.cardId ? { cardId, at: performance.now() } : null
    },
    true
  )
  // The primitive returns focus to the ⋯ on every exit path; focus landing back
  // on it means "the menu is gone" — the close hook ContextMenuHandle doesn't
  // expose, and what keeps aria-expanded honest. Delegated: cards rebuild.
  root.addEventListener('focusin', (e) => {
    const t = e.target instanceof Element ? e.target.closest<HTMLElement>('.board-card-more') : null
    if (!t) return
    if (openMenu?.trigger === t) openMenu = null
    t.setAttribute('aria-expanded', 'false')
  })

  function showCardMenu(card: BoardCard, trigger: HTMLElement): void {
    const r = trigger.getBoundingClientRect()
    openContextMenu({
      items: cardMenuItems(card, deps.cardContext()),
      // Hangs down-left from the ⋯ (200 is .ctx-menu's min-width); the primitive
      // clamps into the viewport, which keeps the lane scroller from clipping it.
      x: r.right - 200,
      y: r.bottom + 4,
      returnFocus: trigger,
      ariaLabel: `Actions for ${card.title || 'card'}`
    })
    // AFTER, never before: openContextMenu() evicts any open menu, and that
    // eviction returns focus to the OLD trigger — whose focusin handler clears
    // `openMenu`. Claim the slot only once the eviction has run.
    openMenu = { cardId: card.id, trigger }
    trigger.setAttribute('aria-expanded', 'true')
  }

  function onMenuClick(card: BoardCard, trigger: HTMLElement): void {
    const swallow = dismissed?.cardId === card.id && performance.now() - dismissed.at < 500
    dismissed = null
    if (swallow) return // this click's own pointerdown already closed it: ⋯ toggles
    showCardMenu(card, trigger)
  }

  // ── capture/restore (finding 37) ──────────────────────────────────────────
  const FOCUSABLE = [
    { key: 'more', sel: '.board-card-more', scope: 'card' },
    { key: 'attention', sel: '.board-chip-attention', scope: 'card' },
    { key: 'add', sel: '.board-add', scope: 'lane' },
    { key: 'empty-add', sel: '.empty-state button', scope: 'lane' },
    { key: 'filter', sel: '.board-filter-input', scope: 'board' },
    { key: 'switcher', sel: '.board-switcher', scope: 'board' },
    { key: 'board-menu', sel: '.board-head-menu', scope: 'board' }
  ] as const
  type FocusMark = { key: string; cardId: string | null; lane: string | null; sel: [number, number] | null }

  function captureFocus(): FocusMark | null {
    const a = document.activeElement
    if (!(a instanceof HTMLElement) || !root.contains(a)) return null
    for (const f of FOCUSABLE) {
      const hit = a.closest<HTMLElement>(f.sel)
      if (!hit) continue
      const sel =
        hit instanceof HTMLInputElement && f.key === 'filter'
          ? ([hit.selectionStart ?? 0, hit.selectionEnd ?? 0] as [number, number])
          : null
      return {
        key: f.key,
        cardId: hit.closest<HTMLElement>('.board-card')?.dataset.cardId ?? null,
        lane: hit.closest<HTMLElement>('.board-lane')?.dataset.lane ?? null,
        sel
      }
    }
    return null
  }

  function restoreFocus(mark: FocusMark | null): void {
    if (!mark) return
    const f = FOCUSABLE.find((x) => x.key === mark.key)
    if (!f) return
    // Re-find by IDENTITY, not position: a card that moved lanes keeps its id.
    // A deleted target resolves to nothing and focus goes nowhere — yanking the
    // caret to a neighbour is worse than leaving it where the browser put it.
    const scope =
      f.scope === 'card' && mark.cardId
        ? root.querySelector<HTMLElement>(`.board-card[data-card-id="${CSS.escape(mark.cardId)}"]`)
        : f.scope === 'lane' && mark.lane
          ? root.querySelector<HTMLElement>(`.board-lane[data-lane="${CSS.escape(mark.lane)}"]`)
          : root
    const target = scope?.querySelector<HTMLElement>(f.sel)
    // preventScroll is LOAD-BEARING: the control lives inside the scroller
    // restoreScroll() has just repaired — focus() must not undo that repair.
    target?.focus({ preventScroll: true })
    if (mark.sel && target instanceof HTMLInputElement) {
      try {
        target.setSelectionRange(mark.sel[0], mark.sel[1])
      } catch {
        /* non-text state */
      }
    }
  }

  function captureScroll(): Map<string, number> {
    const tops = new Map<string, number>()
    for (const list of root.querySelectorAll<HTMLElement>('.board-lane-cards')) {
      const lane = list.closest<HTMLElement>('.board-lane')?.dataset.lane
      if (lane) tops.set(lane, list.scrollTop)
    }
    return tops
  }

  function restoreScroll(tops: Map<string, number>): void {
    for (const list of root.querySelectorAll<HTMLElement>('.board-lane-cards')) {
      const lane = list.closest<HTMLElement>('.board-lane')?.dataset.lane
      const top = lane ? tops.get(lane) : undefined
      if (top) list.scrollTop = top // the browser clamps a shrunken lane for us
    }
  }

  // ── drag + drop with a real insertion point ───────────────────────────────
  let dropMark: { el: HTMLElement; before: boolean } | null = null
  const clearDropMark = (): void => {
    dropMark?.el.classList.remove('drop-before', 'drop-after')
    dropMark = null
  }

  function wireCardDnd(host: HTMLElement, card: BoardCard): void {
    host.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('text/mogging-card', card.id)
      host.classList.add('dragging')
    })
    host.addEventListener('dragend', () => {
      host.classList.remove('dragging')
      clearDropMark()
    })
    host.addEventListener('dragover', (e) => {
      e.preventDefault()
      e.stopPropagation() // the card owns this spot; the lane must not double-highlight
      const r = host.getBoundingClientRect()
      const before = e.clientY < r.top + r.height / 2
      if (dropMark?.el !== host || dropMark.before !== before) {
        clearDropMark()
        host.classList.add(before ? 'drop-before' : 'drop-after')
        dropMark = { el: host, before }
      }
    })
    host.addEventListener('drop', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const before = dropMark?.el === host ? dropMark.before : true
      clearDropMark()
      const id = e.dataTransfer?.getData('text/mogging-card')
      const dragged = id ? model.findCard(id) : undefined
      if (!dragged || dragged.id === card.id) return
      const siblings = model.cardsInLane(card.lane).filter((c) => c.id !== dragged.id)
      const at = siblings.findIndex((c) => c.id === card.id)
      const beforeId = before ? card.id : at >= 0 && at < siblings.length - 1 ? siblings[at + 1].id : null
      model.reorderCard(dragged, card.lane, beforeId)
    })
  }

  // ── the head: identity, switcher, filter, extras ──────────────────────────
  function switcherEl(): HTMLElement {
    const name = model.state.board?.name ?? 'Board'
    const btn = el(
      'button',
      {
        class: 'board-switcher',
        attrs: { type: 'button', 'aria-label': `Switch board — current: ${name}`, 'aria-haspopup': 'menu' }
      },
      [el('span', { class: 'board-switcher-name', text: name }), icon('chevron-down', 14)]
    )
    btn.addEventListener('click', () => {
      const r = btn.getBoundingClientRect()
      openContextMenu({
        items: model.state.boards.map((b) => ({
          label: `${b.board.name} · ${b.cards}${b.board.id === model.state.board?.id ? '  ✓' : ''}`,
          icon: 'kanban' as const,
          onSelect: () => void model.switchTo(b.board.id)
        })),
        x: r.left,
        y: r.bottom + 4,
        returnFocus: btn,
        ariaLabel: 'Switch board'
      })
    })
    // The board's name stays the view's heading; the switcher lives inside it
    // (a button is phrasing content — an h1 inside a button is not).
    return el('h1', { class: 'board-title' }, [btn])
  }

  function filterEl(): HTMLElement {
    const input = el('input', {
      class: 'board-filter-input',
      attrs: { type: 'search', placeholder: 'Filter cards…', 'aria-label': 'Filter cards', value: filter.text }
    }) as HTMLInputElement
    input.addEventListener('keydown', (e) => e.stopPropagation())
    input.addEventListener('input', () => {
      filter.text = input.value
      deps.onFilterChange()
    })
    const pills = BOARD_PRIORITIES.map((p) => {
      const active = filter.priority === p
      return el('button', {
        class: `board-filter-pill is-${p}${active ? ' is-active' : ''}`,
        attrs: { type: 'button', 'aria-pressed': String(active), title: `Only ${PRIORITY_FILTER_LABELS[p]} priority` },
        text: PRIORITY_FILTER_LABELS[p],
        onClick: () => {
          filter.priority = filter.priority === p ? null : p
          deps.onFilterChange()
        }
      })
    })
    return el('div', { class: 'board-filter', attrs: { role: 'search' } }, [icon('search', 14), input, ...pills])
  }

  function headEl(): HTMLElement {
    const board = model.state.board
    const sub =
      board && board.projectKey && !board.projectKey.startsWith('::')
        ? board.projectKey.split(/[\\/]/).slice(-2).join('/')
        : 'Cards launch agents — local only, yours.'
    const menuBtn = el(
      'button',
      { class: 'icon-btn board-head-menu', attrs: { type: 'button', 'aria-label': 'Board menu', 'aria-haspopup': 'menu' } },
      [icon('sliders', 14)]
    )
    menuBtn.addEventListener('click', () => deps.openBoardMenu(menuBtn))
    return el('div', { class: 'board-head' }, [
      switcherEl(),
      el('span', { class: 'board-sub', text: sub }),
      ...deps.headExtras().filter((x): x is HTMLElement => !!x),
      el('span', { class: 'board-head-spacer' }),
      filterEl(),
      menuBtn
    ])
  }

  // ── render ────────────────────────────────────────────────────────────────
  function render(): void {
    // A menu anchored to a card we are about to destroy goes FIRST (finding 37b):
    // the primitive hands focus back while the ⋯ is still in the DOM — exactly
    // what captureFocus() wants to find a line later.
    if (openMenu) {
      closeContextMenu()
      openMenu = null // belt AND braces — a stale entry would close someone else's menu next render
    }
    const focusMark = captureFocus()
    const scrollTops = captureScroll()
    clearDropMark()
    root.replaceChildren()
    const ctx = deps.cardContext()
    const lanesEl = el('div', { class: 'board-lanes' })
    for (const lane of BOARD_LANES) {
      const inLane = model.cardsInLane(lane)
      const visible = inLane.filter((c) => filterMatches(filter, c))
      const wipLimit = model.state.board?.config.wip[lane] ?? 0
      const list = el(
        'div',
        { class: 'board-lane-cards' },
        visible.length
          ? visible.map((c) => {
              const host = cardEl(c, { ...ctx, onMenuClick: (card, trigger) => onMenuClick(card, trigger) })
              wireCardDnd(host, c)
              host.addEventListener('dblclick', () => ctx.verbs.edit(c))
              return host
            })
          : [
              EmptyState({
                icon: 'kanban',
                title: inLane.length ? 'No matches' : 'No cards',
                body: inLane.length ? 'Every card here is filtered out.' : 'Add one, or drag a card here.',
                action: inLane.length
                  ? undefined
                  : Button({ label: '+ Add card', variant: 'ghost', onClick: () => deps.addCard(lane) })
              })
            ]
      )
      // The lane head speaks flow: a WIP-limited lane wears count/limit and an
      // over-limit state (kanban practice #2); an unlimited lane keeps the badge.
      const count = wipLimit
        ? el('span', {
            class: `board-wip${inLane.length > wipLimit ? ' is-over' : ''}`,
            attrs: {
              title:
                inLane.length > wipLimit
                  ? `Over the WIP limit (${inLane.length} of ${wipLimit})`
                  : `${inLane.length} of ${wipLimit} (WIP limit)`
            },
            text: `${inLane.length} / ${wipLimit}`
          })
        : CountBadge(visible.length, { label: `${visible.length} ${visible.length === 1 ? 'card' : 'cards'}` })
      const laneEl = el('section', { class: 'board-lane', attrs: { 'data-lane': lane } }, [
        el('div', { class: 'board-lane-head' }, [el('h3', { class: 'board-lane-title', text: LANE_LABELS[lane] }), count]),
        list,
        inLane.length
          ? el('button', { class: 'board-add', attrs: { type: 'button' }, text: '+ Add card', onClick: () => deps.addCard(lane) })
          : null
      ])
      laneEl.addEventListener('dragover', (e) => {
        e.preventDefault()
        laneEl.classList.add('drop')
      })
      laneEl.addEventListener('dragleave', () => laneEl.classList.remove('drop'))
      laneEl.addEventListener('drop', (e) => {
        e.preventDefault()
        laneEl.classList.remove('drop')
        clearDropMark()
        const id = e.dataTransfer?.getData('text/mogging-card')
        const card = id ? model.findCard(id) : undefined
        if (card) model.reorderCard(card, lane, null) // lane drop = append (same door as the menu)
      })
      lanesEl.append(laneEl)
    }
    root.append(headEl(), lanesEl)
    // Restores run against the LIVE tree; scroll first — focusing a control
    // inside a lane must not fight the scroll that is about to move it.
    restoreScroll(scrollTops)
    restoreFocus(focusMark)
  }

  return { root, render, menuOpenFor: () => openMenu?.cardId ?? null }
}
