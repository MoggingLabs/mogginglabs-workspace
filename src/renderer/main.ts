// Renderer bootstrap (app-wiring). Initialize observability BEFORE mounting the UI so
// early errors are captured, then mount. All UI lives in @ui.
import { start } from '@ui'
import { initRendererTelemetry } from './telemetry'

initRendererTelemetry()
start()
