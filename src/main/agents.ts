import { ipcMain, type BrowserWindow } from 'electron'
import { detectAgents, buildLaunchCommand, InstallService } from '@backend/features/agents'
import { AgentChannels, type AgentCommandRequest, type AgentInfo } from '@contracts'
import { getSettingsStore } from './app-settings'
import { maybeFault } from './fault-port'
import { materializeToolPlanAtLaunch } from './tool-plan'
import { claudeStatuslineArgs } from './context'
import { bellLaunchExtras } from './notify-hook'

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
  })

  ipcMain.handle(AgentChannels.detect, () => detectOverride ?? detectAgents())
  ipcMain.handle(AgentChannels.command, (_e, req: AgentCommandRequest) => {
    const remote = req.remoteHostId
      ? getSettingsStore()?.listRemotes().find((host) => host.id === req.remoteHostId)
      : undefined
    if (req.remoteHostId && !remote) {
      return { ok: false, reason: 'The saved remote host no longer exists. The agent was not launched locally.' }
    }
    // Profile env (4/04): resolved HERE from the store — the renderer only ever
    // names a profile id; values (pointers, never secrets) stay main-side until
    // they become part of the launch command.
    const profile = !remote && req.profileId
      ? getSettingsStore()?.listProfiles().find((p) => p.id === req.profileId)
      : undefined
    if (!remote && req.profileId && !profile) {
      return { ok: false, reason: `The selected profile (${req.profileId}) no longer exists. Choose another profile before launching.` }
    }
    // Tool plan (8/09): materialize this workspace's scoped server set into the
    // launch (flag + plan file), main-side — the renderer never sees it.
    const plan = remote ? { ok: true, args: [] as string[] } : materializeToolPlanAtLaunch(req)
    if (!plan.ok) return { ok: false, reason: plan.reason }
    // Context relay: claude launches carry a generated --settings whose statusline
    // pushes Claude's OWN context numbers to the pane's gauge (src/main/context.ts).
    // The same file carries claude's notify hooks + terminal_bell (the bell layer).
    const ctxArgs = !remote && req.agentId === 'claude' ? claudeStatuslineArgs() : []
    // The bell layer for the other CLIs (notify-hook.ts): session-scoped args/env
    // that make the provider ring its pane. Profile env wins a key collision — a
    // user who pointed a profile at their own notify setup said so on purpose.
    const bell = remote ? { env: {}, args: [] } : bellLaunchExtras(req.agentId)
    const command = buildLaunchCommand(
      req.agentId,
      req.cwd,
      req.resume,
      { ...bell.env, ...profile?.env },
      [...plan.args, ...ctxArgs, ...bell.args],
      remote
        ? {
            platform: remote.platform ?? 'posix',
            shell: remote.shell ?? (remote.platform === 'windows' ? 'powershell' : 'sh')
          }
        : undefined
    )
    return command ? { ok: true, command } : { ok: false, reason: `Unknown agent provider: ${req.agentId}` }
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
