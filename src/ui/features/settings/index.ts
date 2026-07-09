import type { UiFeature } from '../../core/registry/feature-registry'
import { BrowserChannels, TelemetryChannels, type TelemetryRendererConfig } from '@contracts'
import { getWorkspaces } from '../../core/workspace/workspace-info-port'
import { Button, Card, FieldGroup, SectionHeader, TwoColumn, createSegmented, createToggleRow, el, icon, ICON_NAMES, type ElChild, type IconName } from '../../components'
import { THEMES } from '../../core/theme/themes'
import { currentThemeId, onThemeChange, setTheme } from '../../core/theme/theme-state'
import { setCommands } from '../../core/commands/command-port'
import { getBridge } from '../../core/ipc/bridge'
import { getTelemetry } from '../../core/telemetry'
import { activeView, goBack, onViewChange, setActiveView } from '../../core/shell/view-port'
import { takeRequestedSettingsTab } from '../../core/shell/settings-tab-port'
import { requestIntegrationsFocus, type IntegrationsFocus } from '../../core/shell/integrations-focus-port'
import { renderShortcutList } from '../../core/commands/shortcuts'
import { setTerminalFontSize, terminalFontSize, TERMINAL_FONT_SIZES } from '../../core/terminal/font-port'
import { TEMPLATE_COUNTS } from '../layout'
import { createClipboardSection } from './clipboard'
import { createProfilesHostsSection } from './profiles-hosts'
import { createUsageSection } from './usage'
import { createIntegrationsSection, enterIntegrations } from './integrations'

const DEFAULT_LAYOUT_KEY = 'mogging.defaultPaneCount'

/**
 * The nav is a MAP, not a list (8.5/04). Nine flat rows say only "there are nine";
 * four named groups say where a knob lives before you read the labels. Grouping is
 * visual — every knob keeps its tab, and every tab keeps its `data-target` id.
 */
const NAV_GROUPS: { label: string; ids: string[] }[] = [
  { label: 'Workspace', ids: ['appearance', 'terminal', 'clipboard'] },
  { label: 'Agents & tools', ids: ['profiles', 'integrations', 'usage'] },
  { label: 'Trust', ids: ['privacy', 'browser'] },
  { label: 'System', ids: ['shortcuts', 'about'] }
]

