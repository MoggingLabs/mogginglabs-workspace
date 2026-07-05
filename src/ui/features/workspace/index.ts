import type { UiFeature } from '../../core/registry/feature-registry'
import {
  ControlChannels,
  type AgentState,
  type ControlCommand,
  type PaneId,
  type RecentWorkspace,
  type WorkspaceState
} from '@contracts'
import { getBridge } from '../../core/ipc/bridge'
import { TEMPLATE_COUNTS, TEMPLATES } from '../layout'
import { IconButton, MiniGridPreview, el } from '../../components'
import { WorkspaceController, type CreateOpts } from './controller'
import { workspaceClient } from './workspace.client'
import { DEFAULT_THEME_ID } from '../../core/theme/themes'
import { setTheme, currentThemeId, onThemeChange } from '../../core/theme/theme-state'
import { setWorkspaceOpener } from '../../core/workspace/open-service'
import {
  publishWorkspaces,
  setWorkspaceSwitcher
} from '../../core/workspace/workspace-info-port'
import { openWizard } from '../../core/workspace/wizard-port'
import { onProfileFailover } from '../../core/agents/launch-port'
import { setActiveView, activeView } from '../../core/shell/view-port'
import { setCommands } from '../../core/commands/command-port'
import { setPaneState } from '../../core/attention/attention-port'

const MAX_RECENTS = 5 // Home shows the five most recent projects worked on

function debounce(fn: () => void, ms: number): () => void {
  let t: ReturnType<typeof setTimeout> | undefined
  return () => {
    if (t) clearTimeout(t)
    t = setTimeout(fn, ms)
  }
}

/**
 * The workspace feature: the left vertical RAIL — one item per workspace with a live
 * numeric attention count ("who needs me, and how badly") — plus per-workspace grids,
 * a layout picker in the titlebar, keyboard switching, and restore-on-relaunch
 * (including recently-closed workspaces for Home). Decoupled from `terminal`/`home`/
 * `wizard`: panes arrive via the slots port, views via the view port, opens via the
 * wizard/open-service ports.
 */
