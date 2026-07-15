import type { UiFeature } from '../../core/registry/feature-registry'
import { BrowserChannels, ProfileChannels, UsageChannels, USAGE_DISPLAY_DEFAULTS, findProvider, type AgentProfile, type CostScan, type PlanUsageView, type ProviderStatus, type UsageAlert, type UsageDisplayConfig } from '@contracts'
import { createAsyncGuard } from '../../core/async/async-state'
import { getBridge } from '../../core/ipc/bridge'
import { announce } from '../../core/a11y/live-region'
import { clear, el, icon, providerLogo, showToast } from '../../components'
import { setActiveView } from '../../core/shell/view-port'
import { requestSettingsTab } from '../../core/shell/settings-tab-port'
import { switchActiveProfile } from '../../core/agents/profile-switch'
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

// Reset lines arrive PRE-FORMATTED on each window (`resetText`, 7/10) from
// the ONE backend reset formatter — this file never re-spells them.

/** The ONE relative-age formatter (8/05's trail viewer reuses it verbatim). */
export function fmtAge(fetchedAt: number, now: number): string {
  const s = Math.max(0, Math.round((now - fetchedAt) / 1000))
  if (s < 60) return `as of ${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `as of ${m}m ago`
  return `as of ${Math.round(m / 60)}h ago`
}

/** Cost-line formatters (08c) for the CodexBar cost row — a display estimate,
 *  never a bill (ADR 0007). Money keeps 2 decimals; tokens go compact. */
const fmtMoney = (n: number): string => n.toFixed(2)
const fmtTok = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n))

/** Severity rank for popover ordering (7/09): runs-out speaks first, then
 *  on-pace, surplus, and unpaceable tiles (error/unconfigured) last;
 *  usage percent breaks ties hotter-first. Layout only — no wording here. */
const severityRank = (p: PlanUsageView): number =>
  p.pace?.verdict === 'runs-out' ? 0 : p.pace?.verdict === 'on-pace' ? 1 : p.pace?.verdict === 'surplus' ? 2 : 3

/** The ONE tabpanel the provider tabs own (`aria-controls`), and the id scheme
 *  that lets the panel name itself after the selected tab. The feature mounts
 *  once per window, so a fixed id is a fixed id. */
const PANEL_ID = 'usage-tabpanel'
const tabDomId = (id: string): string => `usage-tab-${id}`

/**
 * THE bar painter. A track that paints a width must also SAY the width — the
 * house contract (components/meter.ts): `role="progressbar"` + aria-valuenow/
 * min/max, or the fill is a picture no screen reader can read, and this file
 * paints six of them (two on the gauge, one per window row, one per lane tile).
 * Every width goes through here, INCLUDING the zeroes: the name is part of the
 * paint, so an emptied gauge cannot keep announcing the window it no longer shows.
 */
const paintBar = (track: HTMLElement, fill: HTMLElement, usedPct: number, label = ''): void => {
  const v = Math.max(0, Math.min(100, Math.round(usedPct)))
  fill.style.width = `${usedPct}%`
  track.setAttribute('role', 'progressbar')
  track.setAttribute('aria-valuenow', String(v))
  track.setAttribute('aria-valuemin', '0')
  track.setAttribute('aria-valuemax', '100')
  if (label) track.setAttribute('aria-label', `${label} — ${v}% used`)
  else track.removeAttribute('aria-label')
}

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
    // 7/10: display prefs — WHICH plan the gauge mirrors, WHAT the icon
    // shows, how resets render. Painted, never decided, on this side.
    let display: UsageDisplayConfig = { ...USAGE_DISPLAY_DEFAULTS }

    /** The active profile id for a provider — order 0, or the seam's 'default'
     *  lane when no profiles exist. */
    const activeIdFor = (providerId: string): string => {
      const mine = profiles.filter((p) => p.provider === providerId).sort((a, b) => a.order - b.order)
      return mine[0]?.id ?? 'default'
    }

    const usable = (p: PlanUsageView): boolean => p.health === 'fresh' || p.health === 'stale'

    /** Highest severity first, hotter first — the merged-mode pick. */
    const bestBySeverity = (all: PlanUsageView[]): PlanUsageView | null => {
      const u = all.filter(usable)
      if (!u.length) return null
      return u.slice().sort((a, b) => severityRank(a) - severityRank(b) || (b.windows[0]?.usedPct ?? 0) - (a.windows[0]?.usedPct ?? 0))[0]
    }

    /** The plan the ONE titlebar gauge mirrors, per display mode (7/10):
     *  merged = highest severity · pinned = the chosen provider (active lane
     *  preferred) · auto = highest usage. Falls back to merged when a pin has
     *  no data — an empty gauge helps nobody. */
    const gaugePlan = (): PlanUsageView | null => {
      if (display.mode === 'pinned' && display.pin) {
        const mine = plans.filter((p) => usable(p) && p.providerId === display.pin)
        const active = mine.find((p) => p.profileId === activeIdFor(display.pin ?? ''))
        if (active) return active
        const best = bestBySeverity(mine)
        if (best) return best
      }
      if (display.mode === 'auto') {
        const u = plans.filter(usable)
        if (u.length) return u.slice().sort((a, b) => (b.windows[0]?.usedPct ?? 0) - (a.windows[0]?.usedPct ?? 0))[0]
      }
      return bestBySeverity(plans)
    }

    const refreshProfiles = async (): Promise<void> => {
      profiles = ((await bridge.invoke(ProfileChannels.list)) as AgentProfile[]) ?? []
    }

    /** ONE switch implementation (ui-core, shared with the Settings plans
     *  table), N triggers here: tile Enter/click + the failover toast action. */
    const switchActive = async (providerId: string, profileId: string, viaSuggestion: boolean): Promise<void> => {
      try {
        const targetName = await switchActiveProfile(providerId, profileId)
        if (!targetName) return
        await refreshProfiles()
        switchHint = `New launches use ${targetName} — running panes keep the profile they started with.`
        paintGauge()
        if (!pop.hidden) renderPop()
        // ids + booleans only (ADR 0005) — never plan names or numbers.
        getTelemetry().captureEvent({ name: 'usage.profileSwitch', props: { provider: providerId, viaSuggestion } })
      } catch (error) {
        showToast({ tone: 'danger', title: 'Default profile was not changed', body: String(error) })
      }
    }

    // ── The gauge (paint-only state flips: CSS vars + classes, no layout) ──
    const barS = el('span', { class: 'usage-fill usage-fill-s' })
    const barW = el('span', { class: 'usage-fill usage-fill-w' })
    const badge = el('span', { class: 'usage-badge', hidden: true })
    // The incident overlay (7/08): ONE subtle glyph in the badge idiom —
    // armed when any enabled provider reports an outage, never a takeover.
    const incident = el('span', { class: 'usage-incident', hidden: true, title: 'Provider incident reported' })
    // 7/10 content options: every element always EXISTS — classes decide what
    // paints (the toggles change classes, never structure).
    const glyph = el('span', { class: 'usage-glyph' })
    const pctNum = el('span', { class: 'usage-pct-num' })
    const glabel = el('span', { class: 'usage-glabel' })
    // The tracks are NAMED (not anonymous children of the button) because
    // paintGauge has to voice them, not just size them — see paintBar.
    const trackS = el('span', { class: 'usage-track' }, [barS])
    const trackW = el('span', { class: 'usage-track' }, [barW])
    const gauge = el(
      'button',
      { class: 'icon-btn usage-gauge', type: 'button', ariaLabel: 'Usage', title: 'Usage' },
      [glyph, trackS, trackW, pctNum, glabel, badge, incident]
    )
    gauge.setAttribute('aria-expanded', 'false')

    const paintGauge = (): void => {
      // Independent of gauge data: an outage badges even an off/unconfigured icon.
      incident.hidden = !statuses.some((s) => s.state === 'outage')
      gauge.classList.toggle('hide-bars', !display.showBars)
      gauge.classList.toggle('show-pct', display.showPct)
      gauge.classList.toggle('show-glyph', display.showGlyph)
      gauge.classList.toggle('show-label', display.showLabel)
      gauge.dataset.mode = display.mode
      const p = gaugePlan()
      gauge.classList.toggle('is-off', !p)
      if (!p) {
        // NOTHING may outlive the plan that painted it. This branch used to reset
        // the badge and the two data-attrs and LEAVE — so the glyph, the percent,
        // the provider label, is-warn and is-stale all kept the last usable plan's
        // paint. `is-off` is not the safety net it looks like: it only zeroes the
        // bar FILL in CSS, while the glyph/percent/label ride an INDEPENDENT class
        // set (show-glyph/show-pct/show-label). A user with those options on read a
        // stale percentage and a stale provider name on a gauge whose own title said
        // "not configured yet" — and a dimmed one, since is-stale survived too.
        badge.hidden = true
        delete gauge.dataset.provider
        delete gauge.dataset.profile
        paintBar(trackS, barS, 0)
        paintBar(trackW, barW, 0)
        glyph.replaceChildren()
        pctNum.textContent = ''
        glabel.textContent = ''
        gauge.classList.remove('is-warn', 'is-stale')
        gauge.title = plans[0]?.reason ? `Usage — ${plans[0].reason}` : 'Usage — not configured yet'
        return
      }
      gauge.dataset.provider = p.providerId
      gauge.dataset.profile = p.profileId
      const s = p.windows[0]?.usedPct ?? 0
      const w = p.windows[1]?.usedPct ?? s
      paintBar(trackS, barS, s, p.windows[0]?.label ?? p.planLabel)
      paintBar(trackW, barW, w, p.windows[1]?.label ?? p.windows[0]?.label ?? p.planLabel)
      glyph.replaceChildren(providerLogo(p.providerId, 13))
      pctNum.textContent = `${Math.round(s)}%`
      glabel.textContent = p.providerId
      gauge.classList.toggle('is-warn', p.pace?.verdict === 'runs-out')
      gauge.classList.toggle('is-stale', p.health === 'stale')
      badge.hidden = !p.windows.some((x) => x.usedPct >= BADGE_PCT)
      gauge.title = p.pace ? `${p.planLabel} — ${p.pace.text}` : `${p.planLabel} — ${fmtAge(p.fetchedAt, Date.now())}`
    }

    // ── The popover (cached-snapshot-first; Esc/click-away dismiss) ──
    const pop = el('div', { class: 'menu usage-popover', hidden: true, role: 'dialog', ariaLabel: 'Usage' })
    const wrap = el('span', { class: 'usage-wrap' }, [gauge, pop])
    ctx.titlebarRight.append(wrap)

    /** Persist + reflect a display-mode change (the provider tabs' click). The
     *  KV (`usage.display.*`) and the state machine are UNCHANGED — only the
     *  trigger moved from a <select> to tabs. */
    const setDisplay = (patch: Partial<UsageDisplayConfig>): void => {
      display = { ...display, ...patch } // optimistic paint; main echoes via displayChanged
      paintGauge()
      void bridge.invoke(UsageChannels.displaySet, patch)
      // Mode enum ONLY (ADR 0005) — never the pinned provider id.
      getTelemetry().captureEvent({ name: 'usage.display', props: { mode: display.mode } })
      renderPop() // the popover follows the gauge's selection
    }

    /** The KEPT footer (05b's theme check): snapshot age + in-place refresh. */
    const popFoot = (now: number): HTMLElement => {
      const newest = plans.reduce((m, p) => Math.max(m, p.fetchedAt), 0)
      const refreshBtn = el('button', { class: 'icon-btn usage-refresh', type: 'button', ariaLabel: 'Refresh usage', title: 'Refresh' }, [icon('rotate-cw', 13)])
      refreshBtn.addEventListener('click', () => {
        announce('Refreshing usage') // A11Y-01: the gauge update is otherwise silent
        void bridge.invoke(UsageChannels.refresh, undefined)
      })
      return el('div', { class: 'usage-foot' }, [el('span', { class: 'usage-age', text: newest ? fmtAge(newest, now) : '' }), refreshBtn])
    }

    // Finding 39: the cost scan's guard lives OUT here, at mount scope, on purpose. paintPop runs
    // again on every usage push and every tab arrow, and each paint fires a scan — a guard built
    // inside the paint would have no memory of the paint before it, and the memory IS the
    // generation: the answer for the provider tab you just left must never land in the tab you are
    // now reading.
    const costGuard = createAsyncGuard<CostScan>()

    // ── The popover, recut to the CodexBar dropdown (08c): provider tabs, then
    //    the selected provider's ACTIVE lane — header · windows · pace · credits ·
    //    cost · actions · profile switch · footer. The LAYOUT is copied; the DATA
    //    is ours — every element is backed by IPC, and a slot we can't back (a $
    //    cap, a faked Sonnet meter, in-popover add-account) is dropped, not invented.
    const paintPop = (): void => {
      clear(pop)
      pop.classList.toggle('is-compact', display.density === 'compact')
      const now = Date.now()

      const byProvider = new Map<string, PlanUsageView[]>()
      for (const p of plans) {
        const list = byProvider.get(p.providerId) ?? []
        list.push(p)
        byProvider.set(p.providerId, list)
      }
      if (!plans.length) {
        pop.append(el('div', { class: 'menu-empty', text: 'No usage sources yet — enable a provider in Settings.' }))
        pop.append(popFoot(now))
        return
      }
      // A provider with a plan IS an enabled/polled provider (the poller only
      // tracks enabled rows) — the tab set, worst-severity first. `display.order`
      // is a REAL control (Settings § Usage writes both it and `pinOrder`, and
      // main persists them) that this paint simply never READ: the manual order
      // was stored and thrown away on every repaint, so the knob did nothing.
      // Manual = the pinOrder's index; a provider the list does not name falls in
      // BEHIND the named ones, severity-sorted among its unnamed peers (a pin list
      // is a preference, not a filter). Severity — the default — is 09's rule, as
      // it was. The header still shows the highest-severity plan either way: the
      // ORDER of the strip is a layout choice, not a change of subject.
      const sevOf = (id: string): number => {
        const best = bestBySeverity(byProvider.get(id) ?? [])
        return best ? severityRank(best) : 9
      }
      const pinAt = (id: string): number => {
        const i = display.pinOrder.indexOf(id)
        return i < 0 ? Infinity : i // unnamed -> behind every named one
      }
      const providerIds = [...byProvider.keys()].sort((a, b) => {
        if (display.order === 'manual') {
          const pa = pinAt(a)
          const pb = pinAt(b)
          // Two UNNAMED providers compare Infinity to Infinity — equal, so they
          // fall through to severity rather than returning NaN from the subtraction.
          if (pa !== pb) return pa - pb
        }
        return sevOf(a) - sevOf(b)
      })

      // ── Provider tabs (step 1): All · Auto · one per enabled provider ──
      // A real APG tablist, not a row of buttons wearing role=tab: ONE tab stop
      // for the whole strip (roving tabIndex — every tab being natively tabbable
      // made the user Tab through N providers to leave), each tab OWNS the panel
      // below it (aria-controls -> the one tabpanel), and Left/Right/Home/End
      // drive it from the keyboard (the popover-wide keydown handler).
      const tabs = el('div', { class: 'usage-tabs', role: 'tablist', ariaLabel: 'Gauge shows' })
      const panel = el('div', { class: 'usage-panel', role: 'tabpanel', attrs: { id: PANEL_ID } })
      const modeTab = (id: string, label: string, on: boolean, onClick: () => void): HTMLElement => {
        const t = el(
          'button',
          {
            class: 'usage-tab usage-tab-mode' + (on ? ' is-selected' : ''),
            type: 'button',
            role: 'tab',
            tabIndex: on ? 0 : -1,
            dataset: { tab: id },
            attrs: { id: tabDomId(id), 'aria-controls': PANEL_ID }
          },
          [el('span', { class: 'usage-tab-label', text: label })]
        )
        t.setAttribute('aria-selected', String(on))
        t.addEventListener('click', onClick)
        return t
      }
      tabs.append(modeTab('all', 'All', display.mode === 'merged', () => setDisplay({ mode: 'merged' })))
      tabs.append(modeTab('auto', 'Auto', display.mode === 'auto', () => setDisplay({ mode: 'auto' })))
      for (const id of providerIds) {
        const on = display.mode === 'pinned' && display.pin === id
        const mine = byProvider.get(id)!
        const lane = mine.find((p) => p.profileId === activeIdFor(id)) ?? mine[0]
        const usedPct = lane?.windows[0]?.usedPct ?? 0
        const t = el(
          'button',
          {
            class: 'usage-tab' + (on ? ' is-selected' : ''),
            type: 'button',
            role: 'tab',
            tabIndex: on ? 0 : -1,
            dataset: { tab: id },
            attrs: { id: tabDomId(id), 'aria-controls': PANEL_ID }
          },
          [
            el('span', { class: 'usage-tab-glyph' }, [providerLogo(id, 13)]),
            el('span', { class: 'usage-tab-label', text: findProvider(id)?.label ?? id }),
            // The chip's hairline stays a picture ON PURPOSE: role=progressbar here
            // would join the TAB's name-from-content computation and the tab would
            // announce itself twice ("Claude, Claude 45% used"). The same number is
            // voiced by the row bars inside the panel, where it has room to be read.
            el('span', { class: 'usage-tab-track' }, [
              el('span', { class: 'usage-tab-fill' + (usedPct >= BADGE_PCT ? ' is-hot' : '') })
            ])
          ]
        )
        ;(t.querySelector('.usage-tab-fill') as HTMLElement).style.width = `${usedPct}%`
        t.setAttribute('aria-selected', String(on))
        t.addEventListener('click', () => setDisplay({ mode: 'pinned', pin: id }))
        tabs.append(t)
      }
      // Exactly ONE tab stop: the selected tab — or the first, when a pin names a
      // provider that has no plans and nothing is selected (the strip would
      // otherwise be unreachable by Tab entirely).
      const tabEls = [...tabs.querySelectorAll<HTMLElement>('.usage-tab')]
      if (tabEls.length && !tabEls.some((t) => t.tabIndex === 0)) tabEls[0].tabIndex = 0
      const selectedTab = tabEls.find((t) => t.getAttribute('aria-selected') === 'true') ?? tabEls[0]
      if (selectedTab) panel.setAttribute('aria-labelledby', selectedTab.id)
      pop.append(tabs, panel)

      // The focused provider mirrors the gauge's selection; its ACTIVE lane is
      // the stack, its profiles the switch row.
      const shown = gaugePlan()
      const shownProvider = shown?.providerId ?? providerIds[0]
      const provPlans = byProvider.get(shownProvider) ?? []
      const activeProfileId = activeIdFor(shownProvider)
      const activePlan = provPlans.find((p) => p.profileId === activeProfileId) ?? shown ?? provPlans[0]
      if (!activePlan) {
        pop.append(popFoot(now))
        return
      }

      // Provider status (7/08) is per-PROVIDER; it rides the profile tiles below (where
      // the outage smoke reads it) — not the header, which stays name · age · tier · health.
      const provStatus = statuses.find((s) => s.providerId === shownProvider)
      const outaged = !!provStatus && (provStatus.state === 'degraded' || provStatus.state === 'outage')

      // ── Header (step 2), the CodexBar grammar: name (bold) left, the plan
      //    tier as a quiet badge right. Freshness lives in the footer; the
      //    health pill only appears when it is NEWS (stale/error) — a pill
      //    that always says "fresh" is text with no information in it.
      const tierText = activePlan.planLabel.replace(new RegExp(`^${findProvider(shownProvider)?.label ?? shownProvider}\\s*`, 'i'), '').replace(/^\((.*)\)$/, '$1')
      const head = el('div', { class: 'usage-glance-head' }, [
        providerLogo(shownProvider, 16),
        el('span', { class: 'usage-glance-name', text: findProvider(shownProvider)?.label ?? shownProvider }),
        activePlan.health !== 'fresh' ? el('span', { class: `pill usage-health is-${activePlan.health}`, text: activePlan.health }) : null,
        tierText ? el('span', { class: 'usage-glance-tier', text: tierText }) : null
      ])
      panel.append(head)

      // ── Windows (step 3): a row per UsageWindow, and EVERY paceable window
      //    carries its own pace line — the session limit and the weekly limit
      //    (and any model lane) each answer "at this rate, do I make it?".
      //    .usage-verdict renders pace.text VERBATIM (golden-locked); the delta
      //    is a separate .usage-pace-delta. Both inked sev-${severity}. ──
      for (const w of activePlan.windows) {
        // The expected-pace TICK (CodexBar): a hairline on the bar at "where
        // you should be by now" — fill past the tick = hotter than the budget,
        // readable without the verdict line.
        const fill = el('span', { class: 'usage-fill' + (w.usedPct >= BADGE_PCT ? ' is-hot' : '') })
        const track = el('span', { class: 'usage-track usage-track-row' }, [
          fill,
          w.pace?.elapsedPct !== undefined ? el('span', { class: 'usage-tick', title: `expected by now: ${w.pace.elapsedPct}%` }) : null
        ])
        paintBar(track, fill, w.usedPct, w.label) // the bar SAYS its number, not just draws it
        // The CodexBar row anatomy: label on its own line, the full-width bar
        // under it, then ONE stats line — percent left, reset right. Three
        // quiet lines instead of four things fighting for one.
        const row = el('div', { class: 'usage-row' }, [
          el('span', { class: 'usage-row-label', text: w.label }),
          track,
          el('span', { class: 'usage-row-stats' }, [
            el('span', { class: 'usage-pct', text: `${Math.round(w.usedPct)}% used` }),
            w.resetText ? el('span', { class: 'usage-reset', text: w.resetText }) : null
          ])
        ])
        const tick = row.querySelector('.usage-tick') as HTMLElement | null
        if (tick && w.pace?.elapsedPct !== undefined) tick.style.left = `${w.pace.elapsedPct}%`
        if (w.resetsAt) row.title = new Date(w.resetsAt).toLocaleString()
        panel.append(row)
        if (w.pace)
          panel.append(
            el('div', { class: 'usage-pace' }, [
              el('span', { class: `usage-verdict sev-${w.pace.severity}`, text: w.pace.text }),
              el('span', { class: `usage-pace-delta sev-${w.pace.severity}`, text: w.pace.deltaText }),
              // The risk estimate rides quietly AFTER the verdict, never inside
              // it (the verdict wording is golden-locked); absent = no noise.
              w.pace.riskText ? el('span', { class: 'usage-risk', text: w.pace.riskText }) : null
            ])
          )
      }
      if (!activePlan.pace && activePlan.reason)
        panel.append(el('div', { class: 'usage-verdict sev-quiet', text: `${activePlan.reason} — ${fmtAge(activePlan.fetchedAt, now)}` }))

      // ── Credits / spend (step 4): Claude's extra-usage box carries its cap
      //    ("This month: $used / $limit · N% used" — the CodexBar grammar);
      //    a spend with no cap stays the plain figure it always was. ──
      if (activePlan.credits)
        panel.append(el('div', { class: 'usage-credits', text: `${activePlan.credits.remaining} ${activePlan.credits.label}` }))
      else if (activePlan.spend) {
        const s = activePlan.spend
        const cur = s.currency === 'USD' ? '$' : s.currency
        const text = s.limit
          ? `Extra usage — this month: ${cur}${fmtMoney(s.amount)} / ${cur}${fmtMoney(s.limit)} · ${Math.round((s.amount / s.limit) * 100)}% used`
          : `${cur}${fmtMoney(s.amount)}`
        panel.append(el('div', { class: 'usage-credits', text }))
      }

      // ── Cost (step 4): usage:cost → CostScan, filled async; › opens the full
      //    Cost overview in § Usage. Beyond the CodexBar two-liner: today's
      //    share of the window, the daily average, and where the month is
      //    heading at this week's pace — the glance version of the dashboard. ──
      const costRow = el('button', { class: 'usage-cost menu-item', type: 'button', title: 'Local cost scan — opens the Cost overview' }, [
        icon('clock', 14),
        el('span', { class: 'usage-cost-text', text: 'Cost…' }),
        el('span', { class: 'usage-cost-more', text: '›' })
      ])
      costRow.addEventListener('click', () => {
        close()
        requestSettingsTab('usage')
        setActiveView('settings')
      })
      panel.append(costRow)
      const costLines = el('div', { class: 'usage-cost-lines' })
      panel.append(costLines)
      const costText = costRow.querySelector('.usage-cost-text') as HTMLElement
      /**
       * Finding 39, the audit's quietest lie: this row was BORN saying "Cost…" and only ever
       * changed inside `.then()`, under a `.catch(() => undefined)` that threw the reason away. A
       * scan that never came back left the ellipsis standing forever; a scan that failed left it
       * standing AND silent. An ellipsis is a promise that an answer is coming — so the timeout
       * makes the hang terminal, and onError replaces the promise with what actually happened plus
       * the retry the row never had. `isConnected` is the staleness test that matters: a repaint
       * has already replaced this row, and the answer to a question nobody is asking any more must
       * not paint into a node that is no longer on screen.
       */
      const scanCost = (): void => {
        void costGuard.run(() => bridge.invoke(UsageChannels.cost, shownProvider) as Promise<CostScan>, {
          action: 'scan this provider’s cost log',
          onLoading: () => {
            costText.textContent = 'Cost…'
            costLines.replaceChildren() // a retry must first clear the failure it is retrying
          },
          onSuccess: (scan) => {
            if (!costRow.isConnected) return
            if (!scan || !scan.days.length) {
              costText.textContent = 'Cost —' // no cost log
              return
            }
            costText.textContent = 'Cost'
            const cur = scan.currency === 'USD' ? '$' : scan.currency
            const p2 = (n: number): string => `${cur}${fmtMoney(n)}`
            const todayStr = ((): string => {
              const d = new Date()
              const p = (n: number): string => String(n).padStart(2, '0')
              return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
            })()
            const today = scan.days.find((d) => d.date === todayStr)
            const sum = scan.days.reduce((a, d) => a + d.spend, 0)
            const tok = scan.days.reduce((a, d) => a + d.tokens, 0)
            const todayPct = sum > 0 && today ? Math.round((today.spend / sum) * 100) : 0
            const last7 = scan.days.filter((d) => Date.parse(d.date) >= Date.now() - 7 * 86_400_000).reduce((a, d) => a + d.spend, 0)
            const line = (label: string, value: string): HTMLElement =>
              el('div', { class: 'usage-cost-line' }, [
                el('span', { class: 'usage-cost-label', text: label }),
                el('span', { class: 'usage-cost-value', text: value })
              ])
            costLines.append(
              line('Today', today ? `${p2(today.spend)} · ${fmtTok(today.tokens)} tokens · ${todayPct}% of 30d` : `${p2(0)} · nothing yet`),
              line('Last 30 days', `${p2(sum)} · ${fmtTok(tok)} tokens`),
              line('Daily average', `${p2(scan.days.length ? sum / scan.days.length : 0)} per active day`),
              line('Projected monthly', `${p2((last7 / 7) * 30)} at this week's pace`)
            )
          },
          onError: (message) => {
            if (!costRow.isConnected) return
            // Inline, never a toast: the popover is a glance the user dismisses in a second, and a
            // toast about a cost line would outlive the surface that asked for it.
            costText.textContent = 'Cost unavailable'
            const retry = el('button', { class: 'usage-cost-retry usage-action menu-item', type: 'button' }, [
              icon('rotate-cw', 14),
              el('span', { text: 'Retry cost scan' })
            ])
            retry.addEventListener('click', scanCost)
            costLines.replaceChildren(el('div', { class: 'usage-cost-error usage-verdict sev-warning', text: message }), retry)
          },
          // A LOCAL log scan that has not answered in 8s is not answering. Give the row back rather
          // than leave an ellipsis to be believed. (The invoke cannot be cancelled — only waited on
          // less credulously.)
          timeoutMs: 8000
        })
      }
      scanCost()

      // ── Actions (step 5): icon rows. Add-account is dropped (can't add in
      //    the popover); the dashboard/gear open § Usage, About opens § About. ──
      const action = (name: Parameters<typeof icon>[0], label: string, onClick: () => void, cls = ''): HTMLElement => {
        const b = el('button', { class: 'usage-action menu-item' + (cls ? ' ' + cls : ''), type: 'button' }, [icon(name, 14), document.createTextNode(label)])
        b.addEventListener('click', onClick)
        return b
      }
      const goUsage = (): void => {
        close()
        requestSettingsTab('usage')
        setActiveView('settings')
      }
      panel.append(action('gauge', 'Usage Dashboard', goUsage))
      const statusUrl = findProvider(shownProvider)?.statusUrl
      if (statusUrl) panel.append(action('globe', 'Status Page', () => void bridge.invoke(BrowserChannels.openExternal, { url: statusUrl })))
      panel.append(action('sliders', 'Settings…', goUsage, 'usage-gear'))
      panel.append(action('info', 'About', () => {
        close()
        requestSettingsTab('about')
        setActiveView('settings')
      }))

      // ── Profile switch row (step 5): every profile of the shown provider, the
      //    active lane marked. Same .usage-tile + data-provider/data-profile
      //    contract the settings plans-table mirrors; Enter/click drives the ONE
      //    Phase-4 switch (the popover-wide keydown handler reads .usage-tile). ──
      const laneOrder = provPlans.slice().sort((a, b) => severityRank(a) - severityRank(b) || (b.windows[0]?.usedPct ?? 0) - (a.windows[0]?.usedPct ?? 0))
      const switchRow = el('div', { class: 'usage-switch' })
      for (const p of laneOrder) {
        const usedPct = p.windows[0]?.usedPct ?? 0
        const fill = el('span', { class: 'usage-fill' + (usedPct >= BADGE_PCT ? ' is-hot' : '') })
        const bar = el('span', { class: 'usage-track usage-track-row usage-track-mini' }, [fill])
        paintBar(bar, fill, usedPct, p.windows[0]?.label ?? p.planLabel)
        const tile = el('div', {
          class: 'usage-tile' + (p.profileId === activeProfileId ? ' is-active' : ''),
          tabIndex: -1,
          dataset: { provider: p.providerId, profile: p.profileId, health: p.health }
        }, [
          el('span', { class: 'usage-profile', text: p.profileId }),
          bar,
          // The swap-with-projection cue (CodexBar): each lane's own pace delta,
          // so "which account survives the week?" is answered BEFORE switching.
          p.pace ? el('span', { class: `usage-tile-delta sev-${p.pace.severity}`, text: p.pace.deltaText, title: p.pace.text }) : null
        ])
        if (provStatus && outaged)
          tile.append(el('span', { class: `pill usage-status is-${provStatus.state}`, text: provStatus.state, title: provStatus.note ?? '' }))
        tile.addEventListener('click', () => void switchActive(p.providerId, p.profileId, false))
        switchRow.append(tile)
      }
      panel.append(switchRow)

      // The one-line post-switch hint: pointers flipped for NEW launches only.
      if (switchHint) panel.append(el('div', { class: 'usage-switch-hint', text: switchHint }))
      // The foot is the POPOVER's (age + refresh), not the selected tab's — it
      // stays outside the tabpanel, where switching tabs cannot redraw it.
      pop.append(popFoot(now))
    }

    /**
     * A repaint MUST NOT steal the focus. Usage polls in the background and every snapshot that
     * arrives repaints this popover — and `clear(pop)` destroys the very node the user
     * has focused. Focus falls back to <body>, and the Enter they were lining up (the profile
     * switch, the one thing you can do from here with the keyboard) silently does nothing: they
     * arrowed to a lane, a refresh landed, and the popover stopped answering. The keydown handler
     * is right to demand a focused tile — a switch must go where the user is looking. The repaint
     * was the wrong half. Focus follows the LANE (provider + profile) rather than the node, since
     * the node is gone by definition, and lands back on the tile that replaced it.
     *
     * The tab strip has the SAME wound and one extra: selection follows focus there, so every
     * arrow key repaints the strip the arrow is walking. Focus follows the TAB id for the same
     * reason it follows the lane — the node it was on is gone by the time we look for it.
     */
    const renderPop = (): void => {
      const active = document.activeElement
      const inPop = active instanceof HTMLElement && pop.contains(active)
      const held = !inPop
        ? null
        : active.classList.contains('usage-tile')
          ? ({ kind: 'tile', provider: active.dataset.provider, profile: active.dataset.profile } as const)
          : active.classList.contains('usage-tab')
            ? ({ kind: 'tab', tab: active.dataset.tab } as const)
            : null
      paintPop()
      if (!held) return
      const back =
        held.kind === 'tile'
          ? [...pop.querySelectorAll<HTMLElement>('.usage-tile')].find(
              (t) => t.dataset.provider === held.provider && t.dataset.profile === held.profile
            )
          : [...pop.querySelectorAll<HTMLElement>('.usage-tab')].find((t) => t.dataset.tab === held.tab)
      back?.focus() // the lane/tab survived the repaint, so the user's next key still means it
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
      if (e.key === 'Escape') {
        // A dismissing layer must SAY it consumed the key. Settings
        // (settings/index.ts) and the wizard (wizard/index.ts) each leave their
        // page on Esc unless it arrives already `defaultPrevented` — so an Esc
        // that closed this popover and stayed silent ALSO closed the page behind
        // it: one keypress, two dismissals, and the user lands somewhere they
        // never asked to go. The house convention is both calls (components/
        // modal.ts) — prevent the default AND stop the climb.
        e.preventDefault()
        e.stopPropagation()
        close()
        return
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const tiles = [...pop.querySelectorAll<HTMLElement>('.usage-tile')]
        if (!tiles.length) return
        const at = tiles.findIndex((t) => t === document.activeElement)
        const next = e.key === 'ArrowDown' ? Math.min(tiles.length - 1, at + 1) : Math.max(0, at <= 0 ? 0 : at - 1)
        tiles[next].focus()
        e.preventDefault()
      }
      // The tab strip's own keyboard contract (APG tablist) — the twin of the tile
      // Arrows above, and the other half of the roving tabIndex: with one tab stop
      // for the whole strip, Left/Right (wrapping) and Home/End are the ONLY way to
      // reach the other providers. Selection FOLLOWS focus: a tab only chooses what
      // the gauge mirrors, and it repaints from the cached snapshot — nothing is
      // destroyed by arrowing past it. The click that selects also REPAINTS the
      // strip, so focus goes on first and renderPop() carries it into the new DOM.
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Home' || e.key === 'End') {
        const tabList = [...pop.querySelectorAll<HTMLElement>('.usage-tab')]
        const at = tabList.findIndex((t) => t === document.activeElement)
        if (at < 0) return // the arrows belong to whoever holds the focus
        const n = tabList.length
        const next =
          e.key === 'ArrowRight' ? (at + 1) % n : e.key === 'ArrowLeft' ? (at - 1 + n) % n : e.key === 'Home' ? 0 : n - 1
        e.preventDefault()
        tabList[next].focus()
        tabList[next].click()
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
    // Delivery contract (phase-11): every alert carries an outbox id — ack it
    // AFTER the toast reaches the DOM, and dedupe against the mount drain (a
    // pushed alert can also arrive in the drain when both race the boot).
    const seenAlerts = new Set<string>()
    const onAlert = (a: UsageAlert & { alertId?: string }): void => {
      if (!a || typeof a.title !== 'string') return
      if (a.alertId) {
        if (seenAlerts.has(a.alertId)) return
        seenAlerts.add(a.alertId)
      }
      showToast({
        tone: a.kind === 'reset' ? 'neutral' : a.level === 'warn' || a.kind === 'pace' ? 'attention' : 'info',
        title: a.title,
        body: a.body || undefined,
        timeout: a.level === 'warn' || a.kind === 'pace' ? 15000 : 6000,
        action: a.failover
          ? { label: `Fail over to ${a.failover.profileName}`, onClick: () => void switchActive(a.providerId, a.failover!.profileId, true) }
          : undefined
      })
      if (a.alertId) void bridge.invoke(UsageChannels.alertAck, a.alertId)
      if (a.confetti) spawnConfetti()
      // Class + booleans ONLY (ADR 0005) — never plan names or numbers.
      getTelemetry().captureEvent({
        name: 'usage.alert',
        props: { kind: a.kind, level: a.level ?? 'none', failoverOffered: !!a.failover, confetti: !!a.confetti }
      })
    }

    const applyDisplay = (next: UsageDisplayConfig | null): void => {
      display = { ...USAGE_DISPLAY_DEFAULTS, ...(next ?? {}) }
      paintGauge()
      if (!pop.hidden) renderPop()
    }

    bridge.on(UsageChannels.changed, (payload) => apply((payload as PlanUsageView[]) ?? []))
    bridge.on(UsageChannels.statusChanged, (payload) => applyStatuses((payload as ProviderStatus[]) ?? []))
    bridge.on(UsageChannels.alert, (payload) => onAlert(payload as UsageAlert & { alertId?: string }))
    bridge.on(UsageChannels.displayChanged, (payload) => applyDisplay(payload as UsageDisplayConfig))
    void refreshProfiles().then(() => paintGauge())
    void bridge.invoke(UsageChannels.displayGet).then((payload) => applyDisplay(payload as UsageDisplayConfig))
    void bridge.invoke(UsageChannels.list).then((payload) => apply((payload as PlanUsageView[]) ?? []))
    void bridge.invoke(UsageChannels.status).then((payload) => applyStatuses((payload as ProviderStatus[]) ?? []))
    // Drain the alert outbox: anything the first polls fired before this
    // listener existed (the boot race) replays now instead of being lost.
    void bridge.invoke(UsageChannels.alertDrain).then((payload) => {
      for (const a of (payload as (UsageAlert & { alertId: string })[]) ?? []) onAlert(a)
    })

    // Dev/smoke handle (the firstrun pattern).
    const g = window as unknown as { __mogging?: Record<string, unknown> }
    g.__mogging = { ...(g.__mogging ?? {}), usage: { open, close } }
  }
}
