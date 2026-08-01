import { ipcMain } from 'electron'
import { execFile } from 'node:child_process'
import os from 'node:os'
import { SystemChannels, type MachineSpec, type ToolId, type ToolStatus, type ToolchainStatus } from '@contracts'
import { applyLivePathToProcess, resolveLivePath, resolveOnPath } from '@backend/platform/env-path'

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

// ── The toolchain probe ──────────────────────────────────────────────────────
//
// "Can this process run it", never "is it installed". The whole reason this surface
// exists is that those two answers diverge: a tool installed after the app started is
// on the system PATH and invisible here, and every feature that shells out to it fails
// with an error that names the feature instead of the cause.
//
// The version call is best-effort and short-fused: a present tool that will not answer
// `--version` in two seconds is still present, and the UI only ever shows the string
// as detail beside a verdict it did not derive from it.

const TOOLS: readonly { id: ToolId; bin: string; args: string[] }[] = [
  { id: 'git', bin: 'git', args: ['--version'] },
  { id: 'node', bin: 'node', args: ['--version'] },
  { id: 'npm', bin: 'npm', args: ['--version'] }
]

function probeVersion(file: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { encoding: 'utf8', windowsHide: true, timeout: 2500 }, (err, stdout) => {
        if (err) return resolve(undefined)
        const first = String(stdout).split('\n')[0]?.trim() ?? ''
        resolve(first.replace(/^v/, '').replace(/^git version\s+/i, '') || undefined)
      })
    } catch {
      resolve(undefined)
    }
  })
}

async function toolchainStatus(repairedNow: string[] = []): Promise<ToolchainStatus> {
  const live = await resolveLivePath()
  const tools: ToolStatus[] = await Promise.all(
    TOOLS.map(async (tool): Promise<ToolStatus> => {
      const resolvedPath = resolveOnPath(tool.bin)
      if (!resolvedPath) return { id: tool.id, present: false }
      // Spawn the RESOLVED path, not the bare name: the answer then belongs to the same
      // executable the caller was told about, whatever happens to PATH in between.
      return { id: tool.id, present: true, resolvedPath, version: await probeVersion(resolvedPath, tool.args) }
    })
  )
  return { tools, pathSource: live.source, repaired: repairedNow }
}

export function registerSystem(): void {
  ipcMain.handle(SystemChannels.machine, (): MachineSpec => ({
    cpuCount: envInt('MOGGING_MACHINE_CORES') ?? Math.max(1, os.cpus().length),
    totalMemMb: envInt('MOGGING_MACHINE_MB') ?? Math.max(1, Math.round(os.totalmem() / 1048576))
  }))
  ipcMain.handle(SystemChannels.toolchain, () => toolchainStatus())
  // The one-click "you installed it after I started — go look again". Re-reads the live
  // PATH from scratch and reports what that changed, so the UI can say what it fixed
  // instead of asking the user to trust it.
  ipcMain.handle(SystemChannels.repairPath, async () => toolchainStatus(await applyLivePathToProcess()))
}

export function disposeSystem(): void {
  ipcMain.removeHandler(SystemChannels.machine)
  ipcMain.removeHandler(SystemChannels.toolchain)
  ipcMain.removeHandler(SystemChannels.repairPath)
}
