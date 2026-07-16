import {
  AgentChannels,
  AgentConfigChannels,
  AgentHookChannels,
  type AgentConfigProviderSummary,
  type AgentInfo,
  type AgentInstallStart,
  type AgentInstallState,
  type GlobalHooksMutationResult,
  type GlobalHooksProviderStatus,
  type GlobalHooksStatus
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

  // ── Global session alerts: the hand-typed-launch gap, all four CLIs ──────────────────
  // An app-launched agent rings its pane through session-scoped bell config (claude's
  // --settings overlay, codex -c flags, the gemini/opencode env-pointed files); an agent
  // TYPED at a pane's own prompt carries none of it, so its pane never rings (found live
  // 2026-07-16: a hand-typed claude worked a 15-minute turn wearing a resting dot). Wiring
  // the same config into each CLI's own global files closes that: the notify script (and
  // OpenCode's plugin around it) no-op outside a MoggingLabs pane. Explicit action + backup
  // + atomic write, same as every user-owned config we touch; a CONFLICT (the user's own
  // codex `notify`, a differing tui value) shows its reason instead of an Apply button.
  const hooksList = el('div', { class: 'prov-list' })
  let hooksStatus: GlobalHooksStatus | null = null
  const HOOKS_LABEL: Record<GlobalHooksProviderStatus['provider'], string> = {
    claude: 'Claude Code',
    codex: 'Codex',
    gemini: 'Gemini',
    opencode: 'OpenCode'
  }
  const HOOKS_PILL: Record<GlobalHooksProviderStatus['state'], { text: string; tone: 'success' | 'neutral' | 'warning' | 'danger' }> = {
    applied: { text: '✓ wired', tone: 'success' },
    partial: { text: 'stale', tone: 'warning' },
    'not-applied': { text: 'not wired', tone: 'neutral' },
    conflict: { text: 'their config', tone: 'warning' },
    unreadable: { text: 'unreadable', tone: 'danger' }
  }
  const hooksAct = (channel: string, provider: GlobalHooksProviderStatus['provider'], done: string): void => {
    void (invoke(channel, { provider }) as Promise<GlobalHooksMutationResult>).then(async (result) => {
      if (result?.ok) showToast({ title: done, body: result.backups?.length ? `Backup: ${result.backups.join(' · ')}` : undefined, tone: 'success' })
      else showToast({ title: 'Nothing was written', body: result?.reason, tone: 'danger' })
      await refreshHooks()
    })
  }
  const hooksRow = (row: GlobalHooksProviderStatus): HTMLElement => {
    const label = HOOKS_LABEL[row.provider]
    const actions = el('div', { class: 'prov-actions' })
    if (row.state === 'not-applied' || row.state === 'partial') {
      actions.append(Button({
        label: row.state === 'partial' ? 'Re-apply' : 'Wire alerts',
        icon: 'bell',
        size: 'sm',
        onClick: () => hooksAct(AgentHookChannels.apply, row.provider, `${label} alerts wired globally`)
      }))
    }
    if (row.state === 'applied' || row.state === 'partial') {
      actions.append(Button({
        label: 'Remove',
        variant: 'ghost',
        size: 'sm',
        onClick: () => hooksAct(AgentHookChannels.remove, row.provider, `${label} alert wiring removed`)
      }))
    }
    // F-07: a conflict's `reason` can embed the user's entire config value — an escaped
    // Windows path, unbroken — which used to print inline and drag a horizontal scrollbar
    // onto the whole page. The row now says WHAT in one sentence; the raw value sits
    // behind a disclosure in a wrapping <pre> (the install-log surface, same class).
    const blocked = row.state === 'conflict' || row.state === 'unreadable'
    const note = blocked
      ? row.state === 'conflict'
        ? 'This CLI’s own config already sets these values — yours, not the app’s, so nothing is overwritten.'
        : 'The config file could not be read — fix or remove it, then Wire alerts again.'
      : row.files.join(' · ')
    let detail: HTMLElement | null = null
    if (blocked) {
      detail = el('pre', { class: 'prov-log prov-conflict-detail', text: `${row.reason ?? 'not writable'}\n${row.files.join('\n')}` })
      detail.hidden = true
      const toggle: HTMLButtonElement = Button({
        label: 'Show details',
        variant: 'ghost',
        size: 'sm',
        onClick: () => {
          detail!.hidden = !detail!.hidden
          toggle.textContent = detail!.hidden ? 'Show details' : 'Hide details'
        }
      })
      actions.append(toggle)
    }
    return el('div', { class: 'prov-item', dataset: { hooksProvider: row.provider } }, [
      el('div', { class: 'prov-row prov-row--static' }, [
        el('div', { class: 'prov-row-main' }, [
          el('div', { class: 'prov-row-head' }, [
            el('span', { class: 'prov-name', text: `${label} · global alerts` }),
            Pill(HOOKS_PILL[row.state])
          ]),
          // F-15: file paths are for the expert's eye — faint, one line, full on hover.
          el('div', { class: `settings-row-caption${blocked ? '' : ' prov-paths'}`, text: note, title: blocked ? undefined : note })
        ]),
        actions
      ]),
      detail
    ])
  }
  const renderHooks = (): void => {
    if (!hooksStatus) {
      hooksList.replaceChildren(el('div', { class: 'settings-row-caption' }, [Spinner()]))
      return
    }
    hooksList.replaceChildren(...hooksStatus.map(hooksRow))
  }
  const refreshHooks = async (): Promise<void> => {
    try {
      hooksStatus = (await invoke(AgentHookChannels.status)) as GlobalHooksStatus
    } catch {
      hooksStatus = null
    }
    renderHooks()
  }
  const hooksCard = Card(
    {
      header: SectionHeader({
        title: 'Hand-typed session alerts',
        caption:
          'An agent launched from the app rings its pane through session-scoped config. Wire the same alerts into each CLI’s own global config so an agent you type at a pane’s own prompt rings too. Outside a pane the wiring is a silent no-op.'
      })
    },
    [hooksList]
  )

  const landing = el('div', { class: 'prov-landing' }, [
    Card(
      {
        header: SectionHeader({
          // F-09: was "CLI control plane" — k8s idiom on a consumer surface.
          title: 'Your agent CLIs',
          caption:
            'Open a CLI to browse every setting it supports and keep the values you choose in sync. Install runs the exact provider command shown, under your login.'
        })
      },
      [list]
    ),
    hooksCard
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
    void refreshHooks() // independent read; never gates the CLI roster
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
