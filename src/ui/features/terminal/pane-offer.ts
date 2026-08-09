import type { PaneId } from '@contracts'
import { icon } from '../../components'
import { onPaneFailoverOffer, type PaneFailoverOffer } from '../../core/agents/failover-offer-port'

// The profile-switch offer overlay — the pane-drop idiom (blurred radial wash,
// centered card) with one load-bearing difference: this overlay TAKES the pointer.
// pane-drop must stay transparent to drags or it would strobe itself off; this one
// carries buttons, and while it is up the capped agent under it has nothing useful
// to receive anyway. Same extraction seam as pane-drop: one self-contained concern,
// wired to the pane through a tiny surface (id, body element, dispose signal).

export interface PaneOfferOptions {
  paneId: PaneId
  /** The pane body the overlay mounts into. */
  body: HTMLElement
  /** Aborted when the pane is disposed — detaches the port subscription. */
  signal: AbortSignal
  /** Called whenever the pane becomes covered or uncovered. The thing that PAINTS the
   *  cover is the thing that reports it, so the input gate and the pixels can never
   *  disagree — one subscription, one truth. */
  onCoveredChange?: (covered: boolean) => void
}

/** Mount the offer overlay: renders whatever the failover-offer port says about
 *  this pane, replaying the current offer on mount (a pane recreated mid-offer —
 *  workspace switch — paints it again). */
export function mountPaneOffer({ paneId, body, signal, onCoveredChange }: PaneOfferOptions): void {
  const overlay = document.createElement('div')
  overlay.className = 'pane-offer'
  overlay.hidden = true
  const card = document.createElement('div')
  card.className = 'pane-offer-card'
  overlay.append(card)
  body.append(overlay)

  // Same one-source-of-truth show/hide discipline as pane-drop: `visible` decides,
  // `gen` invalidates async work a newer transition supersedes (a show and a hide
  // batched into one frame must not strand the card on screen).
  let visible = false
  let gen = 0

  const show = (): void => {
    if (visible) return
    visible = true
    onCoveredChange?.(true)
    const mine = ++gen
    overlay.hidden = false
    requestAnimationFrame(() => {
      if (gen === mine && visible) overlay.classList.add('is-active')
    })
  }

  const hide = (): void => {
    if (!visible) return
    visible = false
    // Uncover BEFORE the fade-out: the pane is usable the instant the agent says so, and
    // making the human wait out a 200ms animation to type would be its own small lie.
    onCoveredChange?.(false)
    const mine = ++gen
    overlay.classList.remove('is-active')
    const done = (): void => {
      if (gen === mine && !visible) overlay.hidden = true
    }
    overlay.addEventListener('transitionend', done, { once: true })
    setTimeout(done, 220)
  }

  const button = (label: string, kind: 'primary' | 'ghost', run: () => void): HTMLButtonElement => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = `btn btn--sm${kind === 'primary' ? ' btn--primary' : ' btn--ghost'}`
    b.textContent = label
    b.addEventListener('click', run)
    return b
  }

  const render = (offer: PaneFailoverOffer): void => {
    const busy = offer.state === 'switching' || offer.state === 'launching'
    const ring = document.createElement('div')
    ring.className = `pane-offer-ring${busy ? ' is-spin' : ''}${offer.state === 'failed' ? ' is-failed' : ''}`
    ring.append(icon(offer.state === 'failed' ? 'alert' : busy ? 'rotate-cw' : 'circle-user', 22))
    const title = document.createElement('div')
    title.className = 'pane-offer-title'
    title.textContent =
      offer.state === 'switching'
        ? `Switching to ${offer.nextName}…`
        : offer.state === 'launching'
          ? `Starting ${offer.nextName}…`
          : offer.title
    const hint = document.createElement('div')
    hint.className = 'pane-offer-hint'
    hint.textContent =
      offer.state === 'offered'
        ? // The owner may name the window that is spent and when it comes back
          // ("Weekly resets in 2h 14m. …"); the bare sentence is the fallback.
          (offer.message ?? `This session continues under ${offer.nextName} — same pane, same conversation.`)
        : offer.state === 'switching'
          ? 'Interrupting the agent, then resuming this session.'
          : offer.state === 'launching'
            ? // No percentage, no step list: the only thing this screen honestly knows is
              // that the CLI has not said it is ready yet.
              (offer.message ?? 'This pane unlocks the moment the agent is ready for input.')
            : (offer.message ?? 'The agent could not be interrupted.')
    const actions = document.createElement('div')
    actions.className = 'pane-offer-actions'
    if (offer.state === 'offered') {
      if (offer.onAccept) actions.append(button(`Continue on ${offer.nextName}`, 'primary', offer.onAccept))
      if (offer.onDismiss) actions.append(button('Not now', 'ghost', offer.onDismiss))
    } else if (offer.state === 'failed' && offer.onDismiss) {
      actions.append(button('Dismiss', 'ghost', offer.onDismiss))
    }
    card.replaceChildren(ring, title, hint, ...(actions.childElementCount ? [actions] : []))
  }

  const unsub = onPaneFailoverOffer((id, offer) => {
    if (id !== paneId) return
    if (!offer) {
      hide()
      return
    }
    render(offer)
    show()
  })
  signal.addEventListener('abort', () => {
    unsub()
    overlay.remove()
  })
}
