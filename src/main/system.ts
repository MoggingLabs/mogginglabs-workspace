import { ipcMain } from 'electron'
import os from 'node:os'
import { SystemChannels, type MachineSpec } from '@contracts'

// App-wiring: the machine's raw shape for the pane budget (wizard revamp,
// 2026-07-16). Main measures, the renderer's capacity model decides — layout
// POLICY (how many terminals per core / per GiB) lives in @ui/features/layout/
// pane-capacity.ts where it is pure and unit-tested, not here. Two counts,
// nothing identifying (ADR 0005).

export function registerSystem(): void {
  ipcMain.handle(SystemChannels.machine, (): MachineSpec => ({
    cpuCount: Math.max(1, os.cpus().length),
    totalMemMb: Math.max(1, Math.round(os.totalmem() / 1048576))
  }))
}

export function disposeSystem(): void {
  ipcMain.removeHandler(SystemChannels.machine)
}
