import {
  IntegrationsChannels,
  SERVICE_LINK_CADENCE_DEFAULT,
  type BoardCard,
  type LinkStatus,
  type ServiceLink
} from '@contracts'
import { getBridge } from '../../core/ipc/bridge'
import { Button, createModal, el } from '../../components'

/**
 * Service links (8/12), board-side: a card <-> a GitHub PR/issue, live via the
 * user's own gh. This module owns the card→link map + the pushed status
 * snapshot and renders the chip; the engine lives app-side and never mutates
 * the PR (reads here; ADR 0015's write-back is a separate, gated door).
 */

let linkSnapshot: { statuses: LinkStatus[]; at: number } = { statuses: [], at: 0 }
const linksByCard = new Map<string, ServiceLink>()
const subs = new Set<() => void>()
let wired = false

function emit(): void {
  for (const cb of subs) cb()
}

export function initLinks(): void {
  if (wired) return
  wired = true
  // Live status push (8/12) repaints the chips — never a re-fetch.
  getBridge().on(IntegrationsChannels.linkStatusChanged, (snap) => {
    linkSnapshot = (snap as typeof linkSnapshot) ?? linkSnapshot
    emit()
  })
}

export function onLinksChange(cb: () => void): () => void {
  subs.add(cb)
  return () => subs.delete(cb)
}

export async function loadLinks(cards: BoardCard[]): Promise<void> {
  const bridge = getBridge()
  linksByCard.clear()
  await Promise.all(
    cards.map(async (c) => {
      const l = (await bridge.invoke(IntegrationsChannels.linkGet, c.id)) as ServiceLink | null
      if (l) linksByCard.set(c.id, l)
    })
  )
  linkSnapshot = ((await bridge.invoke(IntegrationsChannels.linkStatusGet)) as typeof linkSnapshot) ?? linkSnapshot
}

export const linkFor = (cardId: string): ServiceLink | undefined => linksByCard.get(cardId)

/** True when the pushed status snapshot names a link this store has never
 *  loaded — a link minted WITHOUT a card-set change (an IPC link:set, the
 *  board's PR auto-link) would otherwise never paint until an unrelated
 *  reload. The consumer answers by re-loading the map. */
export function snapshotHasUnknownLink(): boolean {
  if (!linkSnapshot.statuses.length) return false
  const known = new Set([...linksByCard.values()].map((l) => l.id))
  return linkSnapshot.statuses.some((s) => !known.has(s.linkId))
}

// "as of {age}" — the ONE relative formatter.
const fmtAge = (ts: number): string => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

const GLYPH: Record<string, string> = { open: '◌', draft: '◍', merged: '✔', closed: '✕' }

/** The card-face status chip (state glyph + checks; stale dims). */
export function serviceLinkChip(card: BoardCard): HTMLElement | null {
  const link = linksByCard.get(card.id)
  if (!link) return null
  const st = linkSnapshot.statuses.find((s) => s.linkId === link.id)
  const num = link.ref.split('#')[1] ?? '?'
  if (!st) return el('span', { class: 'board-link-chip is-loading', text: `#${num} …` })
  const checks = st.checks && st.checks !== 'none' ? ` · ${st.checks}` : ''
  const glyph = st.state ? GLYPH[st.state] ?? '' : ''
  const review = st.reviewDecision === 'changes-requested' ? ' ✎' : st.reviewDecision === 'approved' ? ' ✓' : ''
  const chip = el('span', {
    class: `board-link-chip is-${st.state ?? 'open'} health-${st.health} checks-${st.checks ?? 'none'}`,
    text: `${glyph} #${num}${review}${checks}`
  })
  chip.title = `${link.ref}${st.title ? ` — ${st.title}` : ''} · ${st.health === 'stale' ? 'stale, ' : ''}as of ${fmtAge(st.fetchedAt)}${st.reason ? ` (${st.reason})` : ''}`
  return chip
}

/** The link/edit modal — unchanged contract: read-only observation via gh. */
export function linkCardModal(card: BoardCard, onDone: () => void): void {
  const bridge = getBridge()
  const existing = linksByCard.get(card.id)
  const input = el('input', { class: 'browser-sites-input', placeholder: 'GitHub PR/issue URL or owner/repo#123' }) as HTMLInputElement
  if (existing) input.value = existing.ref
  input.addEventListener('keydown', (e) => e.stopPropagation())
  const note = el('div', { class: 'settings-error', role: 'alert', hidden: true })
  const m = createModal({ title: 'Link GitHub PR/issue', width: 460 })
  const saveBtn = Button({
    label: 'Link',
    variant: 'primary',
    onClick: async () => {
      const r = (await bridge.invoke(IntegrationsChannels.linkSet, {
        cardId: card.id,
        input: input.value,
        cadence: SERVICE_LINK_CADENCE_DEFAULT
      })) as { ok: boolean; reason?: string }
      if (r.ok) {
        m.close()
        onDone()
      } else {
        note.textContent = r.reason ?? 'refused'
        note.hidden = false
      }
    }
  })
  m.setBody(
    el('div', { class: 'mgr-form' }, [
      input,
      el('div', { class: 'settings-row-caption', text: 'Read-only: the app observes via your own gh; it never changes the PR.' }),
      note
    ])
  )
  m.setFooter(el('div', { class: 'confirm-actions' }, [Button({ label: 'Cancel', variant: 'ghost', onClick: () => m.close() }), saveBtn]))
  m.open()
}
