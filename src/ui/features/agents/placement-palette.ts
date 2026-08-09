import type { AgentInfo, AgentProfile } from '@contracts'
import {
  Button,
  clear,
  createStepper,
  el,
  icon,
  openContextMenu,
  providerLogo,
  type ContextMenuEntry,
  type StepperHandle
} from '../../components'
import { refreshAgentRegistry } from '../../core/agents/registry'
import { createAgentSetupPanel, type AgentSetupPanelHandle } from './setup-panel'
import {
  assignedTotal,
  countOf,
  fillAll,
  fillEmpty,
  setSlotCount,
  type SlotId
} from './placement-model'

/**
 * The AGENT PALETTE — the brush strip that paints a layout's terminals, shared by the
 * wizard and the "New terminals" modal.
 *
 * The model is the user's explicit direction: whoever learned the wizard must already know
 * every other pane-creation surface. A CHIP per installed agent (plus custom and shell)
 * arms a brush; the layout canvas is what you paint on; double-clicking a chip fills every
 * terminal and ▾ opens the fill menus; a bare click on a tile opens that tile's own picker,
 * for whoever never discovers the brush. Counts are OUTPUTS on the chips, never inputs.
 *
 * It renders `.wizard-*` classes deliberately: this IS the wizard's vocabulary, not a copy
 * of it, and the two surfaces cannot drift apart while they share the markup.
 *
 * The host owns the slot array; this only renders it and reports edits back through
 * `onSlots`. That is what lets the modal keep a slot list covering just the terminals being
 * ADDED while the painter's canvas covers the whole grid.
 */

export interface PlacementPaletteOpts {
  /** Live reads of the host's state — this component stores none of it. */
  slots: () => readonly SlotId[]
  count: () => number
  brush: () => SlotId
  roster: () => readonly AgentInfo[]
  profiles: () => readonly AgentProfile[]
  customCmd: () => string
  /** What one slot is called, for chip and menu copy. Default 'terminal'. */
  unit?: string
  /** Show a profile row only for providers this lineup actually places. */
  profilesFilter?: 'placed' | 'all'
  onSlots: (next: SlotId[]) => void
  onBrush: (next: SlotId) => void
  onCustomCmd: (text: string) => void
  /** A bulk fill landed (chip double-click or a ▾ menu entry) — the wizard counts these. */
  onFill?: () => void
  /** Render the "Looking for agent CLIs…" note when the roster has not answered yet. */
  emptyNote?: string
  /**
   * Where the per-provider profile choice is kept. Pass a map the HOST owns when the
   * palette is rebuilt more often than the choice should live — the wizard re-renders its
   * whole page on a folder change, and a choice stored in here would silently revert to
   * the default profile. Omitted: the palette keeps its own, which is right for a modal
   * that is built once.
   */
  profileStore?: Map<string, string>
}

export interface PlacementPaletteHandle {
  /** `.wizard-palette` — the brush toolbar (installed chips · missing chips · Clear). */
  el: HTMLElement
  /** The contextual "what an armed brush does" line; empty and hidden at rest. */
  hintEl: HTMLElement
  /** The custom-command row: logo · input · count stepper. */
  customRow: HTMLElement
  /** Per-provider profile selects (hidden unless a provider has a real choice). */
  profilesEl: HTMLElement
  /** Install progress for the missing CLIs, unfolding under their chips. */
  setupEl: HTMLElement
  /** The "still looking for agent CLIs" note, when `emptyNote` is given. */
  emptyEl: HTMLElement
  /** Repaint chips, the custom row and the profile rows — the placement cadence. */
  render(): void
  /** Repaint the missing chips and their setup panels — the roster cadence. */
  renderRoster(): void
  /** The profile chosen for a provider, if the user picked one. */
  profileFor(provider: string): string | undefined
  /** Display name for a slot value, for tile tooltips and picker copy. */
  nameFor(id: SlotId): string
  /** The per-tile picker: the click-to-choose half of the placement model. */
  openPicker(slot: number, anchor: DOMRect, current: SlotId): void
  dispose(): void
}

