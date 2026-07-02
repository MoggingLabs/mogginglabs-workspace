import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { SerializeAddon } from '@xterm/addon-serialize'
import {
  ClipboardChannels,
  WorktreeChannels,
  type GitStatus,
  type PaneId,
  type RemoveWorktreeResult
} from '@contracts'
import '@xterm/xterm/css/xterm.css'
import { icon, showToast, type IconName } from '../../components'
import { getBridge } from '../../core/ipc/bridge'
import { terminalClient } from './terminal.client'
import { onTerminalTheme } from '../../core/theme/theme-port'
import { onPaneLabel, getPaneLabel, setPaneLabel } from '../../core/layout/pane-meta'
import { setPaneState, clearPaneState } from '../../core/attention/attention-port'
import { setPaneCwd, clearPaneCwd, getPaneCwd } from '../../core/layout/pane-cwd'
import { getPaneRole, onPaneRole } from '../../core/layout/pane-meta'
import { onFocusedPane } from '../../core/layout/focus'
import { onPaneGit, getPaneGit } from '../../core/git/git-port'
import { allCommands } from '../../core/commands/command-port'
import { getTelemetry } from '../../core/telemetry'
import { BlockTracker } from '../blocks'

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
  private glQueued = false
  private glLosses = 0
  private devHandle: unknown
  private themeUnsub?: () => void
  private paneLabelUnsub?: () => void
  private paneGitUnsub?: () => void
  private focusUnsub?: () => void
  private roleUnsub?: () => void
  private renameFn?: () => void
  private blocks?: BlockTracker

  constructor(
    private readonly id: PaneId,
    host: HTMLElement
  ) {
    this.term = new Terminal({
      fontFamily:
        '"JetBrains Mono Variable", "JetBrains Mono", "Cascadia Code", Menlo, Consolas, monospace',
      fontSize: 13,
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

    // Ctrl+Shift+C / Cmd+C copies the selection; Ctrl+Shift+V / Cmd+V pastes. A bare
    // Ctrl+C with no selection falls through to the shell as SIGINT.
    this.term.attachCustomKeyEventHandler((e) => this.handleKey(e))

    terminalClient.onData((e) => {
      if (e.id === this.id) this.term.write(e.data)
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

    void terminalClient.spawn({ id: this.id, cwd: '', cols: this.term.cols, rows: this.term.rows })

    // Blink the cursor only while this pane is focused — cuts idle repaints across many panes.
    this.term.textarea?.addEventListener('focus', () => (this.term.options.cursorBlink = true))
    this.term.textarea?.addEventListener('blur', () => (this.term.options.cursorBlink = false))

    // Apply the active theme now (replayed) + on every change (decoupled via the theme port).
    this.themeUnsub = onTerminalTheme((theme) => (this.term.options.theme = theme))

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

  private handleKey(e: KeyboardEvent): boolean {
    if (e.type !== 'keydown') return true
    const k = e.key.toLowerCase()
    const copy = (e.metaKey && k === 'c') || (e.ctrlKey && e.shiftKey && k === 'c')
    const paste = (e.metaKey && k === 'v') || (e.ctrlKey && e.shiftKey && k === 'v')
    if (copy && this.term.hasSelection()) {
      void getBridge().invoke(ClipboardChannels.write, { text: this.term.getSelection() })
      return false
    }
    if (paste) {
      void getBridge()
        .invoke(ClipboardChannels.read)
        .then((text) => {
          if (typeof text === 'string' && text) terminalClient.write({ id: this.id, data: text })
        })
      return false
    }
    // Alt+Up / Alt+Down: jump between command blocks (02).
    if (e.altKey && (k === 'arrowup' || k === 'arrowdown')) {
      this.blocks?.jump(k === 'arrowdown' ? 1 : -1)
      return false
    }
    return true
  }

  /** Pane chrome — the terminal top bar, an exact take on the reference:
   *  LEFT   ✳ state glyph + the task title the agent set (OSC 0/2), else its label;
   *  CENTER the read-only git branch chip;
   *  RIGHT  [⋯ menu] [expand full] [expand horizontal] [expand vertical] [× close].
   *  Class names (.pane-label/.pane-git/.pane-state/.pane-badge) are the DOM contract
   *  of the git/milestone smokes. Returns the terminal body. */
  private mountChrome(host: HTMLElement): HTMLElement {
    const header = document.createElement('div')
    header.className = 'pane-header'

    // Left: state + title. (.pane-badge kept on the cluster for selector continuity.)
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
      role.hidden = !r
    }
    const existingRole = getPaneRole(this.id)
    if (existingRole) applyRole(existingRole)
    this.roleUnsub = onPaneRole((paneId, r) => {
      if (paneId === this.id) applyRole(r)
    })
    left.append(state, role, title)

    // Center: branch chip — a branch icon + name (soft chip, like the reference bar).
    const git = document.createElement('span')
    git.className = 'pane-git'
    const branch = document.createElement('span')
    branch.className = 'pane-branch'
    const dirty = document.createElement('span')
    dirty.className = 'pane-dirty'
    git.append(icon('git-branch', 11), branch, dirty)

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
      if (menu.hidden) this.buildMenu(menu, title)
      menu.hidden = !menu.hidden
    })
    actions.append(
      menuBtn,
      act('maximize', 'Expand to whole workspace (Ctrl+Shift+Enter)', () => expand('full')),
      act('chevrons-left-right', 'Expand across full width', () => expand('row')),
      act('chevrons-up-down', 'Expand to full height', () => expand('col')),
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
  private buildMenu(menu: HTMLElement, _titleEl: HTMLElement): void {
    menu.innerHTML = ''
    const item = (name: IconName, label: string, run: () => void): HTMLButtonElement => {
      const b = document.createElement('button')
      b.className = 'menu-item'
      b.type = 'button'
      b.append(icon(name, 13), document.createTextNode(label))
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
        if (cwd) void getBridge().invoke(ClipboardChannels.write, { text: cwd })
      })
    )
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
        (this.blocks?.find(q) ?? []).map((b) => ({ id: b.id, command: b.command, exitCode: b.exitCode }))
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
    this.blocks?.dispose()
    this.themeUnsub?.()
    this.paneLabelUnsub?.()
    this.paneGitUnsub?.()
    this.focusUnsub?.()
    this.roleUnsub?.()
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
