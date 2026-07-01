import type { UiFeature } from '../../core/registry/feature-registry'
import type { AgentInfo } from '@contracts'
import { getFocusedPane } from '../../core/layout/focus'
import { setPaneLabel } from '../../core/layout/pane-meta'
import { agentsClient } from './agents.client'

/**
 * The agent launcher: a picker of installed CLIs (Claude Code, Codex, Gemini, Aider, OpenCode).
 * Launching one writes its command into the focused pane at the workspace cwd; the CLI
 * self-authenticates (BYO — ADR 0002). Decoupled: it targets the focused pane via the focus
 * port and labels it via the pane-meta port — it never imports `workspace` or `terminal`.
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

    void populate()

    async function populate(): Promise<void> {
      let agents: AgentInfo[] = []
      try {
        agents = await agentsClient.detect()
      } catch {
        agents = []
      }
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
          void launch(agent.id, agent.name)
        })
        menu.append(item)
      }
    }

    /** Launch an agent CLI into the focused pane at its workspace cwd (command only, ADR 0002). */
    async function launch(agentId: string, name: string): Promise<void> {
      const focus = getFocusedPane()
      if (!focus) return
      const command = await agentsClient.command({ agentId, cwd: focus.cwd })
      if (!command) return
      agentsClient.launchInto(focus.paneId as number, command)
      setPaneLabel(focus.paneId, name)
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
        launch: (agentId: string, name?: string) => launch(agentId, name ?? agentId),
        open: () => {
          menu.hidden = false
        }
      }
    }
  }
}
