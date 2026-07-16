import { EXPLORER_DRAG_TYPE, type PaneId } from '@contracts'
import { icon, showToast } from '../../components'
import { getBridge } from '../../core/ipc/bridge'
import { getPaneRemote } from '../../core/layout/pane-meta'
import { quoteDroppedPaths, quoteWithFlavor, recordDrop } from '../../core/clipboard/clipboard-port'
import { terminalClient } from './terminal.client'

// The pane's drag-and-drop target — extracted from TerminalPane along the same seam as
// pane-anchor / pane-scrollbar / pane-webgl / pane-header-fit: one self-contained concern,
// wired to the pane through a tiny surface (its id, its body element, the pane's dispose
// signal, and a focus callback). Drop a file — from Finder, Explorer, VS Code's tree,
// anywhere — and its absolute path is TYPED into the pane, quoted for the shell we spawned.
// Nothing is executed: the path lands as text at the cursor.

export interface PaneDropOptions {
  paneId: PaneId
  /** The pane body the overlay mounts into and listens on. */
  body: HTMLElement
  /** Aborted when the pane is disposed — tears down the WINDOW-scoped drag listeners a
   *  closed pane must not outlive (they would otherwise live as long as the app, one set
   *  per pane ever opened). */
  signal: AbortSignal
  /** Give the terminal keyboard focus after a successful insert. */
  focus: () => void
}

/**
 * Mount the drop overlay + listeners. `dragleave` fires every time the cursor crosses into
 * a CHILD element (xterm nests several layers of canvas and helper divs), so a naive
 * enter/leave pair strobes the overlay. We count enters and leaves instead, and only hide
 * at zero — the standard fix, and the reason this is more than three lines.
 */
export function mountPaneDrop({ paneId, body, signal, focus }: PaneDropOptions): void {
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
        terminalClient.write({ id: paneId, data: ' ' + text + ' ' })
        focus()
      }
      return
    }
    void insertDroppedPaths(paneId, Array.from(e.dataTransfer?.files ?? []), focus)
  })
  // A drag abandoned with Esc, or ended outside the window, fires neither dragleave nor
  // drop on this element. Without these the card would hang there until the next drag.
  // Bound to WINDOW, so they must die with the pane — a closed pane's listener would
  // otherwise live as long as the app, once per pane ever opened.
  for (const type of ['dragend', 'drop', 'blur'] as const) {
    window.addEventListener(type, () => hide(), { signal })
  }
}

/** Resolve dropped Files to absolute paths, quote them for the pane's shell, and type
 *  them at the cursor. Electron removed `File.path` in v32, so the preload's
 *  `getPathForFile` is the only route — and a browser-hosted gallery has neither. */
async function insertDroppedPaths(paneId: PaneId, files: File[], focus: () => void): Promise<void> {
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
  const remote = getPaneRemote(paneId)
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
  terminalClient.write({ id: paneId, data: ' ' + quoted + ' ' })
  focus()

  // Remembered in the Clipboard tab, but NOT put on the system clipboard — a drag is
  // not a copy, and clobbering what the user had copied would be a surprise.
  void recordDrop(paths, quoted)
}
