import { ipcMain, type WebContents } from 'electron'
import {
  RuntimeHealthChannels,
  type DaemonHealthState,
  type RuntimeHealthRetryResult
} from '@contracts'

let state: DaemonHealthState = {
  mode: 'starting',
  state: 'starting',
  message: 'Starting the terminal service…',
  sessionSurvival: false
}
let webContents: (() => WebContents | null) | null = null
let retry: (() => Promise<RuntimeHealthRetryResult>) | null = null

export function registerRuntimeHealth(getWebContents: () => WebContents | null): void {
  webContents = getWebContents
  ipcMain.handle(RuntimeHealthChannels.get, () => state)
  ipcMain.handle(RuntimeHealthChannels.retryDaemon, () =>
    retry
      ? retry()
      : ({
          ok: false,
          reason: 'This terminal mode can only be changed safely by restarting the app.'
        } satisfies RuntimeHealthRetryResult)
  )
}

/** The current daemon-health snapshot, for main-process consumers (the DAEMONHEAL gate
 *  asserts the reconnecting→connected lifecycle windowless, where the IPC pull can't run). */
export function getDaemonHealth(): DaemonHealthState {
  return state
}

export function setDaemonHealth(next: DaemonHealthState): void {
  state = next
  try {
    webContents?.()?.send(RuntimeHealthChannels.changed, state)
  } catch {
    /* a future window pulls the snapshot */
  }
}

export function setDaemonHealthRetry(fn: (() => Promise<RuntimeHealthRetryResult>) | null): void {
  retry = fn
}
