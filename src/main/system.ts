import { ipcMain } from 'electron'
import os from 'node:os'
import { SystemChannels, type MachineSpec } from '@contracts'

// App-wiring: the machine's raw shape for the pane budget (wizard revamp,
// 2026-07-16). Main measures, the renderer's capacity model decides — layout
// POLICY (how many terminals per core / per GiB) lives in @ui/features/layout/
// pane-capacity.ts where it is pure and unit-tested, not here. Two counts,
// nothing identifying (ADR 0005).
//
// MOGGING_MACHINE_MB / MOGGING_MACHINE_CORES pin the measurements — the HARNESS
// knob (qa-smokes.sh exports a canonical 64 GiB / 16-core machine for every
// gate, or dense fixtures would clamp to whatever box CI happens to rent: a
// 7 GiB macOS runner budgets six panes and a 16-pane gate goes red for the
// hardware, not the product). The policy math itself is pinned against
// synthetic machines in the unit suite; production never sets these.

const envInt = (name: string): number | null => {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

export function registerSystem(): void {
  ipcMain.handle(SystemChannels.machine, (): MachineSpec => ({
    cpuCount: envInt('MOGGING_MACHINE_CORES') ?? Math.max(1, os.cpus().length),
    totalMemMb: envInt('MOGGING_MACHINE_MB') ?? Math.max(1, Math.round(os.totalmem() / 1048576))
  }))
}

export function disposeSystem(): void {
  ipcMain.removeHandler(SystemChannels.machine)
}
