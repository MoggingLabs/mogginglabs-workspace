import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { SerializeAddon } from '@xterm/addon-serialize'
import {
  EXPLORER_DRAG_TYPE,
  WorktreeChannels,
  type ContextUsage,
  type GitStatus,
  type AgentState,
  type PaneId,
  type RemoveWorktreeResult
} from '@contracts'
import '@xterm/xterm/css/xterm.css'
import {
  Button,
  createModal,
  icon,
  providerLogo,
  showToast,
  type IconName,
  type ModalHandle
} from '../../components'
import { getBridge } from '../../core/ipc/bridge'
import { terminalClient } from './terminal.client'
import { onTerminalTheme } from '../../core/theme/theme-port'
import { onTerminalFontSize, terminalFontSize, TERMINAL_LINE_HEIGHT } from '../../core/terminal/font-port'
import { windowsPtyFor } from '../../core/terminal/pty-emulation'
import { forgetPane, markPaneLive, markPaneReattached, markPaneRemoteReady } from '../../core/terminal/liveness-port'
import { onPaneLabel, getPaneLabel, setPaneLabel } from '../../core/layout/pane-meta'
import { setPaneState, adoptPaneState, clearPaneState, paneState, paneFinished, onAttentionChange } from '../../core/attention/attention-port'
import { applyPaneCwdEvent, clearPaneCwd, getPaneCwd, getPaneCwdProjection } from '../../core/layout/pane-cwd'
import { getPaneRole, onPaneRole, getPaneRemote, getPaneProfile, setPaneProfile } from '../../core/layout/pane-meta'
import {
  clearPaneCli,
  mcpChipForPane,
  onMcpStatusChange,
  recordPaneCli,
  setMcpSnapshot
} from '../../core/agents/mcp-status-port'
import { getPaneContext, onPaneContext, type PaneContext } from '../../core/terminal/context-port'
import { clearPaneAgentSession, getPaneAgentSession, onPaneAgentSession } from '../../core/agents/agent-session-port'
import { claimsFor, onClaimsChange, setClaimsForDev, workspaceClaims } from './claims-store'
import { createPaneAnchor, type PaneAnchorHandle } from './pane-anchor'
import { createPaneScrollbar, type PaneScrollbarHandle } from './pane-scrollbar'
import { onFocusedPane } from '../../core/layout/focus'
import { onPaneGit, getPaneGit, setPaneGit } from '../../core/git/git-port'
import { displayGitStatus } from '../../core/git/git-display'
import { allCommands } from '../../core/commands/command-port'
import { getTelemetry } from '../../core/telemetry'
import { BlockTracker } from '../blocks'
import {
  copyOnSelect,
  copyText,
  quoteDroppedPaths,
  quoteWithFlavor,
  readText,
  recordDrop,
  sanitizePaste
} from '../../core/clipboard/clipboard-port'

// Same platform probe the app shell uses for its `platform-darwin` class.
const IS_MAC = navigator.platform.toUpperCase().includes('MAC')

// WebGL job serializer: at most ONE attach/detach per animation frame, app-wide.
// Revealing or hiding a workspace otherwise (re)builds/tears down up to 16 WebGL
// addons in a single tick (shader compile, glyph-atlas alloc, context teardown +
// DOM-renderer fallback repaint each), stalling the main thread for hundreds of ms —
// a visible hitch. Serialized — and with hide-releases debounced — a rapid workspace
// flip is a pure show/hide (GL stays warm), while a sustained hide still frees its
// contexts within a second. Panes always render (DOM renderer) while work streams in.
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

/**
 * How long a resize burst must be quiet before the pane refits. A resize is not free:
 * ConPTY answers EVERY one by repainting its entire viewport, and it replays conhost's
 * screen buffer — which still holds the pre-agent shell prompts — over whatever the
 * agent is drawing. Measured against cmd.exe: the 9 ResizeObserver ticks of a 150 ms
 * rail transition cost 9 full repaints (3717 bytes); coalesced, they cost 1 (419).
 *
 * 120 ms > --dur-2 (the rail's 150 ms transition trails off inside it) and comfortably
 * covers a window drag's per-frame ticks, while staying under the ~150 ms at which a
 * settle starts to read as lag. The FIRST tick of a burst still fits immediately — a
 * discrete change (pane mount, template apply, reveal) must never wait on a timer.
 */
const REFIT_SETTLE_MS = 120

/** A single xterm pane bound to a backend PTY of the same id. */
export class TerminalPane {
  private readonly term: Terminal
  private readonly fit = new FitAddon()
  private readonly serializer = new SerializeAddon()
  private readonly resizeObs: ResizeObserver
  private visObs?: IntersectionObserver
  private webgl?: WebglAddon
  private visible = false
  private glRetry?: ReturnType<typeof setTimeout>
  private glDebounce?: ReturnType<typeof setTimeout>
  private glReleaseDebounce?: ReturnType<typeof setTimeout>
  private selectionCopyTimer?: ReturnType<typeof setTimeout>
  /** Tears down the window-scoped drag listeners this pane installs (see mountFileDrop). */
  private readonly dropAbort = new AbortController()
  private glQueued = false
  private glLosses = 0
  private devHandle: unknown
  private themeUnsub?: () => void
  private fontUnsub?: () => void
  private liveMarked = false
  private paneLabelUnsub?: () => void
  private paneGitUnsub?: () => void
  private focusUnsub?: () => void
  private roleUnsub?: () => void
  private claimsUnsub?: () => void
  private mcpUnsub?: () => void
  private ctxUnsub?: () => void
  private agentSessionUnsub?: () => void
  private agentChipUnsub?: () => void
  private scrollbar?: PaneScrollbarHandle
  private anchor?: PaneAnchorHandle
  private osc133?: { dispose(): void }
  private stateDot?: HTMLSpanElement
  private syncState?: (adopted?: boolean) => void
  private dotGateUnsub?: () => void
  private renameFn?: () => void
  private renameModal?: ModalHandle
  /** The portaled pane menu owns document/window listeners plus DOM outside the pane.
   *  One cleanup tears all of it down when the pane id is retired. */
  private menuCleanup?: () => void
  private blocks?: BlockTracker
  private refitTimer?: ReturnType<typeof setTimeout>
  private expandStateObs?: MutationObserver
  private refitLeading = true
  private disposed = false
  /** When this pane started WATCHING. An adopted session (a restore against the surviving
   *  daemon) was already working by then, so the attention port times that first episode
   *  from here rather than from the adoption — see adoptPaneState. */
  private readonly mountedAt = Date.now()
  /** Unsubscribers for this pane's terminalClient channel listeners. The channels are
   *  session-lived while panes die on close — an undetached listener kept running against
   *  a disposed xterm for the rest of the session (and xterm's WriteBuffer keeps queueing
   *  into a disposed core, so the leak grew with every byte a reused id streamed). */
  private readonly clientUnsubs: Array<() => void> = []

