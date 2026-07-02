import type { UiFeature } from '../../core/registry/feature-registry'
import { TelemetryChannels, type TelemetryRendererConfig } from '@contracts'
import { Button, createCheckbox, createModal, createSegmented, el, icon, ICON_NAMES } from '../../components'
import { THEMES } from '../../core/theme/themes'
import { currentThemeId, onThemeChange, setTheme } from '../../core/theme/theme-state'
import { setCommands } from '../../core/commands/command-port'
import { getBridge } from '../../core/ipc/bridge'
import { getTelemetry } from '../../core/telemetry'
import { TEMPLATE_COUNTS } from '../layout'
import { createProfilesHostsSection } from './profiles-hosts'

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
 * Settings: theme, default wizard layout, and telemetry CONSENT (observability/00,
 * ADR 0005) — two independent opt-in toggles persisted main-side over IPC; granting or
 * revoking re-initializes the adapters live. BYO-auth is stated, not configured: there
 * are deliberately no credential fields anywhere in this app (ADR 0002).
 */
export const settingsFeature: UiFeature = {
  name: 'settings',
  mount() {
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

    async function pullConsent(): Promise<void> {
      try {
        const cfg = (await getBridge().invoke(TelemetryChannels.getConfig)) as TelemetryRendererConfig
        errorConsent.setChecked(!!cfg.errorReporting)
        analyticsConsent.setChecked(!!cfg.productAnalytics)
      } catch {
        /* bridge unavailable — leave off */
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

    const body = el('div', { class: 'settings' }, [
      row('Theme', themeSeg.el, 'System follows your OS light/dark preference.'),
      row('New-workspace layout', layoutSeg.el, 'How many terminals the wizard suggests.'),
      row(
        'Profiles & SSH hosts',
        profilesHosts,
        'Pointer sets only: profiles select WHICH of your accounts a CLI uses; hosts are ssh targets. Never keys, tokens, or passwords — secret-shaped values are refused at save (ADR 0002).'
      ),
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

    const modal = createModal({
      title: 'Settings',
      subtitle: 'Theme · profiles · hosts · privacy',
      body,
      footer: el('div', { class: 'settings-footer' }, [
        el('span', {}),
        Button({ label: 'Done', variant: 'primary', onClick: () => modal.close() })
      ])
    })

    // Dev/gallery handles: switch themes + render the full icon sheet for shots.
    if (import.meta.env.DEV) {
      const w = window as unknown as { __mogging?: Record<string, unknown> }
      w.__mogging = w.__mogging ?? {}
      w.__mogging.setTheme = (id: string) => setTheme(id)
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
        run: () => {
          void pullConsent()
          void profilesHosts.refresh()
          modal.open()
          getTelemetry().captureEvent({ name: 'settings.opened' })
        }
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