export const workspaceFeature: UiFeature = {
  name: 'workspace',
  mount(ctx) {
    // ── Rail scaffolding ─────────────────────────────────────────────────────
    const header = el('div', { class: 'rail-header' }, [
      el('span', { class: 'section-label rail-title', text: 'Workspaces' }),
      el('span', { class: 'rail-total', text: '' })
    ])
    const addBtn = IconButton({
      icon: 'plus',
      label: 'New workspace',
      title: 'New workspace (Ctrl+T)',
      onClick: () => newWorkspace()
    })
    addBtn.id = 'ws-add'
    header.append(addBtn)

    const tabs = el('div', { class: '', role: 'list' })
    tabs.id = 'workspace-tabs'

    // The rail is workspaces-only by design — navigation (Home) lives in the top bar.
    ctx.rail.append(header, tabs)

    const host = el('div', {})
    host.id = 'workspace-host'
    ctx.content.append(host)

    // ── State ────────────────────────────────────────────────────────────────
    let restoring = true
    let recents: RecentWorkspace[] = []

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
          assignments: m.assignments,
          paneCwds: m.paneCwds,
          roles: m.roles,
          remotes: m.remotes,
          profileIds: m.profileIds // ids only — env values never leave main (ADR 0002)
        })),
        activeId: controller.activeMeta()?.id ?? null,
        theme: currentThemeId(),
        recents
      }
      workspaceClient.saveState(state)
    }, 400)

    const publishInfo = (): void => {
      publishWorkspaces({
        workspaces: controller.list().map((m) => ({
          id: m.id,
          name: m.name,
          color: m.color,
          cwd: m.cwd,
          ordinal: m.ordinal,
          paneCount: m.paneCount
        })),
        activeId: controller.activeMeta()?.id ?? null
      })
    }

    /** Touch a project in Home's recents: newest first, deduped by folder, capped at 5.
     *  Metadata only (folder + layout + provider lineup) — never credentials (ADR 0002). */
    const touchRecent = (meta: {
      name: string
      cwd: string
      paneCount: number
      assignments?: string[]
    }): void => {
      if (!meta.cwd) return // recents are PROJECTS — a directory is the identity
      recents = [
        {
          name: meta.name,
          cwd: meta.cwd,
          paneCount: meta.paneCount,
          assignments: meta.assignments,
          lastUsedAt: Date.now()
        },
        ...recents.filter((r) => r.cwd !== meta.cwd)
      ].slice(0, MAX_RECENTS)
      persist()
    }

    const controller = new WorkspaceController(
      tabs,
      host,
      () => {
        header.querySelector('.rail-total')!.textContent = String(controller.list().length)
        publishInfo()
        publishCommands()
        persist()
      },
      (anyAttention) => workspaceClient.setAttention(anyAttention),
      touchRecent, // closing keeps the project's final layout in recents
      touchRecent // opening/working on a project bumps it to the top
    )

    setWorkspaceSwitcher((id) => controller.switch(id))
    // Usage-limit failover switched a pane's profile (6/04): the manifest follows,
    // one persist per event — otherwise a restart resurrects the capped profile.
    onProfileFailover((ev) => {
      if (controller.noteProfileFailover(ev.paneId, ev.profileId)) persist()
    })
    // 06b: the wizard/templates open workspaces from a provider-mix spec.
    setWorkspaceOpener((spec) => {
      const meta = controller.openFromTemplate(spec)
      return { id: meta.id, ordinal: meta.ordinal }
    })

    function newWorkspace(): void {
      // The wizard is the rich path; fall back to an instant workspace if it isn't up.
      if (!openWizard({ cwd: controller.activeMeta()?.cwd })) controller.create()
    }

    // ── Layout picker (titlebar): compact popover of grid templates ─────────
    const layoutWrap = el('div', { class: 'layout-launcher' })
    const layoutBtn = IconButton({
      icon: 'layout-grid',
      label: 'Change grid layout',
      title: 'Grid layout',
      onClick: (e) => {
        e.stopPropagation()
        if (layoutMenu.hidden) renderLayoutMenu()
        layoutMenu.hidden = !layoutMenu.hidden
      }
    })
    const layoutMenu = el('div', { class: 'menu layout-menu', hidden: true })
    layoutWrap.append(layoutBtn, layoutMenu)
    ctx.titlebarLeft.append(layoutWrap)
    document.addEventListener('click', (e) => {
      if (!(e.target instanceof Node) || !layoutWrap.contains(e.target)) layoutMenu.hidden = true
    })

    function renderLayoutMenu(): void {
      layoutMenu.innerHTML = ''
      const current = controller.activePaneCount()
      for (const n of TEMPLATE_COUNTS) {
        const spec = TEMPLATES[n]
        const tile = el(
          'button',
          {
            class: 'layout-menu-tile' + (n === current ? ' is-selected' : ''),
            type: 'button',
            ariaLabel: `${n}-pane layout`,
            onClick: () => {
              controller.applyTemplate(n)
              layoutMenu.hidden = true
            }
          },
          [
            MiniGridPreview({ rows: spec.rows, cols: spec.cols }),
            el('span', { class: 'layout-tile-count', text: String(n) })
          ]
        )
        layoutMenu.append(tile)
      }
    }

    // ── Keyboard: capture phase + stopPropagation so xterm never sees these ──
    const NAV: Record<string, 'left' | 'right' | 'up' | 'down'> = {
      arrowleft: 'left',
      arrowright: 'right',
      arrowup: 'up',
      arrowdown: 'down'
    }
    window.addEventListener(
      'keydown',
      (e) => {
        const mod = e.ctrlKey || e.metaKey
        if (!mod) return
        const k = e.key.toLowerCase()
        if (e.altKey) {
          const dir = NAV[k]
          if (dir) {
            e.preventDefault()
            e.stopPropagation()
            controller.focusDir(dir) // Ctrl/Cmd+Alt+arrows: pane navigation
          }
          return
        }
        if (k === 't' && !e.shiftKey) {
          e.preventDefault()
          e.stopPropagation()
          newWorkspace()
        } else if (k === 'h' && e.shiftKey) {
          e.preventDefault()
          e.stopPropagation()
          setActiveView(activeView() === 'home' ? 'grid' : 'home')
        } else if (k === 'enter' && e.shiftKey) {
          e.preventDefault()
          e.stopPropagation()
          controller.toggleZoom()
        } else if (!e.shiftKey && k >= '1' && k <= '9') {
          e.preventDefault()
          e.stopPropagation()
          controller.switchByIndex(Number(k) - 1)
        }
      },
      true
    )

    // Theme changes (Settings / palette / restore) persist with the workspace state.
    onThemeChange(() => persist())

    // `mogging .` deep link -> open/focus a workspace for the directory.
    workspaceClient.onOpenCwd((cwd) => controller.openForCwd(cwd))

    // Phase-3/02 layout verbs — already VALIDATED in main against the closed union;
    // the renderer only ever sees clean ControlCommand objects.
    getBridge().on(ControlChannels.command, (payload) => {
      const cmd = payload as ControlCommand
      switch (cmd.verb) {
        case 'open':
          if (cmd.cwd) {
            controller.openForCwd(cmd.cwd)
            if (cmd.panes) controller.applyTemplate(cmd.panes)
          }
          break
        case 'layout':
          if (cmd.panes) controller.applyTemplate(cmd.panes)
          break
        case 'focus':
          if (cmd.paneId) controller.focusPane(cmd.paneId)
          break
        case 'expand':
          if (cmd.paneId) controller.expandPaneById(cmd.paneId, cmd.mode ?? 'full')
          break
        case 'close-pane':
          if (cmd.paneId) controller.closePaneById(cmd.paneId)
          break
      }
    })

    // ── Command-palette entries ──────────────────────────────────────────────
    // Republishing is skipped when the workspace SET is unchanged — switching
    // workspaces must not rebuild command lists (perception budget, docs/07).
    let commandsSig = ''
    function publishCommands(): void {
      const sig = controller
        .list()
        .map((m) => `${m.id}:${m.name}`)
        .join('|')
      if (sig === commandsSig) return
      commandsSig = sig
      const wsCommands = controller.list().map((m, i) => ({
        id: `workspace:switch:${m.id}`,
        title: `Switch to “${m.name}”`,
        hint: 'Workspace',
        kbd: i < 9 ? `Ctrl+${i + 1}` : undefined,
        run: () => controller.switch(m.id)
      }))
      setCommands('workspace', [
        {
          id: 'workspace:new',
          title: 'New workspace…',
          hint: 'Workspace',
          kbd: 'Ctrl+T',
          run: () => newWorkspace()
        },
        {
          id: 'workspace:quick',
          title: 'Quick workspace (single shell)',
          hint: 'Workspace',
          run: () => controller.create()
        },
        {
          id: 'home:open',
          title: 'Go Home',
          hint: 'View',
          kbd: 'Ctrl+Shift+H',
          run: () => setActiveView('home')
        },
        {
          id: 'pane:zoom',
          title: 'Zoom / restore focused pane',
          hint: 'Pane',
          kbd: 'Ctrl+Shift+Enter',
          run: () => controller.toggleZoom()
        },
        ...TEMPLATE_COUNTS.map((n) => ({
          id: `layout:${n}`,
          title: `Layout: ${n} pane${n === 1 ? '' : 's'}`,
          hint: 'Layout',
          run: () => controller.applyTemplate(n)
        })),
        ...wsCommands
      ])
    }

    void restore()

    async function restore(): Promise<void> {
      let state: WorkspaceState | null = null
      try {
        state = await workspaceClient.loadState()
      } catch {
        state = null
      }
      setTheme(state?.theme || DEFAULT_THEME_ID)
      recents = state?.recents ?? []
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
            assignments: w.assignments,
            paneCwds: w.paneCwds, // worktree panes re-attach to their worktrees (3/03)
            roles: w.roles, // the swarm manifest survives restore (4/01)
            remotes: w.remotes, // remote panes stay remote across restore (4/05)
            profileIds: w.profileIds // lineups relaunch under the CHOSEN profile (6/04)
          })
        }
        // 06b: re-launch each template workspace's lineup (each CLI self-auths on resume).
        for (const w of state.workspaces) {
          if (w.assignments) controller.launchLineup(w.id, true)
        }
        // Re-activate the last workspace WITHOUT revealing its grid — the app always
        // opens on the launcher; the user picks where to go from there.
        const target =
          activeId && controller.list().some((m) => m.id === activeId)
            ? activeId
            : controller.list()[0]?.id
        if (target) controller.switch(target, { reveal: false })
      }
      // No saved workspaces = a true first run: the launcher IS the empty state.
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
    paneCount: () => controller.activePaneCount(),
    paneIds: () => controller.activePaneIds(),
    zoom: () => controller.toggleZoom(),
    expand: (paneId: number, mode: 'full' | 'col' | 'row') => controller.expandPane(paneId, mode),
    close: (paneId: number) => {
      const id = controller.activeMeta()?.id
      if (id) controller.closePane(id, paneId)
    }
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