  constructor(
    private readonly id: PaneId,
    host: HTMLElement
  ) {
    this.term = new Terminal({
      fontFamily:
        '"JetBrains Mono Variable", "JetBrains Mono", "Cascadia Code", Menlo, Consolas, monospace',
      fontSize: terminalFontSize(), // Settings § Terminal (5/06); default is the matrix pick
      lineHeight: TERMINAL_LINE_HEIGHT, // fixed by design — only fontSize is user-facing
      cursorBlink: false, // enabled only while focused (perf: fewer idle repaints across panes)
      allowProposedApi: true,
      scrollback: 10000,
      // windowsPty is NOT set here: nobody in the renderer knows how this pane's pty grows until
      // the pty exists. It is applied from the spawn answer below, which arrives before the first
      // byte of output — the buffer is empty until then, so no resize can have gone wrong yet.
      theme: { background: '#0c0d0f', foreground: '#f4f5f7' } // corrected by the theme port on mount
    })
    this.term.loadAddon(this.fit)
    this.term.loadAddon(this.serializer)

    // Pane frame: a slim header (title · git chip · state · zoom) over the terminal
    // body. Static DOM — every update below is event-driven, nothing per-frame.
    const body = this.mountChrome(host)
    this.term.open(body)

    // WebGL is the wedge — GPU rendering that stays smooth under many streaming agents. But the
    // browser caps live WebGL contexts (~16 per page in Chromium), which is exactly our largest
    // grid — so contexts are MANAGED, not assumed (Phase-2/05): only VISIBLE panes hold one
    // (panes in a hidden background workspace release theirs and fall back to the DOM renderer;
    // they re-acquire on show), and a lost context (cap eviction / GPU reset) self-heals to the
    // DOM renderer with bounded retries instead of leaving a dead pane.
    this.visObs = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1]
      this.visible = last.isIntersecting
      if (this.visible) {
        // Back on screen. A pane that was hidden fitted against a zero-height body and
        // took its stream blind; if it was following its output, it must come back AT
        // that output — entering a workspace must never dump you at the top of every
        // conversation. A pane you deliberately scrolled up keeps its place (`pin` is a
        // no-op unless the anchor is still following).
        this.anchor?.pin()
        // Cancel any pending release (a rapid flip keeps GL warm).
        if (this.glReleaseDebounce) {
          clearTimeout(this.glReleaseDebounce)
          this.glReleaseDebounce = undefined
        }
        this.glLosses = 0
        this.acquireWebgl()
      } else {
        if (this.glDebounce) {
          clearTimeout(this.glDebounce)
          this.glDebounce = undefined
        }
        this.scheduleRelease()
      }
    })
    this.visObs.observe(host)
    this.fit.fit()

    // Every clipboard chord is intercepted here, ahead of the PTY — see handleKey.
    // Ctrl+C / Cmd+C / Ctrl+Insert copy a selection (bare Ctrl+C with none = SIGINT);
    // Ctrl+V / Cmd+V / Ctrl+Shift+V / Shift+Insert paste.
    this.term.attachCustomKeyEventHandler((e) => this.handleKey(e))

    // THE paste path — capture phase, so it runs before xterm's own `paste` listeners
    // (which write clipboard text to the PTY unsanitised). Every way a paste can happen
    // — Chromium's default action for the chord, the macOS Edit-menu key equivalent, a
    // mouse click on Edit > Paste — converges on this one DOM event, so owning it here
    // makes a double paste structurally impossible and guarantees sanitizePaste runs on
    // all of them. handleKey deliberately lets paste chords through UNCANCELLED so the
    // platform generates this event (see the paste branch there).
    body.addEventListener('paste', (e) => this.handleNativePaste(e), true)

    // Copy-on-select (opt-in): mouse-drag a range and it is on the clipboard, X11-style.
    // Guarded on hasSelection so CLEARING a selection never blanks the clipboard.
    //
    // Debounced because onSelectionChange fires on every mousemove of the drag, not once
    // at the end of it: undebounced, dragging over twenty lines would write the clipboard
    // (and push a history entry) twenty times, for twenty prefixes of the text you wanted.
    this.term.onSelectionChange(() => {
      if (!copyOnSelect() || !this.term.hasSelection()) return
      if (this.selectionCopyTimer) clearTimeout(this.selectionCopyTimer)
      this.selectionCopyTimer = setTimeout(() => {
        this.selectionCopyTimer = undefined
        if (!this.term.hasSelection()) return
        const text = this.term.getSelection()
        if (text) void copyText(text, 'terminal')
      }, 120)
    })

    this.mountFileDrop(body)

    // Detached on dispose (clientUnsubs) and guarded on `disposed`: pane ids are reused,
    // and a listener that outlived its pane wrote every byte of the SUCCESSOR pane's
    // stream into a disposed xterm — for the rest of the session.
    this.clientUnsubs.push(
      terminalClient.onData((e) => {
        if (e.id === this.id && !this.disposed) {
          if (!this.liveMarked) {
            this.liveMarked = true
            markPaneLive(this.id) // first PTY output — lineup launches may proceed
          }
          this.term.write(e.data)
        }
      }),
      terminalClient.onExit((e) => {
        if (e.id === this.id && !this.disposed) {
          this.term.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n')
          this.markDead('process exited') // gray dot: nothing lives here anymore
          // No process, no agent: the context bar (and any future session-scoped
          // chrome) must not outlive the pane's process (agent-session port -> the
          // context feature drops every source).
          clearPaneAgentSession(this.id)
        }
      }),
      // Source-aware backend truth (shell/process/explicit agent report) becomes the one
      // renderer projection consumed by Git, workspace persistence, focus and failover.
      terminalClient.onCwd((e) => {
        if (e.id === this.id && !this.disposed) {
          applyPaneCwdEvent(e)
          if (e.locality === 'remote') markPaneRemoteReady(this.id)
        }
      })
    )
    this.term.onData((data) => terminalClient.write({ id: this.id, data }))

    // ResizeObserver is the one true fit driver: it fires for real resizes AND for
    // display flips (hidden→shown reports 0→W), including a window resized while this
    // pane was hidden. Fits are UNGUARDED on purpose — mid-transition style reads can
    // lie for one pass, and the follow-up observation converges to the true size. They
    // are COALESCED, though: the observer fires once per frame through a rail transition
    // or a window drag, and each surviving fit costs the PTY a full ConPTY repaint.
    this.resizeObs = new ResizeObserver(() => this.scheduleRefit())
    this.resizeObs.observe(body)

    // Font-metrics correctness: if any pane measured its cell size against a fallback
    // font (or a stale activation state), its canvas renders narrower than the pane —
    // a dead strip at the right edge. Once ALL faces are active, force a re-measure
    // (fontFamily must actually change to invalidate xterm's char-size cache) + refit.
    void document.fonts?.ready?.then(() => this.remeasureFont())

    // Remote pane (4/05): the workspace manifest published this BEFORE apply, so the
    // spawn itself rides ssh. Local panes are unchanged.
    const remote = getPaneRemote(this.id)
    // The workspace's folder, published by the controller BEFORE it built this pane. This
    // was a hardcoded '', so the shell started in the daemon's OWN directory and only an
    // agent launch (`cd /d "<cwd>" && …`) ever moved it — a plain terminal opened in the
    // app's install folder, whatever the wizard picked. A REMOTE pane sends none: the path
    // is local and would mean nothing on the far side (publishPaneCwds skips those slots).
    const cwd = remote ? '' : (getPaneCwd(this.id) ?? '')
    void terminalClient
      .spawn({
        id: this.id,
        cwd,
        cols: this.term.cols,
        rows: this.term.rows,
        remoteHostId: remote?.hostId,
        remoteCwd: remote?.cwd
      })
      .then((res) => {
        // The pty told us how it grows. Apply BEFORE any output or resize: xterm re-reads
        // windowsPty on every resize, and nothing has resized a non-empty buffer yet.
        const wp = windowsPtyFor(res.pty)
        if (wp && !this.disposed) this.term.options.windowsPty = wp
        // Reattached, not started: the detached daemon still held this pane's session, so
        // its agent is alive and mid-conversation. The restore lineup checks this before
        // typing (agents/index.ts) — otherwise `claude --resume` lands in Claude's prompt.
        // A RESTORED session must NOT carry the mark: it is a fresh shell repainting
        // persisted scrollback (daemon cold start, or the cross-version update
        // migration) — no agent lives in it, so the lineup must type the resume, or the
        // user gets painted history over a dead conversation. Neither may a DISPOSED pane:
        // dispose() scrubs this id's marks (forgetPane), and a spawn landing after that
        // would re-mark an id whose pane is gone — the NEXT pane to take it would take the
        // adopt branch on restore (agents/index.ts), labelling a session that isn't there
        // instead of typing its resume, and the agent would never come back.
        if (res.existing && !res.restored && !this.disposed) markPaneReattached(this.id)
        // The reattach/restore REPLAY arrives right after this: thousands of scrollback
        // lines in a burst, into a grid that is about to be refitted. Land at the end of
        // the conversation, which is the only place it makes sense to land.
        this.anchor?.pin()
        // Second stateSync pull: the spawn just registered/reattached the session, so
        // the backend now KNOWS this pane's state (the mountChrome pull may have run
        // before it existed). Reattach to a busy/attention agent paints correctly here.
        this.syncState?.()
      })
      .catch((err) => {
        // A pane with no pty renders nothing and grows wrong. Never swallow it — and
        // never leave the USER staring at a silently blank pane: say it in the pane,
        // where the missing prompt would have been.
        console.error(`pane ${this.id}: spawn failed`, err)
        if (!this.disposed) {
          const why = err instanceof Error ? err.message : String(err)
          this.term.write(`\x1b[91m[terminal failed to start]\x1b[0m\r\n\x1b[90m${why}\x1b[0m\r\n`)
          this.markDead('terminal failed to start') // never lived — same gray as exited
        }
      })

    // Blink the cursor only while this pane is focused — cuts idle repaints across many panes.
    this.term.textarea?.addEventListener('focus', () => (this.term.options.cursorBlink = true))
    this.term.textarea?.addEventListener('blur', () => (this.term.options.cursorBlink = false))

    // Apply the active theme now (replayed) + on every change (decoupled via the theme port).
    this.themeUnsub = onTerminalTheme((theme) => (this.term.options.theme = theme))

    // Live font-size changes ride the HOUSE metrics path: option change (xterm
    // re-measures) → force refit → PTY resize. No second metrics pipeline (5/06).
    this.fontUnsub = onTerminalFontSize((size) => {
      if (this.term.options.fontSize === size) return
      this.term.options.fontSize = size
      this.refit(true)
    })

    this.blocks = new BlockTracker(this.term, body) // Warp-style command blocks from OSC 133 (02)

    // Agent-exit detection (best effort): the launched agent IS the shell's foreground
    // command, so where the shell emits OSC 133 marks, 133;C is the agent starting and
    // the next 133;D is the agent EXITING back to the prompt — clear the pane's agent
    // session then (the context bar must not outlive the agent it describes). Two
    // guards: C must arrive first (arm), and marks inside a short grace window after
    // the session was set are ignored — a daemon reattach replays prior scrollback,
    // OSC marks included, and those must not read as a live exit. Shells without
    // integration emit no marks: no auto-hide, and never a false one. Registered
    // AFTER BlockTracker so this handler runs FIRST (xterm calls same-ident handlers
    // in reverse registration order); returning false passes the mark on to blocks.
    let agentSetAt = 0
    let agentArmed = false
    this.agentSessionUnsub = onPaneAgentSession((paneId, s) => {
      if (paneId !== this.id) return
      agentSetAt = s ? Date.now() : 0
      agentArmed = false
    })
    this.osc133 = this.term.parser.registerOscHandler(133, (data) => {
      const mark = data[0]
      if (agentSetAt) {
        // Arm on C at ANY time (a fresh launch's C lands within the grace window);
        // only the CLEAR respects the grace, so replayed end-marks never fire it.
        if (mark === 'C') agentArmed = true
        else if (agentArmed && (mark === 'D' || mark === 'A') && Date.now() - agentSetAt > 1500) {
          agentSetAt = 0
          agentArmed = false
          clearPaneAgentSession(this.id)
        }
      }
      return false
    })

    // Focus-follows-selection: when the focus port names this pane (click, keyboard
    // pane-nav, workspace switch), give the terminal real keyboard focus.
    this.focusUnsub = onFocusedPane((f) => {
      if (f?.paneId === this.id && !host.contains(document.activeElement)) this.term.focus()
    })

    this.exposeForDev(host)
  }

  /** Schedule a WebGL attach: a short visibility debounce (rapid workspace churn skips
   *  the work entirely) + the app-wide one-per-frame queue (a reveal never stalls the
   *  main thread). The pane renders via the DOM renderer until its turn. */
  private acquireWebgl(): void {
    if (this.webgl || !this.visible || this.glDebounce || this.glQueued) return
    this.glDebounce = setTimeout(() => {
      this.glDebounce = undefined
      if (!this.visible || this.webgl) return
      this.glQueued = true
      enqueueGlJob(() => {
        this.glQueued = false
        // `disposed` too: an enqueued job cannot be cancelled, so a pane closed inside the
        // ≤1-frame window between enqueue and pump would attach a WebGL addon to a disposed
        // xterm — a context spent against the ~16 the page gets, with no owner left to
        // release it. `visible` is not enough: dispose() never unsets it.
        if (!this.disposed && this.visible && !this.webgl) this.attachWebglNow()
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
      if (this.visible || !this.webgl) return
      enqueueGlJob(() => {
        if (!this.visible) this.releaseWebgl()
      })
    }, 1500)
  }

  /** Leading-edge + trailing-edge coalescer for the ResizeObserver. The first tick of a
   *  burst fits at once (a pane mount or a reveal must not wait REFIT_SETTLE_MS); every
   *  tick after it only pushes the trailing fit out, so a 150 ms transition or a window
   *  drag ends in exactly ONE more fit — and therefore one ConPTY repaint, not one per
   *  frame. xterm keeps its old grid for the duration, which is what every terminal that
   *  debounces its fit does (the transient is a clipped canvas, not a smeared buffer). */
  private scheduleRefit(): void {
    if (this.refitLeading) {
      this.refitLeading = false
      this.refit(true)
    }
    if (this.refitTimer) clearTimeout(this.refitTimer)
    this.refitTimer = setTimeout(() => {
      this.refitTimer = undefined
      this.refitLeading = true
      if (!this.disposed) this.refit(true)
    }, REFIT_SETTLE_MS)
  }

  /** Re-fit the grid to the body and tell the PTY. The default path is cheap by
   *  construction (propose, bail when unchanged/hidden — safe on hot churn paths);
   *  `force` runs a real fit() for the reveal-settle case, where proposeDimensions
   *  has been observed reading stale parent style. */
  private refit(force = false): void {
    try {
      if (force) {
        const before = { cols: this.term.cols, rows: this.term.rows }
        this.fit.fit()
        if (this.term.cols !== before.cols || this.term.rows !== before.rows) {
          terminalClient.resize({ id: this.id, cols: this.term.cols, rows: this.term.rows })
        }
        // A fit REFLOWS the buffer under a viewport nobody asked to move (a reveal, a
        // zoom, a window drag). If this pane was following its output, it still is.
        this.anchor?.pin()
        return
      }
      const d = this.fit.proposeDimensions()
      if (!d || !Number.isFinite(d.cols) || !Number.isFinite(d.rows)) return // hidden
      if (d.cols === this.term.cols && d.rows === this.term.rows) return // nothing changed
      this.term.resize(d.cols, d.rows)
      terminalClient.resize({ id: this.id, cols: this.term.cols, rows: this.term.rows })
      this.anchor?.pin()
    } catch (err) {
      // Never swallow silently — a failing fit is exactly how "the terminal doesn't
      // take its space" bugs hide.
      console.warn(`pane ${this.id}: refit failed`, err)
    }
  }

  /** Invalidate xterm's cached character metrics (the option must CHANGE to trigger a
   *  re-measure) and refit — run once the document's fonts are fully active. */
  private remeasureFont(): void {
    try {
      const fam = this.term.options.fontFamily ?? ''
      this.term.options.fontFamily = fam + ', monospace' // metric-identical, string differs
      this.term.options.fontFamily = fam
      this.refit()
    } catch {
      /* disposed mid-flight */
    }
  }

  /** Attach the WebGL renderer (idempotent; only while visible). On failure the pane simply
   *  stays on the DOM renderer — a pane must always render; fast when it can. */
  private attachWebglNow(): void {
    if (this.webgl || !this.visible) return
    try {
      const addon = new WebglAddon()
      addon.onContextLoss(() => {
        // Evicted (context cap) or GPU reset: drop to the DOM renderer, then retry a few times
        // while visible — self-healing, never a frozen/blank pane (the incumbent's failure mode).
        this.releaseWebgl()
        this.glLosses++
        // Renderer-health signal (counts only) — the wedge metric we must watch in the field.
        getTelemetry().captureEvent({ name: 'gl.context_lost', props: { losses: this.glLosses } })
        if (this.visible && this.glLosses <= 3) {
          this.glRetry = setTimeout(() => this.acquireWebgl(), 1500)
        }
      })
      this.term.loadAddon(addon)
      this.webgl = addon
    } catch (err) {
      console.warn('WebGL renderer unavailable; using default renderer.', err)
    }
  }

  /** Detach the WebGL renderer and release its GPU context (idempotent). xterm falls back to
   *  its DOM renderer, which is fine for a hidden pane (no frames are being painted anyway). */
  private releaseWebgl(): void {
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

  /**
   * The clipboard's authority point. This handler runs BEFORE xterm writes a single
   * byte to the PTY, so returning false means the hosted CLI — Claude Code, Codex,
   * Gemini, a bare shell — never sees the keystroke. That is how our bindings override
   * every provider's own, identically on Windows and macOS, without negotiating with any
   * of them. Nothing below reaches the PTY unless we let it.
   *
   * `preventDefault()` on every consumed chord is LOAD-BEARING, not hygiene. Returning
   * false only makes xterm skip its own keydown handling — it cancels nothing, and
   * Chromium's default action for an uncancelled Ctrl+V on a focused textarea is to fire
   * a native `paste` event. xterm listens for that event and writes the clipboard to the
   * PTY itself (Clipboard.ts wires `paste` on both the textarea and the root element), so
   * without preventDefault every paste ran TWICE — and the second, native run does not
   * strip the ESC[201~ end sentinel, silently bypassing sanitizePaste's paste-jacking
   * guard. Same shape for copy: xterm's native `copy` listener would re-write the
   * clipboard alongside ours. So the split of responsibilities is:
   *
   *   COPY chords are consumed HERE (preventDefault + IPC write): we need the selection
   *   text and the 'terminal' history attribution, and cancelling the keydown keeps
   *   xterm's native copy listener from double-writing the clipboard.
   *
   *   PASTE chords are deliberately NOT consumed. Cancelling them would leave paste
   *   depending on which platform machinery (Chromium default action on Win/Linux, the
   *   Edit-menu key equivalent on macOS) we managed to suppress — the ambiguity that
   *   produced a double paste. Instead the chord passes through uncancelled, the
   *   platform turns it into the single DOM `paste` event, and handleNativePaste owns
   *   that event in the capture phase. One trigger, one event, one sanitised write —
   *   including pastes we never see as keystrokes (Edit > Paste clicked by mouse).
   */
  private handleKey(e: KeyboardEvent): boolean {
    if (e.type !== 'keydown') return true
    const k = e.key.toLowerCase()

    // AltGr. On Windows a German, Brazilian or Nordic layout reports AltGr as
    // ctrlKey+altKey, and AltGr is how those users type @ \ [ ] { } € — every character
    // a developer needs. NO Ctrl-based chord below may fire while Alt is down, or this
    // app would make it impossible to type a backslash in a terminal on a German
    // keyboard. Cmd (mac) is unaffected, hence the split.
    const ctrl = e.ctrlKey && !e.altKey
    // Meta chords are macOS-only: on Windows `metaKey` is the WINDOWS key, and any
    // Win+C/Win+V combo the OS lets through must not be eaten as copy/paste.
    const cmd = IS_MAC && e.metaKey

    // COPY. Cmd+C (mac), Ctrl+Shift+C, and Ctrl+Insert — plus BARE Ctrl+C, but only
    // when there is a selection to copy. With no selection, bare Ctrl+C must fall
    // through as SIGINT: interrupting a runaway agent is not negotiable, and a
    // clipboard feature that ate it would be a regression, not a feature.
    const copyChord =
      (cmd && k === 'c') || (ctrl && e.shiftKey && k === 'c') || (ctrl && k === 'insert')
    const bareCtrlC = ctrl && !e.shiftKey && k === 'c'
    // Guard on the selection TEXT, not hasSelection(): xterm reports a selection RANGE
    // over blank cells as true while getSelection() is ''. Guarding on the range made
    // Ctrl+C over empty cells copy '' — silently WIPING the clipboard — and swallowed
    // the SIGINT the user actually wanted.
    const selectionText = this.term.getSelection()
    if ((copyChord || bareCtrlC) && selectionText) {
      e.preventDefault()
      void copyText(selectionText, 'terminal')
      // Copying consumes the selection, so a second Ctrl+C sends SIGINT as usual —
      // otherwise a stale selection would swallow every interrupt for the rest of the session.
      this.term.clearSelection()
      return false
    }
    if (copyChord) {
      e.preventDefault()
      return false // an explicit copy chord with nothing selected is a no-op, not input
    }

    // PASTE. Cmd+V, Ctrl+Shift+V, Shift+Insert — and BARE Ctrl+V, which is what people
    // actually press. Ctrl+V's terminal meaning (literal-next, `quoted-insert`) is a
    // readline nicety almost nobody invokes on purpose; the user asked for paste, and
    // paste is what the rest of the desktop does with that chord.
    const pasteChord =
      (cmd && k === 'v') ||
      (ctrl && e.shiftKey && k === 'v') ||
      (e.shiftKey && !e.ctrlKey && !e.altKey && k === 'insert') ||
      (ctrl && !e.shiftKey && k === 'v')
    if (pasteChord) {
      // Return false WITHOUT preventDefault: false keeps xterm's keydown machinery out
      // (it would otherwise type a literal ^V and cancel the event itself), while the
      // uncancelled default action becomes the one `paste` event handleNativePaste owns.
      // Only chords with NO native trigger paste via IPC: on macOS, Chromium binds no
      // editing action to Ctrl-based combos — Cmd+V is the mac paste, via the Edit menu.
      if (IS_MAC && !cmd) {
        e.preventDefault()
        void this.pasteFromClipboard().catch(() => undefined)
      }
      return false
    }

    // Alt+Up / Alt+Down: jump between command blocks (02).
    if (e.altKey && (k === 'arrowup' || k === 'arrowdown')) {
      this.blocks?.jump(k === 'arrowdown' ? 1 : -1)
      return false
    }
    return true
  }

  /** The paste choke point (capture phase — see the listener registration). Consumes the
   *  event so xterm's own unsanitised paste listener never runs, then types the payload
   *  into the PTY wrapped in bracketed paste when the foreground program asked for it
   *  (xterm tracks the DECSET 2004 mode the shell or agent CLI set). */
  private handleNativePaste(e: ClipboardEvent): void {
    e.preventDefault()
    e.stopImmediatePropagation()
    const text = e.clipboardData?.getData('text/plain') ?? ''
    if (!text) return
    terminalClient.write({ id: this.id, data: sanitizePaste(text, this.term.modes.bracketedPasteMode) })
  }

  /** IPC fallback for paste chords with no native trigger (macOS Ctrl-combos only —
   *  everywhere else the platform emits a `paste` event and handleNativePaste owns it). */
  private async pasteFromClipboard(): Promise<void> {
    const text = await readText()
    if (!text) return
    const bracketed = this.term.modes.bracketedPasteMode
    terminalClient.write({ id: this.id, data: sanitizePaste(text, bracketed) })
  }

  /**
   * Drop a file — from Finder, Explorer, VS Code's tree, anywhere — and its absolute
   * path is typed into this pane, quoted for the shell we actually spawned. Nothing is
   * executed: the path lands as text at the cursor, exactly as if it had been typed, so
   * it works the same whether the pane holds a bare shell or an agent CLI's prompt.
   *
   * `dragleave` fires every time the cursor crosses into a CHILD element (xterm nests
   * several layers of canvas and helper divs), so a naive enter/leave pair strobes the
   * overlay. We count enters and leaves instead, and only hide at zero — the standard
   * fix, and the reason this is more than three lines.
   */
  private mountFileDrop(body: HTMLElement): void {
    const overlay = document.createElement('div')
    overlay.className = 'pane-drop'
    overlay.hidden = true
    const card = document.createElement('div')
    card.className = 'pane-drop-card'
    // The glyph sits in a pulsing accent ring — the card's one moving element, so the
    // eye lands on WHERE to drop, not on chrome.
    const ring = document.createElement('div')
    ring.className = 'pane-drop-ring'
    ring.append(icon('download', 22))
    const title = document.createElement('div')
    title.className = 'pane-drop-title'
    const hint = document.createElement('div')
    hint.className = 'pane-drop-hint'
    hint.textContent = 'Full path, quoted for this shell — nothing runs.'
    card.append(ring, title, hint)
    overlay.append(card)
    body.append(overlay)

    // ONE source of truth. Earlier revisions tracked visibility across `depth`, the
    // `hidden` attribute and the `is-active` class, and every bug lived in the gaps
    // between them: a show and a hide batched into one frame left the card stranded on
    // screen, because the deferred rAF re-added `is-active` after the hide had run.
    // `visible` decides; `gen` invalidates any async work a newer transition supersedes.
    let depth = 0
    let visible = false
    let gen = 0

    const show = (n: number): void => {
      title.textContent = n === 1 ? 'Drop to insert path' : `Drop to insert ${n} paths`
      if (visible) return
      visible = true
      const mine = ++gen
      overlay.hidden = false
      // Next frame, so the transition has a start state to animate FROM — unless a hide
      // has already overtaken us, in which case this frame belongs to no one.
      requestAnimationFrame(() => {
        if (gen === mine && visible) overlay.classList.add('is-active')
      })
    }

    const hide = (): void => {
      depth = 0
      if (!visible) return
      visible = false
      const mine = ++gen
      overlay.classList.remove('is-active')
      // Keep it in the tree until the fade finishes, then take it out of hit-testing.
      // `transitionend` never fires if the pane was hidden mid-drag, hence the timeout;
      // `gen` stops a stale timeout from hiding an overlay a newer drag just raised.
      const done = (): void => {
        if (gen === mine && !visible) overlay.hidden = true
      }
      overlay.addEventListener('transitionend', done, { once: true })
      setTimeout(done, 220)
    }

    // Only react to a drag that actually carries files. Dragging selected TEXT from
    // another app also fires these events, and must not put up a "drop a file" card.
    const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer?.types.includes('Files')
    // …or a row dragged out of OUR explorer (11/06). It is recognised by a private
    // dataTransfer type, NEVER by text/plain: a drag of arbitrary text from another app
    // must never type itself into a terminal, and only our own marker can say otherwise.
    const hasOurPath = (e: DragEvent): boolean => !!e.dataTransfer?.types.includes(EXPLORER_DRAG_TYPE)
    const accepts = (e: DragEvent): boolean => hasFiles(e) || hasOurPath(e)

    body.addEventListener('dragenter', (e) => {
      if (!accepts(e)) return
      e.preventDefault()
      depth++
      show(hasOurPath(e) ? 1 : (e.dataTransfer?.items.length ?? 1))
    })
    body.addEventListener('dragover', (e) => {
      if (!accepts(e)) return
      e.preventDefault() // without this the drop event never fires
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      // Self-heal: dragover fires continuously while the cursor is inside, so however the
      // counter got out of step, the overlay comes back rather than staying silently off.
      if (!visible) {
        depth = Math.max(depth, 1)
        show(hasOurPath(e) ? 1 : (e.dataTransfer?.items.length ?? 1))
      }
    })
    body.addEventListener('dragleave', (e) => {
      if (!accepts(e)) return
      // The COUNTER is authoritative, not `relatedTarget`. dragleave fires each time the
      // cursor crosses into one of xterm's nested canvas/helper layers, and Chromium does
      // not reliably name where the cursor went — trusting relatedTarget here made the
      // card strobe once per child boundary. Counting enters against leaves does not care.
      depth = Math.max(0, depth - 1)
      if (depth === 0) hide()
    })
    body.addEventListener('drop', (e) => {
      if (!accepts(e)) return
      e.preventDefault()
      hide()
      if (hasOurPath(e)) {
        // The explorer already quoted it for this machine's shell, and the quoter strips
        // control characters — so this cannot carry a newline, and therefore cannot press
        // Enter. Typed at the cursor, padded like a dropped file. Nothing runs.
        const text = e.dataTransfer?.getData('text/plain') ?? ''
        if (text) {
          terminalClient.write({ id: this.id, data: ' ' + text + ' ' })
          this.term.focus()
        }
        return
      }
      void this.insertDroppedPaths(Array.from(e.dataTransfer?.files ?? []))
    })
    // A drag abandoned with Esc, or ended outside the window, fires neither dragleave nor
    // drop on this element. Without these the card would hang there until the next drag.
    // Bound to WINDOW, so they must die with the pane — a closed pane's listener would
    // otherwise live as long as the app, once per pane ever opened.
    for (const type of ['dragend', 'drop', 'blur'] as const) {
      window.addEventListener(type, () => hide(), { signal: this.dropAbort.signal })
    }
  }

  /** Resolve dropped Files to absolute paths, quote them for the pane's shell, and type
   *  them at the cursor. Electron removed `File.path` in v32, so the preload's
   *  `getPathForFile` is the only route — and a browser-hosted gallery has neither. */
  private async insertDroppedPaths(files: File[]): Promise<void> {
    if (!files.length) return
    const resolve = getBridge().getPathForFile
    if (!resolve) {
      showToast({ tone: 'danger', title: 'Drag-and-drop needs the desktop app' })
      return
    }
    // Per-file try/catch: getPathForFile THROWS for a File with no disk backing (a
    // synthetic DataTransfer, some browser-internal drags). One virtual file must not
    // void a drop that also carried real ones.
    const paths = files
      .map((f) => {
        try {
          return resolve(f)
        } catch {
          return ''
        }
      })
      .filter(Boolean)
    if (!paths.length) return

    // A REMOTE pane's shell lives on the ssh host, not this machine: quote for POSIX
    // (this app's remote panes ride ssh), and say plainly that the path itself is local —
    // inserting C:\Users\... into a Linux shell is only useful if a share mounts it.
    const remote = getPaneRemote(this.id)
    const quoted = remote ? quoteWithFlavor(paths, 'posix') : await quoteDroppedPaths(paths)
    if (remote) {
      showToast({
        tone: 'info',
        title: 'This pane is remote',
        body: 'The inserted path points at a file on THIS machine — the remote host cannot see it unless a mount shares it.'
      })
    }
    // Padded on BOTH sides (user-specified): the leading space detaches the path from
    // whatever is already at the cursor, the trailing one starts the next argument.
    terminalClient.write({ id: this.id, data: ' ' + quoted + ' ' })
    this.term.focus()

    // Remembered in the Clipboard tab, but NOT put on the system clipboard — a drag is
    // not a copy, and clobbering what the user had copied would be a surprise.
    void recordDrop(paths, quoted)
  }

  /** Dead pane, dead dot: gray — deliberately NOT one of the three live colors, so
   *  the last live state can't linger as a lie on a pane with no process. Also drops
   *  the pane from the attention aggregation (a dead pane must not ring its tab).
   *  Only for a VISIBLE (tracked) dot: an untracked pane has no dot to gray. */
  private markDead(title: string): void {
    if (this.stateDot && !this.stateDot.hidden) {
      this.stateDot.dataset.state = 'exited'
      this.stateDot.title = title
    }
    clearPaneState(this.id)
  }

  /** Pane chrome — the terminal top bar, an exact take on the reference:
   *  LEFT   ✳ state glyph (the LEADING glyph) + optional remote/role/claims/mcp chips +
   *         the task title the agent set (OSC 0/2), else its label;
   *  CENTER the read-only git branch chip;
   *  RIGHT  [⋯ menu] [expand full] [expand horizontal] [expand vertical] [× close].
   *  The real DOM contracts are .pane-label (agentlaunch-smoke) and .pane-state
   *  (milestone/state smokes); .pane-badge is NOT one — zero smokes reference it
   *  (REMOVE #11). Returns the terminal body. */
  private mountChrome(host: HTMLElement): HTMLElement {
    const header = document.createElement('div')
    header.className = 'pane-header'

    // Left: state dot (leading) + chips + title. `.pane-badge` stays on the class list
    // but carries no rule (REMOVE #11 dropped it) — kept only to avoid churn on the attr.
    const left = document.createElement('div')
    left.className = 'pane-head-left pane-badge'
    const state = document.createElement('span')
    state.className = 'pane-state'
    state.dataset.state = 'idle'
    state.title = 'idle'
    // AVAILABILITY gate: hidden until this pane runs a provider the app wired
    // end-to-end (a launcher session; custom:<cmd> and plain shells stay untracked —
    // a dot that cannot know would sit on a yellow lie). The session subscription
    // registered with the state wiring below unhides it; smokes driving OSC into
    // plain panes adopt a session first (__mogging.agents.adopt).
    state.hidden = true
    this.stateDot = state // the exit paths (mount) gray it out via markDead
    const title = document.createElement('span')
    title.className = 'pane-title pane-label'
    title.title = 'Double-click to rename'
    // Swarm role chip (4/01) — named by the workspace manifest via the pane-meta port.
    const role = document.createElement('span')
    role.className = 'pane-role'
    role.hidden = true
    const applyRole = (r: string): void => {
      role.textContent = r
      role.title = r // bug #9: the full role on hover, now the chip ellipsises at 88px
      role.dataset.role = r.toLowerCase() // styling hook only — smokes read textContent
      role.hidden = !r
    }
    const existingRole = getPaneRole(this.id)
    if (existingRole) applyRole(existingRole)
    this.roleUnsub = onPaneRole((paneId, r) => {
      if (paneId === this.id) applyRole(r)
    })
    // Remote chip (4/05): WHERE this pane lives — visible at a glance, distinct tint.
    // Built here but appended IN ORDER below (bug #12): the state dot must stay the
    // leading glyph. This used to left.append() ahead of everything, so on a remote pane
    // the dot was no longer first — contradicting this header's contract and the
    // leading-dot note in global.css.
    let remoteChip: HTMLSpanElement | undefined
    if (getPaneRemote(this.id)) {
      remoteChip = document.createElement('span')
      remoteChip.className = 'pane-remote'
      remoteChip.append(
        icon('globe', 12),
        document.createTextNode(getPaneRemote(this.id)?.name ?? '')
      )
      remoteChip.title = 'Remote pane (ssh) — local repo tools are off'
    }
    // Ownership chip (4/02): how many globs THIS pane holds; live via ledger pushes.
    const claimsChip = document.createElement('span')
    claimsChip.className = 'pane-claims'
    claimsChip.hidden = true
    claimsChip.title = 'Files this agent owns (see ⋯ -> Show claims)'
    const applyClaims = (): void => {
      const n = claimsFor(this.id).length
      claimsChip.replaceChildren(icon('flag', 12), document.createTextNode(String(n)))
      claimsChip.hidden = n === 0
    }
    applyClaims()
    this.claimsUnsub = onClaimsChange(applyClaims)
    // MCP status chip (8/11): connected count for this pane's CLI; attention on
    // needs-auth/error; a restart nudge when tools connected after launch.
    const mcpChip = document.createElement('span')
    mcpChip.className = 'pane-mcp'
    mcpChip.hidden = true
    const applyMcp = (): void => {
      const c = mcpChipForPane(this.id)
      if (!c || (c.connected === 0 && !c.attention && c.restartNew === 0)) {
        mcpChip.hidden = true
        return
      }
      mcpChip.hidden = false
      mcpChip.classList.toggle('is-attention', c.attention)
      mcpChip.classList.toggle('is-restart', c.restartNew > 0)
      mcpChip.textContent = c.restartNew > 0 ? `restart +${c.restartNew}` : c.attention ? `mcp !` : `mcp ${c.connected}`
      mcpChip.title = c.restartNew > 0 ? `Restart to pick up ${c.restartNew} new tool${c.restartNew === 1 ? '' : 's'}` : c.attention ? 'A tool needs re-authorization (Settings › MCP servers)' : `${c.connected} MCP tools connected`
    }
    applyMcp()
    this.mcpUnsub = onMcpStatusChange(applyMcp)
    // Agent context gauge: how full the pane's agent conversation window is, live
    // off the context port (session-log tail + statusline relay — counts only,
    // never content). Claude Code's OWN indicator, verbatim (assets/Inspiration/
    // context.png): the moon disc followed by "62% used" — ONE form at every pane
    // width, no bar variant. It exists only while an actual agent session does
    // (the agent-session lifecycle feeds the port and clears it on every exit
    // path). Color is a ramp, not a flag: the disc's arc goes green -> warning at
    // 60 -> danger at 90 ("amber means look, red means act"); the text stays
    // quiet like the reference.
    const ctx = document.createElement('span')
    ctx.className = 'pane-context'
    ctx.hidden = true
    const ctxDisc = document.createElement('span')
    ctxDisc.className = 'ctx-disc'
    const ctxPct = document.createElement('span')
    ctxPct.className = 'ctx-pct'
    ctx.append(ctxDisc, ctxPct)
    const fmtTok = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
    const applyContext = (u: PaneContext): void => {
      if (!u) {
        ctx.hidden = true
        return
      }
      ctx.hidden = false
      // PENDING: the agent just launched and its log has no usage line yet (that
      // arrives with the first response). The gauge shows up EMPTY with a "–" —
      // present from the moment the agent is, but never a made-up number.
      if (u === 'pending') {
        ctx.style.setProperty('--ctx', '0')
        ctxPct.textContent = '–'
        ctx.classList.remove('is-warn', 'is-hot')
        ctx.title = 'Agent context: waiting for the session’s first response'
        return
      }
      // The DISC is a fraction of a circle, so it stops at full. The NUMBER does not: a gemini
      // pane whose prompt has outgrown its window says "101% used" in its own footer, and the
      // header must say the same thing rather than a comfortable lie (context.ipc.ts).
      ctx.style.setProperty('--ctx', String(Math.min(100, u.usedPct))) // drives the disc's sweep
      // A seeded baseline (pre-first-response) is an approximation and SAYS so: "~".
      ctxPct.textContent = `${u.approx ? '~' : ''}${u.usedPct}% used`
      ctx.classList.toggle('is-warn', u.usedPct >= 60 && u.usedPct < 90)
      ctx.classList.toggle('is-hot', u.usedPct >= 90)
      ctx.title =
        `Agent context: ${u.approx ? '~' : ''}${u.usedPct}% used — ~${fmtTok(u.usedTokens)} of ${fmtTok(u.windowTokens)} tokens` +
        (u.model ? ` (${u.model})` : '') +
        (u.approx ? '\nBaseline from the previous session — refines on the first response' : '')
    }
    applyContext(getPaneContext(this.id))
    this.ctxUnsub = onPaneContext((paneId, usage) => {
      if (paneId === this.id) applyContext(usage)
    })
    // Provider mark (WHO runs in this pane): the launched agent's logo, alive only
    // while its session is — same lifetime as the context bar. Decorative (the
    // title carries the words); hidden for plain shells.
    const agentChip = document.createElement('span')
    agentChip.className = 'pane-agent'
    agentChip.hidden = true
    const applyAgentChip = (provider: string | null): void => {
      agentChip.replaceChildren()
      agentChip.hidden = !provider
      agentChip.removeAttribute('role')
      agentChip.removeAttribute('aria-label')
      if (provider) {
        agentChip.append(providerLogo(provider, 18)) // matches the bar's ~1.65× chip scale
        const label = provider.startsWith('custom:') ? provider.slice('custom:'.length) : provider
        agentChip.title = label
        // The logo component is deliberately aria-hidden. At the compact floor the
        // neighbouring title retires, so the surviving identity mark must name itself.
        agentChip.setAttribute('role', 'img')
        agentChip.setAttribute('aria-label', `Agent CLI: ${label}`)
      }
    }
    applyAgentChip(getPaneAgentSession(this.id)?.provider ?? null)
    this.agentChipUnsub = onPaneAgentSession((paneId, s) => {
      if (paneId === this.id) applyAgentChip(s?.provider ?? null)
    })
    // Ordered, state dot FIRST (the leading glyph). Remote sits right after it — WHERE
    // before the agent mark (WHO), then the role/claims/mcp attributes — then the title.
    // The context gauge is NOT here: it reads as pane STATUS, not identity, so it
    // lives on the RIGHT, leading the action cluster (appended there below).
    left.append(state, ...(remoteChip ? [remoteChip] : []), agentChip, role, claimsChip, mcpChip, title)

    // Center: branch chip — a branch icon + name (soft chip, like the reference bar).
    const git = document.createElement('span')
    git.className = 'pane-git'
    const branch = document.createElement('span')
    branch.className = 'pane-branch'
    const worktree = document.createElement('span')
    worktree.className = 'pane-worktree'
    const worktreeName = document.createElement('span')
    worktree.append(icon('folder', 10), worktreeName)
    const dirty = document.createElement('span')
    dirty.className = 'pane-dirty'
    const gitState = document.createElement('span')
    gitState.className = 'pane-git-state'
    const gitStaged = document.createElement('span')
    gitStaged.className = 'pane-git-staged'
    const gitComparison = document.createElement('span')
    gitComparison.className = 'pane-git-comparison'
    git.append(icon('git-branch', 12), branch, worktree, dirty, gitState, gitStaged, gitComparison)

    // Right: menu + expand trio + close.
    const actions = document.createElement('div')
    actions.className = 'pane-actions'
    const act = (
      name: IconName,
      label: string,
      onClick: (e: MouseEvent) => void,
      extraClass = ''
    ): HTMLButtonElement => {
      const b = document.createElement('button')
      b.className = `pane-act${extraClass ? ' ' + extraClass : ''}`
      b.type = 'button'
      b.title = label
      b.setAttribute('aria-label', label)
      b.append(icon(name, 12))
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        onClick(e)
      })
      return b
    }
    const expand = (mode: 'full' | 'col' | 'row'): void => {
      host.dispatchEvent(
        new CustomEvent('mogging:expand-pane', { bubbles: true, detail: { paneId: this.id, mode } })
      )
    }
    // Each expand button carries data-expand=<mode>. The grid stamps the ACTIVE mode on
    // the slot (data-expand-mode, grid-layout.ts) and global.css matches the pair, so
    // the control that put the pane in its current mode reads PRESSED — tint + glow.
    // Because that click now means "restore the grid", the button also TELLS the truth:
    // both glyphs live in the DOM (the expand icon + its contract inverse) and the same
    // CSS pair picks one — glow and glyph ride a single attribute, so they can never
    // disagree. Tooltip/aria mirror via the observer below (CSS can't write attributes).
    const expandBtns: HTMLButtonElement[] = []
    const expandAct = (
      name: IconName,
      contractName: IconName,
      label: string,
      restoreLabel: string,
      mode: 'full' | 'col' | 'row'
    ): HTMLButtonElement => {
      const b = act(name, label, () => expand(mode), 'pane-act-expand')
      b.dataset.expand = mode
      b.dataset.labelExpand = label
      b.dataset.labelRestore = restoreLabel
      b.setAttribute('aria-pressed', 'false')
      b.querySelector('svg')?.classList.add('glyph-expand')
      const alt = icon(contractName, 12)
      alt.classList.add('glyph-restore')
      b.append(alt)
      expandBtns.push(b)
      return b
    }
    const slotEl = host.closest('.layout-slot') as HTMLElement | null
    const menu = document.createElement('div')
    menu.id = `pane-menu-${this.id}`
    menu.className = 'menu pane-menu'
    menu.setAttribute('role', 'menu')
    menu.setAttribute('aria-label', 'Pane details and actions')
    menu.hidden = true

    let menuBtn: HTMLButtonElement
    let menuFactsObserver: MutationObserver | undefined
    let menuVisibilityObserver: MutationObserver | undefined
    let startMenuWatch = (): void => undefined
    const menuEntries = (): HTMLElement[] =>
      Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    const focusEntry = (entry: HTMLElement | undefined): void => {
      if (!entry) return
      for (const other of menuEntries()) other.tabIndex = other === entry ? 0 : -1
      entry.focus()
    }
    const closeMenu = (returnFocus = true): void => {
      if (menu.hidden) return
      menu.hidden = true
      menuBtn.setAttribute('aria-expanded', 'false')
      menuFactsObserver?.disconnect()
      menuVisibilityObserver?.disconnect()
      if (returnFocus && menuBtn.isConnected) menuBtn.focus()
    }
    const positionMenu = (): void => {
      const anchor = menuBtn.getBoundingClientRect()
      const rect = menu.getBoundingClientRect()
      const pad = 8
      const gap = 4
      const left = Math.max(pad, Math.min(anchor.right - rect.width, window.innerWidth - rect.width - pad))
      const below = anchor.bottom + gap
      const above = anchor.top - rect.height - gap
      const top = below + rect.height <= window.innerHeight - pad ? below : Math.max(pad, above)
      menu.style.left = `${Math.round(left)}px`
      menu.style.top = `${Math.round(top)}px`
    }
    menuBtn = act(
      'more',
      'Pane menu',
      () => {
        if (!menu.hidden) return closeMenu(true)
        this.buildMenu(menu, closeMenu, title.textContent?.trim() ?? '', slotEl?.dataset.expandMode, host)
        menu.scrollTop = 0
        menu.hidden = false
        menuBtn.setAttribute('aria-expanded', 'true')
        positionMenu()
        focusEntry(menu.querySelector<HTMLElement>('.menu-item') ?? menuEntries()[0])
        startMenuWatch()
      },
      'pane-act-menu'
    )
    menuBtn.setAttribute('aria-haspopup', 'menu')
    menuBtn.setAttribute('aria-expanded', 'false')
    menuBtn.setAttribute('aria-controls', menu.id)

    menu.addEventListener('keydown', (e) => {
      const entries = menuEntries()
      const at = entries.indexOf(document.activeElement as HTMLElement)
      const move = (next: number): void => {
        e.preventDefault()
        focusEntry(entries[(next + entries.length) % entries.length])
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeMenu(true)
      } else if (e.key === 'Tab') {
        // Hand normal tab order back to the pane controls. Moving focus to the
        // opener before hiding the portaled menu lets the browser advance to the
        // next/previous control instead of restarting at the document root.
        menuBtn.focus()
        closeMenu(false)
      } else if (entries.length && e.key === 'ArrowDown') move(at < 0 ? 0 : at + 1)
      else if (entries.length && e.key === 'ArrowUp') move(at < 0 ? entries.length - 1 : at - 1)
      else if (entries.length && e.key === 'Home') move(0)
      else if (entries.length && e.key === 'End') move(entries.length - 1)
      else if (entries.length && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const key = e.key.toLocaleLowerCase()
        const ordered = entries.slice(at + 1).concat(entries.slice(0, at + 1))
        const hit = ordered.find((entry) => (entry.textContent ?? '').trim().toLocaleLowerCase().startsWith(key))
        if (hit) {
          e.preventDefault()
          focusEntry(hit)
        }
      }
    })

    const closeFromOutside = (e: Event): void => {
      if (menu.hidden || !(e.target instanceof Node) || menu.contains(e.target) || menuBtn.contains(e.target)) return
      closeMenu(false)
    }
    const closeFromViewportChange = (): void => closeMenu(menu.contains(document.activeElement))
    const closeFromWindowBlur = (): void => closeMenu(false)
    document.addEventListener('pointerdown', closeFromOutside, true)
    window.addEventListener('blur', closeFromWindowBlur)
    window.addEventListener('resize', closeFromViewportChange)
    const scrollHost = host.closest<HTMLElement>('.layout-scroll-host')
    scrollHost?.addEventListener('scroll', closeFromViewportChange, { passive: true })
    const workspaceView = host.closest<HTMLElement>('.workspace-view')
    if (workspaceView) {
      const closeWhenWorkspaceHides = (): void => {
        if (workspaceView.classList.contains('active') && !workspaceView.hidden) return
        const focused = menu.contains(document.activeElement)
        const active = document.activeElement
        closeMenu(false)
        // The opener belongs to the workspace that just disappeared, so returning
        // focus there would be worse than dropping it. Explicitly release a focused
        // portaled entry; the newly active workspace owns the next focus decision.
        if (focused && active instanceof HTMLElement) active.blur()
      }
      menuVisibilityObserver = new MutationObserver(closeWhenWorkspaceHides)
    }
    document.body.append(menu)
    this.menuCleanup = (): void => {
      document.removeEventListener('pointerdown', closeFromOutside, true)
      window.removeEventListener('blur', closeFromWindowBlur)
      window.removeEventListener('resize', closeFromViewportChange)
      scrollHost?.removeEventListener('scroll', closeFromViewportChange)
      menuFactsObserver?.disconnect()
      menuVisibilityObserver?.disconnect()
      menu.remove()
    }
    // The expand trio carries `pane-act-expand`: it is the THIRD thing the bar gives up
    // when it runs out of room (after the gauge's "% used" text and the branch chip),
    // and the @container rules in global.css need a hook to retire it. Everything
    // retired survives in the ⋯ menu — see buildMenu.
    // The context gauge LEADS the cluster (user ask: the visual lives on the right):
    // status beside the controls, never between them and the pane edge.
    actions.append(
      ctx,
      menuBtn,
      expandAct('expand', 'contract', 'Expand to whole workspace (Ctrl+Shift+Enter)', 'Restore grid (Ctrl+Shift+Enter)', 'full'),
      expandAct('expand-h', 'contract-h', 'Expand across full width', 'Restore grid', 'row'),
      expandAct('expand-v', 'contract-v', 'Expand to full height', 'Restore grid', 'col'),
      act(
        'x',
        'Close terminal',
        () =>
          host.dispatchEvent(
            new CustomEvent('mogging:close-pane', { bubbles: true, detail: { paneId: this.id } })
          ),
        'pane-act-close'
      )
    )

    // Tooltip/aria half of the trio's truth-telling: when the slot's stamped mode
    // matches a button, its label flips to the restore wording and aria-pressed goes
    // true. A MutationObserver on the ONE attribute the grid writes — the same signal
    // the CSS reads — so every path (trio click, ⋯ menu, Ctrl+Shift+Enter, implicit
    // clears on split/close/template) lands here with no extra plumbing.
    const syncExpandLabels = (): void => {
      const active = slotEl?.dataset.expandMode
      for (const b of expandBtns) {
        const on = b.dataset.expand === active
        const label = (on ? b.dataset.labelRestore : b.dataset.labelExpand) ?? ''
        b.title = label
        b.setAttribute('aria-label', label)
        b.setAttribute('aria-pressed', String(on))
      }
    }
    if (slotEl) {
      this.expandStateObs = new MutationObserver(syncExpandLabels)
      this.expandStateObs.observe(slotEl, { attributes: true, attributeFilter: ['data-expand-mode'] })
      syncExpandLabels() // adopt a mode the slot already holds at mount
    }

    // The header itself is the size-query container. Its child owns the grid so the
    // compact query can tighten column gaps; CSS cannot query and restyle a container
    // element with its own dimensions.
    const headerGrid = document.createElement('div')
    headerGrid.className = 'pane-header-grid'
    headerGrid.append(left, git, actions)
    header.append(headerGrid)
    // Menu facts are a snapshot rebuilt on open. If any live header fact changes
    // underneath an open portal (state, title, agent, context, MCP, claims or git),
    // close it so it can never continue presenting stale status. The menu button's
    // own aria-expanded mutation is merely open/close bookkeeping and is ignored.
    menuFactsObserver = new MutationObserver((records) => {
      const bookkeepingOnly = records.every(
        (record) =>
          record.type === 'attributes' && record.target === menuBtn && record.attributeName === 'aria-expanded'
      )
      if (!bookkeepingOnly) closeMenu(false)
    })
    // These observers are useful only while the snapshot is visible. Keeping one
    // subtree observer hot per pane made normal 16-pane status traffic pay menu costs
    // even though every menu was closed (and showed up as a long frame in MILESTONE).
    startMenuWatch = (): void => {
      menuFactsObserver?.observe(headerGrid, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true
      })
      if (workspaceView) {
        menuVisibilityObserver?.observe(workspaceView, {
          attributes: true,
          attributeFilter: ['class', 'hidden']
        })
      }
    }

    const body = document.createElement('div')
    body.className = 'pane-body'
    host.append(header, body)

    // The anchor comes FIRST: the pane follows its newest output unless a human says
    // otherwise (pane-anchor.ts), and the slide bar is one of the humans who can say it.
    this.anchor = createPaneAnchor(this.term, body)
    // The slide bar + jump pill (pane-scrollbar.ts) replace the native scrollbar with an
    // overlay one: invisible until you reach into its lane or the viewport moves, a
    // full-height grabbable rail, and a one-tap return to following the latest output.
    this.scrollbar = createPaneScrollbar(this.term, body, this.anchor)

    // Title precedence: what the agent says it's doing (OSC 0/2 window title) → the
    // launched agent's label → "Terminal N".
    const fallback = `Terminal ${this.id % 100 || this.id}`
    let oscTitle = ''
    const applyTitle = (): void => {
      const label = getPaneLabel(this.id) ?? ''
      const text = oscTitle || label || fallback
      title.textContent = text
      title.title = text
      title.classList.toggle('has-label', !!(oscTitle || label))
    }
    const applyLabel = (_text: string): void => applyTitle()
    applyTitle()
    this.term.onTitleChange((t) => {
      // Strip a LEADING decorative spark: Claude Code titles itself "✳ Claude Code"
      // (and "✶/✻ <task>" while working), but the header already shows the provider
      // logo chip right before the title — glyph + logo read as two marks (the
      // "too many logos" report). The words stay; only the duplicate mark goes.
      oscTitle = (t ?? '').trim().replace(/^[✳✶✻✽✢·∗*]+\s*/u, '')
      applyTitle()
    })

    // Rename (double-click or menu): a body-portaled dialog, so a compact pane never
    // has to fit an editor inside the title track it deliberately retired.
    const rename = (): void => {
      if (this.renameModal?.isOpen()) {
        const existing = this.renameModal.el.querySelector<HTMLInputElement>('.pane-title-input')
        existing?.focus()
        existing?.select()
        return
      }
      const input = document.createElement('input')
      input.className = 'input pane-title-input'
      input.value = getPaneLabel(this.id) ?? ''
      input.setAttribute('aria-label', 'Pane name')

      const field = document.createElement('label')
      field.className = 'pane-rename-field'
      const fieldLabel = document.createElement('span')
      fieldLabel.textContent = 'Pane name'
      field.append(fieldLabel, input)

      const modal: ModalHandle = createModal({
        title: 'Rename pane',
        width: 380,
        body: field,
        onClose: () => {
          if (this.renameModal === modal) this.renameModal = undefined
        }
      })
      this.renameModal = modal
      const commit = (): void => {
        setPaneLabel(this.id, input.value.trim())
        oscTitle = '' // a manual name takes over from the agent's task title
        applyTitle()
        getTelemetry().captureEvent({ name: 'pane.renamed' }) // never the text
        modal.close()
      }
      const footer = document.createElement('div')
      footer.className = 'pane-rename-actions'
      footer.append(
        Button({ label: 'Cancel', variant: 'ghost', onClick: () => modal.close() }),
        Button({ label: 'Save', variant: 'primary', onClick: commit })
      )
      modal.setFooter(footer)
      input.addEventListener('keydown', (e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        }
      })
      modal.open()
      input.select()
    }
    title.addEventListener('dblclick', rename)
    this.renameFn = rename

    // Read-only git chip (2/03): the `git` feature publishes status on the git port; we
    // just render it. Nothing here mutates a repo.
    const applyGit = (status: GitStatus | null): void => {
      if (!status) {
        git.classList.remove('has-git')
        return
      }
      const display = displayGitStatus(status)
      branch.textContent = display.branchLabel
      worktreeName.textContent = display.worktreeLabel
      worktree.hidden = !display.worktreeLabel
      gitState.textContent = display.stateLabel
      gitStaged.textContent = display.stagedLabel
      gitStaged.hidden = !display.stagedLabel
      gitComparison.textContent = display.comparisonLabel
      gitComparison.hidden = !display.comparisonLabel
      git.title = display.title
      git.setAttribute('aria-label', display.title.replace(/\n/g, '. '))
      git.classList.toggle('dirty', display.tone === 'dirty')
      git.classList.toggle('conflicted', display.tone === 'conflict')
      git.classList.toggle('unavailable', display.tone === 'unknown')
      git.classList.add('has-git')
    }
    applyGit(getPaneGit(this.id))

    // ONE painter for both halves of the dot's reliability contract: the push path
    // (state change events) and the pull path (stateSync below). 'exited' is
    // terminal — this instance's PTY never comes back, so neither a stale in-flight
    // event nor a late sync answer may repaint a dead pane as live.
    // The dot RENDERS FROM THE PORT, not from the event that woke it: the port also
    // owns the sticky finished flag ("green until the pane is clicked"), and painting
    // from the one truth keeps dot, rail and pulses agreeing. paintState re-runs on
    // every port change, so a click's acknowledgeFinished repaints idle right here.
    const paintState = (): void => {
      if (this.disposed || state.dataset.state === 'exited') return
      const st = paneState(this.id)
      const fin = st === 'idle' && paneFinished(this.id)
      state.dataset.state = fin ? 'finished' : st
      // Human words: yellow = idle, green = working (output is flowing / an
      // OSC-integrated command runs), green + halo = FINISHED and unacknowledged
      // (sticky until you click the pane), red pulsing = blocked on you. Gray
      // (exited) is set by markDead, never by an event.
      state.title = fin
        ? 'finished working — click the pane to dismiss'
        : st === 'attention'
          ? 'needs your input'
          : st === 'busy'
            ? 'working'
            : 'idle'
    }
    const applyState = (st: AgentState, adopted = false): void => {
      // Hidden = untracked: the state machine keeps running backend-side, but an
      // unavailable dot paints nothing and feeds no attention aggregation.
      if (this.disposed || state.hidden || state.dataset.state === 'exited') return
      // The port derives the sticky finished flag from this edge. `adopted` = a state read
      // off a session the daemon was ALREADY running (a restore — the daemon outlives the
      // app, ADR 0006), so its work predates this pane and the port times that episode from
      // our MOUNT. Timed from the adoption instead — ~1s into the app, after the restore
      // lineup's delay — an agent that landed its task right as we picked it up scored
      // under the noise floor and silently lost its green dot (see adoptPaneState).
      if (adopted) adoptPaneState(this.id, st, this.mountedAt)
      else setPaneState(this.id, st)
      paintState()
    }
    this.clientUnsubs.push(onAttentionChange(paintState))
    this.clientUnsubs.push(
      terminalClient.onState((e) => {
        if (e.id === this.id) applyState(e.state)
      })
    )
    // The pull half: change events this pane never HEARD (renderer reload, app boot
    // against a surviving daemon holding a busy/attention agent) are not coming back
    // — the backend only pushes on change. Ask now, and mount() asks again once the
    // spawn settles (a fresh session registers its tracker only then).
    this.syncState = (adopted = false): void => {
      terminalClient
        .stateSync(this.id)
        .then((st) => {
          if (st) applyState(st, adopted)
        })
        .catch(() => undefined) // a missing handler mid-boot just means nothing to sync yet
    }
    this.syncState()
    // The availability gate (goal: the dot only claims what the wired providers can
    // back). A launcher session with a real adapter id unhides the dot and paints the
    // CURRENT state; the session ending (agent exited to shell) hides and resets it.
    // Two exceptions: dead-gray persists — a death observed while tracked is PTY fact,
    // and the session-clear that FOLLOWS the exit must not erase it — and a custom:
    // provider never unhides (we can't wire what we don't know).
    this.dotGateUnsub = onPaneAgentSession((paneId, s) => {
      if (paneId !== this.id || this.disposed) return
      if (state.dataset.state === 'exited') return
      const tracked = !!s && !s.provider.startsWith('custom:')
      if (state.hidden === !tracked) return // already in the right visibility
      state.hidden = !tracked
      if (tracked) {
        // An ADOPTED session is one the detached daemon kept running across the app's
        // death, so this pull is our FIRST look at an episode that may already be minutes
        // old — the port is told, or the noise floor would judge it by the seconds since
        // adoption and silently deny a finished agent its green dot.
        this.syncState?.(!!s?.adopted) // appear with the truth, not the mount default
      } else {
        clearPaneState(this.id) // an untracked pane must not hold the rail's attention
        state.dataset.state = 'idle'
        state.title = 'idle'
      }
    })
    this.paneLabelUnsub = onPaneLabel((paneId, text) => {
      if (paneId === this.id) applyLabel(text)
    })
    this.paneGitUnsub = onPaneGit((paneId, status) => {
      if (paneId === this.id) applyGit(status)
    })

    return body
  }

  /** The ⋯ pane menu: rename, clear, copy cwd, plus a launch entry per installed
   *  agent (published on the command port by the agents feature — no cross-import). */
  private buildMenu(
    menu: HTMLElement,
    closeMenu: (returnFocus?: boolean) => void,
    displayTitle: string,
    activeMode: string | undefined,
    eventHost: HTMLElement
  ): void {
    menu.replaceChildren()
    const item = (name: IconName, label: string, run: () => void): HTMLButtonElement => {
      const b = document.createElement('button')
      b.className = 'menu-item'
      b.type = 'button'
      b.role = 'menuitem'
      b.tabIndex = -1
      b.append(icon(name, 14), document.createTextNode(label))
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        closeMenu(true)
        run()
      })
      return b
    }
    const note = (text: string): HTMLDivElement => {
      const el = document.createElement('div')
      el.className = 'menu-note'
      el.role = 'menuitem'
      el.tabIndex = -1
      el.setAttribute('aria-disabled', 'true')
      el.textContent = text
      return el
    }
    const separator = (): HTMLDivElement => {
      const el = document.createElement('div')
      el.className = 'menu-sep'
      el.role = 'separator'
      return el
    }
    // ── What the BAR gives up when it narrows, the menu always keeps ──────────────
    // The header is a summary; this first section is the complete textual truth. It is
    // unconditional rather than width-dependent, so the menu stays learnable and the
    // compact four-anchor bar never makes identity or status undiscoverable.
    const info: HTMLElement[] = [note(`Pane: ${displayTitle || `Terminal ${this.id % 100 || this.id}`}`)]
    const session = getPaneAgentSession(this.id)
    if (session) {
      const provider = session.provider.startsWith('custom:')
        ? session.provider.slice('custom:'.length)
        : session.provider
      info.push(note(`Agent CLI: ${provider}`))
    }
    // State is rendered from multiple lifecycle sources, including the terminal
    // process's terminal gray `exited` state after its agent session has cleared.
    // Read the visible dot itself so menu and bar cannot disagree on that last case.
    const renderedStatus = this.stateDot && !this.stateDot.hidden ? this.stateDot.title.trim() : ''
    if (renderedStatus) info.push(note(`Status: ${renderedStatus}`))
    const remote = getPaneRemote(this.id)
    if (remote) {
      info.push(note(`Remote: ${remote.name} — local repo tools (git, worktrees, review) are off`))
    }
    const profileName = getPaneProfile(this.id)
    if (profileName) info.push(note(`Profile: ${profileName}`))
    const roleName = getPaneRole(this.id)
    if (roleName) info.push(note(`Role: ${roleName}`))
    const ownClaims = claimsFor(this.id).length
    if (ownClaims) info.push(note(`Claims: ${ownClaims} file pattern${ownClaims === 1 ? '' : 's'}`))

    const mcp = mcpChipForPane(this.id)
    if (mcp && (mcp.connected > 0 || mcp.attention || mcp.restartNew > 0)) {
      const facts: string[] = []
      if (mcp.connected > 0) facts.push(`${mcp.connected} tool${mcp.connected === 1 ? '' : 's'} connected`)
      if (mcp.attention) facts.push('a tool needs re-authorization (Settings › MCP servers)')
      if (mcp.restartNew > 0) {
        facts.push(`restart to pick up ${mcp.restartNew} new tool${mcp.restartNew === 1 ? '' : 's'}`)
      }
      info.push(note(`MCP: ${facts.join(' · ')}`))
    }

    const ctxUsage = getPaneContext(this.id)
    if (ctxUsage === 'pending') {
      info.push(note('Agent context: waiting for the session’s first response'))
    } else if (ctxUsage) {
      const k = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
      info.push(
        note(
          `Agent context: ${ctxUsage.approx ? '~' : ''}${ctxUsage.usedPct}% used ` +
            `(~${k(ctxUsage.usedTokens)} of ${k(ctxUsage.windowTokens)} tokens)`
        )
      )
    }

    const status = getPaneGit(this.id)
    if (status) {
      info.push(note(displayGitStatus(status).menuLabel))
    }
    menu.append(...info, separator())

    const expandFromMenu = (mode: 'full' | 'col' | 'row'): void => {
      // The menu is portaled to body, so pane-scoped events originate at the pane host.
      eventHost.dispatchEvent(
        new CustomEvent('mogging:expand-pane', { bubbles: true, detail: { paneId: this.id, mode } })
      )
    }
    // Split (new terminal beside/below this one): routed through the workspace
    // controller — the new pane's cwd must be seeded before its slot exists.
    const splitFromMenu = (dir: 'h' | 'v'): void => {
      eventHost.dispatchEvent(
        new CustomEvent('mogging:split-pane', { bubbles: true, detail: { paneId: this.id, dir } })
      )
    }
    // The menu mirrors the trio's truth-telling. It is REBUILT on every open, so the
    // slot's stamp read here is always current: the active mode's entry shows the
    // contract glyph + restore wording, the other two keep offering their switch.
    const expandItem = (
      mode: 'full' | 'col' | 'row',
      name: IconName,
      contractName: IconName,
      label: string
    ): HTMLButtonElement =>
      activeMode === mode
        ? item(contractName, 'Restore grid', () => expandFromMenu(mode))
        : item(name, label, () => expandFromMenu(mode))
    menu.append(
      expandItem('full', 'expand', 'contract', 'Expand to whole workspace'),
      expandItem('row', 'expand-h', 'contract-h', 'Expand across full width'),
      expandItem('col', 'expand-v', 'contract-v', 'Expand to full height'),
      item('plus', 'Split right — new terminal', () => splitFromMenu('h')),
      item('plus', 'Split down — new terminal', () => splitFromMenu('v')),
      separator(),
      item('pencil', 'Rename', () => this.renameFn?.()),
      item('trash', 'Clear terminal', () => this.term.clear()),
      item('folder', 'Copy working directory', () => {
        const cwd = getPaneCwd(this.id)
        if (cwd) void copyText(cwd, 'terminal')
      })
    )
    // Worktree-isolated pane (3/03): guarded removal. Dirty worktrees are refused with
    // an explicit force step — an agent's uncommitted work is never silently destroyed.
    const cwdState = getPaneCwdProjection(this.id)
    const cwd = cwdState?.cwd ?? ''
    const wtMatch = /^(.*)[\\/]\.mogging[\\/]worktrees[\\/][^\\/]+$/.exec(cwd)
    if (cwdState?.locality !== 'remote' && wtMatch) {
      const repo = wtMatch[1]
      const remove = (force: boolean): void => {
        void (getBridge().invoke(WorktreeChannels.remove, { repo, path: cwd, force }) as Promise<RemoveWorktreeResult>).then(
          (res) => {
            if (res.ok) {
              showToast({ tone: 'success', title: 'Worktree removed', body: 'Its branch is kept for review.' })
            } else if (res.reason === 'dirty') {
              showToast({
                tone: 'danger',
                title: 'Worktree has uncommitted changes',
                body: 'Removing it destroys that work.',
                timeout: 10000,
                action: { label: 'Remove anyway', onClick: () => remove(true) }
              })
            } else {
              showToast({ tone: 'danger', title: 'Could not remove worktree' })
            }
          }
        )
      }
      menu.append(
        separator(),
        // Pre-ship review (3/04): the review feature owns the modal; this dispatches.
        item('git-branch', 'Review changes…', () => {
          document.dispatchEvent(
            new CustomEvent('mogging:review-pane', { detail: { repo, worktree: cwd } })
          )
        }),
        item('trash', 'Remove worktree…', () => remove(false))
      )
    }
    // Ownership map (4/02): the full claim set of this pane's workspace, at a glance.
    menu.append(
      item('flag', 'Show claims…', () => {
        const list = workspaceClaims(this.id)
        const bodyEl = document.createElement('div')
        bodyEl.className = 'claims-list'
        if (!list.length) {
          const empty = document.createElement('p')
          empty.className = 'claims-empty'
          empty.textContent = 'No claims — no agent owns any files in this workspace yet.'
          bodyEl.append(empty)
        }
        for (const c of list) {
          const row = document.createElement('div')
          row.className = 'claims-row'
          const pat = document.createElement('code')
          pat.textContent = c.pattern
          const who = document.createElement('span')
          who.className = 'claims-owner'
          who.textContent = `pane ${c.paneId}${c.role ? ' · ' + c.role : ''}`
          row.append(pat, who)
          bodyEl.append(row)
        }
        const modal = createModal({ title: 'File ownership', subtitle: 'Who owns what in this workspace', width: 460 })
        modal.setBody(bodyEl)
        modal.open()
      })
    )
    const agents = allCommands().filter((c) => c.hint === 'Agent')
    if (agents.length) {
      menu.append(separator())
      for (const cmd of agents) {
        menu.append(
          item('terminal', cmd.title.replace(' in focused pane', ' here'), () => {
            this.term.focus() // make THIS the focused pane, then launch into it
            cmd.run()
          })
        )
      }
    }
  }

  /** Dev-only debug handle so tooling/smoke can inspect the real terminal. Guarded by
   *  import.meta.env.DEV, so it is tree-shaken out of production builds. */
  private exposeForDev(host: HTMLElement): void {
    if (!import.meta.env.DEV) return
    const w = window as unknown as { __mogging?: { panes?: unknown[] } }
    w.__mogging = w.__mogging ?? {}
    w.__mogging.panes = w.__mogging.panes ?? []
    this.devHandle = {
      id: this.id,
      // CHROMEUX (8.5/08): force role/claims/mcp chips visible with representative text,
      // so the one-line header contract can be measured with ALL chips lit (the remote
      // chip is real — built from the workspace manifest). DEV-only, tree-shaken in prod.
      lightChips: (): void => {
        const role = host.querySelector<HTMLElement>('.pane-role')
        if (role) {
          role.hidden = false
          if (!role.textContent) {
            role.textContent = 'REVIEWER'
            role.title = 'REVIEWER'
          }
        }
        const claims = host.querySelector<HTMLElement>('.pane-claims')
        if (claims) {
          claims.hidden = false
          claims.replaceChildren(icon('flag', 12), document.createTextNode('3'))
        }
        const mcp = host.querySelector<HTMLElement>('.pane-mcp')
        if (mcp) {
          mcp.hidden = false
          mcp.textContent = 'restart +2'
          mcp.classList.add('is-restart')
        }
        // The branch chip too: the smoke's measured pane is a REMOTE slot, which never
        // gets a local cwd seed (publishPaneCwds skips remotes), so no git port push
        // ever lights it — force the rendered form the ladder is asserted against.
        const git = host.querySelector<HTMLElement>('.pane-git')
        if (git && !git.classList.contains('has-git')) {
          const branch = git.querySelector<HTMLElement>('.pane-branch')
          if (branch) branch.textContent = 'feat/collapse-ladder'
          const worktree = git.querySelector<HTMLElement>('.pane-worktree')
          if (worktree) {
            worktree.hidden = false
            const name = worktree.querySelector<HTMLElement>('span')
            if (name) name.textContent = 'collapse-ladder'
          }
          const state = git.querySelector<HTMLElement>('.pane-git-state')
          if (state) state.textContent = '4 uncommitted'
          const staged = git.querySelector<HTMLElement>('.pane-git-staged')
          if (staged) {
            staged.hidden = false
            staged.textContent = '2 staged'
          }
          const comparison = git.querySelector<HTMLElement>('.pane-git-comparison')
          if (comparison) {
            comparison.hidden = false
            comparison.textContent = '↑3 vs main'
          }
          git.classList.add('dirty')
          git.classList.add('has-git')
        }
        const ctxEl = host.querySelector<HTMLElement>('.pane-context')
        if (ctxEl) {
          ctxEl.hidden = false
          ctxEl.style.setProperty('--ctx', '62')
          const pctEl = ctxEl.querySelector<HTMLElement>('.ctx-pct')
          if (pctEl) pctEl.textContent = '62% used'
        }
      },
      // Unlike lightChips (a pure geometry fixture), this seeds the backing ports
      // buildMenu reads. CHROMEUX uses it to prove every retired fact survives in ⋯.
      seedMenuFacts: (): void => {
        const now = Date.now()
        setClaimsForDev([
          { id: 1, paneId: String(this.id), role: 'reviewer', pattern: 'src/**', ts: now },
          { id: 2, paneId: String(this.id), role: 'reviewer', pattern: 'tests/**', ts: now + 1 }
        ])
        setMcpSnapshot({
          statuses: [
            { serverId: 'fixture-one', cli: 'claude-code', state: 'connected', checkedAt: now },
            { serverId: 'fixture-two', cli: 'claude-code', state: 'connected', checkedAt: now }
          ],
          at: now
        })
        recordPaneCli(this.id, 'claude-code')
        setPaneGit(this.id, {
          root: 'C:\\fixture',
          branch: 'feat/menu-facts',
          detached: false,
          head: '0123456789abcdef0123456789abcdef01234567',
          linkedWorktree: true,
          available: true,
          upstream: 'origin/feat/menu-facts',
          ahead: 2,
          behind: 1,
          baseBranch: 'main',
          baseAhead: 3,
          baseBehind: 0,
          dirty: true,
          changed: 4,
          staged: 1,
          unstaged: 2,
          untracked: 1,
          conflicted: 0
        })
      },
      term: this.term,
      write: (data: string) => terminalClient.write({ id: this.id, data }),
      text: (): string => {
        const b = this.term.buffer.active
        let s = ''
        for (let i = 0; i < b.length; i++) s += (b.getLine(i)?.translateToString(true) ?? '') + '\n'
        return s
      },
      hasCanvas: () => !!host.querySelector('canvas'),
      /** The pane's root element — PANESCROLL dispatches real wheel/pointer/key events
       *  at the real targets inside it, so the gate exercises the shipped listeners. */
      el: (): HTMLElement => host,
      renderer: (): string => (this.webgl ? 'webgl' : 'dom'),
      bufferLines: () => this.term.buffer.active.length,
      rows: () => this.term.rows,
      cols: () => this.term.cols,
      // PANESCROLL (scroll-anchor gate): the viewport's position, whether the pane is
      // still following its output, and what the overlay bar is showing for it.
      scroll: (): {
        viewportY: number
        baseY: number
        atBottom: boolean
        following: boolean
        sliderOpacity: number
        sliderClasses: string
        jumpShown: boolean
        anchor?: { gestures: number; scrolls: number; inWindow: number; repins: number }
      } => {
        const b = this.term.buffer.active
        const slider = host.querySelector<HTMLElement>('.pane-slider')
        const jump = host.querySelector<HTMLElement>('.pane-jump')
        return {
          viewportY: b.viewportY,
          baseY: b.baseY,
          atBottom: b.viewportY >= b.baseY,
          following: this.anchor?.following() ?? false,
          sliderOpacity: slider ? Number(getComputedStyle(slider).opacity) : -1,
          sliderClasses: slider?.className ?? '',
          jumpShown: !!jump && !jump.hidden,
          anchor: this.anchor?.debug()
        }
      },
      /** The rail's box and the thumb's, in pane-body coordinates — the gate proves the
       *  thumb reaches the true floor at the newest line and the true ceiling at the oldest. */
      sliderGeometry: (): { trackTop: number; trackBottom: number; thumbTop: number; thumbBottom: number } | null => {
        const track = host.querySelector<HTMLElement>('.pane-slider-track')
        const thumb = host.querySelector<HTMLElement>('.pane-slider-thumb')
        if (!track || !thumb) return null
        const t = track.getBoundingClientRect()
        const h = thumb.getBoundingClientRect()
        return { trackTop: t.top, trackBottom: t.bottom, thumbTop: h.top, thumbBottom: h.bottom }
      },
      blocks: () =>
        (this.blocks?.list() ?? []).map((b) => ({
          id: b.id,
          command: b.command,
          exitCode: b.exitCode,
          durationMs: b.durationMs,
          collapsed: b.collapsed
        })),
      toggleBlock: (blockId: number) => this.blocks?.toggleCollapse(blockId),
      findBlocks: (q: string) =>
        (this.blocks?.find(q) ?? []).map((b) => ({ id: b.id, command: b.command, exitCode: b.exitCode })),
      // 5/06 type-matrix probe: set arbitrary type metrics through the house
      // remeasure→refit path (the shipped control only exposes fontSize).
      typeSpec: (fontSize: number, lineHeight: number) => {
        this.term.options.fontSize = fontSize
        this.term.options.lineHeight = lineHeight
        this.refit(true)
      }
    }
    w.__mogging.panes.push(this.devHandle)
  }

  /** Serialize the rendered buffer (ANSI). The daemon's raw scrollback is the primary
   *  persistence source (Phase-1/03); this is available for renderer-side snapshots/export. */
  serialize(): string {
    return this.serializer.serialize()
  }

  dispose(): void {
    this.disposed = true
    // Detach from the terminal channels FIRST: from here on, events for this id belong
    // to whichever pane next takes it — never to this dead xterm.
    for (const unsub of this.clientUnsubs) unsub()
    this.clientUnsubs.length = 0
    if (this.refitTimer) {
      clearTimeout(this.refitTimer)
      this.refitTimer = undefined
    }
    clearPaneState(this.id)
    clearPaneCwd(this.id) // stops the backend git watch for this pane (git feature unwatches)
    forgetPane(this.id) // live/reattached marks die with the pane, not with the id
    if (this.selectionCopyTimer) clearTimeout(this.selectionCopyTimer) // a pane closed mid-drag must not copy after death
    this.dropAbort.abort() // drop the window-scoped drag listeners
    this.menuCleanup?.() // document/window listeners + the body-portaled menu
    this.renameModal?.close()
    this.renameModal = undefined
    this.blocks?.dispose()
    this.themeUnsub?.()
    this.fontUnsub?.()
    this.paneLabelUnsub?.()
    this.paneGitUnsub?.()
    this.focusUnsub?.()
    this.roleUnsub?.()
    this.claimsUnsub?.()
    this.mcpUnsub?.()
    this.ctxUnsub?.()
    this.agentSessionUnsub?.()
    this.agentChipUnsub?.()
    this.dotGateUnsub?.()
    this.scrollbar?.dispose()
    this.anchor?.dispose()
    this.osc133?.dispose()
    clearPaneCli(this.id)
    // Launch-scoped identity dies with the pane, not with the id: a killed pane's exit
    // never reaches the renderer (the relay tombstones it), so without these the NEXT
    // pane to take this id mounted wearing the dead one's agent session (provider chip +
    // context gauge), launch-profile note, and label.
    clearPaneAgentSession(this.id)
    setPaneProfile(this.id, undefined)
    setPaneLabel(this.id, '')
    this.visObs?.disconnect()
    this.expandStateObs?.disconnect()
    this.releaseWebgl()
    this.resizeObs.disconnect()
    terminalClient.kill({ id: this.id })
    this.term.dispose()
    if (this.devHandle) {
      const arr = (window as unknown as { __mogging?: { panes?: unknown[] } }).__mogging?.panes
      const i = arr?.indexOf(this.devHandle) ?? -1
      if (arr && i >= 0) arr.splice(i, 1)
    }
  }
}
