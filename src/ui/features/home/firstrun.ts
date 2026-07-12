import { AgentChannels, ClipboardChannels, IntegrationsChannels, type AgentInfo } from '@contracts'
import { getBridge } from '../../core/ipc/bridge'
import { el, icon, providerLogo, showToast } from '../../components'
import { getWorkspaces } from '../../core/workspace/workspace-info-port'
import { openWizard } from '../../core/workspace/wizard-port'
import { setActiveView } from '../../core/shell/view-port'
import { requestSettingsTab } from '../../core/shell/settings-tab-port'
import { requestIntegrationsFocus } from '../../core/shell/integrations-focus-port'
import { getTelemetry } from '../../core/telemetry'

/**
 * First-run checklist (Phase-6/06): a dismissible "Get set up" card on Home,
 * with LIVE state — not a static tour. Every row reflects real detection / real
 * stores, re-read each time Home is shown. NEVER installs anything, runs no
 * elevated command, phones nothing home: it reads local detection + local
 * stores and offers copy buttons only (the user installs — ADR 0002).
 *
 * Persistence: `mogging.firstrun.dismissed` in localStorage. Once dismissed (by
 * the × or by completing all three), the card never returns.
 */
const KEY = 'mogging.firstrun.dismissed'

function isDismissed(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}
function setDismissed(): void {
  try {
    localStorage.setItem(KEY, '1')
  } catch {
    /* storage unavailable — card just reappears next launch, harmless */
  }
}

interface RowState {
  done: boolean
  /** Optional rows never block the "all done -> collapse" (they're suggestions). */
  optional?: boolean
  render: (row: HTMLElement) => void
}

