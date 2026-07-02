import type { UiFeature } from '../../core/registry/feature-registry'
import { TerminalChannels, type StateEvent } from '@contracts'
import { showToast } from '../../components'
import { getBridge } from '../../core/ipc/bridge'
import { getPaneLabel } from '../../core/layout/pane-meta'
import { activeView } from '../../core/shell/view-port'
import {
  getWorkspaces,
  requestWorkspaceSwitch
} from '../../core/workspace/workspace-info-port'
import { getTelemetry } from '../../core/telemetry'

const COOLDOWN_MS = 20000

/**
 * Toasts for `mogging notify` / OSC attention events: when a pane in a BACKGROUND
 * workspace (or behind Home) flips to attention, show a toast with a one-click "Go".
 * Event-driven off the existing terminal:state relay — never polled — and throttled
 * per pane so a chatty agent can't flood the stack.
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
      if (e.state !== 'attention') return

      const { workspaces, activeId } = getWorkspaces()
      const ws = workspaces.find((w) => Math.floor(e.id / 100) === w.ordinal)
      // Visible already? The pane's own chip + ring carry it — no toast needed.
      if (ws && ws.id === activeId && activeView() === 'grid') return

      const now = Date.now()
      if (now - (lastToast.get(e.id) ?? 0) < COOLDOWN_MS) return
      lastToast.set(e.id, now)
      if (lastToast.size > 64) {
        for (const [id, t] of lastToast) if (now - t > COOLDOWN_MS) lastToast.delete(id)
      }

      const label = getPaneLabel(e.id) || `Terminal ${e.id % 100 || e.id}`
      getTelemetry().captureEvent({ name: 'attention.toast_shown' })
      showToast({
        tone: 'attention',
        title: `${label} needs your input`,
        body: ws ? `in “${ws.name}”` : undefined,
        action: ws
          ? {
              label: 'Go',
              onClick: () => {
                getTelemetry().captureEvent({ name: 'attention.toast_go' })
                requestWorkspaceSwitch(ws.id)
              }
            }
          : undefined
      })
    })
  }
}
