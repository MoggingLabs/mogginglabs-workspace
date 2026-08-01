import { AgentChannels, type AgentSetupState, type AgentSetupStart, type AgentSetupStep } from '@contracts'
import { Button, Spinner, el, icon, clear } from '../../components'
import { getBridge } from '../../core/ipc/bridge'
import { refreshAgentRegistry } from '../../core/agents/registry'
import { getTelemetry } from '../../core/telemetry'

/**
 * THE ONE-CLICK SETUP CONTROL — the same component wherever a missing CLI is offered
 * (Home's checklist, the wizard's agent cards, Settings › Agent CLIs).
 *
 * It is deliberately TWO elements, not one:
 *
 *   `action`    the primary control, sized like a button because it is one. Each surface
 *               places it where that surface's controls already live — the right edge of a
 *               checklist row, an agent card's tail, a settings row's action cluster — so
 *               the offer sits IN the row instead of dangling under it.
 *   `el`        the progress block: the named steps, their verdicts, the remedy on a
 *               failure, and the transcript behind a Details toggle. Hidden until a run
 *               starts, then rendered full-width under the row it belongs to, visually
 *               fused to it (each surface's CSS aligns its left edge with the row's text).
 *
 * One element forced every surface to choose between a button floating mid-list and a
 * progress report crammed into an action cell; the split is what lets all three surfaces
 * read as one designed thing.
 *
 * NO INSTALL COMMANDS. The provider's one-liner used to survive here as a demoted
 * copy-chip; it is gone by explicit direction — the command is the technical detail this
 * feature exists to absorb. The transcript under Details still shows what actually ran,
 * because diagnostics are not the same thing as instructions.
 *
 * ADR 0002 unchanged: setup installs, never signs in, never touches a credential.
 */

export interface AgentSetupPanelOptions {
  agentId: string
  name: string
  /** Dense placement (the wizard's agent card) trims paddings and the log height. */
  compact?: boolean
  /**
   * Icon-only action (the wizard's palette chips): the download glyph + the grayed-out
   * chip it sits on already say "not installed — get it", so the word "Install" is
   * redundant there (explicit direction, 2026-08-01). The name still rides aria-label
   * and the tooltip — icon-only is a visual economy, never an accessibility one.
   */
  iconOnly?: boolean
  /** Fired when setup SUCCEEDS, so a host surface can re-render around a now-present CLI. */
  onInstalled?: () => void
  /** Fired on every phase edge — a host that mirrors state elsewhere (a status pill)
   *  listens here instead of re-subscribing to the channel. */
  onPhase?: (phase: 'idle' | 'running' | 'succeeded' | 'failed') => void
}

export interface AgentSetupPanelHandle {
  /** The progress block — steps, remedies, details. Hidden while nothing is running. */
  el: HTMLElement
  /** The primary control — Install / Retry / a running indicator. Place it inline. */
  action: HTMLElement
  dispose(): void
}

const STEP_ICON: Record<AgentSetupStep['phase'], 'clock' | 'check-circle' | 'alert'> = {
  pending: 'clock',
  running: 'clock',
  done: 'check-circle',
  skipped: 'check-circle',
  failed: 'alert'
}

