import type { UiFeature } from '../../core/registry/feature-registry'
import type { AgentInfo, PaneId } from '@contracts'
import { getFocusedPane } from '../../core/layout/focus'
import { setPaneLabel } from '../../core/layout/pane-meta'
import { onAgentLaunchRequest } from '../../core/agents/launch-port'
import { setCommands } from '../../core/commands/command-port'
import { getTelemetry } from '../../core/telemetry'
import { agentsClient } from './agents.client'

/**
 * The agent launcher: a picker of installed CLIs (Claude Code, Codex, Gemini, Aider, OpenCode).
 * Launching one writes its command into a pane at the workspace cwd; the CLI self-authenticates
 * (BYO — ADR 0002). Two entry points, one launch path: the titlebar picker (focused pane) and
 * the ui-core agent-launch port (used by 06b template open + restore). Decoupled — targets panes
 * via the focus/pane-meta/launch ports, never importing `workspace` or `templates`.
 */
export const agentsFeature: UiFeature = {
  name: 'agents',
  mount(ctx) {
    const wrap = document.createElement('div')
    wrap.className = 'agent-launcher'
    const btn = document.createElement('button')
    btn.className = 'agent-launch-btn'
    btn.type = 'button'
    btn.textContent = 'Launch agent'
    const menu = document.createElement('div')
    menu.className = 'agent-menu'
    menu.hidden = true
    wrap.append(btn, menu)
    ctx.titlebarRight.prepend(wrap)

    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      menu.hidden = !menu.hidden
    })
    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target as Node)) menu.hidden = true
    })

    const nameById = new Map<string, string>()

    void populate()
    // Template opens (06b) + restore drive launches through this port.
    onAgentLaunchRequest((req) => void launchInPane(req.paneId as number, req.provider, req.cwd, req.resume))

    async function populate(): Promise<void> {
      let agents: AgentInfo[] = []
      try {
        agents = await agentsClient.detect()
      } catch {
        agents = []
      }
      for (const a of agents) nameById.set(a.id, a.name)
      menu.innerHTML = ''
      const installed = agents.filter((a) => a.installed)
      if (!installed.length) {
        const empty = document.createElement('div')
        empty.className = 'agent-menu-empty'
        empty.textContent = 'No agent CLIs found on PATH'
        menu.append(empty)
        return
      }
      for (const agent of installed) {
        const item = document.createElement('button')
        item.className = 'agent-menu-item'
        item.type = 'button'
        item.textContent = agent.name
        item.dataset.agentId = agent.id
        item.addEventListener('click', () => {
          menu.hidden = true
          launchInFocused(agent.id)
        })
        menu.append(item)
      }
      // Palette + pane-menu entries: one launch command per installed CLI.
      setCommands(
        'agents',
        installed.map((a) => ({
          id: `agent:launch:${a.id}`,
          title: `Launch ${a.name} in focused pane`,
          hint: 'Agent',
          run: () => launchInFocused(a.id)
        }))
      )
    }

    function launchInFocused(agentId: string): void {
      const focus = getFocusedPane()
      if (focus) void launchInPane(focus.paneId as number, agentId, focus.cwd)
    }

    /** The one launch path: build the command (never a credential — ADR 0002), write it into
     *  the pane, label the pane. `shell` is a no-op (the pane is already a shell). A
     *  `custom:<command>` provider (wizard custom row) writes the user's own command verbatim. */
    async function launchInPane(paneId: number, provider: string, cwd: string, resume = false): Promise<void> {
      if (paneId < 0 || !provider || provider === 'shell') return
      if (provider.startsWith('custom:')) {
        const cmd = provider.slice('custom:'.length).trim()
        if (!cmd) return
        agentsClient.launchInto(paneId, cmd)
        setPaneLabel(paneId as PaneId, cmd.split(/\s+/)[0] || 'custom')
        // Provider id only — NEVER the command text (ADR 0005/0002).
        getTelemetry().captureEvent({ name: 'agent.launched', props: { provider: 'custom', resume } })
        return
      }
      const command = await agentsClient.command({ agentId: provider, cwd, resume })
      if (!command) return
      agentsClient.launchInto(paneId, command)
      setPaneLabel(paneId as PaneId, nameById.get(provider) ?? provider)
      getTelemetry().captureEvent({ name: 'agent.launched', props: { provider, resume } })
    }

    exposeForDev()
    function exposeForDev(): void {
      if (!import.meta.env.DEV) return
      const w = window as unknown as { __mogging?: Record<string, unknown> }
      w.__mogging = w.__mogging ?? {}
      w.__mogging.agents = {
        detect: () => agentsClient.detect(),
        items: () =>
          Array.from(menu.querySelectorAll('.agent-menu-item')).map((el) => (el as HTMLElement).dataset.agentId),
        launch: (agentId: string) => launchInFocused(agentId),
        open: () => {
          menu.hidden = false
        }
      }
    }
  }
}
