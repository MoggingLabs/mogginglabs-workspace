// Public entry for the backend package. The app-wiring layer (src/main) imports
// only from here. Backend never imports @ui; it speaks to the UI only via
// @contracts channels through the BackendContext it is given.
export { startBackend, createFeatureModules } from './bootstrap'
export type { BackendContext, FeatureModule } from './core/ipc/registry'
export { setTelemetry, getTelemetry, NoopTelemetry } from './core/telemetry'
export { setEntitlements, getEntitlements, FreeEntitlements } from './core/entitlements'
