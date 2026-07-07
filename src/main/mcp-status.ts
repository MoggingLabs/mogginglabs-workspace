import { app, ipcMain, type BrowserWindow } from 'electron'
import { IntegrationsChannels, type HostedCliId, type McpConnStatus, type McpStatusSnapshot } from '@contracts'
import { deriveConnState, parseCliMcpList, type CliServerState } from '@backend/features/integrations'
import { cliMcpListRaw, listServers, mgrStatus } from './mcp-manager'

// The MCP connection-status poller (Phase-8/11). The usage-seam discipline:
// jittered cadence, refresh on demand (Settings-open / after apply), paused
// while hidden, snapshot PUSHED over IPC. OBSERVATION only — the CLIs' own
// `mcp list` + our config verdict (mgrStatus); never a token store or a probe.
// States + counts are the whole vocabulary that leaves this file.

const HOSTED: readonly HostedCliId[] = ['claude-code', 'codex', 'gemini']
const BASE_MS = Number(process.env.MOGGING_MCPSTATUS_CADENCE_MS) || 15 * 60_000
const jitter = (): number => BASE_MS + Math.floor((BASE_MS / 4) * (0.5 - deterministicNoise()))

let winGetter: (() => BrowserWindow | null) | null = null
let last: McpStatusSnapshot = { statuses: [], at: 0 }
let timer: ReturnType<typeof setTimeout> | null = null
let visible = true
let polling = false

export function getStatusSnapshot(): McpStatusSnapshot {
  return last
}

async function poll(): Promise<void> {
  if (polling) return
  polling = true
  try {
    const servers = listServers()
    // Run each installed CLI's `mcp list` ONCE, parse per server.
    const rawByCli = new Map<HostedCliId, string | null>()
    const installedByCli = new Map<HostedCliId, boolean>()
    for (const server of servers) {
      for (const st of mgrStatus(server.id)) installedByCli.set(st.cli, st.installed)
    }
    for (const cli of HOSTED) {
      if (installedByCli.get(cli)) rawByCli.set(cli, await cliMcpListRaw(cli))
    }
    const now = Date.now()
    const statuses: McpConnStatus[] = []
    for (const server of servers) {
      for (const st of mgrStatus(server.id)) {
        const raw = rawByCli.get(st.cli)
        const cliList: CliServerState | 'unknown' = st.installed && raw != null ? parseCliMcpList(st.cli, raw, server.id) : 'unknown'
        statuses.push({ serverId: server.id, cli: st.cli, state: deriveConnState(st.installed, st.state, cliList), checkedAt: now })
      }
    }
    last = { statuses, at: now }
    try {
      winGetter?.()?.webContents.send(IntegrationsChannels.statusChanged, last)
    } catch {
      /* window gone */
    }
  } finally {
    polling = false
  }
}

function schedule(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    void tick()
  }, jitter())
}
async function tick(): Promise<void> {
  if (visible) await poll() // paused while hidden — the poll costs nothing at rest
  schedule()
}

/** On-demand refresh (Settings-open, after Authorize/apply, gallery). */
export function refreshStatus(): void {
  void poll()
}

export function setStatusVisible(v: boolean): void {
  visible = v
}

/** Smoke-only: one cadence tick's WORK (poll only when visible), no reschedule.
 *  Lets the gate prove the hidden window pauses the poller. */
export async function tickForSmoke(): Promise<boolean> {
  if (!visible) return false
  await poll()
  return true
}

export function registerMcpStatus(getWin: () => BrowserWindow | null): void {
  winGetter = getWin
  ipcMain.handle(IntegrationsChannels.statusGet, () => last)
  ipcMain.handle(IntegrationsChannels.statusRefresh, () => refreshStatus())
  app.on('browser-window-created', (_e, w) => {
    w.on('hide', () => setStatusVisible(false))
    w.on('minimize', () => setStatusVisible(false))
    w.on('show', () => setStatusVisible(true))
    w.on('restore', () => setStatusVisible(true))
  })
  app.on('before-quit', () => {
    if (timer) clearTimeout(timer)
  })
  // First snapshot shortly after boot, then the jittered cadence.
  setTimeout(() => void tick(), 2000)
}

// A cheap, dependency-free noise source for jitter (Date/Math.random are fine
// in main; this just spreads the cadence so N app instances don't sync).
let noiseSeed = (process.pid * 2654435761) >>> 0
function deterministicNoise(): number {
  noiseSeed = (Math.imul(noiseSeed, 1664525) + 1013904223) >>> 0
  return noiseSeed / 0xffffffff
}
