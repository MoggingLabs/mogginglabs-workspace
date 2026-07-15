import type { Terminal, IMarker, IDecoration } from '@xterm/xterm'
import { clear } from '../../components'

/**
 * A single command block, bracketed by OSC 133 marks. `startMarker` tracks the command line and
 * `endMarker` the exit line — xterm markers move with the scrollback + reflow, so the overlay
 * stays aligned without us re-implementing the renderer.
 */
export interface Block {
  id: number
  command: string
  startedAt: number
  durationMs?: number
  exitCode?: number
  collapsed: boolean
  startMarker?: IMarker
  endMarker?: IMarker
  decoration?: IDecoration
}

const MAX_BLOCKS = 300 // ring buffer — cap tracked blocks so a long session can't grow unbounded

/** Exit-code color bucket. */
export function exitColor(exitCode?: number): 'running' | 'ok' | 'error' {
  if (exitCode === undefined) return 'running'
  return exitCode === 0 ? 'ok' : 'error'
}

/**
 * Overlays Warp-style command blocks on ONE xterm pane. It registers an OSC 133 handler (xterm
 * parses the marks in the data stream at the right buffer position), models blocks, draws a
 * gutter bar per block (exit-code color), and covers a block's output rows when collapsed. If a
 * CLI never emits 133, nothing fires and the pane is a normal terminal (graceful fallback).
 */
export class BlockTracker {
  private readonly blocks: Block[] = []
  private nextId = 1
  private pending: { cmdMarker?: IMarker; cmdCol?: number; startedAt?: number; command?: string } | null = null
  private readonly oscDisposable: { dispose(): void }
  private readonly screenEl: HTMLElement
  private readonly cover: HTMLElement
  private repositionQueued = false

  constructor(
    private readonly term: Terminal,
    host: HTMLElement,
    private readonly onChange?: () => void
  ) {
    this.oscDisposable = term.parser.registerOscHandler(133, (data) => this.onMark(data))
    // Anchor the collapse overlay to the terminal's screen (rows) element — aligns with the rows
    // for both the WebGL and DOM renderers, unlike the padded slot host.
    this.screenEl = (term.element?.querySelector('.xterm-screen') as HTMLElement) ?? host
    this.cover = document.createElement('div')
    this.cover.className = 'block-cover-layer'
    this.screenEl.append(this.cover)
    term.onScroll(() => this.scheduleReposition())
    term.onResize(() => this.scheduleReposition())
  }

  private onMark(data: string): boolean {
    const mark = data[0]
    if (mark === 'B') {
      this.pending = { cmdMarker: this.term.registerMarker(0) ?? undefined, cmdCol: this.term.buffer.active.cursorX }
    } else if (mark === 'C') {
      this.pending = this.pending ?? {}
      this.pending.startedAt = Date.now()
      this.pending.command = this.readCommand()
    } else if (mark === 'D') {
      const ex = parseInt(data.split(';')[1] ?? '', 10)
      this.endBlock(Number.isNaN(ex) ? undefined : ex)
    }
    // 'A' (prompt start) needs no action beyond the next B/C/D. Return true so xterm treats 133
    // as handled and doesn't warn.
    return true
  }

  private readCommand(): string {
    const p = this.pending
    if (!p?.cmdMarker) return ''
    const full = this.term.buffer.active.getLine(p.cmdMarker.line)?.translateToString(true) ?? ''
    return full.slice(p.cmdCol ?? 0).trim()
  }

  private endBlock(exitCode?: number): void {
    const p = this.pending
    const startMarker = p?.cmdMarker
    if (!startMarker) {
      this.pending = null
      return
    }
    const block: Block = {
      id: this.nextId++,
      command: p?.command ?? '',
      startedAt: p?.startedAt ?? Date.now(),
      durationMs: p?.startedAt ? Date.now() - p.startedAt : undefined,
      exitCode,
      collapsed: false,
      startMarker,
      endMarker: this.term.registerMarker(0) ?? undefined
    }
    this.decorate(block)
    this.blocks.push(block)
    if (this.blocks.length > MAX_BLOCKS) this.disposeBlock(this.blocks.shift())
    this.pending = null
    this.scheduleReposition()
    this.onChange?.()
  }

