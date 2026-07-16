import { app, ipcMain, type BrowserWindow } from 'electron'
import {
  IntegrationsChannels,
  SERVICE_LINK_CADENCE_DEFAULT,
  SERVICE_LINK_CADENCES,
  type BoardCard,
  type LinkStatus,
  type ServiceLink,
  type ServiceLinkCadence
} from '@contracts'
import { ServiceEngine, createFakeAdapter, createGitHubAdapter, parseServiceLink } from '@backend/features/integrations'
import { getSettingsStore } from './app-settings'
import { getDaemonClient } from './daemon-relay'
import { emitBridgeEvent } from './event-bridge'

// App-wiring for the service links (Phase-8/12): a board card <-> a GitHub
// PR/issue. The engine (backend) polls; here we persist the links, push
// snapshots to the renderer, and — the site's sentence — land a house notify
// on the OWNING pane when a linked card's review/state transitions. The app
// holds no credential: `gh` authenticates itself.

const KV_LINKS = 'integrations.links'
let winGetter: (() => BrowserWindow | null) | null = null
let engine: ServiceEngine | null = null

function loadLinks(): ServiceLink[] {
  try {
    const raw = getSettingsStore()?.getSetting(KV_LINKS)
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(arr) ? (arr as ServiceLink[]) : []
  } catch {
    return []
  }
}
function saveLinks(links: ServiceLink[]): void {
  getSettingsStore()?.setSetting(KV_LINKS, JSON.stringify(links))
}

function pushSnapshot(): void {
  try {
    winGetter?.()?.webContents.send(IntegrationsChannels.linkStatusChanged, engine?.snapshot() ?? { statuses: [], at: 0 })
  } catch {
    /* window gone */
  }
}

/** Board rules (ADR 0015 §inbound) subscribe here — set by registerGithubBoard.
 *  Injected, not imported: github-board already imports this module. */
let transitionRules: ((card: BoardCard, link: ServiceLink, status: LinkStatus) => void) | null = null
export function setLinkTransitionRules(cb: (card: BoardCard, link: ServiceLink, status: LinkStatus) => void): void {
  transitionRules = cb
}

/** The site's promise: review lands back in the pane that wrote it. */
function onTransition(link: ServiceLink, label: string): void {
  const card = getSettingsStore()?.getCard(link.cardId) ?? null
  if (card?.paneId != null) getDaemonClient()?.notify(String(card.paneId), 'attention', label)
  // The bridge's review-changed (10) — a no-op if no webhook subscribes.
  emitBridgeEvent('review-changed', { workspace: card?.workspaceId ?? '', card: link.cardId, note: label })
  // Per-board rules (PR merged → Done, …) act on the SAME transition, after
  // the human-facing signals — a rule failing must never eat the notify.
  const status = engine?.statusFor(link.id)
  if (card && status) transitionRules?.(card, link, status)
}

/** Direct link creation for the board's GitHub verbs (import / auto-link /
 *  push): the ref is already normalized "owner/repo#N" — same store, same
 *  engine, one door as the user's own Link modal. */
export function linkCardDirect(
  cardId: string,
  ref: string,
  kind: ServiceLink['kind'],
  service = 'github'
): { ok: boolean; reason?: string } {
  if (!/^[\w.-]{1,100}\/[\w.-]{1,100}#\d{1,10}$/.test(ref)) return { ok: false, reason: 'bad ref' }
  const links = loadLinks().filter((l) => l.cardId !== cardId) // one link per card (v1)
  const link: ServiceLink = {
    id: `lnk_${Math.abs(hash(cardId + ref)).toString(36)}`,
    service,
    cardId,
    kind,
    ref,
    cadence: SERVICE_LINK_CADENCE_DEFAULT
  }
  links.push(link)
  saveLinks(links)
  engine?.setLinks(links)
  engine?.refresh(link.id)
  return { ok: true }
}

export const linkForCard = (cardId: string): ServiceLink | null =>
  loadLinks().find((l) => l.cardId === cardId) ?? null

/** Refs already linked anywhere on the board — the import's dedupe set. */
export const linkedRefs = (): Set<string> => new Set(loadLinks().map((l) => l.ref))

function setLink(p: { cardId?: string; input?: string; cadence?: ServiceLinkCadence; service?: string }): { ok: boolean; reason?: string; link?: ServiceLink } {
  const cardId = String(p?.cardId ?? '')
  if (!cardId) return { ok: false, reason: 'no card' }
  const parsed = parseServiceLink(String(p?.input ?? ''))
  if (!parsed) return { ok: false, reason: 'couldn’t read that — paste a GitHub PR/issue URL or owner/repo#123' }
  const cadence: ServiceLinkCadence = SERVICE_LINK_CADENCES.includes(p?.cadence as ServiceLinkCadence) ? (p!.cadence as ServiceLinkCadence) : SERVICE_LINK_CADENCE_DEFAULT
  const links = loadLinks().filter((l) => l.cardId !== cardId) // one link per card (v1)
  const link: ServiceLink = { id: `lnk_${Math.abs(hash(cardId + parsed.ref)).toString(36)}`, service: p?.service ?? 'github', cardId, kind: parsed.kind, ref: parsed.ref, cadence }
  links.push(link)
  saveLinks(links)
  engine?.setLinks(links)
  engine?.refresh(link.id)
  return { ok: true, link }
}

function removeLink(linkId: string): void {
  const links = loadLinks().filter((l) => l.id !== linkId)
  saveLinks(links)
  engine?.setLinks(links)
  pushSnapshot()
}

export function registerServices(getWin: () => BrowserWindow | null): void {
  winGetter = getWin
  engine = new ServiceEngine({
    adapters: { github: createGitHubAdapter(), fake: createFakeAdapter() },
    onPush: pushSnapshot,
    onTransition,
    // A `owner/repo#123` shorthand cannot tell a PR from an issue, so it is stored as a PR and
    // the adapter corrects it on the first fetch. PERSIST that correction: without this the
    // repair lives only in the engine's memory and every app start pays another failing
    // `gh pr view` before re-learning the same thing.
    onLinkRepaired: (repaired) => {
      const links = loadLinks().map((l) => (l.id === repaired.id ? { ...l, kind: repaired.kind } : l))
      saveLinks(links)
    }
  })
  engine.setLinks(loadLinks())

  ipcMain.handle(IntegrationsChannels.linkGet, (_e, cardId: string) => loadLinks().find((l) => l.cardId === String(cardId)) ?? null)
  ipcMain.handle(IntegrationsChannels.linkSet, (_e, p) => setLink(p ?? {}))
  ipcMain.handle(IntegrationsChannels.linkRemove, (_e, id: string) => removeLink(String(id)))
  ipcMain.handle(IntegrationsChannels.linkStatusGet, () => engine?.snapshot() ?? { statuses: [], at: 0 })
  ipcMain.handle(IntegrationsChannels.linkRefresh, (_e, id: string) => engine?.refresh(String(id)))

  // Only the MAIN window's visibility governs polling: a SECONDARY window (any other
  // BrowserWindow the app opens) hiding used to pause link-status polling app-wide while the
  // main window sat visible. The identity check must happen when the event ARRIVES, not here —
  // this fires from inside createMainWindow, before index.ts has assigned `win`.
  app.on('browser-window-created', (_e, w) => {
    const visible = (on: boolean) => (): void => {
      if (w === getWin()) engine?.setVisible(on)
    }
    w.on('hide', visible(false))
    w.on('minimize', visible(false))
    w.on('show', visible(true))
    w.on('restore', visible(true))
  })
}

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}
