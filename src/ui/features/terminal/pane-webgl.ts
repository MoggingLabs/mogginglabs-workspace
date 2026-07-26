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
// Context accountant: every attached addon's manager, app-wide. The browser cap (~16
// contexts per page) is the ONLY reason hidden panes ever give up GL — but the old rule
// released them unconditionally, so switching back to a workspace hidden >1.5s replayed
// a staggered DOM→WebGL swap per pane (one per frame): the visible "flicker" on workspace
// switch. Now a hidden pane keeps its context WARM while the app-wide count fits the cap,
// and a visible pane that needs a context past the cap evicts a hidden one's first — the
// budget spends itself on what is on screen, and a switch inside budget is pure show/hide.
// Dev/gate override (FLICKER 3c): the release path is pinned by forcing the budget to 0 —
// with 16 real contexts the smoke's 8 panes could never create genuine pressure.
const glBudget = (): number => (window as { __moggingGlBudget?: number }).__moggingGlBudget ?? 16
/**
 * The ATTACH cap, floored at one context. A budget is a count of live contexts, and the
 * eviction/give-up branch in attachNow is about a cap that is FULL — which an EMPTY set never
 * is. Read raw, an override of 0 made `glAttached.size >= 0` true against an empty set with no
 * hidden holder to reclaim, so no pane could attach at all: the override stopped meaning
 * "maximum pressure" (the words all three of its gate callers use, and the words this file
 * used two comments up) and started meaning "GL is impossible". A gate arming it BEFORE any
 * attach would then read the give-up branch's green vacuously — nothing gave up, because
 * nothing was ever holding. Floored at one, budget 0 is the tightest HONEST budget: a single
 * holder, and every other visible pane reaches the real give-up branch and rides the DOM
 * renderer. The RELEASE threshold below deliberately stays on the RAW budget, so 0 still
 * surrenders every hidden context — which is what FLICKER 2c, MILESTONE and PANEFIT B assert.
 */
const glAttachCap = (): number => Math.max(1, glBudget())
const glAttached = new Set<PaneWebglManager>()
/**
 * Visible panes that reached the give-up branch: past the cap with every holder on screen.
 * They ride the DOM renderer — correct — but NOTHING used to tell them a slot had opened.
 * `release()` freed one and notified nobody, and the only other callers of `acquire()` are
 * `onShow()` and the context-loss retry, so a pane past the cap stayed on the DOM renderer for
 * the life of the app: on every workspace flip ALL panes are visible at `onShow`, the victim
 * search finds nothing, and they give up again. Deterministic, not racy. This set is the
 * missing wake list; entries are pruned on attach, on release (which is also the dispose
 * path), and while scanning.
 */
const glStranded = new Set<PaneWebglManager>()

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
  /** The ACTIVE renderer changed (WebGL attached, or detached back to the DOM renderer).
   *  Cell metrics belong to the active renderer — WebGL floors cells at device pixels,
   *  the DOM renderer does not, and at fractional display scaling they disagree — so a
   *  swap is a metrics event exactly like a resize: the host must re-derive its grid
   *  from the renderer that will actually paint (pane-fit.ts reads the active one). */
  onRendererChanged(): void
}

export class PaneWebglManager {
  private webgl?: WebglAddon
  private glRetry?: ReturnType<typeof setTimeout>
  private glDebounce?: ReturnType<typeof setTimeout>
  private glReleaseDebounce?: ReturnType<typeof setTimeout>
  private glQueued = false
  private glLosses = 0

  constructor(private readonly host: PaneWebglHost) {}

