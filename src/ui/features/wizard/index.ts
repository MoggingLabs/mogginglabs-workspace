import type { ShellContext, UiFeature } from '../../core/registry/feature-registry'
import { ClipboardChannels, IntegrationsChannels, ProfileChannels, RemoteChannels } from '@contracts'
import type { AgentInfo, AgentProfile, McpServerEntry, ProviderCount, ProviderMixTemplate, RecentWorkspace, RemoteHost } from '@contracts'
import {
  Button,
  Card,
  FieldGroup,
  MiniGridPreview,
  Pill,
  SectionHeader,
  clear,
  createCheckbox,
  createLayoutGridPicker,
  createMeter,
  createPathInput,
  createStepper,
  el,
  icon,
  type ElChild,
  type PathInputHandle,
  type StepperHandle
} from '../../components'
import { TEMPLATES, TEMPLATE_COUNTS } from '../layout'
import { getFocusedPane } from '../../core/layout/focus'
import { openWorkspaceFromTemplate } from '../../core/workspace/open-service'
import { setWizardOpener, type WizardPrefill } from '../../core/workspace/wizard-port'
import { activeView, goBack, setActiveView } from '../../core/shell/view-port'
import { getTelemetry } from '../../core/telemetry'
import { getBridge } from '../../core/ipc/bridge'
import { wizardClient } from './wizard.client'

/** Per-provider accent for assignment previews (initial letter chips). Claude sits
 *  on a coral deliberately OFF the brand orange — the brand hue means attention. */
const PROVIDER_COLORS: Record<string, string> = {
  claude: '#e0755f',
  codex: '#4da3ff',
  gemini: '#a78bfa',
  aider: '#3fc873',
  opencode: '#2dd4bf'
}
const CUSTOM_COLOR = '#e879f9'

const basename = (p: string): string =>
  p.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? ''

const plural = (n: number): string => (n === 1 ? 'terminal' : 'terminals')

/** Settings preference for the suggested grid size (falls back to 4). */
function defaultPaneCount(): number {
  try {
    const n = Number(localStorage.getItem('mogging.defaultPaneCount'))
    if (TEMPLATE_COUNTS.includes(n)) return n
  } catch {
    /* storage unavailable */
  }
  return 4
}

/**
 * The new-workspace wizard: ONE full-app PAGE (8.5/02) — not a modal. It owns the
 * content region beside the workspace rail (`#view-wizard`, the same routing as
 * Home/Board/Settings), a centred column with real side gutters, so configuring
 * the next workspace happens with the ones you already have still in view.
 *
 * Where (folder + name) · Layout (grid) · Agents (roster + quick-fill + assignment
 * preview) are three Cards in one scrollable body — the whole decision at once.
 * Rarely-used controls (remote host, swarm preset, tool plan, worktree isolation,
 * presets) live behind a quiet per-card "Advanced" disclosure, which auto-opens
 * when anything inside it is already set.
 *
 * Why one page and not a stepper: NN/g says wizards suit novices and infrequent
 * setup, and to avoid them for repetitive tasks, expert users ("resent the
 * controlled flow"), and arbitrary-order completion. A desktop workspace launcher
 * is all three. (prompts/phase-8.5/AUDIT.md § Patterns carries the citation.)
 *
 * BYO-auth (ADR 0002): agents are launched as YOUR CLIs under YOUR login — the
 * wizard never asks for or stores a credential.
 */
