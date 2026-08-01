import type { ShellContext, UiFeature } from '../../core/registry/feature-registry'
import { IntegrationsChannels, ProfileChannels, RemoteChannels } from '@contracts'
import type {
  AgentInfo,
  AgentProfile,
  McpServerEntry,
  ProviderCount,
  ProviderMixTemplate,
  RecentWorkspace,
  RemoteHost,
  WorktreePreflight
} from '@contracts'
import type { PathStatus } from '../../components/input'
import { copyText } from '../../core/clipboard/clipboard-port'
import {
  Button,
  clear,
  createCheckbox,
  createFolderBrowser,
  createGridPainter,
  createPathInput,
  createStepper,
  el,
  icon,
  openContextMenu,
  providerAccent,
  providerLogo,
  type ContextMenuEntry,
  type ElChild,
  type FolderBrowserHandle,
  type GridPainterHandle,
  type PathInputHandle,
  type StepperHandle
} from '../../components'
import {
  TEMPLATES,
  effectivePaneCapacity,
  serializeTree,
  specForCount,
  treeForRegions,
  uniformSpec,
  type GridSpecModel,
  type PaneBudget
} from '../layout'
import { livePaneCount } from '../../core/layout/slots'
import { machineSpec, primeMachineSpec } from '../../core/system/machine-port'
import { parseCdLine, resolveCdTarget, resolvePathAgainst } from './cd-path'
import { applyCompletion, commonPrefix, completionContext, filterCompletions } from './cd-complete'
import { createCdLine, type CdLineHandle } from './cd-line'
import { getFocusedPane } from '../../core/layout/focus'
import { openLibrary } from '../settings/library'
import { openPlannedWorkspaceFromTemplate, openWorkspaceFromTemplate } from '../../core/workspace/open-service'
import { setWizardOpener, type WizardPrefill } from '../../core/workspace/wizard-port'
import { activeView, goBack, setActiveView } from '../../core/shell/view-port'
import { getTelemetry } from '../../core/telemetry'
import { getBridge } from '../../core/ipc/bridge'
import { wizardClient } from './wizard.client'
import { createPathSelection, type PathOrigin, type PathSelectionHandle, type PathState } from './path-selection'
import { getAgentRegistry, onAgentRegistryChange, refreshAgentRegistry } from '../../core/agents/registry'
import { createAgentSetupPanel, type AgentSetupPanelHandle } from '../agents/setup-panel'

// Provider identity (accent + official mark) lives in components/provider-logo —
// one source for the wizard, settings, usage, and pane chrome.

const basename = (p: string): string =>
  p.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? ''

const plural = (n: number): string => (n === 1 ? 'terminal' : 'terminals')

/** Settings preference for the suggested grid size (falls back to ONE — a fresh
 *  wizard proposes a single terminal and the user grows from there; four presumed
 *  a fleet nobody had asked for yet). The stored number is trusted up to the
 *  contract ceiling; the capacity budget clamps at use. */
function defaultPaneCount(): number {
  try {
    const n = Number(localStorage.getItem('mogging.defaultPaneCount'))
    if (Number.isInteger(n) && n >= 1 && n <= 32) return n
  } catch {
    /* storage unavailable */
  }
  return 1
}

/** The painter spec for a bare pane count — curated shapes for the counts that have
 *  one, near-square with a spanned ragged tail for the rest. */
const specForPanes = (n: number): GridSpecModel => specForCount(n, TEMPLATES[n])

/**
 * The new-workspace wizard: ONE compact PAGE (8.5/02, redesigned) — not a modal. It
 * owns the content region beside the workspace rail (`#view-wizard`), a centred
 * column, so configuring the next workspace happens with the ones you already have
 * still in view.
 *
 * The redesign's contract (2026-07-16): nothing is hidden — every control that used
 * to live behind an "Advanced" disclosure (custom command, tool scoping, worktree
 * isolation, SSH host, presets) is a visible section — and the page is DENSE: flat
 * sections under small uppercase labels (the house division rhythm), not three
 * padded Cards.
 *
 * A fresh page opens with the user's HOME already chosen as the working folder —
 * a real default in the bar (never placeholder fiction), the browser listing it,
 * Launch viable immediately. Prefills (Ctrl+T from a workspace, a board card)
 * outrank it; so does anything the user picks or types before the answer lands.
 * The cd line beneath the bar accepts ONLY cd commands, and Tab-completes. The
 * workspace NAME is automatic until typed: it follows the folder through every
 * move (one keystroke claims it, clearing hands it back). The pane budget is the
 * screen ∧ THE MACHINE (RAM/CPU, minus panes already running — pane-capacity.ts),
 * and the Presets section offers nothing built-in: only the user's own saves.
 *
 * The layout is DYNAMIC, not preset tiles: a Word-style size lattice (hover r×c,
 * click commits — any 1..16, no curated counts) beside a shape canvas where
 * dragging across terminals MERGES them into spanning panes (one full-width
 * terminal above two, a tall left rail, …). The canvas doubles as the live
 * assignment preview, and the merged arrangement is the split tree the workspace
 * actually opens with (grid-regions.ts → layout-tree.ts).
 *
 * BYO-auth (ADR 0002): agents are launched as YOUR CLIs under YOUR login — the
 * wizard never asks for or stores a credential.
 */