export function createFirstRun(): {
  el: HTMLElement
  refresh: () => Promise<void>
  forceMissing: (agentIds: string[]) => void
} {
  const bridge = getBridge()
  const card = el('section', { class: 'firstrun-card', hidden: true })
  card.setAttribute('aria-label', 'Get set up')

  /** DEV-only fixture (HOMEUX). The install row below exists only for a MISSING CLI, so on a
   *  machine that has them all it correctly renders nothing — and the branch that matters most
   *  to a new user is the one nobody here can test. This forces named agents to READ as missing.
   *  It fakes the DETECTION INPUT and nothing else: the row, its command, its copy chip and its
   *  contrast are all produced by the real path. Empty in production (and tree-shaken). */
  let forcedMissing = new Set<string>()

  const dismissBtn = el(
    'button',
    { class: 'firstrun-dismiss icon-btn', type: 'button', ariaLabel: 'Dismiss setup' },
    [icon('x', 12)]
  )
  dismissBtn.onclick = (): void => {
    setDismissed()
    card.hidden = true
    getTelemetry().captureEvent({ name: 'firstrun.dismissed' }) // boolean only
  }
  const header = el('div', { class: 'firstrun-header' }, [
    el('div', { class: 'firstrun-heading' }, [
      el('h2', { class: 'firstrun-title', text: 'Get set up' }),
      el('p', { class: 'firstrun-sub', text: 'Three steps to your first agent workspace.' })
    ]),
    dismissBtn
  ])
  const rowsEl = el('div', { class: 'firstrun-rows' })
  card.append(header, rowsEl)

  let completedToasted = false

  const copyBtn = (text: string): HTMLElement => {
    const b = el('button', { class: 'firstrun-copy', type: 'button' }, [icon('copy', 12), el('span', { text: 'Copy' })])
    b.title = text
    b.onclick = (): void => {
      void bridge.invoke(ClipboardChannels.write, { text })
      const label = b.querySelector('span')
      if (label) {
        label.textContent = 'Copied'
        setTimeout(() => (label.textContent = 'Copy'), 1400)
      }
    }
    return b
  }

  const rowEl = (opts: {
    done: boolean
    title: string
    detail?: HTMLElement | string | null
    action?: HTMLElement | null
  }): HTMLElement =>
    el('div', { class: 'firstrun-row' + (opts.done ? ' is-done' : '') }, [
      el('span', { class: 'firstrun-state' }, [icon(opts.done ? 'check-circle' : 'clock', 16)]),
      el('div', { class: 'firstrun-row-body' }, [
        el('span', { class: 'firstrun-row-title', text: opts.title }),
        typeof opts.detail === 'string'
          ? el('span', { class: 'firstrun-row-detail', text: opts.detail })
          : opts.detail ?? null
      ]),
      opts.action ?? null
    ])

  async function computeRows(): Promise<RowState[]> {
    const [detected, servers] = await Promise.all([
      bridge.invoke(AgentChannels.detect).catch(() => []) as Promise<AgentInfo[]>,
      bridge.invoke(IntegrationsChannels.serversList).catch(() => []) as Promise<{ builtIn?: boolean }[]>
    ])
    const agents = forcedMissing.size
      ? detected.map((a) => (forcedMissing.has(a.id) ? { ...a, installed: false } : a))
      : detected

    // ① Agent CLIs — live detection; found ones listed, missing ones get a copyable install line.
    const found = agents.filter((a) => a.installed)
    const missing = agents.filter((a) => !a.installed)
    const cliDone = found.length > 0
    const cliDetail = el('div', { class: 'firstrun-clis' })
    if (found.length) {
      cliDetail.append(
        el('span', { class: 'firstrun-row-detail firstrun-found' }, [
          el('span', { text: 'Found:' }),
          ...found.flatMap((a) => [providerLogo(a.id, 13), el('span', { text: a.name })])
        ])
      )
    }
    for (const m of missing) {
      if (!m.installHint) continue
      cliDetail.append(
        el('div', { class: 'firstrun-cli-missing' }, [
          providerLogo(m.id, 13),
          el('span', { class: 'firstrun-cli-name', text: m.name }),
          el('code', { class: 'firstrun-cli-cmd', text: m.installHint }),
          copyBtn(m.installHint)
        ])
      )
    }

    // ② First workspace — done when one exists.
    const wsDone = getWorkspaces().workspaces.length > 0
    const wsAction = wsDone
      ? null
      : (() => {
          const b = el('button', { class: 'firstrun-action', type: 'button', text: 'New workspace' })
          b.onclick = (): void => void openWizard()
          return b
        })()

    const intDone = servers.some((s) => !s.builtIn)

    return [
      { done: cliDone, render: (r) => r.replaceWith(rowEl({ done: cliDone, title: 'Install an agent CLI', detail: cliDetail })) },
      { done: wsDone, render: (r) => r.replaceWith(rowEl({ done: wsDone, title: 'Open your first workspace', detail: wsDone ? 'Done — you have a workspace.' : 'Pick a folder and an agent lineup.', action: wsAction })) },
      {
        done: intDone,
        optional: true,
        render: (r) => {
          const setup = el('button', { class: 'firstrun-action', type: 'button', text: 'Set up…' })
          setup.onclick = (): void => {
            requestIntegrationsFocus('flow')
            requestSettingsTab('integrations')
            setActiveView('settings')
          }
          r.replaceWith(
            rowEl({
              done: intDone,
              title: 'Optional: connect your tools',
              detail: intDone ? 'Done — you have connected a tool.' : 'Wire n8n, Slack, Sentry, or GitHub to your agents — guided, no dotfiles.',
              action: intDone ? null : setup
            })
          )
        }
      }
    ]
  }

  async function refresh(): Promise<void> {
    if (isDismissed()) {
      card.hidden = true
      return
    }
    const rows = await computeRows()
    if (isDismissed()) {
      card.hidden = true
      return
    }
    // Required rows done -> collapse into a one-time "setup complete" toast, and
    // never return. Optional rows (integrations, power-ups) never block it.
    if (rows.every((r) => r.done || r.optional)) {
      setDismissed()
      card.hidden = true
      if (!completedToasted) {
        completedToasted = true
        getTelemetry().captureEvent({ name: 'firstrun.completed' }) // boolean only
        showToast({ tone: 'success', title: 'Setup complete', body: 'Your workspace is ready — happy shipping.', icon: 'check-circle' })
      }
      return
    }
    // Render (rebuild rows in place).
    const fresh = el('div', { class: 'firstrun-rows' })
    for (const rs of rows) {
      const placeholder = el('div', {})
      fresh.append(placeholder)
      rs.render(placeholder)
    }
    rowsEl.replaceChildren(...Array.from(fresh.children))
    card.hidden = false
  }

  return {
    el: card,
    refresh,
    forceMissing: (agentIds: string[]): void => {
      if (!import.meta.env.DEV) return
      forcedMissing = new Set(agentIds)
    }
  }
}
