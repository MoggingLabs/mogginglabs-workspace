import type { Telemetry } from '@contracts'
import { NoopTelemetry } from './noop'

// A process-wide singleton, defaulting to no-op. The app composition root
// (src/main/telemetry.ts) calls setTelemetry() with a real adapter when consent +
// config allow. Backend features import getTelemetry() and never touch a vendor SDK.
let current: Telemetry = new NoopTelemetry()

export function setTelemetry(telemetry: Telemetry): void {
  current = telemetry
}

export function getTelemetry(): Telemetry {
  return current
}

export { NoopTelemetry } from './noop'
export type { Telemetry } from '@contracts'
