import type { UiFeature } from '../../core/registry/feature-registry'
import { UsageChannels, type PlanUsageView } from '@contracts'
import { getBridge } from '../../core/ipc/bridge'
import { el, icon } from '../../components'
import { setActiveView } from '../../core/shell/view-port'

/**
 * Usage at a GLANCE (Phase-7/03): a two-bar titlebar gauge (session over
 * weekly, the CodexBar icon grammar) + an anchored popover that answers
 * "can I keep going, and until when?" in one click. The popover opens on the
 * CACHED snapshot synchronously and refreshes in place — never a spinner
 * wall. Verdict strings arrive PRE-FORMATTED from the one backend formatter
 * (7/02) and render verbatim. No usage value enters telemetry (ADR 0005).
 */

const BADGE_PCT = 90

function fmtCountdown(resetsAt: string, now: number): string | null {
  const t = Date.parse(resetsAt)
  if (!Number.isFinite(t)) return null
  let s = Math.max(0, Math.round((t - now) / 1000))
  const d = Math.floor(s / 86400)
  s -= d * 86400
  const h = Math.floor(s / 3600)
  const m = Math.floor((s - h * 3600) / 60)
  if (d > 0) return `resets in ${d}d ${h}h`
  if (h > 0) return `resets in ${h}h ${m}m`
  return `resets in ${m}m`
}

