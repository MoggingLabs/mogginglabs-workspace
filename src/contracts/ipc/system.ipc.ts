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

// ── The toolchain the app itself needs ───────────────────────────────────────
//
// Not "is this installed on your computer" — "can THIS PROCESS run it". Those are
// different questions and the gap between them is a whole class of bug: a desktop
// app inherits one frozen environment block and never learns about a tool the user
// installed afterwards, so `git` can be installed, on the system PATH, and still
// invisible here. Every surface that depends on a tool (worktree isolation on git,
// agent installs on npm) reads this instead of assuming.

export type ToolId = 'git' | 'node' | 'npm'

export interface ToolStatus {
  id: ToolId
  /** Resolvable by this process right now. */
  present: boolean
  /** Absolute path it resolved to — the honest answer to "which one are you running". */
  resolvedPath?: string
  /** Reported version, when the tool answered. */
  version?: string
}

export interface ToolchainStatus {
  tools: ToolStatus[]
  /** Where the PATH the app is using was last learned from. */
  pathSource: 'registry' | 'login-shell' | 'process'
  /** Directories the live environment has that this process's launch snapshot did not.
   *  Non-empty means the snapshot HAD gone stale and the repair did something. */
  repaired: string[]
}
