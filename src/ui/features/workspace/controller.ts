import { TerminalChannels } from '@contracts'
import type { AgentState, PaneId } from '@contracts'
import { getBridge } from '../../core/ipc/bridge'
import { GridLayout } from '../layout'
import { icon } from '../../components'
import { setFocusedPane } from '../../core/layout/focus'
import { setPaneCwd } from '../../core/layout/pane-cwd'
import { setPaneRole } from '../../core/layout/pane-meta'
import { paneState, onAttentionChange } from '../../core/attention/attention-port'
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
}

export interface SwitchOpts {
  /** Reveal the grid view (default). Restore passes false so boot stays on Home. */
  reveal?: boolean
}

/**
 * Owns the set of workspaces: one rail item + one hidden/visible container + one
 * `GridLayout` each. Switching is pure show/hide (every workspace's panes stay mounted
 * and streaming). The rail item carries the Phase-2 signature: a live NUMERIC count of
 * panes needing attention, next to a quiet pane-count — plus the latched attention ring
 * (`data-attention`, the contract the attention/milestone smokes assert). Emits
 * `onChange` after any mutation (used to persist + publish the info port).
 */
export class WorkspaceController {
  private readonly views = new Map<string, WorkspaceView>()
  private order: string[] = []
  private activeId: string | null = null
  private nextOrdinal = 0

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
      roles: opts.roles
    }

    const container = document.createElement('div')
    container.className = 'workspace-view'
    this.hostEl.append(container)
    const layout = new GridLayout(container, meta.id, ordinal * 100, (paneId) =>
      setFocusedPane({ paneId, cwd: meta.cwd })
    )

    const view: WorkspaceView = {
      meta,
      container,
      layout,
      attentionLatched: false,
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

    layout.apply(meta.paneCount)
    this.publishPaneCwds(meta) // seed per-pane git with the workspace cwd (2/03)
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
   *  shows its own branch. OSC 7 later refines a pane's cwd if its shell emits it. */
  private publishPaneCwds(meta: WorkspaceMeta): void {
    const base = meta.ordinal * 100
    for (let i = 1; i <= meta.paneCount; i++) {
      const cwd = meta.paneCwds?.[i - 1] || meta.cwd
      if (cwd) setPaneCwd((base + i) as PaneId, cwd)
    }
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
    tab.style.setProperty('--ws-color', meta.color)
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
      this.close(meta.id)
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
    // User-initiated selection lands in the grid; restore keeps the launcher up.
    if (opts.reveal !== false) setActiveView('grid')
    setFocusedPane({
      paneId: view.layout.focusedPaneId() ?? ((view.meta.ordinal * 100 + 1) as PaneId),
      cwd: view.meta.cwd
    })
    this.refreshAttention() // activating a workspace clears its ring (you're looking at it)
    this.onChange()
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
   *  - `.ws-attn`  — LIVE numeric count of panes currently needing attention (the
   *    Phase-2 signature; shown for every workspace, active included).
   *  - `data-attention` — the latched background ring: attention latches until the
   *    workspace is focused; busy shows a softer cue. The active workspace never rings.
   *    (Exact Phase-2/01 semantics — asserted by the attention + milestone smokes.)
   */
  private refreshAttention(): void {
    let anyAttention = false
    for (const view of this.views.values()) {
      const active = view.meta.id === this.activeId
      let attnCount = 0
      let busy = false
      for (const paneId of view.layout.paneIds()) {
        const s: AgentState = paneState(paneId)
        if (s === 'attention') attnCount++
        else if (s === 'busy') busy = true
      }

      view.attnBadge.hidden = attnCount === 0
      if (attnCount > 0) {
        view.attnBadge.textContent = String(attnCount)
        view.attnBadge.title = `${attnCount} ${attnCount === 1 ? 'pane needs' : 'panes need'} your input`
      }
      view.countBadge.textContent = String(view.meta.paneCount)

      if (active) view.attentionLatched = false
      else if (attnCount > 0) view.attentionLatched = true
      const indicator = active ? '' : view.attentionLatched ? 'attention' : busy ? 'busy' : ''
      if (indicator) view.tab.dataset.attention = indicator
      else delete view.tab.dataset.attention
      if (indicator === 'attention') anyAttention = true
    }
    this.onAttention?.(anyAttention)
  }

  /** Switch by rail position (Ctrl/Cmd+1..9). */
  switchByIndex(i: number): void {
    const id = this.order[i]
    if (id) this.switch(id)
  }

  close(id: string): void {
    const view = this.views.get(id)
    if (!view) return
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
    a.layout.apply(n)
    a.meta.paneCount = n
    this.publishPaneCwds(a.meta) // seed any newly-added panes' cwd for git (2/03)
    getTelemetry().captureEvent({ name: 'layout.applied', props: { panes: n } })
    this.refreshAttention()
    this.onChange()
  }

  activePaneCount(): number {
    return this.active()?.layout.paneCount ?? 1
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
      roles: spec.roles
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
      assignments.forEach((provider, i) => {
        if (provider && provider !== 'shell') {
          const cwd = meta.paneCwds?.[i] || meta.cwd
          requestAgentLaunch({ paneId: (base + i + 1) as PaneId, provider, cwd, resume })
        }
      })
    }, 900)
  }
}
