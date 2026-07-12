import { AgentChannels, TerminalChannels, type AgentInfo, type AgentCommandRequest, type AgentCommandResult } from '@contracts'
import { getBridge } from '../../core/ipc/bridge'

/**
 * Typed client for the agent launcher. `detect`/`command` hit the backend adapters; launching
 * is just writing the returned command into a pane via the terminal channel (the CLI
 * self-authenticates — ADR 0002). Uses the contract channels directly, not the terminal feature.
 */
export const agentsClient = {
  detect: (): Promise<AgentInfo[]> => getBridge().invoke(AgentChannels.detect) as Promise<AgentInfo[]>,
  command: (req: AgentCommandRequest): Promise<AgentCommandResult> =>
    getBridge().invoke(AgentChannels.command, req) as Promise<AgentCommandResult>,
  launchInto: (paneId: number, command: string): void =>
    getBridge().send(TerminalChannels.write, { id: paneId, data: command + '\r' })
}
