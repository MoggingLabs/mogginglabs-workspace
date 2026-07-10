import { TerminalChannels } from '@contracts'
import type { AgentState, PaneId } from '@contracts'
import { getBridge } from '../../core/ipc/bridge'
import { GridLayout, MAX_PANES, parseTree, leafIds } from '../layout'
import { confirmDialog, icon, showToast } from '../../components'
import { setFocusedPane } from '../../core/layout/focus'
import { setPaneCwd, getPaneCwd } from '../../core/layout/pane-cwd'
import { setPaneRole, setPaneRemote, clearPaneRemote, setPaneLabel } from '../../core/layout/pane-meta'
import { paneState, paneFinished, onAttentionChange } from '../../core/attention/attention-port'
import { announce } from '../../core/a11y/live-region'
import { clearPaneLaunch } from '../../core/agents/toolplan-panes'
import { requestAgentLaunch } from '../../core/agents/launch-port'
import { activeView, setActiveView } from '../../core/shell/view-port'
import { getTelemetry } from '../../core/telemetry'
import type { TemplateWorkspaceSpec } from '../../core/workspace/open-service'
import { type WorkspaceMeta, colorForOrdinal, newWorkspaceId } from './model'

interface WorkspaceView {
  meta: WorkspaceMeta
  tab: HTMLElement
  label: HTMLElement
  attnBadge: HTMLElement
  countBadge: HTMLElement
  container: HTMLElement
  layout: GridLayout
  attentionLatched: boolean
  /** The rail outline's latch: ANY alert (blocked or finished) while backgrounded
   *  holds the orange outline until this workspace is focused — nothing else may
   *  clear it (spec: "disappears only once I view and select that workspace"). */
  alertLatched: boolean
}

export interface CreateOpts {
  id?: string
  name?: string
  cwd?: string
  ordinal?: number
  paneCount?: number
  activate?: boolean
  assignments?: string[]
  paneCwds?: (string | null)[]
  roles?: (string | null)[]
  /** Per-slot remote hosts (Phase-4/05). null = local. Name is display data. */
  remotes?: ({ hostId: string; name: string } | null)[]
  profileIds?: (string | null)[]
  /** Serialized split-tree layout (shape + sizes). Absent/invalid → the template
   *  grid for `paneCount` — a bad persisted row can never wedge a restore. */
  layout?: string | null
}

export interface SwitchOpts {
  /** Reveal the grid view (default). Restore passes false so boot stays on Home. */
  reveal?: boolean
}

