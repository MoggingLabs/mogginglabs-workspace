import type { UiFeature } from '../../core/registry/feature-registry'
import {
  TemplateChannels,
  WorkspaceChannels,
  type ProviderMixTemplate,
  type RecentWorkspace,
  type WorkspaceState
} from '@contracts'
import { Button, EmptyState, clear, el, icon } from '../../components'
import { getBridge } from '../../core/ipc/bridge'
import { onViewChange } from '../../core/shell/view-port'
import { openWorkspaceFromTemplate } from '../../core/workspace/open-service'
import {
  getWorkspaces,
  requestWorkspaceSwitch
} from '../../core/workspace/workspace-info-port'
import { openWizard } from '../../core/workspace/wizard-port'
import { runCommand } from '../../core/commands/command-port'
import { getTelemetry } from '../../core/telemetry'
import { createFirstRun } from './firstrun'

const basename = (p: string): string => p.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? ''

/** A short, privacy-safe path: the last two segments only. The full cwd rides the
 *  button's `title` for hover — never telemetry (home.recent_reopened sends a count). */
const shortPath = (cwd: string): string => {
  if (!cwd) return 'no folder'
  const parts = cwd.split(/[/\\]/).filter(Boolean)
  return parts.length <= 2 ? cwd : '…/' + parts.slice(-2).join('/')
}

