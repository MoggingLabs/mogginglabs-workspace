// What the MACHINE is, for the pane budget (wizard revamp, 2026-07-16).
//
// SCOPE, and it is the whole contract: two numbers, read once per app run.
// The renderer must not guess hardware (navigator.deviceMemory is capped and
// quantized; the sandbox has no `os`), and main must not own layout POLICY —
// so main reports raw measurements and the capacity model in @ui/features/
// layout/pane-capacity.ts turns them into a budget. Nothing here identifies
// the machine: counts and sizes only, never serials/hostnames (ADR 0005).

export interface MachineSpec {
  /** Logical CPU count (os.cpus().length — hyperthreads included). */
  cpuCount: number
  /** Total physical memory, in MiB (os.totalmem()). */
  totalMemMb: number
}
