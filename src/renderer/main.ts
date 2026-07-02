// Renderer bootstrap (app-wiring). Initialize observability BEFORE mounting the UI so
// early errors are captured, then mount. All UI lives in @ui.
import { start } from '@ui'
import { initRendererTelemetry } from './telemetry'

initRendererTelemetry()

// Resolve the app typeface BEFORE any xterm measures its cell grid — a font swap after
// mount would change glyph metrics mid-flight (reflow artifacts in the terminals). The
// face is bundled locally, so this settles in milliseconds; failures fall back cleanly.
void document.fonts
  .load('400 13px "JetBrains Mono Variable"')
  .catch(() => undefined)
  .finally(() => start())
