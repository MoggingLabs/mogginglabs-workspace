import type { Board, BoardCard, BoardLane, PaneId } from '@contracts'
import { BOARD_LANES } from '@contracts'
import { el, icon, type ContextMenuEntry } from '../../components'
import { paneState } from '../../core/attention/attention-port'
import { getPaneCwd } from '../../core/layout/pane-cwd'
import { isBranchApproved } from './approvals-store'
import type { BoardModel } from './model'

/**
 * One card, and its verbs — the visual grammar of the board. Every cue here is
 * a RENDER of stored state (never its own poller): priority edge, label dots,
 * blocked/due/aging chips, the live pane chip, the reviewer ✓, the PR chip.
 * "Needs you" stays the loudest thing on the board — everything else is quiet.
 */

export const LANE_LABELS: Record<BoardLane, string> = {
  backlog: 'Backlog',
  todo: 'To do',
  doing: 'Doing',
  review: 'Review',
  done: 'Done'
}

export interface CardVerbs {
  edit(card: BoardCard): void
  confirmDelete(card: BoardCard): void
  archive(card: BoardCard): void
  restore(card: BoardCard): void
  startOn(card: BoardCard, providerId: string): void
  goToPane(card: BoardCard): void
  releaseClaim(card: BoardCard): void
  linkGitHub(card: BoardCard): void
  refreshLink(card: BoardCard): void
  unlink(card: BoardCard): void
  /** ADR 0015: find the PR for the card's branch (read) / push + close (write-back-gated). */
  findPr(card: BoardCard): void
  pushToGitHub(card: BoardCard): void
  closeIssue(card: BoardCard): void
}

export interface CardContext {
  model: BoardModel
  board: Board | null
  roster: { id: string; name: string; installed: boolean }[]
  linked(card: BoardCard): boolean
  serviceLinkChip(card: BoardCard): HTMLElement | null
  verbs: CardVerbs
  onMenuClick(card: BoardCard, trigger: HTMLElement, e: MouseEvent): void
}

/** ✓ when the card's worktree branch holds a live reviewer sign-off. The branch
 *  is remembered ON the card at launch; older cards fall back to deriving it
 *  from the bound pane's cwd (the pre-v2 rule, kept so old bindings still chip). */
export function approvedChip(card: BoardCard): HTMLElement | null {
  let branch = card.branch ?? ''
  if (!branch && card.paneId) {
    const cwd = getPaneCwd(card.paneId as PaneId) ?? ''
    const m = /[\\/]\.mogging[\\/]worktrees[\\/]([^\\/]+)$/.exec(cwd)
    if (m) branch = `mogging/${m[1]}`
  }
  if (!branch || !isBranchApproved(branch)) return null
  return el('span', { class: 'board-chip board-chip-approved', attrs: { title: 'Approved by the reviewer' } }, [
    icon('check', 12),
    el('span', { text: 'approved' })
  ])
}

function cardStateChip(card: BoardCard, verbs: CardVerbs): HTMLElement | null {
  if (!card.paneId) return null
  const state = paneState(card.paneId as PaneId)
  if (state === 'attention') {
    return el(
      'button',
      {
        class: 'board-chip board-chip-attention',
        attrs: { type: 'button', title: 'Jump to the pane' },
        onClick: () => verbs.goToPane(card)
      },
      [icon('bell', 12), el('span', { text: 'needs you' })]
    )
  }
  return el('span', { class: `board-chip board-chip-${state}`, attrs: { title: `pane ${card.paneId}` } }, [
    icon('terminal', 12),
    el('span', { text: state === 'busy' ? 'working' : 'agent' })
  ])
}

function blockedChip(card: BoardCard): HTMLElement | null {
  if (!card.blocked) return null
  const chip = el('span', { class: 'board-chip board-chip-blocked' }, [icon('alert', 12), el('span', { text: 'blocked' })])
  if (card.blockedReason) chip.title = card.blockedReason
  return chip
}

