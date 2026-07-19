import type { UiFeature } from '../../core/registry/feature-registry'
import type { AgentState, PaneId } from '@contracts'
import { showToast } from '../../components'
import { onPaneStateTransition } from '../../core/attention/attention-port'
import { getPaneLabel } from '../../core/layout/pane-meta'
import { activeView } from '../../core/shell/view-port'
import {
  getWorkspaces,
  requestWorkspaceSwitch,
  workspaceIdForPane
} from '../../core/workspace/workspace-info-port'
import { getTelemetry } from '../../core/telemetry'

const COOLDOWN_MS = 20000

/**
 * Toasts for agent verdicts: when a pane in a BACKGROUND workspace (or one behind Home/Board/
 * Settings) flips to `attention` or `done`, show a toast with a one-click "Go". Throttled per
 * pane so a chatty agent can't flood the stack.
 *
 * SOURCED FROM THE ATTENTION PORT, not the raw terminal:state relay (ALERTAGREE, 2026-07-18).
 * The relay carries every pane's tracker verdicts — including a plain shell whose `echo -e '\a'`
 * or build-tool OSC 9 chime latches `attention` backend-side — and reading it here meant a toast
 * could announce "needs your input" over a pane whose dot, outline and rail all (correctly) said
 * nothing. The port's transition stream rides the same tracked gate and the same dedup as every
 * other alert surface, so a toast is structurally incapable of naming a pane the pane itself
 * would not corroborate (explicit direction: alerts are the agent story, everywhere or nowhere).
 *
 * A pane whose workspace is not in the published snapshot toasts NOTHING: mid-close panes (the
 * 5-second undo grace) and boot-replay races used to produce a nameless toast with no "Go" —
 * a doorbell for a room that isn't on the map. If the close is undone, the alert state is still
 * on the port and the rail/outline surface it; the toast moment is deliberately spent.
 *
 * `done` toasts too (explicit direction). A completion used to be invisible unless the app was
 * already in front of you: it raised the rail's count and nothing else, so an agent that
 * finished while you were in another workspace told you only if you happened to look. The two
 * tones stay distinct — red still means "come here", green means "this is ready for you".
 */
export const notifyFeature: UiFeature = {
  name: 'notify',
  mount() {
    // Dev/gallery handle: fire a toast of any tone for screenshots.
    if (import.meta.env.DEV) {
      const w = window as unknown as { __mogging?: Record<string, unknown> }
      w.__mogging = w.__mogging ?? {}
      w.__mogging.toast = (tone: string, title = 'Preview toast', body = 'Gallery sample body text.') =>
        showToast({ tone: tone as never, title, body, timeout: 60000 })
    }

    const lastToast = new Map<PaneId, number>()

    onPaneStateTransition((paneId: PaneId, state: AgentState) => {
      if (state !== 'attention' && state !== 'done') return
      const blocked = state === 'attention'

      const { workspaces, activeId } = getWorkspaces()
      // By the workspace that HOLDS the pane, not by its id: a pane that moved keeps its
      // id, so the formula would name the workspace it left — and this pane, sitting right
      // in front of you in the active grid, would toast at you as if it were off-screen.
      const wsId = workspaceIdForPane(paneId)
      const ws = workspaces.find((w) => w.id === wsId)
      // No workspace on the map = no toast (mid-close undo grace, boot-replay races).
      if (!ws) return
      // Visible already? The pane's own outline + dot carry it — no toast needed.
      if (ws.id === activeId && activeView() === 'grid') return

      const now = Date.now()
      if (now - (lastToast.get(paneId) ?? 0) < COOLDOWN_MS) return
      lastToast.set(paneId, now)
      if (lastToast.size > 64) {
        for (const [id, t] of lastToast) if (now - t > COOLDOWN_MS) lastToast.delete(id)
      }

      const label = getPaneLabel(paneId) || `Terminal ${paneId % 100 || paneId}`
      getTelemetry().captureEvent({ name: blocked ? 'attention.toast_shown' : 'finished.toast_shown' })
      showToast({
        tone: blocked ? 'attention' : 'success',
        title: blocked ? `${label} needs your input` : `${label} finished working`,
        body: `in “${ws.name}”`,
        action: {
          label: 'Go',
          onClick: () => {
            getTelemetry().captureEvent({ name: blocked ? 'attention.toast_go' : 'finished.toast_go' })
            requestWorkspaceSwitch(ws.id)
          }
        }
      })
    })
  }
}
