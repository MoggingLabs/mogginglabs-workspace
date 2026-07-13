import { ipcMain, type BrowserWindow } from 'electron'
import { detectAgents, buildLaunchCommand, InstallService } from '@backend/features/agents'
import { AgentChannels, type AgentCommandRequest, type AgentCommandResult } from '@contracts'
import { getSettingsStore } from './app-settings'
import { materializeToolPlanAtLaunch } from './tool-plan'
import { claudeStatuslineArgs } from './context'
import { bellLaunchExtras } from './notify-hook'
import { markAgentConfigSessionLaunched, prepareAgentConfigLaunch, refreshAgentSettingsForCli } from './agent-settings'
import { materializeProfileEnv } from './profiles'

// App-wiring: expose the agent adapters (detect installed CLIs + build a launch command) to
// the renderer. The launch itself is just writing the returned command into a pane
// (terminal:write) — the CLI self-authenticates; NO credentials are handled here (ADR 0002).
// Settings § Providers adds the third verb: install a MISSING CLI in an ephemeral
// background pty (the provider's own one-liner, run on an explicit click).

let installs: InstallService | null = null

export function registerAgents(getWin: () => BrowserWindow | null): void {
  installs = new InstallService((state) => {
    try {
      getWin()?.webContents.send(AgentChannels.installChanged, state)
    } catch {
      /* window gone — the snapshot channel catches the UI up on remount */
    }
    if (state.phase === 'succeeded') void refreshAgentSettingsForCli(state.agentId)
  })

  ipcMain.handle(AgentChannels.detect, () => detectAgents())
  ipcMain.handle(AgentChannels.command, async (_e, req: AgentCommandRequest): Promise<AgentCommandResult> => {
    if (req.remote === true) {
      const command = buildLaunchCommand(req.agentId, req.cwd, req.resume, undefined, [], 'posix')
      return command ? { ok: true, command } : { ok: false, reason: 'Unknown agent CLI.' }
    }
    // Profile env (4/04): resolved HERE from the store — the renderer only ever
    // names a profile id; values (pointers, never secrets) stay main-side until
    // they become part of the launch command.
    const profile = req.profileId
      ? getSettingsStore()?.listProfiles().find((p) => p.id === req.profileId && p.provider === req.agentId)
      : undefined
    if (req.profileId && !profile) return { ok: false, reason: 'The selected provider profile is unavailable.' }
    let profileEnv: Record<string, string>
    try {
      profileEnv = materializeProfileEnv(req.agentId, profile?.env)
    } catch {
      return { ok: false, reason: 'The selected provider profile home could not be prepared.' }
    }
    // Tool plan (8/09): materialize this workspace's scoped server set into the
    // launch (flag + plan file), main-side — the renderer never sees it.
    const prepared = await prepareAgentConfigLaunch(req)
    if (!prepared.ok) return { ok: false, reason: prepared.reason || 'Provider settings could not be synchronized.' }
    const mcpArgs = await materializeToolPlanAtLaunch(req)
    // Context relay: claude launches carry a generated --settings whose statusline
    // pushes Claude's OWN context numbers to the pane's gauge (src/main/context.ts).
    // The same file carries claude's notify hooks + terminal_bell (the bell layer).
    const ctxArgs = req.agentId === 'claude' ? claudeStatuslineArgs(prepared.runtime) : []
    // The bell layer for the other CLIs (notify-hook.ts): session-scoped args/env
    // that make the provider ring its pane. Profile env wins a key collision — a
    // user who pointed a profile at their own notify setup said so on purpose.
    const bell = bellLaunchExtras(req.agentId, { runtime: prepared.runtime, tui: prepared.tui })
    if (bell.reason) return { ok: false, reason: bell.reason }
    const command = buildLaunchCommand(
      req.agentId,
      req.cwd,
      req.resume,
      { ...bell.env, ...profileEnv, ...prepared.env },
      [...mcpArgs, ...ctxArgs, ...bell.args, ...prepared.args]
    )
    if (!command) return { ok: false, reason: 'Unknown agent CLI.' }
    markAgentConfigSessionLaunched(req)
    return { ok: true, command }
  })
  ipcMain.handle(AgentChannels.install, (_e, agentId: string) => installs!.start(String(agentId)))
  ipcMain.handle(AgentChannels.installStates, () => installs?.states() ?? [])
}

/** App quitting: kill any in-flight ephemeral install terminals. */
export function disposeAgentInstalls(): void {
  installs?.dispose()
  installs = null
}
