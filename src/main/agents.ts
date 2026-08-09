import { ipcMain, type BrowserWindow } from 'electron'
import {
  detectAgents,
  buildLaunchCommand,
  codexTitleArgs,
  InstallService,
  SetupService,
  carryClaudeProjectState,
  claudeStateFileFor,
  poolProviderSessions,
  probeLogin,
  resumeSessionIdFromFile,
  signInTarget
} from '@backend/features/agents'
import { claudeProjectDirName, findClaudeProjectDir } from '@backend/features/context'
import { resolveHome } from '@backend/features/usage'
import { HOME_POINTER } from '@backend/features/usage/homes'
import { AgentChannels, LAUNCH_INTENT_VERSION, normalizeLaunchIntent, type AgentCliId, type AgentCommandCommitRequest, type AgentCommandCommitResult, type AgentCommandRequest, type AgentCommandResult, type AgentInfo, type AgentProfile, type PaneLaunchIntent } from '@contracts'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getSettingsStore } from './app-settings'
import { notePaneAgent } from './agent-presence'
import { rememberedProfileFor, rememberPaneLaunch } from './pane-launch'
import { maybeFault } from './fault-port'
import { materializeToolPlanAtLaunch, verifyToolPlanForLaunch } from './tool-plan'
import { claudeStatuslineArgs, expectPaneSession, paneSessionLog } from './context'
import { bellLaunchExtras } from './notify-hook'
import { markAgentConfigSessionLaunched, prepareAgentConfigLaunch, refreshAgentSettingsForCli } from './agent-settings'
import { materializeProfileEnv } from './profiles'
import { consumeRestoreResumeSessionId, peekRestoreResumeSessionId } from './session-restore'
import { awaitAgentCapabilities, claudeSupportsSessionId, refreshAgentCapabilities } from './agent-capabilities'
import { assignedSessionFor, newClaudeSessionId, rememberAssignedSession } from './assigned-sessions'

// App-wiring: expose the agent adapters (detect installed CLIs + build a launch command) to
// the renderer. The launch itself is just writing the returned command into a pane
// (terminal:write) — the CLI self-authenticates; NO credentials are handled here (ADR 0002).
// Settings § Providers adds the third verb: install a MISSING CLI in an ephemeral
// background pty (the provider's own one-liner, run on an explicit click).

let installs: InstallService | null = null
let setups: SetupService | null = null
let detectOverride: AgentInfo[] | null = null

/**
 * The composer's input, in the shape that gets persisted with the pane.
 *
 * Built HERE, from the same values that built the command, so the two cannot disagree. It
 * goes through `normalizeLaunchIntent` rather than being asserted: this crosses IPC and
 * then lands in sqlite, and the restore guard that reads it back is built on that same
 * validator. Anything it would refuse must not be minted in the first place.
 */
function launchIntentFor(
  agentId: AgentCliId,
  cwd: string,
  profileId: string | undefined,
  configDir: string | undefined,
  at: number,
  sessionId?: string
): PaneLaunchIntent | undefined {
  return (
    normalizeLaunchIntent({
      v: LAUNCH_INTENT_VERSION,
      agentId,
      cwd,
      profileId,
      configDir,
      sessionId,
      source: 'declared',
      at
    }) ?? undefined
  )
}

/**
 * Effects a PREFETCH build deferred (AgentCommandRequest.consume === false), waiting for
 * the commandCommit that says its command was really typed. A prefetch that is never
 * committed — the pane turned out to be daemon-reattached and adopted the living agent,
 * or the pane died mid-wait — must cost NOTHING: the one-shots stay armed, the restore
 * shelf keeps its intent, the pane keeps whatever session identity it had.
 */
interface PendingLaunchEffects {
  agentId: AgentCliId
  workspaceId?: string
  /** The transcript this launch will append to, or null = clear the declaration. */
  expectedFile: string | null
  /** The claude session id this command NAMES (assigned or resumed) — recorded as the
   *  pane's identity only if the command is really typed. */
  sessionId?: string
  /** The resume id came off the restore shelf — commit spends it there. */
  usedRestoreIntent: boolean
  at: number
}
/** The project dir claude keeps this cwd's transcripts in, under the LAUNCH home. */
function claudeProjectDirFor(profile: AgentProfile | null, cwd: string): string {
  const home = resolveHome('claude', profile)
  return findClaudeProjectDir(home, cwd) ?? join(home, 'projects', claudeProjectDirName(cwd))
}

