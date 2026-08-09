import { el, icon } from '../../components'
import { requestAgentLaunch } from '../../core/agents/launch-port'
import { getPaneCwd } from '../../core/layout/pane-cwd'
import type { PaneId } from '@contracts'

/**
 * THE DEGRADED-RESTORE BANNER — a pane that came back having lost what it was running, and
 * says so.
 *
 * Restore used to fail OPEN here. A row whose stored launch intent could not be read back
 * restored as a plain `cmd.exe`, indistinguishable from a pane that had only ever been a
 * shell — and the fresh shell's banner painted over the agent's own scrollback on the way in.
 * The user found out when they went looking for a conversation that was no longer there.
 *
 * The store already fails CLOSED for the neighbouring case: a partial remote row refuses to
 * restore rather than run an SSH pane's command in a local shell (session-rows.ts). This is
 * that guard's twin for agent panes — with one deliberate difference. The remote guard DROPS
 * the row, because restoring it wrong is worse than not restoring it. Here the row holds real
 * user scrollback, so dropping it would destroy the very thing worth keeping. The pane comes
 * back, intact and marked.
 *
 * Not a modal, not auto-typed, same as the sign-in banner next door: a pane that relaunches
 * itself before the user has looked at it is worse than one that waits to be asked.
 */

/** Markers on screen, so a pane never grows two. */
const live = new Map<number, HTMLElement>()

/** The pane's slot in the grid. `data-pane-id` is the smoke-asserted selector. */
function slotFor(paneId: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.layout-slot[data-pane-id="${paneId}"]`)
}

export function dismissDegradedBanner(paneId: number): void {
  live.get(paneId)?.remove()
  live.delete(paneId)
}

/**
 * Mark `paneId` as restored-degraded and offer to relaunch `agentId` in it.
 *
 * The relaunch goes through the ordinary launch port, so it takes the same path any other
 * launch does — profile resolution included. That matters: the pane's own profile record is
 * what could not be read, so this launch resolves the profile the normal way and, being a
 * real launch, records a fresh intent. One click repairs the row.
 */
export function markLaunchDegraded(paneId: number, agentId: string): void {
  // Pane ids are RECYCLED (a split takes the lowest free slot). A banner whose pane died with
  // its workspace leaves a DETACHED element behind, which would otherwise swallow the marker
  // for the next, unrelated pane to inherit the id.
  const existing = live.get(paneId)
  if (existing) {
    if (existing.isConnected) return
    live.delete(paneId)
  }
  const slot = slotFor(paneId)
  const body = slot?.querySelector('.pane-body')
  if (!slot || !body) return

  const relaunch = el('button', {
    class: 'pane-signin-action',
    type: 'button',
    text: `Relaunch ${agentId}`,
    title: `Starts ${agentId} in this terminal and records its settings again`
  })
  relaunch.onclick = (): void => {
    requestAgentLaunch({
      paneId: paneId as PaneId,
      provider: agentId,
      cwd: getPaneCwd(paneId as PaneId) ?? '',
      resume: true
    })
    dismissDegradedBanner(paneId)
  }

  const banner = el('div', { class: 'pane-signin pane-degraded' }, [
    icon('alert', 14),
    el('span', {
      class: 'pane-signin-text',
      // Says what it was, what went wrong, and what is still safe — in that order, because
      // "your scrollback is intact" is the first thing a user needs to hear here.
      text: `This pane was running ${agentId}. Its saved launch settings could not be read, so it came back as a shell — the output above is untouched.`
    }),
    relaunch,
    el(
      'button',
      {
        class: 'pane-signin-close',
        type: 'button',
        ariaLabel: 'Dismiss',
        title: 'Leave it as a shell',
        onClick: () => dismissDegradedBanner(paneId)
      },
      [icon('x', 11)]
    )
  ])
  banner.setAttribute('role', 'status')

  // Between the header and the terminal — pane chrome, never floating over the buffer, so it
  // cannot cover the history it is telling the user is still there.
  body.before(banner)
  live.set(paneId, banner)
}
