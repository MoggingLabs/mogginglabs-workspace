import type { UiFeature } from '../../core/registry/feature-registry'
import { BrowserChannels, TelemetryChannels, UsageChannels, USAGE_CADENCES, type TelemetryRendererConfig, type UsageAlertConfig, type UsageConfig } from '@contracts'
import { getWorkspaces } from '../../core/workspace/workspace-info-port'
import { Button, createCheckbox, createSegmented, el, icon, ICON_NAMES } from '../../components'
import { THEMES } from '../../core/theme/themes'
import { currentThemeId, onThemeChange, setTheme } from '../../core/theme/theme-state'
import { setCommands } from '../../core/commands/command-port'
import { getBridge } from '../../core/ipc/bridge'
import { getTelemetry } from '../../core/telemetry'
import { activeView, goBack, onViewChange, setActiveView } from '../../core/shell/view-port'
import { setTerminalFontSize, terminalFontSize, TERMINAL_FONT_SIZES } from '../../core/terminal/font-port'
import { TEMPLATE_COUNTS } from '../layout'
import { createProfilesHostsSection } from './profiles-hosts'
import { createUsageSection } from './usage'
import { createIntegrationsSection } from './integrations'

const DEFAULT_LAYOUT_KEY = 'mogging.defaultPaneCount'

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
 * Settings — a FULL-APP page (Phase-5/05, was a modal): left section nav
 * (Appearance · Terminal · Profiles & Hosts · Privacy · About) over a scrollable
 * content column. Theme, default wizard layout, and telemetry CONSENT
 * (observability/00, ADR 0005) — two independent opt-in toggles persisted
 * main-side over IPC; granting or revoking re-initializes the adapters live.
 * BYO-auth is stated, not configured: there are deliberately no credential fields
 * anywhere in this app (ADR 0002). The page DOM is built ONCE at mount — unsaved
 * form text survives leaving and returning within a session.
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
    const errorConsent = createCheckbox({
      checked: false,
      label: 'Error reporting (Sentry)',
      onChange: () => void pushConsent()
    })
    const analyticsConsent = createCheckbox({
      checked: false,
      label: 'Product analytics (PostHog)',
      onChange: () => void pushConsent()
    })

    // Agent-browser-control consent (6/05b): per-workspace, default OFF.
    const agentBrowserConsent = createCheckbox({
      checked: false,
      label: 'Agents may drive the browser (this workspace)',
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

    const row = (label: string, control: Node, caption?: string): HTMLElement =>
      el('div', { class: 'settings-row' }, [
        el('div', { class: 'settings-row-head' }, [
          el('span', { class: 'settings-row-label', text: label }),
          caption ? el('span', { class: 'settings-row-caption', text: caption }) : null
        ]),
        control
      ])

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

    const section = (id: string, title: string, children: (Node | null)[]): HTMLElement =>
      el('section', { class: 'settings-section', dataset: { section: id } }, [
        el('h2', { class: 'section-label', text: title }),
        ...children
      ])

    const sections: { id: string; label: string; el: HTMLElement }[] = [
      {
        id: 'appearance',
        label: 'Appearance',
        el: section('appearance', 'Appearance', [
          row('Theme', themeSeg.el, 'System follows your OS light/dark preference.')
        ])
      },
      {
        id: 'terminal',
        label: 'Terminal',
        el: section('terminal', 'Terminal', [
          row(
            'Font size',
            fontSeg.el,
            'Applied live to every open terminal. Line height is fixed — only size varies.'
          ),
          row('New-workspace layout', layoutSeg.el, 'How many terminals the wizard suggests.')
        ])
      },
      {
        id: 'profiles',
        label: 'Profiles & Hosts',
        el: section('profiles', 'Profiles & SSH hosts', [
          row(
            'Pointer sets only',
            profilesHosts,
            'Profiles select WHICH of your accounts a CLI uses; hosts are ssh targets. Never keys, tokens, or passwords — secret-shaped values are refused at save (ADR 0002).'
          )
        ])
      },
      {
        id: 'usage',
        label: 'Usage',
        // The FULL Usage tab (7/12) — one module, one home for every usage
        // knob: the provider grid, plans × profiles, pace/alerts/display,
        // history + cost, and the privacy story. The 7/03 stub is gone.
        el: section('usage', 'Usage', [createUsageSection()])
      },
      {
        id: 'integrations',
        label: 'Integrations',
        // 8/05 lands the Activity trail; 8/06+ grows this into THE integrations
        // home (server registration, catalog, grants) — one module, one home.
        el: section('integrations', 'Integrations', [createIntegrationsSection()])
      },
      {
        id: 'privacy',
        label: 'Privacy',
        el: section('privacy', 'Privacy', [
          row(
            'Help improve the app',
            el('div', { class: 'settings-consents' }, [errorConsent.el, analyticsConsent.el]),
            'Both are OFF by default and fully anonymous (a random install id — never your account, machine name, or provider identity). Telemetry NEVER includes terminal output, prompts, code, file paths, environment variables, or credentials. Changes apply immediately; DO_NOT_TRACK is always honored.'
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
        el: section('browser', 'Browser', [
          row(
            'Agents may drive the browser',
            el('div', { class: 'settings-consents' }, [agentBrowserConsent.el]),
            'OFF by default, per workspace. When on, agents in THIS workspace can navigate, read, and act on the browser dock — you always see when an agent holds the wheel and can Stop it instantly. The dock uses its own empty session (agents never touch your system browser or its logins), and a page an agent reads is untrusted content. Agents can never read cookies or credentials (ADR 0002).'
          )
        ])
      },
      {
        id: 'about',
        label: 'About',
        el: section('about', 'About', [
          el('div', { class: 'settings-about' }, [
            el('span', { class: 'settings-about-name', text: 'MoggingLabs Workspace' }),
            version,
            el('span', {
              class: 'settings-row-caption',
              text: 'A neutral, reliable, cross-platform organizer for AI coding-agent CLIs. Your keys, your CLIs — no subscription to us.'
            })
          ])
        ])
      }
    ]

    const contentCol = el('div', { class: 'settings-content' }, sections.map((s) => s.el))

    const navItems = sections.map((s) =>
      el(
        'button',
        {
          class: 'settings-nav-item',
          type: 'button',
          dataset: { target: s.id },
          onClick: () => {
            s.el.scrollIntoView({ behavior: 'smooth', block: 'start' })
            for (const b of navItems) b.classList.toggle('is-active', b.dataset.target === s.id)
          }
        },
        [s.label]
      )
    )
    navItems[0].classList.add('is-active')

    const backBtn = Button({
      label: 'Back',
      icon: 'chevron-left',
      variant: 'ghost',
      size: 'sm',
      onClick: () => goBack()
    })
    backBtn.classList.add('settings-back')
    const nav = el('nav', { class: 'settings-nav', ariaLabel: 'Settings sections' }, [
      backBtn,
      ...navItems
    ])

    const page = el('div', {})
    page.id = 'view-settings'
    page.append(el('div', { class: 'settings-page' }, [nav, contentCol]))
    ctx.content.append(page)

    // Entering the page re-pulls consent + refreshes the managed lists — but never
    // while a form is open (unsaved text must survive leave/return; page DOM is
    // never rebuilt). Esc leaves, back to wherever the user came from.
    onViewChange((v) => {
      if (v !== 'settings') return
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

    // Dev/gallery handles: switch themes + render the full icon sheet for shots.
    if (import.meta.env.DEV) {
      const w = window as unknown as { __mogging?: Record<string, unknown> }
      w.__mogging = w.__mogging ?? {}
      w.__mogging.setTheme = (id: string) => setTheme(id)
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

    setCommands('settings', [
      {
        id: 'settings:open',
        title: 'Open Settings',
        hint: 'App',
        run: () => setActiveView('settings')
      },
      ...THEMES.map((t) => ({
        id: `theme:${t.id}`,
        title: `Theme: ${t.name}`,
        hint: 'Appearance',
        run: () => setTheme(t.id)
      }))
    ])
  }
}
