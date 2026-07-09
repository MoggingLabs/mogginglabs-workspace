// The generic, contracts-allowlisted bridge the preload exposes as window.bridge.
// Feature clients (e.g. features/terminal/terminal.client.ts) wrap this with typed
// calls, so the UI never touches raw channel strings outside its own feature.
export interface Bridge {
  invoke(channel: string, payload?: unknown): Promise<unknown>
  send(channel: string, payload: unknown): void
  on(channel: string, cb: (payload: unknown) => void): void
  /** Resolve a dropped File to its absolute path (Electron's webUtils; `File.path` was
   *  removed in v32). Absent in non-Electron hosts, so callers must guard. */
  getPathForFile?(file: File): string
}

declare global {
  interface Window {
    bridge: Bridge
  }
}

export function getBridge(): Bridge {
  if (!window.bridge) throw new Error('preload bridge unavailable')
  return window.bridge
}
