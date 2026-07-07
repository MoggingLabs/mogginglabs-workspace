import { app, ipcMain, type BrowserWindow } from 'electron'
import {
  IntegrationsChannels,
  SERVICE_LINK_CADENCE_DEFAULT,
  SERVICE_LINK_CADENCES,
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

/** The site's promise: review lands back in the pane that wrote it. */
function onTransition(link: ServiceLink, label: string): void {
  const card = getSettingsStore()?.listBoard().find((c) => c.id === link.cardId)
  if (card?.paneId != null) getDaemonClient()?.notify(String(card.paneId), 'attention', label)
  // The bridge's review-changed (10) — a no-op if no webhook subscribes.
  emitBridgeEvent('review-changed', { workspace: card?.workspaceId ?? '', card: link.cardId, note: label })
}

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
    onTransition
  })
  engine.setLinks(loadLinks())

  ipcMain.handle(IntegrationsChannels.linkGet, (_e, cardId: string) => loadLinks().find((l) => l.cardId === String(cardId)) ?? null)
  ipcMain.handle(IntegrationsChannels.linkSet, (_e, p) => setLink(p ?? {}))
  ipcMain.handle(IntegrationsChannels.linkRemove, (_e, id: string) => removeLink(String(id)))
  ipcMain.handle(IntegrationsChannels.linkStatusGet, () => engine?.snapshot() ?? { statuses: [], at: 0 })
  ipcMain.handle(IntegrationsChannels.linkRefresh, (_e, id: string) => engine?.refresh(String(id)))

  app.on('browser-window-created', (_e, w) => {
    w.on('hide', () => engine?.setVisible(false))
    w.on('minimize', () => engine?.setVisible(false))
    w.on('show', () => engine?.setVisible(true))
    w.on('restore', () => engine?.setVisible(true))
  })
}

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}
