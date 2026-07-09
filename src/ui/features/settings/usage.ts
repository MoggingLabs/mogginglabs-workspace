import {
  AgentChannels,
  ProfileChannels,
  UsageChannels,
  USAGE_CADENCES,
  USAGE_DISPLAY_DEFAULTS,
  USAGE_PROVIDERS,
  type AgentInfo,
  type AgentProfile,
  type CostScan,
  type PlanUsageView,
  type UsageAlertConfig,
  type UsageConfig,
  type UsageDisplayConfig,
  type UsageProviderDef
} from '@contracts'
import { Button, EmptyState, createCheckbox, createCollapsibleCard, el, providerLogo, showToast } from '../../components'
import { getBridge } from '../../core/ipc/bridge'
import { getTelemetry } from '../../core/telemetry'
import { switchActiveProfile } from '../../core/agents/profile-switch'

/**
 * Settings § Usage — the FULL tab (Phase-7/12): the one home for finding,
 * enabling, keying, and configuring every provider in the ~57-row catalog
 * across the five classes, plus the plans × profiles table, pace baseline,
 * alerts, display, history/cost, and the privacy story. The 7/03 stub is
 * absorbed here. The tab CONFIGURES and explains — the popover stays the
 * glance. Every mutation rides the poller's own IPC (configSet / keySet /
 * webReadSet / alertCfgSet / displaySet / paceCfgSet) — no side channel.
 * Keys are 0007.a WRITE-ONLY: a pasted value leaves the DOM at save and can
 * never be rendered again. Nothing here emits values to telemetry.
 */

const invoke = (channel: string, payload?: unknown): Promise<unknown> => getBridge().invoke(channel, payload)

const CLASS_ORDER = ['cli-store', 'api-key', 'cloud-cli', 'web-session', 'local'] as const
const CLASS_LABEL: Record<string, string> = {
  'cli-store': 'CLI stores — read in place',
  'api-key': 'API keys — paste once, write-only',
  'cloud-cli': 'Cloud CLIs — ambient credentials',
  'web-session': 'Browser sessions — paste-first, read opt-in',
  local: 'Local'
}

interface GridRow extends Pick<UsageProviderDef, 'id' | 'label' | 'klass'> {
  enabled: boolean
  cadence: string
  key?: string
  webRead?: boolean
  health?: string
}

