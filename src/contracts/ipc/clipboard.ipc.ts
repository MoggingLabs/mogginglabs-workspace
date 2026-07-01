// Clipboard is a system/app-level capability (Electron's clipboard lives in the main
// process), so its handlers are registered in the app layer (src/main), not in the
// Electron-free @backend. The channels still live here so the preload allowlist and the
// UI share one source of truth.
export interface WriteClipboard {
  text: string
}
