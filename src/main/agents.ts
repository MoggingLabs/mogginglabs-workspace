import { ipcMain, type BrowserWindow } from 'electron'
import { detectAgents, buildLaunchCommand, InstallService } from '@backend/features/agents'
import { AgentChannels, type AgentCommandRequest, type AgentCommandResult, type AgentInfo } from '@contracts'
import { getSettingsStore } from './app-settings'
import { maybeFault } from './fault-port'
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
let detectOverride: AgentInfo[] | null = null

export function registerAgents(getWin: () => BrowserWindow | null): void {
  installs = new InstallService((state) => {
    try {
      getWin()?.webContents.send(AgentChannels.installChanged, state)
    } catch {
      /* window gone — the snapshot channel catches the UI up on remount */
    }
    if (state.phase === 'succeeded') void refreshAgentSettingsForCli(state.agentId)
  })

  ipcMain.handle(AgentChannels.detect, () => detectOverride ?? detectAgents())
  ipcMain.handle(AgentChannels.command, async (_e, req: AgentCommandRequest): Promise<AgentCommandResult> => {
    const remoteHost = req.remoteHostId
      ? getSettingsStore()?.listRemotes().find((host) => host.id === req.remoteHostId)
      : undefined
    if (req.remoteHostId && !remoteHost) {
      return { ok: false, reason: 'The saved remote host no longer exists. The agent was not launched locally.' }
    }
    // A remote launch is typed into the shell on the far side of SSH: no profile homes, no
    // materialized plan file, no bell/statusline hooks (all of those are LOCAL filesystem
    // facts). A saved host names its own dialect; a bare `remote: true` means confirmed POSIX.
    if (remoteHost || req.remote === true) {
      const target = remoteHost
        ? {
            platform: remoteHost.platform ?? 'posix',
            shell: remoteHost.shell ?? (remoteHost.platform === 'windows' ? 'powershell' : 'sh')
          }
        : ('posix' as const)
      const command = buildLaunchCommand(req.agentId, req.cwd, req.resume, undefined, [], target)
      return command ? { ok: true, command } : { ok: false, reason: `Unknown agent provider: ${req.agentId}` }
    }
    // Profile env (4/04): resolved HERE from the store — the renderer only ever
    // names a profile id; values (pointers, never secrets) stay main-side until
    // they become part of the launch command.
    const profile = req.profileId
      ? getSettingsStore()?.listProfiles().find((p) => p.id === req.profileId && p.provider === req.agentId)
      : undefined
    if (req.profileId && !profile) {
      return { ok: false, reason: `The selected profile (${req.profileId}) no longer exists. Choose another profile before launching.` }
    }
    let profileEnv: Record<string, string>
    try {
      profileEnv = materializeProfileEnv(req.agentId, profile?.env)
    } catch {
      return { ok: false, reason: 'The selected provider profile home could not be prepared.' }
    }
    // Provider settings (agent-CLI control plane): reconcile this launch's desired config
    // before anything is typed — a failed reconciliation refuses the launch, never launches
    // silently on the CLI's own settings.
    const prepared = await prepareAgentConfigLaunch(req)
    if (!prepared.ok) return { ok: false, reason: prepared.reason || 'Provider settings could not be synchronized.' }
    // Tool plan (8/09): materialize this workspace's scoped server set into the
    // launch (flag + plan file), main-side — the renderer never sees it. A refused
    // materialization refuses the LAUNCH; it never falls back to global servers.
    const plan = await materializeToolPlanAtLaunch(req)
    if (!plan.ok) return { ok: false, reason: plan.reason }
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
      [...plan.args, ...ctxArgs, ...bell.args, ...prepared.args]
    )
    if (!command) return { ok: false, reason: `Unknown agent provider: ${req.agentId}` }
    markAgentConfigSessionLaunched(req)
    return { ok: true, command }
  })
  ipcMain.handle(AgentChannels.install, (_e, agentId: string) => installs!.start(String(agentId)))
  ipcMain.handle(AgentChannels.installStates, async () => {
    await maybeFault(AgentChannels.installStates) // finding 39's seam: Settings § Providers' read
    return installs?.states() ?? []
  })
}

/** App quitting: kill any in-flight ephemeral install terminals. */
export function disposeAgentInstalls(): void {
  installs?.dispose()
  installs = null
  detectOverride = null
}

/** Deterministic availability seam for the live-registry audit gate. */
export function setAgentDetectOverrideForSmoke(next: AgentInfo[] | null): void {
  detectOverride = next ? next.map((agent) => ({ ...agent })) : null
}
