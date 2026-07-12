import { ipcMain, type BrowserWindow } from 'electron'
import { BRIDGE_EVENTS, IntegrationsChannels, type BridgeEventName } from '@contracts'
import { buildBridgeEvent, deliverWebhook, urlAllowed, webhookReceives } from '@backend/features/integrations'
import { getSettingsStore } from './app-settings'
import { vaultAvailable, vaultClearKey, vaultHas, vaultLoad, vaultStore } from './vault'
import { workspaceIdForPane } from './integrations'
import { recordTrail } from './trail'

// The outbound event bridge (Phase-8/10, ADR 0008.g). House events -> user
// webhooks, POST only. URLs are SECRETS: the literal rests as vault ciphertext
// (consumer three) or an env-ref pointer; the KV, the trail, logs, and
// telemetry only ever see the LABEL. Delivery is a per-webhook queue with
// bounded retries; a hung receiver never stalls a notify. Daemon stays v3 —
// we subscribe to the attention stream main already sees.

const KV_LIST = 'integrations.webhooks' // JSON array of stored config (NO url)
const KV_URLCIPHER = (id: string): string => `integrations.webhookurl.${id}`
const KV_URLENV = (id: string): string => `integrations.webhookurlenv.${id}`

interface StoredWebhook {
  id: string
  label: string
  events: BridgeEventName[]
  workspaceId?: string
  urlKind: 'keychain' | 'env-ref'
  envRef?: string
}

/** The renderer-safe view: masked url + health, NEVER the URL literal. */
export interface WebhookView {
  id: string
  label: string
  events: BridgeEventName[]
  workspaceId?: string
  urlMask: string
  health: 'ok' | 'failing' | 'off'
}

let winGetter: (() => BrowserWindow | null) | null = null
const health = new Map<string, 'ok' | 'failing' | 'off'>()
const queues = new Map<string, Promise<void>>() // per-webhook serial delivery

function list(): StoredWebhook[] {
  try {
    const raw = getSettingsStore()?.getSetting(KV_LIST)
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(arr) ? (arr as StoredWebhook[]) : []
  } catch {
    return []
  }
}
function saveList(rows: StoredWebhook[]): void {
  getSettingsStore()?.setSetting(KV_LIST, JSON.stringify(rows))
}

/** host/… mask — the ONLY public shape of a URL (0007.a). Never the path. */
function urlMask(w: StoredWebhook): string {
  if (w.urlKind === 'env-ref') return `\${${w.envRef}}`
  const url = resolveUrl(w.id)
  if (!url) return 'key saved ····'
  try {
    return `${new URL(url).host}/…`
  } catch {
    return 'key saved ····'
  }
}

function toView(w: StoredWebhook): WebhookView {
  return { id: w.id, label: w.label, events: w.events, workspaceId: w.workspaceId, urlMask: urlMask(w), health: health.get(w.id) ?? 'off' }
}
function views(): WebhookView[] {
  return list().map(toView)
}

/** Resolve the URL for delivery ONLY (main-side, never exposed). */
function resolveUrl(id: string): string | null {
  const w = list().find((x) => x.id === id)
  if (!w) return null
  if (w.urlKind === 'env-ref') return w.envRef ? (process.env[w.envRef] ?? null) : null
  return vaultLoad(KV_URLCIPHER(id))
}

function sanitizeEvents(raw: unknown): BridgeEventName[] {
  const arr = Array.isArray(raw) ? raw : []
  return BRIDGE_EVENTS.filter((e) => arr.includes(e))
}

export function saveWebhook(p: {
  id?: string
  label?: string
  url?: string
  envRef?: string
  events?: unknown
  workspaceId?: string
  insecureAck?: boolean
}): { ok: boolean; reason?: string } {
  const label = String(p.label ?? '').trim().slice(0, 60)
  if (!label) return { ok: false, reason: 'give the webhook a name' }
  const events = sanitizeEvents(p.events)
  if (!events.length) return { ok: false, reason: 'pick at least one event' }
  const id = p.id && list().some((w) => w.id === p.id) ? p.id : `wh_${Math.abs(hash(label + Date.now())).toString(36)}`

  let urlKind: 'keychain' | 'env-ref'
  let envRef: string | undefined
  if (p.envRef && p.envRef.trim()) {
    const ref = p.envRef.trim().replace(/^\$\{?/, '').replace(/\}$/, '')
    if (!/^[A-Z][A-Z0-9_]{2,64}$/.test(ref)) return { ok: false, reason: 'env-ref must be a NAME like N8N_WEBHOOK_URL' }
    urlKind = 'env-ref'
    envRef = ref
  } else if (p.url && p.url.trim()) {
    const allowed = urlAllowed(p.url.trim(), !!p.insecureAck)
    if (!allowed.ok) return { ok: false, reason: allowed.reason }
    if (!vaultAvailable()) return { ok: false, reason: 'OS keychain unavailable — reference the URL as an env var instead (${N8N_WEBHOOK_URL})' }
    // A dropped ciphertext must not save a webhook that can never resolve its URL.
    if (!vaultStore(KV_URLCIPHER(id), p.url.trim())) return { ok: false, reason: 'could not store the URL — the settings store is unavailable' }
    urlKind = 'keychain'
  } else if (p.id) {
    // Editing an existing webhook without touching the URL — keep it.
    const cur = list().find((w) => w.id === p.id)
    if (!cur) return { ok: false, reason: 'unknown webhook' }
    urlKind = cur.urlKind
    envRef = cur.envRef
  } else {
    return { ok: false, reason: 'paste the webhook URL (or give an env-ref)' }
  }

  const rows = list().filter((w) => w.id !== id)
  rows.push({ id, label, events, workspaceId: p.workspaceId || undefined, urlKind, envRef })
  saveList(rows)
  health.set(id, 'off')
  pushViews()
  return { ok: true }
}

