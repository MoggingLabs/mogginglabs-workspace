import { AgentChannels, TerminalChannels, type AgentInfo, type AgentCommandCommitRequest, type AgentCommandCommitResult, type AgentCommandRequest, type AgentCommandResult } from '@contracts'
import { getBridge } from '../../core/ipc/bridge'

/**
 * Typed client for the agent launcher. `detect`/`command` hit the backend adapters; launching
 * is just writing the returned command into a pane via the terminal channel (the CLI
 * self-authenticates — ADR 0002). Uses the contract channels directly, not the terminal feature.
 *
 * DEV observation seams (tree-shaken in prod), mirroring terminalClient.write's spy:
 * a smoke that plants `__mogging.ptyWrites = []` sees the typed launch line, and one that
 * plants `__mogging.agentCommandCalls = []` sees WHEN each command build started — the
 * LAUNCHNOW gate's proof that the build overlaps the shell boot instead of queuing after it.
 */
const devSpy = (key: 'ptyWrites' | 'agentCommandCalls'): unknown[] | null => {
  if (!import.meta.env.DEV) return null
  const spy = (window as unknown as { __mogging?: Record<string, unknown> }).__mogging?.[key]
  return Array.isArray(spy) ? spy : null
}

export const agentsClient = {
  detect: (): Promise<AgentInfo[]> => getBridge().invoke(AgentChannels.detect) as Promise<AgentInfo[]>,
  command: (req: AgentCommandRequest): Promise<AgentCommandResult> => {
    devSpy('agentCommandCalls')?.push({ paneId: req.paneId, agentId: req.agentId, at: performance.now() })
    return getBridge().invoke(AgentChannels.command, req) as Promise<AgentCommandResult>
  },
  /** Claim a prefetched build's deferred effects (one-shot overrides, the session
   *  declaration, the restore intent) at the moment its command is typed. `ok:false`
   *  means nothing was pending — the caller must rebuild consumingly instead. */
  commandCommit: (req: AgentCommandCommitRequest): Promise<AgentCommandCommitResult> =>
    getBridge().invoke(AgentChannels.commandCommit, req) as Promise<AgentCommandCommitResult>,
  launchInto: (paneId: number, command: string): void => {
    devSpy('ptyWrites')?.push({ id: paneId, data: command + '\r', at: performance.now() })
    getBridge().send(TerminalChannels.write, { id: paneId, data: command + '\r' })
  }
}
