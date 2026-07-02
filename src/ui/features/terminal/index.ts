import type { PaneId } from '@contracts'
import type { UiFeature } from '../../core/registry/feature-registry'
import { onSlots } from '../../core/layout/slots'
import { TerminalPane } from './terminal-pane'
import { initClaims } from './claims-store'

export { TerminalPane } from './terminal-pane'
export { terminalClient } from './terminal.client'

/**
 * Mounts a `TerminalPane` into each layout slot and keeps them reconciled as the layout
 * changes (new slot -> mount a pane; removed slot -> dispose it). Subscribes to the ui-core
 * slots port — it does NOT import the `layout` feature (decoupled via the port + `@contracts`).
 * Each pane's data routes by id, so N panes stream concurrently with no cross-talk.
 */
export const terminalFeature: UiFeature = {
  name: 'terminal',
  mount() {
    initClaims() // ownership-ledger mirror (4/02): push-fed, read by pane chips
    const panes = new Map<PaneId, TerminalPane>()
    onSlots((slots) => {
      const wanted = new Set<PaneId>(slots.map((s) => s.id))
      for (const [id, pane] of panes) {
        if (!wanted.has(id)) {
          pane.dispose()
          panes.delete(id)
        }
      }
      for (const slot of slots) {
        if (!panes.has(slot.id)) panes.set(slot.id, new TerminalPane(slot.id, slot.el))
      }
    })
  }
}
