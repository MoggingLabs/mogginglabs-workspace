import type { AgentSignInTarget } from '@contracts'
import { el, icon } from '../../components'
import { agentsClient } from './agents.client'
import { getTelemetry } from '../../core/telemetry'

/**
 * THE SIGN-IN BANNER — the last step of getting started, in the only place it can happen.
 *
 * Install and sign-in are two different moments and conflating them is what made the old
 * first run confusing. A CLI cannot be logged in during setup: its login is an interactive
 * browser hand-off that has to happen somewhere the user can SEE it, and that somewhere is
 * a terminal, which does not exist until the workspace opens. So setup installs, the
 * workspace opens, and then — only for a pane whose CLI we have CHECKED is signed out —
 * this offers the provider's own login command as one click.
 *
 * ADR 0002 is untouched and this is the surface where that matters most: the app types a
 * published command into a terminal the user is watching. It does not open the browser,
 * receive the callback, read the token, or store anything. The CLI authenticates the user's
 * own account, exactly as it would if they had typed the same eleven characters themselves.
 *
 * It is deliberately NOT a modal and NOT auto-typed: a pane that hijacks itself before the
 * user has looked at it is worse than one that waits to be asked.
 */

/** Sign-in offers currently on screen, so a pane never grows two. */
const live = new Map<number, HTMLElement>()

/** The pane's slot in the grid. `data-pane-id` is the smoke-asserted selector
 *  (grid-layout.ts), which makes it the one stable handle onto a pane's DOM. */
function slotFor(paneId: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.layout-slot[data-pane-id="${paneId}"]`)
}

export function dismissSignInBanner(paneId: number): void {
  live.get(paneId)?.remove()
  live.delete(paneId)
}

/**
 * Offer sign-in in `paneId`. A no-op when the pane is gone, already carrying an offer, or
 * when the provider has no login verb at all (aider authenticates by API key — inventing a
 * command for it would be worse than saying nothing).
 *
 * `agentRunning` picks WHICH command: a CLI already at its own prompt takes its slash verb;
 * a bare shell takes the standalone one. Getting this backwards types `/login` at a shell,
 * which is just an error message with extra steps.
 */
export function offerSignIn(paneId: number, target: AgentSignInTarget, agentRunning: boolean): void {
  // Pane ids are RECYCLED (a split takes the lowest free slot), and a banner whose pane
  // died with its workspace leaves a DETACHED element in the registry — which would
  // silently swallow the offer for the next, unrelated pane that inherits the id. A
  // stale entry is vacated, never obeyed.
  const existing = live.get(paneId)
  if (existing) {
    if (existing.isConnected) return
    live.delete(paneId)
  }
  const command = (agentRunning ? target.inSession : target.shell) ?? target.shell ?? target.inSession
  if (!command) return
  const slot = slotFor(paneId)
  const body = slot?.querySelector('.pane-body')
  if (!slot || !body) return

  const signIn = el('button', {
    class: 'pane-signin-action',
    type: 'button',
    text: 'Sign in',
    title: `Runs ${command} in this terminal`
  })
  signIn.onclick = (): void => {
    // The whole transaction: type the provider's own command. What happens next is between
    // the user and their provider.
    agentsClient.launchInto(paneId, command)
    getTelemetry().captureEvent({ name: 'agent.signin.offered_used', props: { provider: target.agentId } })
    dismissSignInBanner(paneId)
  }

  const banner = el('div', { class: 'pane-signin' }, [
    icon('circle-user', 14),
    el('span', { class: 'pane-signin-text', text: `${target.name} isn’t signed in yet.` }),
    el('code', { class: 'pane-signin-cmd', text: command }),
    signIn,
    el(
      'button',
      {
        class: 'pane-signin-close',
        type: 'button',
        ariaLabel: 'Dismiss',
        title: 'Not now',
        onClick: () => dismissSignInBanner(paneId)
      },
      [icon('x', 11)]
    )
  ])
  banner.setAttribute('role', 'status')

  // Between the header and the terminal: part of the pane's chrome, never floating over
  // the buffer, so it can never cover the output the user is trying to read.
  body.before(banner)
  live.set(paneId, banner)
  getTelemetry().captureEvent({ name: 'agent.signin.offered', props: { provider: target.agentId } })
}
