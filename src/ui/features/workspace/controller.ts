import { formulaPaneId, GitChannels, TerminalChannels, WorktreeChannels } from '@contracts'
import type { AgentState, CreateWorktreeResult, PaneId, RemoveWorktreeResult } from '@contracts'
import { getBridge } from '../../core/ipc/bridge'
import { GridLayout, paneLimit, parseTree, leafIds, type LayoutTreeNode } from '../layout'
import { confirmDialog, icon, showToast, TOAST_DEFAULT_MS } from '../../components'
import { batchSlots } from '../../core/layout/slots'
import { openMovePaneModal, type MoveTarget } from './move-pane-modal'
import { setFocusedPane } from '../../core/layout/focus'
import { setPaneCwd, getPaneCwd, getPaneCwdProjection } from '../../core/layout/pane-cwd'
import { setPaneRole, setPaneRemote, clearPaneRemote, setPaneLabel, getPaneRemote } from '../../core/layout/pane-meta'
import { paneState, paneFinished, acknowledgeFinished, onAttentionChange } from '../../core/attention/attention-port'
import { announce } from '../../core/a11y/live-region'
import { clearPaneLaunch } from '../../core/agents/toolplan-panes'
import { requestAgentLaunch } from '../../core/agents/launch-port'
import { getPaneAgentSession } from '../../core/agents/agent-session-port'
import { activeView, setActiveView, onViewChange } from '../../core/shell/view-port'
import { getTelemetry } from '../../core/telemetry'
import type { TemplateWorkspaceSpec } from '../../core/workspace/open-service'
import { type WorkspaceMeta, isWorkspaceColor, newWorkspaceId, nextColor, paneIdForSlot } from './model'

/** How long to let the arrival swell land before a pane that was auto-focused-into is treated
 *  as clicked. Must outlast the 1.2s swell (and grid-layout's own 1400ms class timer), or the
 *  acknowledgement would clear `data-alert` out from under the animation that rides on it. */
const PULSE_SETTLE_MS = 1400

interface WorkspaceView {
  meta: WorkspaceMeta
  tab: HTMLElement
  /** The real button that switches to this workspace. The tab itself is a plain div: a
   *  div[role=button] wrapping the close BUTTON was invalid content, and its keydown
   *  handler swallowed Enter/Space before the close button could ever see them. */
  activate: HTMLButtonElement
  label: HTMLElement
  /** Blocked panes — RED. Split from the done count by urgency (explicit direction): one
   *  number could not say whether a "3" was three agents needing you or one needing you and
   *  two merely finished, and those are different messages. */
  attnBadge: HTMLElement
  /** Finished-and-unclicked panes — GREEN. */
  doneBadge: HTMLElement
  countBadge: HTMLElement
  container: HTMLElement
  layout: GridLayout
  attentionLatched: boolean
  /** The rail outline's latch: any UNSEEN alert while backgrounded holds the pulsing orange
   *  outline until this workspace is focused — nothing else may clear it (spec: "disappears
   *  only once I view and select that workspace"). */
  alertLatched: boolean
}

/** Payload of the pane's `mogging:remove-worktree` event (grid → controller). */
interface RemoveWorktreeDetail {
  paneId: number
  repo: string
  path: string
  force: boolean
  resolve: (result: RemoveWorktreeResult) => void
}

export interface CreateOpts {
  id?: string
  name?: string
  cwd?: string
  /** A RESTORED identity color. Honoured for life, but only while it is still one of ours
   *  and no live workspace already wears it — see `claimColor`. Absent on a new workspace:
   *  the controller allocates. */
  color?: string
  ordinal?: number
  paneCount?: number
  activate?: boolean
  assignments?: string[]
  paneCwds?: (string | null)[]
  roles?: (string | null)[]
  /** Per-slot remote hosts (Phase-4/05). null = local. Name is display data. */
  remotes?: ({ hostId: string; name: string; cwd?: string } | null)[]
  profileIds?: (string | null)[]
  /** Per-slot pane id for slots holding a pane that MOVED here — restoring one under this
   *  workspace's formula id would spawn a new shell and orphan its live session. */
  paneIds?: (number | null)[]
  /** Serialized split-tree layout (shape + sizes). Absent/invalid → the template
   *  grid for `paneCount` — a bad persisted row can never wedge a restore. */
  layout?: string | null
}

export interface SwitchOpts {
  /** Reveal the grid view (default). Restore passes false so boot stays on Home. */
  reveal?: boolean
}

/**
 * What a close would actually destroy. ONE definition of "live", shared by the three
 * destructive paths (close workspace / close pane / shrink layout) so the predicate and the
 * copy can't drift — they had. Every one of them counted `session || state !== idle` and then
 * told the user those panes had "an agent still working". A session is an ASSIGNMENT, not
 * activity: an agent parked at its prompt still has one.
 *
 * `running` is now exact, which it could not be before: the state machine used to mark a pane
 * busy from plain OUTPUT, so a bare `npm run build` was reported as an agent at work. Under the
 * verdict law busy means an agent actually said it was working (agent-state/activity.ts).
 *
 * The two reasons are counted separately because they are separately true, and a pane can be
 * live for both (an agent mid-turn): `sessions` and `running` overlap, `panes` is the union and
 * is the number that decides whether we prompt at all.
 */
interface LivePanes {
  /** Panes live for either reason — the union. Empty ⇒ no confirmation is warranted. */
  panes: PaneId[]
  /** Live because an agent session is assigned, working or not. */
  sessions: PaneId[]
  /** Live because the pane is still producing output (agent turn, or any command). */
  running: PaneId[]
}

/**
 * One pane's row in the slot-indexed manifest: the provider assigned to it, the worktree it
 * runs in, its swarm role, its remote host and its launch profile. These are indexed by SLOT,
 * not by pane, so a pane that changes workspace has to carry them across by hand — otherwise
 * the next restore rebuilds it as a plain shell in the wrong directory, and its worktree
 * isolation, role and profile are silently gone.
 */
interface PaneManifest {
  assignment?: string
  paneCwd?: string | null
  role?: string | null
  remote?: { hostId: string; name: string; cwd?: string } | null
  profileId?: string | null
}