const TAB_ICON: Record<string, IconName> = {
  appearance: 'sliders',
  terminal: 'terminal',
  clipboard: 'copy',
  profiles: 'user',
  integrations: 'plug',
  usage: 'gauge',
  privacy: 'shield',
  browser: 'globe',
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
    const themeSeg = createSegmented({
      options: THEMES.map((t) => ({ id: t.id, label: t.name })),
      value: currentThemeId(),
      ariaLabel: 'Theme',
      onChange: (id) => {
        setTheme(id)
        getTelemetry().captureEvent({ name: 'theme.changed', props: { theme: id } })
      }
    })
    onThemeChange((id) => themeSeg.setValue(id))

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
    const agentBrowserConsent = createToggleRow({
      label: 'Agents may drive the browser (this workspace)',
      hint: 'When on, agents in THIS workspace can navigate, read, and act on the browser dock — you always see when an agent holds the wheel and can Stop it instantly.',
      onChange: () => {
        const wsId = getWorkspaces().activeId
        if (!wsId) return
        void getBridge().invoke(BrowserChannels.consentSet, { workspaceId: wsId, allowed: agentBrowserConsent.checked() })
        // Make it live for the active workspace immediately.
        getBridge().send(BrowserChannels.consent, { allowed: agentBrowserConsent.checked() })
      }
    })

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

    // ── The page: [section nav | scrollable content column] ──────────────────
    const version = el('span', { class: 'settings-about-version', text: '' })
    try {
      void getBridge()
        .invoke(TelemetryChannels.getConfig)
        .then((cfg) => {
          const release = (cfg as TelemetryRendererConfig | null)?.release
          if (release) version.textContent = `Version ${release}`
        })
        .catch(() => undefined)
    } catch {
      /* no bridge (tests) */
    }

    /** A tab: one h2 SectionHeader saying what lives here, then Cards. The
     *  `data-section` hook and the `hidden` semantics are a compatibility surface —
     *  gallery, KBSHORTCUTS and USAGESET all key off them. */
    const section = (id: string, title: string, caption: string, children: ElChild[]): HTMLElement =>
      el('section', { class: 'settings-section', dataset: { section: id } }, [
        SectionHeader({ title, caption, as: 'h2', class: 'settings-section-head' }),
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
            [themeSeg.el]
          )
        ])
      },
      {
        id: 'terminal',
        label: 'Terminal',
        el: section('terminal', 'Terminal', 'Type, and what a new workspace starts with.', [
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
        id: 'profiles',
        label: 'Profiles & Hosts',
        el: section('profiles', 'Profiles & SSH hosts', 'Pointers to accounts and machines — never credentials.', [
          Card(
            {
              header: SectionHeader({
                title: 'Pointer sets only',
                caption:
                  'Profiles select WHICH of your accounts a CLI uses; hosts are ssh targets. Never keys, tokens, or passwords — secret-shaped values are refused at save (ADR 0002).'
              })
            },
            [profilesHosts]
          )
        ])
      },
      {
        id: 'usage',
        label: 'Usage',
        // The FULL Usage tab (7/12) — one module, one home for every usage
        // knob: the provider grid, plans × profiles, pace/alerts/display,
        // history + cost, and the privacy story. 8.5/04 gives it the page
        // frame; 8.5/05 rebuilds its internals.
        el: section('usage', 'Usage', 'Limits, plans, pace and alerts — read from the CLIs you already use.', [createUsageSection()])
      },
      {
        id: 'integrations',
        label: 'Integrations',
        // 8/05 lands the Activity trail; 8/06+ grows this into THE integrations
        // home (server registration, catalog, grants) — one module, one home.
        el: section(
          'integrations',
          'Integrations',
          'MCP servers, per-workspace tool plans, grants, webhooks, and the activity trail.',
          [createIntegrationsSection()]
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
              // ADR 0005 wording is load-bearing: the layout changed, the clauses did not.
              el('p', {
                class: 'settings-scope',
                text: 'Telemetry NEVER includes terminal output, prompts, code, file paths, environment variables, or credentials. Changes apply immediately; DO_NOT_TRACK is always honored.'
              })
            ]
          ),
          el('div', { class: 'settings-note' }, [
            icon('check-circle', 14),
            el('span', {
              text: 'Your keys, your CLIs: agents authenticate themselves with your own accounts. This app has no credential settings — by design.'
            })
          ])
        ])
      },
      {
        id: 'browser',
        label: 'Browser',
        el: section('browser', 'Browser', 'What agents may do with the browser dock.', [
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
          )
        ])
      },
      {
        id: 'shortcuts',
        label: 'Shortcuts',
        el: section(
          'shortcuts',
          'Keyboard shortcuts',
          'Press ? anywhere (outside a terminal or text field) to pull this up as an overlay.',
          [Card({}, [renderShortcutList()])]
        )
      },
      {
        id: 'about',
        label: 'About',
        // 8.5/01: the smallest live customer of the layout primitives — Card +
        // SectionHeader + TwoColumn + FieldGroup, so none of them can rot
        // unexercised. Every other surface adopts them in 02–08.
        el: section('about', 'About', 'What this app is, and what it refuses to be.', [
          Card(
            {
              header: SectionHeader({
                title: 'MoggingLabs Workspace',
                caption:
                  'A neutral, reliable, cross-platform organizer for AI coding-agent CLIs. Your keys, your CLIs — no subscription to us.'
              })
            },
            [
              TwoColumn(
                { side: FieldGroup({ label: 'Version', hint: 'New builds download in the background — you choose when to restart.' }, version), sideAt: 'end', measure: false },
                [
                  el('p', {
                    class: 'card-caption',
                    text: 'Agents run as YOUR CLIs under YOUR login. The app orchestrates config the CLIs own; it never brokers, stores, or proxies a credential (ADR 0002). Terminal output, prompts, and code never leave this machine.'
                  })
                ]
              )
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
    function showSection(id: string): void {
      const target = sections.some((s) => s.id === id) ? id : sections[0].id
      for (const s of sections) s.el.hidden = s.id !== target
      for (const b of navItems) b.classList.toggle('is-active', b.dataset.target === target)
      contentCol.scrollTop = 0
      setPref(SETTINGS_TAB_KEY, target)
    }
    showSection(pref(SETTINGS_TAB_KEY) ?? sections[0].id)

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
      void pullConsent()
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
      { id: 'integrations:webhooks', title: 'Add a webhook (event bridge)', hint: 'Integrations', run: () => goIntegrations('webhooks') },
      ...THEMES.map((t) => ({
        id: `theme:${t.id}`,
        title: `Theme: ${t.name}`,
        hint: 'Appearance',
        run: () => setTheme(t.id)
      }))
    ])
  }
}
