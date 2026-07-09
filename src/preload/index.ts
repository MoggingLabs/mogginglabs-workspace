import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { AllChannels } from '@contracts'

// A single generic bridge, but locked to the channels declared in @contracts.
// Adding a feature's channels to AllChannels auto-permits them — no per-feature
// preload edit — yet the renderer can never reach arbitrary IPC. This keeps the
// preload stable while features are added in parallel.
const allow = new Set<string>(AllChannels)

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
    ipcRenderer.on(channel, (_e, payload) => cb(payload))
  },
  // Drag-and-drop's ONLY route to a real path. Electron removed the non-standard
  // `File.path` property in v32 (we ship 39), so a dropped File exposes nothing but a
  // name and its bytes. `webUtils.getPathForFile` is the sanctioned replacement, and it
  // is preload-only — hence this one non-channel member on an otherwise generic bridge.
  // It reads a path the user just handed us by dropping it; it opens no new authority.
  getPathForFile: (file: File): string => webUtils.getPathForFile(file)
})
