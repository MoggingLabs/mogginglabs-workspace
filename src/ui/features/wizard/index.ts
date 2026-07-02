import type { UiFeature } from '../../core/registry/feature-registry'
import { ProfileChannels, RemoteChannels } from '@contracts'
import type { AgentInfo, AgentProfile, ProviderCount, ProviderMixTemplate, RecentWorkspace, RemoteHost } from '@contracts'
import {
  Button,
  EmptyState,
  MiniGridPreview,
  Pill,
  clear,
  createCheckbox,
  createLayoutGridPicker,
  createMeter,
  createModal,
  createPathInput,
  createStepper,
  createWizardStepper,
  el,
  icon,
  type PathInputHandle,
  type StepperHandle
} from '../../components'
import { TEMPLATES, TEMPLATE_COUNTS } from '../layout'
import { getFocusedPane } from '../../core/layout/focus'
import { openWorkspaceFromTemplate } from '../../core/workspace/open-service'
import { setWizardOpener, type WizardPrefill } from '../../core/workspace/wizard-port'
import { setCommands } from '../../core/commands/command-port'
import { getTelemetry } from '../../core/telemetry'
import { getBridge } from '../../core/ipc/bridge'
import { wizardClient } from './wizard.client'

type StepId = 'start' | 'layout' | 'agents'

const STEPS = [
  { id: 'start', label: 'Start' },
  { id: 'layout', label: 'Layout' },
  { id: 'agents', label: 'Agents' }
]

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
 * The new-workspace wizard: Start (name + working folder) · Layout (how many
 * terminals, live grid preview) · Agents (real CLI roster + quick-fill + assignment
 * preview). Consolidates the old provider-mix dialog, layout toolbar and openCwd
 * pieces into one keyboard-drivable flow, on the same templates/workspace contracts.
 * BYO-auth (ADR 0002): agents are launched as YOUR CLIs under YOUR login — the wizard
 * never asks for or stores a credential.
 */
