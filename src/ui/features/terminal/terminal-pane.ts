import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { SerializeAddon } from '@xterm/addon-serialize'
import { ClipboardChannels, type PaneId } from '@contracts'
import '@xterm/xterm/css/xterm.css'
import { getBridge } from '../../core/ipc/bridge'
import { terminalClient } from './terminal.client'

/** A single xterm pane bound to a backend PTY of the same id. */
export class TerminalPane {
  private readonly term: Terminal
  private readonly fit = new FitAddon()
  private readonly serializer = new SerializeAddon()
  private readonly resizeObs: ResizeObserver

  constructor(
    private readonly id: PaneId,
    host: HTMLElement
  ) {
    this.term = new Terminal({
      fontFamily: '"Cascadia Code", "Cascadia Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10000,
      theme: { background: '#0a0a0a', foreground: '#e6e6e6' }
    })
    this.term.loadAddon(this.fit)
    this.term.loadAddon(this.serializer)
    this.term.open(host)

    // WebGL is the wedge — GPU rendering that stays smooth under many streaming
    // agents. Fall back to the DOM renderer if a GPU context isn't available.
    try {
      this.term.loadAddon(new WebglAddon())
    } catch (err) {
      console.warn('WebGL renderer unavailable; using default renderer.', err)
    }
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
    this.term.onData((data) => terminalClient.write({ id: this.id, data }))

    this.resizeObs = new ResizeObserver(() => {
      this.fit.fit()
      terminalClient.resize({ id: this.id, cols: this.term.cols, rows: this.term.rows })
    })
    this.resizeObs.observe(host)

    void terminalClient.spawn({ id: this.id, cwd: '', cols: this.term.cols, rows: this.term.rows })
    this.term.focus()

    this.exposeForDev(host)
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
    return true
  }

  /** Dev-only debug handle so tooling/smoke can inspect the real terminal. Guarded by
   *  import.meta.env.DEV, so it is tree-shaken out of production builds. */
  private exposeForDev(host: HTMLElement): void {
    if (!import.meta.env.DEV) return
    const w = window as unknown as { __mogging?: { panes: unknown[] } }
    w.__mogging = w.__mogging ?? { panes: [] }
    w.__mogging.panes.push({
      id: this.id,
      term: this.term,
      hasCanvas: () => !!host.querySelector('canvas'),
      bufferLines: () => this.term.buffer.active.length,
      rows: () => this.term.rows,
      cols: () => this.term.cols
    })
  }

  /** Serialize the rendered buffer (ANSI). The daemon's raw scrollback is the primary
   *  persistence source (Phase-1/03); this is available for renderer-side snapshots/export. */
  serialize(): string {
    return this.serializer.serialize()
  }

  dispose(): void {
    this.resizeObs.disconnect()
    terminalClient.kill({ id: this.id })
    this.term.dispose()
  }
}
