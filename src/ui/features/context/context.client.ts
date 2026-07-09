import { ContextChannels, type ContextUsageEvent, type ContextWatchRequest, type PaneId } from '@contracts'
import { getBridge } from '../../core/ipc/bridge'

/**
 * Typed client for the per-pane context-usage feature. `watch`/`unwatch` start/stop
 * session-log tracking for a pane; `onChange` streams usage updates. The only place
 * in the UI that knows the context channel names.
 */
export const contextClient = {
  watch: (req: ContextWatchRequest): void => getBridge().send(ContextChannels.watch, req),
  unwatch: (paneId: PaneId): void => getBridge().send(ContextChannels.unwatch, { paneId }),
  onChange: (cb: (e: ContextUsageEvent) => void): void =>
    getBridge().on(ContextChannels.change, (p) => cb(p as ContextUsageEvent))
}
