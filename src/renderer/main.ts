// Renderer bootstrap (app-wiring). Initialize observability BEFORE mounting the UI so
// early errors are captured, then mount. All UI lives in @ui.
import { start } from '@ui'
import { primeRendererProfile } from '@ui/core/system/renderer-profile-port'
import { primeTerminalFonts } from '@ui/core/terminal/font-port'
import { initRendererTelemetry } from './telemetry'

initRendererTelemetry()

// One throwaway WebGL context, released immediately — decides whether a published grid
// floors its cell at device pixels. Synchronous and before start(), so no pane can mount
// without the answer (renderer-profile-port).
primeRendererProfile()

// Resolve the app typeface BEFORE any xterm measures its cell grid — a font swap after
// mount would change glyph metrics mid-flight (reflow artifacts in the terminals). The
// face is bundled locally, so this settles in milliseconds; failures fall back cleanly.
//
// THE SAME prime a pane waits on (font-port), not a second definition of it: the bare
// `fonts.load('400 13px …')` this replaces asked for one weight at a size the terminal
// never uses, while a pane waits for 400/700/italic plus the symbols face at 14px — so
// "the app has started" did not imply "the faces a pane measures against are active",
// and the weaker of the two definitions was the one gating boot. It also gains a bound.
void primeTerminalFonts().finally(() => start())
