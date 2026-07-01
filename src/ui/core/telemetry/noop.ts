import type { Telemetry } from '@contracts'

/** Default no-op telemetry — active until a real adapter is set at startup. */
export class NoopTelemetry implements Telemetry {
  init(): void {}
  captureError(): void {}
  captureEvent(): void {}
  addBreadcrumb(): void {}
  setContext(): void {}
  async flush(): Promise<void> {}
}