export function createPlacementPalette(opts: PlacementPaletteOpts): PlacementPaletteHandle {
  const unit = opts.unit ?? 'terminal'
  const plural = (n: number): string => (n === 1 ? unit : `${unit}s`)
  const chosenProfiles = opts.profileStore ?? new Map<string, string>()
  const setupPanels: AgentSetupPanelHandle[] = []

  const brushesHost = el('span', { class: 'wizard-palette-group' })
  const missingHost = el('span', { class: 'wizard-palette-group' })
  const clearHost = el('span', { class: 'wizard-palette-clear' })
  const paletteHost = el('div', { class: 'wizard-palette', role: 'toolbar', ariaLabel: 'Agents' }, [
    brushesHost,
    missingHost,
    clearHost
  ])
  const brushHint = el('p', { class: 'wizard-hint wizard-brush-hint' })
  const setupHost = el('div', { class: 'wizard-setup-host' })
  const profilesHost = el('div', { class: 'wizard-profiles' })
  const emptyHost = el('div', { class: 'wizard-agents' })

  const nameFor = (id: SlotId): string => {
    if (!id || id === 'shell') return 'Shell'
    if (id === 'custom') return 'Custom'
    return opts.roster().find((a) => a.id === id)?.name ?? id
  }

  // ── Custom command row ────────────────────────────────────────────────────
  const customStepper: StepperHandle = createStepper({
    value: 0,
    min: 0,
    max: 0,
    ariaLabel: 'Custom command count',
    onChange: (n) => opts.onSlots(setSlotCount(opts.slots(), 'custom', n))
  })
  const customInput = el('input', {
    class: 'input input--mono wizard-custom-input',
    type: 'text',
    placeholder: 'Custom command…',
    title: 'Any CLI, verbatim — e.g. aider --model gpt-4o',
    ariaLabel: 'Custom command',
    onInput: (e) => opts.onCustomCmd((e.target as HTMLInputElement).value)
  }) as HTMLInputElement
  const customRow = el('div', { class: 'wizard-agent-row wizard-custom-row' }, [
    el('span', { class: 'wizard-agent-head' }, [providerLogo('custom:', 16), customInput]),
    el('span', { class: 'wizard-agent-tail' }, [customStepper.el])
  ])

  /** The stepper's ceiling is "what it already holds plus what is still empty" — it can
   *  claim free slots, never take one from another provider. */
  function syncCustomStepper(): void {
    const slots = opts.slots()
    const mine = countOf(slots, 'custom')
    customStepper.setMax(mine + (opts.count() - assignedTotal(slots)))
    customStepper.setValue(mine)
    customStepper.setDisabled(!opts.customCmd().trim())
  }

  // ── Brushes ───────────────────────────────────────────────────────────────
  /** Arming 'custom' with no command would place a launch that runs nothing — send the
   *  user to the field that makes it real instead of failing quietly. */
  const needsCommand = (id: string): boolean => {
    if (id !== 'custom' || opts.customCmd().trim()) return false
    customInput.focus()
    return true
  }

  const armBrush = (id: string): void => {
    if (needsCommand(id)) return
    opts.onBrush(opts.brush() === id ? null : id)
  }

  const fill = (next: SlotId[]): void => {
    opts.onSlots(next)
    opts.onFill?.()
  }

  /** One chip: logo · name · live ×N · a ▾ fills menu. */
  function paletteChip(id: string, name: string): HTMLElement {
    const slots = opts.slots()
    const count = opts.count()
    const armed = opts.brush() === id
    const n = id === 'shell' ? count - assignedTotal(slots) : countOf(slots, id)
    const body = el(
      'button',
      {
        class: `wizard-chip${armed ? ' is-armed' : ''}`,
        type: 'button',
        title: armed ? `Placing ${name} — click to stop` : `Place ${name} on the ${plural(2)}`,
        ariaLabel: `${name} brush${n ? ` — ${n} assigned` : ''}`,
        onClick: () => armBrush(id),
        onDblclick: () => {
          if (!needsCommand(id)) fill(fillAll(count, id))
        }
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
    const empty = count - assignedTotal(slots)
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
              {
                label: `Fill all ${count} ${plural(count)}`,
                onSelect: () => {
                  if (!needsCommand(id)) fill(fillAll(count, id))
                }
              },
              {
                label: `Fill ${empty} empty ${plural(empty)}`,
                disabled: empty === 0,
                onSelect: () => {
                  if (!needsCommand(id)) fill(fillEmpty(opts.slots(), id))
                }
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
    // Focus survives the repaint: a chip is re-created on every placement edit, and a
    // keyboard user arming one then losing the ring cannot paint at all.
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.chip ?? null
    clear(brushesHost)
    for (const a of opts.roster().filter((agent) => agent.installed)) brushesHost.append(paletteChip(a.id, a.name))
    if (opts.customCmd().trim() || countOf(opts.slots(), 'custom') > 0) {
      brushesHost.append(paletteChip('custom', 'Custom'))
    }
    brushesHost.append(paletteChip('shell', 'Shell'))
    clear(clearHost)
    clearHost.append(
      Button({
        label: 'Clear',
        size: 'sm',
        variant: 'danger',
        title: `Every ${unit} back to a plain shell`,
        onClick: () => {
          opts.onBrush(null)
          opts.onSlots(fillAll(opts.count(), 'shell'))
        }
      })
    )
    if (focused) brushesHost.querySelector<HTMLElement>(`[data-chip="${focused}"]`)?.focus()
    // Contextual, not standing: silent at rest — the chips and the canvas's own tooltips
    // carry discovery — and ONE short line while a brush is armed, because painting is the
    // moment that needs narrating.
    const brush = opts.brush()
    brushHint.textContent = !brush
      ? ''
      : brush === 'shell'
        ? `Sweep the grid to clear ${plural(2)} back to shells.`
        : `Sweep the grid to place ${brush === 'custom' ? 'the custom command' : nameFor(brush)} — double-click fills all.`
    brushHint.hidden = !brushHint.textContent
  }

  // ── Profiles ──────────────────────────────────────────────────────────────
  /** Only providers with a real CHOICE (≥2 profiles), and — in the modal's filter —
   *  only those this lineup actually places. */
  function renderProfiles(): void {
    clear(profilesHost)
    const placedOnly = (opts.profilesFilter ?? 'placed') === 'placed'
    const slots = opts.slots()
    for (const a of opts.roster()) {
      if (!a.installed) continue
      if (placedOnly && countOf(slots, a.id) === 0) continue
      const mine = opts.profiles().filter((p) => p.provider === a.id).sort((x, y) => x.order - y.order)
      if (mine.length < 2) continue
      const sel = el('select', {
        class: 'input input-sm wizard-profile-select',
        ariaLabel: `${a.name} profile`
      }) as HTMLSelectElement
      for (const p of mine) sel.append(new Option(p.name, p.id))
      sel.value = chosenProfiles.get(a.id) ?? mine[0]!.id
      sel.addEventListener('change', () => chosenProfiles.set(a.id, sel.value))
      profilesHost.append(
        el('label', { class: 'wizard-profile-row' }, [
          providerLogo(a.id, 13),
          el('span', { class: 'wizard-profile-name', text: `${a.name} profile` }),
          el('span', { class: 'wizard-select' }, [sel])
        ])
      )
    }
  }

  // ── Missing CLIs ──────────────────────────────────────────────────────────
  function renderRoster(): void {
    clear(missingHost)
    clear(setupHost)
    clear(emptyHost)
    // Each rebuild throws the previous chips away; their setup panels hold a live IPC
    // subscription apiece, so they must be released with the DOM that owned them.
    for (const panel of setupPanels.splice(0)) panel.dispose()
    if (!opts.roster().length && opts.emptyNote) {
      emptyHost.append(el('span', { class: 'wizard-hint', text: opts.emptyNote }))
    }
    // A missing CLI is a CHIP like everyone else: grayed, with the download glyph in the
    // slot where an installed chip keeps its ▾ — the gray and the glyph say "not
    // installed" together, so no card, no pill, no label. Clicking anywhere on it
    // installs; the step-by-step progress unfolds full-width below the row.
    for (const a of opts.roster()) {
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

  // ── The per-tile picker ───────────────────────────────────────────────────
  function openPicker(slot: number, anchor: DOMRect, current: SlotId): void {
    const pick = (id: SlotId): void => {
      const next = [...opts.slots()]
      next[slot] = id
      opts.onSlots(next)
    }
    const entries: ContextMenuEntry[] = opts
      .roster()
      .filter((a) => a.installed)
      .map((a) => ({
        label: a.name,
        hint: current === a.id ? 'current' : undefined,
        onSelect: () => pick(a.id)
      }))
    const cmd = opts.customCmd().trim()
    if (cmd) {
      entries.push({
        label: 'Custom command',
        hint: cmd.length > 24 ? cmd.slice(0, 23) + '…' : cmd,
        onSelect: () => pick('custom')
      })
    }
    entries.push({ separator: true })
    entries.push({
      label: 'Plain shell',
      hint: current === null ? 'current' : undefined,
      onSelect: () => pick(null)
    })
    openContextMenu({
      items: entries,
      x: anchor.left,
      y: anchor.bottom + 4,
      ariaLabel: `Terminal ${slot + 1} — choose what runs here`
    })
  }

  return {
    el: paletteHost,
    hintEl: brushHint,
    customRow,
    profilesEl: profilesHost,
    setupEl: setupHost,
    emptyEl: emptyHost,
    render() {
      if (customInput.value !== opts.customCmd()) customInput.value = opts.customCmd()
      syncCustomStepper()
      renderPalette()
      renderProfiles()
    },
    renderRoster,
    profileFor: (provider) => chosenProfiles.get(provider),
    nameFor,
    openPicker,
    dispose() {
      for (const panel of setupPanels.splice(0)) panel.dispose()
    }
  }
}
