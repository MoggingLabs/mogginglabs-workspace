import type { UiFeature } from '../../core/registry/feature-registry'
import { WorkspaceChannels, type LastSessionInfo } from '@contracts'
import { Button, EmptyState, clear, el, icon, loadingRow, providerLogo } from '../../components'
import { createAsyncGuard } from '../../core/async/async-state'
import { getBridge } from '../../core/ipc/bridge'
import { onViewChange } from '../../core/shell/view-port'
import { restoreSession } from '../../core/workspace/restore-port'
import { openWizard } from '../../core/workspace/wizard-port'
import { runCommand } from '../../core/commands/command-port'
import { getTelemetry } from '../../core/telemetry'
import { createFirstRun } from './firstrun'

const basename = (p: string): string => p.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? ''

/** A short, privacy-safe path: the last two segments only. The full cwd rides the
 *  row's `title` for hover — never telemetry (home.session_restored sends counts). */
const shortPath = (cwd: string): string => {
  if (!cwd) return 'no folder'
  const parts = cwd.split(/[/\\]/).filter(Boolean)
  return parts.length <= 2 ? cwd : '…/' + parts.slice(-2).join('/')
}

/** Relative last-worked, compact — from LastSessionInfo.savedAt (epoch ms). */
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

/** How many workspaces the card lists before folding the rest into "+N more". */
const MAX_RESUME_ROWS = 4

