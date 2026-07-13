import type { UiFeature } from '../../core/registry/feature-registry'
import { IntegrationsChannels, ProfileChannels, TerminalChannels, isAgentCliId, planSignature, type AgentDetectedEvent, type AgentInfo, type AgentProfile, type HostedCliId, type McpStatusSnapshot, type PaneId, type WorkspaceToolPlan } from '@contracts'
import { recordPaneLaunch } from '../../core/agents/toolplan-panes'
import { recordPaneCli, setMcpSnapshot } from '../../core/agents/mcp-status-port'

const PROVIDER_CLI: Record<string, HostedCliId | undefined> = { claude: 'claude-code', codex: 'codex', gemini: 'gemini' }
import { getBridge } from '../../core/ipc/bridge'
import { getFocusedPane } from '../../core/layout/focus'
import { getPaneCwd, getPaneCwdProjection, onPaneCwdProjection, setPaneCwd } from '../../core/layout/pane-cwd'
import { getPaneRemote, setPaneLabel, setPaneProfile } from '../../core/layout/pane-meta'
import { onAgentLaunchRequest, requestAgentLaunch, announceProfileFailover } from '../../core/agents/launch-port'
import { clearPaneAgentSession, getPaneAgentSession, setPaneAgentSession, type PaneAgentSession } from '../../core/agents/agent-session-port'
import { setCommands } from '../../core/commands/command-port'
import { setActiveView } from '../../core/shell/view-port'
import { requestSettingsTab } from '../../core/shell/settings-tab-port'
import { getWorkspaces, workspaceIdForPane } from '../../core/workspace/workspace-info-port'
import { onProfilesChanged } from '../../core/agents/profiles-port'
import {
  isPaneLive,
  isPaneRemoteReady,
  markPaneRemoteReady,
  wasPaneReattached,
  whenPaneLive,
  whenPaneRemoteReady
} from '../../core/terminal/liveness-port'
import { getTelemetry } from '../../core/telemetry'
import { showToast } from '../../components'
import { agentsClient } from './agents.client'
import { getAgentRegistry, onAgentRegistryChange, refreshAgentRegistry } from '../../core/agents/registry'

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
    /** When this feature last WROTE a pane's session, and when detection last SAW an agent
     *  in it. Ordering the two is what keeps a relaunch honest: the dying old agent's "gone"
     *  verdict is still in flight while the new one is being typed, and clearing on it would
     *  wipe the session (profile and all) that the relaunch just established. A `null`
     *  verdict may only retire the session it actually refers to — one that began no later
     *  than the agent it watched. */
    const sessionSetAt = new Map<number, number>()
    const detectedAt = new Map<number, number>()

    /** A launch intent updates the header immediately, before its shell command/process report
     * returns. Remote launch paths stay remote metadata and can never arm local Git. */
    const projectLaunchCwd = (paneId: number, cwd: string): void => {
      setPaneCwd(paneId as PaneId, cwd, {
        source: 'spawn',
        locality: getPaneRemote(paneId as PaneId) ? 'remote' : 'local'
      })
    }

    // An explicit agent declaration is the current worktree for relaunch/failover. Keep the
    // agent-session cwd untouched: it identifies the original session log, not live navigation.
    onPaneCwdProjection((paneId, projection) => {
      if (projection?.source !== 'agent') return
      const id = Number(paneId)
      const prior = lastLaunch.get(id)
      const session = getPaneAgentSession(paneId)
      if (prior) lastLaunch.set(id, { ...prior, cwd: projection.cwd })
      else if (session) {
        lastLaunch.set(id, { provider: session.provider, cwd: projection.cwd, profileId: session.profileId })
      }
    })

    /** The ONE writer of the agent-session port (the port's contract), stamped so the
     *  detection reconciler above can tell a stale verdict from a current one. `at` lets a
     *  DETECTED session share the exact stamp of the detection that produced it: written a
     *  tick later, the session would forever look NEWER than the agent it describes, and that
     *  agent's own "gone" verdict could never retire it — a gauge for a dead agent. */
    const writeSession = (paneId: number, session: PaneAgentSession, at = Date.now()): void => {
      sessionSetAt.set(paneId, at)
      setPaneAgentSession(paneId as PaneId, session)
    }

    let populateGeneration = 0
    onAgentRegistryChange((agents) => void populate(agents))
    onProfilesChanged(() => void populate()) // Settings edits -> palette entries follow live
    // Template opens (06b) + restore drive launches through this port.
    onAgentLaunchRequest((req) => void launchInPane(req.paneId as number, req.provider, req.cwd, req.resume, req.profileId))

    // Usage-limit events (4/04) arrive on a dedicated channel from the daemon.
    getBridge().on(TerminalChannels.limit, (payload) => {
      const id = Number((payload as { id?: number })?.id)
      if (Number.isFinite(id)) void onLimit(id)
    })

    // TYPED-LAUNCH DETECTION. The backend watches each pane's PTY subtree and says which
    // agent CLI is really running in it (process table, not output parsing). This is the
    // path for every agent the app did NOT launch: a `claude` typed at the pane's own
    // prompt, and — after a restart — any agent the detached daemon kept alive. Fulfilled
    // HERE because `agents` is the port's one writer, so a detected session is the same
    // object as a launched one: context gauge, provider mark, MCP chip, failover, resume.
    getBridge().on(TerminalChannels.agent, (payload) => void onAgentDetected(payload as AgentDetectedEvent))

    async function onAgentDetected(ev: AgentDetectedEvent): Promise<void> {
      const paneId = Number(ev?.id)
      if (!Number.isFinite(paneId)) return
      const existing = getPaneAgentSession(paneId as PaneId)

      // The pane's agent is GONE. Retire the session — process truth, so this is the honest
      // version of the OSC-133 guess TerminalPane also makes. But only for the session this
      // verdict actually describes: a launch typed AFTER the agent we watched (a failover
      // relaunch, a user relaunching by hand) is a different session, and its identity must
      // survive its predecessor's death rattle.
      if (!ev.agentId) {
        if ((detectedAt.get(paneId) ?? 0) >= (sessionSetAt.get(paneId) ?? 0)) clearPaneAgentSession(paneId as PaneId)
        return
      }
      // ONE stamp for this verdict and for any session it writes below — see writeSession.
      const at = Date.now()
      detectedAt.set(paneId, at)

      // The app launched this very CLI here: its own record is strictly richer (the exact launch
      // cwd, the profile it chose), so detection only CONFIRMS it — rewriting would restart the
      // log watch and drop the profile for nothing. But it has to confirm it OUT LOUD. Returning
      // in silence left the port unable to say the one thing only the process table knows: the
      // agent is actually UP. A launch writes its session the moment it types the command, so
      // "there is a session here" has always meant "a command was typed", and a reader that
      // needed "something is listening" had nothing to wait for. The board hands a card's task to
      // the pane as the agent's first prompt and waited on exactly this — so it fired 800ms after
      // typing, into the shell behind a still-booting CLI, which then took the alternate screen
      // and wiped it: the task gone, the agent never saw it, the one thing the board exists to do.
      // The identity stays byte-for-byte; all we add is the verdict that the process is real.
      if (existing && existing.provider === ev.agentId && !existing.detected) {
        if (!existing.running) writeSession(paneId, { ...existing, running: true }, at)
        return
      }
      // Process cwd is the session-log identity for a hand-typed CLI. Canonical live cwd comes
      // only through the source-aware terminal cwd stream; writing it here was a competing,
      // unrevisioned path that could roll an explicit report back to an older process snapshot.
      const cwd = ev.cwd || getPaneCwd(paneId as PaneId) || ''
      if (existing && existing.provider === ev.agentId && existing.cwd === cwd) return // same session, no news

      // A profile's env pointers are `set`/`export`ed INTO the pane's shell (see the launch
      // builder), so they outlive the agent that was launched with them: a CLI re-typed in
      // that pane runs under the same profile, and its config home must resolve the same way
      // — otherwise the bar looks for the session log under the default home and finds none.
      const prior = lastLaunch.get(paneId)
      const profileId = prior?.provider === ev.agentId ? prior.profileId : undefined

      // Everything that establishes the session is SYNCHRONOUS, in one tick: an `await` here
      // would open a window for this pane's next verdict — the agent exiting — to land first
      // and be overwritten, leaving a session (and a gauge) for a process that is already
      // gone. The profile's display NAME is the one thing worth a round trip, so it follows
      // afterwards; it is a note on the pane, not the session's identity.
      writeSession(
        paneId,
        // Detected means the process table SAW it: a detected session is running by definition.
        { provider: ev.agentId, cwd, profileId, detected: true, running: true, since: ev.sinceMs },
        at // the session and the agent it names are the same event
      )
      const projection = getPaneCwdProjection(paneId as PaneId)
      const failoverCwd = projection?.source === 'agent' ? projection.cwd : cwd
      lastLaunch.set(paneId, { provider: ev.agentId, cwd: failoverCwd, profileId }) // failover works here too
      setPaneLabel(paneId as PaneId, nameById.get(ev.agentId) ?? ev.agentId)
      const cli = PROVIDER_CLI[ev.agentId]
      if (cli) recordPaneCli(paneId, cli) // the pane's MCP chip, same as a launched agent
      // Provider id only — never the command the user typed (ADR 0005/0002).
      getTelemetry().captureEvent({ name: 'agent.detected', props: { provider: ev.agentId } })

      if (!profileId) {
        setPaneProfile(paneId as PaneId, undefined) // a previous launch's note is not this agent's
        return
      }
      const name = (await listProfiles()).find((p) => p.id === profileId)?.name
      // The pane may have moved on while we asked (the agent quit, another CLI started):
      // only note the profile if this session is still the one running.
      if (getPaneAgentSession(paneId as PaneId)?.profileId === profileId) setPaneProfile(paneId as PaneId, name)
    }

    const listProfiles = async (): Promise<AgentProfile[]> => {
      try {
        return ((await getBridge().invoke(ProfileChannels.list)) as AgentProfile[]) ?? []
      } catch {
        return []
      }
    }

    async function populate(nextAgents?: readonly AgentInfo[]): Promise<void> {
      const generation = ++populateGeneration
      let agents = [...(nextAgents ?? getAgentRegistry())]
      if (!nextAgents && !agents.length) {
        try {
          agents = [...(await refreshAgentRegistry())]
        } catch {
          agents = []
        }
      }
      if (generation !== populateGeneration) return
      nameById.clear()
      for (const a of agents) nameById.set(a.id, a.name)
      const installed = agents.filter((a) => a.installed)
      installedIds = installed.map((a) => a.id)
      const profiles = await listProfiles()
      if (generation !== populateGeneration) return
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
      if (!focus) return
      // Through the launch PORT, not straight into launchInPane (this feature's own
      // subscription fulfils the request): the workspace feature records every port
      // request as that slot's manifest ASSIGNMENT (+ launch cwd), so a palette/menu
      // launch survives restore exactly like a wizard-lineup one. Launched directly,
      // the manifest never learned about the agent — a pane added after workspace
      // creation lost its whole session identity (context bar, agent chip, resume)
      // on the next app restart, while the reattached CLI kept visibly running.
      requestAgentLaunch({ paneId: focus.paneId, provider: agentId, cwd: focus.cwd, profileId })
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
      // A write raced into a still-spawning PTY is dropped by the daemon — wait for the
      // pane's first output (bounded; on timeout proceed, matching the old fixed-delay
      // behavior). Found by the Linux CI sweep: slow machines lost template-lineup launches.
      // Remote output may instead be an SSH password/host-key prompt, so only the
      // bootstrap's live cwd report proves the far-side shell is ready. Keep remote intent
      // queued through arbitrarily slow password, MFA, or host-key confirmation; pane
      // disposal cancels the waiter and still fails closed.
      const remoteTarget = getPaneRemote(paneId as PaneId)
      const remote = !!remoteTarget
      const ready = remote ? await whenPaneRemoteReady(paneId) : await whenPaneLive(paneId, 15000)
      if (remote && !ready) {
        showToast({
          tone: 'danger',
          title: `Remote agent was not started in pane ${paneId}`,
          body: 'SSH did not reach the remote shell. Finish or cancel the host-key/password prompt, then launch the agent again.'
        })
        return
      }
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
        // The adopted agent originally launched under a profile — the named one, or
        // the provider's order-0 default, the SAME resolution a fresh launch applies.
        // The context watch resolves the CONFIG HOME from that id (CLAUDE_CONFIG_DIR
        // et al.); adopting without it pointed the session-log matcher at the default
        // home, so any profile with a relocated home lost its context bar on every
        // app restart even though the agent never stopped.
        const mine = custom
          ? []
          : (await listProfiles()).filter((p) => p.provider === provider).sort((x, y) => x.order - y.order)
        const adoptedProfile = profileId ?? mine[0]?.id
        projectLaunchCwd(paneId, cwd)
        setPaneProfile(paneId as PaneId, mine.find((p) => p.id === adoptedProfile)?.name)
        // Context bar: the adopted session predates this app run, so the log
        // matcher may look back in time (agent-session port -> context feature).
        writeSession(paneId, { provider, cwd, profileId: adoptedProfile, adopted: true })
        // The failover context, which an adopted pane never had: a usage limit in a pane
        // whose agent survived a restart could not offer the next profile, because nothing
        // remembered what was running in it.
        lastLaunch.set(paneId, { provider, cwd, profileId: adoptedProfile })
        return
      }
      if (provider.startsWith('custom:')) {
        const cmd = provider.slice('custom:'.length).trim()
        if (!cmd) return
        projectLaunchCwd(paneId, cwd)
        agentsClient.launchInto(paneId, cmd)
        setPaneLabel(paneId as PaneId, cmd.split(/\s+/)[0] || 'custom')
        // Published even though unsupported: it CLEARS any previous agent's context
        // bar in this pane (the context feature filters non-context providers).
        writeSession(paneId, { provider, cwd })
        // Provider id only — NEVER the command text (ADR 0005/0002).
        getTelemetry().captureEvent({ name: 'agent.launched', props: { provider: 'custom', resume } })
        return
      }
      if (!isAgentCliId(provider)) return
      // Default profile (order 0) applies when none was named and any exist (4/04).
      const mine = (await listProfiles()).filter((p) => p.provider === provider).sort((x, y) => x.order - y.order)
      const effectiveProfile = profileId ?? mine[0]?.id
      const workspaceId = workspaceIdForPane(paneId)
      const result = await agentsClient.command({
        agentId: provider,
        cwd,
        resume,
        profileId: effectiveProfile,
        workspaceId,
        // Both facts main-side needs: WHICH saved host to build for, and that the command
        // is typed into the POSIX shell on the far side of SSH.
        remoteHostId: remoteTarget?.hostId,
        remote
      })
      if (!result.ok || !result.command) {
        showToast({
          tone: 'danger',
          title: `Agent was not launched in pane ${paneId}`,
          body: result.reason || 'The saved configuration could not be synchronized before launch.'
        })
        return
      }
      projectLaunchCwd(paneId, cwd)
      agentsClient.launchInto(paneId, result.command)
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
      writeSession(paneId, { provider, cwd, profileId: effectiveProfile })
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
        detect: () => refreshAgentRegistry(),
        items: () => installedIds.slice(),
        launch: (agentId: string, profileId?: string) => launchInFocused(agentId, profileId),
        launchIn: (paneId: number, agentId: string, cwd: string, profileId?: string) =>
          launchInPane(paneId, agentId, cwd, false, profileId),
        remoteReady: (paneId: number) => isPaneRemoteReady(paneId),
        setAutoFailover: (on: boolean) => {
          const id = getWorkspaces().activeId
          if (id) autoFailover.set(id, on)
          return id
        },
        lastLaunch: (paneId: number) => ({ ...(lastLaunch.get(paneId) ?? {}) }),
        paneLive: (paneId: number) => isPaneLive(paneId),
        markRemoteReady: (paneId: number) => markPaneRemoteReady(paneId),
        refreshCommands: () => refreshAgentRegistry().then((agents) => populate(agents)),
        // Smoke/dev shim: register an agent session WITHOUT launching (the dot is
        // gated on tracked sessions — smokes driving OSC into plain panes adopt one).
        adopt: (paneId: number, provider = 'claude', cwd = '') =>
          writeSession(paneId, { provider, cwd, adopted: true }),
        // Smoke/dev shim: replay a detection event exactly as the backend sends it, so a
        // gate can prove the whole typed-launch path without a real agent process.
        detected: (ev: AgentDetectedEvent) => onAgentDetected(ev),
        session: (paneId: number) => getPaneAgentSession(paneId as PaneId) ?? null
      }
    }
  }
}
