import type { PaneId } from '@contracts'
import { GridLayout } from '../layout'
import { setFocusedPane } from '../../core/layout/focus'
import { type WorkspaceMeta, colorForOrdinal, newWorkspaceId } from './model'

interface WorkspaceView {
  meta: WorkspaceMeta
  tab: HTMLElement
  container: HTMLElement
  layout: GridLayout
}

export interface CreateOpts {
  id?: string
  name?: string
  cwd?: string
  ordinal?: number
  paneCount?: number
  activate?: boolean
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
    private readonly onChange: () => void
  ) {}

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
      paneCount: opts.paneCount ?? 1
    }

    const container = document.createElement('div')
    container.className = 'workspace-view'
    this.hostEl.append(container)
    const layout = new GridLayout(container, meta.id, ordinal * 100, (paneId) =>
      setFocusedPane({ paneId, cwd: meta.cwd })
    )

    const tab = this.makeTab(meta)
    this.tabsEl.append(tab)

    this.views.set(meta.id, { meta, tab, container, layout })
    layout.apply(meta.paneCount)

    if (opts.activate !== false) this.switch(meta.id)
    this.onChange()
    return meta
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
    this.onChange()
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
}
