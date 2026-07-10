import type { UiFeature } from '../../core/registry/feature-registry'
import { IntegrationsChannels, ProfileChannels, TerminalChannels, planSignature, type AgentInfo, type AgentProfile, type HostedCliId, type McpStatusSnapshot, type PaneId, type WorkspaceToolPlan } from '@contracts'
import { recordPaneLaunch } from '../../core/agents/toolplan-panes'
import { recordPaneCli, setMcpSnapshot } from '../../core/agents/mcp-status-port'

const PROVIDER_CLI: Record<string, HostedCliId | undefined> = { claude: 'claude-code', codex: 'codex', gemini: 'gemini' }
import { getBridge } from '../../core/ipc/bridge'
import { getFocusedPane } from '../../core/layout/focus'
import { setPaneLabel, setPaneProfile } from '../../core/layout/pane-meta'
import { onAgentLaunchRequest, announceProfileFailover } from '../../core/agents/launch-port'
import { setPaneAgentSession } from '../../core/agents/agent-session-port'
import { setCommands } from '../../core/commands/command-port'
import { setActiveView } from '../../core/shell/view-port'
import { requestSettingsTab } from '../../core/shell/settings-tab-port'
import { getWorkspaces, workspaceIdForPane } from '../../core/workspace/workspace-info-port'
import { onProfilesChanged } from '../../core/agents/profiles-port'
import { isPaneLive, wasPaneReattached, whenPaneLive } from '../../core/terminal/liveness-port'
import { getTelemetry } from '../../core/telemetry'
import { showToast } from '../../components'
import { agentsClient } from './agents.client'

/**
 * Agent launching (headless — no titlebar button by design: launching lives in the
 * wizard, the pane ⋯ menu, and the command palette). Detects installed CLIs, publishes
 * launch commands, and services the ui-core agent-launch port. Launching writes the
 * CLI's own command into a pane; the CLI self-authenticates (BYO — ADR 0002).
 *
 * Phase-4/04: launches can run under a named PROFILE (env pointer set, resolved
 * main-side), and a `usage-limit` notify offers/performs failover to the next
 * profile — same pane, same cwd/worktree, resume where supported. One hop per event;
 * only the CLI is interrupted (^C), never the shell/PTY (scrollback survives).
 */
