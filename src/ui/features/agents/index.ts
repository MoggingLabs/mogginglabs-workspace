import type { UiFeature } from '../../core/registry/feature-registry'
import type { AgentInfo, PaneId } from '@contracts'
import { getFocusedPane } from '../../core/layout/focus'
import { setPaneLabel } from '../../core/layout/pane-meta'
import { onAgentLaunchRequest } from '../../core/agents/launch-port'
import { setCommands } from '../../core/commands/command-port'
import { getTelemetry } from '../../core/telemetry'
import { agentsClient } from './agents.client'

/**
 * Agent launching (headless — no titlebar button by design: launching lives in the
 * wizard, the pane ⋯ menu, and the command palette). Detects installed CLIs (Claude
 * Code, Codex, Gemini, Aider, OpenCode), publishes one launch command per installed
 * CLI on the command port, and services the ui-core agent-launch port (06b template
 * opens + restore). Launching writes the CLI's own command into a pane; the CLI
 * self-authenticates (BYO — ADR 0002).
 */
export const agentsFeature: UiFeature = {
  name: 'agents',
  mount() {
    const nameById = new Map<string, string>()
    let installedIds: string[] = []

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
      const installed = agents.filter((a) => a.installed)
      installedIds = installed.map((a) => a.id)
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
        items: () => installedIds.slice(),
        launch: (agentId: string) => launchInFocused(agentId)
      }
    }
  }
}
