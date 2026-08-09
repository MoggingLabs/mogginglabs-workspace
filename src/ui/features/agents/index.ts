import type { UiFeature } from '../../core/registry/feature-registry'
import { AgentChannels, AgentHookChannels, IntegrationsChannels, ProfileChannels, TerminalChannels, isAgentCliId, planSignature, type AgentCliId, type AgentCommandResult, type AgentDetectedEvent, type AgentInfo, type AgentProfile, type GlobalHooksMutationResult, type GlobalHooksStatus, type HostedCliId, type McpStatusSnapshot, type PaneId, type WorkspaceToolPlan } from '@contracts'
import { dismissSignInBanner, offerSignIn } from './signin-banner'
import { interruptAgent, noteAgentGone, noteAgentPresent, recordSwitchPhase, resetSwitchTrace, switchTrace } from './interrupt'
import { endProvesAgentGone } from './interrupt-core'
import { NO_LAUNCH_COVER, beginLaunchCover, type LaunchCover } from './launch-readiness'
import { autoTrustClaudeLaunch, isTrustSettled, markTrustPrepared } from './auto-trust'
import { trustDialogLive } from './prompt-answer'
import { typeContinuation } from './continuation'
import { readPaneBufferTail } from '../../core/terminal/pane-buffer-port'
import { getPaneFailoverOffer, setPaneFailoverOffer, type PaneFailoverOffer } from '../../core/agents/failover-offer-port'
import { announceUsageCapped, onUsageCapped } from '../../core/usage/usage-capped-port'
import { recordPaneLaunch } from '../../core/agents/toolplan-panes'
import { recordPaneCli, setMcpSnapshot } from '../../core/agents/mcp-status-port'

