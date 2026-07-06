import type { UiFeature } from '../../core/registry/feature-registry'
import { ProfileChannels, UsageChannels, type AgentProfile, type PlanUsageView, type ProviderStatus, type UsageAlert } from '@contracts'
import { getBridge } from '../../core/ipc/bridge'
import { el, icon, showToast } from '../../components'
import { setActiveView } from '../../core/shell/view-port'
import { announceProfilesChanged } from '../../core/agents/profiles-port'
import { getTelemetry } from '../../core/telemetry'

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

/** Severity rank for popover ordering (7/09): runs-out speaks first, then
 *  on-pace, surplus, and unpaceable tiles (error/unconfigured) last;
 *  usage percent breaks ties hotter-first. Layout only — no wording here. */
const severityRank = (p: PlanUsageView): number =>
  p.pace?.verdict === 'runs-out' ? 0 : p.pace?.verdict === 'on-pace' ? 1 : p.pace?.verdict === 'surplus' ? 2 : 3

export const usageFeature: UiFeature = {
  name: 'usage',
  mount(ctx) {
    const bridge = getBridge()
    let plans: PlanUsageView[] = []
    // 7/08: statuses arrive for ENABLED providers only — any outage in the
    // list IS an enabled outage (the poller never tracks disabled rows).
    let statuses: ProviderStatus[] = []
    // 7/09: the Phase-4 profiles — order 0 is the ACTIVE lane for new launches.
    let profiles: AgentProfile[] = []
    let switchHint = '' // the one-line "running panes untouched" note, post-switch

    /** The active profile id for a provider — order 0, or the seam's 'default'
     *  lane when no profiles exist. */
    const activeIdFor = (providerId: string): string => {
      const mine = profiles.filter((p) => p.provider === providerId).sort((a, b) => a.order - b.order)
      return mine[0]?.id ?? 'default'
    }

    /** The tile the GAUGE mirrors: the ACTIVE profile's plan when usable,
     *  else the first plan with usable data. */
    const activePlan = (all: PlanUsageView[]): PlanUsageView | null =>
      all.find((p) => (p.health === 'fresh' || p.health === 'stale') && p.profileId === activeIdFor(p.providerId)) ??
      all.find((p) => p.health === 'fresh' || p.health === 'stale') ??
      null

    const refreshProfiles = async (): Promise<void> => {
      profiles = ((await bridge.invoke(ProfileChannels.list)) as AgentProfile[]) ?? []
    }

    /** ONE switch implementation, two triggers (tile Enter/click + the failover
     *  toast action): flip the Phase-4 order pointers so `profileId` becomes
     *  order 0 for NEW launches. Nothing re-authenticates; running panes keep
     *  the env they were spawned with. */
    const switchActive = async (providerId: string, profileId: string, viaSuggestion: boolean): Promise<void> => {
      await refreshProfiles()
      const mine = profiles.filter((p) => p.provider === providerId).sort((a, b) => a.order - b.order)
      const target = mine.find((p) => p.id === profileId)
      const current = mine[0]
      if (!target || !current || current.id === target.id) return
      await bridge.invoke(ProfileChannels.save, { ...target, order: current.order })
      await bridge.invoke(ProfileChannels.save, { ...current, order: target.order })
      await refreshProfiles()
      announceProfilesChanged() // palette + failover data follow live (Phase-4 port)
      switchHint = `New launches use ${target.name} — running panes keep the profile they started with.`
      paintGauge()
      if (!pop.hidden) renderPop()
      // ids + booleans only (ADR 0005) — never plan names or numbers.
      getTelemetry().captureEvent({ name: 'usage.profileSwitch', props: { provider: providerId, viaSuggestion } })
    }

    // ── The gauge (paint-only state flips: CSS vars + classes, no layout) ──
    const barS = el('span', { class: 'usage-fill usage-fill-s' })
    const barW = el('span', { class: 'usage-fill usage-fill-w' })
    const badge = el('span', { class: 'usage-badge', hidden: true })
    // The incident overlay (7/08): ONE subtle glyph in the badge idiom —
    // armed when any enabled provider reports an outage, never a takeover.
    const incident = el('span', { class: 'usage-incident', hidden: true, title: 'Provider incident reported' })
    const gauge = el(
      'button',
      { class: 'icon-btn usage-gauge', type: 'button', ariaLabel: 'Usage', title: 'Usage' },
      [el('span', { class: 'usage-track' }, [barS]), el('span', { class: 'usage-track' }, [barW]), badge, incident]
    )
    gauge.setAttribute('aria-expanded', 'false')

    const paintGauge = (): void => {
      // Independent of gauge data: an outage badges even an off/unconfigured icon.
      incident.hidden = !statuses.some((s) => s.state === 'outage')
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
        // 7/09: severity orders the tiles — runs-out first, hotter first.
        group.sort((a, b) => severityRank(a) - severityRank(b) || (b.windows[0]?.usedPct ?? 0) - (a.windows[0]?.usedPct ?? 0))
        const activeId = activeIdFor(providerId)
        for (const p of group) {
          const isActive = p.profileId === activeId
          const tile = el('div', {
            class: 'usage-tile' + (isActive ? ' is-active' : ''),
            tabIndex: -1,
            dataset: { provider: p.providerId, profile: p.profileId, health: p.health }
          })
          // Click = switch the active lane (Enter does the same; 7/09). A tile
          // with no matching Phase-4 profile is display-only — nothing to flip.
          tile.addEventListener('click', () => void switchActive(p.providerId, p.profileId, false))
          const st = statuses.find((s) => s.providerId === p.providerId)
          const chip =
            st && (st.state === 'degraded' || st.state === 'outage')
              ? el('span', { class: `pill usage-status is-${st.state}`, text: st.state, title: st.note ?? '' })
              : null
          tile.append(
            el('div', { class: 'usage-tile-head' }, [
              el('span', { class: 'usage-plan', text: p.planLabel }),
              el('span', { class: 'usage-profile', text: p.profileId }),
              chip,
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
      // The one-line post-switch hint: pointers flipped for NEW launches only.
      if (switchHint) pop.append(el('div', { class: 'usage-switch-hint', text: switchHint }))
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
      void refreshProfiles().then(() => {
        if (!pop.hidden) renderPop() // active marking follows Settings edits
      })
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
      // Enter = switch the active lane to the focused tile's profile (7/09).
      if (e.key === 'Enter') {
        const t = document.activeElement
        if (t instanceof HTMLElement && t.classList.contains('usage-tile') && t.dataset.provider && t.dataset.profile) {
          void switchActive(t.dataset.provider, t.dataset.profile, false)
          e.preventDefault()
        }
      }
    })

    const apply = (next: PlanUsageView[]): void => {
      plans = next
      paintGauge()
      if (!pop.hidden) renderPop() // refresh in place while open
    }

    const applyStatuses = (next: ProviderStatus[]): void => {
      statuses = next
      paintGauge()
      if (!pop.hidden) renderPop()
    }

    // 7/09: the OPTIONAL reset flourish — one notch above silence, ~1s of
    // small falling flecks anchored to the toast corner, then gone.
    const spawnConfetti = (): void => {
      const burst = el('div', { class: 'usage-confetti', ariaLabel: '' })
      for (let i = 0; i < 14; i++) {
        const f = el('span', { class: 'usage-confetti-fleck' })
        f.style.left = `${6 + ((i * 23) % 88)}%`
        f.style.animationDelay = `${(i % 7) * 60}ms`
        f.style.background = ['var(--accent)', 'var(--warning)', 'var(--danger)'][i % 3]
        burst.append(f)
      }
      document.body.append(burst)
      setTimeout(() => burst.remove(), 1600)
    }

    // 7/09 threshold alerts -> the HOUSE toast, copy rendered VERBATIM (title
    // + body composed main-side; the warn body IS the 7/02 verdict line). The
    // failover action is a SUGGESTION — the human clicks, the pointers flip.
    const onAlert = (a: UsageAlert): void => {
      if (!a || typeof a.title !== 'string') return
      showToast({
        tone: a.kind === 'reset' ? 'neutral' : a.level === 'warn' ? 'attention' : 'info',
        title: a.title,
        body: a.body || undefined,
        timeout: a.level === 'warn' ? 15000 : 6000,
        action: a.failover
          ? { label: `Fail over to ${a.failover.profileName}`, onClick: () => void switchActive(a.providerId, a.failover!.profileId, true) }
          : undefined
      })
      if (a.confetti) spawnConfetti()
      // Class + booleans ONLY (ADR 0005) — never plan names or numbers.
      getTelemetry().captureEvent({
        name: 'usage.alert',
        props: { kind: a.kind, level: a.level ?? 'none', failoverOffered: !!a.failover, confetti: !!a.confetti }
      })
    }

    bridge.on(UsageChannels.changed, (payload) => apply((payload as PlanUsageView[]) ?? []))
    bridge.on(UsageChannels.statusChanged, (payload) => applyStatuses((payload as ProviderStatus[]) ?? []))
    bridge.on(UsageChannels.alert, (payload) => onAlert(payload as UsageAlert))
    void refreshProfiles().then(() => paintGauge())
    void bridge.invoke(UsageChannels.list).then((payload) => apply((payload as PlanUsageView[]) ?? []))
    void bridge.invoke(UsageChannels.status).then((payload) => applyStatuses((payload as ProviderStatus[]) ?? []))

    // Dev/smoke handle (the firstrun pattern).
    const g = window as unknown as { __mogging?: Record<string, unknown> }
    g.__mogging = { ...(g.__mogging ?? {}), usage: { open, close } }
  }
}
