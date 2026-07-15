import { Button, createModal, el, icon } from '../../components'
import { MAX_PANES } from '../layout'

/** One offer in the picker: a workspace this pane could move to. The workspace it is
 *  already in is never among them — "move it where it is" is not a choice. */
export interface MoveTarget {
  id: string
  name: string
  color: string
  cwd: string
  paneCount: number
  /** At MAX_PANES: offered but not selectable, and it says why. Hiding it would leave the
   *  user hunting for a workspace that is right there in the rail. */
  full: boolean
}

export interface MovePaneModalOpts {
  /** What the pane calls itself — its label, or its agent, or "Terminal 3". */
  paneTitle: string
  targets: MoveTarget[]
  onConfirm: (workspaceId: string) => void
}

/** The folder a workspace is rooted in, shortened from the LEFT: the tail is what
 *  distinguishes two projects, and the head is the part that is the same for all of them. */
function shortPath(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : parts.join('/')
}

/**
 * "Move to another workspace…" — pick the destination, confirm, done.
 *
 * A radiogroup, not a list of buttons: the choice is exclusive and reversible right up to
 * the confirm, and one Enter after arrowing to a workspace must not move a live agent
 * somewhere it was never meant to go.
 */
export function openMovePaneModal(opts: MovePaneModalOpts): void {
  let selected: string | null = null

  const list = el('div', {
    class: 'ws-move-list',
    role: 'radiogroup',
    ariaLabel: 'Destination workspace'
  })

  const pick = (row: HTMLButtonElement, id: string): void => {
    selected = id
    for (const other of rows) {
      const on = other === row
      other.classList.toggle('is-selected', on)
      other.setAttribute('aria-checked', String(on))
      // Roving tabindex (APG): a radiogroup is ONE tab stop, and Tab lands on the chosen
      // option — not on a walk through every workspace you did not pick.
      other.tabIndex = on ? 0 : -1
    }
    confirm.disabled = false
  }

  const rows = opts.targets.map((target) => {
    const row = el(
      'button',
      {
        class: 'ws-move-row',
        type: 'button',
        role: 'radio',
        disabled: target.full,
        tabIndex: -1,
        attrs: {
          'aria-checked': 'false',
          'data-ws-id': target.id,
          title: target.full ? `“${target.name}” already holds ${MAX_PANES} terminals` : target.cwd
        }
      },
      [
        el('span', { class: 'ws-move-dot', style: { background: target.color } }),
        el('span', { class: 'ws-move-copy' }, [
          el('span', { class: 'ws-move-name', text: target.name }),
          el('span', {
            class: 'ws-move-meta',
            text: target.full
              ? `Full — ${MAX_PANES} terminals`
              : [
                  `${target.paneCount} terminal${target.paneCount === 1 ? '' : 's'}`,
                  shortPath(target.cwd)
                ]
                  .filter(Boolean)
                  .join(' · ')
          })
        ]),
        el('span', { class: 'ws-move-check' }, [icon('check', 14)])
      ]
    )
    row.addEventListener('click', () => {
      if (target.full) return
      pick(row, target.id)
    })
    list.append(row)
    return row
  })

  /** The rows a keyboard may actually land on. A full workspace is shown (so you can see it
   *  is there, and why it is not an option) but it is not one — arrowing skips it. */
  const selectable = rows.filter((row) => !row.disabled)
  // The FIRST option is the tab stop until one is chosen; without it the group is unreachable
  // by keyboard at all (every row starts at tabindex -1, which is the point of roving).
  if (selectable[0]) selectable[0].tabIndex = 0

  list.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0
    if (!step && e.key !== 'Home' && e.key !== 'End') return
    if (!selectable.length) return
    e.preventDefault()
    const at = selectable.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      e.key === 'Home'
        ? selectable[0]!
        : e.key === 'End'
          ? selectable[selectable.length - 1]!
          : selectable[(Math.max(0, at) + step + selectable.length) % selectable.length]!
    // Select-on-focus, as a radiogroup does: arrowing IS choosing. It commits nothing —
    // the Move button is still a separate, deliberate press.
    next.focus()
    pick(next, next.dataset.wsId ?? '')
  })

  const modal = createModal({
    title: 'Move to another workspace',
    subtitle: `“${opts.paneTitle}” keeps running — its agent, scrollback and working directory move with it.`,
    width: 460
  })
  modal.setBody(list)

  const confirm = Button({
    label: 'Move terminal',
    variant: 'primary',
    disabled: true,
    onClick: () => {
      if (!selected) return
      const id = selected
      modal.close()
      opts.onConfirm(id)
    }
  })
  const footer = el('div', { class: 'confirm-actions' }, [
    Button({ label: 'Cancel', variant: 'ghost', onClick: () => modal.close() }),
    confirm
  ])
  modal.setFooter(footer)
  modal.open()
}
