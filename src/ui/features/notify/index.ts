import type { UiFeature } from '../../core/registry/feature-registry'
import { TerminalChannels, type StateEvent } from '@contracts'
import { showToast } from '../../components'
import { getBridge } from '../../core/ipc/bridge'
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
 * Toasts for `mogging notify` / agent-hook verdicts: when a pane in a BACKGROUND workspace (or
 * one behind Home/Board/Settings) flips to `attention` or `done`, show a toast with a one-click
 * "Go". Event-driven off the existing terminal:state relay — never polled — and throttled per
 * pane so a chatty agent can't flood the stack.
 *
 * `done` toasts too, now (explicit direction). A completion used to be invisible unless the app
 * was already in front of you: it raised the rail's count and nothing else, so an agent that
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

    const lastToast = new Map<number, number>()

    getBridge().on(TerminalChannels.state, (payload) => {
      const e = payload as StateEvent
      if (e.state !== 'attention' && e.state !== 'done') return
      const blocked = e.state === 'attention'

      const { workspaces, activeId } = getWorkspaces()
      // By the workspace that HOLDS the pane, not by its id: a pane that moved keeps its
      // id, so the formula would name the workspace it left — and this pane, sitting right
      // in front of you in the active grid, would toast at you as if it were off-screen.
      const wsId = workspaceIdForPane(e.id)
      const ws = workspaces.find((w) => w.id === wsId)
      // Visible already? The pane's own outline + dot carry it — no toast needed.
      if (ws && ws.id === activeId && activeView() === 'grid') return

      const now = Date.now()
      if (now - (lastToast.get(e.id) ?? 0) < COOLDOWN_MS) return
      lastToast.set(e.id, now)
      if (lastToast.size > 64) {
        for (const [id, t] of lastToast) if (now - t > COOLDOWN_MS) lastToast.delete(id)
      }

      const label = getPaneLabel(e.id) || `Terminal ${e.id % 100 || e.id}`
      getTelemetry().captureEvent({ name: blocked ? 'attention.toast_shown' : 'finished.toast_shown' })
      showToast({
        tone: blocked ? 'attention' : 'success',
        title: blocked ? `${label} needs your input` : `${label} finished working`,
        body: ws ? `in “${ws.name}”` : undefined,
        action: ws
          ? {
              label: 'Go',
              onClick: () => {
                getTelemetry().captureEvent({ name: blocked ? 'attention.toast_go' : 'finished.toast_go' })
                requestWorkspaceSwitch(ws.id)
              }
            }
          : undefined
      })
    })
  }
}