export const wizardFeature: UiFeature = {
  name: 'wizard',
  mount(ctx: ShellContext) {
    void primeMachineSpec() // the pane budget's raw inputs — fetched once, read sync ever after
    // ── Wizard state (persists while the page is open) ───────────────────────
    let name = ''
    // The workspace name is AUTOMATIC until the user types one: it follows the
    // chosen folder (its basename — or a recent's saved name) through every pick,
    // cd, and typed path. One keystroke in the name box makes it manual; clearing
    // the box re-arms the follow. `lastAutoCwd` keeps re-emits of the SAME folder
    // (probe pulses, listing arrivals) from rewriting a recent's nicer name.
    let nameAuto = true
    let lastAutoCwd = ''
    let cwd = ''
    // What this machine can honestly RUN and this screen can honestly SHOW, minus
    // the app's own chrome and every pane already running (pane-capacity.ts) —
    // refreshed on every open: monitors get plugged, workspaces open and close.
    let capacity: PaneBudget = effectivePaneCapacity(ctx.content)
    let homeCache = '' // the cd line's fallback base + ~ target — and the fresh page's default folder
    let barTouched = false // typing in the bar outranks the late-arriving home default
    let gridSpec: GridSpecModel = specForPanes(defaultPaneCount())
    let paneCount = gridSpec.regions.length
    // THE ASSIGNMENT (placement redesign, 2026-08-01) — per-TERMINAL, not per-provider.
    // slots[k] names what terminal k runs: a provider id, 'custom' (the command in
    // `customCmd`), or null for a plain shell. Reading order, aligned with
    // gridSpec.regions. This replaced the counts-Map model on explicit direction: counts
    // could say HOW MANY of each agent but never WHERE one goes, and every quick-fill
    // button was a patch over that indirection. Counts are now derived readouts.
    let slots: (string | null)[] = Array<string | null>(paneCount).fill(null)
    // The armed brush: a provider id, 'custom', or 'shell' (paints a plain shell).
    // null = nothing armed; canvas clicks open the per-terminal picker instead.
    let brush: string | null = null
    let customCmd = ''
    let isRepo = false // set by the folder field's git probe
    let isolate = false // Phase-3/03: one git worktree per agent pane
    // Whether isolation is POSSIBLE here, answered by main before the toggle is offered.
    // `isRepo` alone was not enough and the gap cost a user their first launch: probeGit
    // degrades to reading `.git/HEAD` when git cannot be RUN at all (the classic case — git
    // installed after the app started, so it is on the system PATH and invisible to this
    // process), so a folder read as a repo, the box enabled itself, and every `git worktree
    // add` then failed at Launch. null = not asked yet.
    let isolatePreflight: WorktreePreflight | null = null
    /** The folder the current answer (or in-flight question) belongs to — one probe per
     *  folder, however many times the selection re-emits it. */
    let preflightCwd: string | null = null
    let preflightSeq = 0
    let remoteHost: { hostId: string; name: string } | null = null // Phase-4/05
    let localCwd = ''
    let remoteCwd = ''
    let profilesCache: AgentProfile[] = [] // Phase-4/04 picker (refreshed on open)
    const profileByProvider = new Map<string, string>()
    let openGeneration = 0
    let launching = false

    let roster: AgentInfo[] = []
    let presets: ProviderMixTemplate[] = []
    let recents: RecentWorkspace[] = []
    // Tool plan (8/09): connected (non-house) servers the user can scope this
    // workspace to. Empty selection = house only (minimal by default). The
    // section always shows now (store/inventory split): with no connected
    // servers it offers the Library — the moment of need IS workspace creation.
    let pickableServers: { id: string; label: string }[] = []
    const selectedTools = new Set<string>()
    // Set per open (it closes over the open generation); the Library's onClose
    // calls it so a tool connected mid-wizard appears as a chip immediately.
    let refreshToolsList: (() => void) | null = null

    const body = el('div', { class: 'wizard' })
    const footer = el('div', { class: 'wizard-footer' })

    // The page, mounted once. View routing (display:none on the inactive views)
    // shows it; nothing is re-mounted on a view trip.
    const page = el('div', {}, [
      el('div', { class: 'wizard-page' }, [
        el('header', { class: 'wizard-head' }, [
          el('div', { class: 'wizard-head-text' }, [
            el('h1', { class: 'wizard-title', text: 'New workspace' }),
            el('p', { class: 'wizard-subtitle', text: 'Folder, layout, agents — nothing hidden.' })
          ]),
          Button({ label: 'Cancel', icon: 'chevron-left', variant: 'ghost', size: 'sm', onClick: leave })
        ]),
        body,
        footer
      ])
    ])
    page.id = 'view-wizard'
    ctx.content.append(page)

    // Esc leaves, back to wherever the user came from — the Settings-page contract.
    // Overlays above the page (palette, dialogs) own their own Esc.
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented || activeView() !== 'wizard') return
      if (document.querySelector('.palette-overlay:not([hidden]), .modal-overlay')) return
      e.preventDefault()
      leave()
    })

    setWizardOpener(open) // the port `workspace:new` (Ctrl+T) and Home's CTA call

    const currentOpen = (generation: number): boolean =>
      generation === openGeneration && activeView() === 'wizard'

    const applyRoster = (next: readonly AgentInfo[]): void => {
      roster = [...next]
      // A CLI removed while this page is open cannot remain invisibly assigned — its
      // terminals fall back to plain shells. ('custom' and 'shell' are not roster ids.)
      slots = slots.map((id) =>
        id && id !== 'custom' && !roster.some((agent) => agent.id === id && agent.installed) ? null : id
      )
      if (brush && brush !== 'custom' && brush !== 'shell' && !roster.some((a) => a.id === brush && a.installed)) {
        brush = null // the armed brush's CLI is gone; painting nothing beats painting a ghost
      }
      normalizeAssignmentsToCapacity()
      renderRoster()
    }

    onAgentRegistryChange((next) => {
      if (activeView() === 'wizard') applyRoster(next)
    })

    function leave(): void {
      openGeneration++
      selection?.dispose()
      cdLine?.dispose()
      for (const panel of setupPanels.splice(0)) panel.dispose()
      launching = false
      goBack()
    }

    function open(prefill?: WizardPrefill): void {
      const generation = ++openGeneration
      selection?.dispose()
      name = prefill?.name ?? ''
      cwd = prefill?.cwd ?? ''
      localCwd = cwd
      remoteCwd = ''
      barTouched = false
      nameAuto = !prefill?.name // a prefilled name is a chosen one; otherwise follow the folder
      lastAutoCwd = ''
      // The view flips FIRST, then the chrome is measured: capacity subtracts what
      // this app keeps around the content region (rail, titlebar), and measuring
      // while the OUTGOING view still owned the layout read that view's chrome.
      // Same task as render() below — nothing stale can paint in between. The
      // machine term charges every pane already running anywhere (a terminal in
      // another workspace spends the same RAM/CPU this one would). With ZERO
      // workspaces the wizard runs full-bleed (no rail) — but the grid it is
      // sizing for always carries one, so the hidden rail's width is reserved
      // explicitly or the budget overpromises until the first workspace exists.
      setActiveView('wizard')
      const railEl = document.getElementById('rail')
      const railAllowance =
        railEl && railEl.offsetParent === null
          ? parseFloat(getComputedStyle(railEl).getPropertyValue('--rail-w')) || 0
          : 0
      capacity = effectivePaneCapacity(ctx.content, machineSpec(), livePaneCount(), railAllowance)
      setGridSpec(specForPanes(Math.min(prefill?.paneCount ?? defaultPaneCount(), capacity.maxPanes)))
      slots = Array<string | null>(paneCount).fill(null)
      brush = null
      customCmd = ''
      isolate = false
      // A fresh page must not inherit the last one's verdict about a folder it may not
      // even be looking at any more.
      isolatePreflight = null
      preflightCwd = null
      remoteHost = null
      roster = [...getAgentRegistry()]
      presets = []
      recents = []
      pickableServers = []
      profilesCache = []
      profileByProvider.clear()
      launching = false
      selectedTools.clear()
      if (prefill?.mix) applyMix(prefill.mix)

      render()
      // Focus lands on the CD LINE, not the folder bar. The bar already holds a real, usable
      // answer the moment the page opens (your home folder — see the homeDir call below), so
      // focusing it invited you to retype something that was already correct. The cd line is
      // the empty control: it is where a keystroke actually means something, and it is the
      // one that behaves like the terminal this app is made of. Falls back to the bar if the
      // cd line could not be built.
      requestAnimationFrame(() => (cdLine ? cdLine.input.focus() : path.focus()))
      getTelemetry().captureEvent({ name: 'wizard.opened', props: { prefilled: !!prefill } })

      // The cd line's `~` target — and, when nothing was prefilled, THE default:
      // a fresh page chooses your HOME folder. A real folder in the bar, not
      // placeholder fiction; everything else (browse, cd, recents) moves on from
      // there. Guarded so a folder the user picked or typed in the meantime is
      // never stomped by the late-arriving answer.
      void wizardClient
        .homeDir()
        .then((h) => {
          if (!h || !currentOpen(generation)) return
          homeCache = h
          const s = selection.state()
          if (!barTouched && !s.cwd.trim() && !s.remote) selection.set(h, 'prefill')
        })
        .catch(() => undefined)

      // Fresh data every open. Each arrival patches only its own subtree — a full
      // re-render would blow away the folder field's focus and caret mid-type.
      void refreshAgentRegistry()
        .then((agents) => {
          if (currentOpen(generation)) applyRoster(agents)
        })
        .catch(() => undefined)
      void (getBridge().invoke(ProfileChannels.list) as Promise<AgentProfile[]>)
        .then((list) => {
          if (!currentOpen(generation)) return
          profilesCache = list ?? []
          renderRoster()
        })
        .catch(() => undefined)
      void wizardClient
        .listPresets()
        .then((p) => {
          if (!currentOpen(generation)) return
          // The user's own saves ONLY. The channel still ships the built-in mixes
          // (Home's launcher + asyncstate lean on a never-empty list); the wizard
          // deliberately offers none of them — see buildPresets.
          presets = (p ?? []).filter((preset) => !preset.id.startsWith('preset-'))
          renderPresets()
        })
        .catch(() => {
          if (currentOpen(generation)) presets = []
        })
      refreshToolsList = (): void => {
        void (getBridge().invoke(IntegrationsChannels.serversList) as Promise<McpServerEntry[]>)
          .then((servers) => {
            if (!currentOpen(generation)) return
            pickableServers = (servers ?? []).filter((s) => !s.builtIn).map((s) => ({ id: s.id, label: s.label }))
            renderTools()
          })
          .catch(() => {
            if (currentOpen(generation)) pickableServers = []
          })
      }
      refreshToolsList()
      void wizardClient
        .loadState()
        .then((s) => {
          if (!currentOpen(generation)) return
          const openWs = (s?.workspaces ?? []).filter((w) => w.cwd)
          const closed = s?.recents ?? []
          const seen = new Set<string>()
          recents = [
            ...closed,
            ...openWs.map((w) => ({ name: w.name, cwd: w.cwd, paneCount: w.paneCount, assignments: w.assignments, lastUsedAt: 0 }))
          ]
            .filter((r) => {
              if (!r.cwd || seen.has(r.cwd)) return false
              seen.add(r.cwd)
              return true
            })
            .slice(0, 6)
          renderRecents()
        })
        .catch(() => {
          if (currentOpen(generation)) recents = []
        })
    }

    /** The ONE writer of the grid spec — keeps the derived pane count in step. */
    function setGridSpec(next: GridSpecModel): void {
      gridSpec = next
      paneCount = gridSpec.regions.length
    }

    /** Seed the slots from a preset/prefill mix; grow the grid to fit the mix. Mix order
     *  fills from terminal 0 — a mix carries no placement, so first-come is the honest
     *  expansion (and matches what the old counts model launched). */
    function applyMix(mix: ProviderCount[]): void {
      customCmd = ''
      const flat: string[] = []
      for (const m of mix) {
        if (m.count <= 0) continue
        if (m.provider === 'shell') continue // shells are the default; they claim no slot
        if (m.provider.startsWith('custom:')) {
          customCmd = m.provider.slice('custom:'.length)
          for (let i = 0; i < m.count; i++) flat.push('custom')
        } else {
          // A preset outlives its CLIs. A mix naming a provider that is no longer
          // installed must not become an assignment — Launch would type a command the
          // shell cannot find. applyRoster enforces exactly this invariant when the
          // registry CHANGES; the preset/prefill path lands here. An EMPTY roster means
          // detection has not answered yet — keep the mix; the open() refresh prunes
          // with real data.
          if (roster.length && !roster.some((a) => a.id === m.provider && a.installed)) continue
          for (let i = 0; i < m.count; i++) flat.push(m.provider)
        }
      }
      const shells = mix.filter((m) => m.provider === 'shell').reduce((s, m) => s + m.count, 0)
      const total = flat.length + shells
      if (total > paneCount) setGridSpec(specForPanes(Math.min(capacity.maxPanes, total)))
      slots = Array<string | null>(paneCount).fill(null)
      flat.slice(0, paneCount).forEach((id, i) => (slots[i] = id))
    }

    /** Keep the assignment aligned with the grid: one entry per terminal, by index, so a
     *  resize keeps what it can and a shrink drops from the end — the same terminals the
     *  shrink itself removed. Custom entries with no command cannot survive either. */
    function normalizeAssignmentsToCapacity(): void {
      if (slots.length < paneCount) slots = [...slots, ...Array<string | null>(paneCount - slots.length).fill(null)]
      else if (slots.length > paneCount) slots = slots.slice(0, paneCount)
      if (!customCmd.trim()) slots = slots.map((id) => (id === 'custom' ? null : id))
    }

    const assignedTotal = (): number => slots.filter(Boolean).length

    /** How many terminals `id` owns right now — the chips' ×N readouts. */
    const countOf = (id: string): number => slots.filter((s) => s === id).length

    /** The per-terminal assignment, in slot order — THE launch manifest. Unlike the old
     *  counts expansion, this preserves WHERE the user put each agent. */
    function expandAssignments(): string[] {
      const cmd = customCmd.trim()
      return Array.from({ length: paneCount }, (_, i) => {
        const id = slots[i]
        if (!id) return 'shell'
        if (id === 'custom') return cmd ? `custom:${cmd}` : 'shell'
        return id
      })
    }

    const providerColor = (id: string): string => providerAccent(id)
    function providerInitial(id: string): string {
      if (id.startsWith('custom:')) return '›'
      return roster.find((a) => a.id === id)?.name ?? id
    }

    async function launch(skipAgents: boolean, generation: number): Promise<boolean> {
      normalizeAssignmentsToCapacity()
      // THE LAUNCH SNAPSHOT. Everything below runs across awaits — the profile
      // re-check, resolve(), one `git worktree add` PER AGENT (seconds on a real
      // repo) — while the page stays interactive: only the footer buttons disable.
      // Reading the live wizard state after those awaits let a keystroke or a
      // recent-folder click mid-transaction retarget the launch: worktrees created
      // under repo A, the workspace opened at half-typed B, and the rollback asking
      // B to remove A's worktrees (refused as not-managed). The transaction acts on
      // ONE moment — this one — and later input changes only the NEXT launch.
      const snap = {
        cwd,
        name,
        isRepo,
        isolate,
        paneCount,
        gridSpec: {
          rows: gridSpec.rows,
          cols: gridSpec.cols,
          regions: gridSpec.regions.map((region) => ({ ...region }))
        },
        customCmd: customCmd.trim(),
        // THE PLACEMENT, slot by slot — what the user painted is what opens. `skipAgents`
        // means exactly that: every terminal is a plain shell, whatever was painted.
        assignments: skipAgents ? Array<string>(paneCount).fill('shell') : expandAssignments(),
        hasBlankCustom: !skipAgents && slots.includes('custom') && !customCmd.trim(),
        remoteHost: remoteHost ? { ...remoteHost } : null,
        profileByProvider: new Map(profileByProvider),
        scopeTools: pickableServers.length > 0,
        selectedTools: [...selectedTools]
      }
      // BOTH surfaces get the whole message. The chip keeps it verbatim (it is the
      // machine-readable one — WIZARDFAIL reads `.path-input-status` and matches on the
      // text, so shortening it here would quietly retire the gate); the alert is the one a
      // human can actually READ, because the chip is a single ellipsised line and git's
      // explanation never survived it.
      const refuse = (message: string): false => {
        path.setStatus({ kind: 'warn', text: message })
        showLaunchAlert(message)
        return false
      }
      if (!currentOpen(generation)) return false
      if (snap.hasBlankCustom) {
        return refuse('Enter a custom command or set its count to zero.')
      }

      // The mix is the ASSIGNMENT's multiset, in roster order — presets, the resolve
      // validation, and telemetry all still speak counts; only placement is new.
      const mix: ProviderCount[] = []
      for (const a of roster) {
        const n = snap.assignments.filter((id) => id === a.id).length
        if (n > 0) mix.push({ provider: a.id, count: n })
      }
      const customTotal = snap.assignments.filter((id) => id.startsWith('custom:')).length
      if (customTotal > 0) mix.push({ provider: `custom:${snap.customCmd}`, count: customTotal })
      const assigned = mix.reduce((s, m) => s + m.count, 0)
      if (snap.paneCount - assigned > 0) mix.push({ provider: 'shell', count: snap.paneCount - assigned })

      // Re-verify only the profiles this launch actually uses. A picker choice for a
      // provider whose count is zero is not part of the launch — a profile deleted in
      // Settings must not refuse a workspace that never referenced it.
      const mixProviders = new Set<string>(mix.map((m) => m.provider))
      const selectedProfileIds = [
        ...new Set(
          [...snap.profileByProvider.entries()]
            .filter(([provider]) => mixProviders.has(provider))
            .map(([, id]) => id)
        )
      ]
      if (!skipAgents && selectedProfileIds.length) {
        let latestProfiles: AgentProfile[]
        try {
          latestProfiles = ((await getBridge().invoke(ProfileChannels.list)) as AgentProfile[]) ?? []
        } catch {
          return refuse('Could not verify the selected agent profiles. Try again before launching.')
        }
        if (!currentOpen(generation)) return false
        const missing = selectedProfileIds.find((id) => !latestProfiles.some((profile) => profile.id === id))
        if (missing) return refuse('A selected agent profile no longer exists. Choose a profile again before launching.')
      }

      // EXACT resolve: the painter's pane count IS the layout (three panes is a real
      // arrangement there, never "a 4-grid minus one"). The resolve VALIDATES the mix
      // (and is WIZARDFAIL's fault seam), but the assignments the workspace opens with
      // are snap.assignments — the resolve's own expansion is counts-ordered and would
      // throw away where the user painted each agent.
      let resolved: { paneCount: number; assignments: string[] }
      try {
        resolved = await wizardClient.resolve(mix, true)
      } catch {
        return refuse('Could not resolve the workspace layout. No workspace or agent was started.')
      }
      if (!currentOpen(generation)) return false

      // The painter's arrangement as the split tree the workspace opens with. Merges
      // are gated at paint time (mergeRegions refuses unbuildable shapes), so this
      // conversion cannot fail for painter output; a null still falls back honestly
      // to the pane-count template grid rather than refusing the launch.
      const layoutTree = resolved.paneCount === snap.paneCount ? treeForRegions(snap.gridSpec) : null
      const layout = layoutTree ? serializeTree(layoutTree) : undefined

      // Worktree isolation (3/03): every agent slot gets its own worktree before
      // anything opens. A partial failure rolls this transaction back.
      let paneCwds: (string | null)[] | undefined
      const createdWorktrees: string[] = []
      const rollbackWorktrees = async (): Promise<boolean> => {
        let clean = true
        for (const worktreePath of [...createdWorktrees].reverse()) {
          try {
            const removed = await wizardClient.removeWorktree(snap.cwd, worktreePath)
            if (!removed.ok) clean = false
          } catch {
            clean = false
          }
        }
        return clean
      }
      if (!skipAgents && snap.isolate && snap.isRepo && snap.cwd) {
        // One `git worktree add` per agent slot, in PARALLEL: each add gets its own
        // random slug + branch (no shared ref, no shared path), so the adds never
        // contend and the wall-clock is the SLOWEST add, not their sum — sequential
        // creation was seconds of dead time on a real repo with a few agents.
        // Every job SETTLES before any verdict is reached: a rollback issued while a
        // sibling create was still in flight could not name its path and would leak
        // the worktree (WIZARDFAIL asserts leak-zero on partial failure).
        const jobs: Promise<{ path: string } | { error?: string } | null>[] = snap.assignments.map((assignment) =>
          assignment && assignment !== 'shell'
            ? wizardClient
                .createWorktree(snap.cwd)
                .then((wt) => (wt.ok && wt.path ? { path: wt.path } : { error: wt.error }))
                .catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }))
            : Promise.resolve(null)
        )
        const settled = await Promise.all(jobs)
        for (const job of settled) if (job && 'path' in job) createdWorktrees.push(job.path)
        if (!currentOpen(generation)) {
          await rollbackWorktrees()
          return false
        }
        const failure = settled.find((job): job is { error?: string } => !!job && !('path' in job))
        if (failure) {
          const cleaned = await rollbackWorktrees()
          return refuse(
            `Could not isolate every agent${failure.error ? `: ${failure.error}` : '.'} No workspace was opened.` +
              (cleaned ? '' : ' A temporary worktree also needs manual cleanup.')
          )
        }
        paneCwds = settled.map((job) => (job && 'path' in job ? job.path : null))
      }

      // The remote path's cwd rides on the REMOTE entry, never in paneCwds: a paneCwd is a
      // local path, and the far-side folder must never be handed to a local filesystem API.
      const selectedRemote = snap.remoteHost ? { ...snap.remoteHost, cwd: snap.cwd.trim() ? snap.cwd : undefined } : null
      try {
        const opened = await openPlannedWorkspaceFromTemplate({
          name: snap.name.trim() || basename(snap.cwd) || 'Workspace',
          cwd: snap.remoteHost ? '' : snap.cwd,
          paneCount: resolved.paneCount,
          // snap.assignments, not resolved.assignments: same multiset (the resolve took
          // its mix FROM these), but slot-ordered — terminal 3 runs what was painted on
          // terminal 3, not whatever the counts expansion happened to put there.
          assignments: snap.assignments,
          paneCwds: snap.remoteHost ? undefined : paneCwds,
          remotes: selectedRemote
            ? Array<{ hostId: string; name: string; cwd?: string } | null>(resolved.paneCount).fill(selectedRemote)
            : undefined,
          profileIds: snap.assignments.map((a) => (a && snap.profileByProvider.has(a) ? snap.profileByProvider.get(a)! : null)),
          // Scope only when there ARE connected servers to scope (else leave the
          // CLIs' global config untouched — no silent stripping, 8/09).
          tools: snap.scopeTools ? snap.selectedTools : undefined,
          layout
        })
        if (!opened) throw new Error('The workspace service is unavailable. No workspace or agent was started.')
      } catch (error) {
        const cleaned = await rollbackWorktrees()
        return refuse(
          (error instanceof Error ? error.message : String(error)) +
            (cleaned ? '' : ' A temporary worktree also needs manual cleanup.')
        )
      }
      getTelemetry().captureEvent({
        name: 'wizard.completed',
        props: {
          panes: resolved.paneCount,
          agents: snap.assignments.filter((a) => a && a !== 'shell').length,
          custom: snap.assignments.some((a) => a.startsWith('custom:')),
          skipped_agents: skipAgents,
          merged: snap.gridSpec.regions.some((region) => region.rs > 1 || region.cs > 1),
          isolated: paneCwds !== undefined // a boolean — never the paths (ADR 0005)
        }
      })
      // The workspace opener switches the app to the live grid; if no workspace
      // feature is mounted (tests), fall back to wherever we came from.
      if (activeView() === 'wizard') leave()
      return true
    }

    // ── One page ─────────────────────────────────────────────────────────────
    // Live handles the subtree renderers patch. Assigned in render(); every one
    // is non-null for the lifetime of an open page.
    let path!: PathInputHandle
    let browser!: FolderBrowserHandle
    let selection!: PathSelectionHandle
    let cdLine: CdLineHandle | null = null
    let chosenLine!: HTMLParagraphElement
    let whereSection!: HTMLElement
    let nameInputEl!: HTMLInputElement
    let recentsHost!: HTMLElement
    let recentsSection!: HTMLElement
    let layoutReadout!: HTMLElement
    let summaryCount!: HTMLElement
    let summaryShape!: HTMLElement
    let painter!: GridPainterHandle
    let agentsCaption!: HTMLElement
    let rosterHost!: HTMLElement
    let paletteHost!: HTMLElement
    let brushHint!: HTMLElement
    let profilesHost!: HTMLElement
    let presetsHost!: HTMLElement
    let toolsSection!: HTMLElement
    let toolsHost!: HTMLElement
    let meterFill!: HTMLElement
    let meterLabel!: HTMLElement
    let launchLabel!: HTMLElement
    let launchBtn!: HTMLButtonElement
    let skipBtn!: HTMLButtonElement
    let saveBtn!: HTMLButtonElement
    let isolateBox!: ReturnType<typeof createCheckbox>
    let isolateHint!: HTMLElement
    let isolateFix!: HTMLButtonElement
    let launchAlert!: HTMLElement
    let customInput!: HTMLInputElement
    let customStepper: StepperHandle | null = null
    /** Live setup panels on the roster's missing-CLI cards — each owns an IPC subscription. */
    const setupPanels: AgentSetupPanelHandle[] = []

    /** Push the slots' truth back into the custom row — value, ceiling, enablement. */
    function syncCustom(): void {
      if (!customInput || !customStepper) return
      if (customInput.value !== customCmd) customInput.value = customCmd
      const mine = countOf('custom')
      customStepper.setValue(mine)
      customStepper.setMax(mine + (paneCount - assignedTotal()))
      customStepper.setDisabled(!customCmd.trim())
    }

    /** One flat section: uppercase label + inline hint (+ a right-aligned live slot),
     *  the house division hairline, then the content. Nothing folds — the redesign's
     *  whole point is that every control is visible. */
    function section(
      label: string,
      hint: string,
      right: ElChild,
      children: ElChild[],
      extraClass = ''
    ): HTMLElement {
      return el('section', { class: `wizard-sec${extraClass ? ` ${extraClass}` : ''}` }, [
        el('div', { class: 'wizard-sec-head' }, [
          el('span', { class: 'wizard-sec-label', text: label }),
          hint ? el('span', { class: 'wizard-sec-hint', text: hint }) : null,
          right ? el('span', { class: 'wizard-sec-right' }, [right]) : null
        ]),
        ...children
      ])
    }

    function render(): void {
      selection?.dispose()
      cdLine?.dispose()
      clear(body)
      clear(footer)
      customStepper = null
      chosenLine = el('p', { class: 'wizard-chosen' }) // the selection's subscriber writes it
      // Rebuilt with the page: its subscribers close over this render's DOM.
      selection = createPathSelection({ listDir: (p) => wizardClient.listDir({ path: p }), gitQuery: wizardClient.gitQuery })

      body.append(
        buildWhere(),
        buildRecents(),
        buildLayout(),
        buildAgents(),
        buildTools(),
        buildOptions(),
        buildPresets()
      )
      buildFooter()

      renderRecents()
      renderRoster()
      renderPresets()
      renderTools()
    }

    // ── Where ────────────────────────────────────────────────────────────────
    function buildWhere(): HTMLElement {
      const generation = openGeneration
      const ownedSelection = selection
      path = createPathInput({
        value: cwd,
        onBrowse: () => {
          void wizardClient.browseDir().then((dir) => {
            if (dir && currentOpen(generation) && selection === ownedSelection) ownedSelection.set(dir, 'native')
          })
        },
        onInput: (v) => {
          barTouched = true // the human is typing here — the home default may not interrupt
          ownedSelection.set(v, 'bar') // the controller owns the debounce
        },
        // Enter fires ~0ms after the last keystroke — wait for the resolve, then launch.
        onEnter: () => void tryLaunch(false)
      })

      browser = createFolderBrowser({
        listDir: wizardClient.listDir,
        // The browser caused this, so the controller will not write back into it.
        onSelect: (p) => ownedSelection.set(p, 'browser')
      })

      // ── The ONE subscriber that keeps every view honest ──────────────────────
      // Ping-pong cannot form: the view that originated a change is never written to.
      selection.subscribe((s, origin, listing) => {
        cwd = s.cwd
        isRepo = s.isRepo
        if (s.remote) remoteCwd = s.cwd
        else localCwd = s.cwd

        if (origin !== 'bar') path.setValue(s.cwd) // writing the bar while typing eats the caret
        path.setStatus(statusFor(s))

        browser.el.hidden = s.remote
        if (!s.remote && origin !== 'browser') {
          if (listing) browser.applyListing(listing, s.cwd)
          // A half-typed path must not throw away where the browser is; anything else
          // that refuses (a recent folder now gone) should say so on the spot.
          else if (s.refusal && origin !== 'bar') browser.showRefusal(s.refusal)
        }

        // THE AUTOMATIC NAME. Until the user types one, the workspace's name IS
        // the chosen folder's basename — and it FOLLOWS the folder through every
        // pick, cd, recent and typed path, because a name seeded once and left
        // behind is worse than none: it quietly labels folder B with folder A's
        // name. Only a real folder CHANGE rewrites it (`lastAutoCwd`), so the
        // same folder's later emits (probe pulses, listing arrivals) can never
        // clobber a nicer auto name a recent just supplied.
        if (nameInputEl && nameAuto && s.cwd !== lastAutoCwd) {
          lastAutoCwd = s.cwd
          const auto = basename(s.cwd)
          nameInputEl.value = auto
          name = auto
          nameInputEl.placeholder = auto || 'Workspace name'
        }
        updateChosen()
        probeIsolation(origin)
      })

      // A prefilled folder (Ctrl+T from a workspace, a board card) is the selection;
      // otherwise open()'s homeDir answer chooses HOME the moment it lands.
      if (cwd) ownedSelection.set(cwd, 'prefill')

      const nameInput = el('input', {
        class: 'input wizard-name-input',
        type: 'text',
        value: name,
        placeholder: cwd ? basename(cwd) : 'Workspace name',
        ariaLabel: 'Workspace name — follows the folder until you type one',
        onInput: (e) => {
          name = (e.target as HTMLInputElement).value
          // Typing claims the name; CLEARING hands it back to the folder (the
          // ghost shows what it will be, and the next folder change refills it —
          // lastAutoCwd resets so even a return to a seen folder counts as one).
          nameAuto = name.trim() === ''
          if (nameAuto) {
            lastAutoCwd = ''
            nameInputEl.placeholder = basename(cwd) || 'Workspace name'
          }
        },
        onKeydown: (e) => {
          if (e.key === 'Enter') void tryLaunch(false)
        }
      })
      nameInputEl = nameInput

      // The cd line: shell muscle memory as a folder picker — cd-only, with Tab
      // completion (cd-line.ts). It resolves against the chosen folder (home when
      // none) and hands the result to the SAME selection controller every other
      // view feeds — the probe/refusal story stays one story.
      cdLine = createCdLine({
        listDir: wizardClient.listDir,
        base: () => selection.state().cwd,
        home: () => homeCache,
        onCd: (target) => {
          if (currentOpen(generation) && selection === ownedSelection) ownedSelection.set(target, 'native')
        }
      })

      whereSection = section(
        'Working folder',
        'Your terminals start here — type a path, cd to it, or click through.',
        null,
        [el('div', { class: 'wizard-where-row' }, [path.el, nameInput]), cdLine.el, chosenLine, browser.el],
        'wizard-sec--where'
      )
      updateChosen()
      return whereSection
    }

    /** What a refusal reads like in one line, on the bar and on the chosen line. */
    const REFUSAL_TEXT: Record<string, string> = {
      denied: 'locked — no permission',
      missing: 'no folder there',
      'not-a-directory': "that's a file",
      invalid: 'not a full path',
      unavailable: 'could not verify this folder — try again'
    }

    /** The path bar's chip, derived — never set from a call site. */
    function statusFor(s: Readonly<PathState>): PathStatus {
      if (s.remote) {
        if (s.cwd.trim() && !selection.isUsable()) return { kind: 'warn', text: 'use an absolute path like /srv/project' }
        return { kind: 'ok', text: `remote: ${remoteHost?.name ?? ''} — local repo tools off` }
      }
      if (!s.cwd.trim()) return { kind: 'idle' }
      if (s.probing) return { kind: 'idle' } // no flicker while a keystroke settles
      if (s.refusal) return { kind: 'warn', text: REFUSAL_TEXT[s.refusal.reason] ?? 'unverified' }
      if (s.git) return { kind: 'git', text: `${s.git.branch}${s.git.dirty ? ' •' : ''}` }
      return { kind: 'ok', text: 'no repo — fine' }
    }

    /** The small current-folder line between the path bar and the browser. */
    function updateChosen(): void {
      if (!chosenLine || !selection) return
      const s = selection.state()
      clear(chosenLine)
      chosenLine.title = s.cwd
      if (s.remote) {
        chosenLine.append(`Runs on ${remoteHost?.name ?? 'a remote host'} — the path above is a folder on that machine.`)
        return
      }
      if (!s.cwd.trim()) {
        chosenLine.append('No folder chosen yet — pick one below.')
        return
      }
      if (s.refusal) {
        chosenLine.append('Can’t use that path — ', el('strong', { text: REFUSAL_TEXT[s.refusal.reason] ?? 'unverified' }))
        return
      }
      chosenLine.append('Terminals will start in ', el('strong', { text: basename(s.cwd) || s.cwd }))
    }

    // ── Recent folders ───────────────────────────────────────────────────────
    function buildRecents(): HTMLElement {
      recentsHost = el('div', { class: 'wizard-recents' })
      recentsSection = section('Recent', 'One click — folder and name follow.', null, [recentsHost])
      return recentsSection
    }

    function renderRecents(): void {
      if (!recentsHost) return
      clear(recentsHost)
      recentsSection.hidden = recents.length === 0
      for (const r of recents) {
        recentsHost.append(
          el(
            'button',
            {
              class: 'wizard-recent',
              type: 'button',
              title: r.cwd,
              // A recent is a one-click jump. One call: bar, browser, chip, chosen line
              // and the isolate toggle all follow from the selection changing. The
              // SAVED name lands after the synchronous emit, so it wins over the
              // basename for THIS folder — and the next folder change replaces it,
              // like any automatic name.
              onClick: () => {
                selection.set(r.cwd, 'recent')
                if (nameAuto && r.name) {
                  name = r.name
                  nameInputEl.value = r.name
                }
              }
            },
            [
              icon('folder', 14),
              el('span', { class: 'wizard-recent-text' }, [
                el('span', { class: 'wizard-recent-name', text: r.name || basename(r.cwd) }),
                el('span', { class: 'wizard-recent-path', text: r.cwd })
              ]),
              typeof r.paneCount === 'number' && r.paneCount > 0
                ? el('span', { class: 'wizard-recent-count', text: String(r.paneCount) })
                : null
            ]
          )
        )
      }
    }

    // ── Layout: the dynamic painter + its live summary ───────────────────────
    function buildLayout(): HTMLElement {
      layoutReadout = el('span', { class: 'wizard-layout-readout', text: layoutReadoutText() })
      summaryCount = el('span', { class: 'wizard-summary-count' })
      summaryShape = el('span', { class: 'wizard-summary-line' })
      painter = createGridPainter({
        value: gridSpec,
        // The lattice offers what this screen holds (display-clamped so a 6K panel
        // doesn't paint a wall of dots); the pane budget itself blocks the rest.
        maxRows: Math.min(capacity.maxRows, 8),
        maxCols: Math.min(capacity.maxCols, 12),
        maxPanes: capacity.maxPanes,
        onChange: (spec) => {
          setGridSpec(spec)
          // Placement follows the grid by index; the palette's readouts and the custom
          // stepper's ceiling both move with it.
          renderAgentControls()
        },
        // THE PLACEMENT SURFACE (redesign, 2026-08-01): with a chip armed, the canvas
        // paints agents; bare, a click on a terminal opens its own picker. Structural
        // gestures (drag-merge, click-splits-merged) are untouched.
        brush: () => brush,
        onPaint: paintSlot,
        onPickSlot: openSlotPicker,
        slotChip: (slot) => {
          const id = expandAssignments()[slot]
          if (!id || id === 'shell') return null
          return {
            color: providerColor(id),
            mark: providerLogo(id, 14),
            label: providerInitial(id).slice(0, 1).toUpperCase()
          }
        }
      })
      // The summary column earns the section's right side: the numbers at a glance,
      // the screen's honest budget, and the way back to a plain grid.
      const resetBtn = Button({
        label: 'Reset grid',
        size: 'sm',
        variant: 'ghost',
        onClick: () => {
          setGridSpec(uniformSpec(gridSpec.rows, gridSpec.cols))
          painter.set(gridSpec)
          refreshAgents()
        }
      })
      const summary = el('div', { class: 'wizard-layout-summary' }, [
        summaryCount,
        summaryShape,
        layoutReadout,
        el('span', { class: 'wizard-hint', text: capacityHintText() }),
        resetBtn
      ])
      return section(
        'Layout',
        'Pick a size on the dots. Drag across terminals to merge; click a merged one to split.',
        null,
        [el('div', { class: 'wizard-layout-row' }, [painter.el, summary])]
      )
    }

    function layoutReadoutText(): string {
      const merged = gridSpec.regions.filter((region) => region.rs > 1 || region.cs > 1).length
      return `${paneCount} ${plural(paneCount)} · ${gridSpec.rows}×${gridSpec.cols}${merged ? ' · merged' : ''}`
    }

    /** The budget, in words: what stopped the count where it did. A machine-bound
     *  budget says so — a user staring at blocked dots deserves the reason, and
     *  "your screen" would be a lie when the screen had room for more. */
    function capacityHintText(): string {
      const machineBound = capacity.maxPanes < capacity.screenMaxPanes
      const running = capacity.panesElsewhere
        ? ` — with ${capacity.panesElsewhere} already running elsewhere`
        : ''
      if (machineBound) {
        const m = capacity.machine
        const spec = m ? ` (${m.cpuCount} cores · ${Math.round(m.totalMemMb / 1024)} GB)` : ''
        return `Up to ${capacity.maxPanes} terminals here — sized to this machine${spec}${running}, not just your screen (which fits ${capacity.screenMaxPanes}).`
      }
      if (capacity.limitedBy === 'ceiling') {
        return `Up to ${capacity.maxPanes} terminals — the app's ceiling; your screen and machine both take it.`
      }
      return `This screen fits up to ${capacity.maxPanes} terminals (${capacity.maxCols} across, ${capacity.maxRows} down at the minimum pane size).`
    }

    // ── Agents — the PLACEMENT PALETTE (redesign, 2026-08-01) ────────────────
    //
    // The counts-and-steppers roster is gone (explicit direction: "counts say how many,
    // never WHERE — and every quick-fill button was a patch over that"). The model now:
    //
    //   · a CHIP per installed agent (+ custom + shell). Click arms it as the BRUSH;
    //     the layout canvas then paints that agent onto any terminal you click or drag
    //     across. Click the chip again to put the brush down.
    //   · double-click a chip — or its ▾ menu — fills every terminal (or just the empty
    //     ones) with that agent. The old global "Fill all" (which round-robined through
    //     EVERY installed CLI) and its siblings are gone; one global Clear remains.
    //   · click a terminal with NO brush armed and it opens its own picker — the
    //     zero-learning-curve path to the same placement.
    //
    // Each chip wears a live ×N readout — counts became outputs, not inputs.
    function buildAgents(): HTMLElement {
      agentsCaption = el('span', { class: 'wizard-sec-hint', text: agentsText() })
      meterFill = el('span', { class: 'wizard-meter-fill' })
      meterLabel = el('span', { class: 'wizard-fill-label' })
      const meter = el('span', { class: 'wizard-meter' }, [
        el('span', { class: 'wizard-meter-track' }, [meterFill]),
        meterLabel
      ])
      paletteHost = el('div', { class: 'wizard-palette', role: 'toolbar', ariaLabel: 'Agent brushes' })
      brushHint = el('p', { class: 'wizard-hint wizard-brush-hint' })
      profilesHost = el('div', { class: 'wizard-profiles' })
      rosterHost = el('div', { class: 'wizard-agents' })

      // Custom command — any CLI, verbatim. Label only; never a stored credential. The
      // stepper survived the redesign as a VIEW over the slots (value = how many
      // terminals run the custom command; stepping assigns/releases them) — it is also
      // the keyboard path KBAPG pins: spinbutton semantics, clamping, disabled-when-blank.
      customStepper = createStepper({
        value: countOf('custom'),
        min: 0,
        max: countOf('custom') + (paneCount - assignedTotal()),
        ariaLabel: 'Custom command count',
        onChange: (n) => {
          setSlotCount('custom', n)
          renderAgentControls()
        }
      })
      customInput = el('input', {
        class: 'input input--mono wizard-custom-input',
        type: 'text',
        value: customCmd,
        placeholder: 'Custom command — e.g. aider --model …',
        ariaLabel: 'Custom command',
        onInput: (e) => {
          customCmd = (e.target as HTMLInputElement).value
          // An empty command can own no panes: normalize strips its slots, and an armed
          // custom brush goes down with them.
          if (!customCmd.trim() && brush === 'custom') brush = null
          renderAgentControls()
        }
      })
      customStepper.setDisabled(!customCmd.trim())
      const customRow = el('div', { class: 'wizard-agent-row wizard-custom-row' }, [
        el('span', { class: 'wizard-agent-head' }, [providerLogo('custom:', 16), customInput]),
        el('span', { class: 'wizard-agent-tail' }, [customStepper.el])
      ])

      const sec = section('Agents', '', el('span', { class: 'wizard-agents-tools' }, [meter]), [
        paletteHost,
        brushHint,
        customRow,
        profilesHost,
        rosterHost
      ])
      const head = sec.querySelector('.wizard-sec-head')
      head?.insertBefore(agentsCaption, head.children[1] ?? null)
      return sec
    }

    function agentsText(): string {
      return `Who runs in your ${paneCount} ${plural(paneCount)} — paint them on, or leave shells.`
    }

    function brushHintText(): string {
      if (!brush) return 'Pick an agent, then click or sweep across the layout to place it — or click any terminal to choose.'
      if (brush === 'shell') return 'Painting plain shells — click or sweep across terminals to clear them back.'
      const name = brush === 'custom' ? 'the custom command' : (roster.find((a) => a.id === brush)?.name ?? brush)
      return `Painting ${name} — click or sweep across the layout. Double-click the chip to fill every terminal. Click the chip again to stop.`
    }

    /** Grow or shrink `id`'s slot count to n: new ones take the first empty terminals,
     *  releases come off the end — the stepper's view of the same placement model. */
    function setSlotCount(id: string, n: number): void {
      let current = countOf(id)
      for (let i = slots.length - 1; current > n && i >= 0; i--) {
        if (slots[i] === id) {
          slots[i] = null
          current--
        }
      }
      for (let i = 0; current < n && i < slots.length; i++) {
        if (slots[i] === null) {
          slots[i] = id
          current++
        }
      }
    }

    /** Arm (or disarm) a brush. A custom brush with no command is refused by pointing at
     *  the problem: the input takes focus instead of the chip taking state. */
    function armBrush(id: string): void {
      if (id === 'custom' && !customCmd.trim()) {
        customInput?.focus()
        return
      }
      brush = brush === id ? null : id
      renderAgentControls()
    }

    function fillAllWith(id: string): void {
      if (id === 'custom' && !customCmd.trim()) {
        customInput?.focus()
        return
      }
      slots = Array<string | null>(paneCount).fill(id === 'shell' ? null : id)
      renderAgentControls()
      getTelemetry().captureEvent({ name: 'wizard.fill_one', props: { panes: paneCount } })
    }

    function fillEmptyWith(id: string): void {
      if (id === 'custom' && !customCmd.trim()) {
        customInput?.focus()
        return
      }
      slots = slots.map((s) => s ?? (id === 'shell' ? null : id))
      renderAgentControls()
    }

    function clearAssignments(): void {
      slots = Array<string | null>(paneCount).fill(null)
      brush = null
      renderAgentControls()
    }

    /** Paint one terminal with the armed brush (the painter's onPaint). The full control
     *  refresh, not just the canvas: the chips' ×N readouts move WITH the stroke, which
     *  is what makes painting feel accounted for. */
    function paintSlot(slot: number): void {
      if (!brush || slot < 0 || slot >= slots.length) return
      slots[slot] = brush === 'shell' ? null : brush
      renderAgentControls()
    }

    /** The no-brush click on a terminal: its own picker, anchored to the tile. */
    function openSlotPicker(slot: number, anchor: DOMRect): void {
      const entries: ContextMenuEntry[] = roster
        .filter((a) => a.installed)
        .map((a) => ({
          label: a.name,
          hint: slots[slot] === a.id ? 'current' : undefined,
          onSelect: () => {
            slots[slot] = a.id
            renderAgentControls()
          }
        }))
      const cmd = customCmd.trim()
      entries.push({
        label: 'Custom command',
        hint: cmd ? (cmd.length > 24 ? cmd.slice(0, 23) + '…' : cmd) : 'type one below first',
        disabled: !cmd,
        onSelect: () => {
          slots[slot] = 'custom'
          renderAgentControls()
        }
      })
      entries.push({
        label: 'Plain shell',
        hint: slots[slot] === null ? 'current' : undefined,
        onSelect: () => {
          slots[slot] = null
          renderAgentControls()
        }
      })
      openContextMenu({
        items: entries,
        x: anchor.left,
        y: anchor.bottom + 4,
        ariaLabel: `Terminal ${slot + 1} — choose what runs here`
      })
    }

    /** One chip: logo · name · live ×N · a ▾ fills menu. Click arms it as the brush. */
    function paletteChip(id: string, name: string, logoSize = 14): HTMLElement {
      const armed = brush === id
      const n = id === 'shell' ? paneCount - assignedTotal() : countOf(id)
      const body = el(
        'button',
        {
          class: `wizard-chip${armed ? ' is-armed' : ''}`,
          type: 'button',
          title: armed ? `Painting ${name} — click to stop` : `Paint terminals with ${name}`,
          ariaLabel: `${name} brush${n ? ` — ${n} assigned` : ''}`,
          onClick: () => armBrush(id),
          onDblclick: () => fillAllWith(id)
        },
        [
          providerLogo(id === 'custom' ? 'custom:' : id, logoSize),
          el('span', { class: 'wizard-chip-name', text: name }),
          n > 0 ? el('span', { class: 'wizard-chip-count', text: `×${n}` }) : null
        ]
      )
      body.dataset.chip = id
      body.setAttribute('aria-pressed', String(armed))
      if (id === 'shell') return el('span', { class: 'wizard-chip-wrap' }, [body])
      const empty = paneCount - assignedTotal()
      const menu = el(
        'button',
        {
          class: 'wizard-chip-menu',
          type: 'button',
          ariaLabel: `${name} — fill options`,
          onClick: (e) => {
            e.stopPropagation()
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
            openContextMenu({
              items: [
                { label: `Fill all ${paneCount} ${plural(paneCount)}`, onSelect: () => fillAllWith(id) },
                {
                  label: `Fill ${empty} empty ${plural(empty)}`,
                  disabled: empty === 0,
                  onSelect: () => fillEmptyWith(id)
                }
              ],
              x: r.left,
              y: r.bottom + 4,
              returnFocus: e.currentTarget as HTMLElement,
              ariaLabel: `${name} fills`
            })
          }
        },
        [icon('chevron-down', 12)]
      )
      return el('span', { class: 'wizard-chip-wrap' }, [body, menu])
    }

    function renderPalette(): void {
      if (!paletteHost) return
      // A rebuild must not eat the keyboard: whoever held focus gets it back by chip id.
      const focused = (document.activeElement as HTMLElement | null)?.dataset?.chip ?? null
      clear(paletteHost)
      for (const a of roster.filter((agent) => agent.installed)) paletteHost.append(paletteChip(a.id, a.name))
      if (customCmd.trim() || countOf('custom') > 0) paletteHost.append(paletteChip('custom', 'Custom'))
      paletteHost.append(paletteChip('shell', 'Shell'))
      paletteHost.append(
        Button({
          label: 'Clear',
          size: 'sm',
          variant: 'danger',
          title: 'Every terminal back to a plain shell',
          onClick: clearAssignments
        })
      )
      if (focused) paletteHost.querySelector<HTMLElement>(`[data-chip="${focused}"]`)?.focus()
      if (brushHint) brushHint.textContent = brushHintText()
    }

    function renderProfiles(): void {
      if (!profilesHost) return
      clear(profilesHost)
      // Profile picker (4/04), now one compact row per provider that HAS a choice —
      // it used to ride the (deleted) per-agent cards.
      for (const a of roster.filter((agent) => agent.installed)) {
        const mine = profilesCache.filter((p) => p.provider === a.id).sort((x, y) => x.order - y.order)
        if (mine.length < 2) continue
        const sel = el('select', { class: 'input input-sm wizard-profile-select', ariaLabel: `${a.name} profile` }) as HTMLSelectElement
        for (const p of mine) sel.append(new Option(p.name, p.id))
        sel.value = profileByProvider.get(a.id) ?? mine[0].id
        sel.addEventListener('change', () => profileByProvider.set(a.id, sel.value))
        profilesHost.append(
          el('label', { class: 'wizard-profile-row' }, [
            providerLogo(a.id, 13),
            el('span', { class: 'wizard-profile-name', text: `${a.name} profile` }),
            sel
          ])
        )
      }
    }

    /** Everything the palette model touches, in one call: chips, custom row, meter,
     *  painter chips. The one entry point for every placement mutation. */
    function renderAgentControls(): void {
      normalizeAssignmentsToCapacity()
      renderPalette()
      syncCustom()
      refreshAgents()
    }

    /** The agents subtree: palette + profiles + the missing-CLI cards. Rebuilt when the
     *  roster or the profiles list changes; pure placement moves take renderAgentControls. */
    function renderRoster(): void {
      if (!rosterHost) return
      normalizeAssignmentsToCapacity()
      clear(rosterHost)
      // Each rebuild throws the previous cards away; their setup panels hold a live IPC
      // subscription apiece, so they must be released with the DOM that owned them.
      for (const panel of setupPanels.splice(0)) panel.dispose()

      const noneInstalled = roster.length > 0 && roster.every((a) => !a.installed)
      if (!roster.length || noneInstalled) {
        const recheck = el('button', { class: 'wizard-recheck', type: 'button', text: 'Re-check PATH' })
        recheck.onclick = (): void => {
          const generation = openGeneration
          recheck.textContent = 'Checking…'
          recheck.disabled = true
          void refreshAgentRegistry()
            .then((agents) => {
              if (currentOpen(generation)) applyRoster(agents)
            })
            .catch(() => undefined)
            .finally(() => {
              if (recheck.isConnected) {
                recheck.disabled = false
                recheck.textContent = 'Re-check PATH'
              }
            })
        }
        rosterHost.append(
          el('div', { class: 'wizard-agents-empty' }, [
            el('span', {
              class: 'wizard-hint',
              text: roster.length
                ? 'No agent CLIs installed yet — pick one below and hit Install. It handles the dependencies too.'
                : 'Looking for agent CLIs (Claude Code, Codex, Gemini, Aider, OpenCode) on your PATH…'
            }),
            recheck
          ])
        )
      }

      // Installed agents live in the PALETTE now; only the missing ones still take a
      // card — its whole job is the one-click Install (setup-panel.ts, no command shown;
      // the transcript behind Details still records what ran). The moment one installs,
      // the registry push re-renders and it graduates into a chip.
      for (const a of roster) {
        if (a.installed || !a.installHint) continue
        const panel = createAgentSetupPanel({
          agentId: a.id,
          name: a.name,
          compact: true,
          onInstalled: () => void refreshAgentRegistry()
        })
        setupPanels.push(panel)
        // ONE row — logo, name, Install right-aligned (2026-08-01, height complaint).
        // The old two-row anatomy (head row, controls row) existed so missing cards
        // matched installed cards' stepper row; installed agents are palette chips now,
        // so the second row held nothing but a floating button and doubled the card's
        // height for no content. No "not installed" pill either (redundancy pass): the
        // Install button and the grayscale mark already say it. The setup progress still
        // unfolds full-width below while a run is live.
        rosterHost.append(
          el('div', { class: 'wizard-agent-card is-missing' }, [
            el('span', { class: 'wizard-agent-head' }, [
              providerLogo(a.id, 18),
              el('span', { class: 'wizard-agent-name', text: a.name }),
              el('span', { class: 'wizard-agent-action' }, [panel.action])
            ]),
            panel.el
          ])
        )
      }

      renderProfiles()
      renderAgentControls()
    }

    // ── Agent tools (8/09 + the store/inventory split) — ALWAYS visible ──────
    // With connected servers: the pick chips. Without: the Library on-ramp —
    // workspace creation is the moment a user discovers they want a tool, and a
    // hidden section made that discovery impossible.
    function buildTools(): HTMLElement {
      toolsHost = el('div', { class: 'wizard-tools' })
      toolsSection = section(
        'Agent tools',
        'House server always on. Unpicked tools stay out of this workspace’s agents (edit later in Settings › Integrations › Workspace tools).',
        null,
        [toolsHost]
      )
      return toolsSection
    }

    function renderTools(): void {
      if (!toolsHost) return
      clear(toolsHost)
      toolsSection.hidden = false
      if (!pickableServers.length) {
        // The Library reopens ON TOP of the wizard (it is an overlay, not a view
        // change), so the half-configured folder/layout/agents survive the trip.
        toolsHost.append(
          el('div', { class: 'wizard-hint wizard-tools-empty', text: 'No tools connected yet — agents launch with the house server only.' }),
          Button({
            label: 'Browse the Library',
            icon: 'plug',
            variant: 'ghost',
            size: 'sm',
            onClick: () => openLibrary({ onClose: () => refreshToolsList?.() })
          })
        )
        return
      }
      const chips = el('div', { class: 'wizard-tools-chips' })
      for (const s of pickableServers) {
        const chip = el(
          'button',
          {
            class: `wizard-tool-chip${selectedTools.has(s.id) ? ' is-on' : ''}`,
            type: 'button',
            ariaLabel: `Include ${s.label} in this workspace`
          },
          [providerLogo(s.id, 12), el('span', { text: s.label })]
        ) as HTMLButtonElement
        chip.setAttribute('aria-pressed', String(selectedTools.has(s.id)))
        chip.onclick = (): void => {
          if (selectedTools.has(s.id)) selectedTools.delete(s.id)
          else selectedTools.add(s.id)
          chip.classList.toggle('is-on')
          chip.setAttribute('aria-pressed', String(selectedTools.has(s.id)))
        }
        chips.append(chip)
      }
      toolsHost.append(chips)
      toolsHost.append(
        Button({
          label: 'More tools…',
          icon: 'plug',
          variant: 'ghost',
          size: 'sm',
          onClick: () => openLibrary({ onClose: () => refreshToolsList?.() })
        })
      )
    }

    // ── Options: isolation + where it runs — visible, never behind a fold ────
    function buildOptions(): HTMLElement {
      const generation = openGeneration
      const ownedSelection = selection

      isolateBox = createCheckbox({
        // Disabled until the preflight SAYS it can work. Enabling first and failing at
        // Launch is what this replaces.
        checked: false,
        disabled: true,
        label: 'Isolate each agent in its own git worktree',
        onChange: (checked) => {
          isolate = checked
        }
      })
      isolateHint = el('span', { class: 'wizard-hint' })
      isolateFix = el('button', {
        class: 'wizard-inline-fix',
        type: 'button',
        text: 'Find Git',
        hidden: true,
        title: 'Re-read your PATH — picks up anything installed since this app started',
        onClick: repairToolPath
      }) as HTMLButtonElement

      // Remote target (4/05): mutually exclusive with a local folder — choosing a
      // host turns the folder box into a plain remote-cwd string (no local probing).
      const remoteSelect = el('select', { class: 'input wizard-remote-select', ariaLabel: 'Runs on' }) as HTMLSelectElement
      remoteSelect.append(new Option('This machine', ''))
      void (getBridge().invoke(RemoteChannels.list) as Promise<RemoteHost[]>).then((hosts) => {
        if (!currentOpen(generation) || selection !== ownedSelection || !remoteSelect.isConnected) return
        for (const h of hosts ?? []) {
          if (h.platform !== 'posix') continue // legacy hosts need explicit confirmation in Settings
          const opt = new Option(`${h.name} (${h.user ? h.user + '@' : ''}${h.host})`, h.id)
          opt.dataset.name = h.name
          remoteSelect.append(opt)
        }
        if (remoteHost) remoteSelect.value = remoteHost.hostId
      }).catch(() => undefined)
      remoteSelect.addEventListener('change', () => {
        const opt = remoteSelect.selectedOptions[0]
        const nextRemote = remoteSelect.value
          ? { hostId: remoteSelect.value, name: opt?.dataset.name ?? remoteSelect.value }
          : null
        if (nextRemote && !remoteHost) {
          const restoreRemote = remoteCwd
          localCwd = selection.state().cwd
          remoteHost = nextRemote
          selection.setRemote(true)
          remoteCwd = restoreRemote
          selection.set(restoreRemote, 'remote')
        } else if (!nextRemote && remoteHost) {
          const restoreLocal = localCwd
          const restoreRemote = selection.state().cwd
          remoteHost = null
          selection.set('', 'remote')
          remoteCwd = restoreRemote
          selection.setRemote(false)
          localCwd = restoreLocal
          selection.set(restoreLocal, 'prefill')
        } else {
          remoteHost = nextRemote
        }
        if (remoteHost) isolate = false
        // A remote workspace's cwd lives on the OTHER machine. Browsing this disk
        // would answer a question nobody asked — the controller hides it and stops probing.
        // (the branches above already told the controller which machine it is looking at —
        // `selection` is the owned one here, guarded at the top of this handler)
      })

      return section('Options', '', null, [
        el('div', { class: 'wizard-option-row' }, [isolateBox.el, isolateHint, isolateFix]),
        el('div', { class: 'wizard-option-row' }, [
          el('span', { class: 'wizard-option-label', text: 'Runs on' }),
          remoteSelect,
          el('span', { class: 'wizard-hint', text: 'This machine, or a saved SSH host.' })
        ])
      ])
    }

    // ── Presets — the USER'S OWN, nothing offered (2026-07-16) ───────────────
    // The section exists for one loop: set a mix up, SAVE it, get it back with
    // one click next time. Nothing arrives pre-made any more — the built-in
    // mixes and the curated Swarm card offered arrangements nobody had asked
    // for, ahead of folders and agents that are actually theirs. (The built-ins
    // still exist behind the channel for Home's launcher; the wizard filters
    // them out where the list lands.)
    function buildPresets(): HTMLElement {
      presetsHost = el('div', { class: 'wizard-presets' })
      saveBtn = Button({
        label: 'Save as preset',
        size: 'sm',
        variant: 'ghost',
        icon: 'bookmark',
        disabled: assignedTotal() === 0,
        onClick: savePreset
      })
      return section('Presets', 'Save the current mix — it comes back as one click.', saveBtn, [
        el('div', { class: 'wizard-presets-row' }, [presetsHost])
      ])
    }

    function savePreset(): void {
      const presetName = `${expandAssignments().filter((a) => a !== 'shell').length} agents · ${paneCount} panes`
      // A preset stays a MIX (counts, no placement) — it must apply onto any future grid
      // size, and first-come expansion is how applyMix has always seeded one.
      const mix: ProviderCount[] = []
      for (const a of roster) {
        const n = countOf(a.id)
        if (n > 0) mix.push({ provider: a.id, count: n })
      }
      const customTotal = countOf('custom')
      if (customTotal > 0 && customCmd.trim()) mix.push({ provider: `custom:${customCmd.trim()}`, count: customTotal })
      const preset = { id: crypto.randomUUID(), name: presetName, mix }
      void wizardClient.savePreset(preset).then(() => {
        presets = [...presets, preset]
        renderPresets()
        getTelemetry().captureEvent({ name: 'preset.saved', props: { agents: mix.reduce((s, m) => s + m.count, 0) } })
      })
    }

    function renderPresets(): void {
      if (!presetsHost) return
      clear(presetsHost)
      if (!presets.length) {
        presetsHost.append(
          el('span', {
            class: 'wizard-hint',
            text: 'Nothing saved yet — set up a mix you like, then keep it here for next time.'
          })
        )
        return
      }
      for (const p of presets) {
        // A preset card SHOWS its mix — the provider marks and the pane total —
        // instead of asking the name to carry everything.
        const marks: ElChild[] = []
        const entries = p.mix.filter((m) => m.count > 0)
        for (const m of entries.slice(0, 4)) {
          marks.push(
            el('span', { class: 'wizard-preset-mark' }, [
              providerLogo(m.provider.startsWith('custom:') ? 'custom:' : m.provider, 13)
            ])
          )
        }
        if (entries.length > 4) marks.push(el('span', { class: 'wizard-preset-more', text: `+${entries.length - 4}` }))
        const total = entries.reduce((s, m) => s + m.count, 0)
        presetsHost.append(
          el('div', { class: 'wizard-preset-card' }, [
            el(
              'button',
              {
                class: 'wizard-preset-apply',
                type: 'button',
                title: `Apply “${p.name}”`,
                onClick: () => {
                  applyMix(p.mix)
                  painter.set(gridSpec)
                  renderRoster()
                  getTelemetry().captureEvent({ name: 'preset.applied' })
                }
              },
              [
                el('span', { class: 'wizard-preset-logos' }, marks),
                el('span', { class: 'wizard-preset-name', text: p.name }),
                el('span', { class: 'wizard-preset-count', text: `${total} ${plural(total)}` })
              ]
            ),
            // Every card here is the user's own now (built-ins are filtered at the
            // list), so every card is deletable.
            el(
              'button',
              {
                class: 'wizard-preset-remove',
                type: 'button',
                ariaLabel: `Delete preset ${p.name}`,
                onClick: () => {
                  void wizardClient.removePreset(p.id).then(() => {
                    presets = presets.filter((x) => x.id !== p.id)
                    renderPresets()
                  })
                }
              },
              [icon('x', 12)]
            )
          ])
        )
      }
    }

    /**
     * Ask main whether THIS folder can actually be isolated, and repaint the toggle.
     *
     * Fired from the selection subscriber, so it follows every folder change. Two rules
     * shape when it actually spends an IPC:
     *
     *   · Once per FOLDER, not once per emit. The subscriber fires several times for a
     *     single change (the synchronous one, then the resolve's), and the preflight's
     *     answer depends on the path alone.
     *   · Immediately for a discrete choice (prefill, browse, a recent, a cd) — in PARALLEL
     *     with the folder's own git probe rather than behind it, so the toggle comes alive
     *     as early as it possibly can. A path being TYPED is the exception: it waits for the
     *     350ms debounce, or every keystroke would spawn git.
     *
     * A monotonic token means a slow answer for folder A can never repaint a toggle that
     * now belongs to folder B.
     */
    function probeIsolation(origin: PathOrigin): void {
      const s = selection.state()
      const target = s.remote ? '' : s.cwd.trim()
      if (target && target === preflightCwd) return syncIsolate() // already asked about this one
      const token = ++preflightSeq
      isolatePreflight = null
      preflightCwd = null
      if (!target || (origin === 'bar' && s.probing)) return syncIsolate() // nothing to ask yet
      preflightCwd = target
      syncIsolate() // paint "checking…" before the round trip
      const settle = (pf: WorktreePreflight): void => {
        if (token !== preflightSeq) return // a newer folder owns the toggle
        isolatePreflight = pf
        syncIsolate()
      }
      void wizardClient
        .preflightWorktree(target)
        .then(settle)
        .catch(() => settle({ ok: false, reason: 'unsupported' }))
    }

    /** What each refusal MEANS, in the user's terms — and, where one exists, the button that
     *  fixes it. Every line here names the real obstacle rather than restating the feature. */
    function isolationHint(pf: WorktreePreflight | null): { text: string; fix?: 'path' } {
      if (!cwd.trim()) return { text: 'Pick a git repository above to give each agent its own branch.' }
      if (!pf) return { text: 'Checking whether this folder can be isolated…' }
      switch (pf.reason) {
        case 'ok':
          return { text: 'Each agent works on its own branch in its own folder — no trampling. Review & merge later.' }
        case 'no-git':
          // THE case this preflight was written for. Not "install git" — git is usually
          // already installed and simply arrived after this app started, so the honest fix
          // is one button, not a download.
          return { text: 'This app can’t reach Git. If you installed it recently, it just needs picking up.', fix: 'path' }
        case 'no-commits':
          return { text: 'This repository has no commits yet — make one first, then each agent can branch from it.' }
        case 'not-writable':
          return { text: 'This folder is read-only, so the isolated copies can’t be created here.' }
        case 'unsupported':
          return { text: pf.detail ? `Git refused: ${pf.detail}` : 'Git couldn’t prepare this repository for isolation.' }
        default:
          return { text: 'This folder isn’t a git repository — run `git init` there (or pick a repo) to isolate agents.' }
      }
    }

    /** Worktree isolation is only offered when it can actually WORK — and only truly OFF
     *  when the input is really disabled (never `pointer-events: none`). */
    function syncIsolate(): void {
      if (!isolateBox) return
      const usable = isolatePreflight?.ok === true
      if (!usable) isolate = false
      isolateBox.setDisabled(!usable)
      isolateBox.setChecked(isolate && usable)
      const { text, fix } = isolationHint(isolatePreflight)
      isolateHint.textContent = text
      isolateFix.hidden = fix !== 'path'
    }

    /** The one-click answer to "this app can't reach Git": re-read the live PATH, then ask
     *  the preflight again. No restart, no instructions, no dotfiles. */
    function repairToolPath(): void {
      isolateFix.disabled = true
      isolateFix.textContent = 'Looking again…'
      void wizardClient
        .repairPath()
        .catch(() => undefined)
        .finally(() => {
          isolateFix.disabled = false
          isolateFix.textContent = 'Find Git'
          // Force a re-ask for the SAME folder: the answer may have changed even though
          // the path did not — that is the entire point of the button.
          preflightCwd = null
          probeIsolation('native')
        })
    }

    /** Everything that moves when the mix or the grid changes. */
    function refreshAgents(): void {
      normalizeAssignmentsToCapacity()
      const total = assignedTotal()
      meterFill.style.width = `${paneCount ? Math.min(100, Math.round((total / paneCount) * 100)) : 0}%`
      meterLabel.textContent = `${total} / ${paneCount} · ${paneCount - total} empty`
      agentsCaption.textContent = agentsText()
      layoutReadout.textContent = layoutReadoutText()

      customStepper?.setMax(countOf('custom') + (paneCount - total))

      painter.refreshChips()
      summaryCount.textContent = String(paneCount)
      const mergedCount = gridSpec.regions.filter((region) => region.rs > 1 || region.cs > 1).length
      summaryShape.textContent = `${plural(paneCount)} on a ${gridSpec.rows}×${gridSpec.cols} grid${
        mergedCount ? ` · ${mergedCount} merged` : ''
      }`

      saveBtn.disabled = total === 0
      syncIsolate()

      launchLabel.textContent = total > 0 ? `Launch ${paneCount} ${plural(paneCount)}` : `Open ${paneCount} plain ${plural(paneCount)}`
      // "Skip" only means something once agents ARE assigned; otherwise the
      // primary already says "Open N plain terminals".
      skipBtn.hidden = total === 0
    }

    // ── Footer: a sticky action bar at the foot of the page ──────────────────
    /**
     * THE FAILURE SURFACE. A launch can fail for reasons that take a sentence to state —
     * "git worktree add failed: fatal: …" — and the only place that ever said so was the
     * path bar's status chip, a one-line pill sized for "no repo — fine". Git's actual
     * message, the one word that would have explained everything, was truncated into
     * nothing. So a real alert says it in full, keeps it on screen, and offers it as
     * copyable text; the chip keeps its short version for the field it belongs to.
     */
    function showLaunchAlert(text: string): void {
      if (!launchAlert) return
      clear(launchAlert)
      launchAlert.hidden = false
      const copy = el('button', { class: 'wizard-alert-copy', type: 'button', text: 'Copy' })
      copy.onclick = (): void => {
        void copyText(text).then((ok) => {
          copy.textContent = ok ? 'Copied' : 'Copy failed'
          setTimeout(() => (copy.textContent = 'Copy'), 1400)
        })
      }
      launchAlert.append(
        icon('alert', 14),
        el('span', { class: 'wizard-alert-text', text }),
        copy,
        el('button', {
          class: 'wizard-alert-close',
          type: 'button',
          ariaLabel: 'Dismiss',
          onClick: () => (launchAlert.hidden = true)
        }, [icon('x', 12)])
      )
      launchAlert.scrollIntoView({ block: 'nearest' })
    }

    function clearLaunchAlert(): void {
      if (launchAlert) launchAlert.hidden = true
    }

    function buildFooter(): void {
      launchAlert = el('div', { class: 'wizard-alert', hidden: true })
      launchAlert.setAttribute('role', 'alert')
      launchLabel = el('span', { text: `Launch ${paneCount} ${plural(paneCount)}` })
      launchBtn = el(
        'button',
        { class: 'btn btn--primary', type: 'button', ariaLabel: 'Launch workspace', onClick: () => void tryLaunch(false) },
        [icon('sparkles'), launchLabel]
      )
      skipBtn = Button({ label: 'Skip — no agents', variant: 'outline', onClick: () => void tryLaunch(true) })
      footer.append(
        launchAlert,
        el('span', { class: 'wizard-byo' }, [
          icon('check-circle', 12),
          el('span', { text: 'Your own CLIs, your own login — this app never touches it.' })
        ]),
        el('div', { class: 'wizard-footer-actions' }, [skipBtn, launchBtn])
      )
    }

    /** The validation that used to gate "Continue" now gates "Launch". */
    async function tryLaunch(skipAgents: boolean): Promise<void> {
      if (launching) return
      const generation = openGeneration
      const ownedSelection = selection
      clearLaunchAlert() // a new attempt clears the last one's verdict
      launching = true
      launchBtn.disabled = true
      skipBtn.disabled = true
      footer.setAttribute('aria-busy', 'true')
      try {
        await ownedSelection.settle() // Enter can beat the 350ms debounce; don't race it
        if (!currentOpen(generation) || selection !== ownedSelection) return
        const s = ownedSelection.state()
        // A folder problem belongs AT the folder field — this one keeps the old behaviour on
        // purpose: the fix is three inches above the message.
        const refuse = (text: string): void => {
          path.setStatus({ kind: 'warn', text })
          whereSection.scrollIntoView({ block: 'nearest' })
          path.focus()
        }
        if (!s.remote && !s.cwd.trim()) return refuse('pick a folder first')
        // A remote path is never probed here — it lives on the other machine — so the only
        // thing we can (and must) say is that it has to be absolute over there.
        if (s.remote && s.cwd.trim() && !ownedSelection.isUsable()) {
          return refuse('use an absolute remote path like /srv/project')
        }
        // A path the filesystem refused is not a workspace root. Launching into one
        // used to succeed and then strand every pane in a directory that isn't there.
        if (!ownedSelection.isUsable()) {
          return refuse(REFUSAL_TEXT[s.refusal?.reason ?? ''] ?? 'pick a folder first')
        }
        await launch(skipAgents, generation)
      } finally {
        if (currentOpen(generation)) {
          launching = false
          launchBtn.disabled = false
          skipBtn.disabled = false
          footer.removeAttribute('aria-busy')
        }
      }
    }

    exposeForDev()
    function exposeForDev(): void {
      if (!import.meta.env.DEV) return
      const w = window as unknown as { __mogging?: Record<string, unknown> }
      w.__mogging = w.__mogging ?? {}
      // The dev contract the template/gate/ledger/mcp/swarm/profpersist smokes drive.
      w.__mogging.templates = {
        open: async (
          m: ProviderCount[],
          roles?: (string | null)[],
          remotes?: ({ hostId: string; name: string; cwd?: string } | null)[],
          profileIds?: (string | null)[]
        ) => {
          const r = await wizardClient.resolve(m)
          const focused = getFocusedPane()?.cwd ?? ''
          openWorkspaceFromTemplate({
            name: 'Smoke',
            cwd: focused,
            paneCount: r.paneCount,
            assignments: r.assignments,
            roles,
            remotes,
            profileIds // per-slot profile choice (6/04) — the profpersist smoke drives this
          })
          return r
        },
        // Worktree-isolation path (3/03): one worktree per non-shell slot at `repo`.
        // Parallel like the real launch path — the smoke drives the same concurrency.
        openIsolated: async (repo: string, m: ProviderCount[]) => {
          const r = await wizardClient.resolve(m)
          const paneCwds: (string | null)[] = await Promise.all(
            r.assignments.map((a) =>
              a && a !== 'shell'
                ? wizardClient.createWorktree(repo).then(
                    (wt) => (wt.ok && wt.path ? wt.path : null),
                    () => null
                  )
                : Promise.resolve<string | null>(null)
            )
          )
          openWorkspaceFromTemplate({ name: 'Isolated', cwd: repo, paneCount: r.paneCount, assignments: r.assignments, paneCwds })
          return { ...r, paneCwds }
        },
        // Remote audit path: drive the same resolved-spec service as Launch,
        // including the per-pane TARGET cwd that a low-level workspace.create
        // helper deliberately does not interpret or launch.
        openRemote: (spec: {
          name: string
          cwd: string
          assignments: string[]
          paneCwds: (string | null)[]
          remotes: ({ hostId: string; name: string } | null)[]
        }) => openWorkspaceFromTemplate({ ...spec, paneCount: spec.assignments.length }),
        openWizard: (prefill?: WizardPrefill) => open(prefill)
      }
      // The single-source-of-truth invariant, made checkable: with no refusal in
      // play, the bar, the browser's selection, and the controller are one value.
      // FOLDERPICK asserts this after every interaction.
      w.__mogging.wizardPath = () => {
        const s = selection?.state()
        return {
          cwd: s?.cwd ?? null,
          bar: path?.value() ?? null,
          browserSelected: browser?.selected() ?? null,
          browserPath: browser?.path() ?? null,
          refusal: s?.refusal?.reason ?? null,
          probing: s?.probing ?? false,
          remote: s?.remote ?? false,
          agree: !!s && !s.refusal && !s.remote ? s.cwd === path.value() && s.cwd === browser.selected() : true
        }
      }
      // The cd line, drivable end-to-end (WIZCD): the gate types into the REAL input
      // and reads the REAL menu — plus the pure math, callable with a fixture table.
      w.__mogging.wizardCd = {
        value: () => cdLine?.input.value ?? '',
        type: (v: string) => {
          if (!cdLine) return
          cdLine.input.focus()
          cdLine.input.value = v
          cdLine.input.dispatchEvent(new Event('input', { bubbles: true }))
        },
        key: (k: string, init?: KeyboardEventInit) =>
          cdLine?.input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })),
        suggestions: () => cdLine?.suggestions() ?? [],
        selectedIndex: () => cdLine?.selectedIndex() ?? -1,
        hint: () => cdLine?.hint() ?? '',
        settle: () => cdLine?.settle() ?? Promise.resolve(),
        pure: { parseCdLine, resolveCdTarget, resolvePathAgainst, completionContext, filterCompletions, commonPrefix, applyCompletion }
      }
      // The painter, drivable: gates set sizes and merges deterministically here,
      // and separately prove the pointer gestures against the real canvas.
      // The placement model, drivable end-to-end: gates arm a real brush, paint real
      // slots, and read the same array the launch snapshot will serialize.
      w.__mogging.wizardAgents = {
        slots: () => [...slots],
        assignments: () => expandAssignments(),
        brush: () => brush,
        arm: (id: string | null) => {
          brush = id
          renderAgentControls()
        },
        paint: (slot: number, id: string | null) => {
          if (slot >= 0 && slot < slots.length) slots[slot] = id
          renderAgentControls()
        },
        fillAll: (id: string) => fillAllWith(id),
        clear: () => clearAssignments()
      }
      w.__mogging.wizardLayout = {
        capacity: () => ({ ...capacity }),
        spec: () => ({ rows: gridSpec.rows, cols: gridSpec.cols, regions: gridSpec.regions.map((r) => ({ ...r })) }),
        setGrid: (rows: number, cols: number) => {
          setGridSpec(uniformSpec(Math.max(1, Math.floor(rows)), Math.max(1, Math.floor(cols))))
          painter.set(gridSpec)
          refreshAgents()
          return paneCount
        },
        merge: (r0: number, c0: number, r1: number, c1: number) => painter.mergeRect(r0, c0, r1, c1),
        readout: () => layoutReadout?.textContent ?? ''
      }
    }
  }
}