export function createUsageSection(): HTMLElement {
  const root = el('div', { class: 'usage-tab' })

  let plans: PlanUsageView[] = []
  let profiles: AgentProfile[] = []
  let detected = new Set<string>()

  // ── 1 · The provider catalog grid (searchable, class-grouped) ─────────────
  const search = el('input', { class: 'usage-search', ariaLabel: 'Search providers' }) as HTMLInputElement
  search.type = 'search'
  search.placeholder = `Search ${USAGE_PROVIDERS.length}+ providers…`
  const grid = el('div', { class: 'usage-grid' })

  const rowState = new Map<string, GridRow>()

  async function loadGrid(): Promise<void> {
    const cfg = ((await invoke(UsageChannels.configGet)) as UsageConfig | null)?.providers ?? []
    const byId = new Map(cfg.map((p) => [p.id, p]))
    rowState.clear()
    // The union: the FULL catalog + any adapter row outside it (the FAKE world).
    for (const def of USAGE_PROVIDERS) {
      const c = byId.get(def.id)
      rowState.set(def.id, {
        id: def.id,
        label: def.label,
        klass: def.klass,
        enabled: c?.enabled ?? false,
        cadence: c?.cadence ?? '5m',
        key: c?.key,
        webRead: c?.webRead,
        health: plans.find((p) => p.providerId === def.id)?.health
      })
    }
    for (const c of cfg) {
      if (rowState.has(c.id)) continue
      rowState.set(c.id, {
        id: c.id,
        label: c.id,
        klass: 'local',
        enabled: c.enabled,
        cadence: c.cadence,
        key: c.key,
        webRead: c.webRead,
        health: plans.find((p) => p.providerId === c.id)?.health
      })
    }
    renderGrid()
  }

  function keyControl(r: GridRow, rerender: () => void): HTMLElement {
    const host = el('div', { class: 'usage-key-ctl' })
    const err = el('span', { class: 'settings-error usage-key-err', role: 'alert' })
    err.hidden = true
    const fail = (reason: string): void => {
      err.textContent = reason
      err.hidden = false
    }
    if (r.key === 'keychain' || r.key === 'env-ref') {
      // WRITE-ONLY forever: saved state renders a masked chip — Replace and
      // Delete exist; a reveal does not (no getter channel exists at all).
      host.append(
        el('span', { class: 'pill usage-key-saved', text: r.key === 'keychain' ? 'Key saved ····' : 'env-ref set' }),
        Button({
          label: 'Replace',
          size: 'sm',
          onClick: () => {
            r.key = 'none'
            rerender()
          }
        }),
        Button({
          label: 'Delete',
          size: 'sm',
          onClick: () => {
            void invoke(UsageChannels.keyClear, r.id).then(() => void loadGrid())
          }
        })
      )
      return host
    }
    // Paste-once: a password field (never readable back after save) + save.
    const paste = el('input', { class: 'usage-key-input', ariaLabel: `${r.id} API key` }) as HTMLInputElement
    paste.type = 'password'
    paste.placeholder = r.klass === 'web-session' ? 'paste cookie value…' : 'paste API key…'
    const save = Button({
      label: 'Save',
      size: 'sm',
      onClick: () => {
        const plaintext = paste.value
        if (!plaintext) return
        paste.value = '' // the value leaves the DOM before the round trip
        void invoke(UsageChannels.keySet, { providerId: r.id, plaintext }).then((res) => {
          const out = res as { ok: boolean; reason?: string }
          if (out.ok) void loadGrid()
          else fail(out.reason ?? 'refused')
        })
      }
    })
    // Advanced: an env-ref POINTER slot (a name, never a secret — a
    // secret-shaped literal is refused main-side and surfaced here).
    const envRef = el('input', { class: 'usage-envref-input', ariaLabel: `${r.id} env-ref` }) as HTMLInputElement
    envRef.type = 'text'
    envRef.placeholder = '${ENV_VAR} ref…'
    const saveRef = Button({
      label: 'Set ref',
      size: 'sm',
      onClick: () => {
        const ref = envRef.value.trim()
        if (!ref) return
        void invoke(UsageChannels.keySet, { providerId: r.id, envRef: ref }).then((res) => {
          const out = res as { ok: boolean; reason?: string }
          if (out.ok) {
            envRef.value = ''
            void loadGrid()
          } else fail(out.reason ?? 'refused')
        })
      }
    })
    host.append(paste, save, envRef, saveRef, err)
    return host
  }

  function renderGrid(): void {
    grid.replaceChildren()
    const q = search.value.trim().toLowerCase()
    const rows = [...rowState.values()].filter((r) => !q || r.id.includes(q) || r.label.toLowerCase().includes(q))
    for (const klass of CLASS_ORDER) {
      const mine = rows.filter((r) => r.klass === klass)
      if (!mine.length) continue
      // Detected/enabled first; the rest are one search away.
      mine.sort(
        (a, b) =>
          Number(b.enabled || detected.has(b.id)) - Number(a.enabled || detected.has(a.id)) || a.label.localeCompare(b.label)
      )
      const group = el('div', { class: 'usage-class-group', dataset: { klass } })
      group.append(el('div', { class: 'section-label usage-class-label', text: CLASS_LABEL[klass] ?? klass }))
      for (const r of mine) {
        const row = el('div', { class: 'usage-prov-row', dataset: { provider: r.id, klass: r.klass } })
        const enable = createCheckbox({
          label: '',
          ariaLabel: `${r.id} enabled`,
          checked: r.enabled,
          onChange: (checked) => {
            void invoke(UsageChannels.configSet, { providerId: r.id, enabled: checked }).then(() => void loadGrid())
          }
        })
        enable.el.classList.add('usage-prov-enable')
        const cadence = el('select', { class: 'usage-cadence', ariaLabel: `${r.id} refresh cadence` }) as HTMLSelectElement
        for (const c of USAGE_CADENCES) cadence.append(el('option', { value: c, text: c }))
        cadence.value = r.cadence
        cadence.addEventListener('change', () => void invoke(UsageChannels.configSet, { providerId: r.id, cadence: cadence.value }))
        const head = el('div', { class: 'usage-prov-head' }, [
          enable.el,
          providerLogo(r.id, 15),
          el('span', { class: 'usage-prov-label', text: r.label }),
          el('span', { class: `pill usage-class-chip is-${r.klass}`, text: r.klass }),
          r.klass === 'cli-store' || r.klass === 'cloud-cli'
            ? el('span', {
                class: `pill usage-detected ${detected.has(r.id) || r.health === 'fresh' || r.health === 'stale' ? 'is-found' : 'is-missing'}`,
                text: detected.has(r.id) || r.health === 'fresh' || r.health === 'stale' ? 'detected' : 'not found'
              })
            : null,
          r.enabled && r.health ? el('span', { class: `pill usage-health is-${r.health}`, text: r.health }) : null,
          r.enabled ? cadence : null,
          r.enabled
            ? Button({ label: 'Refresh', size: 'sm', onClick: () => void invoke(UsageChannels.refresh, r.id) })
            : null
        ])
        row.append(head)
        if (r.klass === 'api-key' || r.klass === 'web-session') {
          const ctl = el('div', { class: 'usage-prov-controls' }, [keyControl(r, renderGrid)])
          if (r.klass === 'web-session') {
            const webRead = createCheckbox({
              label: 'read my browser session',
              ariaLabel: `${r.id}: read my browser session`,
              checked: r.webRead ?? false,
              onChange: (checked) => void invoke(UsageChannels.webReadSet, { providerId: r.id, enabled: checked })
            })
            webRead.el.classList.add('usage-webread')
            webRead.el.title =
              'OFF by default. When on, the app decrypts this one site’s cookie via your OS keychain, for the one usage read only — never shared with agents (ADR 0007.b). You can always paste a cookie instead.'
            ctl.append(webRead.el)
          }
          row.append(ctl)
        }
        group.append(row)
      }
      grid.append(group)
    }
    if (!grid.childElementCount) grid.append(el('p', { class: 'ph-empty', text: 'No provider matches that search.' }))
  }
  search.addEventListener('input', renderGrid)

  // ── 2 · Plans × profiles (the poller's exact fan-out; same snapshot as the
  //        popover — asserted equal in the smoke) ────────────────────────────
  const plansTable = el('div', { class: 'usage-plans-table' })

  function renderPlans(): void {
    plansTable.replaceChildren()
    if (!plans.length) {
      plansTable.append(EmptyState({ icon: 'plug', title: 'No plans yet', body: 'Enable a provider above and its plans show up here.' }))
      return
    }
    for (const p of plans) {
      const mine = profiles.filter((x) => x.provider === p.providerId).sort((a, b) => a.order - b.order)
      const activeId = mine[0]?.id ?? 'default'
      const isActive = p.profileId === activeId
      const rowEl = el('div', {
        class: 'usage-plan-row' + (isActive ? ' is-active' : ''),
        dataset: { provider: p.providerId, profile: p.profileId }
      })
      const bars = el('span', { class: 'usage-mini-gauges' })
      for (const w of p.windows.slice(0, 2)) {
        const track = el('span', { class: 'usage-track usage-track-mini' })
        const fill = el('span', { class: 'usage-fill' + (w.usedPct >= 90 ? ' is-hot' : '') })
        fill.style.width = `${Math.max(0, Math.min(100, w.usedPct))}%`
        track.append(fill)
        bars.append(track)
      }
      const children: (Node | null)[] = [
        el('span', { class: 'usage-plan-name' }, [providerLogo(p.providerId, 13), el('span', { text: p.planLabel })]),
        el('span', { class: 'usage-profile', text: p.profileId }),
        bars,
        p.spend ? el('span', { class: 'usage-spend', text: `${p.spend.currency} ${p.spend.amount.toFixed(2)}` }) : null,
        el('span', { class: 'usage-plan-verdict', text: p.pace?.text ?? p.reason ?? '' }),
        el('span', { class: `pill usage-health is-${p.health}`, text: p.health }),
        !isActive && mine.some((m) => m.id === p.profileId)
          ? Button({
              label: 'Switch for new launches',
              size: 'sm',
              onClick: () => {
                void switchActiveProfile(p.providerId, p.profileId).then((name) => {
                  if (name) {
                    void refreshSnapshot()
                    getTelemetry().captureEvent({ name: 'usage.profileSwitch', props: { provider: p.providerId, viaSuggestion: false } })
                  }
                })
              }
            })
          : null
      ]
      rowEl.append(...children.filter((c): c is Node => c !== null))
      plansTable.append(rowEl)
    }
  }

  // ── 3 · Cost overview (7/07's scan, recut to the questions people actually
  //        ask): what did TODAY cost, how does it compare to the window, where
  //        is the month heading at this pace, and which model burns the money.
  //        (The old "pace baseline" work-days card lived here — deleted: pace
  //        is pure burn-rate arithmetic now, nothing for the user to declare.)
  const costHost = el('div', { class: 'usage-cost-cfg' })
  const fmtMoney = (cur: string, n: number): string => `${cur === 'USD' ? '$' : cur + ' '}${n.toFixed(2)}`
  const fmtTok = (n: number): string =>
    n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n))
  const localDateOf = (t: number): string => {
    const d = new Date(t)
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }
  const localToday = (): string => localDateOf(Date.now())

  // The window is a display pref (CodexBar's historyDays): renderer-local,
  // persisted beside the other paint-only choices.
  const WINDOW_KEY = 'mogging.costWindowDays'
  const costWindow = (): number => {
    const v = Number(localStorage.getItem(WINDOW_KEY))
    return [7, 30, 90, 365].includes(v) ? v : 30
  }

  async function renderCost(): Promise<void> {
    costHost.replaceChildren()
    const windowDays = costWindow()
    const winSel = el('select', { class: 'usage-cost-window', ariaLabel: 'Cost window' }) as HTMLSelectElement
    for (const [v, label] of [
      ['7', 'Last 7 days'],
      ['30', 'Last 30 days'],
      ['90', 'Last 90 days'],
      ['365', 'Last 365 days']
    ] as const)
      winSel.append(el('option', { value: v, text: label }))
    winSel.value = String(windowDays)
    winSel.addEventListener('change', () => {
      try {
        localStorage.setItem(WINDOW_KEY, winSel.value)
      } catch {
        /* session-only then */
      }
      void renderCost()
    })
    costHost.append(el('div', { class: 'usage-cost-windowrow' }, [el('span', { class: 'settings-row-caption', text: 'Window' }), winSel]))

    const providerIds = [...new Set(plans.map((p) => p.providerId))]
    let any = false
    for (const id of providerIds) {
      const scan = (await invoke(UsageChannels.cost, { providerId: id, windowDays })) as CostScan | null
      if (!scan || (!scan.days.length && !scan.models?.length)) continue
      any = true
      const cur = scan.currency
      const todayStr = localToday()
      const today = scan.days.find((d) => d.date === todayStr)
      const total = scan.days.reduce((a, d) => a + d.spend, 0)
      const totalTok = scan.days.reduce((a, d) => a + d.tokens, 0)
      const todayPct = total > 0 && today ? (today.spend / total) * 100 : 0
      const activeAvg = scan.days.length ? total / scan.days.length : 0
      // Projection rides the RECENT pace (last 7 calendar days), not the whole
      // window — "at this week's pace" answers where the month is heading.
      const spendSince = (days: number): number =>
        scan.days.filter((d) => Date.parse(d.date) >= Date.now() - days * 86_400_000).reduce((a, d) => a + d.spend, 0)
      const last7 = spendSince(7)
      const projected = (last7 / 7) * 30

      const stat = (label: string, value: string, hint?: string): HTMLElement =>
        el('div', { class: 'usage-stat', title: hint ?? '' }, [
          el('span', { class: 'usage-stat-value', text: value }),
          el('span', { class: 'usage-stat-label', text: label })
        ])
      const block = el('div', { class: 'usage-cost-block', dataset: { provider: id } }, [
        el('div', { class: 'usage-cost-head' }, [
          providerLogo(id, 14),
          el('span', { class: 'usage-cost-provider', text: id }),
          el('span', { class: 'settings-row-caption', text: `${scan.days.length} active day${scan.days.length === 1 ? '' : 's'} in the window · estimates, never a bill` })
        ]),
        el('div', { class: 'usage-cost-stats' }, [
          stat("Today's cost", today ? fmtMoney(cur, today.spend) : fmtMoney(cur, 0), today ? `${fmtTok(today.tokens)} tokens today` : 'no usage yet today'),
          stat('Today vs total', `${Math.round(todayPct)}%`, `today's share of the ${windowDays}-day spend`),
          stat(`Total (${windowDays}d)`, fmtMoney(cur, total), `${fmtTok(totalTok)} tokens in the window`),
          stat('Daily average', fmtMoney(cur, activeAvg), 'per active day in the window'),
          stat('Projected monthly', fmtMoney(cur, projected), "last 7 days' pace × 30")
        ])
      ])
      // Comparison rows (CodexBar's 7/30/90 summaries): every standard period
      // SHORTER than the window, so the numbers nest instead of repeating.
      const comparisons = [7, 30, 90].filter((p) => p < windowDays)
      if (comparisons.length) {
        const rows = el('div', { class: 'usage-cost-compare' })
        for (const p of comparisons)
          rows.append(
            el('div', { class: 'usage-cost-compare-row' }, [
              el('span', { class: 'usage-cost-compare-label', text: `Last ${p} days` }),
              el('span', { class: 'usage-cost-compare-value', text: fmtMoney(cur, spendSince(p)) })
            ])
          )
        block.append(rows)
      }
      // Daily-spend bars (the CodexBar cost-history chart, house-styled): the
      // FULL calendar window (capped at 90 bars — a year of 3px bars is a
      // smear, not a chart) — zero days render as baseline stubs so the
      // timeline is honest, not just the active days squeezed together. One
      // series, one hue; TODAY carries the only direct label (selective
      // labeling); every bar answers precisely on hover.
      if (scan.days.length) {
        const chartDays = Math.min(windowDays, 90)
        const maxSpend = Math.max(...scan.days.map((d) => d.spend), 1e-9)
        const byDate = new Map(scan.days.map((d) => [d.date, d]))
        const chart = el('div', {
          class: 'usage-cost-chart',
          role: 'img',
          ariaLabel: `Daily spend, last ${chartDays} days — window total ${fmtMoney(cur, total)}, peak day ${fmtMoney(cur, maxSpend)}`
        })
        for (let i = chartDays - 1; i >= 0; i--) {
          const dstr = localDateOf(Date.now() - i * 86_400_000)
          const d = byDate.get(dstr)
          const bar = el('span', { class: 'usage-chart-bar' + (i === 0 ? ' is-today' : '') + (d && d.spend > 0 ? '' : ' is-zero') })
          bar.style.height = d && d.spend > 0 ? `${Math.max(4, (d.spend / maxSpend) * 100)}%` : '2px'
          bar.title = d ? `${dstr} · ${fmtMoney(cur, d.spend)} · ${fmtTok(d.tokens)} tokens` : `${dstr} · no usage`
          chart.append(bar)
        }
        const todayLabel = today ? el('span', { class: 'usage-chart-today', text: fmtMoney(cur, today.spend) }) : null
        block.append(
          el('div', { class: 'usage-chart-row' }, [
            el('span', { class: 'section-label', text: `Daily spend — last ${chartDays} days` }),
            todayLabel
          ]),
          chart
        )
      }
      // Cost efficiency by model: spend, tokens, and the effective $/MTok the
      // mix actually paid — an unpriced model shows its tokens and says so.
      if (scan.models?.length) {
        const table = el('div', { class: 'usage-cost-models' })
        for (const m of scan.models) {
          const rate = m.tokens > 0 && !m.unpriced ? `${fmtMoney(cur, m.spend / (m.tokens / 1e6))}/MTok` : m.unpriced ? 'no price row' : '—'
          table.append(
            el('div', { class: 'usage-cost-model-row' + (m.unpriced ? ' is-unpriced' : '') }, [
              el('span', { class: 'usage-cost-model', text: m.model }),
              el('span', { class: 'usage-cost-model-spend', text: m.unpriced ? '—' : fmtMoney(cur, m.spend) }),
              el('span', { class: 'usage-cost-model-tok', text: fmtTok(m.tokens) }),
              el('span', { class: 'usage-cost-model-rate', text: rate })
            ])
          )
        }
        block.append(el('div', { class: 'section-label', text: 'Cost efficiency by model' }), table)
      }
      // Per-project cut (Codex names its cwd in session_meta): where the money
      // went, top-heavy, capped so the card stays a card and not a report.
      if (scan.projects?.length) {
        const table = el('div', { class: 'usage-cost-projects' })
        const TOP = 6
        for (const p of scan.projects.slice(0, TOP)) {
          table.append(
            el('div', { class: 'usage-cost-project-row' }, [
              el('span', { class: 'usage-cost-project', text: p.project }),
              el('span', { class: 'usage-cost-project-spend', text: fmtMoney(cur, p.spend) }),
              el('span', { class: 'usage-cost-project-tok', text: fmtTok(p.tokens) })
            ])
          )
        }
        if (scan.projects.length > TOP)
          table.append(el('div', { class: 'settings-row-caption', text: `+ ${scan.projects.length - TOP} more project${scan.projects.length - TOP === 1 ? '' : 's'}` }))
        block.append(el('div', { class: 'section-label', text: 'By project' }), table)
      }
      if (scan.reason) block.append(el('p', { class: 'settings-row-caption usage-cost-reason', text: scan.reason }))
      costHost.append(block)
    }
    if (!any)
      costHost.append(
        EmptyState({ icon: 'clock', title: 'No cost data yet', body: 'Costs are scanned from the session logs your CLIs already write (Claude Code, Codex) — locally, on demand.' })
      )
    costHost.append(Button({ label: 'Rescan', size: 'sm', onClick: () => void renderCost() }))
  }

  // ── 4 · Alerts (the 09 rules) + a fixture test toast ──────────────────────
  const alertsHost = el('div', { class: 'usage-alert-cfg settings-consents' })
  void (async () => {
    const cfg = (await invoke(UsageChannels.alertCfgGet)) as UsageAlertConfig | null
    if (!cfg) return
    const pctInput = (cls: string, label: string, value: number, key: 'quiet' | 'warn'): HTMLInputElement => {
      const input = el('input', { class: `usage-thr ${cls}`, ariaLabel: label }) as HTMLInputElement
      input.type = 'number'
      input.min = '1'
      input.max = '100'
      input.value = String(value)
      input.addEventListener('change', () => {
        const v = Number(input.value)
        if (Number.isFinite(v) && v >= 1 && v <= 100) void invoke(UsageChannels.alertCfgSet, { [key]: v })
      })
      return input
    }
    const quiet = pctInput('usage-thr-quiet', 'Quiet threshold percent', cfg.quiet, 'quiet')
    const warn = pctInput('usage-thr-warn', 'Warning threshold percent', cfg.warn, 'warn')
    const confetti = createCheckbox({
      label: 'Confetti on window reset',
      checked: cfg.confetti,
      onChange: (checked) => void invoke(UsageChannels.alertCfgSet, { confetti: checked })
    })
    confetti.el.classList.add('usage-confetti-toggle')
    alertsHost.append(
      el('div', { class: 'usage-alert-row' }, [
        el('span', { class: 'settings-row-caption', text: 'Quiet toast at' }),
        quiet,
        el('span', { class: 'settings-row-caption', text: '% · warning at' }),
        warn,
        el('span', { class: 'settings-row-caption', text: '%' })
      ]),
      confetti.el
    )
    // A FIXTURE toast, clearly labeled — proves the house toast path works but is
    // NOT a reading (its own comment said so). 05b puts it behind DEV so it never
    // ships; the real alert copy is composed main-side (09).
    if (import.meta.env.DEV) {
      alertsHost.append(
        Button({
          label: 'Test notification',
          size: 'sm',
          onClick: () =>
            showToast({ tone: 'attention', title: 'Test — Fake Pro at 95% of Session (5h)', body: 'Ahead of pace — a fixture, not a reading.' })
        })
      )
    }
  })()

  // ── 5 · Display (the 10 options — absorbed intact) ────────────────────────
  const displayHost = createDisplayControls()

  // ── 6 · History + cost (compact — the popover's deferred depth) ───────────
  const historyHost = el('div', { class: 'usage-history' })

  function sparkline(series: number[]): HTMLElement {
    const svgNs = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(svgNs, 'svg')
    svg.setAttribute('class', 'usage-sparkline')
    svg.setAttribute('viewBox', '0 0 60 16')
    svg.setAttribute('preserveAspectRatio', 'none')
    const pts = series.length > 1 ? series : [0, ...series]
    const step = 60 / Math.max(1, pts.length - 1)
    const line = document.createElementNS(svgNs, 'polyline')
    line.setAttribute('points', pts.map((v, i) => `${(i * step).toFixed(1)},${(15 - (v / 100) * 14).toFixed(1)}`).join(' '))
    svg.append(line)
    return svg as unknown as HTMLElement
  }

  async function renderHistory(): Promise<void> {
    historyHost.replaceChildren()
    const seen = new Set<string>()
    for (const p of plans) {
      if (seen.has(p.providerId) || (p.health !== 'fresh' && p.health !== 'stale')) continue
      seen.add(p.providerId)
      const w = p.windows[0]
      if (!w) continue
      const series = ((await invoke(UsageChannels.history, { providerId: p.providerId, window: w.label })) as number[]) ?? []
      // (The per-row "Scan cost" button moved up into the Cost overview card —
      // one home for cost, history keeps the sampled sparklines.)
      const rowEl = el('div', { class: 'usage-history-row', dataset: { provider: p.providerId } }, [
        el('span', { class: 'usage-history-label', text: `${p.providerId} · ${w.label}` }),
        sparkline(series)
      ])
      historyHost.append(rowEl)
    }
    if (!historyHost.childElementCount)
      historyHost.append(EmptyState({ icon: 'clock', title: 'No history yet', body: 'History appears once an enabled provider reports usage.' }))
  }

  // ── 7 · The privacy story, in place (ADR 0007 / .a / .b) ──────────────────
  const privacy = el('div', { class: 'usage-privacy-block settings-consents' }, [
    el('p', {
      class: 'usage-privacy-line',
      text: 'Sessions are read IN PLACE from your own CLIs — this app performs no logins and copies no credentials (ADR 0007).'
    }),
    el('p', {
      class: 'usage-privacy-line',
      text: 'Pasted keys are encrypted by your OS immediately and can never be shown again — replace or delete only; no read-back exists (ADR 0007.a).'
    }),
    el('p', {
      class: 'usage-privacy-line',
      text: 'Browser-session reads are per-provider opt-in, OFF by default, one cookie for one usage request, never shared with agents (ADR 0007.b).'
    }),
    el('p', { class: 'settings-row-caption', text: 'The full story: docs/12-usage.md in the repository.' })
  ])

  // ── Overview band + progressive-disclosure Cards (8.5/05b) ────────────────
  // The mega-tab opens QUIET: only this overview and any section with attention.
  // Collapse is not hide — every card body stays in the DOM (USAGESET/USAGEUI
  // reach through display:none), so folding changes nothing they assert.
  const overview = el('div', { class: 'usage-overview' })
  const maxPct = (p: PlanUsageView): number => (p.windows.length ? Math.max(...p.windows.map((w) => w.usedPct)) : 0)

  const card = (id: string, title: string, caption: string, body: HTMLElement): ReturnType<typeof createCollapsibleCard> =>
    createCollapsibleCard({ id, title, caption, storagePrefix: 'usage', class: `usage-card usage-card-${id}` }, [body])
  const providersCard = card('providers', 'Providers', 'The full catalog, five classes — enable what you use; keys are set per row, the rest is one search away.', el('div', {}, [search, grid]))
  const plansCard = card('plans', 'Plans & profiles', 'Every lane the poller reads. The active lane launches new agents; switching flips pointers, never credentials.', plansTable)
  const costCard = card('cost', 'Cost overview', "Today vs the window, the daily average, where the month is heading at this pace, and which model burns the money — scanned locally from your CLIs' own logs.", costHost)
  const alertsCard = card('alerts', 'Thresholds & alerts', 'A quiet toast at the first threshold, a warning with the verdict at the second; once per window, re-armed at reset.', alertsHost)
  const displayCard = card('display', 'Display', 'What the titlebar gauge mirrors, what the icon shows, how resets render, popover order and density.', displayHost)
  const historyCard = card('history', 'History & cost', 'Sampled history per provider and the on-demand local cost scan. Compact by design — the popover stays the glance.', historyHost)
  const privacyCard = card('privacy', 'Privacy', 'Where credentials live and what never leaves the machine.', privacy)

  function computeAttention(): Node | null {
    // Surviving collapse (AUDIT § Settings): a hot bar or an errored provider must
    // read from the folded Providers header — the two signals the popover shows too.
    const hot = plans.some((p) => p.windows.some((w) => w.usedPct >= 90))
    const errored = plans.some((p) => p.health === 'error')
    if (!hot && !errored) return null
    const box = el('div', { class: 'usage-attn' })
    if (hot) {
      const track = el('span', { class: 'usage-track usage-track-row' })
      const fill = el('span', { class: 'usage-fill is-hot' })
      fill.style.width = '100%'
      track.append(fill)
      box.append(track)
    }
    if (errored) box.append(el('span', { class: 'pill usage-health is-error', text: 'error' }))
    return box
  }
  function renderOverview(): void {
    overview.replaceChildren()
    const connected = new Set(plans.filter((p) => p.health === 'fresh' || p.health === 'stale').map((p) => p.providerId)).size
    overview.append(
      el('div', {
        class: 'usage-ov-summary',
        text: plans.length
          ? `${connected} provider${connected === 1 ? '' : 's'} reporting · ${plans.length} plan${plans.length === 1 ? '' : 's'}`
          : 'No usage yet — enable a provider in Providers below.'
      })
    )
    const top = plans.length ? [...plans].sort((a, b) => maxPct(b) - maxPct(a))[0] : undefined
    if (top) {
      const gauges = el('div', { class: 'usage-ov-gauges' })
      for (const w of top.windows.slice(0, 2)) {
        const track = el('span', { class: 'usage-ov-track' })
        const fill = el('span', { class: 'usage-ov-fill' + (w.usedPct >= 90 ? ' is-hot' : '') })
        fill.style.width = `${Math.max(0, Math.min(100, w.usedPct))}%`
        track.append(fill)
        gauges.append(track)
      }
      overview.append(
        el('div', { class: 'usage-ov-plan' }, [
          el('span', { class: 'usage-ov-name', text: `${top.providerId} · ${top.planLabel}` }),
          gauges,
          el('span', { class: 'usage-ov-verdict', text: top.pace?.text ?? top.reason ?? '' })
        ])
      )
    }
    // Attention beats persistence: a hot/errored snapshot opens Providers and shows
    // the signal on its always-visible header (persist:false — never rewrites intent).
    providersCard.setAttention(computeAttention())
  }
  renderOverview()

  // ── Data flow: one snapshot feeds grid health + plans + history ───────────
  async function refreshSnapshot(): Promise<void> {
    const [plansRaw, profilesRaw] = await Promise.all([invoke(UsageChannels.list), invoke(ProfileChannels.list)])
    plans = (plansRaw as PlanUsageView[]) ?? []
    profiles = (profilesRaw as AgentProfile[]) ?? []
    renderPlans()
    renderOverview()
    void renderHistory()
  }
  getBridge().on(UsageChannels.changed, (payload) => {
    plans = (payload as PlanUsageView[]) ?? []
    renderPlans()
    renderOverview()
    // Profiles may have changed too (a switch, a Settings edit) — cheap re-read
    // so the active marker and Switch affordances stay truthful.
    void invoke(ProfileChannels.list).then((raw) => {
      profiles = (raw as AgentProfile[]) ?? []
      renderPlans()
    })
  })
  void (async () => {
    try {
      const agents = ((await invoke(AgentChannels.detect)) as AgentInfo[]) ?? []
      detected = new Set(agents.filter((a) => a.installed).map((a) => a.id))
    } catch {
      /* detection optional */
    }
    await loadGrid()
    await refreshSnapshot()
    void renderCost() // after the first snapshot: cost sources = reporting providers
  })()

  root.append(
    overview,
    providersCard.el,
    plansCard.el,
    costCard.el,
    alertsCard.el,
    displayCard.el,
    historyCard.el,
    privacyCard.el
  )
  return root
}

