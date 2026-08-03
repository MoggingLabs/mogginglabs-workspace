import { ProfileChannels, SystemChannels, WorktreeChannels } from '@contracts'
import type { AgentInfo, AgentProfile, WorktreePreflight } from '@contracts'
import {
  Button,
  clear,
  createCheckbox,
  createModal,
  createStepper,
  el,
  icon,
  openContextMenu,
  providerAccent,
  providerLogo,
  type CheckboxHandle,
  type ContextMenuEntry,
  type StepperHandle
} from '../../components'
import { getBridge } from '../../core/ipc/bridge'
import { getAgentRegistry, onAgentRegistryChange, refreshAgentRegistry } from '../../core/agents/registry'
import { createAgentSetupPanel, type AgentSetupPanelHandle } from '../agents/setup-panel'
import { isolationView, type IsolationProbe } from '../wizard/isolation-state'

export interface NewTerminalEntry {
  /** 'shell' · a roster id · 'custom:<command>' — the launch port's provider vocabulary. */
  provider: string
  /** Launch under this profile; omitted = the provider's active profile (order 0). */
  profileId?: string
}

export interface NewTerminalModalOpts {
  /** How many more panes this workspace can hold — the stepper's hard ceiling. */
  headroom: number
  /** The workspace root — what the isolation preflight asks about. */
  cwd: string
  onCreate: (entries: NewTerminalEntry[], isolate: boolean) => void
}

/** Remembered across opens (renderer display preference, same tier as the rail
 *  collapse): the last lineup's provider ids + the isolate tick. Never the custom
 *  command text — a command line can carry tokens, and this store is plaintext. */
const LAST_KEY = 'mogging.newTerminals.last'

interface LastChoice {
  providers: string[]
  isolate: boolean
}

function readLast(): LastChoice | null {
  try {
    const raw = localStorage.getItem(LAST_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as LastChoice
    if (!Array.isArray(v.providers)) return null
    return { providers: v.providers.filter((p): p is string => typeof p === 'string'), isolate: !!v.isolate }
  } catch {
    return null
  }
}

function writeLast(choice: LastChoice): void {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(choice))
  } catch {
    /* storage unavailable */
  }
}

const plural = (n: number): string => (n === 1 ? 'terminal' : 'terminals')

/**
 * "New terminal…" (titlebar layout popover) — the wizard's placement palette, scaled
 * down to the panes being ADDED to a live workspace instead of a whole new grid.
 *
 * Same model, on purpose (user direction: whoever learned the wizard must already
 * know this dialog): a CHIP per installed agent (+ custom + shell) arms a brush, the
 * slot strip is the canvas — click or sweep to place, double-click a chip to fill
 * all, ▾ for fill menus, a bare click on a slot opens its own picker. Counts are
 * outputs on the chips, never inputs. What shrank is the canvas: a strip of the N
 * terminals to create, not a grid painter — arrangement belongs to the split the
 * controller performs, so there is nothing spatial to paint here.
 */
