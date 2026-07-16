import type { ShellContext, UiFeature } from '../../core/registry/feature-registry'
import { IntegrationsChannels, ProfileChannels, RemoteChannels } from '@contracts'
import type { AgentInfo, AgentProfile, McpServerEntry, ProviderCount, ProviderMixTemplate, RecentWorkspace, RemoteHost } from '@contracts'
import type { PathStatus } from '../../components/input'
import { copyText } from '../../core/clipboard/clipboard-port'
import {
  Button,
  Pill,
  clear,
  createCheckbox,
  createFolderBrowser,
  createGridPainter,
  createPathInput,
  createStepper,
  el,
  icon,
  providerAccent,
  providerLogo,
  type ElChild,
  type FolderBrowserHandle,
  type GridPainterHandle,
  type PathInputHandle,
  type StepperHandle
} from '../../components'
import { TEMPLATES, serializeTree, specForCount, treeForRegions, uniformSpec, type GridSpecModel } from '../layout'
import { getFocusedPane } from '../../core/layout/focus'
import { openPlannedWorkspaceFromTemplate, openWorkspaceFromTemplate } from '../../core/workspace/open-service'
import { setWizardOpener, type WizardPrefill } from '../../core/workspace/wizard-port'
import { activeView, goBack, setActiveView } from '../../core/shell/view-port'
import { getTelemetry } from '../../core/telemetry'
import { getBridge } from '../../core/ipc/bridge'
import { wizardClient } from './wizard.client'
import { createPathSelection, type PathSelectionHandle, type PathState } from './path-selection'
import { getAgentRegistry, onAgentRegistryChange, refreshAgentRegistry } from '../../core/agents/registry'

// Provider identity (accent + official mark) lives in components/provider-logo —
// one source for the wizard, settings, usage, and pane chrome.

const basename = (p: string): string =>
  p.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? ''

const plural = (n: number): string => (n === 1 ? 'terminal' : 'terminals')