  /** Hand a just-freed slot to exactly ONE stranded pane. Deferred to a microtask because
   *  the eviction path calls `victim.release()` and then attaches into that very slot
   *  SYNCHRONOUSLY — waking from inside `release()` would spend a 60 ms debounce and a queued
   *  frame job on a slot that is already gone. One pane per freed slot, never the whole set:
   *  a reveal that frees one context must not send fifteen panes into the attach queue, and
   *  the pane that does attach frees nothing, so the cascade stops on its own. */
  private static wakeOneStranded(): void {
    if (!glStranded.size) return
    queueMicrotask(() => {
      for (const pane of glStranded) {
        // Prune what can never use a slot again. A stranded pane never held a context, so
        // its own release() is the only other place this set is trimmed.
        if (pane.host.isDisposed() || pane.webgl) {
          glStranded.delete(pane)
          continue
        }
        if (!pane.host.isVisible()) continue // hidden: onShow() asks again for itself
        if (glAttached.size >= glAttachCap()) return // the slot was taken while we waited
        glStranded.delete(pane)
        pane.acquire()
        return
      }
    })
  }

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
        // Budget-aware: a hidden pane's context is only surrendered when the app-wide
        // count is actually pressing the browser cap. Under budget it stays warm, so
        // switching back is pure show/hide — no DOM→WebGL swap, no per-pane flicker.
        // The RAW budget on purpose (not the floored attach cap): an override of 0 must
        // still surrender every hidden context — see glAttachCap.
        if (!this.host.isVisible() && glAttached.size > glBudget()) this.release()
      })
    }, 1500)
  }

  /** Attach the WebGL renderer (idempotent; only while visible). On failure the pane
   *  simply stays on the DOM renderer — a pane must always render; fast when it can. */
  private attachNow(): void {
    if (this.webgl || !this.host.isVisible()) return
    // At the cap, a VISIBLE pane's need outranks a hidden pane's warm context: evict one
    // hidden holder before attaching. (This is also what reclaims contexts a hidden pane
    // kept under budget — its release debounce fired once and did nothing; the pressure
    // that matters shows up here, at acquire time.)
    if (glAttached.size >= glAttachCap()) {
      let victim: PaneWebglManager | undefined
      for (const other of glAttached) {
        if (other !== this && !other.host.isVisible()) {
          victim = other
          break
        }
      }
      // Past the cap with nothing to reclaim (every holder is on screen), RIDE THE DOM
      // RENDERER — which is what pane-capacity.ts:89-91 already promises in words: "GPU is
      // deliberately NOT a count limit … PaneWebglManager already rides the DOM renderer past
      // that edge — correct, just not GPU-smooth." Without this branch the attach went ahead
      // anyway, Chromium force-lost the oldest context, its owner's onContextLoss re-acquired
      // 1.5s later and evicted the next one — a renderer-swap churn (each swap is a metrics
      // event → refit → ConPTY repaint over whatever the agent is drawing), re-armed on every
      // workspace switch because onShow() forgives glLosses. Reachable: the machine budget
      // offers up to ABS_MAX_PANES=32 and a 1920x1080 work area fits well past 16 at the
      // 132x110 minima, so >16 panes can be visible at once in one workspace.
      //
      // Giving up is not the same as giving up FOREVER, which is what it used to mean: join
      // the wake list so the next freed slot reaches this pane. Without it the DOM fallback
      // was permanent — see glStranded.
      if (!victim) {
        glStranded.add(this)
        return
      }
      victim.release()
    }
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
      glAttached.add(this)
      glStranded.delete(this) // it has one now; it is nobody's wake candidate
      this.host.onRendererChanged()
    } catch (err) {
      console.warn('WebGL renderer unavailable; using default renderer.', err)
    }
  }

  /** Detach the WebGL renderer and release its GPU context (idempotent). xterm falls
   *  back to its DOM renderer, which is fine for a hidden pane (no frames are being
   *  painted anyway). Also the dispose path. */
  release(): void {
    // BEFORE the `!this.webgl` early return below: a STRANDED pane never held a context, so
    // that return is the path its dispose takes — and leaving it on the wake list would keep
    // a disposed manager (and its terminal) alive in a module-global set for the session.
    glStranded.delete(this)
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
    glAttached.delete(this)
    try {
      addon.dispose()
    } catch {
      /* already disposed with the terminal */
    }
    // A slot just opened. Nothing else in this module ever announces that, which is exactly
    // why panes past the cap never came back (see glStranded).
    PaneWebglManager.wakeOneStranded()
    // After the swap back to the DOM renderer — its metrics may disagree with WebGL's
    // (see PaneWebglHost.onRendererChanged). The host guards its own disposed state
    // (release is also the dispose path).
    this.host.onRendererChanged()
  }
}