/** The 7/10 display controls (absorbed intact — one home). */
function createDisplayControls(): HTMLElement {
  const root = el('div', { class: 'settings-consents usage-display-cfg' })
  void (async () => {
    try {
      const cfg: UsageDisplayConfig = {
        ...USAGE_DISPLAY_DEFAULTS,
        ...(((await invoke(UsageChannels.displayGet)) as UsageDisplayConfig) ?? {})
      }
      const providers = (((await invoke(UsageChannels.configGet)) as UsageConfig | null)?.providers ?? []).map((p) => p.id)
      const set = (patch: Partial<UsageDisplayConfig>): void => {
        void invoke(UsageChannels.displaySet, patch)
        // Enums + booleans ONLY (ADR 0005) — never a provider id or number.
        getTelemetry().captureEvent({
          name: 'usage.display',
          props: {
            mode: patch.mode ?? cfg.mode,
            bars: patch.showBars ?? cfg.showBars,
            pct: patch.showPct ?? cfg.showPct,
            glyph: patch.showGlyph ?? cfg.showGlyph,
            label: patch.showLabel ?? cfg.showLabel,
            reset: patch.resetStyle ?? cfg.resetStyle,
            density: patch.density ?? cfg.density,
            order: patch.order ?? cfg.order
          }
        })
        Object.assign(cfg, patch)
      }
      const select = (cls: string, label: string, options: [string, string][], value: string, onChange: (v: string) => void): HTMLSelectElement => {
        const s = el('select', { class: `usage-display-select ${cls}`, ariaLabel: label }) as HTMLSelectElement
        for (const [v, text] of options) s.append(el('option', { value: v, text }))
        s.value = value
        s.addEventListener('change', () => onChange(s.value))
        return s
      }
      const pinSel = select('usage-display-pin', 'Pinned provider', providers.map((id) => [id, id]), cfg.pin ?? providers[0] ?? '', (v) => set({ mode: 'pinned', pin: v }))
      const modeSel = select(
        'usage-display-mode',
        'Gauge mode',
        [
          ['merged', 'Merged — highest severity'],
          ['auto', 'Auto — highest usage'],
          ['pinned', 'Pinned provider']
        ],
        cfg.mode,
        (v) => {
          pinSel.hidden = v !== 'pinned'
          if (v === 'pinned') set({ mode: 'pinned', pin: pinSel.value || undefined })
          else set({ mode: v as UsageDisplayConfig['mode'] })
        }
      )
      pinSel.hidden = cfg.mode !== 'pinned'
      const resetSel = select(
        'usage-display-reset',
        'Reset time style',
        [
          ['countdown', 'Countdown (2d 4h)'],
          ['absolute', 'Absolute (Tue 14:00)'],
          ['relative', 'Relative (tomorrow 14:00)']
        ],
        cfg.resetStyle,
        (v) => set({ resetStyle: v as UsageDisplayConfig['resetStyle'] })
      )
      const densitySel = select(
        'usage-display-density',
        'Popover density',
        [
          ['roomy', 'Roomy'],
          ['compact', 'Compact']
        ],
        cfg.density,
        (v) => set({ density: v as UsageDisplayConfig['density'] })
      )
      const orderSel = select(
        'usage-display-order',
        'Popover order',
        [
          ['severity', 'By severity (runs-out first)'],
          ['manual', 'Manual pin order']
        ],
        cfg.order,
        (v) => set({ order: v as UsageDisplayConfig['order'] })
      )
      const pinOrder = el('input', { class: 'usage-display-pinorder', ariaLabel: 'Manual provider order (comma-separated ids)' }) as HTMLInputElement
      pinOrder.type = 'text'
      pinOrder.placeholder = 'provider ids, comma-separated'
      pinOrder.value = cfg.pinOrder.join(', ')
      pinOrder.addEventListener('change', () =>
        set({ pinOrder: pinOrder.value.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 64) })
      )
      const check = (label: string, cls: string, checked: boolean, key: 'showBars' | 'showPct' | 'showGlyph' | 'showLabel'): HTMLElement => {
        const c = createCheckbox({ label, checked, onChange: (on) => set({ [key]: on }) })
        c.el.classList.add(cls)
        return c.el
      }
      root.append(
        el('div', { class: 'usage-display-row' }, [el('span', { class: 'settings-row-caption', text: 'Gauge shows' }), modeSel, pinSel]),
        el('div', { class: 'usage-display-row' }, [
          check('Bars', 'usage-display-bars', cfg.showBars, 'showBars'),
          check('%', 'usage-display-pct', cfg.showPct, 'showPct'),
          check('Glyph', 'usage-display-glyph', cfg.showGlyph, 'showGlyph'),
          check('Label', 'usage-display-label', cfg.showLabel, 'showLabel')
        ]),
        el('div', { class: 'usage-display-row' }, [el('span', { class: 'settings-row-caption', text: 'Resets' }), resetSel]),
        el('div', { class: 'usage-display-row' }, [
          el('span', { class: 'settings-row-caption', text: 'Popover' }),
          densitySel,
          orderSel,
          pinOrder
        ])
      )
    } catch {
      root.append(el('span', { class: 'settings-row-caption', text: 'Display config unavailable.' }))
    }
  })()
  return root
}
