import type { UiFeature } from '../../core/registry/feature-registry'
import { BrowserChannels, TelemetryChannels, type TelemetryRendererConfig } from '@contracts'
import { getWorkspaces } from '../../core/workspace/workspace-info-port'
import { Button, Card, FieldGroup, SectionHeader, TwoColumn, createSegmented, createToggleRow, el, icon, showToast, ICON_NAMES, type ElChild, type IconName } from '../../components'
import { THEMES } from '../../core/theme/themes'
import { currentThemeId, onThemeChange, setTheme } from '../../core/theme/theme-state'
import { setCommands } from '../../core/commands/command-port'
import { getBridge } from '../../core/ipc/bridge'
import { getTelemetry } from '../../core/telemetry'
import { activeView, goBack, onViewChange, setActiveView } from '../../core/shell/view-port'
import { registerSettingsTabNav, takeRequestedSettingsTab } from '../../core/shell/settings-tab-port'
import { requestIntegrationsFocus, type IntegrationsFocus } from '../../core/shell/integrations-focus-port'
import { renderShortcutList } from '../../core/commands/shortcuts'
import { setTerminalFontSize, terminalFontSize, TERMINAL_FONT_SIZES } from '../../core/terminal/font-port'
import { calmMotion, setCalmMotion } from '../../core/a11y/motion-port'
import { TEMPLATE_COUNTS } from '../layout'
import { createActOriginsCard } from './act-origins'
import { createActivitySection } from './activity'
import { createClipboardSection } from './clipboard'
import { createProfilesHostsSection } from './profiles-hosts'
import { createProvidersSection } from './providers'
import { createSessionAlertsCard } from './session-alerts'
import { createThemePicker } from './theme-picker'
import { createUpdatesSection } from './updates'
import { createUsageAlertsBlock, createUsageSection } from './usage'
import { createWebhooksSection } from './webhooks'
import { createIntegrationsSection, enterIntegrations } from './integrations'

const DEFAULT_LAYOUT_KEY = 'mogging.defaultPaneCount'

/**
 * The nav is a MAP, not a list (8.5/04). Nine flat rows say only "there are nine";
 * four named groups say where a knob lives before you read the labels. Grouping is
 * visual — every knob keeps its tab, and every tab keeps its `data-target` id.
 */
const NAV_GROUPS: { label: string; ids: string[] }[] = [
  { label: 'Workspace', ids: ['appearance', 'terminal', 'clipboard'] },
  { label: 'Agents & tools', ids: ['providers', 'profiles', 'integrations', 'usage', 'webhooks'] },
  { label: 'Trust', ids: ['privacy', 'browser', 'activity'] },
  { label: 'System', ids: ['shortcuts', 'about'] }
]

const TAB_ICON: Record<string, IconName> = {
  appearance: 'sliders',
  terminal: 'terminal',
  providers: 'sparkles',
  clipboard: 'copy',
  profiles: 'user',
  integrations: 'plug',
  usage: 'gauge',
  webhooks: 'bell',
  privacy: 'shield',
  browser: 'globe',
  activity: 'activity',
  shortcuts: 'keyboard',
  about: 'info'
}

function pref(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function setPref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage unavailable */
  }
}

/**
 * Settings — a FULL-APP page (Phase-5/05, was a modal): a left TAB rail of NINE
 * tabs, grouped (Workspace · Agents & tools · Trust · System), where each tab is
 * its OWN page — selecting one shows only that section and hides the rest (not
 * stacked sections on one scroll). Every tab is a `SectionHeader` over `Card`s of
 * `FieldGroup`s / `ToggleRow`s (8.5/04); a card holding ONE knob uses its own head
 * as that knob's label rather than nesting a second one. Theme,
 * default wizard layout, and telemetry CONSENT (observability/00, ADR 0005) —
 * independent opt-in toggles persisted main-side over IPC; granting or revoking
 * re-initializes the adapters live. BYO-auth is stated, not configured: there
 * are deliberately no credential fields anywhere in this app (ADR 0002). The
 * page DOM is built ONCE at mount and tabs HIDE (never rebuild), so unsaved form
 * text survives tab switches and leave/return; the last-open tab is remembered.
 */
