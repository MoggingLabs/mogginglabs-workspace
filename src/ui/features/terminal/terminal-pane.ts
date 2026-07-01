import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { SerializeAddon } from '@xterm/addon-serialize'
import { ClipboardChannels, type GitStatus, type PaneId } from '@contracts'
import '@xterm/xterm/css/xterm.css'
import { getBridge } from '../../core/ipc/bridge'
import { terminalClient } from './terminal.client'
import { onTerminalTheme } from '../../core/theme/theme-port'
import { onPaneLabel, getPaneLabel } from '../../core/layout/pane-meta'
import { setPaneState, clearPaneState } from '../../core/attention/attention-port'
import { setPaneCwd, clearPaneCwd } from '../../core/layout/pane-cwd'
import { onPaneGit, getPaneGit } from '../../core/git/git-port'
import { BlockTracker } from '../blocks'

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
  private glLosses = 0
  private devHandle: unknown
  private themeUnsub?: () => void
  private paneLabelUnsub?: () => void
  private paneGitUnsub?: () => void
  private blocks?: BlockTracker

  constructor(
    private readonly id: PaneId,
    host: HTMLElement
  ) {
    this.term = new Terminal({
      fontFamily: '"Cascadia Code", "Cascadia Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      cursorBlink: false, // enabled only while focused (perf: fewer idle repaints across panes)
      allowProposedApi: true,
      scrollback: 10000,
      theme: { background: '#0a0a0a', foreground: '#e6e6e6' }
    })
    this.term.loadAddon(this.fit)
    this.term.loadAddon(this.serializer)
    this.term.open(host)

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
        this.glLosses = 0
        this.acquireWebgl()
      } else {
        this.releaseWebgl()
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

    this.resizeObs = new ResizeObserver(() => {
      this.fit.fit()
      terminalClient.resize({ id: this.id, cols: this.term.cols, rows: this.term.rows })
    })
    this.resizeObs.observe(host)

    void terminalClient.spawn({ id: this.id, cwd: '', cols: this.term.cols, rows: this.term.rows })

    // Blink the cursor only while this pane is focused — cuts idle repaints across many panes.
    this.term.textarea?.addEventListener('focus', () => (this.term.options.cursorBlink = true))
    this.term.textarea?.addEventListener('blur', () => (this.term.options.cursorBlink = false))

    // Apply the active theme now (replayed) + on every change (decoupled via the theme port).
    this.themeUnsub = onTerminalTheme((theme) => (this.term.options.theme = theme))

    this.mountBadge(host)
    this.blocks = new BlockTracker(this.term, host) // Warp-style command blocks from OSC 133 (02)
    this.exposeForDev(host)
  }

  /** Attach the WebGL renderer (idempotent; only while visible). On failure the pane simply
   *  stays on the DOM renderer — a pane must always render; fast when it can. */
  private acquireWebgl(): void {
    if (this.webgl || !this.visible) return
    try {
      const addon = new WebglAddon()
      addon.onContextLoss(() => {
        // Evicted (context cap) or GPU reset: drop to the DOM renderer, then retry a few times
        // while visible — self-healing, never a frozen/blank pane (the BridgeSpace failure mode).
        this.releaseWebgl()
        this.glLosses++
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

  /** Per-pane corner badge: the launched agent's label + its OSC agent-state chip (06). Each
   *  pane shows its OWN state, so "which agent needs me" is answerable at a glance. */
  private mountBadge(host: HTMLElement): void {
    const badge = document.createElement('div')
    badge.className = 'pane-badge'
    const label = document.createElement('span')
    label.className = 'pane-label'
    const git = document.createElement('span')
    git.className = 'pane-git'
    const branch = document.createElement('span')
    branch.className = 'pane-branch'
    const dirty = document.createElement('span')
    dirty.className = 'pane-dirty'
    git.append(branch, dirty)
    const state = document.createElement('span')
    state.className = 'pane-state'
    state.dataset.state = 'idle'
    badge.append(label, git, state)
    host.append(badge)

    const applyLabel = (text: string): void => {
      label.textContent = text
      badge.classList.toggle('has-label', !!text)
    }
    applyLabel(getPaneLabel(this.id) ?? '')

    // Read-only git chip (2/03): the `git` feature publishes status on the git port; we just
    // render it here, next to the agent label + state — so you see the branch + uncommitted work
    // for each pane at a glance. Nothing here mutates a repo.
    const applyGit = (status: GitStatus | null): void => {
      if (!status) {
        git.classList.remove('has-git')
        return
      }
      const ab =
        (status.ahead ? `↑${status.ahead}` : '') + (status.behind ? `↓${status.behind}` : '')
      branch.textContent = `⎇ ${status.branch}${ab ? ' ' + ab : ''}`
      git.title = `${status.detached ? 'detached @ ' : 'on '}${status.branch}` +
        `${status.dirty ? ' — uncommitted changes' : ' — clean'}${status.root ? `\n${status.root}` : ''}`
      git.classList.toggle('dirty', status.dirty)
      git.classList.add('has-git')
    }
    applyGit(getPaneGit(this.id))

    terminalClient.onState((e) => {
      if (e.id === this.id) {
        state.dataset.state = e.state
        setPaneState(this.id, e.state) // feed the workspace-tab / app attention aggregation
      }
    })
    this.paneLabelUnsub = onPaneLabel((paneId, text) => {
      if (paneId === this.id) applyLabel(text)
    })
    this.paneGitUnsub = onPaneGit((paneId, status) => {
      if (paneId === this.id) applyGit(status)
    })
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
