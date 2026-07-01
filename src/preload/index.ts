import { contextBridge, ipcRenderer } from 'electron'
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
  }
})
