import {
  SERVICE_LINK_CADENCE_MS,
  type LinkStatus,
  type ServiceAdapter,
  type ServiceLink,
  type ServiceReviewDecision,
  type ServiceLinkState
} from '@contracts'

// The service poller/registry (Phase-8/12), the usage-seam discipline cloned:
// per-link cadence (manual/1m/5m/15m), jitter, exponential backoff on error,
// paused while hidden, and the LAST GOOD status cached — stale is a state, not
// an error. One bounded request per link per tick; a 429 dims to stale, never a
// retry storm. Electron-free; main injects the adapters + the notify/push sinks.

const FETCH_TIMEOUT_MS = 8000
const MAX_BACKOFF_MS = 30 * 60_000

interface LinkRuntime {
  link: ServiceLink
  status?: LinkStatus
  timer?: ReturnType<typeof setTimeout>
  backoff: number // added to the cadence after consecutive errors
}

export interface EngineDeps {
  adapters: Record<string, ServiceAdapter>
  onPush: () => void
  /** A review/merge/close TRANSITION on a linked card — main lands the notify. */
  onTransition: (link: ServiceLink, label: string) => void
  jitter?: () => number // 0..1; injectable so smokes are deterministic
}

export class ServiceEngine {
  private readonly links = new Map<string, LinkRuntime>()
  private visible = true
  constructor(private readonly deps: EngineDeps) {}

  snapshot(): { statuses: LinkStatus[]; at: number } {
    const statuses: LinkStatus[] = []
    for (const rt of this.links.values()) if (rt.status) statuses.push(rt.status)
    return { statuses, at: Date.now() }
  }

  statusFor(linkId: string): LinkStatus | undefined {
    return this.links.get(linkId)?.status
  }

  setLinks(links: ServiceLink[]): void {
    const next = new Set(links.map((l) => l.id))
    for (const id of [...this.links.keys()]) if (!next.has(id)) this.removeLink(id)
    for (const link of links) {
      const existing = this.links.get(link.id)
      if (existing) {
        existing.link = link
        this.reschedule(link.id)
      } else {
        this.addLink(link)
      }
    }
  }

  addLink(link: ServiceLink): void {
    if (this.links.has(link.id)) return
    this.links.set(link.id, { link, backoff: 0 })
    void this.tick(link.id)
  }

  removeLink(linkId: string): void {
    const rt = this.links.get(linkId)
    if (rt?.timer) clearTimeout(rt.timer)
    this.links.delete(linkId) // unlinking stops the poll
  }

  setVisible(v: boolean): void {
    const was = this.visible
    this.visible = v
    if (v && !was) for (const id of this.links.keys()) this.reschedule(id) // resume
  }

  refresh(linkId: string): void {
    void this.tick(linkId)
  }
  refreshAll(): void {
    for (const id of this.links.keys()) void this.tick(id)
  }

  private reschedule(linkId: string): void {
    const rt = this.links.get(linkId)
    if (!rt) return
    if (rt.timer) clearTimeout(rt.timer)
    if (rt.link.cadence === 'manual' || !this.visible) return // manual + hidden: no ticks
    const base = SERVICE_LINK_CADENCE_MS[rt.link.cadence] + rt.backoff
    const jitter = (this.deps.jitter ?? Math.random)()
    rt.timer = setTimeout(() => void this.tick(linkId), base + Math.floor(base * 0.15 * jitter))
  }

  private async tick(linkId: string): Promise<void> {
    const rt = this.links.get(linkId)
    if (!rt) return
    if (!this.visible) {
      this.reschedule(linkId)
      return
    }
    await this.fetchOnce(rt)
    this.reschedule(linkId)
  }

  private async fetchOnce(rt: LinkRuntime): Promise<void> {
    const adapter = this.deps.adapters[rt.link.service]
    const prev = rt.status
    if (!adapter) {
      rt.status = { linkId: rt.link.id, health: 'unconfigured', fetchedAt: Date.now(), reason: `no adapter for ${rt.link.service}` }
      this.deps.onPush()
      return
    }
    const det = await adapter.detect().catch(() => ({ ok: false, reason: 'detect failed' }))
    if (!det.ok) {
      rt.status = { linkId: rt.link.id, health: 'unconfigured', fetchedAt: Date.now(), reason: det.reason }
      this.deps.onPush()
      return
    }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    try {
      const status = await adapter.fetch(rt.link, ctrl.signal)
      rt.backoff = 0
      rt.status = status
      const label = transitionLabel(rt.link, prev, status)
      if (label) this.deps.onTransition(rt.link, label)
    } catch (e) {
      rt.backoff = Math.min(rt.backoff ? rt.backoff * 2 : SERVICE_LINK_CADENCE_MS['5m'], MAX_BACKOFF_MS)
      const reason = (e instanceof Error ? e.message : 'fetch failed').slice(0, 120)
      // Last good re-served as STALE; nothing prior -> error. Never a throw out.
      rt.status = prev
        ? { ...prev, health: 'stale', reason }
        : { linkId: rt.link.id, health: 'error', fetchedAt: Date.now(), reason }
    } finally {
      clearTimeout(timer)
    }
    this.deps.onPush()
  }
}

/** A short, ADR-0005-safe label for a review/merge/close transition, or null. */
export function transitionLabel(link: ServiceLink, prev: LinkStatus | undefined, next: LinkStatus): string | null {
  const num = link.ref.split('#')[1] ?? '?'
  const tag = link.kind === 'issue' ? `Issue #${num}` : `PR #${num}`
  const reviewChanged = next.reviewDecision && next.reviewDecision !== prev?.reviewDecision
  const stateChanged = next.state && next.state !== prev?.state && (next.state === 'merged' || next.state === 'closed')
  if (!prev) return null // first fetch is not a transition
  if (stateChanged) return `${tag}: ${next.state}`
  if (reviewChanged) return `${tag}: ${reviewCopy(next.reviewDecision!)}`
  return null
}

function reviewCopy(d: ServiceReviewDecision): string {
  return d === 'changes-requested' ? 'changes requested' : d === 'approved' ? 'approved' : 'review required'
}

export type { ServiceLinkState }