export const wizardFeature: UiFeature = {
  name: 'wizard',
  mount(ctx: ShellContext) {
    // ── Wizard state (persists while the modal is open) ──────────────────────
    let name = ''
    let cwd = ''
    let paneCount = 4
    let counts = new Map<string, number>() // provider id -> count
    let customCmd = ''
    let customCount = 0
    let isRepo = false // set by the folder field's git probe
    let isolate = false // Phase-3/03: one git worktree per agent pane
    let swarmRoles: (string | null)[] | null = null // Phase-4/01: per-slot manifest (preset)
    let remoteHost: { hostId: string; name: string } | null = null // Phase-4/05
    let profilesCache: AgentProfile[] = [] // Phase-4/04 picker (refreshed on open)
    const profileByProvider = new Map<string, string>()

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
            el('p', { class: 'wizard-subtitle', text: 'Folder, grid, and agents — all on one page.' })
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

    function leave(): void {
      goBack()
    }

    function open(prefill?: WizardPrefill): void {
      void (getBridge().invoke(ProfileChannels.list) as Promise<AgentProfile[]>).then((list) => {
        profilesCache = list ?? []
      })
      name = prefill?.name ?? ''
      cwd = prefill?.cwd ?? ''
      paneCount = prefill?.paneCount ?? defaultPaneCount()
      counts = new Map()
      customCmd = ''
      customCount = 0
      isolate = false
      swarmRoles = null
      remoteHost = null
      roster = []
      presets = []
      recents = []
      pickableServers = []
      selectedTools.clear()
      if (prefill?.mix) applyMix(prefill.mix)

      render()
      setActiveView('wizard')
      requestAnimationFrame(() => path.focus()) // focus only once the view is painted
      getTelemetry().captureEvent({ name: 'wizard.opened', props: { prefilled: !!prefill } })

      // Fresh data every open. Each arrival patches only its own subtree — a full
      // re-render would blow away the folder field's focus and caret mid-type.
      void wizardClient
        .detectAgents()
        .then((a) => {
          roster = a ?? []
          renderRoster()
        })
        .catch(() => (roster = []))
      void wizardClient
        .listPresets()
        .then((p) => {
          presets = p ?? []
          renderPresets()
        })
        .catch(() => (presets = []))
      void (getBridge().invoke(IntegrationsChannels.serversList) as Promise<McpServerEntry[]>)
        .then((servers) => {
          pickableServers = (servers ?? []).filter((s) => !s.builtIn).map((s) => ({ id: s.id, label: s.label }))
          renderTools()
        })
        .catch(() => (pickableServers = []))
      void wizardClient
        .loadState()
        .then((s) => {
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
        .catch(() => (recents = []))
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
          counts.set(m.provider, m.count)
          total += m.count
        }
      }
      const fit = TEMPLATE_COUNTS.find((n) => n >= total)
      if (fit && fit > paneCount) paneCount = fit
    }

    const assignedTotal = (): number =>
      Array.from(counts.values()).reduce((s, n) => s + n, 0) + customCount

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

    function providerColor(id: string): string {
      if (id.startsWith('custom:')) return CUSTOM_COLOR
      return PROVIDER_COLORS[id] ?? '#2dd4bf'
    }
    function providerInitial(id: string): string {
      if (id.startsWith('custom:')) return '›'
      return roster.find((a) => a.id === id)?.name ?? id
    }

    async function launch(skipAgents: boolean): Promise<void> {
      const mix: ProviderCount[] = []
      if (!skipAgents) {
        for (const a of roster) {
          const n = counts.get(a.id) ?? 0
          if (n > 0) mix.push({ provider: a.id, count: n })
        }
        const cmd = customCmd.trim()
        if (customCount > 0 && cmd) mix.push({ provider: `custom:${cmd}`, count: customCount })
      }
      const assigned = mix.reduce((s, m) => s + m.count, 0)
      if (paneCount - assigned > 0) mix.push({ provider: 'shell', count: paneCount - assigned })

      let resolved = { paneCount, assignments: expandAssignments() }
      try {
        resolved = await wizardClient.resolve(mix)
      } catch {
        /* offline fallback: the local expansion mirrors resolveLayout */
      }

      // Worktree isolation (3/03): every agent slot gets its own worktree; the agent
      // launches there. Failures fall back to the repo cwd — never block the launch.
      let paneCwds: (string | null)[] | undefined
      if (!skipAgents && isolate && isRepo && cwd) {
        paneCwds = []
        for (const assignment of resolved.assignments) {
          if (assignment && assignment !== 'shell') {
            try {
              const wt = await wizardClient.createWorktree(cwd)
              paneCwds.push(wt.ok && wt.path ? wt.path : null)
            } catch {
              paneCwds.push(null)
            }
          } else {
            paneCwds.push(null)
          }
        }
      }

      const manifest = swarmRoles
      const roles =
        !skipAgents && manifest ? resolved.assignments.map((_, i) => manifest[i] ?? null) : undefined
      openWorkspaceFromTemplate({
        name: name.trim() || basename(cwd) || 'Workspace',
        cwd: remoteHost ? '' : cwd,
        paneCount: resolved.paneCount,
        assignments: resolved.assignments,
        paneCwds: remoteHost ? undefined : paneCwds,
        roles,
        remotes: remoteHost ? Array<{ hostId: string; name: string } | null>(resolved.paneCount).fill(remoteHost) : undefined,
        profileIds: resolved.assignments.map((a) => (a && profileByProvider.has(a) ? profileByProvider.get(a)! : null)),
        // Scope only when there ARE connected servers to scope (else leave the
        // CLIs' global config untouched — no silent stripping, 8/09).
        tools: pickableServers.length ? [...selectedTools] : undefined
      })
      getTelemetry().captureEvent({
        name: 'wizard.completed',
        props: {
          panes: resolved.paneCount,
          agents: resolved.assignments.filter((a) => a && a !== 'shell').length,
          custom: customCount > 0,
          skipped_agents: skipAgents,
          isolated: !!paneCwds // a boolean — never the paths (ADR 0005)
        }
      })
      // The workspace opener switches the app to the live grid; if no workspace
      // feature is mounted (tests), fall back to wherever we came from.
      if (activeView() === 'wizard') leave()
    }

    // ── One page ─────────────────────────────────────────────────────────────
    // Live handles the subtree renderers patch. Assigned in render(); every one
    // is non-null for the lifetime of an open modal.
    let path!: PathInputHandle
    let whereCard!: HTMLElement
    let nameInputEl!: HTMLInputElement
    let recentsHost!: HTMLElement
    let layoutCaption!: HTMLElement
    let agentsCaption!: HTMLElement
    let rosterHost!: HTMLElement
    let presetsHost!: HTMLElement
    let toolsHost!: HTMLElement
    let previewHost!: HTMLElement
    let meterHandle!: ReturnType<typeof createMeter>
    let meterLabel!: HTMLElement
    let launchLabel!: HTMLElement
    let skipBtn!: HTMLButtonElement
    let saveBtn!: HTMLButtonElement
    let swarmHint!: HTMLElement
    let picker!: ReturnType<typeof createLayoutGridPicker>
    let isolateBox!: ReturnType<typeof createCheckbox>
    let isolateHint!: HTMLElement
    let customInput!: HTMLInputElement
    let advAgents!: HTMLDetailsElement
    const steppers = new Map<string, StepperHandle>()
    let customStepper: StepperHandle | null = null

    const customIsSet = (): boolean => customCount > 0 || customCmd.trim().length > 0

    /** Push a programmatic mix (prefill, preset, Clear) back into the custom row. */
    function syncCustom(): void {
      if (!customInput || !customStepper) return
      if (customInput.value !== customCmd) customInput.value = customCmd
      customStepper.setValue(customCount)
      if (customIsSet()) advAgents.open = true // never hide state the user did not set here
    }

    /** A quiet per-card "Advanced" disclosure. Native <details>: Chromium gives us
     *  the button semantics, aria-expanded, and Enter/Space for free. */
    function disclosure(label: string, openNow: boolean, children: ElChild[]): HTMLDetailsElement {
      const d = el('details', { class: 'wizard-adv' }, [
        el('summary', { class: 'wizard-adv-summary' }, [icon('chevron-right', 14), el('span', { text: label })]),
        el('div', { class: 'wizard-adv-body' }, children)
      ]) as HTMLDetailsElement
      d.open = openNow
      return d
    }

    function render(): void {
      clear(body)
      clear(footer)
      steppers.clear()
      customStepper = null

      body.append(buildWhere(), buildLayout(), buildAgents())
      buildFooter()

      renderRecents()
      renderRoster()
      renderPresets()
      renderTools()
    }

    // ── Card 1: Where ────────────────────────────────────────────────────────
    function buildWhere(): HTMLElement {
      const probeGit = async (value: string): Promise<void> => {
        cwd = value
        if (remoteHost) return // remote target: no local probing (4/05)
        if (!value.trim()) {
          isRepo = false
          path.setStatus({ kind: 'idle' })
          syncIsolate()
          return
        }
        try {
          const git = await wizardClient.gitQuery(value)
          if (cwd !== value) return // stale probe
          isRepo = !!git
          if (git) path.setStatus({ kind: 'git', text: `${git.branch}${git.dirty ? ' •' : ''}` })
          else path.setStatus({ kind: 'ok', text: 'no repo — fine' })
        } catch {
          isRepo = false
          path.setStatus({ kind: 'warn', text: 'unverified' })
        }
        syncIsolate()
      }
      let probeTimer: ReturnType<typeof setTimeout> | undefined
      path = createPathInput({
        value: cwd,
        onBrowse: () => {
          void wizardClient.browseDir().then((dir) => {
            if (!dir) return
            path.setValue(dir)
            void probeGit(dir)
            if (!nameInput.value) {
              nameInput.value = basename(dir)
              name = nameInput.value
            }
          })
        },
        onInput: (v) => {
          cwd = v
          if (probeTimer) clearTimeout(probeTimer)
          probeTimer = setTimeout(() => void probeGit(v), 350)
        },
        // Enter in the folder field launches when the form is valid (8.5/02).
        onEnter: () => void tryLaunch(false)
      })
      if (cwd) void probeGit(cwd)

      const nameInput = el('input', {
        class: 'input',
        type: 'text',
        value: name,
        placeholder: cwd ? basename(cwd) : 'My project',
        onInput: (e) => {
          name = (e.target as HTMLInputElement).value
        },
        onKeydown: (e) => {
          if (e.key === 'Enter') void tryLaunch(false)
        }
      })
      nameInputEl = nameInput

      recentsHost = el('div', { class: 'wizard-recents' })

      // Remote target (4/05): mutually exclusive with a local folder — choosing a
      // host turns the folder box into a plain remote-cwd string (no local probing).
      const remoteSelect = el('select', { class: 'input' }) as HTMLSelectElement
      remoteSelect.append(new Option('This machine', ''))
      void (getBridge().invoke(RemoteChannels.list) as Promise<RemoteHost[]>).then((hosts) => {
        for (const h of hosts ?? []) {
          const opt = new Option(`${h.name} (${h.user ? h.user + '@' : ''}${h.host})`, h.id)
          opt.dataset.name = h.name
          remoteSelect.append(opt)
        }
        if (remoteHost) remoteSelect.value = remoteHost.hostId
      })
      remoteSelect.addEventListener('change', () => {
        const opt = remoteSelect.selectedOptions[0]
        remoteHost = remoteSelect.value ? { hostId: remoteSelect.value, name: opt?.dataset.name ?? remoteSelect.value } : null
        if (remoteHost) {
          isRepo = false
          isolate = false
          path.setStatus({ kind: 'ok', text: `remote: ${remoteHost.name} — local repo tools off` })
        } else {
          void probeGit(cwd)
        }
        syncIsolate()
      })

      whereCard = Card({ header: SectionHeader({ title: 'Where', caption: 'Your terminals start in this folder.' }) }, [
        FieldGroup({ label: 'Working folder', hint: 'Type a path, or Browse.' }, path.el),
        FieldGroup({ label: 'Workspace name', hint: 'Optional — defaults to the folder name.' }, nameInput),
        FieldGroup({ label: 'Recent folders' }, recentsHost),
        // Auto-open when a remote host is already chosen.
        disclosure('Advanced', !!remoteHost, [
          FieldGroup({ label: 'Runs on', hint: 'This machine, or a saved SSH host.' }, remoteSelect)
        ])
      ])
      return whereCard
    }

    function renderRecents(): void {
      if (!recentsHost) return
      clear(recentsHost)
      const group = recentsHost.closest('.field-group') as HTMLElement | null
      if (group) group.hidden = recents.length === 0
      for (const r of recents) {
        recentsHost.append(
          el(
            'button',
            {
              class: 'wizard-recent',
              type: 'button',
              title: r.cwd,
              onClick: () => {
                path.setValue(r.cwd)
                cwd = r.cwd
                void wizardClient
                  .gitQuery(r.cwd)
                  .then((git) => {
                    isRepo = !!git
                    path.setStatus(git ? { kind: 'git', text: `${git.branch}${git.dirty ? ' •' : ''}` } : { kind: 'ok', text: 'no repo — fine' })
                    syncIsolate()
                  })
                  .catch(() => undefined)
                if (!name) {
                  name = r.name
                  nameInputEl.value = r.name
                }
              }
            },
            [
              icon('folder', 14),
              el('span', { class: 'wizard-recent-name', text: r.name || basename(r.cwd) }),
              el('span', { class: 'wizard-recent-path', text: r.cwd })
            ]
          )
        )
      }
    }

    // ── Card 2: Layout ───────────────────────────────────────────────────────
    function buildLayout(): HTMLElement {
      // The selected tile already carries count + shape (its label and aria-label);
      // the caption states it in words. The old duplicate mini-preview is gone.
      const header = SectionHeader({ title: 'Layout', caption: layoutText() })
      layoutCaption = header.querySelector('.section-header-caption') as HTMLElement
      picker = createLayoutGridPicker({
        specs: TEMPLATE_COUNTS.map((n) => ({ count: n, rows: TEMPLATES[n].rows, cols: TEMPLATES[n].cols })),
        selected: paneCount,
        onSelect: (n) => {
          paneCount = n
          layoutCaption.textContent = layoutText()
          refreshAgents()
        }
      })
      return Card({ header }, [picker.el])
    }

    function layoutText(): string {
      const spec = TEMPLATES[paneCount]
      return `${paneCount} ${plural(paneCount)} · ${spec.rows}×${spec.cols} grid. Re-layout any time.`
    }

    // ── Card 3: Agents ───────────────────────────────────────────────────────
    function buildAgents(): HTMLElement {
      const header = SectionHeader({ title: 'Agents', caption: agentsText() })
      agentsCaption = header.querySelector('.section-header-caption') as HTMLElement

      meterHandle = createMeter(assignedTotal(), paneCount)
      meterLabel = el('span', { class: 'wizard-fill-label' })
      previewHost = el('div', { class: 'wizard-preview' })
      rosterHost = el('div', { class: 'wizard-agents' })
      presetsHost = el('div', { class: 'wizard-presets' })
      toolsHost = el('div', { class: 'wizard-tools' })

      // The meter groups DOWN with the controls that move it, not up toward the
      // card title (the audit's complaint: it read as a header ornament).
      const fillRow = el('div', { class: 'wizard-fill' }, [
        el('div', { class: 'wizard-fill-bar' }, [meterHandle.el, meterLabel]),
        el('div', { class: 'wizard-fills' }, [
          el('span', { class: 'wizard-cluster-label', text: 'Quick fill' }),
          Button({ label: 'Fill all', size: 'sm', title: 'Fill every pane, cycling through installed agents', onClick: () => quickFill('all') }),
          Button({ label: 'One of each', size: 'sm', onClick: () => quickFill('each') }),
          Button({ label: 'Split evenly', size: 'sm', onClick: () => quickFill('split') }),
          Button({ label: 'Clear', size: 'sm', variant: 'danger', onClick: () => quickFill('clear') })
        ])
      ])

      // ── Advanced: swarm · tools · worktrees · presets ───────────────────────
      const swarmBtn = Button({
        label: 'Swarm preset — architect · 2 workers · reviewer',
        icon: 'sparkles',
        onClick: () => {
          const provider = roster.find((a) => a.installed) ?? roster[0]
          if (!provider) return
          paneCount = 4
          picker.setSelected(4)
          layoutCaption.textContent = layoutText()
          counts = new Map([[provider.id, 4]])
          customCount = 0
          swarmRoles = ['architect', 'worker', 'worker', 'reviewer']
          renderRoster() // NOT render(): a self-call to the card builder double-rendered it
        }
      })
      swarmHint = el('span', { class: 'wizard-hint' })

      isolateBox = createCheckbox({
        checked: isolate && isRepo,
        disabled: !isRepo,
        label: 'Isolate each agent in its own git worktree',
        onChange: (checked) => {
          isolate = checked
        }
      })
      isolateHint = el('span', { class: 'wizard-hint' })

      saveBtn = Button({
        label: 'Save as preset',
        size: 'sm',
        variant: 'ghost',
        icon: 'bookmark',
        disabled: assignedTotal() === 0,
        onClick: savePreset
      })

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
          refreshAgents()
        }
      })
      const customRow = el('div', { class: 'wizard-agent-row wizard-custom-row' }, [
        el('span', { class: 'wizard-agent-head' }, [
          el('span', { class: 'wizard-agent-dot', style: { background: CUSTOM_COLOR } }),
          customInput
        ]),
        el('span', { class: 'wizard-agent-tail' }, [customStepper.el])
      ])

      // Auto-open when anything inside is already set — including a prefilled
      // `custom:` mix, whose only controls live in here.
      const advanced = disclosure('Advanced', !!swarmRoles || isolate || selectedTools.size > 0 || customIsSet(), [
        customRow,
        el('div', { class: 'wizard-adv-row' }, [swarmBtn, swarmHint]),
        toolsHost,
        el('div', { class: 'wizard-adv-row' }, [isolateBox.el, isolateHint]),
        el('div', { class: 'wizard-adv-row wizard-presets-row' }, [
          el('span', { class: 'wizard-cluster-label', text: 'Presets' }),
          presetsHost,
          saveBtn
        ])
      ])
      advAgents = advanced

      // The BYO-auth reassurance rides the footer bar, where it is always in view
      // (it used to sit below the fold at the bottom of a 640px modal).
      return Card({ header }, [
        fillRow,
        rosterHost,
        el('div', { class: 'wizard-preview-wrap' }, [
          el('span', { class: 'wizard-cluster-label', text: 'Your grid' }),
          previewHost
        ]),
        advanced
      ])
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

    /** The roster + custom row. Rebuilt when the roster or the mix changes. */
    function renderRoster(): void {
      if (!rosterHost) return
      clear(rosterHost)
      steppers.clear()

      const noneInstalled = roster.length > 0 && roster.every((a) => !a.installed)
      if (!roster.length || noneInstalled) {
        const recheck = el('button', { class: 'wizard-recheck', type: 'button', text: 'Re-check PATH' })
        recheck.onclick = (): void => {
          recheck.textContent = 'Checking…'
          void wizardClient
            .detectAgents()
            .then((a) => {
              roster = a ?? []
              renderRoster()
            })
            .catch(() => (roster = []))
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
                  void getBridge().invoke(ClipboardChannels.write, { text: a.installHint! })
                  copy.textContent = 'Copied'
                  setTimeout(() => (copy.textContent = 'Copy'), 1400)
                }
                return el('span', { class: 'wizard-agent-install' }, [
                  el('code', { class: 'wizard-agent-cmd', text: a.installHint }),
                  copy
                ])
              })()
            : null

        // head | tail, tail right-aligned by `margin-left: auto` — no zero-width
        // spacer element (the audit's REMOVE) and no phantom flex gaps.
        rosterHost.append(
          el('div', { class: 'wizard-agent-row' + (a.installed ? '' : ' is-missing') }, [
            el('span', { class: 'wizard-agent-head' }, [
              el('span', { class: 'wizard-agent-dot', style: { background: providerColor(a.id) } }),
              el('span', { class: 'wizard-agent-name', text: a.name }),
              a.installed ? null : Pill({ text: 'not found on PATH', tone: 'warning' })
            ]),
            el('span', { class: 'wizard-agent-tail' }, [installHint, profSel, a.installed ? s.el : null])
          ])
        )
      }

      // The custom-command row lives in Advanced (it is built once, in buildAgents),
      // so a mix that carries one must be pushed back into its controls here.
      syncCustom()
      refreshAgents()
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
                picker.setSelected(paneCount)
                layoutCaption.textContent = layoutText()
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

    /** Tools scoping (8/09) — rendered only when there ARE connected servers. */
    function renderTools(): void {
      if (!toolsHost) return
      clear(toolsHost)
      toolsHost.hidden = pickableServers.length === 0
      if (!pickableServers.length) return
      const chips = el('div', { class: 'wizard-tools-chips' })
      for (const s of pickableServers) {
        const chip = el('button', {
          class: `wizard-tool-chip${selectedTools.has(s.id) ? ' is-on' : ''}`,
          type: 'button',
          text: s.label,
          ariaLabel: `Include ${s.label} in this workspace`
        }) as HTMLButtonElement
        chip.setAttribute('aria-pressed', String(selectedTools.has(s.id)))
        chip.onclick = (): void => {
          if (selectedTools.has(s.id)) selectedTools.delete(s.id)
          else selectedTools.add(s.id)
          chip.classList.toggle('is-on')
          chip.setAttribute('aria-pressed', String(selectedTools.has(s.id)))
        }
        chips.append(chip)
      }
      toolsHost.append(
        el('span', { class: 'wizard-cluster-label', text: 'Agent tools' }),
        chips,
        el('span', {
          class: 'wizard-hint',
          text: 'House server always on. Unpicked tools stay out of this workspace’s agents (edit later in Settings › Workspace tools).'
        })
      )
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
        : 'Pick a git repository above to enable worktree isolation.'
    }

    /** Everything that moves when the mix or the grid changes. */
    function refreshAgents(): void {
      const total = assignedTotal()
      meterHandle.set(total, paneCount)
      meterLabel.textContent = `${total} / ${paneCount} · ${paneCount - total} empty`
      agentsCaption.textContent = agentsText()

      const remaining = paneCount - total
      for (const [id, s] of steppers) s.setMax((counts.get(id) ?? 0) + remaining)
      customStepper?.setMax(customCount + remaining)

      clear(previewHost)
      const spec = TEMPLATES[paneCount]
      previewHost.append(
        MiniGridPreview({ rows: spec.rows, cols: spec.cols, assignments: expandAssignments(), providerColor, providerInitial })
      )

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
      const launchBtn = el(
        'button',
        { class: 'btn btn--primary', type: 'button', ariaLabel: 'Launch workspace', onClick: () => void tryLaunch(false) },
        [icon('sparkles'), launchLabel]
      )
      skipBtn = Button({ label: 'Skip — no agents', variant: 'outline', onClick: () => void tryLaunch(true) })
      footer.append(
        el('span', { class: 'wizard-byo' }, [
          icon('check-circle', 12),
          el('span', { text: 'Your own CLIs, your own login — no keys stored.' })
        ]),
        el('div', { class: 'wizard-footer-actions' }, [skipBtn, launchBtn])
      )
    }

    /** The validation that used to gate "Continue" now gates "Launch". */
    async function tryLaunch(skipAgents: boolean): Promise<void> {
      if (!remoteHost && !cwd.trim()) {
        path.setStatus({ kind: 'warn', text: 'pick a folder first' })
        whereCard.scrollIntoView({ block: 'nearest' })
        path.focus()
        return
      }
      await launch(skipAgents)
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
          remotes?: ({ hostId: string; name: string } | null)[],
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
        openWizard: (prefill?: WizardPrefill) => open(prefill)
      }
    }
  }
}
