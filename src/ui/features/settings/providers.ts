import {
  AgentChannels,
  type AgentInfo,
  type AgentInstallStart,
  type AgentInstallState
} from '@contracts'
import { Button, Card, EmptyState, Pill, SectionHeader, Spinner, el, loadingRow, providerLogo, showToast } from '../../components'
import { createAsyncGuard } from '../../core/async/async-state'
import { getBridge } from '../../core/ipc/bridge'
import { getTelemetry } from '../../core/telemetry'
import { onAgentRegistryChange, refreshAgentRegistry } from '../../core/agents/registry'

/**
 * Settings § Providers (the availability map): one row per agent CLI the app
 * knows how to launch — Available when its bin resolves on PATH, otherwise the
 * provider's own install one-liner plus an Install button. Install runs that
 * exact line in an EPHEMERAL background pty main-side (agents:install); this UI
 * only watches: `installChanged` pushes progress, and the verdict is a re-detect,
 * so this tab and the wizard can never disagree about "installed".
 */
export function createProvidersSection(): HTMLElement & { refresh: () => Promise<void> } {
  const invoke = (channel: string, payload?: unknown): Promise<unknown> => getBridge().invoke(channel, payload)

  let agents: AgentInfo[] = []
  const installs = new Map<string, AgentInstallState>()
  /** Live log <pre> per provider, so tail pushes patch in place (no re-render churn). */
  const logs = new Map<string, HTMLElement>()

  const list = el('div', { class: 'prov-list' })
  const root = el('div', { class: 'prov-section' }, [
    Card(
      {
        header: SectionHeader({
          // The tab hero says 'Agent CLIs' now — this head says what the card DOES.
          title: 'Detection & install',
          caption:
            'Each CLI is detected on PATH. Install runs the provider’s own documented one-liner in a background terminal — the exact command shown, under your login, nothing else.'
        })
      },
      [list]
    )
  ])

  function statusPill(a: AgentInfo, ins: AgentInstallState | undefined): HTMLElement {
    if (a.installed) return Pill({ text: 'Available', tone: 'success', icon: 'check-circle' })
    if (ins?.phase === 'running')
      return el('span', { class: 'prov-installing' }, [Spinner(), Pill({ text: 'Installing…', tone: 'accent' })])
    if (ins?.phase === 'failed')
      return Pill({ text: 'Install failed', tone: 'danger', icon: 'alert', title: ins.exitCode != null ? `shell exited ${ins.exitCode}` : undefined })
    return Pill({ text: 'Not installed', tone: 'neutral' })
  }

  function startInstall(a: AgentInfo): void {
    getTelemetry().captureEvent({ name: 'provider.install.clicked', props: { provider: a.id } })
    void (invoke(AgentChannels.install, a.id) as Promise<AgentInstallStart>).then((res) => {
      if (res?.ok) return // the running state arrives via installChanged
      showToast({ title: 'Install didn’t start', body: res?.reason, tone: 'danger' })
      void refresh() // e.g. "already installed" — re-detect so the row tells the truth
    })
  }

  function row(a: AgentInfo): HTMLElement {
    const ins = installs.get(a.id)
    const running = ins?.phase === 'running'
    const actions: (HTMLElement | null)[] = []
    if (!a.installed && a.installHint && !running) {
      actions.push(
        Button({
          label: ins?.phase === 'failed' ? 'Retry install' : 'Install',
          icon: 'terminal',
          size: 'sm',
          onClick: () => startInstall(a)
        })
      )
    }

    const showLog = !a.installed && (running || ins?.phase === 'failed') && !!ins?.tail
    let log: HTMLElement | null = null
    if (showLog) {
      log = el('pre', { class: 'prov-log', text: ins!.tail })
      logs.set(a.id, log)
      queueMicrotask(() => (log!.scrollTop = log!.scrollHeight))
    }

    // Identity column: the provider's mark (full color once the CLI is available,
    // dimmed while missing), the name beside its status, and a subline — the
    // provider's own install one-liner when it is missing, or where the detection
    // came from when it is not.
    return el('div', { class: 'prov-item', dataset: { provider: a.id } }, [
      el('div', { class: 'prov-row' }, [
        el('span', { class: 'prov-avatar' + (a.installed ? ' is-installed' : ''), attrs: { 'aria-hidden': 'true' } }, [
          providerLogo(a.id, 20)
        ]),
        el('div', { class: 'prov-row-main' }, [
          el('div', { class: 'prov-row-head' }, [el('span', { class: 'prov-name', text: a.name }), statusPill(a, ins)]),
          !a.installed && a.installHint
            ? el('code', { class: 'prov-cmd', text: a.installHint })
            : el('span', { class: 'prov-sub', text: 'Detected on PATH' })
        ]),
        el('div', { class: 'prov-actions' }, actions)
      ]),
      log
    ])
  }

  function render(): void {
    logs.clear()
    list.replaceChildren(...agents.map(row))
  }

  // Finding 39: the same defect as Profiles — an un-caught Promise.all feeding a list that starts
  // as an empty <div>, so a rejection skipped render() and the tab was BLANK. One guard for the
  // one read; the generation guard also settles the race between mount and an install verdict,
  // which both call refresh().
  const detectGuard = createAsyncGuard<[readonly AgentInfo[], AgentInstallState[]]>()

  async function refresh(): Promise<void> {
    await detectGuard.run(
      () => Promise.all([refreshAgentRegistry(), invoke(AgentChannels.installStates) as Promise<AgentInstallState[]>]),
      {
        action: 'detect your agent CLIs',
        // Spinner only when no rows are up: an install verdict re-refreshes, and a live tab must
        // not blink back to a loading row every time one lands.
        onLoading: () => {
          if (!list.querySelector('.prov-item')) list.replaceChildren(loadingRow('Detecting agent CLIs…'))
        },
        onSuccess: ([detected, states]) => {
          agents = [...detected]
          installs.clear()
          for (const s of states ?? []) installs.set(s.agentId, s)
          render()
        },
        // An error state IS an EmptyState with an alert icon and a retry — never a blank card,
        // which reads as "no CLIs exist" when the truth is that we never found out.
        onError: (message) =>
          list.replaceChildren(
            EmptyState({
              icon: 'alert',
              title: 'Agent CLIs didn’t load',
              body: message,
              action: Button({ label: 'Retry', icon: 'rotate-cw', size: 'sm', onClick: () => void refresh() })
            })
          ),
        timeoutMs: 15_000
      }
    )
  }

  // One subscription for the section's lifetime (the settings DOM is built once).
  onAgentRegistryChange((next) => {
    agents = [...next]
    render()
  })
  getBridge().on(AgentChannels.installChanged, (payload) => {
    const state = payload as AgentInstallState
    const prev = installs.get(state.agentId)
    installs.set(state.agentId, state)
    if (state.phase === 'succeeded') {
      const name = agents.find((a) => a.id === state.agentId)?.name ?? state.agentId
      showToast({ title: `${name} installed`, tone: 'success' })
      void refresh() // refreshes install-state detail; the shared roster flips every launch surface
      return
    }
    if (state.phase !== prev?.phase) {
      render() // running↔failed transitions change pills/buttons/log visibility
      return
    }
    const log = logs.get(state.agentId)
    if (log) {
      // Tail-only tick: patch the live log in place.
      log.textContent = state.tail
      log.scrollTop = log.scrollHeight
    } else if (state.tail) {
      render() // first output for a row rendered before any tail existed
    }
  })

  void refresh()
  return Object.assign(root, { refresh })
}