const PROVIDER_CLI: Record<string, HostedCliId | undefined> = { claude: 'claude-code', codex: 'codex', gemini: 'gemini' }
import { getBridge } from '../../core/ipc/bridge'
import { getFocusedPane } from '../../core/layout/focus'
import { getPaneCwd, getPaneCwdProjection, onPaneCwdProjection, setPaneCwd } from '../../core/layout/pane-cwd'
import { getPaneRemote, setPaneLabel, setPaneProfile } from '../../core/layout/pane-meta'
import { onAgentLaunchRequest, requestAgentLaunch, announcePaneProfile, type AgentLaunchRequest } from '../../core/agents/launch-port'
import {
  NO_PROFILE,
  UNKNOWN_PROFILE,
  namedProfile,
  orderZeroProfileId,
  profileIdOf,
  profilesFor,
  resolveAdoptedProfile,
  resolveLaunchProfile,
  type PaneProfile
} from '../../core/agents/pane-profile'
import { endRetiresLaunchContext, pickFailoverTarget } from './launch-ledger'
import { cappedOfferCopy, laneIdentity, planCappedOffers, type CappedOfferPlan, type CappedPane } from './capped-offers'
import { getUsageLanes, onUsageLanesChange } from '../../core/usage/usage-lane-port'
import type { CappedLane } from '../../core/usage/lane-capped'
import { armSpawnRun, whenSpawnRunOutcome } from '../../core/terminal/spawn-run-port'
import { paneInstance } from '../../core/terminal/pane-instance-port'
import { clearPaneAgentSession, getPaneAgentSession, onPaneAgentSession, setPaneAgentSession, type PaneAgentSession } from '../../core/agents/agent-session-port'
import { allCommands, setCommands } from '../../core/commands/command-port'
import { setActiveView } from '../../core/shell/view-port'
import { requestSettingsTab } from '../../core/shell/settings-tab-port'
import { getWorkspaces, onWorkspacesChange, workspaceIdForPane } from '../../core/workspace/workspace-info-port'
import { onProfilesChanged } from '../../core/agents/profiles-port'
import {
  clearPaneReattached,
  isPaneLive,
  isPaneRemoteReady,
  markPaneReattached,
  markPaneRemoteReady,
  paneLiveAt,
  wasPaneReattached,
  whenPaneLive,
  whenPaneRemoteReady,
  whenPaneSpawnSettled
} from '../../core/terminal/liveness-port'
import { getTelemetry } from '../../core/telemetry'
import { showToast } from '../../components'
import { agentsClient } from './agents.client'
import { composeFirstPrompt } from './launch'
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
    /** The last-listed profiles — the capped-claim's SYNCHRONOUS order-0 lookup
     *  (populate() refreshes it on mount, registry change, and every profiles edit). */
    let cachedProfiles: AgentProfile[] = []
    /** What launched in each pane — the failover context. Values are ids only,
     *  and the profile is a THREE-state fact: a pane whose account nobody
     *  recorded is `unknown`, never defaulted to order-0. Defaulting is what let
     *  one capped-lane event claim every pane in the grid after a restart.
     *
     *  Stamped with the pane INSTANCE. Pane ids are deliberately reusable, and
     *  the session-end signal that retires an entry does not always arrive:
     *  `clearPaneAgentSession` returns early when there is no session, so a pane
     *  whose agent already died by verdict and is THEN disposed fires nothing.
     *  Without the stamp that entry outlives its pane and the next occupant of
     *  the id inherits a stranger's account. */
    const lastLaunch = new Map<number, { provider: string; cwd: string; profile: PaneProfile; instance?: number }>()
    /** The launch context for THIS pane — never a previous occupant's. */
    const launchCtx = (paneId: number): { provider: string; cwd: string; profile: PaneProfile } | undefined => {
      const ctx = lastLaunch.get(paneId)
      if (!ctx) return undefined
      const live = paneInstance(paneId as PaneId)
      // Evicted only on a REPLACEMENT — a different pane now holds this id, so
      // the entry describes someone else. An id with no pane at all is left
      // alone: nothing can read it as a live pane's context (agent presence is
      // false either way), and the moment a new pane claims the id this same
      // check evicts it. An entry with no stamp is pre-change state and is
      // likewise left alone rather than guessed about.
      if (ctx.instance !== undefined && live !== undefined && ctx.instance !== live) {
        lastLaunch.delete(paneId)
        cappedRaised.delete(paneId)
        cappedMisses.delete(paneId)
        cappedDismissed.delete(paneId)
        return undefined
      }
      return ctx
    }
    /** Record a launch context, stamped with the pane it is about. */
    const setLaunchCtx = (paneId: number, ctx: { provider: string; cwd: string; profile: PaneProfile }): void => {
      const instance = paneInstance(paneId as PaneId)
      lastLaunch.set(paneId, { ...ctx, ...(instance !== undefined ? { instance } : {}) })
    }
    /** Main's build wall-ms for the most recent launch (dev measurement seam). */
    let lastBuildMs: number | null = null
    /** Per-workspace auto-failover opt-in (in-memory; the toast is the default). */
    const autoFailover = new Map<string, boolean>()
    /** One-hop guard: a pane mid-failover ignores further limit events. */
    const failingOver = new Set<number>()
    /** Offers THIS path raised, by object IDENTITY. Sampled at reconcile time and
     *  re-checked at the instant of the write: a `switching`/`launching`/`failed`
     *  overlay that superseded ours belongs to another owner, and clearing blind
     *  destroyed it (the lesson launch-readiness records in as many words). */
    const cappedRaised = new Map<number, { offer: PaneFailoverOffer; identity: string; lane: CappedLane }>()
    /** Consecutive reconciles that failed to justify a held offer. One
     *  unjustified sample is a rumour; two agree. */
    const cappedMisses = new Map<number, number>()
    /** What the human said "Not now" to. Without this latch, going level-triggered
     *  would re-raise a dismissed card on the very next poll — a regression the
     *  old edge-triggered code avoided by accident. It expires by itself: a rolled
     *  window is a new lane identity. */
    const cappedDismissed = new Map<number, string>()
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
      const prior = launchCtx(id)
      const session = getPaneAgentSession(paneId)
      if (prior) setLaunchCtx(id, { ...prior, cwd: projection.cwd })
      else if (session) {
        setLaunchCtx(id, {
          provider: session.provider,
          cwd: projection.cwd,
          profile: resolveAdoptedProfile(session.profileId, profilesFor(cachedProfiles, session.provider))
        })
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
    onProfilesChanged(() => {
      // Settings edits -> palette entries follow live... and so does the capped
      // decision: `paneMatchesCappedLane` resolves a profile-less pane's lane
      // through the provider's ORDER-ZERO id, so login discovery minting
      // `login-<provider>` minutes after a launch changes the answer. That is
      // the exact case the matcher's fuzzy arm exists for, and without this the
      // pane waited for some unrelated input to re-run the decision.
      void populate().then(() => void reconcileCappedOffers())
    })
    // Template opens (06b) + restore drive launches through this port. A fresh open's
    // local slots arrive as deliver:'spawn' BEFORE their panes exist — spawnDeliver must
    // arm the command synchronously in this callback, or the pane's spawn misses it.
    onAgentLaunchRequest((req) => {
      if (req.deliver === 'spawn') spawnDeliver(req)
      else void launchInPane(req.paneId as number, req.provider, req.cwd, req.resume, req.profileId)
    })

    // Usage-limit events (4/04) arrive on a dedicated channel from the daemon —
    // the immediate trigger, when a provider hook ever emits one.
    getBridge().on(TerminalChannels.limit, (payload) => {
      const id = Number((payload as { id?: number })?.id)
      if (Number.isFinite(id)) void offerSwitch(id, 'notify')
    })

    // Persisted auto-failover follows the ACTIVE workspace (F6): hydrate its stored
    // state on every switch and keep the palette title honest about it.
    let lastActiveWs: string | null = null
    onWorkspacesChange((snap) => {
      if (snap.activeId === lastActiveWs) return
      lastActiveWs = snap.activeId
      if (!snap.activeId) return
      void hydrateAutoFailover(snap.activeId).then(() => publishFailoverCommand())
    })

    // The usage ENGINE's trigger (F4): a lane crossed 100% ('capped' alert). Claim it
    // by raising the offer on every LIVE pane running that lane; unclaimed events fall
    // back to the usage feature's toast. Synchronous claim over in-memory state only.
    onUsageCapped((ev) => {
      // The event says WHICH lane to look at again. The lane PORT says whether it
      // is spent. `ev` is never read as evidence — it cannot be, it carries only
      // ids — so a 24h-old outbox replay nudges a re-derivation that finds
      // nothing and covers nothing. The boolean stays synchronous, so the claim
      // contract (a covered pane suppresses the announcer's toast) is unchanged.
      const plan = reconcileCappedOffers()
      const covered =
        plan.raise.some((r) => r.lane.providerId === ev.providerId && r.lane.profileId === ev.profileId) ||
        [...cappedRaised.values()].some((m) => m.lane.providerId === ev.providerId && m.lane.profileId === ev.profileId)
      return covered
    })
    // The offer is a FUNCTION OF CURRENT STATE, so every input to that function
    // re-runs it: the lanes changing (including the port's own expiry timer,
    // which fires at a window's reset instead of waiting out the poll cadence),
    // a pane's agent arriving or leaving, and a launch changing what a pane runs.
    onUsageLanesChange(() => void reconcileCappedOffers())

    // TYPED-LAUNCH DETECTION. The backend watches each pane's PTY subtree and says which
    // agent CLI is really running in it (process table, not output parsing). This is the
    // path for every agent the app did NOT launch: a `claude` typed at the pane's own
    // prompt, and — after a restart — any agent the detached daemon kept alive. Fulfilled
    // HERE because `agents` is the port's one writer, so a detected session is the same
    // object as a launched one: context gauge, provider mark, MCP chip, failover, resume.
    getBridge().on(TerminalChannels.agent, (payload) => void onAgentDetected(payload as AgentDetectedEvent))

    // Belt and braces beside the process verdict: a PTY exit, or the pane being closed
    // out from under the switch, also mean "nothing left to interrupt" — and a WRITTEN
    // session re-arms the gone signal, so a switch started while the next CLI is already
    // booting waits for a real exit instead of insta-succeeding on stale state.
    //
    // But only the ends that are PROOF (interrupt-core's endProvesAgentGone). This used
    // to note EVERY clear as gone, which handed the interrupt the OSC-133 prompt guess as
    // a verdict — the fail-closed hole the PROFSWITCH flake was.
    onPaneAgentSession((paneId, session, end) => {
      if (session) noteAgentPresent(Number(paneId))
      else if (end) {
        if (endProvesAgentGone(end)) noteAgentGone(Number(paneId))
        cappedDismissed.delete(Number(paneId)) // a new agent is a new conversation
        // The SHELL is gone, so the profile env `export`ed into it is gone with
        // it — and pane ids are recycled, so a surviving entry gets inherited by
        // a stranger. NOT endProvesAgentGone: that also answers 'verdict', and
        // an agent dying inside a living shell is exactly the case the failover
        // relaunch depends on. Five writers and zero deleters is how this map
        // outlived the panes it described.
        if (endRetiresLaunchContext(end)) lastLaunch.delete(Number(paneId))
      }
      // Agent presence is an input to whether a pane may be covered, so a change
      // in it re-runs the decision.
      void reconcileCappedOffers()
    })

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
        // The reattach mark describes the pane's SPAWN-TIME agent ("already running when
        // we asked"). The process table just said that agent is gone — whichever session
        // the guard below decides to keep, a future resume typed here is a real launch
        // again, not words into a running CLI (audit F1: the mark used to hold for the
        // pane's whole life, so every post-restart failover adopted and typed nothing).
        clearPaneReattached(paneId)
        // The deterministic interrupt (interrupt.ts) waits on exactly this verdict —
        // fired BEFORE the stamp guard below, which may legitimately keep an adopted
        // session while the process is nonetheless gone.
        noteAgentGone(paneId)
        if ((detectedAt.get(paneId) ?? 0) >= (sessionSetAt.get(paneId) ?? 0)) clearPaneAgentSession(paneId as PaneId, 'verdict')
        // The offer belonged to the agent that just died. Leaving it up would ask the user
        // to sign a CLI in that is no longer running, into a shell that would reject the
        // slash command it was built for.
        dismissSignInBanner(paneId)
        // Same honesty for a standing profile-switch OFFER: the capped agent it was
        // about is gone. A 'switching' overlay stays — this verdict IS its success
        // signal mid-flight, and the flow settles it itself.
        if (getPaneFailoverOffer(paneId as PaneId)?.state === 'offered') setPaneFailoverOffer(paneId as PaneId, null)
        // ...and drop our ownership mark with it, so the level-triggered
        // reconcile cannot resurrect an offer about an agent that is gone.
        cappedRaised.delete(paneId)
        return
      }
      // ONE stamp for this verdict and for any session it writes below — see writeSession.
      const at = Date.now()
      detectedAt.set(paneId, at)
      noteAgentPresent(paneId) // an interrupt started later must wait for a REAL exit

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
      // Detection's `sinceMs` is the agent PROCESS's start (creation time where the platform
      // reports it): the true floor for the context-log watch. It refines an existing session
      // in two honest cases — the session never had one (an adopted pane's 30-minute guess, a
      // launch's 5-second slack), or the process it named is a DIFFERENT one (an in-pane
      // relaunch the cwd cannot betray). The jitter gate keeps the platforms whose floor is
      // re-derived per snapshot from re-watching a live gauge over rounding noise.
      const sinceRefined = (s: { since?: number }): boolean =>
        typeof ev.sinceMs === 'number' && (s.since === undefined || Math.abs(s.since - ev.sinceMs) > 30_000)
      if (existing && existing.provider === ev.agentId && !existing.detected) {
        if (!existing.running || sinceRefined(existing)) {
          writeSession(paneId, { ...existing, running: true, since: sinceRefined(existing) ? ev.sinceMs : existing.since }, at)
        }
        return
      }
      // Process cwd is the session-log identity for a hand-typed CLI. Canonical live cwd comes
      // only through the source-aware terminal cwd stream; writing it here was a competing,
      // unrevisioned path that could roll an explicit report back to an older process snapshot.
      const cwd = ev.cwd || getPaneCwd(paneId as PaneId) || ''
      // Same provider, same cwd, same process floor: the same session, no news. A materially
      // different sinceMs is a RELAUNCH the cwd cannot show (claude quit, claude typed again in
      // the same repo) — fall through and write the new session, so the context watch re-locks
      // with the new process's true floor instead of trailing the dead session's log.
      if (existing && existing.provider === ev.agentId && existing.cwd === cwd && !sinceRefined(existing)) return

      // A profile's env pointers are `set`/`export`ed INTO the pane's shell (see the launch
      // builder), so they outlive the agent that was launched with them: a CLI re-typed in
      // that pane runs under the same profile, and its config home must resolve the same way
      // — otherwise the bar looks for the session log under the default home and finds none.
      const prior = launchCtx(paneId)
      // No prior context for this provider means nobody recorded an account —
      // which is UNKNOWN, not "the default". This used to resolve to
      // `undefined`, and `lastLaunch` is rebuilt empty on every renderer boot,
      // so after a restart every detected pane read as the order-0 lane.
      const profile =
        prior?.provider === ev.agentId
          ? prior.profile
          : resolveAdoptedProfile(undefined, profilesFor(cachedProfiles, ev.agentId))
      const profileId = profileIdOf(profile)

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
      setLaunchCtx(paneId, { provider: ev.agentId, cwd: failoverCwd, profile }) // failover works here too
      // Record what we resolved — including "we don't know". A hand-typed CLI's
      // slot must say `null` rather than inherit whatever the last agent left.
      announcePaneProfile({ paneId: paneId as PaneId, provider: ev.agentId, profile })
      setPaneLabel(paneId as PaneId, nameById.get(ev.agentId) ?? ev.agentId)
      const cli = PROVIDER_CLI[ev.agentId]
      if (cli) recordPaneCli(paneId, cli) // the pane's MCP chip, same as a launched agent
      // Provider id only — never the command the user typed (ADR 0005/0002).
      getTelemetry().captureEvent({ name: 'agent.detected', props: { provider: ev.agentId } })
      // A DETECTED agent was not launched by the app, so it may carry no bell config at all
      // — a verdict-mute pane that works whole turns wearing a resting dot (found live
      // 2026-07-16). If that CLI's global alerts aren't wired (and the user never removed
      // them), wire them now and say so — the ask-toast this replaces never converted.
      void autoWireGlobalHooks(ev.agentId)

      if (!profileId) {
        setPaneProfile(paneId as PaneId, undefined) // a previous launch's note is not this agent's
        return
      }
      const name = (await listProfiles()).find((p) => p.id === profileId)?.name
      // The pane may have moved on while we asked (the agent quit, another CLI started):
      // only note the profile if this session is still the one running.
      if (getPaneAgentSession(paneId as PaneId)?.profileId === profileId) setPaneProfile(paneId as PaneId, name)
    }

    /** AUTO-WIRE a detected provider's global alerts, once per provider per app run.
     *
     *  A hand-typed agent carries none of the session-scoped bell config a launch rides, so
     *  without the global wiring its pane is verdict-mute: the dot sits hollow through whole
     *  turns — a working agent wearing "cannot tell you", forever. This used to be an
     *  ask-toast, and the ask demonstrably failed: one transient nudge per app run, shown
     *  while the user watches some other pane — found live 2026-07-18 as eight hand-typed
     *  claude sessions (wizard-adjacent isolated-worktree terminals) all running with dead
     *  status dots and nothing wired. Detection is the moment the app KNOWS the user runs
     *  this CLI in its panes, so it wires the alerts then and says so, instead of asking and
     *  expiring. The write is the same guarded mutation Settings performs (backup, atomic,
     *  additive merge); wiring is a silent no-op outside app panes (global-hooks.ts).
     *
     *  The brakes, in order: a CONFLICT (the user's own codex notify, say) is their
     *  deliberate config — status never reads not-applied, nothing is touched. An explicit
     *  REMOVE (Settings, or the toast's Undo) persists an opt-out (`autoWire: false`) that
     *  detection honors forever after. And the already-running session cannot re-read its
     *  config — the wiring speaks from each agent's next launch — so the toast says so. */
    const hooksAutoWired = new Set<string>()
    const HOOK_NUDGE_LABEL: Record<string, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', opencode: 'OpenCode' }
    async function autoWireGlobalHooks(providerId: string): Promise<void> {
      const label = HOOK_NUDGE_LABEL[providerId]
      if (!label || hooksAutoWired.has(providerId)) return
      hooksAutoWired.add(providerId)
      try {
        const status = (await getBridge().invoke(AgentHookChannels.status)) as GlobalHooksStatus
        const row = status?.find?.((r) => r.provider === providerId)
        if (!row || (row.state !== 'not-applied' && row.state !== 'partial')) return
        if (row.autoWire === false) return // they removed it once; their no stands
        const result = (await getBridge().invoke(AgentHookChannels.apply, { provider: providerId })) as GlobalHooksMutationResult
        if (result?.ok) {
          showToast({
            tone: 'success',
            title: `${label} alerts wired globally`,
            body: `Hand-typed ${label} sessions now ring their pane and drive its status dot — this one from its next launch. Review or remove in Settings › Notifications.`,
            action: {
              label: 'Undo',
              onClick: () => {
                void (getBridge().invoke(AgentHookChannels.remove, { provider: providerId }) as Promise<GlobalHooksMutationResult>).then((undone) => {
                  if (undone?.ok) showToast({ title: `${label} alert wiring removed`, body: 'It will not be re-applied automatically.' })
                  else showToast({ tone: 'attention', title: 'Nothing was removed', body: undone?.reason })
                })
              }
            }
          })
        } else {
          // The write refused (changed under us, unwritable file): fall back to saying why,
          // with the manual path — never retry silently against a refusing file.
          showToast({
            tone: 'attention',
            title: `Hand-typed ${label} sessions have no alerts`,
            body: `${result?.reason ?? 'The wiring could not be applied.'} — Settings › Notifications to wire them by hand.`
          })
        }
      } catch {
        /* the auto-wire is a courtesy — never a failure surface */
      }
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
      cachedProfiles = profiles
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
      // Manual pane-scoped profile switch (the escape hatch when limit detection
      // misses, and the "move this session to my other account" verb): one command
      // per OTHER profile of a multi-profile provider. Same interrupt → exact-resume
      // flow as the failover; the global default is deliberately NOT touched. The
      // pane ⋯ menu picks these up by hint + id prefix (its no-imports law).
      const switchCommands = installed.flatMap((a) => {
        const mine = profiles.filter((p) => p.provider === a.id).sort((x, y) => x.order - y.order)
        if (mine.length < 2) return []
        return mine.map((p) => ({
          id: `agent:switch:${a.id}:${p.id}`,
          title: `Switch focused pane to ${p.name} (resume session)`,
          hint: 'Switch profile',
          run: () => switchFocusedPane(a.id, p)
        }))
      })
      setCommands('agents-switch', switchCommands)
      publishFailoverCommand()
    }

    /** The manual switch's entry point: resolve the FOCUSED pane's launch context and
     *  hand it to the one switch flow. Honest no-ops when the pane isn't running that
     *  provider — a switch command must never relaunch a provider into a plain shell. */
    function switchFocusedPane(provider: string, profile: { id: string; name: string }): void {
      const focus = getFocusedPane()
      if (!focus) return
      const ctx = launchCtx(focus.paneId)
      if (!ctx || ctx.provider !== provider) {
        showToast({
          tone: 'attention',
          title: `No ${nameById.get(provider) ?? provider} session in the focused pane`,
          body: 'Switch profile continues a running session — launch the agent first.'
        })
        return
      }
      // No order-0 fallback here: under `unknown` this is undefined, so the
      // "already runs X" no-op cannot fire and the switch PROCEEDS. That is
      // right — the user asked for it explicitly, and switchPaneProfile
      // interrupts and resumes under a named profile whatever came before.
      // Worst case is one redundant interrupt onto the same account.
      const current = profileIdOf(ctx.profile)
      if (current === profile.id) {
        showToast({ tone: 'info', title: `Pane ${focus.paneId} already runs ${profile.name}` })
        return
      }
      void switchPaneProfile(focus.paneId, ctx.provider, ctx.cwd, profile, 'manual')
    }

    /** The auto-failover palette entry, STATE-BEARING (audit F6: the old title never
     *  said which way the toggle sat — you had to flip it to learn it). Republished on
     *  toggle and on workspace switch, because the title names the ACTIVE workspace's
     *  state. */
    function publishFailoverCommand(): void {
      const on = !!autoFailover.get(getWorkspaces().activeId ?? '')
      setCommands('agents-failover', [
        {
          id: 'agents:auto-failover',
          title: `Auto-failover: ${on ? 'ON' : 'OFF'} for this workspace — turn ${on ? 'off' : 'on'}`,
          hint: 'Profiles',
          run: () => void toggleAutoFailover()
        }
      ])
    }

    /** Persisted per workspace (agents.autoFailover.<wsId>, audit F6) — the overnight-run
     *  mode must survive a restart. The write's {ok} is OBEYED: an unsaved toggle that
     *  slid over anyway is the browser-dock consent bug reborn. */
    async function toggleAutoFailover(): Promise<void> {
      const wsId = getWorkspaces().activeId
      if (!wsId) return
      const next = !autoFailover.get(wsId)
      let ok = false
      try {
        ok = ((await getBridge().invoke(AgentChannels.failoverSet, { workspaceId: wsId, on: next })) as { ok?: boolean })?.ok === true
      } catch {
        ok = false
      }
      if (!ok) {
        showToast({ tone: 'danger', title: 'Auto-failover was not changed', body: 'The setting could not be saved.' })
        return
      }
      autoFailover.set(wsId, next)
      publishFailoverCommand()
      showToast({ tone: 'info', title: `Auto-failover ${next ? 'ON' : 'OFF'} for this workspace` })
    }

    /** Fill the cache for a workspace whose persisted state we have not read yet.
     *  The cache is only ever a mirror of the store — the store decides. */
    async function hydrateAutoFailover(wsId: string): Promise<void> {
      if (autoFailover.has(wsId)) return
      try {
        autoFailover.set(wsId, (await getBridge().invoke(AgentChannels.failoverGet, wsId)) === true)
      } catch {
        /* unreadable — leave unset; the reader treats that as OFF */
      }
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

    /** Resolve the profile + build the launch command — the main round trips of a local
     *  CLI launch, factored out so a fresh launch can start them WHILE the shell is still
     *  booting (the pane-live wait and the command build overlap instead of queuing).
     *  Never rejects: a prefetch settles into a refused result, not an unhandled
     *  rejection racing the liveness waiter. */
    async function prepareCliLaunch(
      paneId: number,
      provider: AgentCliId,
      cwd: string,
      resume: boolean,
      profileId: string | undefined,
      remoteHostId: string | undefined,
      remote: boolean,
      opts?: {
        /** false = a build that may still be DISCARDED (the adopt branch, a failed
         *  interrupt): main defers the one-shots, the restore intent and the session
         *  declaration until `commandCommit` says the command was really typed. */
        consume?: boolean
      }
    ): Promise<{ mine: AgentProfile[]; profile: PaneProfile; workspaceId?: string; result: AgentCommandResult }> {
      // Default profile (order 0) applies when none was named and any exist (4/04).
      let mine: AgentProfile[] = []
      // A launch is ABOUT to choose, so it always knows: `named` or `none`. If
      // listing the profiles throws we know nothing yet — and a failed list is
      // `unknown` by definition, never a silent "no profile".
      let profile: PaneProfile = profileId ? namedProfile(profileId) : UNKNOWN_PROFILE
      const workspaceId = workspaceIdForPane(paneId)
      try {
        mine = profilesFor(await listProfiles(), provider)
        profile = resolveLaunchProfile(profileId, mine)
        const result = await agentsClient.command({
          agentId: provider,
          cwd,
          resume,
          profileId: profileIdOf(profile),
          workspaceId,
          // Names the pane so a cross-profile resume can continue its EXACT session
          // (main reads the context monitor's lock — ADR 0013). Id only.
          paneId,
          // Both facts main-side needs: WHICH saved host to build for, and that the command
          // is typed into the POSIX shell on the far side of SSH.
          remoteHostId,
          remote,
          ...(opts?.consume === false ? { consume: false } : {})
        })
        return { mine, profile, workspaceId, result }
      } catch {
        return { mine, profile, workspaceId, result: { ok: false } }
      }
    }

    /** The one launch path: build the command (never a credential — ADR 0002), write it into
     *  the pane, label the pane. `shell` is a no-op (the pane is already a shell). A
     *  `custom:<command>` provider (wizard custom row) writes the user's own command verbatim. */
    async function launchInPane(
      paneId: number,
      provider: string,
      cwd: string,
      resume = false,
      profileId?: string,
      opts?: {
        /** The caller has PROVEN the pane's agent is gone (profile switch: interrupt +
         *  agent-gone verdict) — skip the reattach adopt branch and really type. The
         *  detector's clear can lag the verdict this caller already awaited. */
        forceType?: boolean
        /** A build the caller already started (with `consume: false`) so it could run
         *  alongside something else — the switch's interrupt, most of all. */
        prefetched?: ReturnType<typeof prepareCliLaunch>
        /** Handed the "is this agent usable yet" promise at the instant the launch command
         *  is typed — the one moment a waiter can be registered without a race. A caller
         *  running its OWN overlay (the profile switch) awaits this instead of guessing
         *  with a timer. Never called when nothing is typed (the adopt branch, a refusal). */
        onReady?: (ready: Promise<boolean>) => void
      }
    ): Promise<void> {
      if (paneId < 0 || !provider || provider === 'shell') return
      const remoteTarget = getPaneRemote(paneId as PaneId)
      const remote = !!remoteTarget
      const custom = provider.startsWith('custom:')
      // PREFETCH: the command build is pure main-side work — profile resolution, config
      // reconciliation, session pooling — none of which needs the pane's shell. Started
      // here, it runs concurrently with the waits below, so by the first prompt byte the
      // command is (usually) already in hand and the write lands immediately.
      //
      // RESUME launches prefetch too now. They could not before for one honest reason:
      // building CONSUMED things a launch that never types must not spend (the one-shot
      // config overrides, the restore shelf's exact-session intent) and it CLEARED the
      // pane's session declaration — and a resume may still adopt a reattached agent and
      // type nothing at all. `consume: false` splits those effects off; they are claimed
      // by `commandCommit` at the moment the command is really typed, and a discarded
      // prefetch simply never claims them. Remote launches still skip it: the far-side
      // dialect ride is cheap and the SSH wait dwarfs it.
      const prefetched =
        opts?.prefetched ??
        (!remote && !custom && isAgentCliId(provider)
          ? prepareCliLaunch(paneId, provider, cwd, resume, profileId, undefined, false, resume ? { consume: false } : undefined)
          : null)
      // THE COVER goes up HERE for a fresh launch — at the commitment, before the pane has
      // even produced a prompt. Everything below (the liveness wait, the build, the typed
      // command itself) is machinery the user did not ask to watch, and raising it at the
      // write instead meant they watched the shell prompt appear and the `claude …` line
      // get typed into it. `cancel()` on every path that ends up typing nothing.
      //
      // A RESUME launch is deliberately NOT covered yet: it may still adopt a reattached
      // agent below, and covering that pane would block input to a LIVING conversation for
      // the length of the spawn-settled wait. Its cover goes up once the adopt branch has
      // been passed and typing is certain.
      // THE PANE THIS LAUNCH IS FOR. A pane id is a slot number, not an identity: close a
      // pane mid-launch and the next split can re-mint the id, so a command already in
      // flight would be typed into a stranger — a full `cd … && claude …` line landing in
      // whatever that pane was doing, which would then wear the dead launch's agent chip
      // and have its own cover torn down. Every wait below (liveness, spawn-settled, the
      // build) is a window for that. Same guard, and the same reason, as the board's
      // card hand-off. An `undefined` capture means the pane has not mounted its xterm
      // yet — a workspace opening behind the board view — and must still proceed.
      const bornAs = paneInstance(paneId as PaneId)
      const samePane = (): boolean => bornAs === undefined || paneInstance(paneId as PaneId) === bornAs
      let cover: LaunchCover = NO_LAUNCH_COVER
      const raiseCover = (): void => {
        cover = beginLaunchCover(paneId, provider, remote, nameById.get(provider) ?? provider)
      }
      if (!resume) raiseCover()
      // A write raced into a still-spawning PTY is dropped by the daemon — wait for the
      // pane's first output (bounded; on timeout proceed, matching the old fixed-delay
      // behavior). Found by the Linux CI sweep: slow machines lost template-lineup launches.
      // Remote output may instead be an SSH password/host-key prompt, so only the
      // bootstrap's live cwd report proves the far-side shell is ready. Keep remote intent
      // queued through arbitrarily slow password, MFA, or host-key confirmation; pane
      // disposal cancels the waiter and still fails closed.
      const ready = remote ? await whenPaneRemoteReady(paneId) : await whenPaneLive(paneId, 15000)
      if (remote && !ready) {
        cover.cancel()
        showToast({
          tone: 'danger',
          title: `Remote agent was not started in pane ${paneId}`,
          body: 'SSH did not reach the remote shell. Finish or cancel the host-key/password prompt, then launch the agent again.'
        })
        return
      }
      // The reattach verdict rides the SPAWN REPLY, which lands after the first output on
      // a daemon reattach (scrollback replays first) — so "live" alone cannot authorize a
      // resume decision. Wait for the verdict explicitly; the fixed 900ms lineup delay
      // that used to paper over this ordering is gone.
      if (resume && !remote) await whenPaneSpawnSettled(paneId, 15000)
      // RESTORE into a pane the daemon never let die. The PTY outlives the app (ADR 0006),
      // so on the next launch the pane reattaches to a session whose agent is still running
      // — and typing `claude --resume` there does not relaunch it, it types the words into
      // the running agent's prompt. Adopt the session instead: label it, claim its CLI for
      // the MCP chip, launch nothing. A fresh spawn (cold daemon) reports existing=false
      // and takes the normal path below.
      if (resume && wasPaneReattached(paneId) && !opts?.forceType) {
        cover.cancel() // inert on this branch today (a resume raises no cover before here) — kept so it stays true if that ever changes
        const label = custom
          ? provider.slice('custom:'.length).trim().split(/\s+/)[0] || 'custom'
          : (nameById.get(provider) ?? provider)
        setPaneLabel(paneId as PaneId, label)
        const reCli = PROVIDER_CLI[provider]
        if (reCli) recordPaneCli(paneId, reCli)
        // The adopted agent launched under SOME profile, and the recorded slot is
        // the only thing that knows which. The context watch resolves the CONFIG
        // HOME from that id (CLAUDE_CONFIG_DIR et al.), so adopting without it
        // pointed the session-log matcher at the default home and any profile
        // with a relocated home lost its context bar on every restart.
        //
        // But this branch READS a process it did not start — it is not "the same
        // resolution a fresh launch applies", which is what it used to claim. A
        // fresh launch is about to CHOOSE; an adopt can only report. When the
        // slot is blank the honest answer is `unknown`, and stamping order-0
        // here is what made every restored pane match the cdev lane at once.
        const mine = custom ? [] : profilesFor(await listProfiles(), provider)
        const adopted = resolveAdoptedProfile(profileId, mine)
        projectLaunchCwd(paneId, cwd)
        setPaneProfile(paneId as PaneId, mine.find((p) => p.id === profileIdOf(adopted))?.name)
        // Context bar: the adopted session predates this app run, so the log
        // matcher may look back in time (agent-session port -> context feature).
        writeSession(paneId, { provider, cwd, profileId: profileIdOf(adopted), adopted: true })
        // The failover context, which an adopted pane never had: a usage limit in a pane
        // whose agent survived a restart could not offer the next profile, because nothing
        // remembered what was running in it.
        setLaunchCtx(paneId, { provider, cwd, profile: adopted })
        announcePaneProfile({ paneId: paneId as PaneId, provider, profile: adopted })
        return
      }
      // Past the adopt branch a resume WILL type: raise its cover now, so the build and
      // the write are hidden even though the reattach verdict had to come first.
      if (resume) raiseCover()
      if (custom) {
        cover.cancel() // a custom command is not a provider with a readiness signal
        const cmd = provider.slice('custom:'.length).trim()
        if (!cmd) return
        agentsClient.launchInto(paneId, cmd)
        recordCustomLaunch(paneId, provider, cmd, cwd, resume)
        return
      }
      if (!isAgentCliId(provider)) {
        cover.cancel()
        return
      }
      // The prefetched build (started before the liveness wait) — or, on the remote path
      // that must not prefetch, the same build strictly ordered here.
      let prep = await (prefetched ?? prepareCliLaunch(paneId, provider, cwd, resume, profileId, remoteTarget?.hostId, remote))
      // A deferred build is about to become a real launch: claim its effects BEFORE the
      // command is typed, so the pane's session declaration is in place before the CLI
      // writes its first log line. A commit that finds nothing pending (the build was
      // never deferred, or it aged out behind a long wait) is not an error — rebuild it
      // the consuming way rather than type a command whose one-shots nobody claimed.
      if (prep.result.ok && prep.result.command && resume && !remote) {
        const committed = await agentsClient
          .commandCommit({ agentId: provider, paneId, workspaceId: prep.workspaceId })
          .catch(() => ({ ok: false }))
        if (!committed.ok) {
          // Local by construction here (`!remote`), so no host to name.
          prep = await prepareCliLaunch(paneId, provider, cwd, resume, profileId, undefined, false)
        }
      }
      const { mine, profile: launchProfile, workspaceId, result } = prep
      if (!result.ok || !result.command) {
        cover.cancel() // nothing will be typed — never leave the pane blurred over a failure
        showToast({
          tone: 'danger',
          title: `Agent was not launched in pane ${paneId}`,
          body: result.reason || 'The saved configuration could not be synchronized before launch.'
        })
        return
      }
      // Last check before the bytes go out: the pane that asked for this launch is still
      // the pane sitting on this id.
      if (!samePane()) {
        cover.cancel()
        return
      }
      agentsClient.launchInto(paneId, result.command)
      recordCliLaunch(paneId, provider, cwd, resume, { mine, profile: launchProfile, workspaceId, result })
      // Hold the cover until the agent is genuinely usable, then lift it — on the agent's
      // word OR on the ceiling, because a cover that can outlive its own failure mode is a
      // trap rather than a cover.
      cover.settle()
      if (cover.ready) opts?.onReady?.(cover.ready)
    }

    /** Everything a successful CLI launch records — shared by typed delivery (right after
     *  the write) and spawn-run delivery (the backend already typed it at spawn). Pure
     *  bookkeeping: no waits, no writes into the pane. */
    function recordCliLaunch(
      paneId: number,
      provider: string,
      cwd: string,
      resume: boolean,
      prep: { mine: AgentProfile[]; profile: PaneProfile; workspaceId?: string; result: AgentCommandResult }
    ): void {
      const { mine, profile, workspaceId, result } = prep
      projectLaunchCwd(paneId, cwd)
      // The profile's email is a label the app cannot enforce — the CLI's OAuth
      // lands on whatever account the browser offers. Main checked the launch
      // home; say what it found while the sign-in (or the mixup) is on screen.
      if (result.signIn) {
        const profileName = mine.find((p) => p.id === profileIdOf(profile))?.name
        showToast(
          result.signIn.actual
            ? {
                tone: 'attention',
                title: `Pane ${paneId} is signed in as ${result.signIn.actual}`,
                body: `The “${profileName ?? 'selected'}” profile expects ${result.signIn.expected}. Run /login in that pane to switch accounts, or edit the profile's email in Settings.`
              }
            : {
                tone: 'info',
                title: `Sign in to set up “${profileName ?? provider}”`,
                body: `When the browser opens, pick ${result.signIn.expected} — this profile should run under that account.`
              }
        )
      }
      // THE SIGN-IN OFFER. Setup installs; this is where being signed in gets handled —
      // the first moment a terminal exists to do it in. Only ever raised on a CHECKED
      // signed-out home (main returns nothing when the answer is unknowable), and it
      // types the provider's own verb on click and nothing before that (ADR 0002).
      //
      // Deferred past the launch write: the CLI is starting up in this same instant, and
      // a banner that appears before its first frame reads as a complaint about a pane
      // that has not spoken yet.
      if (result.needsSignIn) {
        const target = result.needsSignIn
        setTimeout(() => offerSignIn(paneId, target, true), 1200)
      }
      // Remember the tool-plan signature this pane launched with (8/09) — a
      // later plan edit flips it to restart-needed.
      if (workspaceId) {
        void (getBridge().invoke(IntegrationsChannels.planGet, workspaceId) as Promise<WorkspaceToolPlan>)
          .then((plan) => recordPaneLaunch(paneId, workspaceId, planSignature(plan)))
          .catch(() => undefined)
      }
      setLaunchCtx(paneId, { provider, cwd, profile })
      // The RESOLVED profile, announced so the manifest records a fact. The slot
      // used to be written from the launch REQUEST, where an omitted profile
      // means "use the default" — a statement about a request, not about an
      // account. Persisting it as one is why every restore re-derived order-0.
      announcePaneProfile({ paneId: paneId as PaneId, provider, profile })
      if (typeof result.buildMs === 'number') lastBuildMs = result.buildMs
      // Propagate MCP status to this pane's header (8/11): record its CLI +
      // the connected count it launched with (for the restart nudge).
      const cli = PROVIDER_CLI[provider]
      if (cli) recordPaneCli(paneId, cli)
      // Pane-meta carries the profile NAME only (⋯ menu note, 6/04) — never env.
      // A deleted/unknown id resolves to no name: the note simply disappears.
      setPaneProfile(paneId as PaneId, mine.find((p) => p.id === profileIdOf(profile))?.name)
      // Context bar: LAUNCH cwd + profile ID (the id names the config home main-side;
      // env values never ride the port — ADR 0002).
      writeSession(paneId, { provider, cwd, profileId: profileIdOf(profile) })
      // FOLDER TRUST, the way claude itself records it. Opening a workspace at a folder
      // IS the trust declaration (product decision), and claude's own mechanism for
      // saying so is `projects["<cwd>"].hasTrustDialogAccepted` in its state file — which
      // main already writes on every local launch and reports back as `trustPrepared`.
      // Where that succeeded there is no dialog to answer: the gate is settled the moment
      // the launch is typed.
      //
      // So the buffer WATCHER is now a belt, not the mechanism — and it only runs where
      // the carry could not reach. It used to run unconditionally, scraping the pane's
      // text every 400ms for 45 seconds and holding an auto-submitted prompt behind a
      // nine-second dialog-free settle, on launches where the state file already proved
      // the dialog could not paint. That is a poll standing in for a fact the app had
      // written itself.
      //
      // The belt still earns its place in the three cases the carry cannot cover: a
      // REMOTE claude (the state file resolves against the local home, so another
      // machine's is unreachable), a first launch whose new entry is keyed in a different
      // path form than claude's own process uses, and a carry that failed and honestly
      // said so. All three arrive here as `trustPrepared` falsy.
      //
      // Ordering note for the belt path: it must come AFTER the session write, because the
      // watcher's launch-died check reads the session port — called earlier it died on its
      // first look and marked the gate settled with the dialog still coming (found live:
      // the switch overlay sat on an unanswered dialog for its whole hold).
      if (provider === 'claude') {
        if (result.trustPrepared) markTrustPrepared(paneId)
        else void autoTrustClaudeLaunch(paneId)
      }
      setPaneLabel(paneId as PaneId, nameById.get(provider) ?? provider)
      // Booleans/ids only — never env values or command text (ADR 0005).
      getTelemetry().captureEvent({ name: 'agent.launched', props: { provider, resume, profiled: profile.kind === 'named' } })
    }

    /** The custom-command twin of recordCliLaunch (wizard custom row — ADR 0005/0002:
     *  the provider id is `custom:<command>`; telemetry never carries the command text). */
    function recordCustomLaunch(paneId: number, provider: string, cmd: string, cwd: string, resume: boolean): void {
      projectLaunchCwd(paneId, cwd)
      setPaneLabel(paneId as PaneId, cmd.split(/\s+/)[0] || 'custom')
      // Published even though unsupported: it CLEARS any previous agent's context
      // bar in this pane (the context feature filters non-context providers).
      writeSession(paneId, { provider, cwd })
      // A custom command takes the slot over from whatever profiled agent was
      // there. Blank the recorded profile, or restore relaunches carrying a
      // profile id that describes nothing running.
      announcePaneProfile({ paneId: paneId as PaneId, provider, profile: NO_PROFILE })
      getTelemetry().captureEvent({ name: 'agent.launched', props: { provider: 'custom', resume } })
    }

    /** DEV-only build stretch (LAUNCHNOW gate): pushes the spawn-run build past the
     *  pane's claim window to prove the typed fallback delivers exactly once. */
    let spawnRunHoldMs = 0

    /**
     * Spawn-run delivery (instant launch, part 2): a fresh template/wizard slot whose
     * request arrives BEFORE its pane exists. Arm the command build on the spawn-run
     * port synchronously — the pane's spawn claims it and the backend types it as the
     * shell's first act — then settle on the pane's REPORT:
     *   delivered      → bookkeeping only (the command is already executing);
     *   anything else  → the typed fallback, which is exactly the pre-spawn-run launch
     *     path (wait for the first output, write the SAME already-built command — the
     *     build ran once, so one-shot config overrides are never double-consumed).
     * A pane that never reports (disposed mid-open) times out to the fallback, whose
     * own bounded liveness wait keeps the old behavior as the floor.
     */
    function spawnDeliver(req: AgentLaunchRequest): void {
      const paneId = Number(req.paneId)
      const { provider, cwd } = req
      if (paneId < 0 || !provider || provider === 'shell') return
      const custom = provider.startsWith('custom:')
      const customCmd = custom ? provider.slice('custom:'.length).trim() : ''
      if (custom && !customCmd) return
      if (!custom && !isAgentCliId(provider)) return
      const prep = custom || !isAgentCliId(provider)
        ? null
        : prepareCliLaunch(paneId, provider, cwd, false, req.profileId, undefined, false)
      let build: Promise<string | null> = custom
        ? Promise.resolve(customCmd)
        : prep!.then((p) => (p.result.ok && p.result.command ? p.result.command : null))
      if (import.meta.env.DEV && spawnRunHoldMs > 0) {
        const ms = spawnRunHoldMs
        build = new Promise<void>((r) => setTimeout(r, ms)).then(() => build)
      }
      // THE COVER, before the pane even exists. This path hands the command to the DAEMON,
      // which types it as the shell's very first act — so there is no later moment to
      // raise it at, and raising it here is also what makes the pane paint covered the
      // instant it mounts (the offer port replays on subscribe). This is the path a
      // wizard/template open takes, and it shipped uncovered: the whole boot, prompt and
      // injected command line included, played out in the open.
      const cover = beginLaunchCover(paneId, provider, false, nameById.get(provider) ?? provider)
      armSpawnRun(paneId, build)
      // The whole delivery runs under a catch that GIVES THE PANE BACK. A cover is removed
      // only by settle/cancel, so anything that throws between the raise and them — a
      // subscriber blowing up inside recordCliLaunch's fan-out, a rejected build — would
      // strand a pane blurred and refusing input, with no button on the overlay and no way
      // out but closing it. The ceiling bounds the promise, not the overlay; this is what
      // bounds the overlay against a throw.
      void (async () => {
        const outcome = await whenSpawnRunOutcome(paneId, 20000)
        if (custom) {
          cover.cancel() // a custom command is not a provider with a readiness signal
          if (outcome !== true) {
            // Typed fallback: the pane spawned without the run (late build, reattach,
            // spawn failure) — deliver the pre-spawn-run way.
            await whenPaneLive(paneId, 15000)
            agentsClient.launchInto(paneId, customCmd)
          }
          recordCustomLaunch(paneId, provider, customCmd, cwd, false)
          return
        }
        const p = await prep!
        if (!p.result.ok || !p.result.command) {
          cover.cancel() // nothing to launch — the pane is the user's again immediately
          showToast({
            tone: 'danger',
            title: `Agent was not launched in pane ${paneId}`,
            body: p.result.reason || 'The saved configuration could not be synchronized before launch.'
          })
          return
        }
        if (outcome !== true) {
          await whenPaneLive(paneId, 15000)
          agentsClient.launchInto(paneId, p.result.command)
        }
        recordCliLaunch(paneId, provider, cwd, false, p)
        // Both arms end here: the daemon typed it at spawn, or the fallback just did.
        cover.settle()
      })().catch(() => cover.cancel())
    }

    /**
     * THE pane profile switch — usage-limit failover (auto or accepted offer) and the
     * manual pane action are the same flow: prove the capped CLI is GONE (the
     * deterministic interrupt, F2 — never type into a running agent), rewrite the
     * slot's manifest, then relaunch in the SAME pane/cwd with resume — main-side
     * session pooling + exact-session id (ADR 0013) make the new profile continue the
     * conversation. The overlay narrates; failure leaves the pane untouched.
     */
    async function switchPaneProfile(
      paneId: number,
      provider: string,
      cwd: string,
      next: { id: string; name: string },
      trigger: 'capped' | 'notify' | 'manual'
    ): Promise<void> {
      if (failingOver.has(paneId)) return
      failingOver.add(paneId)
      resetSwitchTrace(paneId)
      setPaneFailoverOffer(paneId as PaneId, { state: 'switching', title: '', nextName: next.name })
      try {
        // The build is NOT started here, and that is deliberate. Overlapping it with the
        // interrupt looks free — different concerns, one main-side, one keystrokes — but
        // main is single-threaded and is also the process that relays the process-table
        // verdict this interrupt is waiting for. Measured: with the build running
        // alongside, the agent-gone verdict took 9.6s instead of ~1s, because the
        // interrupt's 3s waits kept expiring while main was busy in the build's
        // synchronous filesystem work. Since the build is now ~free anyway (memoized
        // settings, plan, pooling and state carry), the overlap bought a few ms and cost
        // the interrupt seconds. The launch below prefetches during its OWN waits, which
        // is where a build genuinely has idle time to hide in.
        const gone = await interruptAgent(paneId)
        if (!gone) {
          recordSwitchPhase(paneId, 'failed')
          setPaneFailoverOffer(paneId as PaneId, {
            state: 'failed',
            title: `Couldn't switch to ${next.name}`,
            nextName: next.name,
            message: 'The agent kept running. Press Ctrl+C twice in the pane, then use Switch profile from the ⋯ menu.',
            onDismiss: () => setPaneFailoverOffer(paneId as PaneId, null)
          })
          getTelemetry().captureEvent({ name: 'agent.profileSwitch', props: { provider, trigger, ok: false } })
          return
        }
        // The workspace manifest follows the switch (6/04) — otherwise the next restart
        // resurrects the capped profile. AFTER the interrupt verdict: a failed switch
        // used to rewrite the manifest anyway, promising a profile it never launched.
        announcePaneProfile({ paneId: paneId as PaneId, provider, profile: namedProfile(next.id) })
        // HOLD THE BLUR until the resumed session is really usable: the machinery under
        // it (shell prompt, the typed resume command, the CLI's boot, the auto-answered
        // trust dialog) is not the user's business — they clicked Continue and the next
        // thing they see is their conversation.
        //
        // "Usable" is now the SAME observation every launch uses (launch-readiness.ts):
        // claude's TUI taking the alternate screen, then a clear trust gate. What that
        // replaced is worth naming, because it was the last timer on this path — a
        // `running` process-table check (true a second before the trust dialog even
        // paints) followed by a `max(1000, typed + 5000 - now)` splash FLOOR, tuned by
        // hand because the readiness test underneath it could not be trusted. The floor
        // both delayed switches that were already done and, when the trust carry made a
        // boot unusually fast, still fired the continuation into a TUI that was mid-init
        // (7.9s switch, prompt eaten — found live). One measured signal retires all of it.
        let readyWait: Promise<boolean> | null = null
        await launchInPane(paneId, provider, cwd, true, next.id, {
          forceType: true,
          onReady: (usable) => {
            readyWait = usable
          }
        })
        recordSwitchPhase(paneId, 'typed')
        // Null means nothing was typed (the launch refused) — no agent, so no readiness.
        const ready = readyWait ? await (readyWait as Promise<boolean>) : false
        // EVERY switch exists to keep the WORK going — the interrupt cut a turn either
        // way, so the continuation prompt is submitted into the resumed conversation
        // (still behind the blur) and the agent picks its task back up by itself; the
        // manual switch included (product decision 2026-08-02: choosing a different
        // account mid-session is a request to continue there, not to start over).
        // Only when readiness was actually OBSERVED — typed into an unknown TUI state
        // it would be eaten again. Claude only for now: it is the one provider whose
        // resume is exact-session today.
        if (provider === 'claude' && ready) {
          await typeContinuation(paneId)
          recordSwitchPhase(paneId, 'continued')
          await new Promise((r) => setTimeout(r, 600))
        }
        setPaneFailoverOffer(paneId as PaneId, null)
        recordSwitchPhase(paneId, 'done')
        getTelemetry().captureEvent({ name: 'agent.profileSwitch', props: { provider, trigger, ok: true } })
      } finally {
        failingOver.delete(paneId)
        // AND THE BLUR COMES DOWN, whatever happened. The clear above sits on the success
        // path; the `switching` overlay carries no button by contract (there is nothing
        // useful to offer mid-interrupt), so a throw anywhere between raising it and that
        // line left a pane permanently blurred and refusing input, escapable only by
        // closing it. Clearing here is safe because it only ever removes an overlay this
        // flow still owns — an offer raised by something newer is a different object and
        // the success path already cleared ours.
        const still = getPaneFailoverOffer(paneId as PaneId)
        if (still?.state === 'switching') setPaneFailoverOffer(paneId as PaneId, null)
      }
    }

    /** Bring every pane's usage-limit offer into line with what the lane port
     *  says RIGHT NOW. Idempotent, and safe to call from any input.
     *
     *  This replaces "an alert arrived, so cover the panes". The offer is now a
     *  function of current state, which means three things the event-driven
     *  version could not do: a replayed or stale alert covers nothing, an offer
     *  withdraws itself when its window resets, and launching into a lane that is
     *  ALREADY spent raises the offer immediately instead of waiting for an edge
     *  that fired hours ago. */
    function reconcileCappedOffers(): CappedOfferPlan {
      const snap = getUsageLanes()
      // Keys materialised FIRST: launchCtx evicts a stale entry as it reads it,
      // and mutating the map mid-iteration is how you skip an element.
      const panes: CappedPane[] = []
      for (const id of [...lastLaunch.keys()]) {
        const ctx = launchCtx(id)
        if (!ctx) continue // this pane's id belongs to someone else now
        const mark = cappedRaised.get(id)
        const holdsOurOffer = !!mark && getPaneFailoverOffer(id as PaneId) === mark.offer
        panes.push({
          paneId: id,
          provider: ctx.provider,
          profile: ctx.profile,
          // PRESENCE, never the absence of a verdict: `isPaneLive` only ever meant
          // "this pane's shell has produced output", which is true of a bare
          // prompt whose agent left and of a stranger pane that recycled the id.
          agentPresent: getPaneAgentSession(id as PaneId)?.provider === ctx.provider,
          busy: failingOver.has(id),
          holdsOurOffer,
          ...(holdsOurOffer && mark ? { raisedFor: mark.identity } : {}),
          ...(holdsOurOffer && mark?.lane.resetsAt ? { raisedResetsAt: mark.lane.resetsAt } : {}),
          missStreak: cappedMisses.get(id) ?? 0,
          ...(cappedDismissed.has(id) ? { dismissedFor: cappedDismissed.get(id) } : {})
        })
      }
      const plan = planCappedOffers(panes, snap.capped, snap.known, (providerId) =>
        orderZeroProfileId(cachedProfiles, providerId)
      )
      // Only a pane the planner deliberately HELD keeps a streak; anything it
      // decided about is settled, so its count starts over.
      const held = new Set(plan.holdAmbiguous)
      for (const id of [...cappedMisses.keys()]) if (!held.has(id)) cappedMisses.delete(id)
      for (const id of plan.holdAmbiguous) cappedMisses.set(id, (cappedMisses.get(id) ?? 0) + 1)
      for (const paneId of plan.forget) cappedRaised.delete(paneId)
      for (const paneId of plan.lower) {
        const mark = cappedRaised.get(paneId)
        cappedRaised.delete(paneId)
        // Identity, not a boolean: between the plan and this write the port may be
        // holding someone else's overlay, and clearing blind would destroy it.
        if (mark && getPaneFailoverOffer(paneId as PaneId) === mark.offer) setPaneFailoverOffer(paneId as PaneId, null)
      }
      for (const { paneId, lane } of plan.raise) void offerSwitch(paneId, 'capped', lane)
      return plan
    }

    /** Usage-limit failover (4/04): next profile, same pane, same cwd. ONE hop.
     *  The surface is the pane's own blurred OFFER overlay (failover-offer port) —
     *  auto-failover skips straight to the switching state. */
    async function offerSwitch(paneId: number, trigger: 'capped' | 'notify', lane?: CappedLane): Promise<void> {
      if (failingOver.has(paneId)) return
      const ctx = launchCtx(paneId)
      if (!ctx) return
      const mine = profilesFor(await listProfiles(), ctx.provider)
      const pick = pickFailoverTarget(ctx.profile, mine)
      if (pick.kind === 'too-few') {
        showToast({
          tone: 'attention',
          title: `Usage limit in pane ${paneId}`,
          body: 'Add a second profile in Settings to enable failover.'
        })
        return
      }
      // We could not name the account this pane is on, so we may not move it and
      // we certainly may not put a name on a card. This branch replaces a
      // `Math.max(0, findIndex(...))` clamp that turned "unresolvable" into
      // index 0 — which is where the words "cdev" and "cmain" came from.
      //
      // Sits ABOVE the auto-failover branch on purpose: auto-failover must never
      // switch a pane whose account it could not identify, and here it
      // structurally cannot get the chance.
      if (pick.kind === 'unidentified') {
        showToast({
          tone: 'attention',
          title: `Usage limit in pane ${paneId}`,
          // No action button. One was tried and removed: any button here has to
          // pick a target profile, and picking one is exactly the guess this
          // branch exists to refuse. The ⋯ menu is where the human chooses.
          body: `This pane's account isn't on record, so it was left alone. Relaunch the agent, or use “Switch profile” in the ⋯ menu to move it.`
        })
        return
      }
      const { current: cur, next } = pick
      const doSwitch = (): void => void switchPaneProfile(paneId, ctx.provider, ctx.cwd, next, trigger)
      // The workspace that HOLDS this pane — a moved pane keeps its id, so the old
      // `id / 100` would read the auto-failover setting of the workspace it left.
      // Hydrated on demand: a BACKGROUND workspace's persisted opt-in counts too —
      // the overnight-run case is exactly a workspace nobody has switched to.
      const wsId = workspaceIdForPane(paneId)
      if (wsId) await hydrateAutoFailover(wsId)
      if (wsId && autoFailover.get(wsId)) {
        doSwitch()
        return
      }
      // The card names the window it is actually talking about. Without a lane —
      // the per-pane notify path, which knows a limit was hit but not which
      // window — it keeps the original unqualified sentence rather than
      // inventing one.
      const copy = cappedOfferCopy(cur.name, next.name, lane)
      const offer: PaneFailoverOffer = {
        state: 'offered',
        title: copy.title,
        nextName: next.name,
        ...(copy.message ? { message: copy.message } : {}),
        onAccept: doSwitch,
        onDismiss: () => {
          // Latch WHAT was declined before clearing, so the level-triggered
          // reconcile does not put the same card straight back up.
          if (lane) cappedDismissed.set(paneId, laneIdentity(lane))
          cappedRaised.delete(paneId)
          setPaneFailoverOffer(paneId as PaneId, null)
        }
      }
      if (lane) cappedRaised.set(paneId, { offer, identity: laneIdentity(lane), lane })
      setPaneFailoverOffer(paneId as PaneId, offer)
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
        // Writes THROUGH the persistence IPC (F6) so smokes exercise the real path;
        // resolves the workspace id on success, null on a refused/failed write.
        setAutoFailover: async (on: boolean) => {
          const id = getWorkspaces().activeId
          if (!id) return null
          let ok = false
          try {
            ok = ((await getBridge().invoke(AgentChannels.failoverSet, { workspaceId: id, on })) as { ok?: boolean })?.ok === true
          } catch {
            ok = false
          }
          if (!ok) return null
          autoFailover.set(id, on)
          publishFailoverCommand()
          return id
        },
        getAutoFailover: async (wsId?: string) => {
          const id = wsId ?? getWorkspaces().activeId
          if (!id) return null
          return (await getBridge().invoke(AgentChannels.failoverGet, id)) === true
        },
        // Flattened for the smokes that read `.provider` / `.profileId` off this
        // (PROFILES, PROFSWITCH, TEMPLATE, LAUNCHNOW). `profileKind` is the new
        // fact they could not otherwise see: "no account on record" is different
        // from "the default", and only one of them may be acted on.
        lastLaunch: (paneId: number) => {
          const ctx = launchCtx(paneId)
          return ctx
            ? { provider: ctx.provider, cwd: ctx.cwd, profileId: profileIdOf(ctx.profile), profileKind: ctx.profile.kind }
            : {}
        },
        paneLive: (paneId: number) => isPaneLive(paneId),
        // LAUNCHNOW gate seam: the launch cover's state for a pane, or null when the pane
        // is the user's. The gate polls it to prove a booting agent is covered and then
        // uncovered — the assertion that was missing when spawn-run delivery shipped with
        // no cover at all, in full view of a gate that already drove that exact path.
        paneCover: (paneId: number) => getPaneFailoverOffer(paneId as PaneId)?.state ?? null,
        // First-output timestamp (performance.now) — the LAUNCHNOW gate measures the
        // live→write gap against it to prove lineup commands ride the readiness
        // signal, never a reintroduced fixed delay.
        paneLiveAt: (paneId: number) => paneLiveAt(paneId),
        // LAUNCHNOW gate seam: stretch the spawn-run build past the pane's claim
        // window so the typed fallback is provably exercised. 0 restores normal.
        setSpawnRunHold: (ms: number) => {
          spawnRunHoldMs = Math.max(0, Number(ms) || 0)
        },
        markRemoteReady: (paneId: number) => markPaneRemoteReady(paneId),
        refreshCommands: () => refreshAgentRegistry().then((agents) => populate(agents)),
        // Smoke/dev shim: register an agent session WITHOUT launching (the dot is
        // gated on tracked sessions — smokes driving OSC into plain panes adopt one).
        adopt: (paneId: number, provider = 'claude', cwd = '') =>
          writeSession(paneId, { provider, cwd, adopted: true }),
        // Smoke/dev shim: replay a detection event exactly as the backend sends it, so a
        // gate can prove the whole typed-launch path without a real agent process.
        detected: (ev: AgentDetectedEvent) => onAgentDetected(ev),
        // Smoke/dev shim: drive the profile-note port directly — PLAINMENU proves an
        // OPEN ⋯ menu follows it live (the note resolves async on the detection path).
        profileNote: (paneId: number, name?: string) => setPaneProfile(paneId as PaneId, name),
        session: (paneId: number) => getPaneAgentSession(paneId as PaneId) ?? null,
        // Smoke/dev shim: the compose seam itself (ADR 0018/06 + revision D) — the
        // BRAINRECALL gate's precise byte-budget witness (capture reflows lines).
        compose: (task: string, root: string, anchorWorkspaceId: string) =>
          composeFirstPrompt({ task, root, anchorWorkspaceId }),
        // Smoke/dev shim: the switch ORDER witness (F2) — the gate asserts
        // 'agent-gone' strictly precedes 'typed'. Phases only, never content.
        switchTrace: (paneId: number) => switchTrace(paneId),
        // Smoke/dev shim: the usage engine's capped trigger, driven at the port the
        // real alert path announces on — proves claim → pane offer end to end.
        capped: (ev: { providerId: string; profileId: string }) => announceUsageCapped(ev),
        // Smoke/dev shim (CAPFALSE): WHY a capped nudge did or did not cover a
        // pane. A negative gate that can only see "no card" cannot tell a
        // correctly withheld offer from a feature that silently stopped working,
        // so it reads the evidence the decision was made on.
        cappedState: () => {
          const snap = getUsageLanes()
          return {
            laneKnown: snap.known,
            cappedLanes: [...snap.capped.values()].map((l) => `${l.providerId}/${l.profileId}/${l.windowLabel}`),
            raised: [...cappedRaised.keys()]
          }
        },
        // Smoke/dev shim: put a pane in the daemon-reattached state (F1's precondition)
        // without an app restart over a surviving daemon.
        markReattached: (paneId: number) => markPaneReattached(paneId),
        wasReattached: (paneId: number) => wasPaneReattached(paneId),
        // Smoke/dev shim: the pane's current offer (state + names only) for DOM-free
        // assertions; the overlay itself is asserted in the DOM.
        offer: (paneId: number) => {
          const o = getPaneFailoverOffer(paneId as PaneId)
          return o ? { state: o.state, title: o.title, nextName: o.nextName } : null
        },
        // Smoke/dev shim: which commands a hint currently registers — ids only, the
        // PROFSWITCH gate's diagnosis line when a menu entry it expects is absent.
        commandsFor: (hint: string) => allCommands().filter((c) => c.hint === hint).map((c) => c.id),
        // Smoke/dev shim: main's build wall-ms for the most recent launch — the
        // launch-latency gates' before/after evidence for the pipeline optimizations.
        lastBuildMs: () => lastBuildMs,
        // Smoke/dev shim: the switch hold's three readiness conjuncts, sampled by the
        // gate while the blur is up — the diagnosis line for a skipped continuation.
        readiness: (paneId: number) => ({
          running: getPaneAgentSession(paneId as PaneId)?.running === true,
          trustSettled: isTrustSettled(paneId),
          trustLive: trustDialogLive(readPaneBufferTail(paneId, 14))
        })
      }
    }
  }
}
