import type { Terminal } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'
import { getTelemetry } from '../../core/telemetry'

/**
 * The WebGL context lifecycle for ONE pane, extracted whole from TerminalPane (which
 * carried six gl* fields and four methods of it among its forty fields — the review's
 * god-class finding). Semantics unchanged, byte for byte where it matters:
 *
 * WebGL is the wedge — GPU rendering that stays smooth under many streaming agents. But
 * the browser caps live WebGL contexts (~16 per page in Chromium), which is exactly our
 * largest grid — so contexts are MANAGED, not assumed (Phase-2/05): only VISIBLE panes
 * hold one (panes in a hidden background workspace release theirs and fall back to the
 * DOM renderer; they re-acquire on show), and a lost context (cap eviction / GPU reset)
 * self-heals to the DOM renderer with bounded retries instead of leaving a dead pane.
 */

// App-wide job serializer: at most ONE attach/detach per animation frame. Revealing or
// hiding a workspace otherwise (re)builds/tears down up to 16 WebGL addons in a single
// tick (shader compile, glyph-atlas alloc, context teardown + DOM-renderer fallback
// repaint each), stalling the main thread for hundreds of ms — a visible hitch.
// Serialized — and with hide-releases debounced — a rapid workspace flip is a pure
// show/hide (GL stays warm), while a sustained hide still frees its contexts within a
// second. Panes always render (DOM renderer) while work streams in.
const glJobQueue: Array<() => void> = []
let glPumping = false
function enqueueGlJob(job: () => void): void {
  glJobQueue.push(job)
  if (glPumping) return
  glPumping = true
  const step = (): void => {
    const next = glJobQueue.shift()
    if (next) next()
    if (glJobQueue.length) requestAnimationFrame(step)
    else glPumping = false
  }
  requestAnimationFrame(step)
}

export interface PaneWebglHost {
  readonly term: Terminal
  isVisible(): boolean
  isDisposed(): boolean
}

export class PaneWebglManager {
  private webgl?: WebglAddon
  private glRetry?: ReturnType<typeof setTimeout>
  private glDebounce?: ReturnType<typeof setTimeout>
  private glReleaseDebounce?: ReturnType<typeof setTimeout>
  private glQueued = false
  private glLosses = 0

  constructor(private readonly host: PaneWebglHost) {}

  /** Is the GPU renderer live right now? (dev/gate probe — the PANESCROLL smoke asserts
   *  which renderer painted). */
  isActive(): boolean {
    return !!this.webgl
  }

  /** The pane came on screen: cancel any pending release (a rapid flip keeps GL warm),
   *  forgive past losses, and (re)acquire. */
  onShow(): void {
    if (this.glReleaseDebounce) {
      clearTimeout(this.glReleaseDebounce)
      this.glReleaseDebounce = undefined
    }
    this.glLosses = 0
    this.acquire()
  }

  /** The pane left the screen: cancel a pending acquire and schedule the release. */
  onHide(): void {
    if (this.glDebounce) {
      clearTimeout(this.glDebounce)
      this.glDebounce = undefined
    }
    this.scheduleRelease()
  }

  /** Acquire on a debounce (a flip through visibility never spends the work) + the
   *  app-wide one-per-frame queue (a reveal never stalls the main thread). The pane
   *  renders via the DOM renderer until its turn. */
  private acquire(): void {
    if (this.webgl || !this.host.isVisible() || this.glDebounce || this.glQueued) return
    this.glDebounce = setTimeout(() => {
      this.glDebounce = undefined
      if (!this.host.isVisible() || this.webgl) return
      this.glQueued = true
      enqueueGlJob(() => {
        this.glQueued = false
        // `isDisposed` too: an enqueued job cannot be cancelled, so a pane closed inside
        // the ≤1-frame window between enqueue and pump would attach a WebGL addon to a
        // disposed xterm — a context spent against the ~16 the page gets, with no owner
        // left to release it. `visible` is not enough: dispose() never unsets it.
        if (!this.host.isDisposed() && this.host.isVisible() && !this.webgl) this.attachNow()
      })
    }, 60)
  }

  /** Schedule a GL release for a hidden pane: debounced (a rapid flip back cancels it,
   *  keeping the context warm) + queue-serialized (a hidden 16-pane workspace tears
   *  down one context per frame, never all at once). The 1.5 s quiet period is a
   *  PERCEPTION-budget choice (docs/07): workspace switching within it is pure
   *  show/hide — zero shader/atlas cost while the user is interacting — while a
   *  workspace left in the background still frees its contexts promptly. */
  private scheduleRelease(): void {
    if (!this.webgl || this.glReleaseDebounce) return
    this.glReleaseDebounce = setTimeout(() => {
      this.glReleaseDebounce = undefined
      if (this.host.isVisible() || !this.webgl) return
      enqueueGlJob(() => {
        if (!this.host.isVisible()) this.release()
      })
    }, 1500)
  }

  /** Attach the WebGL renderer (idempotent; only while visible). On failure the pane
   *  simply stays on the DOM renderer — a pane must always render; fast when it can. */
  private attachNow(): void {
    if (this.webgl || !this.host.isVisible()) return
    try {
      const addon = new WebglAddon()
      addon.onContextLoss(() => {
        // Evicted (context cap) or GPU reset: drop to the DOM renderer, then retry a few
        // times while visible — self-healing, never a frozen/blank pane.
        this.release()
        this.glLosses++
        // Renderer-health signal (counts only) — the wedge metric watched in the field.
        getTelemetry().captureEvent({ name: 'gl.context_lost', props: { losses: this.glLosses } })
        if (this.host.isVisible() && this.glLosses <= 3) {
          this.glRetry = setTimeout(() => this.acquire(), 1500)
        }
      })
      this.host.term.loadAddon(addon)
      this.webgl = addon
    } catch (err) {
      console.warn('WebGL renderer unavailable; using default renderer.', err)
    }
  }

  /** Detach the WebGL renderer and release its GPU context (idempotent). xterm falls
   *  back to its DOM renderer, which is fine for a hidden pane (no frames are being
   *  painted anyway). Also the dispose path. */
  release(): void {
    if (this.glRetry) {
      clearTimeout(this.glRetry)
      this.glRetry = undefined
    }
    if (this.glDebounce) {
      clearTimeout(this.glDebounce)
      this.glDebounce = undefined
    }
    if (this.glReleaseDebounce) {
      clearTimeout(this.glReleaseDebounce)
      this.glReleaseDebounce = undefined
    }
    if (!this.webgl) return
    const addon = this.webgl
    this.webgl = undefined
    try {
      addon.dispose()
    } catch {
      /* already disposed with the terminal */
    }
  }
}