/** Relative last-open, compact — from RecentWorkspace.lastUsedAt (epoch ms). */
const relTime = (ms: number): string => {
  const d = Date.now() - ms
  if (!ms || d < 60_000) return 'just now'
  const m = Math.floor(d / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const days = Math.floor(h / 24)
  if (days < 7) return `${days}d ago`
  const w = Math.floor(days / 7)
  return w < 5 ? `${w}w ago` : `${Math.floor(days / 30)}mo ago`
}

const isMac = navigator.platform.toUpperCase().includes('MAC')
const MOD = isMac ? '⌘' : 'Ctrl'

/** Rotating welcome lines — one per app open (persisted index, not random, so every
 *  launch greets differently). Name-ready: when accounts land, pass the user's name.
 *  TODO(accounts): thread the signed-in name into greeting(). */
const GREETINGS = [
  'Welcome back',
  'Good to see you',
  'Ready when you are',
  'Let’s ship something',
  'The fleet awaits'
]
function greeting(name = ''): string {
  let i = 0
  try {
    i = Number(localStorage.getItem('mogging.greetIndex') || '0') || 0
    localStorage.setItem('mogging.greetIndex', String((i + 1) % GREETINGS.length))
  } catch {
    /* storage unavailable — first greeting it is */
  }
  const base = GREETINGS[i % GREETINGS.length]
  return name ? `${base}, ${name}.` : `${base}.`
}

/**
 * Home / launcher: brand hero + primary actions + one-click recents + presets + a
 * keyboard-hint bar. First-run shows a designed empty state; returning users get
 * their recent workspaces back in one click. We are ONE focused organizer — no fake
 * product tiles here (deliberate divergence from the competitor's launcher).
 */
export const homeFeature: UiFeature = {
  name: 'home',
  mount(ctx) {
    const view = el('div', {})
    view.id = 'view-home'
    ctx.content.append(view)

    const hero = el('div', { class: 'home-hero' }, [
      el('img', { class: 'home-logo', attrs: { src: './logo.png', alt: '' } }),
      el('h1', { class: 'home-title', text: 'MoggingLabs Workspace' }),
      el('p', { class: 'home-welcome', text: greeting() }),
      el('div', { class: 'home-ctas' }, [
        Button({
          label: 'New workspace',
          icon: 'plus',
          variant: 'primary',
          size: 'lg',
          kbd: `${MOD}+T`,
          onClick: () => {
            if (!openWizard()) runCommand('workspace:quick')
          }
        }),
        Button({
          label: 'Quick terminal',
          icon: 'terminal',
          size: 'lg',
          onClick: () => runCommand('workspace:quick')
        })
      ])
    ])

    const recentsList = el('div', { class: 'home-recents-grid' })
    const presetsList = el('div', { class: 'home-list' })
    const sections = el('div', { class: 'home-sections' }, [
      el('section', { class: 'home-section' }, [
        el('h2', { class: 'section-label', text: 'Recent projects' }),
        recentsList
      ]),
      el('section', { class: 'home-section' }, [
        el('h2', { class: 'section-label', text: 'Presets' }),
        presetsList
      ])
    ])

    const hint = (kbd: string, label: string): HTMLElement =>
      el('span', { class: 'home-hint' }, [
        el('span', { class: 'kbd', text: kbd }),
        el('span', { text: label })
      ])
    const hints = el('div', { class: 'home-hints' }, [
      hint(`${MOD}+T`, 'new workspace'),
      hint(`${MOD}+K`, 'commands'),
      hint(`${MOD}+1–9`, 'switch workspace'),
      hint(`${MOD}+Alt+←→`, 'move between panes'),
      hint(`${MOD}+⇧+Enter`, 'zoom pane')
    ])

    // First-run checklist (6/06): live, dismissible, sits between hero and sections.
    const firstrun = createFirstRun()
    view.append(hero, firstrun.el, sections, hints)

    function renderRecents(recents: RecentWorkspace[]): void {
      clear(recentsList)
      if (!recents.length) {
        recentsList.append(
          EmptyState({
            icon: 'clock',
            title: 'No recent projects yet',
            body: 'The five most recent projects you work on show up here — folder, layout and agent lineup included, one click to reopen.',
            action: Button({
              label: 'New workspace',
              icon: 'plus',
              variant: 'primary',
              size: 'sm',
              onClick: () => {
                if (!openWizard()) runCommand('workspace:quick')
              }
            })
          })
        )
        return
      }
      for (const r of recents) {
        const agentCount = (r.assignments ?? []).filter((a) => a && a !== 'shell').length
        recentsList.append(
          el(
            'button',
            {
              class: 'home-recent',
              type: 'button',
              title: r.cwd, // full path for hover only — never telemetry
              onClick: () => {
                getTelemetry().captureEvent({ name: 'home.recent_reopened', props: { panes: r.paneCount } })
                // Already open for this folder? Switch instead of duplicating.
                const openWs = getWorkspaces().workspaces.find((w) => w.cwd && w.cwd === r.cwd)
                if (openWs) {
                  requestWorkspaceSwitch(openWs.id)
                  return
                }
                openWorkspaceFromTemplate({
                  name: r.name || basename(r.cwd) || 'Workspace',
                  cwd: r.cwd,
                  paneCount: r.paneCount,
                  assignments: r.assignments ?? Array.from({ length: r.paneCount }, () => 'shell')
                })
              }
            },
            [
              el('div', { class: 'home-recent-head' }, [
                el('span', { class: 'home-recent-icon' }, [icon('folder', 14)]),
                el('span', { class: 'home-recent-name', text: r.name || basename(r.cwd) }),
                el('span', { class: 'home-recent-when', text: relTime(r.lastUsedAt) })
              ]),
              el('span', { class: 'home-recent-path', text: shortPath(r.cwd) }),
              el('div', { class: 'home-recent-chips' }, [
                el('span', { class: 'home-recent-chip', text: `${r.paneCount} ${r.paneCount === 1 ? 'pane' : 'panes'}` }),
                agentCount ? el('span', { class: 'home-recent-chip', text: `${agentCount} ${agentCount === 1 ? 'agent' : 'agents'}` }) : null
              ])
            ]
          )
        )
      }
    }

    function renderPresets(presets: ProviderMixTemplate[]): void {
      clear(presetsList)
      if (!presets.length) {
        presetsList.append(
          EmptyState({
            icon: 'layout-grid',
            title: 'No presets yet',
            body: 'Save an agent mix in the workspace wizard and open it from here in one click.'
          })
        )
        return
      }
      for (const p of presets) {
        const total = p.mix.reduce((s, m) => s + m.count, 0)
        presetsList.append(
          el(
            'button',
            {
              class: 'home-item',
              type: 'button',
              onClick: () => {
                getTelemetry().captureEvent({ name: 'home.preset_opened' })
                openWizard({ mix: p.mix })
              }
            },
            [
              el('span', { class: 'home-item-icon home-item-icon--accent' }, [
                icon('sparkles', 14)
              ]),
              el('div', { class: 'home-item-body' }, [
                el('span', { class: 'home-item-name', text: p.name }),
                el('span', {
                  class: 'home-item-sub',
                  text: p.mix.map((m) => `${m.count}× ${m.provider.replace(/^custom:.*/, 'custom')}`).join(' · ')
                })
              ]),
              el('span', { class: 'home-item-meta', text: `${total} agents` }),
              el('span', { class: 'home-item-go' }, [icon('arrow-right', 14)])
            ]
          )
        )
      }
    }

    async function refresh(): Promise<void> {
      try {
        const state = (await getBridge().invoke(WorkspaceChannels.loadState)) as WorkspaceState | null
        renderRecents(state?.recents ?? [])
      } catch {
        renderRecents([])
      }
      try {
        const presets = (await getBridge().invoke(TemplateChannels.list)) as ProviderMixTemplate[]
        renderPresets(presets ?? [])
      } catch {
        renderPresets([])
      }
    }

    // Refresh whenever Home becomes the active view (event-driven, no polling).
    onViewChange((v) => {
      if (v === 'home') {
        void refresh()
        void firstrun.refresh() // live checklist state every time Home shows
        getTelemetry().captureEvent({ name: 'home.opened' })
      }
    })
    void firstrun.refresh() // and once at mount (Home is the boot view)

    // Dev handle for the first-run smoke.
    if (import.meta.env.DEV) {
      const w = window as unknown as { __mogging?: Record<string, unknown> }
      w.__mogging = w.__mogging ?? {}
      w.__mogging.firstrun = { refresh: () => firstrun.refresh() }
      w.__mogging.home = { refresh: () => refresh() } // recents/presets re-read (HOMEUX seeds a recent)
    }
  }
}
