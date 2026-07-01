import { ipcMain } from 'electron'
import { detectAgents, buildLaunchCommand } from '@backend/features/agents'
import { AgentChannels, type AgentCommandRequest } from '@contracts'

// App-wiring: expose the agent adapters (detect installed CLIs + build a launch command) to
// the renderer. The launch itself is just writing the returned command into a pane
// (terminal:write) — the CLI self-authenticates; NO credentials are handled here (ADR 0002).
export function registerAgents(): void {
  ipcMain.handle(AgentChannels.detect, () => detectAgents())
  ipcMain.handle(AgentChannels.command, (_e, req: AgentCommandRequest) =>
    buildLaunchCommand(req.agentId, req.cwd, req.resume)
  )
}
