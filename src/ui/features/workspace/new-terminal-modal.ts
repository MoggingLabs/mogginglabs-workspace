import { SystemChannels, WorktreeChannels, ProfileChannels } from '@contracts'
import type { AgentInfo, AgentProfile, WorktreePreflight } from '@contracts'
import {
  Button,
  createCheckbox,
  createGridPainter,
  createModal,
  createStepper,
  el,
  providerAccent,
  providerLogo,
  type CheckboxHandle,
  type GridPainterHandle,
  type StepperHandle
} from '../../components'
import { getBridge } from '../../core/ipc/bridge'
import { getAgentRegistry, onAgentRegistryChange, refreshAgentRegistry } from '../../core/agents/registry'
import { createPlacementPalette } from '../agents/placement-palette'
import {
  expandAssignments,
  normalizeSlots,
  paintSlot,
  pruneBrush,
  pruneToRoster,
  restoreLineup,
  type SlotId
} from '../agents/placement-model'
import { specForCount, TEMPLATES, type GridSpecModel } from '../layout'
import { isolationView, type IsolationProbe } from '../wizard/isolation-state'

export interface NewTerminalEntry {
  /** 'shell' · a roster id · 'custom:<command>' — the launch port's provider vocabulary. */
  provider: string
  /** Launch under this profile; omitted = the provider's active profile (order 0). */
  profileId?: string
}

/** One terminal the workspace ALREADY runs, as the painter needs to draw it. */
export interface LivePaneTile {
  paneId: number
  /** 'shell' · a roster id · 'custom:…' — what is running there now. */
  provider: string
  /** What to call it on its tile: the pane's title, else its provider's name. */
  label: string
}

/** The painted result: a whole-grid spec plus what to launch in the tiles that are new. */
export interface NewTerminalPlan {
  /** Regions 0..liveIds.length-1 are the panes that already exist, in reading order. */
  spec: GridSpecModel
  /**
   * The pane ids those first regions stood for, IN ORDER — not a count. A count cannot
   * say WHICH: a simultaneous open and close leaves it intact while every locked tile
   * comes to mean a different terminal, and the apply would then type an agent into a
   * pane someone is using.
   */
  liveIds: number[]
  /** One per ADDED region, reading order: entries[k] ⇔ spec.regions[liveIds.length + k]. */
  entries: NewTerminalEntry[]
  isolate: boolean
}

/** The workspace as this dialog needs to see it — re-resolved whenever it changes. */
export interface LiveWorkspaceShape {
  /** The terminals already open, in the READING order the painter draws them in. */
  live: LivePaneTile[]
  /** How many more panes this workspace can hold. */
  headroom: number
}

export interface NewTerminalModalOpts {
  /** The terminals already open, in the order `templateLocals` will hand them back. */
  live: LivePaneTile[]
  /** How many more panes this workspace can hold — the painter's growth ceiling. */
  headroom: number
  /** Lattice bounds from the workspace's real capacity. */
  maxRows: number
  maxCols: number
  /** The workspace root — what the isolation preflight asks about. */
  cwd: string
  /**
   * Re-resolve the workspace while the dialog is up, so a pane opening or closing under it
   * redraws the canvas instead of dead-ending at a refusal. Owned by the CONTROLLER —
   * pane identity, order and headroom are all its knowledge, and this dialog stays
   * ignorant of slots and workspaces. Returns an unsubscribe, called on close.
   */
  subscribeLive?: (cb: (next: LiveWorkspaceShape) => void) => () => void
  onCreate: (plan: NewTerminalPlan) => void
}

/** Remembered across opens (renderer display preference, same tier as the rail
 *  collapse): the last lineup's provider ids + the isolate tick. Never the custom
 *  command text — a command line can carry tokens, and this store is plaintext. Never
 *  the geometry either: the grid it was painted against is gone by the next open. */
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

const plural = (n: number, one = 'terminal'): string => (n === 1 ? one : `${one}s`)

/**
 * "New terminal…" (titlebar layout popover) — the wizard's LAYOUT PAINTER, brought to a
 * live workspace.
 *
 * The canvas is the WHOLE resulting grid, not just the panes being added: the terminals
 * you already have appear as locked tiles wearing their agent, and the new ones are yours
 * to size, shape and paint. That is what lets this dialog answer "where do they go?" at
 * all — the split it replaced could only ever cascade off the focused pane, along whatever
 * axis happened to be longer.
 *
 * Same vocabulary as the wizard and Reorganize, on purpose (user direction: whoever
 * learned the wizard must already know this): the SIZE lattice picks rows × cols, dragging
 * across tiles merges them into a spanning terminal, a chip arms a brush, a bare click on
 * a tile opens its own picker. Counts are outputs on the chips, never inputs.
 *
 * Because the lattice will not go below the live pane count and a merge cannot swallow a
 * locked tile, this surface can only ever ADD. It therefore has no destructive confirm and
 * needs none — every path out of it preserves every running terminal.
 */