export const agentsFeature: UiFeature = {
  name: 'agents',
  mount() {
    // MCP status push (8/11): keep the pane-header chip port fed + seed it.
    getBridge().on(IntegrationsChannels.statusChanged, (p) => setMcpSnapshot(p as McpStatusSnapshot))
    void (getBridge().invoke(IntegrationsChannels.statusGet) as Promise<McpStatusSnapshot>).then((s) => s && setMcpSnapshot(s))
    // Failure shoulder-tap (8/13): ONE quiet toast on a connected->needs-auth
    // transition; Re-authorize routes to the integrations home.
    getBridge().on(IntegrationsChannels.authNag, (p) => {
      const n = p as { serverLabel: string; cliLabel: string }
      showToast({
        tone: 'attention',
        title: `${n.serverLabel} needs re-authorization`,
        body: `in ${n.cliLabel}`,
        action: { label: 'Re-authorize', onClick: () => { requestSettingsTab('integrations'); setActiveView('settings') } }
      })
    })
    const nameById = new Map<string, string>()
    let installedIds: string[] = []
    /** What launched in each pane — the failover context. Values are ids only. */
    const lastLaunch = new Map<number, { provider: string; cwd: string; profileId?: string }>()
    /** Per-workspace auto-failover opt-in (in-memory; the toast is the default). */
    const autoFailover = new Map<string, boolean>()
    /** One-hop guard: a pane mid-failover ignores further limit events. */
    const failingOver = new Set<number>()

    void populate()
    onProfilesChanged(() => void populate()) // Settings edits -> palette entries follow live
    // Template opens (06b) + restore drive launches through this port.
    onAgentLaunchRequest((req) => void launchInPane(req.paneId as number, req.provider, req.cwd, req.resume, req.profileId))

    // Usage-limit events (4/04) arrive on a dedicated channel from the daemon.
    getBridge().on(TerminalChannels.limit, (payload) => {
      const id = Number((payload as { id?: number })?.id)
      if (Number.isFinite(id)) void onLimit(id)
    })

    const listProfiles = async (): Promise<AgentProfile[]> => {
      try {
        return ((await getBridge().invoke(ProfileChannels.list)) as AgentProfile[]) ?? []
      } catch {
        return []
      }
    }

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
      const profiles = await listProfiles()
      // Palette + pane-menu entries: one launch command per installed CLI — and one
      // per PROFILE when a provider has more than one (the picker, 4/04).
      const commands = installed.flatMap((a) => {
        const mine = profiles.filter((p) => p.provider === a.id).sort((x, y) => x.order - y.order)
        const base = {
          id: `agent:launch:${a.id}`,
          title: `Launch ${a.name} in focused pane`,
          hint: 'Agent',
          run: () => launchInFocused(a.id)
        }
        if (mine.length < 2) return [base]
        return [
          base,
          ...mine.map((p) => ({
            id: `agent:launch:${a.id}:${p.id}`,
            title: `Launch ${a.name} (${p.name}) in focused pane`,
            hint: 'Agent',
            run: () => launchInFocused(a.id, p.id)
          }))
        ]
      })
      setCommands('agents', commands)
      setCommands('agents-failover', [
        {
          id: 'agents:auto-failover',
          title: 'Toggle auto-failover for this workspace',
          hint: 'Profiles',
          run: () => {
            const ws = getWorkspaces()
            const id = ws.activeId
            if (!id) return
            const next = !autoFailover.get(id)
            autoFailover.set(id, next)
            showToast({ tone: 'info', title: `Auto-failover ${next ? 'ON' : 'OFF'} for this workspace` })
          }
        }
      ])
    }

    function launchInFocused(agentId: string, profileId?: string): void {
      const focus = getFocusedPane()
      if (focus) void launchInPane(focus.paneId as number, agentId, focus.cwd, false, profileId)
    }

    /** The one launch path: build the command (never a credential — ADR 0002), write it into
     *  the pane, label the pane. `shell` is a no-op (the pane is already a shell). A
     *  `custom:<command>` provider (wizard custom row) writes the user's own command verbatim. */
    async function launchInPane(
      paneId: number,
      provider: string,
      cwd: string,
      resume = false,
      profileId?: string
    ): Promise<void> {
      if (paneId < 0 || !provider || provider === 'shell') return
      // A write raced into a still-spawning PTY is dropped by the daemon — wait for
      // the pane's first output (bounded; on timeout proceed, matching the old
      // fixed-delay behavior). Found by the Linux CI sweep: slow machines lost
      // template-lineup launches entirely.
      await whenPaneLive(paneId, 15000)
      // RESTORE into a pane the daemon never let die. The PTY outlives the app (ADR 0006),
      // so on the next launch the pane reattaches to a session whose agent is still running
      // — and typing `claude --resume` there does not relaunch it, it types the words into
      // the running agent's prompt. Adopt the session instead: label it, claim its CLI for
      // the MCP chip, launch nothing. A fresh spawn (cold daemon) reports existing=false
      // and takes the normal path below.
      if (resume && wasPaneReattached(paneId)) {
        const custom = provider.startsWith('custom:')
        const label = custom
          ? provider.slice('custom:'.length).trim().split(/\s+/)[0] || 'custom'
          : (nameById.get(provider) ?? provider)
        setPaneLabel(paneId as PaneId, label)
        const reCli = PROVIDER_CLI[provider]
        if (reCli) recordPaneCli(paneId, reCli)
        // Context bar: the adopted session predates this app run, so the log
        // matcher may look back in time (agent-session port -> context feature).
        setPaneAgentSession(paneId as PaneId, { provider, cwd, adopted: true })
        return
      }
      if (provider.startsWith('custom:')) {
        const cmd = provider.slice('custom:'.length).trim()
        if (!cmd) return
        agentsClient.launchInto(paneId, cmd)
        setPaneLabel(paneId as PaneId, cmd.split(/\s+/)[0] || 'custom')
        // Published even though unsupported: it CLEARS any previous agent's context
        // bar in this pane (the context feature filters non-context providers).
        setPaneAgentSession(paneId as PaneId, { provider, cwd })
        // Provider id only — NEVER the command text (ADR 0005/0002).
        getTelemetry().captureEvent({ name: 'agent.launched', props: { provider: 'custom', resume } })
        return
      }
      // Default profile (order 0) applies when none was named and any exist (4/04).
      const mine = (await listProfiles()).filter((p) => p.provider === provider).sort((x, y) => x.order - y.order)
      const effectiveProfile = profileId ?? mine[0]?.id
      const workspaceId = workspaceIdForPane(paneId)
      const command = await agentsClient.command({ agentId: provider, cwd, resume, profileId: effectiveProfile, workspaceId })
      if (!command) return
      agentsClient.launchInto(paneId, command)
      // Remember the tool-plan signature this pane launched with (8/09) — a
      // later plan edit flips it to restart-needed.
      if (workspaceId) {
        void (getBridge().invoke(IntegrationsChannels.planGet, workspaceId) as Promise<WorkspaceToolPlan>)
          .then((plan) => recordPaneLaunch(paneId, workspaceId, planSignature(plan)))
          .catch(() => undefined)
      }
      lastLaunch.set(paneId, { provider, cwd, profileId: effectiveProfile })
      // Propagate MCP status to this pane's header (8/11): record its CLI +
      // the connected count it launched with (for the restart nudge).
      const cli = PROVIDER_CLI[provider]
      if (cli) recordPaneCli(paneId, cli)
      // Pane-meta carries the profile NAME only (⋯ menu note, 6/04) — never env.
      // A deleted/unknown id resolves to no name: the note simply disappears.
      setPaneProfile(paneId as PaneId, mine.find((p) => p.id === effectiveProfile)?.name)
      // Context bar: LAUNCH cwd + profile ID (the id names the config home main-side;
      // env values never ride the port — ADR 0002).
      setPaneAgentSession(paneId as PaneId, { provider, cwd, profileId: effectiveProfile })
      setPaneLabel(paneId as PaneId, nameById.get(provider) ?? provider)
      // Booleans/ids only — never env values or command text (ADR 0005).
      getTelemetry().captureEvent({ name: 'agent.launched', props: { provider, resume, profiled: !!effectiveProfile } })
    }

    /** Usage-limit failover (4/04): next profile, same pane, same cwd. ONE hop. */
    async function onLimit(paneId: number): Promise<void> {
      if (failingOver.has(paneId)) return
      const ctx = lastLaunch.get(paneId)
      if (!ctx) return
      const mine = (await listProfiles()).filter((p) => p.provider === ctx.provider).sort((x, y) => x.order - y.order)
      if (mine.length < 2) {
        showToast({
          tone: 'attention',
          title: `Usage limit in pane ${paneId}`,
          body: 'Add a second profile in Settings to enable failover.'
        })
        return
      }
      const curIdx = Math.max(0, mine.findIndex((p) => p.id === ctx.profileId))
      const next = mine[(curIdx + 1) % mine.length]
      const cur = mine[curIdx]
      const doFailover = (): void => {
        failingOver.add(paneId)
        // Interrupt ONLY the CLI (^C) — the shell/PTY and its scrollback survive.
        getBridge().send(TerminalChannels.write, { id: paneId as PaneId, data: '\x03' })
        setTimeout(() => {
          void launchInPane(paneId, ctx.provider, ctx.cwd, true, next.id).finally(() => failingOver.delete(paneId))
        }, 900)
        // The workspace manifest follows the switch (6/04) — otherwise the next
        // restart resurrects the capped profile. Port only, one hop per event.
        announceProfileFailover({ paneId: paneId as PaneId, profileId: next.id })
      }
      const wsId = getWorkspaces().workspaces.find((w) => w.ordinal === Math.floor(paneId / 100))?.id
      if (wsId && autoFailover.get(wsId)) {
        doFailover()
        showToast({ tone: 'info', title: `Usage limit — relaunching on ${next.name}`, body: `Pane ${paneId} (auto-failover).` })
        return
      }
      showToast({
        tone: 'attention',
        title: `Usage limit on ${cur.name}`,
        body: `Pane ${paneId} hit its limit.`,
        timeout: 15000,
        action: { label: `Relaunch on ${next.name}`, onClick: doFailover }
      })
    }

    exposeForDev()
    function exposeForDev(): void {
      if (!import.meta.env.DEV) return
      const w = window as unknown as { __mogging?: Record<string, unknown> }
      w.__mogging = w.__mogging ?? {}
      w.__mogging.agents = {
        detect: () => agentsClient.detect(),
        items: () => installedIds.slice(),
        launch: (agentId: string, profileId?: string) => launchInFocused(agentId, profileId),
        launchIn: (paneId: number, agentId: string, cwd: string, profileId?: string) =>
          launchInPane(paneId, agentId, cwd, false, profileId),
        setAutoFailover: (on: boolean) => {
          const id = getWorkspaces().activeId
          if (id) autoFailover.set(id, on)
          return id
        },
        lastLaunch: (paneId: number) => ({ ...(lastLaunch.get(paneId) ?? {}) }),
        paneLive: (paneId: number) => isPaneLive(paneId),
        refreshCommands: () => populate(),
        // Smoke/dev shim: register an agent session WITHOUT launching (the dot is
        // gated on tracked sessions — smokes driving OSC into plain panes adopt one).
        adopt: (paneId: number, provider = 'claude', cwd = '') =>
          setPaneAgentSession(paneId as PaneId, { provider, cwd, adopted: true })
      }
    }
  }
}