export const wizardFeature: UiFeature = {
  name: 'wizard',
  mount() {
    // ── Wizard state (persists across Back / step changes while open) ────────
    let step: StepId = 'start'
    let name = ''
    let cwd = ''
    let paneCount = 4
    let counts = new Map<string, number>() // provider id -> count
    let customCmd = ''
    let customCount = 0
    let isRepo = false // set by the Start step's git probe
    let isolate = false // Phase-3/03: one git worktree per agent pane
    let swarmRoles: (string | null)[] | null = null // Phase-4/01: per-slot manifest (preset)
    let remoteHost: { hostId: string; name: string } | null = null // Phase-4/05
    let profilesCache: AgentProfile[] = [] // Phase-4/04 picker (refreshed on open)
    const profileByProvider = new Map<string, string>()

    let roster: AgentInfo[] = []
    let presets: ProviderMixTemplate[] = []
    let recents: RecentWorkspace[] = []

    const stepper = createWizardStepper(STEPS, step)
    const body = el('div', { class: 'wizard' })
    const footer = el('div', { class: 'wizard-footer' })

    const modal = createModal({
      title: 'Set up your workspace',
      variant: 'wizard',
      closeOnBackdrop: false,
      body: el('div', { class: 'wizard-shell' }, [stepper.el, body]),
      footer
    })

    setWizardOpener(open)
    setCommands('wizard', [
      { id: 'wizard:open', title: 'New workspace…', hint: 'Workspace', run: () => open() }
    ])

    function open(prefill?: WizardPrefill): void {
      void (getBridge().invoke(ProfileChannels.list) as Promise<AgentProfile[]>).then((list) => {
        profilesCache = list ?? []
      })
      step = 'start'
      name = prefill?.name ?? ''
      cwd = prefill?.cwd ?? ''
      paneCount = prefill?.paneCount ?? defaultPaneCount()
      counts = new Map()
      customCmd = ''
      customCount = 0
      if (prefill?.mix) applyMix(prefill.mix)

      modal.open()
      render()
      getTelemetry().captureEvent({ name: 'wizard.opened', props: { prefilled: !!prefill } })

      // Fresh data every open: installed CLIs, presets, recent folders.
      void wizardClient.detectAgents().then((a) => {
        roster = a ?? []
        if (step === 'agents') render()
      }).catch(() => (roster = []))
      void wizardClient.listPresets().then((p) => {
        presets = p ?? []
        if (step === 'agents') render()
      }).catch(() => (presets = []))
      void wizardClient.loadState().then((s) => {
        const openWs = (s?.workspaces ?? []).filter((w) => w.cwd)
        const closed = s?.recents ?? []
        const seen = new Set<string>()
        recents = [
          ...closed,
          ...openWs.map((w) => ({
            name: w.name,
            cwd: w.cwd,
            paneCount: w.paneCount,
            assignments: w.assignments,
            lastUsedAt: 0
          }))
        ].filter((r) => {
          if (!r.cwd || seen.has(r.cwd)) return false
          seen.add(r.cwd)
          return true
        }).slice(0, 6)
        if (step === 'start') render()
      }).catch(() => (recents = []))
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

    // ── Navigation ───────────────────────────────────────────────────────────
    function go(next: StepId): void {
      step = next
      render()
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
        !skipAgents && manifest
          ? resolved.assignments.map((_, i) => manifest[i] ?? null)
          : undefined
      openWorkspaceFromTemplate({
        name: name.trim() || basename(cwd) || 'Workspace',
        cwd: remoteHost ? '' : cwd,
        paneCount: resolved.paneCount,
        assignments: resolved.assignments,
        paneCwds: remoteHost ? undefined : paneCwds,
        roles,
        remotes: remoteHost ? Array<{ hostId: string; name: string } | null>(resolved.paneCount).fill(remoteHost) : undefined,
        profileIds: resolved.assignments.map((a) => (a && profileByProvider.has(a) ? profileByProvider.get(a)! : null))
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
      modal.close()
    }

    // ── Rendering ────────────────────────────────────────────────────────────
    function render(): void {
      stepper.setCurrent(step)
      clear(body)
      clear(footer)
      if (step === 'start') renderStart()
      else if (step === 'layout') renderLayout()
      else renderAgents()
    }

    function renderStart(): void {
      modal.setTitle('Set up your workspace')
      modal.setSubtitle('Pick a folder to work in — your terminals start there.')

      let path: PathInputHandle
      const probeGit = async (value: string): Promise<void> => {
        cwd = value
        if (remoteHost) return // remote target: no local probing (4/05)
        if (!value.trim()) {
          isRepo = false
          path.setStatus({ kind: 'idle' })
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
        onEnter: () => go('layout')
      })
      if (cwd) void probeGit(cwd)

      const nameInput = el('input', {
        class: 'input',
        type: 'text',
        value: name,
        placeholder: cwd ? basename(cwd) : 'My project',
        ariaLabel: 'Workspace name',
        onInput: (e) => {
          name = (e.target as HTMLInputElement).value
        },
        onKeydown: (e) => {
          if (e.key === 'Enter') go('layout')
        }
      })

      const recentRows = recents.length
        ? el(
            'div',
            { class: 'wizard-recents' },
            recents.map((r) =>
              el(
                'button',
                {
                  class: 'wizard-recent',
                  type: 'button',
                  title: r.cwd,
                  onClick: () => {
                    path.setValue(r.cwd)
                    void probeGit(r.cwd)
                    if (!name) {
                      name = r.name
                      nameInput.value = r.name
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
          )
        : null

      // Remote target (4/05): mutually exclusive with a local folder — choosing a
      // host turns the folder box into a plain remote-cwd string (no local probing).
      const remoteSelect = el('select', { class: 'input wizard-remote-select', ariaLabel: 'Remote host' }) as HTMLSelectElement
      remoteSelect.append(new Option('Local folder', ''))
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
      })

      body.append(
        el('div', { class: 'field' }, [
          el('span', { class: 'field-label' }, [
            'Working folder',
            el('span', { class: 'field-hint', text: 'where your terminals will start' })
          ]),
          path.el
        ]),
        el('div', { class: 'field' }, [
          el('span', { class: 'field-label' }, [
            'Runs on',
            el('span', { class: 'field-hint', text: 'this machine, or a saved SSH host' })
          ]),
          remoteSelect
        ]),
        el('div', { class: 'field' }, [
          el('span', { class: 'field-label' }, [
            'Workspace name',
            el('span', { class: 'field-hint', text: 'optional — defaults to the folder name' })
          ]),
          nameInput
        ]),
        recentRows
          ? el('div', { class: 'field' }, [
              el('span', { class: 'section-label', text: 'Recent folders' }),
              recentRows
            ])
          : el('div', {})
      )

      footer.append(
        el('span', {}),
        Button({
          label: 'Continue',
          iconRight: 'arrow-right',
          variant: 'primary',
          onClick: () => go('layout')
        })
      )
      path.focus()
    }

    function renderLayout(): void {
      modal.setTitle('How many terminals?')
      modal.setSubtitle('Pick a grid — you can drag-resize and re-layout any time.')

      const preview = el('div', { class: 'wizard-layout-preview' })
      const renderPreview = (): void => {
        clear(preview)
        const spec = TEMPLATES[paneCount]
        preview.append(
          MiniGridPreview({ rows: spec.rows, cols: spec.cols }),
          el('span', {
            class: 'wizard-layout-caption',
            text: `${paneCount} ${paneCount === 1 ? 'terminal' : 'terminals'} · ${spec.rows}×${spec.cols} grid`
          })
        )
      }

      const picker = createLayoutGridPicker({
        specs: TEMPLATE_COUNTS.map((n) => ({ count: n, rows: TEMPLATES[n].rows, cols: TEMPLATES[n].cols })),
        selected: paneCount,
        onSelect: (n) => {
          paneCount = n
          renderPreview()
        }
      })
      renderPreview()

      body.append(picker.el, preview)
      footer.append(
        Button({ label: 'Back', icon: 'chevron-left', variant: 'ghost', onClick: () => go('start') }),
        Button({
          label: 'Continue',
          iconRight: 'arrow-right',
          variant: 'primary',
          onClick: () => go('agents')
        })
      )
    }

    function renderAgents(): void {
      modal.setTitle('Add AI coding agents')
      modal.setSubtitle(
        `Pick which agents launch in your ${paneCount} ${paneCount === 1 ? 'terminal' : 'terminals'} — or skip and keep plain shells.`
      )

      const meter = createMeter(assignedTotal(), paneCount)
      const meterLabel = el('span', { class: 'wizard-fill-label' })
      const preview = el('div', { class: 'wizard-assign-preview' })
      const launchBtn = Button({
        label: `Launch ${paneCount} terminals`,
        icon: 'sparkles',
        variant: 'primary',
        onClick: () => void launch(false)
      })

      const steppers = new Map<string, StepperHandle>()
      let customStepper: StepperHandle

      const refresh = (): void => {
        const total = assignedTotal()
        meter.set(total, paneCount)
        meterLabel.textContent = `${total} / ${paneCount} · ${paneCount - total} empty`
        const remaining = paneCount - total
        for (const [id, s] of steppers) {
          s.setMax((counts.get(id) ?? 0) + remaining)
        }
        customStepper.setMax(customCount + remaining)
        clear(preview)
        const spec = TEMPLATES[paneCount]
        preview.append(
          MiniGridPreview({
            rows: spec.rows,
            cols: spec.cols,
            assignments: expandAssignments(),
            providerColor,
            providerInitial
          })
        )
        const label = total > 0 ? `Launch ${paneCount} terminals` : `Open ${paneCount} plain terminals`
        launchBtn.querySelector('span')!.textContent = label
      }

      // Quick fills — all trivially reversible (Clear resets, steppers correct).
      const installed = roster.filter((a) => a.installed)
      const fills = el('div', { class: 'wizard-fills' }, [
        el('span', { class: 'wizard-fills-label', text: 'Quick fill:' }),
        Button({
          label: 'Fill all',
          size: 'sm',
          disabled: !installed.length,
          title: 'Fill every pane, cycling through installed agents',
          onClick: () => {
            counts = new Map()
            customCount = 0
            for (let i = 0; i < paneCount; i++) {
              const a = installed[i % installed.length]
              counts.set(a.id, (counts.get(a.id) ?? 0) + 1)
            }
            renderRows()
          }
        }),
        Button({
          label: 'One of each',
          size: 'sm',
          disabled: !installed.length,
          onClick: () => {
            counts = new Map()
            customCount = 0
            installed.slice(0, paneCount).forEach((a) => counts.set(a.id, 1))
            renderRows()
          }
        }),
        Button({
          label: 'Split evenly',
          size: 'sm',
          disabled: !installed.length,
          onClick: () => {
            counts = new Map()
            customCount = 0
            if (installed.length) {
              const each = Math.floor(paneCount / installed.length)
              let rem = paneCount - each * installed.length
              for (const a of installed) counts.set(a.id, each + (rem-- > 0 ? 1 : 0))
            }
            renderRows()
          }
        }),
        Button({
          label: 'Clear',
          size: 'sm',
          variant: 'danger',
          onClick: () => {
            counts = new Map()
            customCount = 0
            renderRows()
          }
        })
      ])

      const rows = el('div', { class: 'wizard-agents' })
      const renderRows = (): void => {
        clear(rows)
        steppers.clear()
        if (!roster.length) {
          rows.append(
            EmptyState({
              icon: 'terminal',
              title: 'Looking for agent CLIs…',
              body: 'Claude Code, Codex, Gemini, Aider and OpenCode are detected from your PATH.'
            })
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
              refresh()
            }
          })
          steppers.set(a.id, s)
          // Profile picker (4/04): shown only when this provider has >1 profile.
          const mine = profilesCache.filter((p) => p.provider === a.id).sort((x, y) => x.order - y.order)
          let profSel: HTMLSelectElement | null = null
          if (a.installed && mine.length > 1) {
            profSel = el('select', {
              class: 'input wizard-profile-select',
              ariaLabel: `${a.name} profile`
            }) as HTMLSelectElement
            for (const p of mine) profSel.append(new Option(p.name, p.id))
            profSel.value = profileByProvider.get(a.id) ?? mine[0].id
            profSel.addEventListener('change', () => profileByProvider.set(a.id, profSel!.value))
          }
          rows.append(
            el('div', { class: 'wizard-agent-row' + (a.installed ? '' : ' is-missing') }, [
              el('span', {
                class: 'wizard-agent-dot',
                style: { background: providerColor(a.id) }
              }),
              el('span', { class: 'wizard-agent-name', text: a.name }),
              a.installed ? null : Pill({ text: 'not found on PATH', tone: 'warning' }),
              el('span', { class: 'wizard-agent-spacer' }),
              profSel,
              a.installed ? s.el : el('span', {})
            ])
          )
        }
        // Custom command — any CLI, verbatim. Label only; never a stored credential.
        customStepper = createStepper({
          value: customCount,
          min: 0,
          max: customCount + (paneCount - assignedTotal()),
          ariaLabel: 'Custom command count',
          onChange: (n) => {
            customCount = n
            swarmRoles = null
            refresh()
          }
        })
        rows.append(
          el('div', { class: 'wizard-agent-row wizard-custom-row' }, [
            el('span', { class: 'wizard-agent-dot', style: { background: CUSTOM_COLOR } }),
            el('input', {
              class: 'input input--mono wizard-custom-input',
              type: 'text',
              value: customCmd,
              placeholder: 'Custom command — e.g. aider --model …',
              ariaLabel: 'Custom command',
              onInput: (e) => {
                customCmd = (e.target as HTMLInputElement).value
                refresh()
              }
            }),
            el('span', { class: 'wizard-agent-spacer' }),
            customStepper.el
          ])
        )
        refresh()
      }
      renderRows()

      const presetChips = el(
        'div',
        { class: 'wizard-presets' },
        presets.map((p) =>
          el('span', { class: 'wizard-preset' }, [
            el('button', {
              class: 'wizard-preset-apply',
              type: 'button',
              text: p.name,
              onClick: () => {
                applyMix(p.mix)
                renderRows()
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
                        render()
                      })
                    }
                  },
                  [icon('x', 12)]
                )
          ])
        )
      )
      const saveBtn = Button({
        label: 'Save as preset',
        size: 'sm',
        variant: 'ghost',
        icon: 'bookmark',
        disabled: assignedTotal() === 0,
        onClick: () => {
          const presetName = `${expandAssignments().filter((a) => a !== 'shell').length} agents · ${paneCount} panes`
          const mix: ProviderCount[] = []
          for (const a of roster) {
            const n = counts.get(a.id) ?? 0
            if (n > 0) mix.push({ provider: a.id, count: n })
          }
          if (customCount > 0 && customCmd.trim())
            mix.push({ provider: `custom:${customCmd.trim()}`, count: customCount })
          const preset = { id: crypto.randomUUID(), name: presetName, mix }
          void wizardClient.savePreset(preset).then(() => {
            presets = [...presets, preset]
            render()
            getTelemetry().captureEvent({
              name: 'preset.saved',
              props: { agents: mix.reduce((s, m) => s + m.count, 0) }
            })
          })
        }
      })

      // Worktree isolation toggle — only meaningful when the Start folder is a repo.
      const isolateBox = createCheckbox({
        checked: isolate && isRepo,
        label: 'Isolate each agent in its own git worktree',
        onChange: (checked) => {
          isolate = checked
        }
      })
      const isolateRow = el('div', { class: 'wizard-isolate' + (isRepo ? '' : ' is-disabled') }, [
        isolateBox.el,
        el('span', {
          class: 'wizard-isolate-hint',
          text: isRepo
            ? 'Each agent works on its own branch in its own folder — no trampling. Review & merge later.'
            : 'Pick a git repository in Start to enable worktree isolation.'
        })
      ])
      if (!isRepo) isolate = false

      // Swarm preset (4/01): one click -> architect + 2 workers + reviewer on the
      // first installed CLI, each pane chipped with its role.
      const swarmBtn = Button({
        label: 'Swarm preset — architect · 2 workers · reviewer',
        icon: 'sparkles',
        onClick: () => {
          const provider = roster.find((a) => a.installed) ?? roster[0]
          if (!provider) return
          paneCount = 4
          counts = new Map([[provider.id, 4]])
          customCount = 0
          swarmRoles = ['architect', 'worker', 'worker', 'reviewer']
          renderAgents()
        }
      })
      const swarmRow = el('div', { class: 'wizard-swarm-row' }, [
        swarmBtn,
        el('span', {
          class: 'wizard-isolate-hint',
          text: swarmRoles ? 'Swarm manifest armed — roles land on the panes.' : ''
        })
      ])

      body.append(
        el('div', { class: 'wizard-fill-row' }, [meter.el, meterLabel]),
        fills,
        rows,
        swarmRow,
        isolateRow,
        el('div', { class: 'wizard-agent-footer' }, [
          el('div', { class: 'wizard-preview-wrap' }, [
            el('span', { class: 'section-label', text: 'Your grid' }),
            preview
          ]),
          el('div', { class: 'wizard-preset-wrap' }, [
            el('span', { class: 'section-label', text: 'Presets' }),
            presetChips,
            saveBtn
          ])
        ]),
        el('p', { class: 'wizard-byo' }, [
          icon('check-circle', 12),
          el('span', {
            text: 'Agents run your own CLIs under your own login — nothing to configure, no keys stored.'
          })
        ])
      )

      footer.append(
        Button({ label: 'Back', icon: 'chevron-left', variant: 'ghost', onClick: () => go('layout') }),
        el('div', { class: 'wizard-footer-actions' }, [
          Button({ label: 'Skip — no agents', variant: 'outline', onClick: () => void launch(true) }),
          launchBtn
        ])
      )
      refresh()
    }

    exposeForDev()
    function exposeForDev(): void {
      if (!import.meta.env.DEV) return
      const w = window as unknown as { __mogging?: Record<string, unknown> }
      w.__mogging = w.__mogging ?? {}
      // Same dev contract the template smoke drives (resolve a mix -> open a workspace).
      w.__mogging.templates = {
        resolve: (m: ProviderCount[]) => wizardClient.resolve(m),
        list: () => wizardClient.listPresets(),
        open: async (
          m: ProviderCount[],
          roles?: (string | null)[],
          remotes?: ({ hostId: string; name: string } | null)[]
        ) => {
          const r = await wizardClient.resolve(m)
          const cwd = getFocusedPane()?.cwd ?? ''
          openWorkspaceFromTemplate({
            name: 'Smoke',
            cwd,
            paneCount: r.paneCount,
            assignments: r.assignments,
            roles,
            remotes
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
          openWorkspaceFromTemplate({
            name: 'Isolated',
            cwd: repo,
            paneCount: r.paneCount,
            assignments: r.assignments,
            paneCwds
          })
          return { ...r, paneCwds }
        },
        openWizard: (prefill?: WizardPrefill) => open(prefill)
      }
    }
  }
}
