import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { AllChannels } from '@contracts'

// A single generic bridge, but locked to the channels declared in @contracts.
// Adding a feature's channels to AllChannels auto-permits them — no per-feature
// preload edit — yet the renderer can never reach arbitrary IPC. This keeps the
// preload stable while features are added in parallel.
const allow = new Set<string>(AllChannels)

// Every TerminalPane holds one listener per terminal event channel, and a workspace
// legitimately runs dozens of panes (screen-derived paneLimit, ABS-capped at 32) — past Node's default of 10 that printed a
// MaxListenersExceededWarning for perfectly healthy fan-out. Leak protection is real,
// not a threshold: `on` returns an unsubscriber and panes detach on dispose.
ipcRenderer.setMaxListeners(0)

function assertAllowed(channel: string): void {
  if (!allow.has(channel)) throw new Error(`ipc channel not allowed: ${channel}`)
}

contextBridge.exposeInMainWorld('bridge', {
  invoke: (channel: string, payload: unknown) => {
    assertAllowed(channel)
    return ipcRenderer.invoke(channel, payload)
  },
  send: (channel: string, payload: unknown) => {
    assertAllowed(channel)
    ipcRenderer.send(channel, payload)
  },
  on: (channel: string, cb: (payload: unknown) => void) => {
    assertAllowed(channel)
    const listener = (_e: Electron.IpcRendererEvent, payload: unknown): void => cb(payload)
    ipcRenderer.on(channel, listener)
    // The unsubscriber crosses the context bridge as a proxied function. Panes are
    // created and disposed all session long (splits, closed slots, workspace churn);
    // without this, every disposed pane's listeners lived — and ran — forever.
    return () => ipcRenderer.removeListener(channel, listener)
  },
  // Drag-and-drop's ONLY route to a real path. Electron removed the non-standard
  // `File.path` property in v32 (we ship 39), so a dropped File exposes nothing but a
  // name and its bytes. `webUtils.getPathForFile` is the sanctioned replacement, and it
  // is preload-only — hence this one non-channel member on an otherwise generic bridge.
  // It reads a path the user just handed us by dropping it; it opens no new authority.
  getPathForFile: (file: File): string => webUtils.getPathForFile(file)
})