  /** A thin colored gutter bar on the block's command line; click toggles collapse. */
  private decorate(block: Block): void {
    if (!block.startMarker) return
    const dec = this.term.registerDecoration({ marker: block.startMarker, x: 0, width: 1 })
    if (!dec) return
    block.decoration = dec
    dec.onRender((el) => {
      el.className = 'block-gutter'
      el.dataset.exit = exitColor(block.exitCode)
      el.title = `${block.command || 'command'}${block.exitCode !== undefined ? ` · exit ${block.exitCode}` : ''}`
      el.onclick = (e) => {
        e.stopPropagation()
        this.toggleCollapse(block.id)
      }
    })
  }

  list(): Block[] {
    return this.blocks.map((b) => ({ ...b }))
  }

  toggleCollapse(id: number): void {
    const b = this.blocks.find((x) => x.id === id)
    if (!b) return
    b.collapsed = !b.collapsed
    this.scheduleReposition()
    this.onChange?.()
  }

  /** Find blocks by command text or exit code (e.g. "42" or "exit 1"). */
  find(query: string): Block[] {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return this.blocks.filter(
      (b) => b.command.toLowerCase().includes(q) || String(b.exitCode ?? '') === q || `exit ${b.exitCode}` === q
    )
  }

  /** Scroll a block into view (top of viewport). */
  jumpTo(id: number): void {
    const b = this.blocks.find((x) => x.id === id)
    const line = b?.startMarker?.line
    if (line != null) this.term.scrollToLine(Math.max(0, line - 1))
  }

  /** Previous/next block relative to the current viewport top (keyboard nav). */
  jump(dir: 1 | -1): void {
    const top = this.term.buffer.active.viewportY
    const ordered = this.blocks
      .map((b) => b.startMarker?.line)
      .filter((l): l is number => l != null)
      .sort((a, b) => a - b)
    const target = dir === 1 ? ordered.find((l) => l > top + 1) : [...ordered].reverse().find((l) => l < top - 1)
    if (target != null) this.term.scrollToLine(Math.max(0, target - 1))
  }

  private scheduleReposition(): void {
    if (this.repositionQueued) return
    this.repositionQueued = true
    requestAnimationFrame(() => {
      this.repositionQueued = false
      this.reposition()
    })
  }

  /** Position the collapse covers over each collapsed block's output rows (marker-driven). */
  private reposition(): void {
    const rowH = this.rowHeight()
    const viewTop = this.term.buffer.active.viewportY
    const viewRows = this.term.rows
    clear(this.cover)
    for (const b of this.blocks) {
      if (!b.collapsed || !b.startMarker) continue
      const first = b.startMarker.line + 1 // output starts after the command line
      const last = b.endMarker?.line ?? first
      const topRow = first - viewTop
      const rows = Math.max(1, last - first + 1)
      if (topRow + rows <= 0 || topRow >= viewRows) continue // fully offscreen
      const strip = document.createElement('div')
      strip.className = 'block-collapsed'
      strip.style.top = `${Math.max(0, topRow) * rowH}px`
      strip.style.height = `${Math.min(rows, viewRows - Math.max(0, topRow)) * rowH}px`
      strip.textContent = `▸ ${b.command || 'command'} · exit ${b.exitCode ?? '?'} · ${rows} lines`
      strip.onclick = () => this.toggleCollapse(b.id)
      this.cover.append(strip)
    }
  }

  private rowHeight(): number {
    return Math.max(1, this.screenEl.clientHeight / Math.max(1, this.term.rows))
  }

  private disposeBlock(b?: Block): void {
    b?.decoration?.dispose()
    b?.startMarker?.dispose()
    b?.endMarker?.dispose()
  }

  dispose(): void {
    this.oscDisposable.dispose()
    for (const b of this.blocks) this.disposeBlock(b)
    this.cover.remove()
  }
}
