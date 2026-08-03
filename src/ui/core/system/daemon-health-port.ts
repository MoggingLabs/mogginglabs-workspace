/**
 * Daemon-reconnect notifications — the heal trigger no box observer sees.
 *
 * When the app's connection to the PTY daemon flaps, main heals it (daemon-relay's
 * reconnect loop) and re-reconciles the DAEMON side of every pane it spawned (the
 * banked-dims replay). Nothing told the RENDERER: a pane whose xterm grid drifted, or
 * whose resize died in the dead socket, kept disagreeing with its PTY forever — the
 * grid-drift incident, and the GRIDHEAL gate's reconnect phase.
 *
 * The transition already reaches the renderer whole: runtime-health pushes every
 * DaemonHealthState snapshot on RuntimeHealthChannels.changed (the workspace banner
 * consumes the same stream). This port distills it to the one edge panes care about —
 * reconnecting → connected — so each pane can re-assert its grid. Boot's
 * starting → connected never fires it: there is nothing to heal before a loss.
 *
 * Same subscribe shape as dpr-port: one lazy bridge listener, per-consumer
 * unsubscribers (panes are disposed; the port is app-lifetime).
 */
import { RuntimeHealthChannels, type DaemonHealthState } from '@contracts'
import { getBridge } from '../ipc/bridge'

const subscribers = new Set<() => void>()
let armed = false
let prev: DaemonHealthState | null = null

function arm(): void {
  getBridge().on(RuntimeHealthChannels.changed, (payload) => {
    const next = payload as DaemonHealthState
    if (prev?.state === 'reconnecting' && next.state === 'connected') {
      for (const cb of subscribers) cb()
    }
    prev = next
  })
}

/** Subscribe to daemon reconnects (the reconnecting → connected edge only — never
 *  boot, never the retry loop's repeated 'reconnecting' pulses). Returns unsubscribe. */
export function onDaemonReconnected(cb: () => void): () => void {
  subscribers.add(cb)
  if (!armed) {
    armed = true
    arm()
  }
  return () => subscribers.delete(cb)
}
