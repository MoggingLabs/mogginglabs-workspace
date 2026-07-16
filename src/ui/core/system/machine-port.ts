import { SystemChannels, type MachineSpec } from '@contracts'
import { getBridge } from '../ipc/bridge'

/**
 * The machine's shape, cached for SYNCHRONOUS consumers. GridLayout gates every
 * split/adopt/move through `limit()` — a hot, synchronous path that cannot await
 * an IPC round trip — and the wizard computes its capacity inside `open()`. So
 * the spec is fetched ONCE (it cannot change under a running app: you do not
 * hot-swap RAM) and read synchronously ever after. Until the answer lands — or
 * if the channel is unavailable (old main during dev HMR) — consumers get null
 * and fall back to geometry-only budgets, which is exactly the pre-budget world.
 */

let spec: MachineSpec | null = null
let inFlight: Promise<void> | null = null

/** Fire the one fetch. Idempotent; call from any feature that will need the
 *  budget (wizard mount, workspace mount) — first caller wins. */
export function primeMachineSpec(): Promise<void> {
  if (spec) return Promise.resolve()
  if (!inFlight) {
    inFlight = (getBridge().invoke(SystemChannels.machine) as Promise<MachineSpec>)
      .then((m) => {
        if (m && Number.isFinite(m.cpuCount) && Number.isFinite(m.totalMemMb)) spec = m
      })
      .catch(() => {
        inFlight = null // a transport hiccup may retry on the next prime
      })
  }
  return inFlight
}

/** The cached spec, or null while unknown (callers fall back to geometry-only). */
export function machineSpec(): MachineSpec | null {
  return spec
}
