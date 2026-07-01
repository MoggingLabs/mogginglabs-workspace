import type { AgentState, PaneId } from '@contracts'
import { GridLayout } from '../layout'
import { setFocusedPane } from '../../core/layout/focus'
import { setPaneCwd } from '../../core/layout/pane-cwd'
import { paneState, onAttentionChange } from '../../core/attention/attention-port'
import { requestAgentLaunch } from '../../core/agents/launch-port'
import type { TemplateWorkspaceSpec } from '../../core/workspace/open-service'
import { type WorkspaceMeta, colorForOrdinal, newWorkspaceId } from './model'

interface WorkspaceView {
  meta: WorkspaceMeta
  tab: HTMLElement
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
}

/**
 * Owns the set of workspaces: one tab + one hidden/visible container + one `GridLayout` each.
 * Switching is pure show/hide (every workspace's panes stay mounted, so they keep streaming).
 * Closing disposes a workspace's layout, which clears its slots so the terminal feature tears
 * down just that workspace's panes. Emits `onChange` after any mutation (used to persist).
 */
export class WorkspaceController {
  private readonly views = new Map<string, WorkspaceView>()
  private activeId: string | null = null
  private nextOrdinal = 0

  constructor(
    private readonly tabsEl: HTMLElement,
    private readonly hostEl: HTMLElement,
    private readonly onChange: () => void,
    private readonly onAttention?: (anyAttention: boolean) => void
  ) {
    onAttentionChange(() => this.refreshAttention())
  }

  list(): WorkspaceMeta[] {
    return Array.from(this.views.values()).map((v) => v.meta)
  }

  activeMeta(): WorkspaceMeta | null {
    return this.activeId ? (this.views.get(this.activeId)?.meta ?? null) : null
  }

  private active(): WorkspaceView | null {
    return this.activeId ? (this.views.get(this.activeId) ?? null) : null
  }

