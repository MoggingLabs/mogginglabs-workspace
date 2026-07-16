import {
  BOARD_LANES,
  BoardChannels,
  UNFILED_PROJECT_KEY,
  type Board,
  type BoardGhResult,
  type BoardMetaPatch
} from '@contracts'
import { getBridge } from '../../core/ipc/bridge'
import { Button, confirmDialog, createModal, el, showToast } from '../../components'
import { LANE_LABELS } from './card'
import type { BoardModel } from './model'

/**
 * The per-board settings sheet: identity (name), flow practice knobs (WIP
 * limits, aging cue, done auto-archive), the GitHub binding (ADR 0015), and
 * the queue (Phase-9′'s pull model). The TWO risky switches — GitHub
 * write-back and the queue — are default OFF and flip only through an explicit
 * risk-confirm: the user must see what they are opting into (quota spend,
 * unattended mutations) before either turns on.
 */

export function openBoardSettings(
  model: BoardModel,
  roster: { id: string; name: string; installed: boolean }[]
): void {
  const bridge = getBridge()
  const board = model.state.board
  if (!board) return
  const patchBoard = async (patch: BoardMetaPatch): Promise<Board | null> => {
    const next = (await bridge.invoke(BoardChannels.boardPatch, { id: board.id, patch })) as Board | null
    if (next) {
      model.state.board = next
      await model.reload()
    }
    return next
  }

  const modal = createModal({ title: 'Board settings', width: 560 })
  const body = el('div', { class: 'board-settings' })

  // ── identity ───────────────────────────────────────────────────────────────
  const name = el('input', {
    class: 'board-edit-title',
    attrs: { type: 'text', value: board.name, 'aria-label': 'Board name' }
  }) as HTMLInputElement
  name.addEventListener('keydown', (e) => e.stopPropagation())
  body.append(
    el('div', { class: 'board-settings-section' }, [
      el('h5', { class: 'board-settings-title', text: 'Board' }),
      name,
      el('div', {
        class: 'settings-row-caption',
        text:
          board.projectKey === UNFILED_PROJECT_KEY
            ? 'Unfiled: cards that predate boards or whose workspace is gone.'
            : `Project: ${board.projectKey}`
      })
    ])
  )

  // ── flow knobs ─────────────────────────────────────────────────────────────
  const wipInputs = new Map<string, HTMLInputElement>()
  const wipRow = el('div', { class: 'board-settings-wip' })
  for (const lane of BOARD_LANES) {
    const input = el('input', {
      class: 'board-settings-num',
      attrs: {
        type: 'number',
        min: '0',
        max: '99',
        value: String(board.config.wip[lane] ?? 0),
        'aria-label': `WIP limit for ${LANE_LABELS[lane]} (0 = none)`
      }
    }) as HTMLInputElement
    wipInputs.set(lane, input)
    wipRow.append(el('label', { class: 'board-settings-wip-lane' }, [el('span', { text: LANE_LABELS[lane] }), input]))
  }
  const aging = el('input', {
    class: 'board-settings-num',
    attrs: { type: 'number', min: '0', max: '60', value: String(board.config.agingDays), 'aria-label': 'Aging cue after days (0 = off)' }
  }) as HTMLInputElement
  const autoArchive = el('input', {
    class: 'board-settings-num',
    attrs: {
      type: 'number',
      min: '0',
      max: '365',
      value: String(board.config.autoArchiveDays),
      'aria-label': 'Auto-archive Done cards after days (0 = off)'
    }
  }) as HTMLInputElement
  body.append(
    el('div', { class: 'board-settings-section' }, [
      el('h5', { class: 'board-settings-title', text: 'Flow' }),
      el('div', { class: 'settings-row-caption', text: 'WIP limits per lane (0 = no limit). The lane head turns amber when over.' }),
      wipRow,
      el('div', { class: 'board-settings-row' }, [
        el('span', { class: 'board-settings-label', text: 'Aging cue after (days)' }),
        aging
      ]),
      el('div', { class: 'board-settings-row' }, [
        el('span', { class: 'board-settings-label', text: 'Auto-archive Done after (days)' }),
        autoArchive
      ])
    ])
  )

  // ── GitHub (ADR 0015) ──────────────────────────────────────────────────────
  const ghStatus = el('div', { class: 'settings-row-caption' })
  const renderGhStatus = (b: Board): void => {
    ghStatus.textContent = b.repoRef
      ? `Bound to ${b.repoRef} — reads ride your own gh.`
      : 'Not bound. Detect reads this project’s origin remote.'
  }
  renderGhStatus(board)
  const detectBtn = Button({
    label: 'Detect repo',
    onClick: async () => {
      const r = (await bridge.invoke(BoardChannels.ghDetect, board.id)) as BoardGhResult
      if (r.ok && r.repoRef) {
        const next = model.state.board
        if (next) renderGhStatus(next)
        showToast({ tone: 'info', title: `Bound to ${r.repoRef}` })
        await model.reload()
        if (model.state.board) renderGhStatus(model.state.board)
      } else {
        showToast({ tone: 'danger', title: 'No GitHub remote found', body: r.ok ? undefined : r.reason })
      }
    }
  })
  const importBtn = Button({
    label: 'Import open issues…',
    onClick: async () => {
      const r = (await bridge.invoke(BoardChannels.ghImport, { boardId: board.id })) as BoardGhResult
      if (r.ok) {
        showToast({ tone: 'info', title: `Imported ${r.created ?? 0} issue${(r.created ?? 0) === 1 ? '' : 's'}`, body: 'New cards landed in Backlog, linked live.' })
        await model.reload()
      } else {
        showToast({ tone: 'danger', title: 'Import failed', body: r.reason })
      }
    }
  })
  const ruleToggle = (label: string, key: 'prMergedToDone' | 'issueClosedToDone' | 'autoLinkPr', caption: string): HTMLElement => {
    const input = el('input', { attrs: { type: 'checkbox' } }) as HTMLInputElement
    input.checked = model.state.board?.config.rules[key] ?? false
    input.addEventListener('change', () => {
      void patchBoard({ config: { rules: { ...model.state.board!.config.rules, [key]: input.checked } } })
    })
    return el('label', { class: 'board-settings-toggle' }, [
      input,
      el('span', { text: label }),
      el('span', { class: 'settings-row-caption', text: caption })
    ])
  }
  const writeBack = el('input', { attrs: { type: 'checkbox' } }) as HTMLInputElement
  writeBack.checked = board.config.github.writeBack
  writeBack.addEventListener('change', () => {
    if (!writeBack.checked) {
      void patchBoard({ config: { github: { writeBack: false } } })
      return
    }
    writeBack.checked = false // not on until the human has read the risk
    void confirmDialog({
      title: 'Let this board write to GitHub?',
      message:
        'Write-back lets board actions CREATE and CLOSE issues on the bound repository, through your own gh login — visible to everyone who watches that repo. ' +
        'Reads never need this. It applies to this board only, and you can turn it off here at any time.',
      confirmLabel: 'Enable write-back',
      danger: true
    }).then((ok) => {
      if (!ok) return
      writeBack.checked = true
      void patchBoard({ config: { github: { writeBack: true } } })
    })
  })
  body.append(
    el('div', { class: 'board-settings-section' }, [
      el('h5', { class: 'board-settings-title', text: 'GitHub' }),
      ghStatus,
      el('div', { class: 'board-settings-actions' }, [detectBtn, importBtn]),
      ruleToggle('PR merged → Done', 'prMergedToDone', 'A linked PR merging moves its card to Done.'),
      ruleToggle('Issue closed → Done', 'issueClosedToDone', 'A linked issue closing moves its card to Done.'),
      ruleToggle('Auto-link PRs', 'autoLinkPr', 'A card entering Review looks up the PR for its branch and links it.'),
      el('label', { class: 'board-settings-toggle' }, [
        writeBack,
        el('span', { text: 'Write-back (create/close issues)' }),
        el('span', { class: 'settings-row-caption', text: 'Default off. Mutations, via your own gh, behind an explicit confirm.' })
      ])
    ])
  )

  // ── the queue (default OFF; the risk is quota) ─────────────────────────────
  const queue = board.config.queue
  const queueToggle = el('input', { attrs: { type: 'checkbox', id: 'board-queue-enabled' } }) as HTMLInputElement
  queueToggle.checked = queue.enabled
  const provider = el('select', { class: 'board-settings-select', attrs: { 'aria-label': 'Queue provider' } }) as HTMLSelectElement
  for (const a of roster.filter((r) => r.installed)) {
    const opt = el('option', { attrs: { value: a.id }, text: a.name }) as HTMLOptionElement
    provider.append(opt)
  }
  // The STORED provider wins until the user changes it — even when the roster
  // doesn't list it (an uninstalled-since CLI, a scripted config). Without
  // this, merely OPENING the sheet re-pointed the queue at the first option.
  if (queue.provider && ![...provider.options].some((o) => o.value === queue.provider)) {
    provider.prepend(el('option', { attrs: { value: queue.provider }, text: queue.provider }) as HTMLOptionElement)
  }
  if (queue.provider) provider.value = queue.provider
  const maxConcurrent = el('input', {
    class: 'board-settings-num',
    attrs: { type: 'number', min: '1', max: '4', value: String(queue.maxConcurrent), 'aria-label': 'Max concurrent queue agents' }
  }) as HTMLInputElement
  const perHour = el('input', {
    class: 'board-settings-num',
    attrs: { type: 'number', min: '1', max: '20', value: String(queue.launchesPerHour), 'aria-label': 'Max queue launches per hour' }
  }) as HTMLInputElement
  // An empty select (no CLI detected yet) must never WIPE a stored provider.
  const effectiveProvider = (): string => provider.value || model.state.board?.config.queue.provider || ''
  const saveQueueKnobs = (enabled: boolean, ackAt?: number | null): Promise<Board | null> =>
    patchBoard({
      config: {
        queue: {
          ...model.state.board!.config.queue,
          enabled,
          provider: effectiveProvider(),
          maxConcurrent: Number(maxConcurrent.value) || 2,
          launchesPerHour: Number(perHour.value) || 6,
          pausedReason: null,
          ...(ackAt !== undefined ? { ackAt } : {})
        }
      }
    })
  queueToggle.addEventListener('change', () => {
    if (!queueToggle.checked) {
      void saveQueueKnobs(false) // stopping is always one click, no ceremony
      return
    }
    queueToggle.checked = false // OFF until the risk is acknowledged, every time
    if (!effectiveProvider()) {
      showToast({ tone: 'attention', title: 'Pick a provider first', body: 'The queue needs an installed agent CLI to launch.' })
      return
    }
    // Pedro's rule, verbatim: enabling the queue is an OPT-IN to real spend.
    void confirmDialog({
      title: 'Turn the queue on?',
      message:
        `The queue launches ${provider.options[provider.selectedIndex]?.text || effectiveProvider() || 'an agent'} UNATTENDED: whenever a slot frees, the top To-do card starts an agent in its own worktree — and every launch spends your real CLI quota or API credits, whether or not you are at the keyboard. ` +
        `Budgets are enforced (at most ${maxConcurrent.value} at once, ${perHour.value} launches/hour), it pauses itself after two consecutive failed launches, and this switch turns it all off instantly. ` +
        'To-do order becomes the queue order.',
      confirmLabel: 'I understand — enable the queue',
      danger: true
    }).then((ok) => {
      if (!ok) return
      queueToggle.checked = true
      void saveQueueKnobs(true, Date.now())
    })
  })
  body.append(
    el('div', { class: 'board-settings-section' }, [
      el('h5', { class: 'board-settings-title', text: 'Queue' }),
      el('label', { class: 'board-settings-toggle' }, [
        queueToggle,
        el('span', { text: 'Queue mode — the board pulls' }),
        el('span', {
          class: 'settings-row-caption',
          text: 'Default off. Auto-launches the top To-do card when a slot frees. Unattended launches spend real quota — enabling asks you to confirm the risk.'
        })
      ]),
      el('div', { class: 'board-settings-row' }, [el('span', { class: 'board-settings-label', text: 'Provider' }), provider]),
      el('div', { class: 'board-settings-row' }, [
        el('span', { class: 'board-settings-label', text: 'Concurrent agents' }),
        maxConcurrent
      ]),
      el('div', { class: 'board-settings-row' }, [el('span', { class: 'board-settings-label', text: 'Launches per hour' }), perHour])
    ])
  )

  const done = Button({
    label: 'Done',
    variant: 'primary',
    onClick: async () => {
      const wip: Record<string, number> = {}
      for (const [lane, input] of wipInputs) {
        const n = Number(input.value)
        if (Number.isFinite(n) && n > 0) wip[lane] = Math.min(99, Math.floor(n))
      }
      const patch: BoardMetaPatch = {
        config: {
          wip,
          agingDays: Math.max(0, Math.min(60, Number(aging.value) || 0)),
          autoArchiveDays: Math.max(0, Math.min(365, Number(autoArchive.value) || 0)),
          queue: {
            ...model.state.board!.config.queue,
            provider: provider.value || model.state.board!.config.queue.provider,
            maxConcurrent: Number(maxConcurrent.value) || 2,
            launchesPerHour: Number(perHour.value) || 6
          }
        }
      }
      if (name.value.trim() && name.value.trim() !== board.name) patch.name = name.value.trim()
      await patchBoard(patch)
      modal.close()
    }
  })
  modal.setBody(body)
  modal.setFooter(el('div', { class: 'board-edit-footer' }, [Button({ label: 'Cancel', onClick: () => modal.close() }), done]))
  modal.open()
}
