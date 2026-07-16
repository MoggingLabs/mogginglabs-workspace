import {
  BOARD_PRIORITIES,
  BoardChannels,
  type BoardActivity,
  type BoardCard,
  type BoardCardPatch,
  type BoardLane,
  type BoardPriority
} from '@contracts'
import { getBridge } from '../../core/ipc/bridge'
import { Button, createModal, el, showToast } from '../../components'
import type { BoardModel } from './model'

/**
 * The card detail modal — one surface for creating and editing: title, notes,
 * and the flow metadata (priority, labels, due, blocked), plus the activity
 * tail for existing cards (who did what — human, pane N, queue, sync). Saving
 * an existing card sends ONE field patch of exactly what changed.
 */

const PRIORITY_LABELS: Record<BoardPriority, string> = {
  urgent: 'Urgent',
  high: 'High',
  normal: 'Normal',
  low: 'Low'
}

const fmtWhen = (ts: number): string => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

export function openCardDetail(model: BoardModel, card: BoardCard | null, lane: BoardLane): void {
  const isNew = card == null
  const title = el('input', {
    class: 'board-edit-title',
    attrs: { type: 'text', placeholder: 'Task title', value: card?.title ?? '', 'aria-label': 'Task title' }
  }) as HTMLInputElement
  const notes = el('textarea', {
    class: 'board-edit-notes',
    attrs: { rows: '6', placeholder: 'Notes / context the agent should get…', 'aria-label': 'Notes' }
  }) as HTMLTextAreaElement
  notes.value = card?.notes ?? ''

  // ── metadata row ──────────────────────────────────────────────────────────
  let priority: BoardPriority = card?.priority ?? 'normal'
  const priorityGroup = el('div', { class: 'board-edit-priorities', attrs: { role: 'radiogroup', 'aria-label': 'Priority' } })
  const priorityButtons = new Map<BoardPriority, HTMLButtonElement>()
  for (const p of BOARD_PRIORITIES) {
    const btn = el('button', {
      class: `board-edit-priority is-${p}`,
      attrs: { type: 'button', role: 'radio', 'aria-checked': String(p === priority) },
      text: PRIORITY_LABELS[p],
      onClick: () => {
        priority = p
        for (const [k, b] of priorityButtons) b.setAttribute('aria-checked', String(k === p))
      }
    }) as HTMLButtonElement
    priorityButtons.set(p, btn)
    priorityGroup.append(btn)
  }
  const labels = el('input', {
    class: 'board-edit-labels',
    attrs: {
      type: 'text',
      placeholder: 'Labels (comma-separated)',
      value: card?.labels.join(', ') ?? '',
      'aria-label': 'Labels, comma-separated'
    }
  }) as HTMLInputElement
  const due = el('input', {
    class: 'board-edit-due',
    attrs: { type: 'date', 'aria-label': 'Due date' }
  }) as HTMLInputElement
  if (card?.dueAt) due.value = new Date(card.dueAt).toISOString().slice(0, 10)
  const blocked = el('input', { attrs: { type: 'checkbox', id: 'board-edit-blocked' } }) as HTMLInputElement
  blocked.checked = card?.blocked ?? false
  const blockedReason = el('input', {
    class: 'board-edit-blocked-reason',
    attrs: { type: 'text', placeholder: 'Why is it blocked?', 'aria-label': 'Blocked reason', value: card?.blockedReason ?? '' }
  }) as HTMLInputElement
  blockedReason.hidden = !blocked.checked
  blocked.addEventListener('change', () => {
    blockedReason.hidden = !blocked.checked
  })
  const meta = el('div', { class: 'board-edit-meta' }, [
    priorityGroup,
    labels,
    el('div', { class: 'board-edit-meta-row' }, [
      due,
      el('label', { class: 'board-edit-blocked', attrs: { for: 'board-edit-blocked' } }, [blocked, el('span', { text: 'Blocked' })]),
      blockedReason
    ])
  ])
  for (const input of [title, notes, labels, due, blockedReason]) {
    input.addEventListener('keydown', (e) => e.stopPropagation())
  }

  const body = el('div', { class: 'board-edit' }, [title, notes, meta])

  // ── activity tail (existing cards) — read-only, local, honest ─────────────
  if (card) {
    const list = el('div', { class: 'board-activity', attrs: { 'aria-label': 'Card activity' } })
    body.append(el('h5', { class: 'board-activity-title', text: 'Activity' }), list)
    void (getBridge().invoke(BoardChannels.activity, card.id) as Promise<BoardActivity[]>).then((rows) => {
      if (!rows?.length) {
        list.append(el('div', { class: 'board-activity-empty', text: 'No activity yet.' }))
        return
      }
      for (const row of rows.slice(0, 15)) {
        list.append(
          el('div', { class: 'board-activity-row' }, [
            el('span', { class: 'board-activity-when', text: fmtWhen(row.ts) }),
            el('span', { class: 'board-activity-actor', text: row.actor }),
            el('span', { class: 'board-activity-verb', text: row.verb }),
            ...(row.detail ? [el('span', { class: 'board-activity-detail', text: row.detail })] : [])
          ])
        )
      }
    })
  }

  const modal = createModal({ title: isNew ? 'New card' : 'Edit card', width: 560 })
  const parseDue = (): number | null => {
    if (!due.value) return null
    const t = Date.parse(`${due.value}T12:00:00`)
    return Number.isFinite(t) ? t : null
  }
  const saveBtn = Button({
    label: isNew ? 'Add card' : 'Save',
    variant: 'primary',
    onClick: () => {
      const nextTitle = title.value.trim()
      if (!nextTitle) {
        showToast({ tone: 'attention', title: 'A card needs a title' })
        return
      }
      const labelList = labels.value.split(',').map((s) => s.trim()).filter(Boolean)
      if (isNew) {
        void model.createCard({ title: nextTitle, notes: notes.value, lane }).then((created) => {
          if (!created) return
          const patch: BoardCardPatch = {}
          if (priority !== 'normal') patch.priority = priority
          if (labelList.length) patch.labels = labelList
          if (parseDue() != null) patch.dueAt = parseDue()
          if (blocked.checked) {
            patch.blocked = true
            patch.blockedReason = blockedReason.value.trim() || null
          }
          if (Object.keys(patch).length) model.patchCard(created, patch)
        })
      } else {
        // ONE patch of exactly what changed — an unchanged field never rides.
        const patch: BoardCardPatch = {}
        if (nextTitle !== card.title) patch.title = nextTitle
        if (notes.value !== card.notes) patch.notes = notes.value
        if (priority !== card.priority) patch.priority = priority
        if (JSON.stringify(labelList) !== JSON.stringify(card.labels)) patch.labels = labelList
        if ((parseDue() ?? null) !== (card.dueAt ?? null)) patch.dueAt = parseDue()
        if (blocked.checked !== card.blocked) patch.blocked = blocked.checked
        const reason = blocked.checked ? blockedReason.value.trim() || null : null
        if ((reason ?? null) !== (card.blockedReason ?? null)) patch.blockedReason = reason
        if (Object.keys(patch).length) model.patchCard(card, patch)
      }
      modal.close()
    }
  })
  const cancel = Button({ label: 'Cancel', onClick: () => modal.close() })
  modal.setBody(body)
  modal.setFooter(el('div', { class: 'board-edit-footer' }, [cancel, saveBtn]))
  modal.open()
  setTimeout(() => title.focus(), 50)
}