  /** Create a workspace (from a `mogging .` launch, the + button, or a restore). */
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
      assignments: opts.assignments
    }

    const container = document.createElement('div')
    container.className = 'workspace-view'
    this.hostEl.append(container)
    const layout = new GridLayout(container, meta.id, ordinal * 100, (paneId) =>
      setFocusedPane({ paneId, cwd: meta.cwd })
    )

    const tab = this.makeTab(meta)
    this.tabsEl.append(tab)

    this.views.set(meta.id, { meta, tab, container, layout, attentionLatched: false })
    layout.apply(meta.paneCount)
    this.publishPaneCwds(meta) // seed per-pane git with the workspace cwd (2/03)

    if (opts.activate !== false) this.switch(meta.id)
    this.onChange()
    return meta
  }

  /** Seed each of a workspace's panes with the workspace cwd on the pane-cwd port — the reliable
   *  default for per-pane git (2/03). OSC 7 later refines a pane's cwd if its shell emits it. */
  private publishPaneCwds(meta: WorkspaceMeta): void {
    if (!meta.cwd) return
    const base = meta.ordinal * 100
    for (let i = 1; i <= meta.paneCount; i++) setPaneCwd((base + i) as PaneId, meta.cwd)
  }

  private makeTab(meta: WorkspaceMeta): HTMLElement {
    const tab = document.createElement('div')
    tab.className = 'workspace-tab'
    tab.dataset.wsId = meta.id
    tab.style.setProperty('--ws-color', meta.color)

    const dot = document.createElement('span')
    dot.className = 'ws-dot'
    const label = document.createElement('span')
    label.className = 'ws-label'
    label.textContent = meta.name
    const close = document.createElement('button')
    close.className = 'ws-close'
    close.type = 'button'
    close.textContent = '×'
    close.title = 'Close workspace'

    tab.append(dot, label, close)
    tab.addEventListener('mousedown', (e) => {
      if (e.target !== close) this.switch(meta.id)
    })
    close.addEventListener('click', (e) => {
      e.stopPropagation()
      this.close(meta.id)
    })
    return tab
  }

  switch(id: string): void {
    const view = this.views.get(id)
    if (!view) return
    this.activeId = id
    for (const [vid, v] of this.views) {
      const on = vid === id
      v.container.classList.toggle('active', on)
      v.tab.classList.toggle('active', on)
    }
    setFocusedPane({
      paneId: view.layout.focusedPaneId() ?? ((view.meta.ordinal * 100 + 1) as PaneId),
      cwd: view.meta.cwd
    })
    this.refreshAttention() // activating a workspace clears its ring (you're looking at it)
    this.onChange()
  }

  /** Recompute each workspace's tab attention indicator + the app-level any-attention flag. A
   *  tab rings when a BACKGROUND pane needs you (attention latches until you focus that tab;
   *  busy shows a softer dot). The active workspace never rings. */
  private refreshAttention(): void {
    let anyAttention = false
    for (const view of this.views.values()) {
      const active = view.meta.id === this.activeId
      const base = view.meta.ordinal * 100
      let maxState: AgentState = 'idle'
      for (let i = 1; i <= view.meta.paneCount; i++) {
        const s = paneState((base + i) as PaneId)
        if (s === 'attention') {
          maxState = 'attention'
          break
        }
        if (s === 'busy') maxState = 'busy'
      }
      if (active) view.attentionLatched = false
      else if (maxState === 'attention') view.attentionLatched = true
      const indicator = active ? '' : view.attentionLatched ? 'attention' : maxState === 'busy' ? 'busy' : ''
      if (indicator) view.tab.dataset.attention = indicator
      else delete view.tab.dataset.attention
      if (indicator === 'attention') anyAttention = true
    }
    this.onAttention?.(anyAttention)
  }

  /** Switch by tab position (Ctrl/Cmd+1..9). */
  switchByIndex(i: number): void {
    const view = Array.from(this.views.values())[i]
    if (view) this.switch(view.meta.id)
  }

  close(id: string): void {
    const view = this.views.get(id)
    if (!view) return
    view.layout.dispose() // clears slots -> terminal disposes this workspace's panes
    view.tab.remove()
    view.container.remove()
    this.views.delete(id)
    if (this.activeId === id) {
      this.activeId = null
      const next = this.views.values().next().value as WorkspaceView | undefined
      if (next) this.switch(next.meta.id)
      else this.create({ name: 'Workspace 1' }) // never leave zero workspaces
    }
    this.onChange()
  }

  /** Apply an N-pane template to the active workspace. */
  applyTemplate(n: number): void {
    const a = this.active()
    if (!a) return
    a.layout.apply(n)
    a.meta.paneCount = n
    this.publishPaneCwds(a.meta) // seed any newly-added panes' cwd for git (2/03)
    this.onChange()
  }

  activePaneCount(): number {
    return this.active()?.layout.paneCount ?? 1
  }

  /** Focus an existing workspace for `cwd`, or create one (the `mogging .` entry point). */
  openForCwd(cwd: string): WorkspaceMeta {
    for (const v of this.views.values()) {
      if (v.meta.cwd && v.meta.cwd === cwd) {
        this.switch(v.meta.id)
        return v.meta
      }
    }
    const name = cwd ? cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || 'Workspace' : undefined
    return this.create({ cwd, name })
  }

  /** Open a workspace from a template spec (06b): the resolved grid + its provider lineup. */
  openFromTemplate(spec: TemplateWorkspaceSpec): WorkspaceMeta {
    const meta = this.create({
      name: spec.name,
      cwd: spec.cwd,
      paneCount: spec.paneCount,
      assignments: spec.assignments
    })
    this.launchLineup(meta.id, false)
    return meta
  }

  /** Launch each non-shell pane's assigned CLI (06b). Delayed so the panes' PTYs are spawned
   *  and ready to accept input. `resume` re-launches the lineup on restore. */
  launchLineup(id: string, resume: boolean): void {
    const view = this.views.get(id)
    const assignments = view?.meta.assignments
    if (!view || !assignments) return
    const base = view.meta.ordinal * 100
    const cwd = view.meta.cwd
    setTimeout(() => {
      assignments.forEach((provider, i) => {
        if (provider && provider !== 'shell') {
          requestAgentLaunch({ paneId: (base + i + 1) as PaneId, provider, cwd, resume })
        }
      })
    }, 900)
  }
}