export function openNewTerminalModal(opts: NewTerminalModalOpts): void {
  const last = readLast()
  const headroom = Math.max(1, opts.headroom)

  let count = Math.min(Math.max(last?.providers.length ?? 1, 1), headroom)
  // The remembered lineup restores only what is still installed — a provider that
  // left the machine falls back to a plain shell, exactly like the wizard's
  // applyRoster invariant (a launch would type a command the shell cannot find).
  let roster: AgentInfo[] = [...getAgentRegistry()]
  const restorable = (id: string | undefined): string | null =>
    id && id !== 'shell' && roster.some((a) => a.id === id && a.installed) ? id : null
  let slots: (string | null)[] = Array.from({ length: count }, (_, i) => restorable(last?.providers[i]))
  let brush: string | null = null
  let customCmd = ''
  let isolate = last?.isolate ?? false
  let isolateProbe: IsolationProbe = { kind: opts.cwd ? 'pending' : 'no-folder' }
  let profilesCache: AgentProfile[] = []
  const profileByProvider = new Map<string, string>()
  const setupPanels: AgentSetupPanelHandle[] = []
  let open = true

  // ── The placement model — the wizard's, verbatim, over `count` slots ─────
  const assignedTotal = (): number => slots.filter(Boolean).length
  const countOf = (id: string): number => slots.filter((s) => s === id).length

  function normalizeSlots(): void {
    if (slots.length < count) slots = [...slots, ...Array<string | null>(count - slots.length).fill(null)]
    else if (slots.length > count) slots = slots.slice(0, count)
    if (!customCmd.trim()) slots = slots.map((id) => (id === 'custom' ? null : id))
  }

  function expandAssignments(): string[] {
    const cmd = customCmd.trim()
    return Array.from({ length: count }, (_, i) => {
      const id = slots[i]
      if (!id) return 'shell'
      if (id === 'custom') return cmd ? `custom:${cmd}` : 'shell'
      return id
    })
  }

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

  function armBrush(id: string): void {
    if (id === 'custom' && !customCmd.trim()) {
      customInput.focus()
      return
    }
    brush = brush === id ? null : id
    render()
  }

  function fillAllWith(id: string): void {
    if (id === 'custom' && !customCmd.trim()) {
      customInput.focus()
      return
    }
    slots = Array<string | null>(count).fill(id === 'shell' ? null : id)
    render()
  }

  function fillEmptyWith(id: string): void {
    if (id === 'custom' && !customCmd.trim()) {
      customInput.focus()
      return
    }
    slots = slots.map((s) => s ?? (id === 'shell' ? null : id))
    render()
  }

  function paintSlot(i: number): void {
    if (!brush || i < 0 || i >= slots.length) return
    slots[i] = brush === 'shell' ? null : brush
    render()
  }

  function providerName(id: string | null): string {
    if (!id) return 'Shell'
    if (id === 'custom') return 'Custom'
    return roster.find((a) => a.id === id)?.name ?? id
  }

  /** The no-brush click on a slot: its own picker, anchored to the tile — the
   *  zero-learning-curve path the wizard's canvas promises. */
  function openSlotPicker(i: number, anchor: DOMRect): void {
    const entries: ContextMenuEntry[] = roster
      .filter((a) => a.installed)
      .map((a) => ({
        label: a.name,
        hint: slots[i] === a.id ? 'current' : undefined,
        onSelect: () => {
          slots[i] = a.id
          render()
        }
      }))
    const cmd = customCmd.trim()
    if (cmd) {
      entries.push({
        label: 'Custom command',
        hint: cmd.length > 24 ? cmd.slice(0, 23) + '…' : cmd,
        onSelect: () => {
          slots[i] = 'custom'
          render()
        }
      })
    }
    entries.push({ separator: true })
    entries.push({
      label: 'Plain shell',
      hint: slots[i] === null ? 'current' : undefined,
      onSelect: () => {
        slots[i] = null
        render()
      }
    })
    openContextMenu({
      items: entries,
      x: anchor.left,
      y: anchor.bottom + 4,
      ariaLabel: `Terminal ${i + 1} — choose what runs here`
    })
  }

  // ── Static skeleton ───────────────────────────────────────────────────────
  const countStepper: StepperHandle = createStepper({
    value: count,
    min: 1,
    max: headroom,
    ariaLabel: 'How many terminals',
    onChange: (n) => {
      count = n
      render()
    }
  })
  const countLabel = el('span', { class: 'ntm-count-label' })
  const countHint = el('span', {
    class: 'wizard-hint',
    text: `Up to ${headroom} more ${plural(headroom)} on this grid`
  })

  const slotsHost = el('div', { class: 'ntm-slots', role: 'group', ariaLabel: 'New terminals' })
  const brushesHost = el('span', { class: 'wizard-palette-group' })
  const missingHost = el('span', { class: 'wizard-palette-group' })
  const clearHost = el('span', { class: 'wizard-palette-clear' })
  const paletteHost = el('div', { class: 'wizard-palette ntm-palette', role: 'toolbar', ariaLabel: 'Agents' }, [
    brushesHost,
    missingHost,
    clearHost
  ])
  const brushHint = el('p', { class: 'wizard-hint wizard-brush-hint' })
  const setupHost = el('div', { class: 'wizard-setup-host' })
  const profilesHost = el('div', { class: 'wizard-profiles' })

  const customStepper: StepperHandle = createStepper({
    value: 0,
    min: 0,
    max: 0,
    ariaLabel: 'Custom command count',
    onChange: (n) => {
      setSlotCount('custom', n)
      render()
    }
  })
  const customInput = el('input', {
    class: 'input input--mono wizard-custom-input',
    type: 'text',
    placeholder: 'Custom command…',
    title: 'Any CLI, verbatim — e.g. aider --model gpt-4o',
    ariaLabel: 'Custom command',
    onInput: (e) => {
      customCmd = (e.target as HTMLInputElement).value
      if (!customCmd.trim() && brush === 'custom') brush = null
      render()
    }
  }) as HTMLInputElement
  const customRow = el('div', { class: 'wizard-agent-row wizard-custom-row' }, [
    el('span', { class: 'wizard-agent-head' }, [providerLogo('custom:', 16), customInput]),
    el('span', { class: 'wizard-agent-tail' }, [customStepper.el])
  ])

  const isolateBox: CheckboxHandle = createCheckbox({
    checked: false,
    disabled: true,
    label: 'Isolate each terminal in its own git worktree',
    onChange: (checked) => {
      isolate = checked
    }
  })
  const isolateHint = el('span', { class: 'wizard-hint' })
  let isolateFixKind: 'path' | 'recheck' | null = null
  const isolateFix = el('button', {
    class: 'wizard-inline-fix',
    type: 'button',
    text: 'Check again',
    hidden: true,
    title: 'Ask again — the answer can change without the folder changing',
    onClick: () => {
      if (isolateFixKind === 'path') {
        isolateFix.disabled = true
        void getBridge()
          .invoke(SystemChannels.repairPath)
          .catch(() => undefined)
          .then(() => {
            isolateFix.disabled = false
            probeIsolation()
          })
      } else {
        probeIsolation()
      }
    }
  }) as HTMLButtonElement
  const isolateRow = el('div', { class: 'wizard-option-row' }, [isolateBox.el, isolateHint, isolateFix])

  const createBtn = Button({
    label: 'Open terminal',
    variant: 'primary',
    onClick: () => {
      normalizeSlots()
      const assignments = expandAssignments()
      const entries: NewTerminalEntry[] = assignments.map((provider) => ({
        provider,
        profileId:
          provider !== 'shell' && !provider.startsWith('custom:') && profileByProvider.has(provider)
            ? profileByProvider.get(provider)
            : undefined
      }))
      // The isolate WANT persists even when this folder refused it (wizard rule: the
      // user's intent is not evidence about the filesystem) — but the CREATE honors
      // only what the preflight allowed, or the split would fail where the toggle lied.
      const view = isolationView({ probe: isolateProbe, want: isolate })
      writeLast({ providers: assignments.map((p) => (p.startsWith('custom:') ? 'shell' : p)), isolate })
      modal.close()
      opts.onCreate(entries, view.enabled && view.checked)
    }
  })

  const modal = createModal({
    title: 'New terminals',
    subtitle: 'They split off the focused pane — pick what runs in each.',
    variant: 'dialog',
    width: 560,
    onClose: () => {
      open = false
      unsubRoster()
      for (const panel of setupPanels.splice(0)) panel.dispose()
    }
  })
  modal.setBody(
    el('div', { class: 'ntm-body' }, [
      el('div', { class: 'ntm-count-row' }, [countLabel, countStepper.el, countHint]),
      slotsHost,
      paletteHost,
      brushHint,
      customRow,
      setupHost,
      profilesHost,
      isolateRow
    ])
  )
  modal.setFooter(
    el('div', { class: 'confirm-actions' }, [
      Button({ label: 'Cancel', variant: 'ghost', onClick: () => modal.close() }),
      createBtn
    ])
  )

  // ── Renders — the wizard's cadences: placement vs roster ─────────────────
  function renderSlots(): void {
    clear(slotsHost)
    const expanded = expandAssignments()
    for (let i = 0; i < count; i++) {
      const id = slots[i]
      const name = providerName(id)
      const tile = el(
        'button',
        {
          class: `ntm-slot${id ? ' is-assigned' : ''}`,
          type: 'button',
          title: brush ? `Place ${providerName(brush === 'shell' ? null : brush)} here` : `${name} — click to change`,
          ariaLabel: `Terminal ${i + 1} — runs ${name}`,
          onClick: (e) => {
            // Painting happens on pointerdown (below); the click is the bare-handed
            // path — no brush armed, the slot opens its own picker.
            if (!brush) openSlotPicker(i, (e.currentTarget as HTMLElement).getBoundingClientRect())
          }
        },
        [
          id ? providerLogo(id === 'custom' ? 'custom:' : id, 16) : icon('terminal', 16),
          el('span', { class: 'ntm-slot-name', text: name })
        ]
      )
      // Sweep support, the strip-sized version of the canvas drag: press on one
      // tile, cross the others with the button held, and the brush follows.
      // (el() has no pointer props — attached by hand, released with the tile.)
      tile.addEventListener('pointerdown', () => {
        if (brush) paintSlot(i)
      })
      tile.addEventListener('pointerenter', (e) => {
        if (brush && e.buttons === 1) paintSlot(i)
      })
      const accent = expanded[i] !== 'shell' ? providerAccent(id === 'custom' ? 'custom:' : (id as string)) : ''
      if (accent) tile.style.setProperty('--ntm-accent', accent)
      slotsHost.append(tile)
    }
  }

  /** One chip: logo · name · live ×N · a ▾ fills menu — the wizard's anatomy and
   *  classes, so the two surfaces cannot drift apart visually. */
  function paletteChip(id: string, name: string): HTMLElement {
    const armed = brush === id
    const n = id === 'shell' ? count - assignedTotal() : countOf(id)
    const body = el(
      'button',
      {
        class: `wizard-chip${armed ? ' is-armed' : ''}`,
        type: 'button',
        title: armed ? `Placing ${name} — click to stop` : `Place ${name} on the terminals below`,
        ariaLabel: `${name} brush${n ? ` — ${n} assigned` : ''}`,
        onClick: () => armBrush(id),
        onDblclick: () => fillAllWith(id)
      },
      [
        providerLogo(id === 'custom' ? 'custom:' : id, 14),
        el('span', { class: 'wizard-chip-name', text: name }),
        n > 0 ? el('span', { class: 'wizard-chip-count', text: `×${n}` }) : null
      ]
    )
    body.dataset.chip = id
    body.setAttribute('aria-pressed', String(armed))
    if (id === 'shell') return el('span', { class: 'wizard-chip-wrap' }, [body])
    const empty = count - assignedTotal()
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
              { label: `Fill all ${count} ${plural(count)}`, onSelect: () => fillAllWith(id) },
              { label: `Fill ${empty} empty ${plural(empty)}`, disabled: empty === 0, onSelect: () => fillEmptyWith(id) }
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
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.chip ?? null
    clear(brushesHost)
    for (const a of roster.filter((agent) => agent.installed)) brushesHost.append(paletteChip(a.id, a.name))
    if (customCmd.trim() || countOf('custom') > 0) brushesHost.append(paletteChip('custom', 'Custom'))
    brushesHost.append(paletteChip('shell', 'Shell'))
    clear(clearHost)
    clearHost.append(
      Button({
        label: 'Clear',
        size: 'sm',
        variant: 'danger',
        title: 'Every terminal back to a plain shell',
        onClick: () => {
          slots = Array<string | null>(count).fill(null)
          brush = null
          render()
        }
      })
    )
    if (focused) brushesHost.querySelector<HTMLElement>(`[data-chip="${focused}"]`)?.focus()
    brushHint.textContent = !brush
      ? ''
      : brush === 'shell'
        ? 'Click the terminals above to clear them back to shells.'
        : `Click the terminals above to place ${brush === 'custom' ? 'the custom command' : providerName(brush)} — double-click the chip fills all.`
    brushHint.hidden = !brushHint.textContent
  }

  /** Providers with a real profile CHOICE, and only those this lineup places —
   *  the wizard's row, filtered to what is being created (compact pass). */
  function renderProfiles(): void {
    clear(profilesHost)
    for (const a of roster.filter((agent) => agent.installed && countOf(agent.id) > 0)) {
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
          el('span', { class: 'wizard-select' }, [sel])
        ])
      )
    }
  }

  /** Roster cadence: missing CLIs as grayed chips whose one click installs —
   *  the same anatomy the wizard renders, setup progress unfolding below. */
  function renderMissing(): void {
    clear(missingHost)
    clear(setupHost)
    for (const panel of setupPanels.splice(0)) panel.dispose()
    for (const a of roster) {
      if (a.installed || !a.installHint) continue
      const panel = createAgentSetupPanel({
        agentId: a.id,
        name: a.name,
        compact: true,
        iconOnly: true,
        onInstalled: () => void refreshAgentRegistry()
      })
      setupPanels.push(panel)
      setupHost.append(panel.el)
      const body = el(
        'button',
        {
          class: 'wizard-chip is-missing',
          type: 'button',
          title: `${a.name} isn’t installed — one click sets it up, dependencies included`,
          ariaLabel: `Install ${a.name}`,
          onClick: () => panel.action.querySelector('button')?.click()
        },
        [providerLogo(a.id, 14), el('span', { class: 'wizard-chip-name', text: a.name })]
      )
      missingHost.append(el('span', { class: 'wizard-chip-wrap is-missing' }, [body, panel.action]))
    }
  }

  function syncIsolate(): void {
    const view = isolationView({ probe: isolateProbe, want: isolate })
    isolateBox.setDisabled(!view.enabled)
    isolateBox.setChecked(view.checked)
    isolateHint.textContent = view.hint
    isolateFix.hidden = view.fix === null
    isolateFixKind = view.fix
    isolateFix.textContent = view.fix === 'path' ? 'Find Git' : 'Check again'
  }

  function probeIsolation(): void {
    if (!opts.cwd) {
      isolateProbe = { kind: 'no-folder' }
      return syncIsolate()
    }
    isolateProbe = { kind: 'pending' }
    syncIsolate()
    void (getBridge().invoke(WorktreeChannels.preflight, opts.cwd) as Promise<WorktreePreflight>)
      .then((pf) => {
        if (!open) return
        isolateProbe = { kind: 'answered', preflight: pf }
        syncIsolate()
      })
      .catch(() => {
        if (!open) return
        isolateProbe = { kind: 'answered', preflight: { ok: false, reason: 'unsupported' } }
        syncIsolate()
      })
  }

  function render(): void {
    normalizeSlots()
    countLabel.textContent = `${count} ${plural(count)}`
    countStepper.setValue(count)
    customStepper.setMax(countOf('custom') + (count - assignedTotal()))
    customStepper.setValue(countOf('custom'))
    customStepper.setDisabled(!customCmd.trim())
    renderSlots()
    renderPalette()
    renderProfiles()
    // The label span, not textContent on the button — Button() nests its label.
    const label = `Open ${count === 1 ? 'terminal' : `${count} terminals`}`
    const span = createBtn.querySelector('span')
    if (span) span.textContent = label
    createBtn.setAttribute('aria-label', label)
  }

  const unsubRoster = onAgentRegistryChange((next) => {
    if (!open) return
    roster = [...next]
    // A provider that vanished cannot stay placed (or armed) — same invariant as
    // the wizard's applyRoster: a launch would type a command the shell cannot find.
    slots = slots.map((id) => (id && id !== 'custom' && !roster.some((a) => a.id === id && a.installed) ? null : id))
    if (brush && brush !== 'custom' && brush !== 'shell' && !roster.some((a) => a.id === brush && a.installed)) {
      brush = null
    }
    renderMissing()
    render()
  })

  void refreshAgentRegistry()
  void (getBridge().invoke(ProfileChannels.list) as Promise<AgentProfile[]>)
    .then((profiles) => {
      if (!open) return
      profilesCache = profiles ?? []
      renderProfiles()
    })
    .catch(() => undefined)

  renderMissing()
  render()
  syncIsolate()
  probeIsolation()
  modal.open()
}