export const settingsFeature: UiFeature = {
  name: 'settings',
  mount(ctx) {
    // Swatch tiles, not a segmented (see theme-picker.ts): each theme previews
    // itself out of its own chrome tokens. Same non-looping setValue contract.
    const themePicker = createThemePicker({
      value: currentThemeId(),
      onChange: (id) => {
        setTheme(id)
        getTelemetry().captureEvent({ name: 'theme.changed', props: { theme: id } })
      }
    })
    onThemeChange((id) => themePicker.setValue(id))

    const layoutSeg = createSegmented({
      options: TEMPLATE_COUNTS.map((n) => ({ id: String(n), label: String(n) })),
      value: pref(DEFAULT_LAYOUT_KEY) ?? '4',
      ariaLabel: 'Default terminals in a new workspace',
      onChange: (id) => setPref(DEFAULT_LAYOUT_KEY, id)
    })

    // Terminal type (5/06): fontSize only — applied LIVE to every open pane through
    // the house remeasure→refit path; line-height is fixed by design.
    const fontSeg = createSegmented({
      options: TERMINAL_FONT_SIZES.map((n) => ({ id: String(n), label: `${n}px` })),
      value: String(terminalFontSize()),
      ariaLabel: 'Terminal font size',
      onChange: (id) => {
        setTerminalFontSize(Number(id))
        getTelemetry().captureEvent({ name: 'terminal.fontSize', props: { size: Number(id) } })
      }
    })

    // ── Calm motion (Appearance): the in-app twin of the OS reduce-motion pref ──
    // One switch, applied live via :root.motion-calm (motion-port): the attention
    // pulse and the rail's infinite indicator pulses become the MOTION-01 gentle
    // fades. The OS preference keeps working on its own; this is for turning the
    // motion down without reconfiguring the whole desktop.
    const calmMotionToggle = createToggleRow({
      label: 'Calm motion',
      hint: 'Replaces pulses with gentle fades — attention still shows. Your OS reduce-motion setting always does this automatically.',
      onChange: () => {
        setCalmMotion(calmMotionToggle.checked())
        getTelemetry().captureEvent({ name: 'appearance.calmMotion', props: { on: calmMotionToggle.checked() } })
      }
    })
    calmMotionToggle.setChecked(calmMotion())

    // ── Telemetry consent: persisted in main, applied live (opt-in, default off) ──
    // ToggleRow, not Checkbox: a switch means "this is on, now"; a checkbox means
    // "include this in what I submit". `setChecked()` still never fires onChange,
    // which is what keeps `pullConsent()` from pushing straight back.
    const errorConsent = createToggleRow({
      label: 'Error reporting (Sentry)',
      hint: 'Crash and error reports, so a bug you hit gets fixed.',
      onChange: () => void pushConsent()
    })
    const analyticsConsent = createToggleRow({
      label: 'Product analytics (PostHog)',
      hint: 'Which features get used, so the dead ones can go.',
      onChange: () => void pushConsent()
    })

    // Agent-browser-control consent (6/05b): per-workspace, default OFF.
    //
    // This is a native <input type=checkbox>: the browser flips `.checked` BEFORE onChange
    // runs. So the switch sliding over is not evidence of anything — it is the START of a
    // request, and it was being treated as the end of one (finding 33b). The old handler
    // fired `void invoke(consentSet)` and walked away: no await, no catch, no rollback —
    // and main's handler silently dropped the write whenever its store was gone. With ZERO
    // workspaces it was worse: `if (!wsId) return` left the box sitting there ON, having
    // never called anything, and pullConsent() only re-syncs on entering Settings, so the
    // lie persisted for the rest of the visit. The grant that decides whether AGENTS MAY
    // DRIVE A BROWSER is the last switch in this app that should be optimistic.
    //
    // Now: disabled outright with no workspace (with the reason under it), and otherwise
    // held disabled across the round-trip, reverted on failure, and made live ONLY after
    // main confirms it saved.
    const agentBrowserConsentNote = el('p', {
      class: 'toggle-row-hint browser-consent-note',
      text: 'No workspace open — this grant is per-workspace. Create or open one, then decide here.',
      hidden: true
    })
    const agentBrowserConsent = createToggleRow({
      label: 'Agents may drive the browser (this workspace)',
      hint: 'When on, agents in THIS workspace can navigate, read, and act on the browser dock — you always see when an agent holds the wheel and can Stop it instantly.',
      extra: agentBrowserConsentNote,
      onChange: () => void applyAgentBrowserConsent()
    })

    /** No workspace, no per-workspace grant: the switch is dead, and says why. */
    function syncAgentBrowserConsentAvailability(): void {
      const wsId = getWorkspaces().activeId
      agentBrowserConsent.setDisabled(!wsId)
      agentBrowserConsentNote.hidden = !!wsId
      if (!wsId) agentBrowserConsent.setChecked(false) // nothing is granted when nothing is open
    }

    async function applyAgentBrowserConsent(): Promise<void> {
      const next = agentBrowserConsent.checked()
      const wsId = getWorkspaces().activeId
      if (!wsId) {
        // Belt and braces — the control is disabled without a workspace, so this cannot
        // normally fire. If it ever does, the box does not get to sit there lying.
        syncAgentBrowserConsentAvailability()
        showToast({
          tone: 'danger',
          title: 'No workspace open',
          body: 'This grant is per-workspace — open a workspace, then grant its agents the wheel.'
        })
        return
      }
      agentBrowserConsent.setDisabled(true) // no second click racing the first
      try {
        const saved = (await getBridge().invoke(BrowserChannels.consentSet, {
          workspaceId: wsId,
          allowed: next
        })) as { ok?: boolean } | undefined
        if (!saved?.ok) {
          agentBrowserConsent.setChecked(!next) // put the switch back where the truth is
          showToast({
            tone: 'danger',
            title: 'Consent was not saved',
            body: 'The settings store did not accept the change — nothing was granted or revoked. Try again.'
          })
          return
        }
        // Live only once it is SAVED: a grant that survives no restart is not a grant.
        getBridge().send(BrowserChannels.consent, { allowed: next, workspaceId: wsId })
      } catch (error) {
        agentBrowserConsent.setChecked(!next)
        showToast({ tone: 'danger', title: 'Consent was not saved', body: String(error) })
      } finally {
        syncAgentBrowserConsentAvailability() // re-enable — unless the workspace left while we waited
      }
    }

    async function pullConsent(): Promise<void> {
      try {
        const cfg = (await getBridge().invoke(TelemetryChannels.getConfig)) as TelemetryRendererConfig
        errorConsent.setChecked(!!cfg.errorReporting)
        analyticsConsent.setChecked(!!cfg.productAnalytics)
      } catch {
        /* bridge unavailable — leave off */
      }
      try {
        const wsId = getWorkspaces().activeId
        const on = !!wsId && (await getBridge().invoke(BrowserChannels.consentGet, wsId)) === true
        agentBrowserConsent.setChecked(on)
      } catch {
        /* leave off */
      }
      syncAgentBrowserConsentAvailability() // entering Settings re-derives whether it may be touched at all
    }
    async function pushConsent(): Promise<void> {
      try {
        await getBridge().invoke(TelemetryChannels.setConsent, {
          errorReporting: errorConsent.checked(),
          productAnalytics: analyticsConsent.checked()
        })
      } catch {
        /* bridge unavailable */
      }
    }

    const profilesHosts = createProfilesHostsSection() as HTMLElement & { refresh: () => Promise<void> }
    const providers = createProvidersSection()

    // ── The page: [section nav | scrollable content column] ──────────────────
    // The version used to be read out of the telemetry config's `release` field — which meant
    // the number went blank for anyone with telemetry off. It now comes from the updater's own
    // state (app.getVersion()), next to the control that can change it.

    /** A tab: a HERO head (the tab's icon in an accent chip + one h2 SectionHeader
     *  saying what lives here, over a hairline), then Cards. The `data-section` hook
     *  and the `hidden` semantics are a compatibility surface — gallery, KBSHORTCUTS
     *  and USAGESET all key off them; `.settings-section-head` stays for SETSHELL. */
    const section = (id: string, title: string, caption: string, children: ElChild[]): HTMLElement =>
      el('section', { class: 'settings-section', dataset: { section: id } }, [
        el('div', { class: 'settings-hero' }, [
          el('div', { class: 'settings-hero-glyph', attrs: { 'aria-hidden': 'true' } }, [icon(TAB_ICON[id] ?? 'sliders', 20)]),
          SectionHeader({ title, caption, as: 'h2', class: 'settings-section-head' })
        ]),
        ...children
      ])

    const sections: { id: string; label: string; el: HTMLElement }[] = [
      {
        id: 'appearance',
        label: 'Appearance',
        el: section('appearance', 'Appearance', 'How the app looks.', [
          // One knob, so the card's head IS its label — nesting a FieldGroup here
          // would print "Theme" twice. Cards with two or more knobs use FieldGroups.
          Card(
            {
              header: SectionHeader({
                title: 'Theme',
                caption: 'System follows your OS light/dark preference. Applies immediately, everywhere.'
              })
            },
            [themePicker.el]
          ),
          Card(
            {
              header: SectionHeader({
                title: 'Motion',
                caption: 'How much the interface moves to get your attention.'
              })
            },
            [calmMotionToggle.el]
          )
        ])
      },
      {
        id: 'terminal',
        label: 'Terminal',
        // F-03: "Type," read as "kind of terminal" — say what the two knobs actually are.
        el: section('terminal', 'Terminal', 'Text size, and how many terminals a new workspace starts with.', [
          Card(
            {
              header: SectionHeader({
                title: 'Terminal defaults',
                caption: 'Font size applies live to every open terminal; the layout default seeds the new-workspace wizard.'
              })
            },
            [
              FieldGroup({ label: 'Font size', hint: 'Line height is fixed — only size varies.' }, fontSeg.el),
              FieldGroup({ label: 'New-workspace layout', hint: 'How many terminals the wizard suggests.' }, layoutSeg.el)
            ]
          )
        ])
      },
      {
        id: 'clipboard',
        label: 'Clipboard',
        el: section(
          'clipboard',
          'Clipboard',
          'Copy, paste and drag-and-drop — ours, not the agent CLI’s.',
          [createClipboardSection()]
        )
      },
      {
        id: 'providers',
        label: 'Agent CLIs',
        // The availability map (see providers.ts): which agent CLIs this machine
        // can run, and a one-click background install for the missing ones.
        // Labeled 'Agent CLIs', not 'Providers' — Usage's source catalog owned
        // that word too, and one word must not name two doors. The id stays
        // 'providers' (data-target, smokes, shot sweeps all key off it).
        // F-09: "control plane" was k8s idiom on a consumer surface.
        el: section('providers', 'Agent CLIs', 'Install each CLI, open its settings, and keep the values you choose in sync.', [providers])
      },
      {
        id: 'profiles',
        // F-16: the rail label and the page title must match verbatim — it is how a
        // user confirms they landed where they aimed.
        label: 'Profiles & SSH hosts',
        // F-17: the two real cards stand alone — the old wrapper card led the page
        // with a policy heading ("Pointer sets only") and made the app's only
        // card-in-card nesting. Content first; the ADR covenant closes the page.
        el: section('profiles', 'Profiles & SSH hosts', 'Pointers to accounts and machines — never credentials.', [
          profilesHosts,
          el('p', {
            class: 'settings-scope',
            text: 'Profiles select WHICH of your accounts a CLI uses; hosts are ssh targets. Never keys, tokens, or passwords — secret-shaped values are refused at save (ADR 0002).'
          })
        ])
      },
      {
        id: 'usage',
        label: 'Usage',
        // The FULL Usage tab (7/12) — one module, one home for every usage
        // knob: the provider grid, plans × profiles, pace/alerts/display,
        // history + cost, and the privacy story. 8.5/04 gives it the page
        // frame; 8.5/05 rebuilds its internals.
        el: section('usage', 'Usage', 'Limits, plans, pace and cost — read from the CLIs you already use.', [createUsageSection()])
      },
      {
        id: 'integrations',
        label: 'Integrations',
        // THE integrations home (8/06+, ADR 0014): connections, catalog, registry,
        // plans, grants, keys — one module, one home. Webhooks and the activity trail
        // have their own tabs. The subtitle leads with CONNECTIONS because that is now
        // the page's subject; the per-CLI machinery is how a connection reaches an agent.
        el: section(
          'integrations',
          'Integrations',
          'Connect your accounts once — then scope which agents can use them.',
          [createIntegrationsSection()]
        )
      },
      {
        id: 'webhooks',
        label: 'Notifications',
        // F-08 + reorg: ONE home for "how do I get pinged" — the question used to be
        // answered across three tabs (usage thresholds, the session-alerts card in
        // Agent CLIs, and this event bridge). The tab id stays `webhooks`: it is the
        // deep-link + smoke surface, and ids are plumbing, not labels.
        el: section(
          'webhooks',
          'Notifications',
          'How you get pinged when agents need you — alerts, thresholds, and your own automations.',
          [
            Card(
              {
                header: SectionHeader({
                  title: 'Alerts & thresholds',
                  caption: 'Get warned before a plan runs out — a quiet heads-up first, the verdict near the line. Once per window, re-armed at reset.'
                })
              },
              [createUsageAlertsBlock()]
            ),
            createSessionAlertsCard(),
            createWebhooksSection()
          ]
        )
      },
      {
        id: 'privacy',
        label: 'Privacy',
        el: section('privacy', 'Privacy', 'Nothing here is on unless you turn it on.', [
          Card(
            {
              header: SectionHeader({
                title: 'Help improve the app',
                caption:
                  'Both are OFF by default and fully anonymous (a random install id — never your account, machine name, or provider identity).'
              })
            },
            [
              errorConsent.el,
              analyticsConsent.el,
              // ADR 0005 wording is load-bearing: the clauses are verbatim — F-37 only
              // splits them into two breaths (the NEVER list, then the mechanics).
              el('p', {
                class: 'settings-scope',
                text: 'Telemetry NEVER includes terminal output, prompts, code, file paths, environment variables, or credentials.'
              }),
              el('p', {
                class: 'settings-scope',
                text: 'Changes apply immediately; DO_NOT_TRACK is always honored.'
              })
            ]
          ),
          el('div', { class: 'settings-note' }, [
            icon('check-circle', 14),
            el('span', {
              text: 'Your keys, your CLIs: agents authenticate themselves with your own accounts — the app never brokers or stores their auth (ADR 0002). The only secrets it holds are keys and webhook URLs you explicitly vault, encrypted by your OS keychain.'
            })
          ])
        ])
      },
      {
        id: 'browser',
        label: 'Browser',
        // The ONE browser-boundary home: the drive-consent switch AND the act-origin
        // grants (moved from Integrations — same store, but a browser concern).
        el: section('browser', 'Browser', 'What agents may do with the browser dock, and where they may act.', [
          Card(
            {
              header: SectionHeader({ title: 'Agent browser control', caption: 'OFF by default, per workspace.' })
            },
            [
              agentBrowserConsent.el,
              // ADR 0002 wording is load-bearing: same clauses, given room to breathe.
              el('p', {
                class: 'settings-scope',
                text: 'The dock uses its own empty session (agents never touch your system browser or its logins), and a page an agent reads is untrusted content. Agents can never read cookies or credentials (ADR 0002).'
              })
            ]
          ),
          createActOriginsCard()
        ])
      },
      {
        id: 'activity',
        label: 'Activity',
        // The agent audit trail (8/05) — a Trust surface, not an integrations knob:
        // Privacy and Browser decide what agents MAY do; this is how you check
        // what they DID (web acts, MCP writes, webhook deliveries).
        el: section(
          'activity',
          'Activity',
          'What agents did — web acts, MCP writes, webhook deliveries. Kept on this machine.',
          [createActivitySection()]
        )
      },
      {
        id: 'shortcuts',
        label: 'Shortcuts',
        el: section(
          'shortcuts',
          'Keyboard shortcuts',
          // F-43: say bindings are fixed — users arriving from VS Code hunt for a
          // rebind affordance that does not exist.
          'Press ? anywhere (outside a terminal or text field) to pull this up as an overlay. Shortcuts are fixed in this release.',
          [Card({}, [renderShortcutList()])]
        )
      },
      {
        id: 'about',
        label: 'About',
        // 8.5/01: the smallest live customer of the layout primitives — Card +
        // SectionHeader + TwoColumn + FieldGroup, so none of them can rot
        // unexercised. Every other surface adopts them in 02–08.
        // Updates live HERE, not in a section of their own. The convention for apps this
        // size is that About IS the update surface — Obsidian, GitHub Desktop, Figma, and
        // Chrome (whose About page literally performs the check). A dedicated pane is what
        // Docker and JetBrains need because their updates have components, channels and
        // restart semantics; ours has four controls and would rattle around in an empty tab.
        // It goes FIRST: "what am I running, and is there a newer one" is the question people
        // actually open this page to answer.
        el: section('about', 'About', 'What version you are running, what this app is, and what it refuses to be.', [
          createUpdatesSection(),
          Card(
            {
              header: SectionHeader({
                title: 'MoggingLabs Workspace',
                caption:
                  'A neutral, reliable, cross-platform organizer for AI coding-agent CLIs. Your keys, your CLIs — no subscription to us.'
              })
            },
            [
              // The Version row moved up into the Updates card, where the number sits next to
              // the thing that can change it. Two places claiming to tell you what you are
              // running is one place too many.
              el('p', {
                class: 'card-caption',
                text: 'Agents run as YOUR CLIs under YOUR login. The app orchestrates config the CLIs own; it never brokers, stores, or proxies your CLI login (ADR 0002). The only secrets it ever holds are integration keys and webhook URLs you explicitly vault — see Privacy. Terminal output, prompts, and code never leave this machine.'
              })
            ]
          )
        ])
      }
    ]

    const contentCol = el('div', { class: 'settings-content' }, sections.map((s) => s.el))

    // Each tab is its OWN page (not stacked sections): selecting one shows only
    // that section and hides the rest. The DOM is still built once, so hiding
    // (not removing) preserves unsaved form text across tab switches and
    // leave/return. The last-open tab is remembered per install.
    const SETTINGS_TAB_KEY = 'mogging.settingsTab'
    const navItems = sections.map((s) =>
      el(
        'button',
        {
          class: 'settings-nav-item',
          type: 'button',
          dataset: { target: s.id },
          onClick: () => showSection(s.id)
        },
        [icon(TAB_ICON[s.id] ?? 'sliders', 16), el('span', { class: 'settings-nav-text', text: s.label })]
      )
    )
    const navById = new Map(sections.map((s, i) => [s.id, navItems[i]]))
    let currentSection = ''
    function showSection(id: string): void {
      const target = sections.some((s) => s.id === id) ? id : sections[0].id
      currentSection = target
      for (const s of sections) s.el.hidden = s.id !== target
      for (const b of navItems) b.classList.toggle('is-active', b.dataset.target === target)
      contentCol.scrollTop = 0
      setPref(SETTINGS_TAB_KEY, target)
      if (target === 'integrations' && activeView() === 'settings') enterIntegrations()
    }
    showSection(pref(SETTINGS_TAB_KEY) ?? sections[0].id)
    // Cross-links between tabs (F-10) and the rail search (S5) jump through this —
    // live when the page is up, a pending request otherwise.
    registerSettingsTabNav((id) => {
      showSection(id)
      setActiveView('settings')
    })

    // ── S5 · Settings search — the baseline VS Code/Chrome/macOS all lead with ──
    // Past ~30 knobs nobody navigates by taxonomy reliably; this app has ~80 across
    // 13 tabs. The index is a DOM walk over titles, captions, toggle labels and
    // field labels — rebuilt on the first keystroke of each search, so late-loading
    // blocks (usage grid, connections) are indexed by the time anyone can type.
    interface SearchHit {
      tab: string
      tabLabel: string
      title: string
      haystack: string
      target: HTMLElement
    }
    const searchIndex: SearchHit[] = []
    const buildSearchIndex = (): void => {
      searchIndex.length = 0
      for (const s of sections) {
        const claim = (target: HTMLElement, title: string, extra = ''): void => {
          const t = title.trim()
          if (t) searchIndex.push({ tab: s.id, tabLabel: s.label, title: t, haystack: `${t} ${extra}`.toLowerCase(), target })
        }
        claim(s.el, s.label, s.el.querySelector('.settings-section-head .section-header-caption')?.textContent ?? '')
        for (const head of s.el.querySelectorAll<HTMLElement>('.section-header-title')) {
          const card = head.closest<HTMLElement>('.card') ?? head
          claim(card, head.textContent ?? '', card.querySelector('.section-header-caption')?.textContent ?? '')
        }
        for (const cc of s.el.querySelectorAll<HTMLElement>('.collapsible-card')) {
          claim(cc, cc.querySelector('.cc-title')?.textContent ?? '', cc.querySelector('.cc-caption')?.textContent ?? '')
        }
        for (const row of s.el.querySelectorAll<HTMLElement>('.toggle-row')) {
          claim(row, row.querySelector('.toggle-row-label')?.textContent ?? '', row.querySelector('.toggle-row-hint')?.textContent ?? '')
        }
        for (const fg of s.el.querySelectorAll<HTMLElement>('.field-group')) {
          claim(fg, fg.querySelector('.field-group-label')?.textContent ?? '', fg.querySelector('.field-group-hint')?.textContent ?? '')
        }
      }
    }
    const searchInput = el('input', { class: 'input input-sm settings-search', ariaLabel: 'Search settings' }) as HTMLInputElement
    searchInput.type = 'search'
    searchInput.placeholder = 'Search settings…'
    const searchResults = el('div', { class: 'settings-search-results' })
    searchResults.hidden = true
    const jumpTo = (hit: SearchHit): void => {
      showSection(hit.tab)
      searchInput.value = ''
      runSearch()
      // A hit inside a folded card opens it first — landing on a 40px header
      // and revealing nothing is a no-op shaped like a success.
      const fold = hit.target.closest<HTMLElement>('.collapsible-card')
      if (fold && !fold.classList.contains('is-open')) {
        fold.querySelector<HTMLButtonElement>('.cc-toggle')?.click()
      }
      setTimeout(() => {
        hit.target.scrollIntoView({ block: 'center' })
        hit.target.classList.add('search-hit-flash')
        setTimeout(() => hit.target.classList.remove('search-hit-flash'), 2000)
      }, 60)
    }
    let lastQuery = ''
    function runSearch(): void {
      const q = searchInput.value.trim().toLowerCase()
      searchResults.replaceChildren()
      searchResults.hidden = !q
      if (!q) {
        lastQuery = ''
        return
      }
      if (!lastQuery) buildSearchIndex() // fresh walk per search session
      lastQuery = q
      const seen = new Set<HTMLElement>()
      const hits = searchIndex
        .filter((h) => h.haystack.includes(q) && !seen.has(h.target) && (seen.add(h.target), true))
        .slice(0, 12)
      if (!hits.length) {
        searchResults.append(el('div', { class: 'settings-search-none', text: 'No setting matches.' }))
        return
      }
      for (const h of hits) {
        searchResults.append(
          el('button', { class: 'settings-search-hit', type: 'button', onClick: () => jumpTo(h) }, [
            el('span', { class: 'settings-search-hit-title', text: h.title }),
            el('span', { class: 'settings-search-hit-tab', text: h.tabLabel })
          ])
        )
      }
    }
    searchInput.addEventListener('input', runSearch)
    searchInput.addEventListener('keydown', (e) => {
      e.stopPropagation() // typing must not trip page-level bindings
      if (e.key === 'Escape') {
        if (searchInput.value) {
          searchInput.value = ''
          runSearch()
        } else {
          searchInput.blur()
        }
        e.preventDefault()
      }
      if (e.key === 'Enter') {
        searchResults.querySelector<HTMLButtonElement>('.settings-search-hit')?.click()
        e.preventDefault()
      }
    })

    const backBtn = Button({
      label: 'Back',
      icon: 'chevron-left',
      variant: 'ghost',
      size: 'sm',
      onClick: () => goBack()
    })
    backBtn.classList.add('settings-back')

    // Grouped nav. A tab missing from NAV_GROUPS would silently vanish from the
    // rail while its section still existed — so the leftovers are appended, loudly.
    const grouped = new Set(NAV_GROUPS.flatMap((g) => g.ids))
    const orphans = sections.filter((s) => !grouped.has(s.id)).map((s) => s.id)
    if (orphans.length && import.meta.env.DEV) console.warn(`settings: tabs missing from NAV_GROUPS: ${orphans.join(', ')}`)
    const navBox = el('div', { class: 'settings-nav' }, [
      backBtn,
      searchInput,
      searchResults,
      ...NAV_GROUPS.flatMap((g) => [
        el('span', { class: 'settings-nav-group', text: g.label }),
        ...g.ids.map((id) => navById.get(id) ?? null)
      ]),
      ...orphans.map((id) => navById.get(id) ?? null)
    ])

    // TwoColumn's first FEATURE customer (8.5/01 § Deviations #5). It builds the
    // <nav> landmark, so `navBox` stays a plain <div> — nesting navs would give the
    // rail two landmarks with one name.
    const page = el('div', {})
    page.id = 'view-settings'
    page.append(TwoColumn({ side: navBox, ariaLabel: 'Settings sections', class: 'settings-page' }, [contentCol]))
    ctx.content.append(page)

    // Entering the page re-pulls consent + refreshes the managed lists — but never
    // while a form is open (unsaved text must survive leave/return; page DOM is
    // never rebuilt). Esc leaves, back to wherever the user came from.
    onViewChange((v) => {
      if (v !== 'settings') return
      const requested = takeRequestedSettingsTab() // a deep-link (e.g. the usage gear)
      if (requested) showSection(requested)
      else if (currentSection === 'integrations') enterIntegrations()
      void pullConsent()
      void providers.refresh() // re-detect: a CLI installed since last visit flips to Available
      if (!page.querySelector('.ph-form')) void profilesHosts.refresh()
      getTelemetry().captureEvent({ name: 'settings.opened' })
    })
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented || activeView() !== 'settings') return
      // Overlays above the page (palette, dialogs) own their own Esc.
      if (document.querySelector('.palette-overlay:not([hidden]), .modal-overlay')) return
      e.preventDefault()
      goBack()
    })
    // S5: Ctrl/Cmd+F inside Settings focuses the search — the browser find has no
    // meaning on a page whose content is mostly hidden tabs.
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key === 'f' && activeView() === 'settings') {
        e.preventDefault()
        searchInput.focus()
        searchInput.select()
      }
    })
    // NAV-01: Ctrl/Cmd+, opens Settings from anywhere (the platform convention),
    // toggling back out if it's already up — matching the gear button.
    window.addEventListener(
      'keydown',
      (e) => {
        if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key === ',') {
          e.preventDefault()
          e.stopPropagation()
          if (activeView() === 'settings') goBack()
          else setActiveView('settings')
        }
      },
      true
    )

    // Dev/gallery handles: switch themes + render the full icon sheet for shots.
    if (import.meta.env.DEV) {
      const w = window as unknown as { __mogging?: Record<string, unknown> }
      w.__mogging = w.__mogging ?? {}
      w.__mogging.setTheme = (id: string) => setTheme(id)
      w.__mogging.settingsTab = (id: string) => showSection(id) // deep-link a tab (smokes/gallery)
      w.__mogging.setTerminalFontSize = (n: number) => (setTerminalFontSize(n), fontSeg.setValue(String(n)))
      w.__mogging.iconSheet = () => {
        const id = 'mogging-icon-sheet'
        const prev = document.getElementById(id)
        if (prev) {
          prev.remove()
          return 0
        }
        const host = document.createElement('div')
        host.id = id
        host.style.cssText =
          'position:fixed;inset:0;z-index:999;overflow:auto;padding:24px;background:var(--bg-app);' +
          'display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:6px 16px;' +
          'font-family:var(--font-mono);font-size:11px;color:var(--text-mid);align-content:start'
        for (const n of ICON_NAMES) {
          const cell = document.createElement('div')
          cell.style.cssText = 'display:flex;align-items:center;gap:10px;padding:4px 0'
          for (const s of [12, 16, 24]) cell.append(icon(n, s))
          cell.append(Object.assign(document.createElement('span'), { textContent: n }))
          host.append(cell)
        }
        document.body.append(host)
        return 1
      }
    }

    // Integrations palette verbs (8/13) — routes into the ONE home, not new
    // capabilities. Every integrations action is reachable from ⌘K.
    const goIntegrations = (focus: IntegrationsFocus): void => {
      requestIntegrationsFocus(focus)
      showSection('integrations')
      setActiveView('settings')
      // `setActiveView` early-returns when Settings is ALREADY the view, so its
      // onViewChange listeners never fire and the token sat pending until the next
      // fresh entry — which then scrolled somewhere the user hadn't asked for. Enter
      // here too; `enterIntegrations` coalesces, so the double call does one pass.
      enterIntegrations()
    }
    setCommands('settings', [
      {
        id: 'settings:open',
        title: 'Open Settings',
        hint: 'App',
        kbd: 'Ctrl+,',
        run: () => setActiveView('settings')
      },
      { id: 'integrations:setup', title: 'Set up integrations…', hint: 'Integrations', run: () => goIntegrations('flow') },
      { id: 'integrations:open', title: 'Open integrations', hint: 'Integrations', run: () => goIntegrations('servers') },
      { id: 'integrations:matrix', title: 'Open integrations matrix (workspace tools)', hint: 'Integrations', run: () => goIntegrations('matrix') },
      // REMOVE #2: `integrations:connect` was `integrations:open` under a second name —
      // both ran goIntegrations('servers'). REMOVE #3: `integrations:restart` promised a
      // restart in its title and only scrolled to the matrix. A verb that lies is worse
      // than a missing one; the matrix now reports pending panes on its fold instead.
      // Webhooks and Activity are TABS now, not integrations sub-blocks — their verbs
      // are plain tab switches, no focus token to drain.
      { id: 'webhooks:add', title: 'Add a webhook (event bridge)', hint: 'Notifications', run: () => { showSection('webhooks'); setActiveView('settings') } },
      { id: 'activity:open', title: 'Open the activity trail', hint: 'Trust', run: () => { showSection('activity'); setActiveView('settings') } },
      ...THEMES.map((t) => ({
        id: `theme:${t.id}`,
        title: `Theme: ${t.name}`,
        hint: 'Appearance',
        run: () => setTheme(t.id)
      }))
    ])
  }
}