/** Settings preference for the suggested grid size (falls back to 4). */
function defaultPaneCount(): number {
  try {
    const n = Number(localStorage.getItem('mogging.defaultPaneCount'))
    if (Number.isInteger(n) && n >= 1 && n <= 16) return n
  } catch {
    /* storage unavailable */
  }
  return 4
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
    // ── Wizard state (persists while the page is open) ───────────────────────
    let name = ''
    let cwd = ''
    let gridSpec: GridSpecModel = specForPanes(defaultPaneCount())
    let paneCount = gridSpec.regions.length
    let counts = new Map<string, number>() // provider id -> count
    let customCmd = ''
    let customCount = 0
    let isRepo = false // set by the folder field's git probe
    let isolate = false // Phase-3/03: one git worktree per agent pane
    let swarmRoles: (string | null)[] | null = null // Phase-4/01: per-slot manifest (preset)
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
    // workspace to. Empty selection = house only (minimal by default). The row
    // shows only when there ARE connected servers, so no silent scoping.
    let pickableServers: { id: string; label: string }[] = []
    const selectedTools = new Set<string>()

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
      // A CLI removed while this page is open cannot remain invisibly assigned.
      for (const [id] of counts) {
        if (roster.some((agent) => agent.id === id && agent.installed)) continue
        counts.delete(id)
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
      setGridSpec(specForPanes(prefill?.paneCount ?? defaultPaneCount()))
      counts = new Map()
      customCmd = ''
      customCount = 0
      isolate = false
      swarmRoles = null
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
      setActiveView('wizard')
      requestAnimationFrame(() => path.focus()) // focus only once the view is painted
      getTelemetry().captureEvent({ name: 'wizard.opened', props: { prefilled: !!prefill } })

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
          presets = p ?? []
          renderPresets()
        })
        .catch(() => {
          if (currentOpen(generation)) presets = []
        })
      void (getBridge().invoke(IntegrationsChannels.serversList) as Promise<McpServerEntry[]>)
        .then((servers) => {
          if (!currentOpen(generation)) return
          pickableServers = (servers ?? []).filter((s) => !s.builtIn).map((s) => ({ id: s.id, label: s.label }))
          renderTools()
        })
        .catch(() => {
          if (currentOpen(generation)) pickableServers = []
        })
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

    /** Seed counts/custom from a preset mix; grow the grid to fit the mix. */
    function applyMix(mix: ProviderCount[]): void {
      counts = new Map()
      customCmd = ''
      customCount = 0
      let total = 0
      for (const m of mix) {
        if (m.count <= 0) continue
        if (m.provider === 'shell') {
          total += m.count
        } else if (m.provider.startsWith('custom:')) {
          customCmd = m.provider.slice('custom:'.length)
          customCount = m.count
          total += m.count
        } else {
          // A preset outlives its CLIs. A mix naming a provider that is no longer
          // installed must not become an assignment: its roster row has no stepper
          // ("not found on PATH"), so the count would be invisible and unfixable —
          // and Launch would type a command the shell cannot find. applyRoster
          // enforces exactly this invariant when the registry CHANGES; the preset/
          // prefill path lands here. An EMPTY roster means detection has not
          // answered yet — keep the mix; the open() refresh prunes with real data.
          if (roster.length && !roster.some((a) => a.id === m.provider && a.installed)) continue
          counts.set(m.provider, m.count)
          total += m.count
        }
      }
      if (total > paneCount) setGridSpec(specForPanes(Math.min(16, total)))
      normalizeAssignmentsToCapacity()
    }

    /** Keep the persisted model, steppers, preview, and eventual manifest within
     * the selected grid. Earlier assignments win deterministically on shrink. */
    function normalizeAssignmentsToCapacity(): void {
      let remaining = paneCount
      const next = new Map<string, number>()
      for (const [id, raw] of counts) {
        const count = Math.min(remaining, Math.max(0, Math.floor(Number(raw) || 0)))
        if (count) next.set(id, count)
        remaining -= count
      }
      counts = next
      customCount = customCmd.trim()
        ? Math.min(remaining, Math.max(0, Math.floor(Number(customCount) || 0)))
        : 0
      if (swarmRoles) swarmRoles = swarmRoles.slice(0, paneCount)
    }

    const assignedTotal = (): number =>
      Array.from(counts.values()).reduce((s, n) => s + n, 0) + (customCmd.trim() ? customCount : 0)

    /** Slot-order assignment expansion (mirrors the backend's resolveLayout). */
    function expandAssignments(): string[] {
      const out: string[] = []
      for (const a of roster) {
        const n = counts.get(a.id) ?? 0
        for (let i = 0; i < n; i++) out.push(a.id)
      }
      const cmd = customCmd.trim()
      for (let i = 0; i < customCount && cmd; i++) out.push(`custom:${cmd}`)
      while (out.length < paneCount) out.push('shell')
      return out.slice(0, paneCount)
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
        customCount,
        counts: new Map(counts),
        remoteHost: remoteHost ? { ...remoteHost } : null,
        swarmRoles: swarmRoles ? [...swarmRoles] : null,
        profileByProvider: new Map(profileByProvider),
        scopeTools: pickableServers.length > 0,
        selectedTools: [...selectedTools]
      }
      const refuse = (message: string): false => {
        path.setStatus({ kind: 'warn', text: message })
        whereSection.scrollIntoView({ block: 'nearest' })
        path.focus()
        return false
      }
      if (!currentOpen(generation)) return false
      if (!skipAgents && snap.customCount > 0 && !snap.customCmd) {
        return refuse('Enter a custom command or set its count to zero.')
      }

      const mix: ProviderCount[] = []
      if (!skipAgents) {
        for (const a of roster) {
          const n = snap.counts.get(a.id) ?? 0
          if (n > 0) mix.push({ provider: a.id, count: n })
        }
        if (snap.customCount > 0 && snap.customCmd) mix.push({ provider: `custom:${snap.customCmd}`, count: snap.customCount })
      }
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
      // arrangement there, never "a 4-grid minus one").
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
        paneCwds = []
        for (const assignment of resolved.assignments) {
          if (assignment && assignment !== 'shell') {
            if (!currentOpen(generation)) {
              await rollbackWorktrees()
              return false
            }
            try {
              const wt = await wizardClient.createWorktree(snap.cwd)
              if (!wt.ok || !wt.path) {
                const cleaned = await rollbackWorktrees()
                return refuse(
                  `Could not isolate every agent${wt.error ? `: ${wt.error}` : '.'} No workspace was opened.` +
                    (cleaned ? '' : ' A temporary worktree also needs manual cleanup.')
                )
              }
              createdWorktrees.push(wt.path)
              paneCwds.push(wt.path)
            } catch (error) {
              const cleaned = await rollbackWorktrees()
              return refuse(
                `Could not isolate every agent: ${error instanceof Error ? error.message : String(error)}. No workspace was opened.` +
                  (cleaned ? '' : ' A temporary worktree also needs manual cleanup.')
              )
            }
          } else {
            paneCwds.push(null)
          }
        }
      }

      const manifest = snap.swarmRoles
      const roles =
        !skipAgents && manifest ? resolved.assignments.map((_, i) => manifest[i] ?? null) : undefined
      // The remote path's cwd rides on the REMOTE entry, never in paneCwds: a paneCwd is a
      // local path, and the far-side folder must never be handed to a local filesystem API.
      const selectedRemote = snap.remoteHost ? { ...snap.remoteHost, cwd: snap.cwd.trim() ? snap.cwd : undefined } : null
      try {
        const opened = await openPlannedWorkspaceFromTemplate({
          name: snap.name.trim() || basename(snap.cwd) || 'Workspace',
          cwd: snap.remoteHost ? '' : snap.cwd,
          paneCount: resolved.paneCount,
          assignments: resolved.assignments,
          paneCwds: snap.remoteHost ? undefined : paneCwds,
          roles,
          remotes: selectedRemote
            ? Array<{ hostId: string; name: string; cwd?: string } | null>(resolved.paneCount).fill(selectedRemote)
            : undefined,
          profileIds: resolved.assignments.map((a) => (a && snap.profileByProvider.has(a) ? snap.profileByProvider.get(a)! : null)),
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
          agents: resolved.assignments.filter((a) => a && a !== 'shell').length,
          custom: snap.customCount > 0,
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
    let chosenLine!: HTMLParagraphElement
    let whereSection!: HTMLElement
    let nameInputEl!: HTMLInputElement
    let recentsHost!: HTMLElement
    let recentsSection!: HTMLElement
    let layoutReadout!: HTMLElement
    let painter!: GridPainterHandle
    let agentsCaption!: HTMLElement
    let rosterHost!: HTMLElement
    let presetsHost!: HTMLElement
    let toolsSection!: HTMLElement
    let toolsHost!: HTMLElement
    let meterFill!: HTMLElement
    let meterLabel!: HTMLElement
    let launchLabel!: HTMLElement
    let launchBtn!: HTMLButtonElement
    let skipBtn!: HTMLButtonElement
    let saveBtn!: HTMLButtonElement
    let swarmHint!: HTMLElement
    let isolateBox!: ReturnType<typeof createCheckbox>
    let isolateHint!: HTMLElement
    let customInput!: HTMLInputElement
    const steppers = new Map<string, StepperHandle>()
    let customStepper: StepperHandle | null = null

    /** Push a programmatic mix (prefill, preset, Clear) back into the custom row. */
    function syncCustom(): void {
      if (!customInput || !customStepper) return
      if (customInput.value !== customCmd) customInput.value = customCmd
      customStepper.setValue(customCount)
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
      clear(body)
      clear(footer)
      steppers.clear()
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
        onInput: (v) => ownedSelection.set(v, 'bar'), // the controller owns the debounce
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
        // `reveal` only moves what the browser LOOKS at. Nothing else may react to it.
        if (origin === 'reveal') {
          if (listing && !s.remote) browser.applyListing(listing, s.cwd)
          return
        }
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

        // Seed the workspace name only from a deliberate PICK. Seeding it from
        // `prefill` would name a fresh workspace after the user's home directory.
        if ((origin === 'browser' || origin === 'native') && nameInputEl && !nameInputEl.value) {
          const base = basename(s.cwd)
          if (base) {
            nameInputEl.value = base
            name = base
          }
        }
        updateChosen()
        syncIsolate()
      })

      // Somewhere to start looking. `reveal`, not `set`: opening the browser at $HOME
      // must not make $HOME the workspace root.
      if (cwd) ownedSelection.set(cwd, 'prefill')
      else {
        void wizardClient.homeDir()
          .then((h) => {
            if (currentOpen(generation) && selection === ownedSelection) ownedSelection.reveal(h)
          })
          .catch(() => undefined)
      }

      const nameInput = el('input', {
        class: 'input wizard-name-input',
        type: 'text',
        value: name,
        placeholder: cwd ? basename(cwd) : 'Workspace name',
        ariaLabel: 'Workspace name — optional, defaults to the folder name',
        onInput: (e) => {
          name = (e.target as HTMLInputElement).value
        },
        onKeydown: (e) => {
          if (e.key === 'Enter') void tryLaunch(false)
        }
      })
      nameInputEl = nameInput

      whereSection = section(
        'Working folder',
        'Your terminals start here — type a path or click through.',
        null,
        [el('div', { class: 'wizard-where-row' }, [path.el, nameInput]), chosenLine, browser.el],
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
              // and the isolate toggle all follow from the selection changing.
              onClick: () => {
                if (!name) {
                  name = r.name
                  nameInputEl.value = r.name
                }
                selection.set(r.cwd, 'recent')
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

    // ── Layout: the dynamic painter ──────────────────────────────────────────
    function buildLayout(): HTMLElement {
      layoutReadout = el('span', { class: 'wizard-layout-readout', text: layoutReadoutText() })
      painter = createGridPainter({
        value: gridSpec,
        onChange: (spec) => {
          setGridSpec(spec)
          if (swarmRoles) swarmRoles = swarmRoles.slice(0, paneCount)
          refreshAgents()
        },
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
      return section(
        'Layout',
        'Pick a size on the dots. Drag across terminals to merge; click a merged one to split.',
        layoutReadout,
        [painter.el]
      )
    }

    function layoutReadoutText(): string {
      const merged = gridSpec.regions.some((region) => region.rs > 1 || region.cs > 1)
      return `${paneCount} ${plural(paneCount)} · ${gridSpec.rows}×${gridSpec.cols}${merged ? ' · merged' : ''}`
    }

    // ── Agents ───────────────────────────────────────────────────────────────
    function buildAgents(): HTMLElement {
      agentsCaption = el('span', { class: 'wizard-sec-hint', text: agentsText() })
      meterFill = el('span', { class: 'wizard-meter-fill' })
      meterLabel = el('span', { class: 'wizard-fill-label' })
      const meter = el('span', { class: 'wizard-meter' }, [
        el('span', { class: 'wizard-meter-track' }, [meterFill]),
        meterLabel
      ])
      rosterHost = el('div', { class: 'wizard-agents' })

      const fills = el('div', { class: 'wizard-fills' }, [
        Button({ label: 'Fill all', size: 'sm', title: 'Fill every pane, cycling through installed agents', onClick: () => quickFill('all') }),
        Button({ label: 'One of each', size: 'sm', onClick: () => quickFill('each') }),
        Button({ label: 'Split evenly', size: 'sm', onClick: () => quickFill('split') }),
        Button({ label: 'Clear', size: 'sm', variant: 'danger', onClick: () => quickFill('clear') })
      ])

      // Custom command — any CLI, verbatim. Label only; never a stored credential.
      customStepper = createStepper({
        value: customCount,
        min: 0,
        max: customCount + (paneCount - assignedTotal()),
        ariaLabel: 'Custom command count',
        onChange: (n) => {
          customCount = n
          swarmRoles = null
          refreshAgents()
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
          if (!customCmd.trim()) {
            customCount = 0
            customStepper?.setValue(0)
          }
          customStepper?.setDisabled(!customCmd.trim())
          refreshAgents()
        }
      })
      customStepper.setDisabled(!customCmd.trim())
      const customRow = el('div', { class: 'wizard-agent-row wizard-custom-row' }, [
        el('span', { class: 'wizard-agent-head' }, [providerLogo('custom:', 16), customInput]),
        el('span', { class: 'wizard-agent-tail' }, [customStepper.el])
      ])

      const sec = section('Agents', '', el('span', { class: 'wizard-agents-tools' }, [meter]), [
        el('div', { class: 'wizard-fill' }, [fills]),
        rosterHost,
        customRow
      ])
      const head = sec.querySelector('.wizard-sec-head')
      head?.insertBefore(agentsCaption, head.children[1] ?? null)
      return sec
    }

    function agentsText(): string {
      return `Which agents launch in your ${paneCount} ${plural(paneCount)} — or keep plain shells.`
    }

    function quickFill(kind: 'all' | 'each' | 'split' | 'clear'): void {
      const installed = roster.filter((a) => a.installed)
      counts = new Map()
      customCount = 0
      swarmRoles = null
      if (kind !== 'clear' && installed.length) {
        if (kind === 'all') {
          for (let i = 0; i < paneCount; i++) {
            const a = installed[i % installed.length]
            counts.set(a.id, (counts.get(a.id) ?? 0) + 1)
          }
        } else if (kind === 'each') {
          installed.slice(0, paneCount).forEach((a) => counts.set(a.id, 1))
        } else {
          const each = Math.floor(paneCount / installed.length)
          let rem = paneCount - each * installed.length
          for (const a of installed) counts.set(a.id, each + (rem-- > 0 ? 1 : 0))
        }
      }
      renderRoster()
    }

    /** The roster + custom row. Rebuilt when the roster or the mix changes. */
    function renderRoster(): void {
      if (!rosterHost) return
      normalizeAssignmentsToCapacity()
      clear(rosterHost)
      steppers.clear()

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
                ? 'No agent CLIs on your PATH yet. Copy an install command below, run it in a terminal, then re-check.'
                : 'Looking for agent CLIs (Claude Code, Codex, Gemini, Aider, OpenCode) on your PATH…'
            }),
            recheck
          ])
        )
      }

      for (const a of roster) {
        const s = createStepper({
          value: counts.get(a.id) ?? 0,
          min: 0,
          max: (counts.get(a.id) ?? 0) + (paneCount - assignedTotal()),
          ariaLabel: `${a.name} count`,
          onChange: (n) => {
            counts.set(a.id, n)
            swarmRoles = null // a manual mix is no longer the swarm preset
            refreshAgents()
          }
        })
        steppers.set(a.id, s)

        // Profile picker (4/04): shown only when this provider has >1 profile.
        const mine = profilesCache.filter((p) => p.provider === a.id).sort((x, y) => x.order - y.order)
        let profSel: HTMLSelectElement | null = null
        if (a.installed && mine.length > 1) {
          profSel = el('select', { class: 'input wizard-profile-select', ariaLabel: `${a.name} profile` }) as HTMLSelectElement
          for (const p of mine) profSel.append(new Option(p.name, p.id))
          profSel.value = profileByProvider.get(a.id) ?? mine[0].id
          profSel.addEventListener('change', () => profileByProvider.set(a.id, profSel!.value))
        }

        // Missing CLI: show the provider's OWN install one-liner with a copy
        // button (we never install — 6/06). Installed: the count stepper.
        const installHint =
          !a.installed && a.installHint
            ? (() => {
                const copy = el('button', { class: 'wizard-agent-copy', type: 'button', text: 'Copy' })
                copy.title = a.installHint
                copy.onclick = (): void => {
                  // copyText never rejects and answers truthfully — main verifies the write
                  // took (a clipboard held open by another process is a silent no-op), so
                  // the label only ever claims what actually happened.
                  void copyText(a.installHint!).then((ok) => {
                    copy.textContent = ok ? 'Copied' : 'Copy failed'
                    setTimeout(() => (copy.textContent = 'Copy'), 1400)
                  })
                }
                return el('span', { class: 'wizard-agent-install' }, [
                  el('code', { class: 'wizard-agent-cmd', text: a.installHint }),
                  copy
                ])
              })()
            : null

        // head | tail, tail right-aligned by `margin-left: auto` — no zero-width
        // spacer element and no phantom flex gaps.
        rosterHost.append(
          el('div', { class: 'wizard-agent-row' + (a.installed ? '' : ' is-missing') }, [
            el('span', { class: 'wizard-agent-head' }, [
              providerLogo(a.id, 18),
              el('span', { class: 'wizard-agent-name', text: a.name }),
              a.installed ? null : Pill({ text: 'not found on PATH', tone: 'warning' })
            ]),
            el('span', { class: 'wizard-agent-tail' }, [installHint, profSel, a.installed ? s.el : null])
          ])
        )
      }

      // The custom-command row is always visible now — a mix that carries one is
      // pushed back into its controls here.
      syncCustom()
      refreshAgents()
    }

    // ── Agent tools (8/09) — visible whenever there ARE connected servers ────
    function buildTools(): HTMLElement {
      toolsHost = el('div', { class: 'wizard-tools' })
      toolsSection = section(
        'Agent tools',
        'House server always on. Unpicked tools stay out of this workspace’s agents (edit later in Settings › Workspace tools).',
        null,
        [toolsHost]
      )
      return toolsSection
    }

    function renderTools(): void {
      if (!toolsHost) return
      clear(toolsHost)
      toolsSection.hidden = pickableServers.length === 0
      if (!pickableServers.length) return
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
    }

    // ── Options: isolation + where it runs — visible, never behind a fold ────
    function buildOptions(): HTMLElement {
      const generation = openGeneration
      const ownedSelection = selection

      isolateBox = createCheckbox({
        checked: isolate && isRepo,
        disabled: !isRepo,
        label: 'Isolate each agent in its own git worktree',
        onChange: (checked) => {
          isolate = checked
        }
      })
      isolateHint = el('span', { class: 'wizard-hint' })

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
        el('div', { class: 'wizard-option-row' }, [isolateBox.el, isolateHint]),
        el('div', { class: 'wizard-option-row' }, [
          el('span', { class: 'wizard-option-label', text: 'Runs on' }),
          remoteSelect,
          el('span', { class: 'wizard-hint', text: 'This machine, or a saved SSH host.' })
        ])
      ])
    }

    // ── Presets ──────────────────────────────────────────────────────────────
    function buildPresets(): HTMLElement {
      presetsHost = el('div', { class: 'wizard-presets' })
      swarmHint = el('span', { class: 'wizard-hint' })
      saveBtn = Button({
        label: 'Save as preset',
        size: 'sm',
        variant: 'ghost',
        icon: 'bookmark',
        disabled: assignedTotal() === 0,
        onClick: savePreset
      })
      const swarmBtn = el(
        'button',
        {
          class: 'wizard-preset-apply wizard-preset-swarm',
          type: 'button',
          title: 'architect · 2 workers · reviewer, on your first installed CLI',
          onClick: () => {
            const provider = roster.find((a) => a.installed) ?? roster[0]
            if (!provider) return
            setGridSpec(uniformSpec(2, 2))
            painter.set(gridSpec)
            counts = new Map([[provider.id, 4]])
            customCount = 0
            swarmRoles = ['architect', 'worker', 'worker', 'reviewer']
            renderRoster()
          }
        },
        [icon('sparkles', 12), el('span', { text: 'Swarm — architect · 2 workers · reviewer' })]
      )
      return section('Presets', 'A saved mix, one click from launching.', saveBtn, [
        el('div', { class: 'wizard-presets-row' }, [presetsHost, swarmBtn]),
        swarmHint
      ])
    }

    function savePreset(): void {
      const presetName = `${expandAssignments().filter((a) => a !== 'shell').length} agents · ${paneCount} panes`
      const mix: ProviderCount[] = []
      for (const a of roster) {
        const n = counts.get(a.id) ?? 0
        if (n > 0) mix.push({ provider: a.id, count: n })
      }
      if (customCount > 0 && customCmd.trim()) mix.push({ provider: `custom:${customCmd.trim()}`, count: customCount })
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
      for (const p of presets) {
        presetsHost.append(
          el('span', { class: 'wizard-preset' }, [
            el('button', {
              class: 'wizard-preset-apply',
              type: 'button',
              text: p.name,
              onClick: () => {
                applyMix(p.mix)
                painter.set(gridSpec)
                renderRoster()
                getTelemetry().captureEvent({ name: 'preset.applied' })
              }
            }),
            p.id.startsWith('preset-')
              ? null
              : el(
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

    /** Worktree isolation is only meaningful on a git repo — and only truly OFF
     *  when the input is really disabled (never `pointer-events: none`). */
    function syncIsolate(): void {
      if (!isolateBox) return
      if (!isRepo) isolate = false
      isolateBox.setDisabled(!isRepo)
      isolateBox.setChecked(isolate && isRepo)
      isolateHint.textContent = isRepo
        ? 'Each agent works on its own branch in its own folder — no trampling. Review & merge later.'
        : cwd.trim()
          ? 'This folder isn’t a usable git repository — run `git init` there (or pick a repo) to enable worktree isolation.'
          : 'Pick a git repository above to enable worktree isolation.'
    }

    /** Everything that moves when the mix or the grid changes. */
    function refreshAgents(): void {
      normalizeAssignmentsToCapacity()
      const total = assignedTotal()
      meterFill.style.width = `${paneCount ? Math.min(100, Math.round((total / paneCount) * 100)) : 0}%`
      meterLabel.textContent = `${total} / ${paneCount} · ${paneCount - total} empty`
      agentsCaption.textContent = agentsText()
      layoutReadout.textContent = layoutReadoutText()

      const remaining = paneCount - total
      for (const [id, s] of steppers) s.setMax((counts.get(id) ?? 0) + remaining)
      customStepper?.setMax(customCount + remaining)

      painter.refreshChips()

      swarmHint.textContent = swarmRoles ? 'Swarm manifest armed — roles land on the panes.' : ''
      saveBtn.disabled = total === 0
      syncIsolate()

      launchLabel.textContent = total > 0 ? `Launch ${paneCount} ${plural(paneCount)}` : `Open ${paneCount} plain ${plural(paneCount)}`
      // "Skip" only means something once agents ARE assigned; otherwise the
      // primary already says "Open N plain terminals".
      skipBtn.hidden = total === 0
    }

    // ── Footer: a sticky action bar at the foot of the page ──────────────────
    function buildFooter(): void {
      launchLabel = el('span', { text: `Launch ${paneCount} ${plural(paneCount)}` })
      launchBtn = el(
        'button',
        { class: 'btn btn--primary', type: 'button', ariaLabel: 'Launch workspace', onClick: () => void tryLaunch(false) },
        [icon('sparkles'), launchLabel]
      )
      skipBtn = Button({ label: 'Skip — no agents', variant: 'outline', onClick: () => void tryLaunch(true) })
      footer.append(
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
      launching = true
      launchBtn.disabled = true
      skipBtn.disabled = true
      footer.setAttribute('aria-busy', 'true')
      try {
        await ownedSelection.settle() // Enter can beat the 350ms debounce; don't race it
        if (!currentOpen(generation) || selection !== ownedSelection) return
        const s = ownedSelection.state()
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
        openIsolated: async (repo: string, m: ProviderCount[]) => {
          const r = await wizardClient.resolve(m)
          const paneCwds: (string | null)[] = []
          for (const a of r.assignments) {
            if (a && a !== 'shell') {
              const wt = await wizardClient.createWorktree(repo)
              paneCwds.push(wt.ok && wt.path ? wt.path : null)
            } else {
              paneCwds.push(null)
            }
          }
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
      // The painter, drivable: gates set sizes and merges deterministically here,
      // and separately prove the pointer gestures against the real canvas.
      w.__mogging.wizardLayout = {
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