function removeWebhook(id: string): void {
  saveList(list().filter((w) => w.id !== id))
  vaultClearKey(KV_URLCIPHER(id))
  getSettingsStore()?.setSetting(KV_URLENV(id), '')
  health.delete(id)
  queues.delete(id)
  pushViews()
}

function pushViews(): void {
  try {
    winGetter?.()?.webContents.send(IntegrationsChannels.webhookHealthChanged, views())
  } catch {
    /* window gone */
  }
}

// ── Emission + delivery ─────────────────────────────────────────────────────

/** Fire a house event at every matching webhook — never blocks the caller. */
export function emitBridgeEvent(event: BridgeEventName, fields: { workspace: string; pane?: string; card?: string; note?: string }): void {
  const payload = buildBridgeEvent(event, fields, Date.now())
  for (const w of list()) {
    if (!webhookReceives({ events: w.events, workspaceId: w.workspaceId }, event, fields.workspace)) continue
    const url = resolveUrl(w.id)
    const label = w.label
    queues.set(
      w.id,
      (queues.get(w.id) ?? Promise.resolve()).then(async () => {
        if (!url) {
          health.set(w.id, 'off')
          pushViews()
          return
        }
        const r = await deliverWebhook(url, payload, { fetchFn: nodeFetch, timeoutMs: 5000 })
        if (r.ok) {
          health.set(w.id, 'ok')
        } else {
          health.set(w.id, 'failing')
          // Dropped after retries: a trail entry with the LABEL, never the URL. The outcome is
          // NOT 'ok' — the viewer badges outcome, so a failed delivery read as a success with the
          // truth buried in `reason`. 'refused' is the union's only non-success value (the store
          // rewrites anything else back to 'ok'), and the event did not reach the receiver.
          recordTrail({ ts: Date.now(), source: 'bridge', workspaceId: fields.workspace, verb: event, target: label, outcome: 'refused', reason: `delivery dropped after ${r.attempts} attempts` })
        }
        pushViews()
      })
    )
  }
}

/** Node fetch adapter (no redirects; AbortSignal for the timeout). */
async function nodeFetch(url: string, init: { method: string; headers: Record<string, string>; body: string; redirect: 'error'; signal: AbortSignal }): Promise<{ status: number }> {
  const res = await fetch(url, init as RequestInit)
  // Drain a bounded slice so a huge body can't cost us; we only need the status.
  try {
    await res.text()
  } catch {
    /* ignore */
  }
  return { status: res.status }
}

// ── The house-event subscription (attention stream, daemon untouched) ────────
const lastState = new Map<number, string>()
/** Called from daemon-relay's onState. A transition INTO attention = a pane
 *  needs the human -> a `needs-you` bridge event (ids only; the daemon dropped
 *  the note, honestly). */
export function onPaneStateForBridge(paneId: number, state: string): void {
  const prev = lastState.get(paneId)
  lastState.set(paneId, state)
  if (state === 'attention' && prev !== 'attention') {
    const workspace = workspaceIdForPane(String(paneId))
    if (workspace) emitBridgeEvent('needs-you', { workspace, pane: String(paneId) })
  }
}

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}

export function registerEventBridge(getWin: () => BrowserWindow | null): void {
  winGetter = getWin
  for (const w of list()) if (!health.has(w.id)) health.set(w.id, 'off')
  ipcMain.handle(IntegrationsChannels.webhookList, () => views())
  ipcMain.handle(IntegrationsChannels.webhookSave, (_e, p) => saveWebhook(p ?? {}))
  ipcMain.handle(IntegrationsChannels.webhookRemove, (_e, id: string) => removeWebhook(String(id)))
  ipcMain.handle(IntegrationsChannels.webhookTest, (_e, id: string) => {
    const w = list().find((x) => x.id === String(id))
    if (w) emitBridgeEvent(w.events[0] ?? 'notify', { workspace: w.workspaceId ?? 'test', note: 'Test event from MoggingLabs Workspace' })
  })
}