/**
 * Home / launcher: brand hero + primary actions + the LAST-SESSION restore card + a
 * keyboard-hint bar. First-run shows a designed empty state; a returning user gets
 * their whole previous session back in one click — every workspace, every terminal,
 * every agent relaunched with resume (exact session ids where the CLI takes one; see
 * src/main/session-restore.ts). Recents and presets both live in the wizard (Ctrl+T),
 * where they prefill a NEW workspace — Home answers the other question: "put me back
 * where I was". We are ONE focused organizer — no fake product tiles here (deliberate
 * divergence from the competitor's launcher).
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

    const resumeHost = el('div', { class: 'home-resume' })
    const sections = el('div', { class: 'home-sections' }, [
      el('section', { class: 'home-section' }, [
        el('h2', { class: 'section-label', text: 'Last session' }),
        resumeHost
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

    let restoring = false

    /** One workspace of the previous session, as one calm row of the card. */
    function resumeRow(w: LastSessionInfo['workspaces'][number]): HTMLElement {
      const agents = (w.assignments ?? []).filter((a) => a && a !== 'shell')
      return el('div', { class: 'home-resume-row', attrs: { title: w.cwd } }, [
        el('span', { class: 'home-resume-dot', attrs: { style: `--dot:${w.color}` } }),
        el('span', { class: 'home-resume-name', text: w.name || basename(w.cwd) || 'Workspace' }),
        el('span', { class: 'home-resume-path', text: shortPath(w.cwd) }),
        el('span', { class: 'home-resume-chips' }, [
          el('span', { class: 'home-resume-chip', text: `${w.paneCount} ${w.paneCount === 1 ? 'pane' : 'panes'}` }),
          // The agent chip wears each provider's mark — "2× ✳" beats prose.
          agents.length
            ? el(
                'span',
                { class: 'home-resume-chip home-resume-chip--agents' },
                [
                  el('span', { text: `${agents.length}×` }),
                  ...[...new Set(agents)]
                    .slice(0, 3)
                    .map((a) => (a.startsWith('custom:') ? icon('terminal', 12) : providerLogo(a, 12)))
                ]
              )
            : null
        ])
      ])
    }

    function renderResume(info: LastSessionInfo | null): void {
      clear(resumeHost)
      if (!info || !info.workspaces.length) {
        resumeHost.append(
          EmptyState({
            icon: 'history',
            title: 'No previous session yet',
            body: 'Your workspaces are saved as you work. Close them and the whole session — layouts, terminals, agents — waits here to come back in one click.',
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
      const paneTotal = info.workspaces.reduce((s, w) => s + w.paneCount, 0)
      const agentTotal = info.workspaces.reduce(
        (s, w) => s + (w.assignments ?? []).filter((a) => a && a !== 'shell').length,
        0
      )
      const wsCount = info.workspaces.length
      const rows = info.workspaces.slice(0, MAX_RESUME_ROWS).map(resumeRow)
      if (wsCount > MAX_RESUME_ROWS) {
        rows.push(el('div', { class: 'home-resume-more', text: `+${wsCount - MAX_RESUME_ROWS} more` }))
      }
      const card = el(
        'button',
        {
          class: 'home-resume-card',
          type: 'button',
          onClick: () => void restore()
        },
        [
          el('div', { class: 'home-resume-head' }, [
            el('span', { class: 'home-resume-icon' }, [icon('history', 14)]),
            el('span', { class: 'home-resume-title', text: 'Restore last working session' }),
            el('span', { class: 'home-resume-when', text: relTime(info.savedAt) })
          ]),
          el('div', { class: 'home-resume-list' }, rows),
          el('div', { class: 'home-resume-meta' }, [
            el('span', {
              class: 'home-resume-totals',
              text:
                `${wsCount} ${wsCount === 1 ? 'workspace' : 'workspaces'} · ` +
                `${paneTotal} ${paneTotal === 1 ? 'terminal' : 'terminals'}` +
                (agentTotal ? ` · ${agentTotal} ${agentTotal === 1 ? 'agent' : 'agents'}` : ''),
            }),
            el('span', { class: 'home-resume-go' }, [icon('arrow-right', 14)])
          ])
        ]
      )
      resumeHost.append(card)
    }

    /** An error state IS an EmptyState — alert icon, the guard's human sentence, a retry. It is
     *  emphatically NOT the calm copy above: "no previous session yet" and "we could not ask" are
     *  different facts, and rendering the first when the second is true is the audit's worst lie
     *  (finding 39) precisely because nothing looks wrong. */
    function renderLoadError(title: string, message: string): void {
      clear(resumeHost)
      resumeHost.append(
        EmptyState({
          icon: 'alert',
          title,
          body: message,
          action: Button({ label: 'Retry', icon: 'rotate-cw', size: 'sm', onClick: () => void refresh() })
        })
      )
    }

    /** Rebuild the previous session: arm main-side resume intents, then hand the
     *  manifest to the workspace feature (restore-port). The grid reveals itself —
     *  view-port's invariant — so Home needs no navigation of its own. */
    async function restore(): Promise<void> {
      if (restoring) return
      restoring = true
      const card = resumeHost.querySelector('.home-resume-card')
      card?.classList.add('is-busy')
      card?.setAttribute('disabled', '')
      try {
        const info = (await getBridge().invoke(WorkspaceChannels.restoreSession)) as LastSessionInfo | null
        if (!info || !info.workspaces.length) {
          // The snapshot vanished between render and click — show the honest empty.
          renderResume(null)
          return
        }
        const outcome = restoreSession(info)
        if (!outcome) throw new Error('The workspace feature is not ready to restore yet.')
        getTelemetry().captureEvent({
          name: 'home.session_restored',
          props: {
            workspaces: info.workspaces.length,
            panes: info.workspaces.reduce((s, w) => s + w.paneCount, 0)
          }
        })
      } catch (error) {
        const message =
          error instanceof Error && error.message.trim()
            ? error.message
            : 'The session could not be restored.'
        renderLoadError('The session couldn’t be restored', message)
      } finally {
        restoring = false
      }
    }

    // One guard held for the feature's lifetime: a fresh guard per call would have no
    // memory of the previous one, and the memory IS the generation guard.
    const resumeGuard = createAsyncGuard<LastSessionInfo | null>()

    async function refresh(): Promise<void> {
      // Settled before this resolves — HOMEUX awaits __mogging.home.refresh() then reads DOM.
      await resumeGuard.run(
        () => getBridge().invoke(WorkspaceChannels.lastSession) as Promise<LastSessionInfo | null>,
        {
          action: 'load your last session',
          onLoading: () => resumeHost.replaceChildren(loadingRow('Loading your last session…')),
          onSuccess: (info) => renderResume(info),
          onError: (message) => renderLoadError('Last session didn’t load', message),
          // A store that never answers must not leave a spinner on the launcher forever.
          timeoutMs: 15_000
        }
      )
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
      w.__mogging.firstrun = {
        refresh: () => firstrun.refresh(),
        // HOMEUX drives the missing-CLI branch: the install row can only be exercised on a
        // machine that is missing a CLI, and this one is missing none.
        forceMissing: (agentIds: string[]) => firstrun.forceMissing(agentIds)
      }
      w.__mogging.home = { refresh: () => refresh() } // last-session re-read (HOMEUX seeds a snapshot)
    }
  }
}