export function openNewTerminalModal(opts: NewTerminalModalOpts): void {
  const last = readLast()
  // MUTABLE: the workspace can gain or lose a terminal while this dialog is up, and every
  // one of these is keyed on the live set (the painter's locked prefix, the tile→slot
  // mapping, the stepper's ceiling). See onLive.
  let live = opts.live
  let headroom = Math.max(1, opts.headroom)

  let roster: AgentInfo[] = [...getAgentRegistry()]
  const installedIds = (): Set<string> =>
    new Set(roster.filter((a) => a.installed).map((a) => a.id))

  let added = Math.min(Math.max(last?.providers.length ?? 1, 1), headroom)
  let slots: SlotId[] = restoreLineup(last?.providers ?? [], installedIds(), added)
  let brush: SlotId = null
  let customCmd = ''
  let profilesCache: AgentProfile[] = []
  let isolate = last?.isolate ?? false
  let isolateProbe: IsolationProbe = { kind: opts.cwd ? 'pending' : 'no-folder' }
  let open = true

  /** The painted grid. Its first `live.length` regions are the existing terminals. */
  let spec: GridSpecModel = specForCount(live.length + added, TEMPLATES[live.length + added])

  // ── The palette (shared with the wizard) ──────────────────────────────────
  const palette = createPlacementPalette({
    slots: () => slots,
    count: () => added,
    brush: () => brush,
    roster: () => roster,
    profiles: () => profilesCache,
    customCmd: () => customCmd,
    onSlots: (next) => {
      slots = next
      render()
    },
    onBrush: (next) => {
      brush = next
      render()
    },
    onCustomCmd: (text) => {
      customCmd = text
      if (!customCmd.trim() && brush === 'custom') brush = null
      render()
    }
  })

  // ── The painter ───────────────────────────────────────────────────────────
  /** Painter tile index → the added-slot index it stands for. Negative for a locked tile. */
  const slotOfTile = (tile: number): number => tile - live.length

  /** The logo id for a live pane's provider, or null for "no badge, just a shell dot". */
  const markFor = (provider: string): string | null => {
    if (!provider || provider === 'shell') return null
    if (provider.startsWith('custom:')) return 'custom:'
    return roster.some((a) => a.id === provider) ? provider : null
  }

  const painter: GridPainterHandle = createGridPainter({
    value: spec,
    maxRows: Math.min(opts.maxRows, 8),
    maxCols: Math.min(opts.maxCols, 12),
    // Thunks, not numbers: both move when the workspace does.
    maxPanes: () => live.length + headroom,
    lockedCount: () => live.length,
    onChange: (next) => {
      spec = next
      // The count follows the canvas: merging two tiles into one is a way of asking for
      // one fewer new terminal, and the stepper must not then disagree with what is drawn.
      added = Math.max(0, spec.regions.length - live.length)
      slots = normalizeSlots(slots, added, customCmd)
      render()
    },
    brush: () => brush,
    onPaint: (tile) => {
      const i = slotOfTile(tile)
      if (i < 0 || !brush) return
      slots = paintSlot(slots, i, brush)
      render()
    },
    onPickSlot: (tile, anchor) => {
      const i = slotOfTile(tile)
      if (i < 0) return
      palette.openPicker(i, anchor, slots[i] ?? null)
    },
    slotChip: (tile) => {
      const i = slotOfTile(tile)
      if (i < 0) {
        const pane = live[tile]!
        // Only a provider we RECOGNISE earns a mark. A live pane's provider comes off the
        // manifest or a detected session, and anything else there (a stale row, a bare
        // shell that set its own OSC title) would otherwise be drawn with the fallback
        // glyph — a plain shell wearing an agent's badge.
        const id = markFor(pane.provider)
        return {
          color: id ? providerAccent(id) : '',
          mark: id ? providerLogo(id, 14) : null,
          label: pane.label
        }
      }
      const id = slots[i] ?? null
      const logoId = id === 'custom' ? 'custom:' : id
      return {
        color: logoId ? providerAccent(logoId) : '',
        mark: logoId ? providerLogo(logoId, 14) : null,
        label: palette.nameFor(id)
      }
    }
  })

  // ── Summary column (the wizard's, verbatim) ───────────────────────────────
  const countStepper: StepperHandle = createStepper({
    value: added,
    min: 0,
    max: headroom,
    ariaLabel: 'How many new terminals',
    onChange: (n) => {
      added = n
      // A count change re-seeds the SHAPE — the canonical grid for the new total. Merges
      // are a refinement of a size, so changing the size honestly starts over.
      spec = specForCount(live.length + added, TEMPLATES[live.length + added])
      slots = normalizeSlots(slots, added, customCmd)
      painter.set(spec)
      render()
    }
  })
  const summaryCount = el('span', { class: 'wizard-summary-count' })
  const summaryLine = el('span', { class: 'wizard-summary-line' })
  const summaryShape = el('span', { class: 'wizard-summary-line' })
  const capacityHint = el('span', { class: 'wizard-hint' })
  // The painter's truth line for screen readers (and the gates): visually hidden, but it
  // is the only place the arrangement is stated in words rather than drawn.
  const readout = el('span', { class: 'wizard-layout-readout', role: 'status' })
  /** Says what happened when the workspace changed under the dialog. STICKY for the life
   *  of the dialog: someone looking at the palette when the canvas redrew has to be able
   *  to find out afterwards why their merges are gone. */
  const reseedNote = el('p', { class: 'ntm-reseed', role: 'status', hidden: true })
  const resetBtn = Button({
    label: 'Reset grid',
    size: 'sm',
    variant: 'ghost',
    title: 'Back to the canonical grid for this many terminals',
    onClick: () => {
      spec = specForCount(live.length + added, TEMPLATES[live.length + added])
      painter.set(spec)
      render()
    }
  })
  const summary = el('div', { class: 'wizard-layout-summary' }, [
    summaryCount,
    summaryLine,
    summaryShape,
    capacityHint,
    resetBtn
  ])

  // ── Isolation ─────────────────────────────────────────────────────────────
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

  // ── Shell ─────────────────────────────────────────────────────────────────
  const createBtn = Button({
    label: 'Open terminal',
    variant: 'primary',
    onClick: () => {
      const assignments = expandAssignments(slots, added, customCmd)
      const entries: NewTerminalEntry[] = assignments.map((provider) => ({
        provider,
        profileId:
          provider !== 'shell' && !provider.startsWith('custom:') ? palette.profileFor(provider) : undefined
      }))
      // The isolate WANT persists even when this folder refused it (wizard rule: the
      // user's intent is not evidence about the filesystem) — but the CREATE honors
      // only what the preflight allowed, or the split would fail where the toggle lied.
      const view = isolationView({ probe: isolateProbe, want: isolate })
      writeLast({ providers: assignments.map((p) => (p.startsWith('custom:') ? 'shell' : p)), isolate })
      modal.close()
      opts.onCreate({ spec, liveIds: live.map((tile) => tile.paneId), entries, isolate: view.enabled && view.checked })
    }
  })

  const modal = createModal({
    title: 'New terminals',
    subtitle: 'Paint where they go. The terminals you already have keep their panes.',
    variant: 'dialog',
    // Wide enough for the lattice, the canvas and the summary to stand in one row — the
    // wizard's layout section, which was designed against a 1040px page.
    width: 940,
    onClose: () => {
      open = false
      unsubRoster()
      unsubLive()
      palette.dispose()
    }
  })

  /** The wizard's section: an uppercase label over a hairline, an optional hint, and a
   *  right-hand control slot. The rhythm is the whole reason this reads as one family. */
  const section = (label: string, hint: string | null, right: HTMLElement | null, children: (Node | null)[]) =>
    el('section', { class: 'wizard-sec' }, [
      el('div', { class: 'wizard-sec-head' }, [
        el('span', { class: 'wizard-sec-label', text: label }),
        hint ? el('span', { class: 'wizard-sec-hint', text: hint }) : null,
        right ? el('span', { class: 'wizard-sec-right' }, [right]) : null
      ]),
      ...children
    ])

  modal.setBody(
    el('div', { class: 'ntm-body' }, [
      section('Grid', null, countStepper.el, [
        el('div', { class: 'wizard-layout-row' }, [painter.el, summary]),
        reseedNote,
        readout
      ]),
      section('Agents', null, null, [palette.el, palette.hintEl, palette.customRow, palette.setupEl, palette.profilesEl]),
      section('Options', null, null, [el('div', { class: 'wizard-option-row' }, [isolateBox.el, isolateHint, isolateFix])])
    ])
  )
  modal.setFooter(
    el('div', { class: 'confirm-actions' }, [
      Button({ label: 'Cancel', variant: 'ghost', onClick: () => modal.close() }),
      createBtn
    ])
  )

  // ── Renders ───────────────────────────────────────────────────────────────
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
    slots = normalizeSlots(slots, added, customCmd)
    countStepper.setValue(added)
    painter.refreshChips()
    palette.render()

    const total = live.length + added
    const merged = spec.regions.some((r) => r.rs > 1 || r.cs > 1)
    summaryCount.textContent = String(added)
    summaryLine.textContent = `${plural(added, 'new terminal')} · ${live.length} already open`
    summaryShape.textContent = `${total} in all · ${merged ? 'custom' : `${spec.rows}×${spec.cols}`}`
    capacityHint.textContent =
      headroom - added > 0 ? `Room for ${headroom - added} more on this grid.` : 'This grid is full.'
    readout.textContent = `${plural(total)} · ${merged ? 'custom arrangement' : `${spec.rows} by ${spec.cols}`}`

    // Merging every added tile away leaves a pure rearrange — still worth applying, and
    // the button must not promise terminals it will not open.
    const label = added === 0 ? 'Apply layout' : `Open ${added === 1 ? 'terminal' : `${added} terminals`}`
    const span = createBtn.querySelector('span')
    if (span) span.textContent = label
    createBtn.setAttribute('aria-label', label)
  }

  /**
   * The workspace changed under the dialog. Two tiers, because a reorder and a set change
   * invalidate different things:
   *
   *   same ids, new order (a drag-rearrange) — every locked tile now stands for a
   *     different terminal, so the LABELS must be re-aimed; nothing the user painted is
   *     invalidated, so every merge is kept.
   *   the set moved — `slotOfTile` is keyed on live.length, so the canvas and the tiles it
   *     stands for have to be re-seeded IN THE SAME BREATH. A spec with fewer regions than
   *     live.length would read as all-locked and quietly drop open terminals off the grid.
   */
  const onLive = (next: LiveWorkspaceShape): void => {
    if (!open) return
    const before = live
    live = next.live
    headroom = Math.max(0, next.headroom)
    countStepper.setMax(headroom)
    const beforeIds = before.map((tile) => tile.paneId).join(',')
    const afterIds = live.map((tile) => tile.paneId).join(',')
    const overHeadroom = added > headroom
    if (beforeIds === afterIds) {
      // A pure re-publish, or panes opened in ANOTHER workspace: the set here is
      // unchanged, so the canvas is still true — but the ceiling may have tightened
      // under it, and a count the grid can no longer hold must not stay on screen.
      if (!overHeadroom) return
      added = headroom
      spec = specForCount(live.length + added, TEMPLATES[live.length + added])
      slots = normalizeSlots(slots, added, customCmd)
      painter.set(spec)
      reseedNote.hidden = false
      reseedNote.textContent = `Terminals opened elsewhere, so this workspace has less room. The grid was redrawn.`
      render()
      return
    }
    if (before.length === live.length && !overHeadroom) {
      painter.refreshChips()
      render()
      return
    }
    const grew = live.length > before.length
    const hadMerges = spec.regions.some((r) => r.rs > 1 || r.cs > 1)
    added = Math.min(added, headroom)
    spec = specForCount(live.length + added, TEMPLATES[live.length + added])
    slots = normalizeSlots(slots, added, customCmd)
    painter.set(spec)
    reseedNote.hidden = false
    reseedNote.textContent = `A terminal ${grew ? 'opened' : 'closed'} in this workspace. The grid was redrawn${
      hadMerges ? ', so your merges were reset' : `, and now starts from ${live.length} open`
    }.`
    render()
  }

  const unsubRoster = onAgentRegistryChange((next) => {
    if (!open) return
    roster = [...next]
    const installed = installedIds()
    slots = pruneToRoster(slots, installed)
    brush = pruneBrush(brush, installed)
    palette.renderRoster()
    render()
  })

  void refreshAgentRegistry()
  void (getBridge().invoke(ProfileChannels.list) as Promise<AgentProfile[]>)
    .then((profiles) => {
      if (!open) return
      profilesCache = profiles ?? []
      palette.render()
    })
    .catch(() => undefined)

  palette.renderRoster()
  render()
  syncIsolate()
  probeIsolation()
  // Subscribed last: the port replays immediately and `onLive` touches the painter and the
  // stepper, both of which must exist. The replay lands as a no-op (same ids).
  const unsubLive = opts.subscribeLive?.(onLive) ?? ((): void => {})
  modal.open()
}
