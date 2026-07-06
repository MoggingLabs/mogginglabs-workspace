// The shared seam. Depends on nothing. Imported by BOTH @backend and @ui — and by
// the app-wiring layer (preload/main). This is the ONLY thing the two sides share.
export * from './domain'
export * from './ipc'
export * from './observability'
export * from './daemon'
export * from './usage'
export * from './integrations'
