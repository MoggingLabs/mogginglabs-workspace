import type { UiFeature } from '../../core/registry/feature-registry'
import {
  ControlChannels,
  TerminalChannels,
  type AgentState,
  type ControlCommand,
  type PaneId,
  type RecentWorkspace,
  type WorkspaceState
} from '@contracts'
import { getBridge } from '../../core/ipc/bridge'
import { TEMPLATE_COUNTS, TEMPLATES } from '../layout'
import { IconButton, createLayoutGridPicker, el, icon } from '../../components'
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
import { onAgentLaunchRequest, onProfileFailover } from '../../core/agents/launch-port'
import { onPaneAgentSession } from '../../core/agents/agent-session-port'
import { setActiveView } from '../../core/shell/view-port'
import { setCommands } from '../../core/commands/command-port'
import { setPaneState } from '../../core/attention/attention-port'
import { setPaneRole } from '../../core/layout/pane-meta'
import { getPaneCwdProjection, onPaneCwdProjection } from '../../core/layout/pane-cwd'

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
    header.append(addBtn) // top of the rail, trailing the title — where it belongs

    const tabs = el('div', { class: '', role: 'list' })
    tabs.id = 'workspace-tabs'

    // The rail is workspaces-only by design — navigation (Home) lives in the top bar.
    ctx.rail.append(header, tabs)

    // Scroll-edge fade (the rail's one A− gap): mask ONLY the edge with scrolled-past
    // content, so a fully-visible tab is never masked and the .ws-attn attention count is
    // never dimmed (guardrail). Re-evaluated on scroll, content change (onChange, below)
    // and size change (rail collapse / window resize).
    const updateRailFade = (): void => {
      const overflow = tabs.scrollHeight > tabs.clientHeight + 1
      tabs.classList.toggle('fade-top', overflow && tabs.scrollTop > 1)
      tabs.classList.toggle('fade-bot', overflow && tabs.scrollTop + tabs.clientHeight < tabs.scrollHeight - 1)
    }
    new ResizeObserver(() => updateRailFade()).observe(tabs)
    tabs.addEventListener('scroll', updateRailFade, { passive: true })

    const host = el('div', {})
    host.id = 'workspace-host'
    ctx.content.append(host)

    // ── State ────────────────────────────────────────────────────────────────
    let restoring = true
    // A FAILED load must never be followed by a save: saveState replaces the whole
    // store, so saving after a load error would overwrite the user's intact state
    // with an empty one. Persistence stays off for the session instead.
    let loadFailed = false
    let recents: RecentWorkspace[] = []

    const persist = debounce(() => {
      if (restoring || loadFailed) return
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
          profileIds: m.profileIds, // ids only — env values never leave main (ADR 0002)
          layout: m.layout // split-tree geometry (shape + sizes) — never content
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
        updateRailFade()
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
    // Every authoritative cwd projection keeps focused-pane commands current. Only an
    // explicit agent declaration is durable worktree intent; shell/process movement is
    // live navigation and must not rewrite the restore manifest.
    onPaneCwdProjection((paneId, projection) => {
      if (!projection) return
      if (controller.notePaneCwd(paneId, projection.cwd, projection.source === 'agent')) persist()
    })
    // EVERY agent launch the app performs (palette, pane ⋯ menu, board card, wizard
    // lineup) becomes that slot's assignment, so restores — app relaunch, daemon cold
    // start, the cross-protocol update migration — bring the agent back with resume,
    // not just the panes the creation wizard assigned. Lineup replays announce the
    // values already recorded, so this persists only on real change.
    onAgentLaunchRequest((req) => {
      if (controller.noteAgentLaunch(req.paneId, req.provider, req.profileId, req.cwd)) persist()
    })
    // ...and every agent the app did NOT launch: one the user typed at the pane's own prompt,
    // found by the backend in the pane's PTY subtree (typed-launch detection). Without this
    // the slot stays a 'shell' in the manifest and a cold-daemon restart — a reboot — brings
    // back an empty terminal where a live agent used to be. Detection is the only path that
    // reaches here: a launch already recorded itself above, through the port.
    onPaneAgentSession((paneId, session) => {
      if (!session?.detected) return
      const projection = getPaneCwdProjection(paneId)
      const relaunchCwd = projection?.source === 'agent' ? projection.cwd : session.cwd
      if (controller.noteAgentLaunch(paneId, session.provider, session.profileId, relaunchCwd)) persist()
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
      // REMOVE #16: the SHARED grid picker (compact variant) — one component, replacing
      // the ad-hoc tile builder whose `.layout-menu-tile .layout-tile-count` reached
      // across to override this very component's class.
      const picker = createLayoutGridPicker({
        specs: TEMPLATE_COUNTS.map((n) => ({ count: n, rows: TEMPLATES[n].rows, cols: TEMPLATES[n].cols })),
        selected: controller.activePaneCount(),
        compact: true,
        onSelect: (n) => {
          controller.applyTemplate(n)
          layoutMenu.hidden = true
        }
      })
      // ADD one terminal — lives IN this popover (templates and "one more" are the
      // same decision: how many panes). Splits the focused pane; its line re-equalizes.
      const add = el(
        'button',
        {
          class: 'menu-item layout-menu-add',
          type: 'button',
          title: 'Splits the focused pane — the row/column re-equalizes',
          onClick: () => {
            layoutMenu.hidden = true
            controller.splitActive()
          }
        },
        [
          icon('plus', 14),
          el('span', { text: 'New terminal' }),
          el('span', { class: 'kbd', text: 'Ctrl+Shift+D' })
        ]
      )
      layoutMenu.append(picker.el, el('div', { class: 'menu-sep' }), add)
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
        } else if (k === 'd' && e.shiftKey) {
          e.preventDefault()
          e.stopPropagation()
          controller.splitActive() // Ctrl/Cmd+Shift+D: new terminal in the active grid
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
        // No `home:open` command: Home is the boot launcher and the zero-workspace
        // empty state, not a destination (see core/shell/view-port.ts).
        {
          id: 'pane:zoom',
          title: 'Zoom / restore focused pane',
          hint: 'Pane',
          kbd: 'Ctrl+Shift+Enter',
          run: () => controller.toggleZoom()
        },
        {
          id: 'pane:new',
          title: 'New terminal (split focused pane)',
          hint: 'Pane',
          kbd: 'Ctrl+Shift+D',
          run: () => controller.splitActive()
        },
        {
          id: 'pane:split-right',
          title: 'Split pane right',
          hint: 'Pane',
          run: () => controller.splitActive('h')
        },
        {
          id: 'pane:split-down',
          title: 'Split pane down',
          hint: 'Pane',
          run: () => controller.splitActive('v')
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
      } catch (err) {
        state = null
        loadFailed = true
        console.error('workspace state load failed — persistence disabled for this session to protect the stored state', err)
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
            profileIds: w.profileIds, // lineups relaunch under the CHOSEN profile (6/04)
            layout: w.layout // the exact split arrangement + sizes come back
          })
        }
        // 06b: re-launch each template workspace's lineup (each CLI self-auths on resume).
        for (const w of state.workspaces) {
          if (w.assignments) controller.launchLineup(w.id, true)
        }
        // Re-activate the last workspace AND reveal its grid. A restore that lands on the
        // launcher is a dead screen: the workspaces already exist, their PTYs are already
        // spawning, and Home offers nothing but a way back to them. Home is the
        // zero-workspace empty state (below) and nothing else — the same invariant
        // core/shell/view-port.ts enforces for every other road into it.
        const target =
          activeId && controller.list().some((m) => m.id === activeId)
            ? activeId
            : controller.list()[0]?.id
        if (target) controller.switch(target) // reveal: the grid owns the app
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
    split: (dir?: 'h' | 'v') => controller.splitActive(dir),
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
    count: () => controller.list().length,
    // Naming a reviewer, exactly as the manifest does it (controller.publishRoles): the chip
    // port paints it, and the terminal:setRole IPC is what actually CONFERS it — main records
    // that as the app's own answer to "who may sign off" (daemon-relay: appRoles) and forwards
    // it to the daemon. Both halves, or the role is decoration. Not a back door: the renderer
    // IS the trusted side — a pane is a PTY child with no IPC at all — and this whole block is
    // DEV-only and tree-shaken out of production.
    setRole: (paneId: number, role: string) => {
      setPaneRole(paneId as PaneId, role)
      getBridge().send(TerminalChannels.setRole, { id: paneId as PaneId, role })
    }
  }
  w.__mogging.attention = {
    setPaneState: (id: number, state: string) => setPaneState(id as PaneId, state as AgentState)
  }
  // View switcher for the CHROMEUX smoke (bug #11: the grid picker must be ABSENT off
  // the grid). setActiveView is the real port the titlebar view buttons call.
  w.__mogging.view = (v: string) => setActiveView(v as Parameters<typeof setActiveView>[0])
}