function inspectLive(paneIds: number[]): LivePanes {
  const live: LivePanes = { panes: [], sessions: [], running: [] }
  for (const raw of paneIds) {
    const paneId = raw as PaneId
    const hasSession = !!getPaneAgentSession(paneId)
    // Live work, named exactly: an agent mid-turn (busy) or one blocked waiting on you
    // (attention) — closing the pane kills both. `done` and `idle` are not running, and
    // `unknown` means the pane never spoke a verdict, so we must not claim anything about it.
    // (This was `!== 'idle'`, which read a never-spoken pane as "still producing output".)
    const s = paneState(paneId)
    const isRunning = s === 'busy' || s === 'attention'
    if (hasSession) live.sessions.push(paneId)
    if (isRunning) live.running.push(paneId)
    if (hasSession || isRunning) live.panes.push(paneId)
  }
  return live
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** Name the live panes for what they are. Never says "agent" about a pane we only know is
 *  noisy; never says "working" about an agent we only know is assigned. */
function describeLive(live: LivePanes): string {
  const parts: string[] = []
  if (live.sessions.length > 0) parts.push(`${plural(live.sessions.length, 'pane has', 'panes have')} an agent session`)
  if (live.running.length > 0) {
    parts.push(`${plural(live.running.length, 'pane is', 'panes are')} still running`)
  }
  return parts.join(', and ')
}

/**
 * Owns the set of workspaces: one rail item + one hidden/visible container + one `GridLayout`
 * each. Switching is pure show/hide (every workspace's panes stay mounted and streaming).
 *
 * The rail item carries TWO live alert counts, split by urgency (explicit direction) — red for
 * panes that need you, green for panes that finished — beside a quiet pane-count, plus the
 * latched attention attribute (`data-attention`, the contract the attention/milestone smokes
 * assert). It also owns every pane's RESTING status outline and the swells that deliver them:
 * refreshAttention is the single pass that derives all of it from the attention port, so the
 * pane dot, the pane outline and the rail are incapable of disagreeing.
 *
 * Emits `onChange` after any mutation (used to persist + publish the info port).
 */
export class WorkspaceController {
  private readonly views = new Map<string, WorkspaceView>()
  private order: string[] = []
  private activeId: string | null = null
  private nextOrdinal = 0
  // Workspaces mid-close (WS-01): removed from the visible order + rail but
  // their panes stay ALIVE for a 5-second undo grace, disposed only when it
  // lapses. Key -> the dispose timer + the order index to restore to.
  private readonly pendingClose = new Map<string, { timer: ReturnType<typeof setTimeout>; index: number }>()
  private lastAttnTotal = 0 // for the A11Y-01 "needs your input" announcement

  // ── The three pulse/alert lifetimes. Red and green are deliberately NOT symmetric. ──
  //
  // attnPulsed   red panes whose swell has already played THIS VISIT. Cleared wholesale on
  //              every switch, which is what re-arms it: leave a blocked pane unanswered,
  //              come back, and it pulses at you again (explicit direction). Red has no
  //              "spent" state, because the agent is still blocked and nothing you did
  //              changed that.
  // greenPulsed  finished panes whose swell has played AT ALL. Once, ever — a completion is
  //              news, and news is only new once. Cleared when the pane stops being finished
  //              (you clicked it, or new work reclaimed it), so its NEXT done pulses again.
  // seenBlocked  blocked panes you have CLICKED. They keep their red outline and red dot —
  //              a click cannot unblock an agent — but they stop arming the rail: the tab
  //              no longer pulses for a pane you have already looked at. Seen is not
  //              resolved, but seen is worth something. The COUNT deliberately stays: it is
  //              information, not an alarm, and hiding "how many agents need you" is exactly
  //              the forgetting this whole system exists to prevent.
  //
  // All three are pruned to the panes actually scanned — pane ids are ordinal-derived and
  // REUSED after a workspace closes, so a stale entry would silently corrupt its successor
  // (a reused id reading "already pulsed" would never flash on its first real edge).
  private readonly attnPulsed = new Set<PaneId>()
  private readonly greenPulsed = new Set<PaneId>()
  private readonly seenBlocked = new Set<PaneId>()
  private readonly worktreeRemovalEvents: Array<{
    paneId: number
    stage: 'request' | 'pane-closed' | 'remove-attempt' | 'remove-result'
    attempt?: number
    paneStillMounted: boolean
    ok?: boolean
    reason?: string
  }> = []

  constructor(
    private readonly tabsEl: HTMLElement,
    private readonly hostEl: HTMLElement,
    private readonly onChange: () => void,
    private readonly onAttention?: (anyAttention: boolean) => void,
    private readonly onClosed?: (meta: WorkspaceMeta) => void,
    private readonly onOpened?: (meta: WorkspaceMeta) => void
  ) {
    onAttentionChange(() => this.refreshAttention())
    // Coming back to the grid from Board/Home/Settings is a moment a green pulse can finally be
    // PAID. The old code marked the pulse "seen" the instant the flag rose, wherever you were —
    // so an agent finishing while you sat on the Board spent its news on an empty room, and you
    // returned to a green dot that had never flashed.
    onViewChange(() => this.refreshAttention())
    this.wireReorder()
  }

  list(): WorkspaceMeta[] {
    return this.order
      .map((id) => this.views.get(id)?.meta)
      .filter((m): m is WorkspaceMeta => !!m)
  }

  activeMeta(): WorkspaceMeta | null {
    return this.activeId ? (this.views.get(this.activeId)?.meta ?? null) : null
  }

  private active(): WorkspaceView | null {
    return this.activeId ? (this.views.get(this.activeId) ?? null) : null
  }

  /** Create a workspace (wizard/`mogging .`/the + button/a restore). */
  create(opts: CreateOpts = {}): WorkspaceMeta {
    const ordinal = opts.ordinal ?? this.nextOrdinal
    this.nextOrdinal = Math.max(this.nextOrdinal, ordinal + 1)
    const meta: WorkspaceMeta = {
      id: opts.id ?? newWorkspaceId(),
      name: opts.name ?? `Workspace ${ordinal + 1}`,
      color: this.claimColor(opts.color),
      cwd: opts.cwd ?? '',
      ordinal,
      paneCount: opts.paneCount ?? 1,
      assignments: opts.assignments,
      paneCwds: opts.paneCwds,
      roles: opts.roles,
      remotes: opts.remotes,
      profileIds: opts.profileIds,
      paneIds: opts.paneIds,
      layout: opts.layout ?? undefined
    }

    // Parsed BEFORE the seeds are published: persisted trees keep their REAL slot ids
    // (gaps included — a workspace that closed a middle pane restores 1,3,5, not 1,2,3),
    // and the cwd seeding below must cover exactly those slots.
    const restoredTree = opts.layout ? parseTree(opts.layout, meta.paneCount) : null
    const slots = restoredTree ? leafIds(restoredTree) : undefined

    // BEFORE the grid exists, not merely before `apply`: GridLayout's constructor applies
    // its OPENING tree (the restored one, else a 1-pane grid), which synchronously
    // constructs those TerminalPanes — and a pane reads its remote + cwd seeds at spawn
    // time. Published after construction, pane 1 (and only pane 1) spawned locally at the
    // daemon's fallback cwd: a worktree-isolated slot 1 opened its shell in $HOME while
    // its branch chip claimed mogging/<slug>.
    this.publishRemotes(meta)
    this.publishPaneCwds(meta, slots) // seed the pty's cwd + per-pane git (2/03)

    const container = document.createElement('div')
    container.className = 'workspace-view'
    this.hostEl.append(container)
    const layout = new GridLayout(
      container,
      meta.id,
      formulaPaneId(ordinal, 0), // the workspace's pane-id base (slot ids are 1-based on top)
      (paneId) =>
        // The pane's OWN cwd (worktree isolation, 3/03; OSC-7 refined), not the workspace
        // root: "launch in focused pane" and "review focused pane" act on this value, and
        // the root made both escape the pane's worktree.
        setFocusedPane({ paneId, cwd: getPaneCwd(paneId) || getPaneRemote(paneId)?.cwd || meta.cwd }),
      // The restored tree OPENS the grid, rather than being applied over a default one:
      // that default publishes slot 1 synchronously, so a tree with a GAP there (pane 1
      // closed, 2+3 kept) spawned a phantom pane and killed it mid-spawn — orphaning its
      // shell inside the daemon forever. See GridLayout's constructor.
      restoredTree ?? undefined,
      // Panes that were MOVED into this workspace keep their own ids — restoring them under
      // this workspace's formula would spawn fresh shells and orphan their live sessions.
      meta.paneIds
    )

    const view: WorkspaceView = {
      meta,
      container,
      layout,
      attentionLatched: false,
      alertLatched: false,
      ...this.makeTab(meta)
    }
    this.tabsEl.append(view.tab)
    this.views.set(meta.id, view)
    this.order.push(meta.id)

    // Pane × buttons bubble a close request up through the grid to here.
    container.addEventListener('mogging:close-pane', (e) => {
      const paneId = (e as CustomEvent<{ paneId: number }>).detail?.paneId
      if (paneId != null) void this.requestClosePane(meta.id, paneId)
    })
    container.addEventListener('mogging:remove-worktree', (e) => {
      const detail = (e as CustomEvent<RemoveWorktreeDetail>).detail
      if (detail) void this.removePaneWorktree(view, meta.id, detail)
    })
    // Pane ⋯ menu "Split right/down" bubbles here — the controller (not the grid)
    // owns splits, because the new pane's cwd must be seeded before its slot exists.
    container.addEventListener('mogging:split-pane', (e) => {
      const d = (e as CustomEvent<{ paneId: number; dir: 'h' | 'v' }>).detail
      if (d) this.splitPane(meta.id, d.paneId, d.dir)
    })
    // Pane ⋯ menu "Move to another workspace…". Only the controller knows the other
    // workspaces, and only it can carry a LIVE pane between two grids without the
    // terminal feature noticing (and killing it) — see movePaneToWorkspace.
    container.addEventListener('mogging:move-pane', (e) => {
      const d = (e as CustomEvent<{ paneId: number; title?: string }>).detail
      if (d) this.offerMovePane(d.paneId, d.title ?? `Terminal ${d.paneId}`)
    })

    // Any layout mutation (template, split, close, seam resize, drag-rearrange) keeps
    // the persisted manifest true: pane count + the serialized split tree.
    layout.onLayoutChange = () => {
      meta.paneCount = layout.paneCount
      meta.layout = layout.serialize()
      meta.paneIds = layout.paneIdMap() // undefined unless a pane moved in — see WorkspaceMeta
      this.refreshAttention()
      this.onChange()
    }
    // Expanding a pane HIDES its siblings; collapsing reveals them. Either way the set of panes
    // a human can actually see just changed, and an unpaid green pulse may now be payable (or
    // must keep waiting) — refreshAttention re-asks paneIsVisible for every pane.
    layout.onVisibilityChange = () => this.refreshAttention()
    // A real click on a pane — never a programmatic focus. Dismisses a green (grid-layout calls
    // the port directly) and calms the rail's red (here).
    layout.onPaneClick = (paneId) => this.notePaneClicked(paneId)

    // The restored arrangement is already live — it OPENED the grid above. Re-applying it
    // here, with onLayoutChange now wired, is what writes the canonical form (normalized
    // shape + sizes) back into the manifest; the slot set is identical, so no pane is
    // built or torn down by it. Any doubt about the persisted tree (parseTree returned
    // null) falls back to the template grid for the count.
    if (restoredTree) layout.applyTree(restoredTree)
    else layout.apply(meta.paneCount)
    this.publishRoles(meta) // swarm manifest -> role chips + daemon PaneInfo (4/01)

    if (opts.activate !== false) {
      this.switch(meta.id)
      // A user-initiated open of a project directory → touch Home's recents.
      // (Restores pass activate:false, so relaunches don't reshuffle the list.)
      if (meta.cwd) this.onOpened?.(meta)
      getTelemetry().captureEvent({
        name: 'workspace.created',
        props: {
          panes: meta.paneCount,
          agents: (meta.assignments ?? []).filter((a) => a && a !== 'shell').length,
          has_folder: !!meta.cwd // a boolean — never the folder itself
        }
      })
    }
    this.refreshAttention()
    this.onChange()
    return meta
  }

  /**
   * The "Remove worktree" pane verb, whole: close the pane FIRST (its shell lives in
   * the target directory), then remove the worktree via the guarded backend operation.
   * Every stage is journaled into worktreeRemovalEvents — the WORKTREE gate replays
   * this exact sequence and asserts pane-mounted state at each step.
   */
  private async removePaneWorktree(view: WorkspaceView, wsId: string, detail: RemoveWorktreeDetail): Promise<void> {
    this.worktreeRemovalEvents.push({
      paneId: detail.paneId,
      stage: 'request',
      paneStillMounted: view.layout.paneIds().includes(detail.paneId)
    })
    const closed = await this.requestClosePane(wsId, detail.paneId, { replacementCwd: detail.repo })
    this.worktreeRemovalEvents.push({
      paneId: detail.paneId,
      stage: 'pane-closed',
      paneStillMounted: view.layout.paneIds().includes(detail.paneId)
    })
    if (!closed) {
      detail.resolve({ ok: false, reason: 'error', error: 'Pane close was cancelled.' })
      return
    }
    // node-pty exits asynchronously; on Windows its former cwd cannot be removed until
    // the process handle is gone. Retry the same guarded backend operation, bounded.
    let result: RemoveWorktreeResult = { ok: false, reason: 'error' }
    for (let attempt = 0; attempt < 20; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 150))
      this.worktreeRemovalEvents.push({
        paneId: detail.paneId,
        stage: 'remove-attempt',
        attempt: attempt + 1,
        paneStillMounted: view.layout.paneIds().includes(detail.paneId)
      })
      result = (await getBridge().invoke(WorktreeChannels.remove, {
        repo: detail.repo,
        path: detail.path,
        force: detail.force
      })) as RemoveWorktreeResult
      this.worktreeRemovalEvents.push({
        paneId: detail.paneId,
        stage: 'remove-result',
        attempt: attempt + 1,
        paneStillMounted: view.layout.paneIds().includes(detail.paneId),
        ok: result.ok,
        reason: result.reason
      })
      if (result.ok || result.reason !== 'error') break
    }
    detail.resolve(result)
  }

  /** Swarm manifest (4/01): role chips render from the pane-meta port immediately;
   *  the daemon learns roles after its panes exist (spawn is async over the socket),
   *  so `mogging list`/mailbox `from`-roles agree with the UI. */
  private publishRoles(meta: WorkspaceMeta): void {
    if (!meta.roles?.some((r) => r)) return
    meta.roles.forEach((role, i) => {
      if (role) setPaneRole(paneIdForSlot(meta, i + 1) as PaneId, role)
    })
    meta.roles.forEach((role, i) => {
      if (role) void getBridge().invoke(TerminalChannels.setRole, { id: paneIdForSlot(meta, i + 1) as PaneId, role })
    })
  }

  /** Seed each pane's cwd on the pane-cwd port — the reliable default for per-pane git
   *  (2/03). Worktree-isolated slots (3/03) seed their OWN path, so each pane's chip
   *  shows its own branch. OSC 7 later refines a pane's cwd if its shell emits it.
   *  `slots` are the ACTUAL local slot ids to seed (a restored tree may have gaps —
   *  1,3,5 after a middle pane closed); omitted = the dense template ids 1..paneCount. */
  private publishPaneCwds(meta: WorkspaceMeta, slots?: number[]): void {
    for (const i of slots ?? Array.from({ length: meta.paneCount }, (_, k) => k + 1)) {
      // REMOTE slots (4/05) are skipped: a local cwd seed would make the git probe
      // lie about a remote pane. OSC 7 may refine later, honestly.
      if (meta.remotes?.[i - 1]) continue
      const cwd = meta.paneCwds?.[i - 1] || meta.cwd
      if (cwd) setPaneCwd(paneIdForSlot(meta, i) as PaneId, cwd)
    }
  }

  /** Remote manifest (4/05): published BEFORE layout.apply so each TerminalPane can
   *  spawn over ssh and chip its host. Sync by design; no lookups here. */
  private publishRemotes(meta: WorkspaceMeta): void {
    if (!meta.remotes?.some((r) => r)) return
    meta.remotes.forEach((remote, i) => {
      if (remote) {
        setPaneRemote(paneIdForSlot(meta, i + 1) as PaneId, { ...remote, cwd: meta.paneCwds?.[i] ?? undefined })
      }
    })
  }

  /**
   * Settle a workspace's identity color. A restored one is kept — a workspace wears its
   * color for life, across restarts — but it has to earn that: it must still be a color
   * this app owns, and no LIVE workspace may already be wearing it.
   *
   * Both guards are load-bearing on real stores, because both failures are already ON DISK.
   * The old `ordinal % 8` derivation wrote DUPLICATES (a real store: brand orange twice),
   * and states older than the 5/01 recalibration carry retired hexes (`#b5d21b`). Re-
   * allocating in those two cases is what makes the first launch after this change REPAIR
   * the rail rather than faithfully restore the collision it was built to end.
   *
   * The new workspace is not in `views` yet, so `list()` is exactly the set to avoid.
   */
  private claimColor(restored?: string): string {
    const taken = this.list().map((m) => m.color)
    const want = restored?.toLowerCase()
    if (want && isWorkspaceColor(want) && !taken.includes(want)) return want
    return nextColor(taken)
  }

  /** Build one rail item. Root keeps the `.workspace-tab` class + `data-attention`
   *  attribute — the DOM contract of the attention/milestone smokes. */
  private makeTab(meta: WorkspaceMeta): {
    tab: HTMLElement
    activate: HTMLButtonElement
    label: HTMLElement
    attnBadge: HTMLElement
    doneBadge: HTMLElement
    countBadge: HTMLElement
  } {
    // A plain div — NOT role=button. It contains a real close button, and a button inside a
    // button is invalid content whose only observable behaviour was a bug: the wrapper's
    // Enter/Space handler preventDefault()ed the keystroke and switched workspaces, so the
    // close button could never be activated from the keyboard at all (finding 30).
    const tab = document.createElement('div')
    tab.className = 'workspace-tab'
    tab.dataset.wsId = meta.id
    tab.style.setProperty('--ws-accent', meta.color) // the ONE sanctioned inline style
    tab.title = meta.name
    tab.draggable = true

    // Switching is a real button, so Enter/Space/click come free and correct from the
    // platform. It is a SIBLING of the close button, not its ancestor.
    const activate = document.createElement('button')
    activate.className = 'ws-tab-activate'
    activate.type = 'button'

    const iconEl = document.createElement('span')
    iconEl.className = 'ws-icon'
    iconEl.append(icon('terminal', 12))

    const label = document.createElement('span')
    label.className = 'ws-label'
    label.textContent = meta.name
    activate.append(iconEl, label)

    const badges = document.createElement('span')
    badges.className = 'ws-badges'
    // TWO alert counts, split by urgency (explicit direction). Red first: if the tab runs out
    // of room, the one that must survive is the one that means "an agent is waiting on you".
    const attnBadge = document.createElement('span')
    attnBadge.className = 'count-badge count-badge--attention ws-attn'
    attnBadge.hidden = true
    const doneBadge = document.createElement('span')
    doneBadge.className = 'count-badge ws-done'
    doneBadge.hidden = true
    const countBadge = document.createElement('span')
    countBadge.className = 'count-badge ws-count'
    countBadge.textContent = String(meta.paneCount)
    countBadge.title = 'Panes in this workspace'
    const close = document.createElement('button')
    close.className = 'ws-close'
    close.type = 'button'
    close.setAttribute('aria-label', `Close ${meta.name}`)
    close.title = 'Close workspace'
    close.append(icon('x', 12))
    badges.append(attnBadge, doneBadge, countBadge, close)

    tab.append(activate, badges)

    // The WHOLE tab switches, not just the button. `.workspace-tab` is what paints the hover
    // tint and carries `cursor: pointer`, but `.ws-tab-activate` only ever covered the tab's
    // CONTENT box — and the tab is 2px border + 22px padding around a 30px icon (--ws-square =
    // 54px). Collapsed, that made the click target exactly the icon chip inside a square three
    // times its area; expanded, the 12px bands above, below and left of the row were dead the
    // same way. Listening on the wrapper makes the target the lit box itself, with no second
    // geometry to keep in sync with the first.
    // Still click, not mousedown: switching on press meant that merely STARTING a drag-to-
    // reorder switched workspaces. `activate` stays a real button, so Enter/Space still fire a
    // click — it just bubbles to here now, and the keyboard path remains the platform's.
    tab.addEventListener('click', (e) => {
      // The two descendants that own their clicks: the close button (whose handler stops
      // propagation, but whose padding must not switch either) and the rename input, where a
      // click places the caret and must not switch the workspace out from under the edit.
      if (e.target instanceof Element && e.target.closest('.ws-close, .ws-rename')) return
      // A click on the padding must land focus exactly where a click on the button does: the
      // F2 / Delete / Alt+Arrow verbs below are keydown listeners on `tab` and only fire while
      // focus is inside it, and `:focus-within` is what reveals the close button. preventScroll
      // because native mouse focus does not scroll either — this only mirrors it.
      activate.focus({ preventScroll: true })
      this.switch(meta.id)
    })
    // The wrapper keeps only the verbs no button owns. Enter/Space are gone from here on
    // purpose — the two real buttons handle their own activation now.
    tab.addEventListener('keydown', (e) => {
      if (e.key === 'F2') {
        e.preventDefault()
        this.beginRename(meta.id)
      } else if (e.key === 'Delete') {
        e.preventDefault()
        void this.requestClose(meta.id)
      } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        // Reorder was drag-only (finding 31). The rail stacks vertically, so up/down is
        // the same axis the drag already uses.
        e.preventDefault()
        this.moveTab(meta.id, e.key === 'ArrowUp' ? -1 : 1)
      }
    })
    label.addEventListener('dblclick', (e) => {
      e.preventDefault()
      this.beginRename(meta.id)
    })
    close.addEventListener('click', (e) => {
      e.stopPropagation()
      void this.requestClose(meta.id)
    })
    return { tab, activate, label, attnBadge, doneBadge, countBadge }
  }

  /** Move a tab one slot along the rail, keeping focus on it — the keyboard's answer to
   *  drag-to-reorder. Clamped at the ends: a no-op, not a wrap. */
  moveTab(id: string, delta: number): void {
    const from = this.order.indexOf(id)
    if (from < 0) return
    const to = from + delta
    if (to < 0 || to >= this.order.length) return
    this.order.splice(from, 1)
    this.order.splice(to, 0, id)
    const view = this.views.get(id)
    if (!view) return
    const next = this.order[to + 1]
    const before = next ? (this.views.get(next)?.tab ?? null) : null
    this.tabsEl.insertBefore(view.tab, before)
    view.activate.focus() // the moved tab keeps the keyboard, so the next press repeats
    this.onChange()
  }

  /** Inline rename: the activate button steps aside for an input; Enter/blur commits, Esc
   *  cancels. The input used to be appended INSIDE the label — which now lives in a real
   *  button, and an input inside a button is both invalid and unusable (every keystroke
   *  would activate the tab). It replaces the button instead, for the edit's lifetime. */
  beginRename(id: string): void {
    const view = this.views.get(id)
    if (!view || view.tab.querySelector('input.ws-rename')) return
    const input = document.createElement('input')
    input.className = 'ws-rename'
    input.value = view.meta.name
    input.setAttribute('aria-label', 'Workspace name')
    view.activate.hidden = true
    view.activate.before(input)
    input.focus()
    input.select()

    const commit = (save: boolean): void => {
      const next = save ? input.value.trim() : ''
      input.remove()
      view.activate.hidden = false
      if (next && next !== view.meta.name) {
        view.meta.name = next
        view.tab.title = next
        this.onChange()
      }
      view.label.textContent = view.meta.name
    }
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') commit(true)
      if (e.key === 'Escape') commit(false)
    })
    input.addEventListener('blur', () => commit(true))
    input.addEventListener('mousedown', (e) => e.stopPropagation())
  }

  /** Drag-to-reorder rail items (presentation order only — ids/panes are untouched). */
  private wireReorder(): void {
    let draggingId: string | null = null
    this.tabsEl.addEventListener('dragstart', (e) => {
      const tab = (e.target as HTMLElement).closest('.workspace-tab') as HTMLElement | null
      draggingId = tab?.dataset.wsId ?? null
      if (tab && e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', draggingId ?? '')
        tab.classList.add('dragging')
      }
    })
    this.tabsEl.addEventListener('dragover', (e) => {
      if (!draggingId) return
      e.preventDefault()
      const dragging = this.views.get(draggingId)?.tab
      const over = (e.target as HTMLElement).closest('.workspace-tab') as HTMLElement | null
      if (!dragging || !over || over === dragging) return
      const rect = over.getBoundingClientRect()
      const before = e.clientY < rect.top + rect.height / 2
      this.tabsEl.insertBefore(dragging, before ? over : over.nextSibling)
    })
    const finish = (): void => {
      if (!draggingId) return
      this.views.get(draggingId)?.tab.classList.remove('dragging')
      draggingId = null
      const next = Array.from(this.tabsEl.querySelectorAll<HTMLElement>('.workspace-tab'))
        .map((t) => t.dataset.wsId ?? '')
        .filter((id) => this.views.has(id))
      if (next.length === this.order.length) this.order = next
      this.onChange()
    }
    this.tabsEl.addEventListener('drop', (e) => {
      e.preventDefault()
      finish()
    })
    this.tabsEl.addEventListener('dragend', finish)
  }

  switch(id: string, opts: SwitchOpts = {}): void {
    const view = this.views.get(id)
    if (!view) return
    // A workspace whose LAST pane moved to another workspace holds nothing: it exists only
    // until its undo window lapses. Reviving it here would strand the user in an empty grid
    // — and it is reachable (Ctrl+1..9, `mogging` verbs, the palette's stale entry). The
    // toast's Undo brings the pane home FIRST and switches after; that is the only way in.
    if (view.layout.paneCount === 0) return
    // Switching INTO a workspace that is mid-close IS an undo: its panes never stopped
    // running — only its rail tab left. Several paths can still name one: the control API
    // (`mogging focus`/`expand` resolve panes by LIVE id, and a soft-closed workspace's
    // panes are exactly that) and `mogging .` on its folder. Revealing it without
    // cancelling the pending dispose put the user inside a workspace that the grace timer
    // then tore down under them seconds later, snapping to order[0]/Home.
    this.revivePending(id)
    this.activeId = id
    for (const [vid, v] of this.views) {
      const on = vid === id
      v.container.classList.toggle('active', on)
      v.tab.classList.toggle('active', on)
      if (on) v.tab.setAttribute('aria-current', 'true')
      else v.tab.removeAttribute('aria-current')
    }
    const focusId = view.layout.focusedPaneId() ?? view.layout.paneIds()[0]!
    // The pane's OWN cwd (worktree isolation, 3/03), workspace root as the fallback —
    // same contract as the grid's focus callback in `create`.
    setFocusedPane({ paneId: focusId, cwd: getPaneCwd(focusId) || getPaneRemote(focusId)?.cwd || view.meta.cwd })

    // Entering a workspace RE-ARMS every red swell in it. A blocked pane you walked away from
    // without answering asks again the moment you come back (explicit direction) — red has no
    // spent state, because nothing you did unblocked the agent. Green is untouched here: it
    // pulses once, ever, and greenPulsed remembers that across every visit.
    this.attnPulsed.clear()

    this.onChange()
    // User-initiated selection lands in the grid; restore keeps the launcher up.
    // AFTER onChange: the reveal must see the published workspace snapshot — the
    // view port routes an empty grid Home (UX-16), and on the FIRST create the
    // snapshot is empty until onChange publishes it.
    if (opts.reveal !== false) setActiveView('grid')

    // AFTER the reveal, deliberately: refreshAttention is what plays the swells now, and an
    // animation on a display:none subtree never plays at all. It also asks paneIsVisible,
    // which cannot answer honestly until the grid is actually the visible view.
    this.refreshAttention()

    // LANDING ON A FINISHED PANE COUNTS AS CLICKING IT (explicit direction). The switch
    // auto-focuses a pane; if that pane is the one that finished, you are looking straight at
    // it, and asking you to click what you are already reading is ceremony. It still gets its
    // swell — the news is delivered — and then it is acknowledged: dot back to yellow, outline
    // gone, dropped from the rail's done count.
    //
    // This deliberately REVERSES the old rule in grid-layout, whose comment held that the flag
    // "must survive a workspace switch that happens to auto-focus the finished pane". After
    // the swell, not before: acknowledging first would clear `data-alert`, and the swell rides
    // on it — the pane would be dismissed without ever telling you why.
    if (opts.reveal !== false && paneFinished(focusId) && this.paneIsVisible(view, focusId)) {
      const owed = focusId
      window.setTimeout(() => {
        if (this.views.get(id) === view && paneFinished(owed)) acknowledgeFinished(owed)
      }, PULSE_SETTLE_MS)
    }
  }

  /** Destructive primitive. Callers use requestClosePane so live agents are gated. */
  closePane(wsId: string, paneId: number): void {
    const view = this.views.get(wsId)
    if (!view) return
    if (view.layout.paneCount <= 1) {
      this.close(wsId)
      return
    }
    view.layout.closePane(paneId)
    clearPaneLaunch(paneId) // drop its tool-plan signature (8/09)
    view.meta.paneCount = view.layout.paneCount
    getTelemetry().captureEvent({
      name: 'pane.closed',
      props: { remaining: view.meta.paneCount }
    })
    this.refreshAttention()
    this.onChange()
  }

  /** One close policy for pane chrome, shortcuts, control API, and the last pane. */
  async requestClosePane(
    wsId: string,
    paneId: number,
    opts: { replacementCwd?: string } = {}
  ): Promise<boolean> {
    const view = this.views.get(wsId)
    if (!view || !view.layout.paneIds().includes(paneId)) return false
    if (view.layout.paneCount <= 1 && !opts.replacementCwd) {
      await this.requestClose(wsId)
      return true
    }
    const live = inspectLive([paneId])
    if (live.panes.length > 0) {
      // Session and running are separately true, and both can hold: say what this pane
      // actually is, not "an agent session" over a pane that is only a busy plain shell.
      const what = live.sessions.length
        ? live.running.length
          ? 'An agent session is assigned to this pane and is still running.'
          : 'An agent session is assigned to this pane.'
        : 'This pane is still running.'
      const ok = await confirmDialog({
        title: `Close pane ${paneId}?`,
        message: `${what} Closing it stops that work and cannot be undone.`,
        confirmLabel: 'Close pane',
        danger: true
      })
      if (!ok) return false
    }
    if (view.layout.paneCount <= 1 && opts.replacementCwd) {
      this.splitPane(wsId, paneId, 'h', opts.replacementCwd)
      if (view.layout.paneCount <= 1) return false
    }
    this.closePane(wsId, paneId)
    return true
  }

  /**
   * Can a human actually SEE this pane right now? The whole predicate, in one place, because
   * the green pulse is OWED until it is true (explicit direction) and a debt paid against a
   * half-answer is a debt silently forgiven.
   *
   * Three conditions, and the last two are the ones the old code missed. It asked only
   * `active && activeView() === 'grid'` at the MOMENT the flag rose — so an agent finishing
   * while you sat on the Board marked its pulse "seen" and then never played it; you came
   * back to the grid and the news had already been spent. And a pane hidden under an expanded
   * sibling was "visible" by that test while being, literally, not on screen.
   */
  private paneIsVisible(view: WorkspaceView, paneId: PaneId): boolean {
    return view.meta.id === this.activeId && activeView() === 'grid' && view.layout.paneVisible(paneId)
  }

  /**
   * Recompute every pane outline, every rail indicator, and the app-level any-attention flag.
   * ONE pass, off the attention port, so the pane dot, the pane outline and the rail can never
   * disagree — they are all derived here from the same read.
   *
   *  - pane outline (`data-alert`) — the RESTING state: red while blocked, green while
   *    finished-and-unclicked. The pane wears its own status now; it no longer fades to
   *    nothing and leaves a 13px dot to carry the story.
   *  - the swell — how that outline ARRIVES. Red re-pulses on every visit until it is
   *    answered; green pulses once, ever, and only when the pane is truly visible.
   *  - `.ws-attn` / `.ws-done` — the two counts, SPLIT BY URGENCY. Red = panes that need
   *    you, green = panes that finished. A single number could not tell those apart.
   *  - `.is-alerting` — the pulsing orange outline around the whole tab, background tabs
   *    only. LATCHED: once armed it survives everything except focusing the workspace. This
   *    is the ONE indicator that still moves forever, deliberately — the rail is the surface
   *    you are not looking at.
   *  - `.is-working` — the quiet "my agents are running" hint. Not an alert, not a count.
   *  - `data-attention` — the latched attribute (paint-free): the DOM contract the attention
   *    and milestone smokes assert. Unchanged semantics.
   */
  private refreshAttention(): void {
    // The OS-level signal (dock badge on macOS, taskbar flash on Windows/Linux). It carries
    // BOTH kinds now (explicit direction): a completion used to be invisible unless the app was
    // already in front of you, so an agent that finished while you were elsewhere told you
    // nothing at all. Backgrounded workspaces only — you can see the one you are looking at.
    let anyAlert = false
    let attnTotal = 0
    const scanned = new Set<PaneId>()
    for (const view of this.views.values()) {
      if (this.pendingClose.has(view.meta.id)) continue // mid-close: hidden, don't ring
      const active = view.meta.id === this.activeId
      let attnCount = 0
      let doneCount = 0
      let unseen = 0 // alerts that may still arm the rail (a clicked red no longer does)
      let busy = false

      for (const paneId of view.layout.paneIds()) {
        scanned.add(paneId)
        const s: AgentState = paneState(paneId)
        const finished = paneFinished(paneId)
        const visible = this.paneIsVisible(view, paneId)

        if (s === 'attention') {
          attnCount++
          if (!this.seenBlocked.has(paneId)) unseen++
          // Red's swell: once per VISIT. attnPulsed is cleared on every switch, so leaving a
          // blocked pane unanswered and coming back plays it again — the pane keeps asking.
          const owed = visible && !this.attnPulsed.has(paneId)
          if (owed) this.attnPulsed.add(paneId)
          view.layout.setPaneAlert(paneId, 'input', owed)
          continue
        }

        // Not blocked any more: it was answered, or it moved on. Everything that hung off
        // the red goes with it, so the NEXT block starts clean.
        this.attnPulsed.delete(paneId)
        this.seenBlocked.delete(paneId)

        if (finished) {
          doneCount++
          unseen++
          // Green's swell: once, EVER — and it is owed until the pane is genuinely on screen.
          // A completion is news, and news is only new once.
          const owed = visible && !this.greenPulsed.has(paneId)
          if (owed) this.greenPulsed.add(paneId)
          view.layout.setPaneAlert(paneId, 'finished', owed)
          continue
        }

        // Nothing to say. Clear the outline and re-arm the green for this pane's next done.
        this.greenPulsed.delete(paneId)
        view.layout.setPaneAlert(paneId, null)
        if (s === 'busy') busy = true
      }
      attnTotal += attnCount

      // The two counts. Red is urgency, green is news; they never share a badge.
      view.attnBadge.hidden = attnCount === 0
      if (attnCount > 0) {
        view.attnBadge.textContent = String(attnCount)
        view.attnBadge.title = `${attnCount} ${attnCount === 1 ? 'pane needs' : 'panes need'} your input`
      }
      view.doneBadge.hidden = doneCount === 0
      if (doneCount > 0) {
        view.doneBadge.textContent = String(doneCount)
        view.doneBadge.title = `${doneCount} finished working`
      }
      view.countBadge.textContent = String(view.meta.paneCount)

      if (active) view.attentionLatched = false
      else if (attnCount > 0) view.attentionLatched = true
      const indicator = active ? '' : view.attentionLatched ? 'attention' : busy ? 'busy' : ''
      if (indicator) view.tab.dataset.attention = indicator
      else delete view.tab.dataset.attention
      if (!active && (view.attentionLatched || doneCount > 0)) anyAlert = true

      // The outline's LATCH: an UNSEEN alert while backgrounded arms it, and only focusing the
      // workspace disarms it — the alert may not fade on its own, even if the flagged pane
      // starts working again meanwhile. A blocked pane you have already clicked is not unseen,
      // so it no longer drags the tab back into pulsing every time you leave the room.
      if (active) view.alertLatched = false
      else if (unseen > 0) view.alertLatched = true
      view.tab.classList.toggle('is-alerting', !active && (view.alertLatched || unseen > 0))
      // Work in progress, said quietly. Never on the active tab: you can see the grid.
      view.tab.classList.toggle('is-working', !active && busy && !view.alertLatched && unseen === 0)
    }

    // Prune every lifetime set to the panes that still exist. Pane ids are ordinal-derived and
    // REUSED after a workspace closes: a pane disposed mid-alert would otherwise leave its
    // entry behind, and the successor holding that id would read "already pulsed" — its first
    // real edge would never flash.
    for (const set of [this.attnPulsed, this.greenPulsed, this.seenBlocked]) {
      for (const paneId of set) if (!scanned.has(paneId)) set.delete(paneId)
    }

    // A11Y-01: the badges are silent to screen readers — announce when a new pane starts
    // needing input (a rise in the total).
    if (attnTotal > this.lastAttnTotal) {
      announce(`${attnTotal} ${attnTotal === 1 ? 'pane needs' : 'panes need'} your input`)
    }
    this.lastAttnTotal = attnTotal
    this.onAttention?.(anyAlert)
  }

  /** A real click landed on a pane (GridLayout.onPaneClick — never a programmatic focus).
   *  The green is already dismissed on the port; this is the RED half: a blocked pane you
   *  have looked at stops arming the rail. It keeps its red outline and its red dot, because
   *  a click cannot unblock an agent — but the tab stops pulsing about it. */
  private notePaneClicked(paneId: PaneId): void {
    if (paneState(paneId) !== 'attention' || this.seenBlocked.has(paneId)) return
    this.seenBlocked.add(paneId)
    this.refreshAttention()
  }

  /** Switch by rail position (Ctrl/Cmd+1..9). */
  switchByIndex(i: number): void {
    const id = this.order[i]
    if (id) this.switch(id)
  }

  /** The × on a rail tab (WS-01). Closing a workspace disposes every pane in it — so when
   *  a pane holds live work (an agent session, or any command still running), confirm and
   *  say WHICH; idle panes close straight to the 5-second undo grace, no prompt. */
  async requestClose(id: string): Promise<void> {
    const view = this.views.get(id)
    if (!view || this.pendingClose.has(id)) return
    const live = inspectLive(view.layout.paneIds())
    if (live.panes.length > 0) {
      const n = view.meta.paneCount
      const ok = await confirmDialog({
        title: `Close “${view.meta.name}”?`,
        message: `${plural(n, 'pane', 'panes')} will close. ${describeLive(live)}. You’ll have a few seconds to undo.`,
        confirmLabel: 'Close workspace',
        danger: true
        // Bug #8: NO rememberKey. Killing a workspace with live agents is exactly the
        // act that must never be permanently silenceable — it asks every single time.
      })
      if (!ok) return
    }
    this.softClose(id)
  }

  /** Detach a workspace from the rail + view but keep its panes alive; dispose
   *  for real only after the undo window lapses.
   *
   *  `quiet` suppresses the toast — a workspace emptied by its last pane MOVING out is one
   *  action, not two, and the move's own toast undoes the whole of it. `graceMs` lets that
   *  caller hold the window open for exactly as long as its toast does. */
  private softClose(id: string, opts: { quiet?: boolean; graceMs?: number } = {}): void {
    const view = this.views.get(id)
    if (!view) return
    const graceMs = opts.graceMs ?? 5000
    const index = this.order.indexOf(id)
    this.order = this.order.filter((o) => o !== id)
    view.tab.hidden = true
    view.container.classList.remove('active')
    if (this.activeId === id) {
      this.activeId = null
      const nextId = this.order[0]
      if (nextId) this.switch(nextId, { reveal: activeView() === 'grid' })
      else setActiveView('home')
    }
    const timer = setTimeout(() => {
      this.pendingClose.delete(id)
      this.close(id)
    }, graceMs)
    this.pendingClose.set(id, { timer, index })
    this.refreshAttention()
    this.onChange()
    if (opts.quiet) return
    const n = view.meta.paneCount
    showToast({
      title: `Closed “${view.meta.name}”`,
      body: `${n} pane${n === 1 ? '' : 's'} — undo to keep it`,
      timeout: graceMs,
      action: { label: 'Undo', onClick: () => this.undoClose(id) }
    })
  }

  /** Bring a mid-close workspace back — its panes never stopped running (the toast's
   *  Undo; `switch` does the same for anything that navigates INTO one). */
  private undoClose(id: string): void {
    if (!this.revivePending(id)) return
    if (this.activeId === null) this.switch(id) // was on Home (its last workspace) — reveal it
    else {
      this.refreshAttention()
      this.onChange()
    }
  }

  /** Cancel a pending close: stop the dispose timer, put the rail tab and its position
   *  back. Returns false when the workspace was not mid-close (nothing to undo). */
  private revivePending(id: string): boolean {
    const pending = this.pendingClose.get(id)
    const view = this.views.get(id)
    if (!pending || !view) return false
    clearTimeout(pending.timer)
    this.pendingClose.delete(id)
    view.tab.hidden = false
    this.order.splice(Math.min(pending.index, this.order.length), 0, id)
    return true
  }

  close(id: string): void {
    const view = this.views.get(id)
    if (!view) return
    for (const pid of view.layout.paneIds()) clearPaneLaunch(pid) // drop tool-plan sigs (8/09)
    view.layout.dispose() // clears slots -> terminal disposes this workspace's panes
    view.tab.remove()
    view.container.remove()
    this.views.delete(id)
    this.order = this.order.filter((o) => o !== id)
    this.onClosed?.(view.meta)
    getTelemetry().captureEvent({
      name: 'workspace.closed',
      props: { panes: view.meta.paneCount, remaining: this.order.length }
    })
    if (this.activeId === id) {
      this.activeId = null
      const nextId = this.order[0]
      // Only pull the user into the next grid if they were looking at one; closing the
      // last workspace returns to the launcher (the app is launcher-first — no phantom
      // workspace is auto-created).
      if (nextId) this.switch(nextId, { reveal: activeView() === 'grid' })
      else setActiveView('home')
    }
    this.refreshAttention()
    this.onChange()
  }

  /** Apply an N-pane template to the active workspace. */
  applyTemplate(n: number): void {
    const a = this.active()
    if (!a) return
    // Slots this apply will CREATE get the same scrub a split gives its new pane: a
    // template that re-grows over a closed slot's id must not resurrect that slot's
    // remote host (the pane would silently spawn over ssh), swarm role, agent label,
    // or manifest assignment. Same contract as splitPane — a re-opened slot is a fresh
    // plain terminal at the workspace root.
    const live = new Set(a.layout.paneIds())
    for (const { local, paneId } of a.layout.peekTemplate(n)) {
      if (live.has(paneId)) continue
      clearPaneRemote(paneId)
      setPaneRole(paneId, '')
      setPaneLabel(paneId, '')
      this.scrubManifestSlot(a.meta, local - 1, '')
    }
    // Count first, then publish, THEN apply: `apply` constructs any new TerminalPanes, and
    // a pane reads its cwd at spawn time. Published afterwards, a pane added by growing the
    // grid started its shell in the daemon's directory — the same bug `create` had.
    a.meta.paneCount = n
    this.publishPaneCwds(a.meta) // seed the new panes' pty cwd + per-pane git (2/03)
    a.layout.apply(n)
    getTelemetry().captureEvent({ name: 'layout.applied', props: { panes: n } })
    this.refreshAttention()
    this.onChange()
  }

  /** Layout shrink shares the pane-close policy; growth is non-destructive. */
  async requestApplyTemplate(n: number): Promise<boolean> {
    const view = this.active()
    if (!view) return false
    const keep = new Set<number>(view.layout.peekTemplate(n).map((s) => s.paneId))
    const live = inspectLive(view.layout.paneIds().filter((paneId) => !keep.has(paneId)))
    if (live.panes.length > 0) {
      const ok = await confirmDialog({
        title: `Switch to ${plural(n, 'pane', 'panes')}?`,
        message: `${plural(live.panes.length, 'pane', 'panes')} would close. ${describeLive(live)}.`,
        confirmLabel: 'Close panes and apply layout',
        danger: true
      })
      if (!ok) return false
    }
    this.applyTemplate(n)
    return true
  }

  /** Add a terminal by splitting a pane (⋯ menu / titlebar + / palette / shortcut).
   *  `paneId` null → the workspace's focused pane; `dir` omitted → the pane's longer
   *  axis. The receiving LINE re-equalizes (every terminal in it gets an equal share). */
  splitPane(wsId: string, paneId?: number | null, dir?: 'h' | 'v', newCwd?: string): void {
    const view = this.views.get(wsId)
    if (!view) return
    if (view.layout.paneCount >= paneLimit()) {
      showToast({
        title: 'Pane limit reached',
        body: `A workspace holds at most ${paneLimit()} terminals on this screen.`
      })
      return
    }
    const target = paneId ?? view.layout.focusedPaneId()
    if (target == null) return
    // Refuse BEFORE seeding, because the seeds below cannot be taken back: they write the
    // pane-cwd port and the PERSISTED manifest slot for a pane that does not exist yet, and
    // the split underneath still returns null for an id that is not a live leaf — a stale
    // pane id from the ⋯ menu or a `close-pane`d slot named by a ControlCommand. Seeding
    // first left that state behind for a terminal nobody ever created, and the next restore
    // would have read it. The paneLimit() gate above is the only other refusal, and it has
    // already spoken.
    if (!view.layout.paneIds().includes(target as PaneId)) return
    // Seed BEFORE the slot exists (a pane reads its cwd/remote at spawn time): a new
    // terminal is a plain local shell in the split pane's own directory (fallback:
    // the workspace root). Reusing a closed slot's id must never resurrect that
    // slot's remote host or swarm role.
    const newId = view.layout.peekNextPaneId()
    clearPaneRemote(newId)
    setPaneRole(newId, '')
    setPaneLabel(newId, '') // nor the closed slot's agent label ("Claude Code" on a fresh shell)
    // A split always creates a LOCAL terminal. A remote path belongs to the far side and
    // must never be passed to the local spawn; fall back to the workspace root instead.
    // An explicit caller-supplied cwd (already a local path) still wins.
    const targetCwd = getPaneCwdProjection(target as PaneId)
    const cwd = newCwd ?? (targetCwd?.locality === 'local' ? targetCwd.cwd : view.meta.cwd)
    if (cwd) setPaneCwd(newId, cwd)
    this.scrubManifestSlot(view.meta, view.layout.peekNextSlot() - 1, cwd)
    if (view.layout.splitPane(target, dir) == null) return
    getTelemetry().captureEvent({
      name: 'pane.split',
      props: { panes: view.layout.paneCount }
    })
  }

  /** Split the ACTIVE workspace's focused pane (layout menu +, palette, Ctrl+Shift+D). */
  splitActive(dir?: 'h' | 'v'): void {
    const a = this.active()
    if (a) this.splitPane(a.meta.id, a.layout.focusedPaneId(), dir)
  }

  /** Split the ACTIVE workspace's focused pane into a fresh ISOLATED git worktree
   *  (layout-menu row only — Ctrl+Shift+D stays a plain split by design). Same 3/03
   *  contract as the wizard: the worktree is created FIRST; a refusal opens nothing.
   *  The repo is the workspace root, not the focused pane's cwd — a worktree of a
   *  worktree would nest managed dirs inside each other. */
  async splitActiveIsolated(dir?: 'h' | 'v'): Promise<boolean> {
    const a = this.active()
    if (!a) return false
    const repo = a.meta.cwd
    if (!repo) {
      showToast({ tone: 'attention', title: 'No workspace folder', body: 'Isolation needs a git repository to branch from.' })
      return false
    }
    try {
      // Same honesty as the wizard's checkbox: refuse a non-repo (or a folder whose
      // `.git` git itself cannot read) BEFORE touching the filesystem.
      const isRepo = (await getBridge().invoke(GitChannels.query, repo)) != null
      if (!isRepo) {
        showToast({
          tone: 'attention',
          title: 'Not a git repository',
          body: 'Run `git init` in the workspace folder (or open a repo) to isolate terminals in worktrees.'
        })
        return false
      }
      const wt = (await getBridge().invoke(WorktreeChannels.create, { repo })) as CreateWorktreeResult
      if (!wt.ok || !wt.path) {
        showToast({ tone: 'attention', title: 'Could not create a worktree', body: wt.error || 'git refused.' })
        return false
      }
      this.splitPane(a.meta.id, a.layout.focusedPaneId(), dir, wt.path)
      return true
    } catch (error) {
      showToast({
        tone: 'attention',
        title: 'Could not create a worktree',
        body: error instanceof Error ? error.message : String(error)
      })
      return false
    }
  }

  /** Reusing slot `i` for a fresh plain terminal: the persisted manifest must agree,
   *  or the next restore would resurrect the OLD slot's agent/role/remote there. */
  private scrubManifestSlot(meta: WorkspaceMeta, i: number, cwd: string): void {
    if (i < 0) return
    if (meta.assignments && i < meta.assignments.length) meta.assignments[i] = 'shell'
    if (meta.roles && i < meta.roles.length) meta.roles[i] = null
    if (meta.remotes && i < meta.remotes.length) meta.remotes[i] = null
    if (meta.profileIds && i < meta.profileIds.length) meta.profileIds[i] = null
    // A per-pane cwd that differs from the workspace root (an isolated-worktree split)
    // must SURVIVE restore, even on a workspace that never had a paneCwds manifest —
    // grow the array instead of silently dropping the override.
    if (cwd && cwd !== meta.cwd) {
      meta.paneCwds = meta.paneCwds ?? []
      while (meta.paneCwds.length <= i) meta.paneCwds.push(null)
      meta.paneCwds[i] = cwd
    } else if (meta.paneCwds && i < meta.paneCwds.length) {
      meta.paneCwds[i] = cwd || null
    }
  }

  // ── Move a pane to another workspace ─────────────────────────────────────────────────
  //
  // The pane KEEPS ITS ID, and everything else follows from that. A pane id is its daemon
  // session key: it is what the PTY is filed under, what the agent's own MOGGING_PANE_ID env
  // says (so a `mogging notify` from inside it still raises THIS pane), and what every port
  // in the renderer — cwd, agent session, attention, claims, context gauge — is keyed by.
  // Re-keying it would mean killing that shell and spawning another, which is not a move: it
  // is a re-creation with the running agent destroyed. So the id stays; the workspace records
  // which of its slots now holds it (WorkspaceMeta.paneIds); and the pane's own DOM element —
  // xterm, WebGL canvas, scrollback and all — is RE-PARENTED from one grid into the other.
  // The pane is never rebuilt, so there is nothing for it to notice.
  //
  // The one hazard is the slots port: the terminal feature disposes — and kills the PTY of —
  // every pane id missing from the AGGREGATE slot set. The source's republish and the
  // destination's therefore have to land as a single edit, which is what `batchSlots` is for.
  // Between them the pane belongs to neither workspace, and that instant must not be observable.

  /** Every workspace this pane could move to: all of them but its own (moving it where it
   *  already is isn't a choice). Full ones are included and marked — see MoveTarget. */
  moveTargets(paneId: number): MoveTarget[] {
    const home = this.viewForPane(paneId)
    if (!home) return []
    return this.order
      .filter((id) => id !== home.meta.id && !this.pendingClose.has(id))
      .map((id) => this.views.get(id))
      .filter((v): v is WorkspaceView => !!v)
      .map((v) => ({
        id: v.meta.id,
        name: v.meta.name,
        color: v.meta.color,
        cwd: v.meta.cwd,
        paneCount: v.layout.paneCount,
        full: v.layout.paneCount >= paneLimit()
      }))
  }

  /** Pane ⋯ menu → the destination picker → the move. */
  offerMovePane(paneId: number, paneTitle: string): void {
    const targets = this.moveTargets(paneId)
    if (!targets.length) {
      showToast({
        tone: 'attention',
        title: 'Nowhere to move it',
        body: 'This is your only workspace — make another one first (Ctrl+T).'
      })
      return
    }
    openMovePaneModal({
      paneTitle,
      targets,
      onConfirm: (dstId) => void this.movePaneToWorkspace(paneId, dstId)
    })
  }

  /** Carry a LIVE pane into another workspace: same terminal, same process, same agent. */
  movePaneToWorkspace(paneId: number, dstId: string): boolean {
    const src = this.viewForPane(paneId)
    const dst = this.views.get(dstId)
    if (!src || !dst || src === dst || this.pendingClose.has(dstId)) return false
    if (dst.layout.paneCount >= paneLimit()) {
      showToast({
        tone: 'attention',
        title: 'That workspace is full',
        body: `“${dst.meta.name}” already holds ${paneLimit()} terminals.`
      })
      return false
    }
    const srcSlot = src.layout.slotOf(paneId)
    if (srcSlot == null) return false

    // Everything an undo needs, read BEFORE anything moves: the source's exact arrangement
    // (the seams the user dragged, not merely an equivalent grid) and the pane's manifest row.
    const srcTree = src.layout.snapshotTree()
    const manifest = this.takeManifestSlot(src.meta, srcSlot)
    const srcName = src.meta.name
    // Its LAST pane: a split tree has no empty shape, so the workspace leaves with it. That is
    // the policy CLOSING this pane would already have followed (requestClosePane hands the
    // last one to requestClose), and the undo below puts the workspace back with the pane.
    const emptiesSource = src.layout.paneCount <= 1

    const moved = batchSlots(() => {
      const el = src.layout.detachPane(paneId)
      if (!el) return null
      const dstSlot = dst.layout.adoptPane(el, paneId, { near: dst.layout.focusedPaneId() })
      if (dstSlot == null) {
        // Refused (it could only have filled up in a race). Put the pane straight back, still
        // inside the batch — the aggregate slot set never lost it, so nothing was disposed.
        src.layout.readoptPane(el, paneId, srcSlot, srcTree)
        return null
      }
      return { dstSlot }
    })
    if (!moved) {
      this.putManifestSlot(src.meta, srcSlot, manifest)
      return false
    }
    this.putManifestSlot(dst.meta, moved.dstSlot, manifest)
    if (emptiesSource) this.softClose(src.meta.id, { quiet: true, graceMs: TOAST_DEFAULT_MS })

    // Land on the moved pane, in its new home — you asked for it to be there, so go there.
    this.switch(dstId)
    dst.layout.focusPane(paneId)
    getTelemetry().captureEvent({
      name: 'pane.moved.workspace',
      props: { emptied_source: emptiesSource, panes: dst.layout.paneCount }
    })
    this.refreshAttention()
    this.onChange()

    showToast({
      title: `Moved to “${dst.meta.name}”`,
      body: emptiesSource
        ? `“${srcName}” had no other terminals and closed with it.`
        : `It never stopped running — the agent came with it.`,
      // The toast IS the undo window: the source workspace's dispose grace above is set to
      // the same duration, so the button cannot outlive what it promises to reverse.
      action: {
        label: 'Undo',
        onClick: () => this.undoMovePane({ paneId, srcId: src.meta.id, srcSlot, srcTree, dstId, manifest })
      }
    })
    return true
  }

  /** Put the pane back where it came from — the exact inverse, arrangement included. */
  private undoMovePane(m: {
    paneId: number
    srcId: string
    srcSlot: number
    srcTree: LayoutTreeNode
    dstId: string
    manifest: PaneManifest
  }): void {
    const src = this.views.get(m.srcId)
    const dst = this.views.get(m.dstId)
    // The source can be GONE: when the move emptied it, its dispose grace and this toast run
    // out together, and a click can land on the wrong side of that. Say so — never half-undo.
    if (!src || !dst) {
      showToast({
        tone: 'attention',
        title: 'Too late to undo',
        body: 'That workspace has already closed.'
      })
      return
    }
    const dstSlot = dst.layout.slotOf(m.paneId)
    this.revivePending(m.srcId) // if the move emptied it, the workspace comes back first
    const ok = batchSlots(() => {
      const el = dst.layout.detachPane(m.paneId)
      if (!el) return false
      src.layout.readoptPane(el, m.paneId, m.srcSlot, m.srcTree)
      return true
    })
    if (!ok) return
    if (dstSlot != null) this.takeManifestSlot(dst.meta, dstSlot)
    this.putManifestSlot(src.meta, m.srcSlot, m.manifest)
    this.switch(m.srcId)
    src.layout.focusPane(m.paneId)
    this.refreshAttention()
    this.onChange()
  }

  /** Lift a pane's manifest row out of a workspace, blanking the slot behind it. */
  private takeManifestSlot(meta: WorkspaceMeta, slot: number): PaneManifest {
    const i = slot - 1
    const taken: PaneManifest = {
      assignment: meta.assignments?.[i],
      paneCwd: meta.paneCwds?.[i],
      role: meta.roles?.[i],
      remote: meta.remotes?.[i],
      profileId: meta.profileIds?.[i]
    }
    this.scrubManifestSlot(meta, i, '')
    return taken
  }

  /** ...and write it into the destination's slot, growing each array to reach it. An array
   *  that does not exist yet is only created when there is something to put in it: a plain
   *  shell moving into a plain workspace must not invent a manifest for either of them. */
  private putManifestSlot(meta: WorkspaceMeta, slot: number, m: PaneManifest): void {
    const i = slot - 1
    if (i < 0) return
    const put = <T>(arr: T[] | undefined, value: T, blank: T): T[] | undefined => {
      if (!arr && value === blank) return arr
      const next = arr ?? []
      while (next.length <= i) next.push(blank)
      next[i] = value
      return next
    }
    meta.assignments = put(meta.assignments, m.assignment ?? 'shell', 'shell')
    meta.paneCwds = put(meta.paneCwds, m.paneCwd ?? null, null)
    meta.roles = put(meta.roles, m.role ?? null, null)
    meta.remotes = put(meta.remotes, m.remote ?? null, null)
    meta.profileIds = put(meta.profileIds, m.profileId ?? null, null)
  }

  activePaneCount(): number {
    return this.active()?.layout.paneCount ?? 1
  }

  /** DEV smoke testimony for the destructive ordering invariant. */
  worktreeRemovalAudit(): ReadonlyArray<Readonly<(typeof this.worktreeRemovalEvents)[number]>> {
    return this.worktreeRemovalEvents.map((event) => ({ ...event }))
  }

  /** Failover switched a pane's profile (6/04): rewrite that SLOT in the manifest
   *  so the next restore relaunches on the surviving profile instead of
   *  resurrecting the capped one. Returns whether a workspace owned the pane —
   *  the caller persists (once per failover event; ids only, ADR 0002). */
  noteProfileFailover(paneId: number, profileId: string): boolean {
    // By LIVE pane id, not a paneCount range check: slot ids can exceed paneCount after
    // a middle pane closed (live ids 1,3,5 with count 3), and the range check silently
    // dropped the failover note for exactly those slots.
    const view = this.viewForPane(paneId)
    if (!view) return false
    const slot = view.layout.slotOf(paneId)
    if (slot == null) return false
    const ids = view.meta.profileIds ?? []
    while (ids.length < slot) ids.push(null)
    ids[slot - 1] = profileId
    view.meta.profileIds = ids
    return true
  }

  /** An agent was launched into a pane by any app path — palette, pane ⋯ menu, board
   *  card, wizard lineup, failover relaunch: record it as that SLOT's assignment so
   *  every future restore (app relaunch, daemon cold start, and the cross-protocol
   *  update migration) relaunches it with resume. The LAUNCH cwd is recorded with it:
   *  the session log is keyed on where the CLI started (context feature), and a pane
   *  whose live cwd had drifted from its seeded slot cwd — a split pane, a shell the
   *  user cd'd — would otherwise adopt-watch the wrong project dir after restore.
   *  Creation lineups re-announce the values they were created with, so recording is
   *  idempotent — the return value says whether anything actually changed (the caller
   *  persists only then). */
  noteAgentLaunch(paneId: number, provider: string, profileId?: string, cwd?: string): boolean {
    if (!provider || provider === 'shell') return false
    const view = this.viewForPane(paneId)
    if (!view) return false
    const slot = view.layout.slotOf(paneId)
    if (slot == null) return false
    const assignments = view.meta.assignments ?? []
    let changed = false
    while (assignments.length < slot) assignments.push('shell')
    if (assignments[slot - 1] !== provider) {
      assignments[slot - 1] = provider
      changed = true
    }
    view.meta.assignments = assignments
    if (profileId) {
      const ids = view.meta.profileIds ?? []
      while (ids.length < slot) ids.push(null)
      if (ids[slot - 1] !== profileId) {
        ids[slot - 1] = profileId
        changed = true
      }
      view.meta.profileIds = ids
    }
    if (cwd && view.meta.remotes?.[slot - 1]) {
      const remote = view.meta.remotes[slot - 1]!
      if (remote.cwd !== cwd) {
        remote.cwd = cwd
        changed = true
      }
    } else if (cwd) {
      const cwds = view.meta.paneCwds ?? []
      while (cwds.length < slot) cwds.push(null)
      if (cwds[slot - 1] !== cwd) {
        cwds[slot - 1] = cwd
        changed = true
      }
      view.meta.paneCwds = cwds
    }
    return changed
  }

  /** Project a pane cwd into focus state and, for explicit agent declarations only,
   *  persist it as that slot's restore/relaunch worktree. Returns whether persistence
   *  changed; focus refreshes are intentionally independent from manifest writes. */
  notePaneCwd(paneId: number, cwd: string, persistSlot: boolean): boolean {
    if (!cwd) return false
    const view = this.viewForPane(paneId)
    if (!view) return false

    if (this.activeId === view.meta.id && view.layout.focusedPaneId() === paneId) {
      setFocusedPane({ paneId: paneId as PaneId, cwd })
    }
    if (!persistSlot) return false

    const slot = view.layout.slotOf(paneId)
    if (slot == null) return false
    const remote = view.meta.remotes?.[slot - 1]
    if (remote) {
      if (remote.cwd === cwd) return false
      remote.cwd = cwd
      return true
    }

    const cwds = view.meta.paneCwds ?? []
    while (cwds.length < slot) cwds.push(null)
    if (cwds[slot - 1] === cwd) return false
    cwds[slot - 1] = cwd
    view.meta.paneCwds = cwds
    return true
  }

  /** Keyboard pane navigation within the active workspace (Ctrl/Cmd+Alt+arrows). */
  focusDir(dir: 'left' | 'right' | 'up' | 'down'): void {
    this.active()?.layout.focusDir(dir)
  }

  /** The workspace whose grid currently hosts a pane id (live panes only). */
  private viewForPane(paneId: number): WorkspaceView | null {
    for (const v of this.views.values()) {
      if (v.layout.paneIds().includes(paneId as PaneId)) return v
    }
    return null
  }

  /** Control API (Phase-3/02): focus a pane anywhere — switches to its workspace. */
  focusPane(paneId: number): void {
    const v = this.viewForPane(paneId)
    if (!v) return
    this.switch(v.meta.id)
    v.layout.focusPane(paneId)
  }

  /** Control API: toggle an expand mode on a pane anywhere. */
  expandPaneById(paneId: number, mode: 'full' | 'col' | 'row'): void {
    const v = this.viewForPane(paneId)
    if (!v) return
    this.switch(v.meta.id)
    v.layout.toggleExpand(paneId, mode)
  }

  /** Control API: close a pane anywhere (last pane closes its workspace). */
  closePaneById(paneId: number): void {
    const v = this.viewForPane(paneId)
    if (v) void this.requestClosePane(v.meta.id, paneId)
  }

  /** Zoom/restore the active workspace's focused pane (Ctrl/Cmd+Shift+Enter). */
  toggleZoom(): void {
    this.active()?.layout.toggleZoom()
  }

  /** Toggle an expand mode on a specific pane of the active workspace. */
  expandPane(paneId: number, mode: 'full' | 'col' | 'row'): void {
    this.active()?.layout.toggleExpand(paneId, mode)
  }

  /** Live pane ids of the active workspace (closed slots excluded). */
  activePaneIds(): number[] {
    return (this.active()?.layout.paneIds() ?? []) as number[]
  }

  /** Focus an existing workspace for `cwd`, or create one (the `mogging .` entry point). */
  openForCwd(cwd: string): WorkspaceMeta {
    for (const v of this.views.values()) {
      if (v.meta.cwd && v.meta.cwd === cwd) {
        this.switch(v.meta.id)
        this.onOpened?.(v.meta) // working on this project again → refresh recents
        return v.meta
      }
    }
    const name = cwd ? cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || 'Workspace' : undefined
    return this.create({ cwd, name })
  }

  /** Open a workspace from a template spec (06b): the resolved grid + its lineup. */
  openFromTemplate(spec: TemplateWorkspaceSpec): WorkspaceMeta {
    const meta = this.create({
      id: spec.id,
      name: spec.name,
      cwd: spec.cwd,
      paneCount: spec.paneCount,
      assignments: spec.assignments,
      paneCwds: spec.paneCwds,
      roles: spec.roles,
      remotes: spec.remotes,
      profileIds: spec.profileIds,
      // The painter's arrangement (merged cells included) — create() parses it with
      // the same parseTree gate the restore path uses; invalid falls back to the grid.
      layout: spec.layout
    })
    this.launchLineup(meta.id, false)
    return meta
  }

  /** Launch each non-shell pane's assigned CLI (06b). Delayed so the panes' PTYs are
   *  spawned and ready. `resume` re-launches the lineup on restore. Worktree-isolated
   *  slots (3/03) launch at their OWN cwd — the agent cd's into its worktree. */
  launchLineup(id: string, resume: boolean): void {
    const view = this.views.get(id)
    const assignments = view?.meta.assignments
    if (!view || !assignments) return
    const meta = view.meta
    setTimeout(() => {
      // Only into panes that EXIST: slot ids are sparse after closes (live 1,3,5), and
      // assignment arrays can name slots the layout no longer has — a launch typed at a
      // nonexistent pane id is at best lost, at worst delivered to a future pane.
      const live = new Set<number>(view.layout.paneIds())
      assignments.forEach((provider, i) => {
        const paneId = paneIdForSlot(meta, i + 1)
        if (provider && provider !== 'shell' && live.has(paneId)) {
          const remote = meta.remotes?.[i]
          const cwd = remote ? (remote.cwd ?? '') : (meta.paneCwds?.[i] || meta.cwd)
          requestAgentLaunch({
            paneId: paneId as PaneId,
            provider,
            cwd,
            resume,
            profileId: meta.profileIds?.[i] ?? undefined
          })
        }
      })
    }, 900)
  }
}
