import {
  AgentChannels,
  AgentConfigChannels,
  type AgentConfigProviderSummary,
  type AgentInfo,
  type AgentInstallStart,
  type AgentInstallState
} from '@contracts'
import { Button, Card, EmptyState, Pill, SectionHeader, Spinner, el, loadingRow, providerLogo, showToast } from '../../components'
import { createAsyncGuard } from '../../core/async/async-state'
import { getBridge } from '../../core/ipc/bridge'
import { getTelemetry } from '../../core/telemetry'
import { onAgentRegistryChange, refreshAgentRegistry } from '../../core/agents/registry'
import { createAgentConfigWorkspace } from './agent-config'

/** CLI availability plus the entry point to the provider configuration control plane. */
export function createProvidersSection(): HTMLElement & { refresh: () => Promise<void> } {
  const invoke = (channel: string, payload?: unknown): Promise<unknown> => getBridge().invoke(channel, payload)
  let agents: AgentInfo[] = []
  let summaries: AgentConfigProviderSummary[] = []
  const installs = new Map<string, AgentInstallState>()
  const logs = new Map<string, HTMLElement>()
  const list = el('div', { class: 'prov-list' })
  const landing = el('div', { class: 'prov-landing' }, [
    Card(
      {
        header: SectionHeader({
          title: 'CLI control plane',
          caption:
            'Open a CLI to inspect every cataloged setting, choose its real provider scope, and keep desired values synchronized. Install still runs the exact provider command shown under your login.'
        })
      },
      [list]
    )
  ])
  const config = createAgentConfigWorkspace(() => {
    config.el.hidden = true
    landing.hidden = false
  })
  const root = el('div', { class: 'prov-section' }, [landing, config.el])

  function openConfig(agent: AgentInfo): void {
    landing.hidden = true
    config.el.hidden = false
    void config.open(agent.id, agent)
  }

  function statusPill(agent: AgentInfo, install: AgentInstallState | undefined): HTMLElement {
    if (agent.installed) return Pill({ text: 'Available', tone: 'success', icon: 'check-circle' })
    if (install?.phase === 'running') {
      return el('span', { class: 'prov-installing' }, [Spinner(), Pill({ text: 'Installing…', tone: 'accent' })])
    }
    if (install?.phase === 'failed') {
      return Pill({
        text: 'Install failed',
        tone: 'danger',
        icon: 'alert',
        title: install.exitCode != null ? `shell exited ${install.exitCode}` : undefined
      })
    }
    return Pill({ text: 'Not installed', tone: 'neutral' })
  }

  function startInstall(agent: AgentInfo): void {
    getTelemetry().captureEvent({ name: 'provider.install.clicked', props: { provider: agent.id } })
    void (invoke(AgentChannels.install, agent.id) as Promise<AgentInstallStart>).then((result) => {
      if (result?.ok) return
      showToast({ title: 'Install didn’t start', body: result?.reason, tone: 'danger' })
      void refresh()
    })
  }

  function row(agent: AgentInfo): HTMLElement {
    const install = installs.get(agent.id)
    const running = install?.phase === 'running'
    const summary = summaries.find((candidate) => candidate.provider === agent.id)
    const actions: HTMLElement[] = []
    if (!agent.installed && agent.installHint && !running) {
      actions.push(Button({
        label: install?.phase === 'failed' ? 'Retry install' : 'Install',
        icon: 'terminal',
        size: 'sm',
        onClick: (event) => {
          event.stopPropagation()
          startInstall(agent)
        }
      }))
    }
    actions.push(Button({
      label: 'Settings',
      iconRight: 'chevron-right',
      variant: 'ghost',
      size: 'sm',
      onClick: (event) => {
        event.stopPropagation()
        openConfig(agent)
      }
    }))

    const showLog = !agent.installed && (running || install?.phase === 'failed') && !!install?.tail
    let log: HTMLElement | null = null
    if (showLog) {
      log = el('pre', { class: 'prov-log', text: install!.tail })
      logs.set(agent.id, log)
      queueMicrotask(() => { log!.scrollTop = log!.scrollHeight })
    }
    return el('div', { class: 'prov-item', dataset: { provider: agent.id } }, [
      el('div', {
        class: 'prov-row',
        role: 'button',
        tabIndex: 0,
        ariaLabel: `Open ${agent.name} settings`,
        onClick: () => openConfig(agent),
        onKeydown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            openConfig(agent)
          }
        }
      }, [
        el('span', { class: `prov-avatar${agent.installed ? ' is-installed' : ''}`, attrs: { 'aria-hidden': 'true' } }, [providerLogo(agent.id, 20)]),
        el('div', { class: 'prov-row-main' }, [
          el('div', { class: 'prov-row-head' }, [
            el('span', { class: 'prov-name', text: agent.name }),
            statusPill(agent, install),
            summary?.enforcedCount
              ? Pill({
                  text: `${summary.enforcedCount} synced`,
                  tone: ['error', 'blocked', 'drifted'].includes(summary.sync) ? 'danger' : 'accent'
                })
              : null
          ]),
          !agent.installed && agent.installHint
            ? el('code', { class: 'prov-cmd', text: agent.installHint })
            : el('span', { class: 'prov-sub', text: summary?.version ? `Detected on PATH · v${summary.version}` : 'Detected on PATH' })
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
  const detectGuard = createAsyncGuard<
    [readonly AgentInfo[], AgentInstallState[], AgentConfigProviderSummary[]]
  >()

  async function refresh(): Promise<void> {
    await detectGuard.run(
      () =>
        Promise.all([
          refreshAgentRegistry(),
          invoke(AgentChannels.installStates) as Promise<AgentInstallState[]>,
          invoke(AgentConfigChannels.providers) as Promise<AgentConfigProviderSummary[]>
        ]),
      {
        action: 'detect your agent CLIs',
        // Spinner only when no rows are up: an install verdict re-refreshes, and a live tab must
        // not blink back to a loading row every time one lands.
        onLoading: () => {
          if (!list.querySelector('.prov-item')) list.replaceChildren(loadingRow('Detecting agent CLIs…'))
        },
        onSuccess: ([detected, states, configSummaries]) => {
          agents = [...detected]
          summaries = configSummaries ?? []
          installs.clear()
          for (const s of states ?? []) installs.set(s.agentId, s)
          render()
          if (!config.el.hidden && config.activeProvider()) void config.refresh()
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
    const previous = installs.get(state.agentId)
    installs.set(state.agentId, state)
    if (state.phase === 'succeeded') {
      const name = agents.find((candidate) => candidate.id === state.agentId)?.name ?? state.agentId
      showToast({ title: `${name} installed`, tone: 'success' })
      void refresh() // refreshes install-state detail; the shared roster flips every launch surface
      return
    }
    if (state.phase !== previous?.phase) {
      render()
      return
    }
    const log = logs.get(state.agentId)
    if (log) {
      log.textContent = state.tail
      log.scrollTop = log.scrollHeight
    } else if (state.tail) {
      render()
    }
  })

  void refresh()
  return Object.assign(root, { refresh })
}
