import { BRIDGE_PAYLOAD_VERSION, type BridgeEvent, type BridgeEventName } from '@contracts'

// The outbound event bridge delivery engine (Phase-8/10, ADR 0008.g). POST
// only — nothing listens. Pure + Electron-free: payload shaping, webhook
// matching, the URL-safety policy, and a retrying deliver() over an injected
// fetch. Main wires the vault URL store, the real fetch, the trail, and the
// house-event subscription. A doorbell, not a message bus.

/** Build the versioned wire payload — ids + the note, never content. */
export function buildBridgeEvent(
  event: BridgeEventName,
  fields: { workspace: string; pane?: string; card?: string; note?: string },
  now: number
): BridgeEvent {
  const e: BridgeEvent = { v: BRIDGE_PAYLOAD_VERSION, event, ts: now, workspace: fields.workspace }
  if (fields.pane) e.pane = fields.pane
  if (fields.card) e.card = fields.card
  if (fields.note) e.note = fields.note.slice(0, 280)
  return e
}

/** Does this webhook receive this event, for this workspace? */
export function webhookReceives(w: { events: readonly BridgeEventName[]; workspaceId?: string }, event: BridgeEventName, workspaceId: string | undefined): boolean {
  if (!w.events.includes(event)) return false
  if (w.workspaceId && w.workspaceId !== workspaceId) return false
  return true
}

export type UrlClass = 'https' | 'http-loopback' | 'http-lan' | 'invalid'

/** The URL-safety policy: https anywhere; plain http ONLY loopback; private-LAN
 *  http is allowed but demands the explicit insecure acknowledgment. */
export function classifyWebhookUrl(raw: string): UrlClass {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return 'invalid'
  }
  if (u.protocol === 'https:') return 'https'
  if (u.protocol !== 'http:') return 'invalid'
  const host = u.hostname
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return 'http-loopback'
  if (isPrivateLanHost(host)) return 'http-lan'
  return 'invalid' // plain http to a public host is never allowed
}

function isPrivateLanHost(host: string): boolean {
  // RFC1918 + link-local + .local (LAN n8n is real).
  if (/\.local$/i.test(host)) return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 169 && b === 254) return true
  return false
}

/** May we store/deliver to this URL given the insecure-http acknowledgment? */
export function urlAllowed(raw: string, insecureAck: boolean): { ok: boolean; reason?: string; cls: UrlClass } {
  const cls = classifyWebhookUrl(raw)
  if (cls === 'invalid') return { ok: false, reason: 'use an https URL (or a loopback / private-LAN http one)', cls }
  if (cls === 'http-lan' && !insecureAck) {
    return { ok: false, reason: 'plain http to a LAN address is unencrypted — check “insecure URL” to allow it', cls }
  }
  return { ok: true, cls }
}

export interface DeliverResult {
  ok: boolean
  status?: number
  attempts: number
}

/** POST the payload, at-most-once with 3 exponential retries on failure/5xx.
 *  Never throws; a hung receiver is bounded by the caller's fetch timeout.
 *  `sleep` is injected so the smoke runs without real backoff waits. */
export async function deliverWebhook(
  url: string,
  payload: BridgeEvent,
  deps: {
    fetchFn: (url: string, init: { method: string; headers: Record<string, string>; body: string; redirect: 'error'; signal: AbortSignal }) => Promise<{ status: number }>
    timeoutMs?: number
    sleep?: (ms: number) => Promise<void>
    maxAttempts?: number
  }
): Promise<DeliverResult> {
  const timeoutMs = deps.timeoutMs ?? 5000
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const maxAttempts = deps.maxAttempts ?? 4 // 1 + 3 retries
  const body = JSON.stringify(payload)
  let attempts = 0
  for (let i = 0; i < maxAttempts; i++) {
    attempts++
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await deps.fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'MoggingLabs-Bridge/1' },
        body,
        redirect: 'error', // no redirects, ever
        signal: ctrl.signal
      })
      clearTimeout(timer)
      if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, attempts }
      if (res.status >= 400 && res.status < 500) return { ok: false, status: res.status, attempts } // client error: don't retry
    } catch {
      clearTimeout(timer)
      /* network error / timeout / redirect refused -> retry */
    }
    if (i < maxAttempts - 1) await sleep(200 * 2 ** i)
  }
  return { ok: false, attempts }
}