/** Has claude actually WRITTEN this session? An assigned id names a conversation before
 *  one exists, so this is what separates "continue it" from "there is nothing to continue". */
function claudeTranscriptExists(sessionId: string, profile: AgentProfile | null, cwd: string): boolean {
  try {
    return statSync(join(claudeProjectDirFor(profile, cwd), `${sessionId}.jsonl`)).size > 0
  } catch {
    return false
  }
}

/** Long enough for the longest wait a build can sit behind (pane-live + spawn-settled,
 *  15s each), short enough that a pane id recycled later never inherits one. */
const PENDING_LAUNCH_TTL_MS = 60_000
const pendingLaunches = new Map<number, PendingLaunchEffects>()

export function registerAgents(getWin: () => BrowserWindow | null): void {
  // Which optional flags the installed claude accepts — probed ONCE per run, off the
  // launch path, so the first launch already has its answer and no launch ever waits on
  // a spawn to find out. Fire-and-forget by design: unknown means 'omit the flag'.
  void refreshAgentCapabilities()
  installs = new InstallService((state) => {
    try {
      getWin()?.webContents.send(AgentChannels.installChanged, state)
    } catch {
      /* window gone — the snapshot channel catches the UI up on remount */
    }
    if (state.phase === 'succeeded') void refreshAgentSettingsForCli(state.agentId)
  })
  setups = new SetupService((state) => {
    try {
      getWin()?.webContents.send(AgentChannels.setupChanged, state)
    } catch {
      /* window gone — setupStates catches a remounted UI up */
    }
    if (state.phase === 'succeeded') void refreshAgentSettingsForCli(state.agentId)
  })

  ipcMain.handle(AgentChannels.detect, () => detectOverride ?? detectAgents())
  ipcMain.handle(AgentChannels.command, async (_e, req: AgentCommandRequest): Promise<AgentCommandResult> => {
    const buildStartedAt = Date.now() // buildMs: the launch-latency gates' evidence
    const remoteHost = req.remoteHostId
      ? getSettingsStore()?.listRemotes().find((host) => host.id === req.remoteHostId)
      : undefined
    if (req.remoteHostId && !remoteHost) {
      return { ok: false, reason: 'The saved remote host no longer exists. The agent was not launched locally.' }
    }
    // A LOCAL launch whose cwd has vanished (a restored session pointing at a deleted/renamed/
    // unmounted folder) would `cd`-fail before the CLI ran — the daemon's pickCwd silently
    // falls back to $HOME, so the app booked the pane agent-bearing and SPENT its one-shot
    // config overrides + the restore resume intent on a session that never started. Refuse
    // like a vanished remote host, BEFORE any of that is consumed — the pane stays a plain
    // shell. Checked here (main) because only main can ask the filesystem.
    if (!req.remoteHostId && req.remote !== true && req.cwd && !existsSync(req.cwd)) {
      return { ok: false, reason: 'The saved folder no longer exists. The agent was not launched.' }
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
      if (!command) return { ok: false, reason: `Unknown agent provider: ${req.agentId}` }
      // needs-you presence (ALERTAGREE): a remote pane runs an agent too, even though its
      // verdict channel is chime-only — mark it so the webhook gate agrees with the pane.
      if (typeof req.paneId === 'number') notePaneAgent(req.paneId, true)
      // No configDir: profile homes are LOCAL filesystem facts and a remote launch has none
      // (see above). The agent and cwd are still worth recording — they are what makes a
      // restored remote pane say what it was running.
      const intent = launchIntentFor(req.agentId, req.cwd, undefined, undefined, buildStartedAt)
      if (typeof req.paneId === 'number') rememberPaneLaunch(req.paneId, intent)
      return { ok: true, command, intent, buildMs: Date.now() - buildStartedAt }
    }
    // Profile env (4/04): resolved HERE from the store — the renderer only ever
    // names a profile id; values (pointers, never secrets) stay main-side until
    // they become part of the launch command.
    //
    // ONE read of the profile table per launch. The same rows answer three questions
    // that each used to re-query it: which profile is this launch's, which sibling
    // homes should be pooled from, and (inside prepareAgentConfigLaunch) does the
    // profile replace the user scope. A launch is one instant — three reads of one
    // table can only ever agree, so the extra two were pure cost.
    const profiles = getSettingsStore()?.listProfiles() ?? []
    // When the caller named no profile, ask the PANE which one it was running under before
    // falling through to "whichever is order 0 right now". A launch that took the default —
    // and every hand-typed agent — never recorded a name anywhere the relaunch could read,
    // so a restore re-resolved order 0 and brought the pane back on a different config home.
    // The pane's own intent was resolved by THIS composer at launch, so it names the home the
    // pane actually ran under. A remembered profile that has since been deleted falls through
    // to the default rather than refusing: a restore must not be blocked by a profile the
    // user removed, and only an EXPLICIT name is worth refusing over (below).
    const rememberedProfileId = req.profileId ? undefined : rememberedProfileFor(req.paneId, req.agentId)
    const wantedProfileId = req.profileId ?? rememberedProfileId
    let profile = wantedProfileId
      ? profiles.find((p) => p.id === wantedProfileId && p.provider === req.agentId)
      : undefined
    if (req.profileId && !profile) {
      return { ok: false, reason: `The selected profile (${req.profileId}) no longer exists. Choose another profile before launching.` }
    }
    // The order-0 default (4/04), applied HERE now that the renderer no longer pre-resolves
    // it — for a pane with nothing named and no history of its own, and as the landing spot
    // when a remembered profile has since been deleted (a restore must not be blocked by a
    // profile the user removed; only an explicitly NAMED one is worth refusing over, above).
    if (!profile) {
      profile = profiles
        .filter((p) => p.provider === req.agentId)
        .sort((a, b) => a.order - b.order)[0]
    }
    // The pane HAD a profile and it is gone. Not a refusal — a restore must survive the user
    // deleting a profile — but the pane is coming back on a different config home, with
    // different sessions and a different login, and moving it silently is the only outcome
    // worse than moving it.
    const profileFallback =
      rememberedProfileId && profile?.id !== rememberedProfileId
        ? { wanted: rememberedProfileId, using: profile?.id }
        : undefined
    let profileEnv: Record<string, string>
    try {
      profileEnv = materializeProfileEnv(req.agentId, profile?.env)
    } catch {
      return { ok: false, reason: 'The selected provider profile home could not be prepared.' }
    }
    // The two independent halves of "make this launch's world right" run TOGETHER, and
    // the network-bound one starts first:
    //   · pre-launch connection verification — the plan's connected tools, probed in
    //     parallel under a ~2s budget. Started here so it overlaps the reconcile
    //     instead of queueing behind it; the materialization still awaits it, so a
    //     broken budget still delays a launch (the pulse gate proves exactly that).
    //   · provider settings reconcile — the agent-CLI control plane, config files.
    //   · tool plan — this workspace's scoped server set (flag + plan file).
    // Neither refusal outranks the other by timing: the reason precedence below is
    // explicit, so a launch refused for two reasons always names the settings one.
    const verified = verifyToolPlanForLaunch(req)
    const [prepared, plan] = await Promise.all([
      prepareAgentConfigLaunch(req, profile),
      materializeToolPlanAtLaunch(req, { verified }),
      // Third rider, and free: on a fresh install the boot-time capability probe may not
      // have answered yet, and a launch that beats it silently forfeits its assigned
      // session id for the pane's whole life. Joining the probe HERE overlaps it with the
      // two waits above; on every launch after the first there is nothing to wait for.
      awaitAgentCapabilities(2_000)
    ])
    // Provider settings: a failed reconciliation refuses the launch, never launches
    // silently on the CLI's own settings.
    if (!prepared.ok) return { ok: false, reason: prepared.reason || 'Provider settings could not be synchronized.' }
    // Tool plan (8/09): materialized main-side — the renderer never sees it. A refused
    // materialization refuses the LAUNCH; it never falls back to global servers.
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
    // The title layer (backend/features/agents/title.ts): codex is the one CLI whose
    // goal-carrying title needs launch args (gemini's share rides the bell's generated
    // system settings; claude/opencode title themselves by default; aider offers nothing).
    // BEFORE prepared.args, so a user's own provider-settings choice still wins.
    const titleArgs = req.agentId === 'codex' ? codexTitleArgs() : []
    // Sessions follow profiles (ADR 0013). A profile is a separate config home — the
    // provider's own multi-account mechanism — but that makes every profile a private
    // session silo. So every LOCAL launch first unions this cwd's sessions from the
    // provider's other known homes (default + saved profiles) into the launch home:
    // `--resume`, the CLI's picker, AND an in-session /resume all simply see them,
    // whichever subscription they were born under. Every launch, not just resume ones —
    // the fresh-launch-then-/resume path is exactly how a new workspace picks up the
    // capped profile's work. Whole files at the CLIs' documented paths; never parsed,
    // never a credential (those files are not in the copy set — ADR 0002); best-effort
    // only, a launch never fails over a pooling error.
    let trustPrepared = false
    try {
      const targetHome = resolveHome(req.agentId, profile ?? null)
      const sources = [
        resolveHome(req.agentId, null),
        ...profiles
          .filter((p) => p.provider === req.agentId && p.id !== profile?.id)
          .map((p) => resolveHome(req.agentId, p))
      ]
      poolProviderSessions(req.agentId, req.cwd, targetHome, sources)
      // Project state follows profiles too (claude-project-state.ts): carry the launch
      // cwd's GRANTS (allowedTools, MCP approvals, includes approval) from the other
      // homes and declare the folder TRUSTED in the launch home — opening a workspace
      // there IS the trust declaration (product decision 2026-08-02), so the dialog
      // never paints and a profile switch keeps every permission the session had.
      // `trustPrepared` rides the reply so the renderer skips its trust-settle wait.
      if (req.agentId === 'claude') {
        trustPrepared = carryClaudeProjectState(
          req.cwd,
          claudeStateFileFor(targetHome),
          sources.map((home) => claudeStateFileFor(home))
        ).trusted
      }
    } catch {
      /* pooling is a courtesy before the launch, never a gate */
    }
    // Exact-session resume: when the request names the pane it will be typed into and
    // the context monitor has that pane's session log locked, resume THAT session by id
    // — a usage-limit failover continues the conversation under the next profile instead
    // of dropping the user into the CLI's picker. The lock is the FRESHEST answer when it
    // exists (it carries claude's own `/clear` corrections), but it dies with the watch:
    // the deterministic interrupt proves the capped CLI is dead before this build runs, so
    // by here a failover has no live lock at all. That case is the ASSIGNED id's — the app
    // named this pane's session at birth, and a name outlives the process that held it.
    // Last comes the intent the snapshot armed for this pane (session-restore.ts; consumed
    // once), which is the COLD-BOOT answer: after a restart nothing was assigned this run.
    // Bare flag whenever the id isn't knowable any of those ways (foreign provider, a
    // claude too old for `--session-id`, hand-typed session, no snapshot).
    //
    // A PREFETCH build (`consume: false`) may still be discarded — the pane it was
    // built for can turn out to be daemon-reattached, where the right answer is to
    // adopt the living agent and type nothing. So it only PEEKS at the restore shelf;
    // the intent is spent by commandCommit, when the command is really typed.
    const consumeNow = req.consume !== false
    let usedRestoreIntent = false
    let resumeSessionId: string | undefined
    /** The pane HAS an assigned id, but claude never wrote its transcript. */
    let unwritten = false
    if (req.resume && typeof req.paneId === 'number') {
      const live = paneSessionLog(req.paneId)
      if (live && live.provider === req.agentId) resumeSessionId = resumeSessionIdFromFile(req.agentId, live.file) ?? undefined
      if (!resumeSessionId && req.agentId === 'claude') resumeSessionId = assignedSessionFor(req.paneId)
      if (!resumeSessionId) {
        resumeSessionId = consumeNow
          ? consumeRestoreResumeSessionId(req.paneId, req.agentId)
          : peekRestoreResumeSessionId(req.paneId, req.agentId)
        usedRestoreIntent = !!resumeSessionId
      }
      // ONE existence check, on whichever tier won — because ASSIGNMENT is what made an
      // unwritten id possible, and assignment now feeds more than one tier.
      //
      // `claude --session-id X` creates no transcript until the user actually sends
      // something. Hand `--resume X` to claude for a session it never wrote and it prints
      // "no conversation found" and EXITS, killing the pane instead of continuing it. The
      // old chain could not produce that: every id came from a file that existed by
      // definition. Checking only the in-memory assigned tier left the hole open on the
      // path that matters most — the restore shelf is populated FROM assigned ids and
      // records them WITHOUT a file precisely when the monitor had no lock, and after a
      // restart the in-memory map is empty so the shelf is the only tier left. A pane
      // launched, never prompted, then restored came back to a dead shell.
      //
      // Placed after pooling, which has had its chance to bring the transcript into the
      // launch home. No transcript means there is genuinely nothing to continue.
      if (resumeSessionId && req.agentId === 'claude' && !claudeTranscriptExists(resumeSessionId, profile ?? null, req.cwd)) {
        resumeSessionId = undefined
        unwritten = true
      }
    }
    // The pane's session was named but never written, and nothing else knows an id either:
    // launch FRESH rather than fall through to a bare `--resume`, which would drop the user
    // into the CLI's session picker — a list of unrelated conversations, in a pane whose own
    // conversation never had a single message in it. "Nothing to continue" is the truth here,
    // and starting clean is what it means.
    const resumeFlag = req.resume && !(unwritten && !resumeSessionId)
    // Identity by declaration (context.ts): a claude resume-by-id REUSES the session id
    // (forking is opt-in), so the transcript this launch will append to is knowable right
    // here — under the LAUNCH home (pooling above just made sure it exists there). Tell
    // the context monitor instead of letting it re-guess: a resumed transcript predates
    // the pane's watch, which its matcher rightly refuses to lock by heuristic. Every
    // other launch CLEARS the pane's declaration — a fresh session must never inherit one.
    //
    // A PREFETCH build must not declare anything: this call CLEARS the pane's existing
    // declaration and its retained lock when there is no resumed file, and a build that
    // is then discarded (the adopt branch) would have wiped the very identity the
    // living agent's pane still depends on. The declaration is carried on the pending
    // record and applied by commandCommit instead.
    //
    // IDENTITY BY ASSIGNMENT (the other half). A FRESH claude launch names its own
    // session id up front — `--session-id <uuid>` — so the pane's identity is a fact
    // from birth instead of something the monitor has to recognise afterwards from
    // file birth times and mtimes. The transcript does not exist yet; the monitor holds
    // the declared name and locks it the moment claude writes it (the `declare` rule).
    // Only when the installed claude is PROVEN to accept the flag (agent-capabilities);
    // unknown ⇒ omit ⇒ the old discovery path, unchanged.
    let freshSessionId: string | undefined
    if (
      req.agentId === 'claude' &&
      !resumeFlag &&
      !resumeSessionId &&
      typeof req.paneId === 'number' &&
      claudeSupportsSessionId()
    ) {
      freshSessionId = newClaudeSessionId(req.paneId)
    }
    const namedSessionId = resumeSessionId ?? freshSessionId
    let expectedFile: string | null = null
    if (typeof req.paneId === 'number') {
      if (namedSessionId && req.agentId === 'claude') {
        // The launch home's project dir — created by the pooling above when absent, so
        // the exact munge is the right name to predict when it still is.
        const home = resolveHome('claude', profile ?? null)
        const dir = findClaudeProjectDir(home, req.cwd) ?? join(home, 'projects', claudeProjectDirName(req.cwd))
        expectedFile = join(dir, `${namedSessionId}.jsonl`)
      }
      if (consumeNow) {
        // Order matters: the clear branch of expectPaneSession also drops the pane's
        // assigned id, so the remember has to come after it.
        expectPaneSession(req.paneId, req.agentId, expectedFile)
        if (namedSessionId && req.agentId === 'claude') rememberAssignedSession(req.paneId, namedSessionId)
      }
    }
    const command = buildLaunchCommand(
      req.agentId,
      req.cwd,
      resumeFlag,
      { ...bell.env, ...profileEnv, ...prepared.env },
      [...(freshSessionId ? ['--session-id', freshSessionId] : []), ...plan.args, ...ctxArgs, ...bell.args, ...titleArgs, ...prepared.args],
      'local',
      resumeSessionId
    )
    if (!command) return { ok: false, reason: `Unknown agent provider: ${req.agentId}` }
    if (consumeNow) {
      // needs-you presence (ALERTAGREE): mark the target pane as agent-bearing the moment the
      // launch is real — the daemon's detector takes seconds to confirm a fresh CLI, and a
      // permission prompt can beat it. Detection keeps it true; pane exit drops it.
      if (typeof req.paneId === 'number') notePaneAgent(req.paneId, true)
      // Accepted residual: 'once' session overrides are consumed HERE, when the command
      // is handed back — the renderer still has to type it, and a pane disposed in that
      // microsecond gap spends the one-shot for nothing. Moving consumption behind a
      // typed-ack would add an IPC round trip and a state machine for a window this
      // narrow; the failure is a re-arm in Settings, not a wrong launch.
      markAgentConfigSessionLaunched(req)
    } else if (typeof req.paneId === 'number') {
      // Prefetch: park the effects until the command is really typed. Last build for a
      // pane wins — an overlapping prefetch replaces the previous one, and only one
      // commit can ever claim it.
      pendingLaunches.set(req.paneId, {
        agentId: req.agentId,
        workspaceId: req.workspaceId,
        expectedFile,
        sessionId: req.agentId === 'claude' ? namedSessionId : undefined,
        usedRestoreIntent,
        at: Date.now()
      })
    }
    // Sign-in truth at launch: the profile's email is a LABEL — nothing can route
    // the CLI's own OAuth to it. So state the facts at the moment they bite: no
    // login at the launch home -> "pick <email>" hint; a DIFFERENT login -> a
    // mismatch warning. The renderer phrases it; never a launch gate.
    //
    // ONE probe answers both questions below. They ask different things of the same
    // fact — "does the home's login match the profile's label?" and "is anyone signed
    // in here at all?" — and both resolve the SAME home (`profile` and `profile ?? null`
    // are the same value whenever the first branch runs), so the second probe was
    // re-parsing the identical files for an answer it already had.
    const loginState = probeLogin(req.agentId, profile ?? null)
    let signIn: AgentCommandResult['signIn']
    if (profile?.email) {
      if (loginState && !loginState.signedIn) signIn = { expected: profile.email }
      else if (loginState?.email && loginState.email.toLowerCase() !== profile.email.toLowerCase())
        signIn = { expected: profile.email, actual: loginState.email }
    }
    // The plain "not signed in at all" case — the one a first-time user is actually in, and
    // the one the profile-email check above structurally cannot see. `undefined` from the
    // probe means UNKNOWABLE (no probe for this provider, or an unreadable home) and must
    // never be reported as signed-out: an offer to fix a problem nobody has is its own bug.
    let needsSignIn: AgentCommandResult['needsSignIn']
    if (loginState?.signedIn === false) needsSignIn = signInTarget(req.agentId) ?? undefined
    // The composer's INPUT, resolved, travelling back with its output so the pane can
    // persist what it IS rather than only what was typed at it. `profileEnv` is the
    // materialized profile pointer — absent means this launch used the provider's own
    // default home, which is a fact worth recording as much as a named one.
    const intent = launchIntentFor(
      req.agentId,
      req.cwd,
      profile?.id,
      profileEnv[HOME_POINTER[req.agentId]],
      buildStartedAt,
      req.agentId === 'claude' ? namedSessionId : undefined
    )
    // Remember it HERE too, not only when the next `welcome` reports it back: the daemon
    // replays panes on reconnect, which may be hours away, and a relaunch in between must
    // still find the profile this launch resolved. Only for a build that is really being
    // typed — a discarded prefetch must not relabel the pane.
    if (consumeNow) rememberPaneLaunch(req.paneId as number, intent)
    return { ok: true, command, intent, signIn, needsSignIn, profileFallback, trustPrepared, buildMs: Date.now() - buildStartedAt }
  })
  // The prefetched build's command is being typed NOW — apply what it deferred, in the
  // order the immediate path applies it. Anything unknown (never prefetched, already
  // committed, or aged out) answers ok:false so the renderer rebuilds honestly rather
  // than typing a command whose one-shots were never claimed.
  ipcMain.handle(AgentChannels.commandCommit, (_e, req: AgentCommandCommitRequest): AgentCommandCommitResult => {
    const paneId = Number(req?.paneId)
    if (!Number.isFinite(paneId)) return { ok: false }
    const pending = pendingLaunches.get(paneId)
    pendingLaunches.delete(paneId)
    if (!pending || pending.agentId !== req?.agentId) return { ok: false }
    if (Date.now() - pending.at > PENDING_LAUNCH_TTL_MS) return { ok: false }
    if (pending.usedRestoreIntent) consumeRestoreResumeSessionId(paneId, pending.agentId)
    expectPaneSession(paneId, pending.agentId, pending.expectedFile)
    if (pending.sessionId) rememberAssignedSession(paneId, pending.sessionId)
    notePaneAgent(paneId, true)
    markAgentConfigSessionLaunched({
      agentId: pending.agentId,
      cwd: '',
      workspaceId: pending.workspaceId
    } as AgentCommandRequest)
    return { ok: true }
  })
  ipcMain.handle(AgentChannels.install, (_e, agentId: string) => installs!.start(String(agentId)))
  ipcMain.handle(AgentChannels.installStates, async () => {
    await maybeFault(AgentChannels.installStates) // finding 39's seam: Settings § Providers' read
    return installs?.states() ?? []
  })
  ipcMain.handle(AgentChannels.setup, (_e, agentId: string) => setups!.start(String(agentId)))
  ipcMain.handle(AgentChannels.setupCancel, (_e, agentId: string) => setups?.cancel(String(agentId)))
  ipcMain.handle(AgentChannels.setupStates, () => setups?.snapshot() ?? [])
  // A pointer to the provider's own login verb — no credential, no browser, no token. The
  // renderer types it into a pane; that is the whole transaction (ADR 0002).
  ipcMain.handle(AgentChannels.signIn, (_e, agentId: string) => signInTarget(String(agentId)))

  // ── Per-workspace auto-failover opt-in (4/04, persisted — audit F6) ─────────
  // Settings-store KV keyed by workspace id, the browser-dock consent pattern: the
  // set returns an HONEST {ok} and the renderer obeys it — `store()?.setSetting(...)`
  // evaluates to undefined whether it wrote or not, and a mode that decides whether
  // the app SWITCHES ACCOUNTS BY ITSELF overnight must not be optimistic about that.
  const kvAutoFailover = (workspaceId: string): string => `agents.autoFailover.${workspaceId}`
  ipcMain.handle(AgentChannels.failoverGet, (_e, workspaceId: string) => {
    const wsId = String(workspaceId ?? '')
    return !!wsId && getSettingsStore()?.getSetting(kvAutoFailover(wsId)) === '1'
  })
  ipcMain.handle(AgentChannels.failoverSet, (_e, p: { workspaceId?: string; on?: boolean }): { ok: boolean } => {
    const wsId = String(p?.workspaceId ?? '')
    const store = getSettingsStore()
    if (!wsId || !store) return { ok: false }
    try {
      store.setSetting(kvAutoFailover(wsId), p?.on ? '1' : '')
    } catch {
      return { ok: false } // a store that throws is a store that did not save
    }
    return { ok: true }
  })
}

/** App quitting: kill any in-flight ephemeral install terminals. */
export function disposeAgentInstalls(): void {
  installs?.dispose()
  installs = null
  setups?.dispose()
  setups = null
  detectOverride = null
}

/** Deterministic availability seam for the live-registry audit gate. */
export function setAgentDetectOverrideForSmoke(next: AgentInfo[] | null): void {
  detectOverride = next ? next.map((agent) => ({ ...agent })) : null
}
