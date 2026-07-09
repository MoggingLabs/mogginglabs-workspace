import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { SerializeAddon } from '@xterm/addon-serialize'
import {
  WorktreeChannels,
  type GitStatus,
  type PaneId,
  type RemoveWorktreeResult
} from '@contracts'
import '@xterm/xterm/css/xterm.css'
import { createModal, icon, showToast, type IconName } from '../../components'
import { getBridge } from '../../core/ipc/bridge'
import { terminalClient } from './terminal.client'
import { onTerminalTheme } from '../../core/theme/theme-port'
import { onTerminalFontSize, terminalFontSize, TERMINAL_LINE_HEIGHT } from '../../core/terminal/font-port'
import { markPaneLive } from '../../core/terminal/liveness-port'
import { onPaneLabel, getPaneLabel, setPaneLabel } from '../../core/layout/pane-meta'
import { setPaneState, clearPaneState } from '../../core/attention/attention-port'
import { setPaneCwd, clearPaneCwd, getPaneCwd } from '../../core/layout/pane-cwd'
import { getPaneRole, onPaneRole, getPaneRemote, getPaneProfile } from '../../core/layout/pane-meta'
import { clearPaneCli, mcpChipForPane, onMcpStatusChange } from '../../core/agents/mcp-status-port'
import { claimsFor, onClaimsChange, workspaceClaims } from './claims-store'
import { onFocusedPane } from '../../core/layout/focus'
import { onPaneGit, getPaneGit } from '../../core/git/git-port'
import { allCommands } from '../../core/commands/command-port'
import { getTelemetry } from '../../core/telemetry'
import { BlockTracker } from '../blocks'
import {
  copyOnSelect,
  copyText,
  quoteDroppedPaths,
  readText,
  recordDrop,
  sanitizePaste
} from '../../core/clipboard/clipboard-port'

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
  private renameFn?: () => void
  private blocks?: BlockTracker

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
        // Back on screen: cancel any pending release (a rapid flip keeps GL warm).
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

    terminalClient.onData((e) => {
      if (e.id === this.id) {
        if (!this.liveMarked) {
          this.liveMarked = true
          markPaneLive(this.id) // first PTY output — lineup launches may proceed
        }
        this.term.write(e.data)
      }
    })
    terminalClient.onExit((e) => {
      if (e.id === this.id) this.term.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n')
    })
    // OSC 7 tells us where this pane's shell/agent actually is -> feed per-pane git (2/03).
    terminalClient.onCwd((e) => {
      if (e.id === this.id) setPaneCwd(this.id, e.cwd)
    })
    this.term.onData((data) => terminalClient.write({ id: this.id, data }))

    // ResizeObserver is the one true fit driver: it fires for real resizes AND for
    // display flips (hidden→shown reports 0→W), including a window resized while this
    // pane was hidden. Fits are UNGUARDED on purpose — mid-transition style reads can
    // lie for one pass, and the follow-up observation converges to the true size.
    this.resizeObs = new ResizeObserver(() => this.refit(true))
    this.resizeObs.observe(body)

    // Font-metrics correctness: if any pane measured its cell size against a fallback
    // font (or a stale activation state), its canvas renders narrower than the pane —
    // a dead strip at the right edge. Once ALL faces are active, force a re-measure
    // (fontFamily must actually change to invalidate xterm's char-size cache) + refit.
    void document.fonts?.ready?.then(() => this.remeasureFont())

    // Remote pane (4/05): the workspace manifest published this BEFORE apply, so the
    // spawn itself rides ssh. Local panes are unchanged.
    const remote = getPaneRemote(this.id)
    void terminalClient.spawn({
      id: this.id,
      cwd: '',
      cols: this.term.cols,
      rows: this.term.rows,
      remoteHostId: remote?.hostId
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
        if (this.visible && !this.webgl) this.attachWebglNow()
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
        return
      }
      const d = this.fit.proposeDimensions()
      if (!d || !Number.isFinite(d.cols) || !Number.isFinite(d.rows)) return // hidden
      if (d.cols === this.term.cols && d.rows === this.term.rows) return // nothing changed
      this.term.resize(d.cols, d.rows)
      terminalClient.resize({ id: this.id, cols: this.term.cols, rows: this.term.rows })
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

    // COPY. Cmd+C (mac), Ctrl+Shift+C, and Ctrl+Insert — plus BARE Ctrl+C, but only
    // when there is a selection to copy. With no selection, bare Ctrl+C must fall
    // through as SIGINT: interrupting a runaway agent is not negotiable, and a
    // clipboard feature that ate it would be a regression, not a feature.
    const copyChord =
      (e.metaKey && k === 'c') || (ctrl && e.shiftKey && k === 'c') || (ctrl && k === 'insert')
    const bareCtrlC = ctrl && !e.shiftKey && k === 'c'
    if ((copyChord || bareCtrlC) && this.term.hasSelection()) {
      void copyText(this.term.getSelection(), 'terminal')
      // Copying consumes the selection, so a second Ctrl+C sends SIGINT as usual —
      // otherwise a stale selection would swallow every interrupt for the rest of the session.
      this.term.clearSelection()
      return false
    }
    if (copyChord) return false // an explicit copy chord with nothing selected is a no-op, not input

    // PASTE. Cmd+V, Ctrl+Shift+V, Shift+Insert — and BARE Ctrl+V, which is what people
    // actually press. Ctrl+V's terminal meaning (literal-next, `quoted-insert`) is a
    // readline nicety almost nobody invokes on purpose; the user asked for paste, and
    // paste is what the rest of the desktop does with that chord.
    const pasteChord =
      (e.metaKey && k === 'v') ||
      (ctrl && e.shiftKey && k === 'v') ||
      (e.shiftKey && !e.ctrlKey && !e.altKey && k === 'insert') ||
      (ctrl && !e.shiftKey && k === 'v')
    if (pasteChord) {
      void this.pasteFromClipboard().catch(() => undefined)
      return false
    }

    // Alt+Up / Alt+Down: jump between command blocks (02).
    if (e.altKey && (k === 'arrowup' || k === 'arrowdown')) {
      this.blocks?.jump(k === 'arrowdown' ? 1 : -1)
      return false
    }
    return true
  }

  /** Read the system clipboard and type it into the PTY, wrapped in bracketed paste when
   *  the foreground program asked for it. xterm tracks the DECSET 2004 mode the shell (or
   *  the agent CLI) set, so we honour whatever is actually running in this pane right now. */
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
    const glyph = icon('copy', 28)
    const title = document.createElement('div')
    title.className = 'pane-drop-title'
    const hint = document.createElement('div')
    hint.className = 'pane-drop-hint'
    hint.textContent = 'The full path is inserted, quoted. Nothing runs.'
    card.append(glyph, title, hint)
    overlay.append(card)
    body.append(overlay)

    let depth = 0
    const show = (n: number): void => {
      title.textContent = n === 1 ? 'Drop to insert path' : `Drop to insert ${n} paths`
      overlay.hidden = false
      // Next frame, so the transition has a start state to animate FROM.
      requestAnimationFrame(() => overlay.classList.add('is-active'))
    }
    const hide = (): void => {
      depth = 0
      overlay.classList.remove('is-active')
      // Keep it in the tree until the fade finishes, then take it out of hit-testing.
      const done = (): void => {
        if (!overlay.classList.contains('is-active')) overlay.hidden = true
      }
      overlay.addEventListener('transitionend', done, { once: true })
      setTimeout(done, 220) // transitionend never fires if the pane was hidden mid-drag
    }

    // Only react to a drag that actually carries files. Dragging selected TEXT from
    // another app also fires these events, and must not put up a "drop a file" card.
    const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer?.types.includes('Files')

    body.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth++
      if (depth === 1) show(e.dataTransfer?.items.length ?? 1)
    })
    body.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return
      e.preventDefault() // without this the drop event never fires
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      // Self-heal: if the counter ever desyncs (a dragenter swallowed by a child that was
      // removed mid-drag), dragover still fires continuously while the cursor is inside,
      // so the overlay reappears rather than staying silently off.
      if (overlay.hidden) {
        depth = 1
        show(e.dataTransfer?.items.length ?? 1)
      }
    })
    body.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return
      // relatedTarget is where the cursor went. Null (left the window) or anything outside
      // this pane means the drag is truly gone — collapse the counter instead of
      // decrementing it, so an unbalanced enter can never strand the overlay on screen.
      const to = e.relatedTarget
      if (!to || !(to instanceof Node) || !body.contains(to)) hide()
      else depth = Math.max(0, depth - 1)
    })
    body.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      hide()
      void this.insertDroppedPaths(Array.from(e.dataTransfer?.files ?? []))
    })
    // A drag abandoned with Esc, or ended outside the window, fires neither dragleave nor
    // drop on this element. Without these the card would hang there until the next drag.
    // Bound to WINDOW, so they must die with the pane — a closed pane's listener would
    // otherwise live as long as the app, once per pane ever opened.
    for (const type of ['dragend', 'drop', 'blur'] as const) {
      window.addEventListener(
        type,
        () => {
          if (!overlay.hidden) hide()
        },
        { signal: this.dropAbort.signal }
      )
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
    const paths = files.map((f) => resolve(f)).filter(Boolean)
    if (!paths.length) return

    const quoted = await quoteDroppedPaths(paths)
    // A trailing space so the next thing typed is a new argument, not a suffix.
    terminalClient.write({ id: this.id, data: quoted + ' ' })
    this.term.focus()

    // Remembered in the Clipboard tab, but NOT put on the system clipboard — a drag is
    // not a copy, and clobbering what the user had copied would be a surprise.
    void recordDrop(paths, quoted)
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
    // Ordered, state dot FIRST (the leading glyph). Remote sits right after it — WHERE
    // before the role/claims/mcp attributes — then the title.
    left.append(state, ...(remoteChip ? [remoteChip] : []), role, claimsChip, mcpChip, title)

    // Center: branch chip — a branch icon + name (soft chip, like the reference bar).
    const git = document.createElement('span')
    git.className = 'pane-git'
    const branch = document.createElement('span')
    branch.className = 'pane-branch'
    const dirty = document.createElement('span')
    dirty.className = 'pane-dirty'
    git.append(icon('git-branch', 12), branch, dirty)

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
    const menu = document.createElement('div')
    menu.className = 'menu pane-menu'
    menu.hidden = true
    const menuBtn = act('more', 'Pane menu', () => {
      if (menu.hidden) this.buildMenu(menu)
      menu.hidden = !menu.hidden
    })
    actions.append(
      menuBtn,
      act('expand', 'Expand to whole workspace (Ctrl+Shift+Enter)', () => expand('full')),
      act('expand-h', 'Expand across full width', () => expand('row')),
      act('expand-v', 'Expand to full height', () => expand('col')),
      act(
        'x',
        'Close terminal',
        () =>
          host.dispatchEvent(
            new CustomEvent('mogging:close-pane', { bubbles: true, detail: { paneId: this.id } })
          ),
        'pane-act-close'
      ),
      menu
    )
    document.addEventListener('click', (e) => {
      if (!(e.target instanceof Node) || !actions.contains(e.target)) menu.hidden = true
    })

    header.append(left, git, actions)

    const body = document.createElement('div')
    body.className = 'pane-body'
    host.append(header, body)

    // Hover-only scrollbar: light the thumb only while the cursor rides the pane's
    // right-edge strip (a class flip on change — no per-move layout work).
    let scrollHot = false
    body.addEventListener('mousemove', (e) => {
      const hot = body.getBoundingClientRect().right - e.clientX <= 16
      if (hot !== scrollHot) {
        scrollHot = hot
        body.classList.toggle('scroll-hot', hot)
      }
    })
    body.addEventListener('mouseleave', () => {
      if (scrollHot) {
        scrollHot = false
        body.classList.remove('scroll-hot')
      }
    })

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
      oscTitle = (t ?? '').trim()
      applyTitle()
    })

    // Rename (double-click or menu): runtime metadata on the pane-meta port.
    const rename = (): void => {
      if (title.querySelector('input')) return
      const input = document.createElement('input')
      input.className = 'pane-title-input'
      input.value = getPaneLabel(this.id) ?? ''
      input.setAttribute('aria-label', 'Pane name')
      title.replaceChildren(input)
      input.focus()
      input.select()
      const commit = (save: boolean): void => {
        const next = save ? input.value.trim() : (getPaneLabel(this.id) ?? '')
        input.remove()
        setPaneLabel(this.id, next)
        oscTitle = '' // a manual name takes over from the agent's task title
        applyTitle()
        if (save) getTelemetry().captureEvent({ name: 'pane.renamed' }) // never the text
      }
      input.addEventListener('keydown', (e) => {
        e.stopPropagation()
        if (e.key === 'Enter') commit(true)
        if (e.key === 'Escape') commit(false)
      })
      input.addEventListener('blur', () => commit(true))
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
      const ab =
        (status.ahead ? `↑${status.ahead}` : '') + (status.behind ? `↓${status.behind}` : '')
      branch.textContent = `${status.branch}${ab ? ' ' + ab : ''}`
      git.title = `${status.detached ? 'detached @ ' : 'on '}${status.branch}` +
        `${status.dirty ? ' — uncommitted changes' : ' — clean'}${status.root ? `\n${status.root}` : ''}`
      git.classList.toggle('dirty', status.dirty)
      git.classList.add('has-git')
    }
    applyGit(getPaneGit(this.id))

    terminalClient.onState((e) => {
      if (e.id === this.id) {
        state.dataset.state = e.state
        state.title = e.state === 'attention' ? 'needs your input' : e.state
        setPaneState(this.id, e.state) // feed the rail / app attention aggregation
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
  private buildMenu(menu: HTMLElement): void {
    menu.innerHTML = ''
    const item = (name: IconName, label: string, run: () => void): HTMLButtonElement => {
      const b = document.createElement('button')
      b.className = 'menu-item'
      b.type = 'button'
      b.append(icon(name, 14), document.createTextNode(label))
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        menu.hidden = true
        run()
      })
      return b
    }
    menu.append(
      item('pencil', 'Rename', () => this.renameFn?.()),
      item('trash', 'Clear terminal', () => this.term.clear()),
      item('folder', 'Copy working directory', () => {
        const cwd = getPaneCwd(this.id)
        if (cwd) void copyText(cwd, 'terminal')
      })
    )
    // Remote pane (4/05): local repo tools are OFF — say so instead of lying.
    if (getPaneRemote(this.id)) {
      const note = document.createElement('div')
      note.className = 'menu-note'
      note.textContent = 'Remote pane — local repo tools (git, worktrees, review) are off.'
      menu.append(note)
    }
    // Launch profile (6/04): read-only truth about WHICH account pointer set this
    // pane launched under. Name only — env values never reach the renderer.
    const profileName = getPaneProfile(this.id)
    if (profileName) {
      const note = document.createElement('div')
      note.className = 'menu-note'
      note.textContent = `Profile: ${profileName}`
      menu.append(note)
    }
    // Worktree-isolated pane (3/03): guarded removal. Dirty worktrees are refused with
    // an explicit force step — an agent's uncommitted work is never silently destroyed.
    const cwd = getPaneCwd(this.id) ?? ''
    const wtMatch = /^(.*)[\\/]\.mogging[\\/]worktrees[\\/][^\\/]+$/.exec(cwd)
    if (wtMatch) {
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
      const sep2 = document.createElement('div')
      sep2.className = 'menu-sep'
      menu.append(
        sep2,
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
      const sep = document.createElement('div')
      sep.className = 'menu-sep'
      menu.append(sep)
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
      renderer: (): string => (this.webgl ? 'webgl' : 'dom'),
      bufferLines: () => this.term.buffer.active.length,
      rows: () => this.term.rows,
      cols: () => this.term.cols,
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
    clearPaneState(this.id)
    clearPaneCwd(this.id) // stops the backend git watch for this pane (git feature unwatches)
    if (this.selectionCopyTimer) clearTimeout(this.selectionCopyTimer) // a pane closed mid-drag must not copy after death
    this.dropAbort.abort() // drop the window-scoped drag listeners
    this.blocks?.dispose()
    this.themeUnsub?.()
    this.fontUnsub?.()
    this.paneLabelUnsub?.()
    this.paneGitUnsub?.()
    this.focusUnsub?.()
    this.roleUnsub?.()
    this.claimsUnsub?.()
    this.mcpUnsub?.()
    clearPaneCli(this.id)
    this.visObs?.disconnect()
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