function dueChip(card: BoardCard): HTMLElement | null {
  if (!card.dueAt) return null
  const overdue = card.dueAt < Date.now() && card.lane !== 'done'
  const text = new Date(card.dueAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const chip = el('span', { class: `board-chip board-chip-due${overdue ? ' is-overdue' : ''}` }, [
    icon('clock', 12),
    el('span', { text: overdue ? `${text} · overdue` : text })
  ])
  chip.title = overdue ? 'Past its due date' : 'Due date'
  return chip
}

/** Idle-in-WIP cue (kanban flow practice): a card untouched for the board's
 *  agingDays while in Doing/Review wears its idle time. */
export function cardIdleDays(card: BoardCard, board: Board | null): number {
  const days = board?.config.agingDays ?? 0
  if (!days || (card.lane !== 'doing' && card.lane !== 'review')) return 0
  const idle = Math.floor((Date.now() - card.updatedAt) / 86_400_000)
  return idle >= days ? idle : 0
}

function agingChip(card: BoardCard, board: Board | null): HTMLElement | null {
  const idle = cardIdleDays(card, board)
  if (!idle) return null
  const chip = el('span', { class: 'board-chip board-chip-aging' }, [icon('clock', 12), el('span', { text: `idle ${idle}d` })])
  chip.title = `No activity for ${idle} days`
  return chip
}

/** Label dots: neutral chip text + an 8-hue deterministic dot — color is
 *  decorative (the text carries the meaning), so no new AA text pairs. */
const labelHue = (label: string): number => {
  let h = 0
  for (let i = 0; i < label.length; i++) h = (Math.imul(31, h) + label.charCodeAt(i)) | 0
  return Math.abs(h) % 8
}

function labelChips(card: BoardCard): HTMLElement[] {
  return card.labels.map((label) =>
    el('span', { class: 'board-label' }, [
      el('span', { class: `board-label-dot hue-${labelHue(label)}`, attrs: { 'aria-hidden': 'true' } }),
      el('span', { text: label })
    ])
  )
}

/** The card's verbs, in frequency order: start an agent (the board's whole
 *  point), move/reorder it, link/manage, edit + navigate, destructive LAST. */
export function cardMenuItems(card: BoardCard, ctx: CardContext): ContextMenuEntry[] {
  const items: ContextMenuEntry[] = []
  const { verbs } = ctx
  for (const a of ctx.roster.filter((r) => r.installed)) {
    items.push({ label: `Start ${a.name} on this…`, icon: 'sparkles', onSelect: () => verbs.startOn(card, a.id) })
  }
  if (items.length) items.push({ separator: true })
  // The keyboard's road out of drag-and-drop (finding 31): one item per OTHER
  // lane, plus in-lane reordering — the same mutations the drop handler runs.
  for (const lane of BOARD_LANES) {
    if (lane === card.lane) continue
    items.push({ label: `Move to ${LANE_LABELS[lane]}`, icon: 'arrow-right', onSelect: () => ctx.model.moveCard(card, lane) })
  }
  const siblings = ctx.model.cardsInLane(card.lane)
  const at = siblings.findIndex((c) => c.id === card.id)
  if (at > 0) {
    items.push({ label: 'Move up', icon: 'chevron-up', onSelect: () => ctx.model.reorderCard(card, card.lane, siblings[at - 1].id) })
  }
  if (at >= 0 && at < siblings.length - 1) {
    items.push({
      label: 'Move down',
      icon: 'chevron-down',
      onSelect: () => ctx.model.reorderCard(card, card.lane, siblings.length > at + 2 ? siblings[at + 2].id : null)
    })
  }
  items.push({ separator: true })
  items.push({
    label: ctx.linked(card) ? 'Change GitHub link…' : 'Link GitHub PR/issue…',
    icon: 'git-branch',
    onSelect: () => verbs.linkGitHub(card)
  })
  if (ctx.linked(card)) {
    items.push({ label: 'Refresh link', icon: 'rotate-cw', onSelect: () => verbs.refreshLink(card) })
    items.push({ label: 'Unlink', icon: 'x', onSelect: () => verbs.unlink(card) })
    if (card.lane !== 'done') {
      items.push({ label: 'Close linked issue…', icon: 'check', onSelect: () => verbs.closeIssue(card) })
    }
  } else {
    if (card.branch) {
      items.push({ label: 'Find PR for branch', icon: 'git-branch', onSelect: () => verbs.findPr(card) })
    }
    items.push({ label: 'Push to GitHub as issue…', icon: 'git-branch', onSelect: () => verbs.pushToGitHub(card) })
  }
  items.push({ label: 'Edit…', icon: 'pencil', onSelect: () => verbs.edit(card) })
  if (card.paneId && card.workspaceId) {
    items.push({ label: 'Go to pane', icon: 'terminal', onSelect: () => verbs.goToPane(card) })
  }
  if (card.paneId) {
    items.push({ label: 'Release claim', icon: 'x', onSelect: () => verbs.releaseClaim(card) })
  }
  items.push({ separator: true })
  if (card.archivedAt) {
    items.push({ label: 'Restore card', icon: 'rotate-cw', onSelect: () => verbs.restore(card) })
  } else {
    items.push({ label: 'Archive card', icon: 'bookmark', onSelect: () => verbs.archive(card) })
  }
  // Bug #7: a destructive act gets a confirm, safe action focused (07b danger pattern).
  items.push({ label: 'Delete card', icon: 'trash', onSelect: () => verbs.confirmDelete(card) })
  return items
}

export function cardEl(card: BoardCard, ctx: CardContext): HTMLElement {
  const menuBtn = el(
    'button',
    {
      class: 'icon-btn board-card-more',
      attrs: { type: 'button', 'aria-label': 'Card menu', 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
      onClick: (e) => {
        e.stopPropagation()
        ctx.onMenuClick(card, menuBtn, e as MouseEvent)
      }
    },
    [icon('more', 14)]
  )
  const labels = labelChips(card)
  const host = el(
    'article',
    { class: 'board-card', attrs: { draggable: 'true', 'data-card-id': card.id } },
    [
      el('div', { class: 'board-card-head' }, [el('h4', { class: 'board-card-title', text: card.title }), menuBtn]),
      ...(card.notes.trim() ? [el('p', { class: 'board-card-notes', text: card.notes })] : []),
      ...(labels.length ? [el('div', { class: 'board-card-labels' }, labels)] : []),
      el('div', { class: 'board-card-foot' }, [
        cardStateChip(card, ctx.verbs),
        approvedChip(card),
        blockedChip(card),
        dueChip(card),
        agingChip(card, ctx.board),
        ctx.serviceLinkChip(card)
      ])
    ]
  )
  host.dataset.priority = card.priority
  if (card.priority === 'urgent' || card.priority === 'high') {
    host.title = `${card.priority === 'urgent' ? 'Urgent' : 'High'} priority`
  }
  if (card.paneId && paneState(card.paneId as PaneId) === 'attention') host.dataset.attention = 'true'
  if (cardIdleDays(card, ctx.board)) host.dataset.aged = 'true'
  if (card.blocked) host.dataset.blocked = 'true'
  return host
}