/**
 * Owns the set of workspaces: one rail item + one hidden/visible container + one
 * `GridLayout` each. Switching is pure show/hide (every workspace's panes stay mounted
 * and streaming). The rail item carries the Phase-2 signature: a live NUMERIC alert
 * count — panes needing attention plus panes finished-while-backgrounded — next to a
 * quiet pane-count, plus the latched attention attribute (`data-attention`, the
 * contract the attention/milestone smokes assert). Emits `onChange` after any
 * mutation (used to persist + publish the info port).
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
  private readonly attnSeen = new Set<PaneId>() // panes mid-attention-episode (one pulse each)
  // The sticky finished flag lives on the attention PORT (single source of truth,
  // set on the busy/attention→idle edge, cleared only by a CLICK on the pane or by
  // new work). The controller layers two lifetimes on top of it:
  //   finSeen    flag-episodes already processed — one green pulse each, attnSeen's
  //              twin (a chatty refresh must not re-flash).
  //   finWsSeen  the flag was up while its workspace was FOCUSED: viewing the
  //              workspace consumes the rail alert (badge count + outline), while
  //              the pane's own green dot lives on until the pane is clicked.
  // Both are pruned to the panes actually scanned — pane ids are ordinal-derived
  // and REUSED after a workspace closes, so a stale entry would corrupt a new one.
  private readonly finSeen = new Set<PaneId>()
  private readonly finWsSeen = new Set<PaneId>()

  constructor(
    private readonly tabsEl: HTMLElement,
    private readonly hostEl: HTMLElement,
    private readonly onChange: () => void,
    private readonly onAttention?: (anyAttention: boolean) => void,
    private readonly onClosed?: (meta: WorkspaceMeta) => void,
    private readonly onOpened?: (meta: WorkspaceMeta) => void
  ) {
    onAttentionChange(() => this.refreshAttention())
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
      color: colorForOrdinal(ordinal),
      cwd: opts.cwd ?? '',
      ordinal,
      paneCount: opts.paneCount ?? 1,
      assignments: opts.assignments,
      paneCwds: opts.paneCwds,
      roles: opts.roles,
      remotes: opts.remotes,
      profileIds: opts.profileIds,
      layout: opts.layout ?? undefined
    }

    // Parsed BEFORE the seeds are published: persisted trees keep their REAL slot ids
    // (gaps included — a workspace that closed a middle pane restores 1,3,5, not 1,2,3),
    // and the cwd seeding below must cover exactly those slots.
    const restoredTree = opts.layout ? parseTree(opts.layout, meta.paneCount) : null
    const slots = restoredTree ? leafIds(restoredTree) : undefined

    // BEFORE the grid exists, not merely before `apply`: GridLayout's constructor applies a
    // 1-pane grid, which synchronously constructs pane 1's TerminalPane — and a pane reads
    // its remote + cwd seeds at spawn time. Published after construction, pane 1 (and only
    // pane 1) spawned locally at the daemon's fallback cwd: a worktree-isolated slot 1
    // opened its shell in $HOME while its branch chip claimed mogging/<slug>.
    this.publishRemotes(meta)
    this.publishPaneCwds(meta, slots) // seed the pty's cwd + per-pane git (2/03)

    const container = document.createElement('div')
    container.className = 'workspace-view'
    this.hostEl.append(container)
    const layout = new GridLayout(container, meta.id, ordinal * 100, (paneId) =>
      // The pane's OWN cwd (worktree isolation, 3/03; OSC-7 refined), not the workspace
      // root: "launch in focused pane" and "review focused pane" act on this value, and
      // the root made both escape the pane's worktree.
      setFocusedPane({ paneId, cwd: getPaneCwd(paneId) || meta.cwd })
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
      if (paneId != null) this.closePane(meta.id, paneId)
    })
    // Pane ⋯ menu "Split right/down" bubbles here — the controller (not the grid)
    // owns splits, because the new pane's cwd must be seeded before its slot exists.
    container.addEventListener('mogging:split-pane', (e) => {
      const d = (e as CustomEvent<{ paneId: number; dir: 'h' | 'v' }>).detail
      if (d) this.splitPane(meta.id, d.paneId, d.dir)
    })

    // Any layout mutation (template, split, close, seam resize, drag-rearrange) keeps
    // the persisted manifest true: pane count + the serialized split tree.
    layout.onLayoutChange = () => {
      meta.paneCount = layout.paneCount
      meta.layout = layout.serialize()
      this.refreshAttention()
      this.onChange()
    }

    // A restored workspace re-applies its exact arrangement (shape + sizes); any
    // doubt about the persisted tree falls back to the template grid for the count.
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

  /** Swarm manifest (4/01): role chips render from the pane-meta port immediately;
   *  the daemon learns roles after its panes exist (spawn is async over the socket),
   *  so `mogging list`/mailbox `from`-roles agree with the UI. */
  private publishRoles(meta: WorkspaceMeta): void {
    if (!meta.roles?.some((r) => r)) return
    const base = meta.ordinal * 100
    meta.roles.forEach((role, i) => {
      if (role) setPaneRole((base + i + 1) as PaneId, role)
    })
    const roles = meta.roles
    setTimeout(() => {
      roles.forEach((role, i) => {
        if (role) getBridge().send(TerminalChannels.setRole, { id: (base + i + 1) as PaneId, role })
      })
    }, 1200)
  }

  /** Seed each pane's cwd on the pane-cwd port — the reliable default for per-pane git
   *  (2/03). Worktree-isolated slots (3/03) seed their OWN path, so each pane's chip
   *  shows its own branch. OSC 7 later refines a pane's cwd if its shell emits it.
   *  `slots` are the ACTUAL local slot ids to seed (a restored tree may have gaps —
   *  1,3,5 after a middle pane closed); omitted = the dense template ids 1..paneCount. */
  private publishPaneCwds(meta: WorkspaceMeta, slots?: number[]): void {
    const base = meta.ordinal * 100
    for (const i of slots ?? Array.from({ length: meta.paneCount }, (_, k) => k + 1)) {
      // REMOTE slots (4/05) are skipped: a local cwd seed would make the git probe
      // lie about a remote pane. OSC 7 may refine later, honestly.
      if (meta.remotes?.[i - 1]) continue
      const cwd = meta.paneCwds?.[i - 1] || meta.cwd
      if (cwd) setPaneCwd((base + i) as PaneId, cwd)
    }
  }

  /** Remote manifest (4/05): published BEFORE layout.apply so each TerminalPane can
   *  spawn over ssh and chip its host. Sync by design; no lookups here. */
  private publishRemotes(meta: WorkspaceMeta): void {
    if (!meta.remotes?.some((r) => r)) return
    const base = meta.ordinal * 100
    meta.remotes.forEach((remote, i) => {
      if (remote) setPaneRemote((base + i + 1) as PaneId, remote)
    })
  }

  /** Build one rail item. Root keeps the `.workspace-tab` class + `data-attention`
   *  attribute — the DOM contract of the attention/milestone smokes. */
  private makeTab(meta: WorkspaceMeta): {
    tab: HTMLElement
    label: HTMLElement
    attnBadge: HTMLElement
    countBadge: HTMLElement
  } {
    const tab = document.createElement('div')
    tab.className = 'workspace-tab'
    tab.dataset.wsId = meta.id
    tab.style.setProperty('--ws-accent', meta.color) // the ONE sanctioned inline style
    tab.setAttribute('role', 'button')
    tab.tabIndex = 0
    tab.title = meta.name
    tab.draggable = true

    const iconEl = document.createElement('span')
    iconEl.className = 'ws-icon'
    iconEl.append(icon('terminal', 12))

    const label = document.createElement('span')
    label.className = 'ws-label'
    label.textContent = meta.name

    const badges = document.createElement('span')
    badges.className = 'ws-badges'
    const attnBadge = document.createElement('span')
    attnBadge.className = 'count-badge count-badge--attention ws-attn'
    attnBadge.hidden = true
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
    badges.append(attnBadge, countBadge, close)

    tab.append(iconEl, label, badges)

    tab.addEventListener('mousedown', (e) => {
      if (!(e.target instanceof Node) || !close.contains(e.target)) this.switch(meta.id)
    })
    tab.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        this.switch(meta.id)
      } else if (e.key === 'F2') {
        e.preventDefault()
        this.beginRename(meta.id)
      } else if (e.key === 'Delete') {
        e.preventDefault()
        this.close(meta.id)
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
    return { tab, label, attnBadge, countBadge }
  }

  /** Inline rename: swap the label for an input; Enter/blur commits, Esc cancels. */
  beginRename(id: string): void {
    const view = this.views.get(id)
    if (!view || view.label.querySelector('input')) return
    const input = document.createElement('input')
    input.className = 'ws-rename'
    input.value = view.meta.name
    input.setAttribute('aria-label', 'Workspace name')
    view.label.textContent = ''
    view.label.append(input)
    input.focus()
    input.select()

    const commit = (save: boolean): void => {
      const next = save ? input.value.trim() : ''
      input.remove()
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
    this.activeId = id
    for (const [vid, v] of this.views) {
      const on = vid === id
      v.container.classList.toggle('active', on)
      v.tab.classList.toggle('active', on)
      if (on) v.tab.setAttribute('aria-current', 'true')
      else v.tab.removeAttribute('aria-current')
    }
    const focusId = view.layout.focusedPaneId() ?? ((view.meta.ordinal * 100 + 1) as PaneId)
    // The pane's OWN cwd (worktree isolation, 3/03), workspace root as the fallback —
    // same contract as the grid's focus callback in `create`.
    setFocusedPane({ paneId: focusId, cwd: getPaneCwd(focusId) || view.meta.cwd })
    // Panes owed a green replay: sticky finished flags on the PORT — cleared only
    // by a real click on the pane, so re-entering this workspace keeps replaying
    // the green pulse until each finished pane has actually been acknowledged.
    const finishedToPulse = view.layout.paneIds().filter((p) => paneFinished(p))
    this.refreshAttention() // activating a workspace clears its alert (you're looking at it)
    this.onChange()
    // User-initiated selection lands in the grid; restore keeps the launcher up.
    // AFTER onChange: the reveal must see the published workspace snapshot — the
    // view port routes an empty grid Home (UX-16), and on the FIRST create the
    // snapshot is empty until onChange publishes it.
    if (opts.reveal !== false) {
      setActiveView('grid')
      // The outline the switch just cleared hands off INSIDE the grid: every alerting
      // pane flashes once in its status color — green = finished while you were away,
      // red = still blocked on you — so opening the workspace answers "which pane
      // called me?" without scanning dots. Finished pulses first: a pane somehow owed
      // both replays as red, blocked outranks done. AFTER the reveal — an animation
      // on a display:none subtree never plays.
      for (const paneId of finishedToPulse) view.layout.pulseAttention(paneId, 'finished')
      for (const paneId of view.layout.paneIds()) {
        if (paneState(paneId) === 'attention') view.layout.pulseAttention(paneId, 'input')
      }
    }
  }

  /** Close one pane of a workspace; closing its last pane closes the workspace. */
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

  /**
   * Recompute every rail item's indicators + the app-level any-attention flag.
   *  - `.ws-attn`  — LIVE numeric alert count: panes currently needing attention (the
   *    Phase-2 signature) PLUS panes holding an unacknowledged finished flag this
   *    workspace hasn't been focused over yet. Focusing the workspace consumes the
   *    finished half of the COUNT (finWsSeen); the flag itself — and the pane's
   *    green dot — lives on until the pane is clicked (port acknowledge).
   *  - `.is-alerting` — the ANIMATED orange outline around the whole bar, on
   *    background tabs. LATCHED (alertLatched): once armed it survives everything
   *    except focusing the workspace — the spec's "disappears only once I view it".
   *  - pane pulses — a finished flag rising in the ACTIVE workspace pulses that pane
   *    green right here (finSeen = one pulse per episode; backgrounded flags replay
   *    on switch instead); a rising attention edge in the active workspace pulses
   *    red (attnSeen, same contract).
   *  - `data-attention` — the latched attribute (paint-free): attention latches until
   *    the workspace is focused; busy marks activity. The active workspace never
   *    latches. Finished deliberately does NOT latch it — the attribute keeps its
   *    exact Phase-2/01 semantics, asserted by the attention + milestone smokes.
   */
  private refreshAttention(): void {
    let anyAttention = false
    let attnTotal = 0
    const scanned = new Set<PaneId>()
    for (const view of this.views.values()) {
      if (this.pendingClose.has(view.meta.id)) continue // mid-close: hidden, don't ring
      const active = view.meta.id === this.activeId
      let attnCount = 0
      let finishedCount = 0
      let busy = false
      for (const paneId of view.layout.paneIds()) {
        const s: AgentState = paneState(paneId)
        scanned.add(paneId)
        if (paneFinished(paneId)) {
          if (!this.finSeen.has(paneId)) {
            this.finSeen.add(paneId) // rising flag: one green pulse per episode
            if (active && activeView() === 'grid') view.layout.pulseAttention(paneId, 'finished')
          }
          // Focusing the workspace consumes the RAIL alert; the flag itself (and the
          // pane's green dot) lives on until the pane is clicked (port acknowledge).
          if (active) this.finWsSeen.add(paneId)
          if (!this.finWsSeen.has(paneId)) finishedCount++
        } else {
          this.finSeen.delete(paneId) // flag gone (clicked or working again) — rearm
          this.finWsSeen.delete(paneId)
        }
        if (s === 'attention') {
          attnCount++
          // Rising edge while this workspace is already in front of you: the toast is
          // deliberately suppressed for the visible world (notify feature), so the pulse
          // is the call. `attnSeen` makes it ONE pulse per attention episode — a chatty
          // refresh (any pane, any workspace, re-runs this scan) must not re-flash.
          if (!this.attnSeen.has(paneId)) {
            this.attnSeen.add(paneId)
            if (active && activeView() === 'grid') view.layout.pulseAttention(paneId, 'input')
          }
        } else {
          this.attnSeen.delete(paneId) // episode over; the next flip may pulse again
          if (s === 'busy') busy = true
        }
      }
      attnTotal += attnCount

      const alertCount = attnCount + finishedCount
      view.attnBadge.hidden = alertCount === 0
      if (alertCount > 0) {
        view.attnBadge.textContent = String(alertCount)
        const parts: string[] = []
        if (attnCount > 0)
          parts.push(`${attnCount} ${attnCount === 1 ? 'pane needs' : 'panes need'} your input`)
        if (finishedCount > 0)
          parts.push(`${finishedCount} finished working`)
        view.attnBadge.title = parts.join(' · ')
      }
      view.countBadge.textContent = String(view.meta.paneCount)

      if (active) view.attentionLatched = false
      else if (attnCount > 0) view.attentionLatched = true
      const indicator = active ? '' : view.attentionLatched ? 'attention' : busy ? 'busy' : ''
      if (indicator) view.tab.dataset.attention = indicator
      else delete view.tab.dataset.attention
      if (indicator === 'attention') anyAttention = true
      // The outline's own LATCH: any alert while backgrounded arms it, and ONLY
      // focusing this workspace disarms it — the alert may not fade on its own
      // (spec), even if the flagged pane starts working again meanwhile.
      if (active) view.alertLatched = false
      else if (alertCount > 0) view.alertLatched = true
      // The animated orange outline around the whole bar — background tabs only,
      // so it never fights the active tab's identity selection paint.
      view.tab.classList.toggle('is-alerting', !active && (view.alertLatched || alertCount > 0))
    }
    // Prune the flag-lifetime tracking to panes that still exist (see the field
    // comment: reused pane ids must never inherit a closed workspace's history).
    for (const paneId of this.finSeen) {
      if (!scanned.has(paneId)) this.finSeen.delete(paneId)
    }
    for (const paneId of this.finWsSeen) {
      if (!scanned.has(paneId)) this.finWsSeen.delete(paneId)
    }
    // A11Y-01: the badge is silent to screen readers — announce when a
    // new pane starts needing input (a rise in the total).
    if (attnTotal > this.lastAttnTotal) {
      announce(`${attnTotal} ${attnTotal === 1 ? 'pane needs' : 'panes need'} your input`)
    }
    this.lastAttnTotal = attnTotal
    this.onAttention?.(anyAttention)
  }

  /** Switch by rail position (Ctrl/Cmd+1..9). */
  switchByIndex(i: number): void {
    const id = this.order[i]
    if (id) this.switch(id)
  }

  /** The × on a rail tab (WS-01). Closing a workspace disposes every pane in
   *  it — so when there's live work (an agent busy or waiting), confirm first;
   *  then soft-close with a 5-second undo grace either way. */
  async requestClose(id: string): Promise<void> {
    const view = this.views.get(id)
    if (!view || this.pendingClose.has(id)) return
    const liveCount = view.layout.paneIds().filter((p) => paneState(p) !== 'idle').length
    if (liveCount > 0) {
      const n = view.meta.paneCount
      const ok = await confirmDialog({
        title: `Close “${view.meta.name}”?`,
        message: `${n} pane${n === 1 ? '' : 's'} will close, including ${liveCount} with an agent still working. You’ll have a few seconds to undo.`,
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
   *  for real only after the undo window lapses. */
  private softClose(id: string): void {
    const view = this.views.get(id)
    if (!view) return
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
    }, 5000)
    this.pendingClose.set(id, { timer, index })
    this.refreshAttention()
    this.onChange()
    const n = view.meta.paneCount
    showToast({
      title: `Closed “${view.meta.name}”`,
      body: `${n} pane${n === 1 ? '' : 's'} — undo to keep it`,
      timeout: 5000,
      action: { label: 'Undo', onClick: () => this.undoClose(id) }
    })
  }

  /** Bring a mid-close workspace back — its panes never stopped running. */
  private undoClose(id: string): void {
    const pending = this.pendingClose.get(id)
    const view = this.views.get(id)
    if (!pending || !view) return
    clearTimeout(pending.timer)
    this.pendingClose.delete(id)
    view.tab.hidden = false
    this.order.splice(Math.min(pending.index, this.order.length), 0, id)
    if (this.activeId === null) this.switch(id) // was on Home (its last workspace) — reveal it
    else {
      this.refreshAttention()
      this.onChange()
    }
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
    const base = a.meta.ordinal * 100
    for (let i = 1; i <= n; i++) {
      const paneId = (base + i) as PaneId
      if (live.has(paneId)) continue
      clearPaneRemote(paneId)
      setPaneRole(paneId, '')
      setPaneLabel(paneId, '')
      this.scrubManifestSlot(a.meta, i - 1, '')
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

  /** Add a terminal by splitting a pane (⋯ menu / titlebar + / palette / shortcut).
   *  `paneId` null → the workspace's focused pane; `dir` omitted → the pane's longer
   *  axis. The receiving LINE re-equalizes (every terminal in it gets an equal share). */
  splitPane(wsId: string, paneId?: number | null, dir?: 'h' | 'v'): void {
    const view = this.views.get(wsId)
    if (!view) return
    if (view.layout.paneCount >= MAX_PANES) {
      showToast({
        title: 'Pane limit reached',
        body: `A workspace holds at most ${MAX_PANES} terminals.`
      })
      return
    }
    const target = paneId ?? view.layout.focusedPaneId()
    if (target == null) return
    // Seed BEFORE the slot exists (a pane reads its cwd/remote at spawn time): a new
    // terminal is a plain local shell in the split pane's own directory (fallback:
    // the workspace root). Reusing a closed slot's id must never resurrect that
    // slot's remote host or swarm role.
    const newId = view.layout.peekNextPaneId()
    clearPaneRemote(newId)
    setPaneRole(newId, '')
    setPaneLabel(newId, '') // nor the closed slot's agent label ("Claude Code" on a fresh shell)
    const cwd = getPaneCwd(target as PaneId) || view.meta.cwd
    if (cwd) setPaneCwd(newId, cwd)
    this.scrubManifestSlot(view.meta, newId - view.meta.ordinal * 100 - 1, cwd)
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

  /** Reusing slot `i` for a fresh plain terminal: the persisted manifest must agree,
   *  or the next restore would resurrect the OLD slot's agent/role/remote there. */
  private scrubManifestSlot(meta: WorkspaceMeta, i: number, cwd: string): void {
    if (i < 0) return
    if (meta.assignments && i < meta.assignments.length) meta.assignments[i] = 'shell'
    if (meta.roles && i < meta.roles.length) meta.roles[i] = null
    if (meta.remotes && i < meta.remotes.length) meta.remotes[i] = null
    if (meta.profileIds && i < meta.profileIds.length) meta.profileIds[i] = null
    if (meta.paneCwds && i < meta.paneCwds.length) meta.paneCwds[i] = cwd || null
  }

  activePaneCount(): number {
    return this.active()?.layout.paneCount ?? 1
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
    const slot = paneId - view.meta.ordinal * 100
    if (slot < 1) return false
    const ids = view.meta.profileIds ?? []
    while (ids.length < slot) ids.push(null)
    ids[slot - 1] = profileId
    view.meta.profileIds = ids
    return true
  }

  /** An agent was launched into a pane by any app path — palette, pane ⋯ menu, board
   *  card, wizard lineup, failover relaunch: record it as that SLOT's assignment so
   *  every future restore (app relaunch, daemon cold start, and the cross-protocol
   *  update migration) relaunches it with resume. Creation lineups re-announce the
   *  values they were created with, so recording is idempotent — the return value says
   *  whether anything actually changed (the caller persists only then). */
  noteAgentLaunch(paneId: number, provider: string, profileId?: string): boolean {
    if (!provider || provider === 'shell') return false
    const view = this.viewForPane(paneId)
    if (!view) return false
    const slot = paneId - view.meta.ordinal * 100
    if (slot < 1) return false
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
    return changed
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
    if (v) this.closePane(v.meta.id, paneId)
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
      name: spec.name,
      cwd: spec.cwd,
      paneCount: spec.paneCount,
      assignments: spec.assignments,
      paneCwds: spec.paneCwds,
      roles: spec.roles,
      remotes: spec.remotes,
      profileIds: spec.profileIds
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
    const base = view.meta.ordinal * 100
    const meta = view.meta
    setTimeout(() => {
      // Only into panes that EXIST: slot ids are sparse after closes (live 1,3,5), and
      // assignment arrays can name slots the layout no longer has — a launch typed at a
      // nonexistent pane id is at best lost, at worst delivered to a future pane.
      const live = new Set<number>(view.layout.paneIds())
      assignments.forEach((provider, i) => {
        if (provider && provider !== 'shell' && live.has(base + i + 1)) {
          const cwd = meta.paneCwds?.[i] || meta.cwd
          requestAgentLaunch({
            paneId: (base + i + 1) as PaneId,
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
