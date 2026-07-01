import type { UiFeature } from '../../core/registry/feature-registry'
import type { AgentState, PaneId, WorkspaceState } from '@contracts'
import { TEMPLATE_COUNTS } from '../layout'
import { WorkspaceController, type CreateOpts } from './controller'
import { workspaceClient } from './workspace.client'
import { THEMES, DEFAULT_THEME_ID, applyTheme } from './themes'
import { setWorkspaceOpener } from '../../core/workspace/open-service'
import { setPaneState } from '../../core/attention/attention-port'

function debounce(fn: () => void, ms: number): () => void {
  let t: ReturnType<typeof setTimeout> | undefined
  return () => {
    if (t) clearTimeout(t)
    t = setTimeout(fn, ms)
  }
}

/**
 * The workspace feature: color-coded tabs, each a project dir + its own pane layout (from 04).
 * New / close / switch (Ctrl/Cmd+T, Ctrl/Cmd+1..9), a theme picker, and restore-on-relaunch.
 * Owns the tab bar + a host of per-workspace grids; the shared layout toolbar retargets the
 * active workspace. Decoupled from `terminal` (panes arrive via the slots port, theme via the
 * theme port) — this feature never imports it.
 */
export const workspaceFeature: UiFeature = {
  name: 'workspace',
  mount(ctx) {
    const bar = document.createElement('div')
    bar.id = 'workspace-bar'
    const tabs = document.createElement('div')
    tabs.id = 'workspace-tabs'
    const addBtn = document.createElement('button')
    addBtn.id = 'ws-add'
    addBtn.type = 'button'
    addBtn.textContent = '+'
    addBtn.title = 'New workspace (Ctrl+T)'
    const spacer = document.createElement('div')
    spacer.className = 'ws-spacer'

    const toolbar = document.createElement('div')
    toolbar.id = 'layout-toolbar'
    const tlabel = document.createElement('span')
    tlabel.className = 'layout-toolbar-label'
    tlabel.textContent = 'Panes'
    toolbar.append(tlabel)

    const themePicker = document.createElement('select')
    themePicker.id = 'theme-picker'
    themePicker.title = 'Theme'
    for (const t of THEMES) {
      const opt = document.createElement('option')
      opt.value = t.id
      opt.textContent = t.name
      themePicker.append(opt)
    }

    bar.append(tabs, addBtn, spacer, toolbar, themePicker)
    ctx.content.append(bar)

    const host = document.createElement('div')
    host.id = 'workspace-host'
    ctx.content.append(host)

    let currentTheme = DEFAULT_THEME_ID
    let restoring = true

    const syncToolbar = (): void => {
      const count = String(controller.activePaneCount())
      for (const b of Array.from(toolbar.querySelectorAll('.layout-btn'))) {
        b.classList.toggle('active', b.textContent === count)
      }
    }

    const persist = debounce(() => {
      if (restoring) return
      const state: WorkspaceState = {
        workspaces: controller.list().map((m) => ({
          id: m.id,
          name: m.name,
          color: m.color,
          cwd: m.cwd,
          ordinal: m.ordinal,
          paneCount: m.paneCount,
          assignments: m.assignments
        })),
        activeId: controller.activeMeta()?.id ?? null,
        theme: currentTheme
      }
      workspaceClient.saveState(state)
    }, 400)

    const controller = new WorkspaceController(
      tabs,
      host,
      () => {
        syncToolbar()
        persist()
      },
      (anyAttention) => workspaceClient.setAttention(anyAttention)
    )

    // 06b: let the templates feature open a workspace from a provider-mix template.
    setWorkspaceOpener((spec) => controller.openFromTemplate(spec))

    for (const n of TEMPLATE_COUNTS) {
      const btn = document.createElement('button')
      btn.className = 'layout-btn'
      btn.type = 'button'
      btn.textContent = String(n)
      btn.title = `${n}-pane layout`
      btn.addEventListener('click', () => controller.applyTemplate(n))
      toolbar.append(btn)
    }

    addBtn.addEventListener('click', () => controller.create())

    themePicker.addEventListener('change', () => {
      currentTheme = applyTheme(themePicker.value)
      persist()
    })

    // App shortcuts. Capture phase + stopPropagation so xterm doesn't also receive them.
    window.addEventListener(
      'keydown',
      (e) => {
        const mod = e.ctrlKey || e.metaKey
        if (!mod || e.altKey) return
        const k = e.key.toLowerCase()
        if (k === 't') {
          e.preventDefault()
          e.stopPropagation()
          controller.create()
        } else if (k >= '1' && k <= '9') {
          e.preventDefault()
          e.stopPropagation()
          controller.switchByIndex(Number(k) - 1)
        }
      },
      true
    )

    // `mogging .` deep link -> open/focus a workspace for the directory.
    workspaceClient.onOpenCwd((cwd) => controller.openForCwd(cwd))

    void restore()

    async function restore(): Promise<void> {
      let state: WorkspaceState | null = null
      try {
        state = await workspaceClient.loadState()
      } catch {
        state = null
      }
      currentTheme = applyTheme(state?.theme || DEFAULT_THEME_ID)
      themePicker.value = currentTheme
      if (state && state.workspaces.length) {
        const activeId = state.activeId
        for (const w of state.workspaces) {
          controller.create({
            id: w.id,
            name: w.name,
            cwd: w.cwd,
            ordinal: w.ordinal,
            paneCount: w.paneCount,
            activate: false,
            assignments: w.assignments
          })
        }
        // 06b: re-launch each template workspace's lineup (each CLI self-auths on resume).
        for (const w of state.workspaces) {
          if (w.assignments) controller.launchLineup(w.id, true)
        }
        if (activeId && controller.list().some((m) => m.id === activeId)) controller.switch(activeId)
        else controller.switchByIndex(0)
      } else {
        controller.create({ name: 'Workspace 1' })
      }
      restoring = false
      persist()
    }

    exposeForDev(controller)
  }
}

/** Dev-only handles for the multi-pane + workspace smokes. Tree-shaken in production. */
function exposeForDev(controller: WorkspaceController): void {
  if (!import.meta.env.DEV) return
  const w = window as unknown as { __mogging?: Record<string, unknown> }
  w.__mogging = w.__mogging ?? {}
  w.__mogging.layout = {
    apply: (n: number) => controller.applyTemplate(n),
    paneCount: () => controller.activePaneCount()
  }
  w.__mogging.workspace = {
    create: (opts?: CreateOpts) => controller.create(opts ?? {}),
    switchByIndex: (i: number) => controller.switchByIndex(i),
    openForCwd: (cwd: string) => controller.openForCwd(cwd),
    list: () => controller.list(),
    active: () => controller.activeMeta(),
    count: () => controller.list().length
  }
  w.__mogging.attention = {
    setPaneState: (id: number, state: string) => setPaneState(id as PaneId, state as AgentState)
  }
}