export function createAgentSetupPanel(opts: AgentSetupPanelOptions): AgentSetupPanelHandle {
  const root = el('div', { class: `agent-setup${opts.compact ? ' agent-setup--compact' : ''}`, hidden: true })
  const action = el('span', { class: 'agent-setup-action' })
  let state: AgentSetupState | null = null
  let notice = '' // a start refusal ("already installing") — shown beside the action
  let detailsOpen = false
  let disposed = false

  const phaseOf = (): 'idle' | 'running' | 'succeeded' | 'failed' => state?.phase ?? 'idle'

  const start = (): void => {
    getTelemetry().captureEvent({ name: 'provider.setup.clicked', props: { provider: opts.agentId } })
    notice = ''
    // Paint "working" on the click, not on the first push: the probe step can take a
    // moment, and a button that looks inert while it thinks gets clicked again.
    state = {
      agentId: opts.agentId as AgentSetupState['agentId'],
      phase: 'running',
      steps: [],
      tail: '',
      startedAt: Date.now()
    }
    render()
    void (getBridge().invoke(AgentChannels.setup, opts.agentId) as Promise<AgentSetupStart>)
      .then((result) => {
        if (disposed || result?.ok) return
        // A refusal is a verdict too — most often "it's already installed", which means
        // the roster is what is stale, not the machine.
        state = null
        notice = result?.reason ?? ''
        render()
        void refreshAgentRegistry()
      })
      .catch(() => {
        if (disposed) return
        state = null
        notice = 'Setup could not be started.'
        render()
      })
  }

  function stepRow(step: AgentSetupStep): HTMLElement {
    const running = step.phase === 'running'
    return el('div', { class: `agent-setup-step is-${step.phase}` }, [
      el('span', { class: 'agent-setup-step-mark' }, [running ? Spinner() : icon(STEP_ICON[step.phase], 13)]),
      el('span', { class: 'agent-setup-step-body' }, [
        el('span', { class: 'agent-setup-step-label', text: step.label }),
        step.note ? el('span', { class: 'agent-setup-step-note', text: step.note }) : null,
        // The remedy is the whole point of reporting a failure this way — it is what the
        // user does next, and it appears exactly where the failure is.
        step.remedy ? el('span', { class: 'agent-setup-step-remedy', text: step.remedy }) : null
      ])
    ])
  }

  function detailsBlock(): HTMLElement | null {
    if (!state?.tail) return null
    const toggle = el('button', {
      class: 'agent-setup-details-toggle',
      type: 'button',
      text: detailsOpen ? 'Hide details' : 'Show details',
      onClick: () => {
        detailsOpen = !detailsOpen
        render()
      }
    })
    if (!detailsOpen) return toggle
    const log = el('pre', { class: 'agent-setup-log', text: state.tail })
    queueMicrotask(() => (log.scrollTop = log.scrollHeight))
    return el('div', { class: 'agent-setup-details' }, [toggle, log])
  }

  /** The icon-only grades of the same lifecycle — glyphs where the labeled button would
   *  shout. Every state keeps its words in aria/title. */
  function renderIconAction(): void {
    switch (phaseOf()) {
      case 'idle': {
        action.append(
          el(
            'button',
            {
              class: 'agent-setup-iconbtn',
              type: 'button',
              ariaLabel: `Install ${opts.name}`,
              title: notice || `Install ${opts.name} — one click, dependencies included`,
              onClick: start
            },
            [icon('download', 13)]
          )
        )
        return
      }
      case 'running': {
        const running = el('span', { class: 'agent-setup-iconbtn is-running', title: `Installing ${opts.name}…` }, [Spinner()])
        running.setAttribute('role', 'status')
        running.setAttribute('aria-label', `Installing ${opts.name}`)
        action.append(running)
        return
      }
      case 'failed':
        action.append(
          el(
            'button',
            {
              class: 'agent-setup-iconbtn is-failed',
              type: 'button',
              ariaLabel: `Retry installing ${opts.name}`,
              title: `${opts.name} couldn’t be installed — retry`,
              onClick: start
            },
            [icon('rotate-cw', 13)]
          )
        )
        return
      case 'succeeded':
        action.append(el('span', { class: 'agent-setup-iconbtn is-ready', title: `${opts.name} is ready` }, [icon('check-circle', 13)]))
    }
  }

  function renderAction(): void {
    clear(action)
    if (opts.iconOnly) return renderIconAction()
    switch (phaseOf()) {
      case 'idle':
        action.append(
          Button({
            label: 'Install',
            icon: 'download',
            variant: 'primary',
            size: 'sm',
            ariaLabel: `Install ${opts.name}`,
            title: `Install ${opts.name} and everything it needs — no terminal required`,
            onClick: start
          })
        )
        if (notice) action.append(el('span', { class: 'agent-setup-notice', text: notice }))
        return
      case 'running':
        // The button leaves while a run owns the verdict — an "Install" that is also
        // "installing" invites the double-click this service refuses anyway.
        action.append(el('span', { class: 'agent-setup-running' }, [Spinner(), el('span', { text: 'Installing…' })]))
        return
      case 'failed':
        action.append(Button({ label: 'Retry', icon: 'rotate-cw', size: 'sm', ariaLabel: `Retry installing ${opts.name}`, onClick: start }))
        return
      case 'succeeded':
        action.append(el('span', { class: 'agent-setup-ready' }, [icon('check-circle', 13), el('span', { text: 'Ready' })]))
    }
  }

  function renderProgress(): void {
    clear(root)
    if (!state) {
      root.hidden = true
      return
    }
    root.hidden = false

    if (state.phase === 'succeeded') {
      root.append(
        el('div', { class: 'agent-setup-verdict' }, [
          icon('check-circle', 14),
          el('span', { text: `${opts.name} is ready — sign in from its terminal when it opens.` })
        ])
      )
      return
    }

    const failedStep = state.steps.find((step) => step.phase === 'failed')
    const put = (child: Node | null): void => {
      if (child) root.append(child)
    }
    put(
      state.phase === 'failed'
        ? el('div', { class: 'agent-setup-head' }, [
            el('span', {
              class: 'agent-setup-head-text',
              text: `Couldn’t set up ${opts.name}${failedStep ? ` — ${failedStep.label.toLowerCase()} failed.` : '.'}`
            })
          ])
        : null
    )
    put(el('div', { class: 'agent-setup-steps' }, state.steps.map(stepRow)))
    put(detailsBlock())
  }

  function render(): void {
    if (disposed) return
    renderAction()
    renderProgress()
    opts.onPhase?.(phaseOf())
  }

  const off = getBridge().on(AgentChannels.setupChanged, (payload) => {
    const next = payload as AgentSetupState
    if (disposed || next?.agentId !== opts.agentId) return
    state = next
    render()
    if (next.phase === 'succeeded') {
      // The roster is the app's ONE definition of "installed"; refreshing it is what flips
      // every other surface (the wizard's stepper, Home's checklist) at the same instant.
      void refreshAgentRegistry()
      opts.onInstalled?.()
    }
  })

  // A run started before this panel mounted (Settings tab switched, wizard reopened) is
  // still the truth about this provider — pick it up rather than offering to start a
  // second one.
  void (getBridge().invoke(AgentChannels.setupStates) as Promise<AgentSetupState[]>)
    .then((states) => {
      if (disposed) return
      const mine = (states ?? []).find((candidate) => candidate.agentId === opts.agentId)
      if (mine && mine.phase !== 'succeeded') {
        state = mine
        render()
      }
    })
    .catch(() => undefined)

  render()
  return {
    el: root,
    action,
    dispose: () => {
      disposed = true
      off?.()
    }
  }
}