function fmtAge(fetchedAt: number, now: number): string {
  const s = Math.max(0, Math.round((now - fetchedAt) / 1000))
  if (s < 60) return `as of ${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `as of ${m}m ago`
  return `as of ${Math.round(m / 60)}h ago`
}

/** The tile the GAUGE mirrors: first plan with usable data (the active
 *  profile's lane comes first in the seam's snapshot order). */
const activePlan = (plans: PlanUsageView[]): PlanUsageView | null =>
  plans.find((p) => p.health === 'fresh' || p.health === 'stale') ?? null

export const usageFeature: UiFeature = {
  name: 'usage',
  mount(ctx) {
    const bridge = getBridge()
    let plans: PlanUsageView[] = []

    // ── The gauge (paint-only state flips: CSS vars + classes, no layout) ──
    const barS = el('span', { class: 'usage-fill usage-fill-s' })
    const barW = el('span', { class: 'usage-fill usage-fill-w' })
    const badge = el('span', { class: 'usage-badge', hidden: true })
    const gauge = el(
      'button',
      { class: 'icon-btn usage-gauge', type: 'button', ariaLabel: 'Usage', title: 'Usage' },
      [el('span', { class: 'usage-track' }, [barS]), el('span', { class: 'usage-track' }, [barW]), badge]
    )
    gauge.setAttribute('aria-expanded', 'false')

    const paintGauge = (): void => {
      const p = activePlan(plans)
      gauge.classList.toggle('is-off', !p)
      if (!p) {
        badge.hidden = true
        gauge.title = plans[0]?.reason ? `Usage — ${plans[0].reason}` : 'Usage — not configured yet'
        return
      }
      const s = p.windows[0]?.usedPct ?? 0
      const w = p.windows[1]?.usedPct ?? s
      barS.style.width = `${s}%`
      barW.style.width = `${w}%`
      gauge.classList.toggle('is-warn', p.pace?.verdict === 'runs-out')
      gauge.classList.toggle('is-stale', p.health === 'stale')
      badge.hidden = !p.windows.some((x) => x.usedPct >= BADGE_PCT)
      gauge.title = p.pace ? `${p.planLabel} — ${p.pace.text}` : `${p.planLabel} — ${fmtAge(p.fetchedAt, Date.now())}`
    }

    // ── The popover (cached-snapshot-first; Esc/click-away dismiss) ──
    const pop = el('div', { class: 'menu usage-popover', hidden: true, role: 'dialog', ariaLabel: 'Usage' })
    const wrap = el('span', { class: 'usage-wrap' }, [gauge, pop])
    ctx.titlebarRight.append(wrap)

    const renderPop = (): void => {
      pop.innerHTML = ''
      const now = Date.now()
      if (!plans.length) {
        pop.append(el('div', { class: 'menu-empty', text: 'No usage sources yet — enable a provider in Settings.' }))
      }
      const byProvider = new Map<string, PlanUsageView[]>()
      for (const p of plans) {
        const list = byProvider.get(p.providerId) ?? []
        list.push(p)
        byProvider.set(p.providerId, list)
      }
      for (const [providerId, group] of byProvider) {
        pop.append(el('div', { class: 'usage-group-label section-label', text: providerId }))
        for (const p of group) {
          const tile = el('div', {
            class: 'usage-tile',
            tabIndex: -1,
            dataset: { provider: p.providerId, profile: p.profileId, health: p.health }
          })
          tile.append(
            el('div', { class: 'usage-tile-head' }, [
              el('span', { class: 'usage-plan', text: p.planLabel }),
              el('span', { class: 'usage-profile', text: p.profileId }),
              el('span', { class: `pill usage-health is-${p.health}`, text: p.health })
            ])
          )
          for (const w of p.windows) {
            const cd = w.resetsAt ? fmtCountdown(w.resetsAt, now) : null
            const rowEl = el('div', { class: 'usage-row' }, [
              el('span', { class: 'usage-row-label', text: w.label }),
              el('span', { class: 'usage-track usage-track-row' }, [
                el('span', {
                  class: 'usage-fill' + (w.usedPct >= BADGE_PCT ? ' is-hot' : '')
                })
              ]),
              el('span', { class: 'usage-pct', text: `${Math.round(w.usedPct)}%` }),
              cd ? el('span', { class: 'usage-reset', text: cd }) : null
            ])
            const fill = rowEl.querySelector('.usage-fill') as HTMLElement
            fill.style.width = `${w.usedPct}%`
            if (w.resetsAt) rowEl.title = new Date(w.resetsAt).toLocaleString()
            tile.append(rowEl)
          }
          if (p.pace) {
            tile.append(el('div', { class: `usage-verdict sev-${p.pace.severity}`, text: p.pace.text }))
          } else if (p.reason) {
            tile.append(el('div', { class: 'usage-verdict sev-quiet', text: `${p.reason} — ${fmtAge(p.fetchedAt, now)}` }))
          }
          pop.append(tile)
        }
      }
      const newest = plans.reduce((m, p) => Math.max(m, p.fetchedAt), 0)
      const refreshBtn = el('button', { class: 'icon-btn usage-refresh', type: 'button', ariaLabel: 'Refresh usage', title: 'Refresh' }, [icon('rotate-cw', 13)])
      refreshBtn.addEventListener('click', () => void bridge.invoke(UsageChannels.refresh, undefined))
      const gearBtn = el('button', { class: 'icon-btn usage-gear', type: 'button', ariaLabel: 'Usage settings', title: 'Usage settings' }, [icon('sliders', 13)])
      gearBtn.addEventListener('click', () => {
        close()
        setActiveView('settings')
        requestAnimationFrame(() => {
          document.querySelector('.settings-section[data-section="usage"]')?.scrollIntoView({ block: 'start' })
        })
      })
      pop.append(
        el('div', { class: 'usage-foot' }, [
          el('span', { class: 'usage-age', text: newest ? fmtAge(newest, now) : '' }),
          refreshBtn,
          gearBtn
        ])
      )
    }

    const open = (): void => {
      renderPop() // synchronous, from the cached snapshot — the <100ms rule
      pop.hidden = false
      gauge.setAttribute('aria-expanded', 'true')
      void bridge.invoke(UsageChannels.refresh, undefined) // refresh IN PLACE after paint
    }
    const close = (): void => {
      pop.hidden = true
      gauge.setAttribute('aria-expanded', 'false')
    }

    gauge.addEventListener('click', () => (pop.hidden ? open() : close()))
    document.addEventListener('pointerdown', (e) => {
      if (!pop.hidden && e.target instanceof Node && !wrap.contains(e.target)) close()
    })
    document.addEventListener('keydown', (e) => {
      if (pop.hidden) return
      if (e.key === 'Escape') return close()
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const tiles = [...pop.querySelectorAll<HTMLElement>('.usage-tile')]
        if (!tiles.length) return
        const at = tiles.findIndex((t) => t === document.activeElement)
        const next = e.key === 'ArrowDown' ? Math.min(tiles.length - 1, at + 1) : Math.max(0, at <= 0 ? 0 : at - 1)
        tiles[next].focus()
        e.preventDefault()
      }
      // Enter = switch active profile — 7/09 wires it; disabled until then.
    })

    const apply = (next: PlanUsageView[]): void => {
      plans = next
      paintGauge()
      if (!pop.hidden) renderPop() // refresh in place while open
    }

    bridge.on(UsageChannels.changed, (payload) => apply((payload as PlanUsageView[]) ?? []))
    void bridge.invoke(UsageChannels.list).then((payload) => apply((payload as PlanUsageView[]) ?? []))

    // Dev/smoke handle (the firstrun pattern).
    const g = window as unknown as { __mogging?: Record<string, unknown> }
    g.__mogging = { ...(g.__mogging ?? {}), usage: { open, close } }
  }
}
