import {
  EXPLORER_DRAG_TYPE,
  EXPLORER_MIN_WIDTH,
  quotePathForShell,
  type ExplorerEntry,
  type ExplorerResult,
  type GitFileState,
  type GitFileStatus,
  type ShellFlavor
} from '@contracts'
import type { UiFeature } from '../../core/registry/feature-registry'
import {
  CountBadge,
  EmptyState,
  IconButton,
  createFileTree,
  el,
  openContextMenu,
  showToast,
  type ContextMenuEntry,
  type FileTreeDecoration,
  type FileTreeHandle
} from '../../components'
import { clipboardEnv, copyText } from '../../core/clipboard/clipboard-port'

/** Copy a path and tell the user if the OS refused it (a clipboard held open by another
 *  process makes the write a silent no-op — copyText verifies and answers truthfully).
 *  Silence on success: the copy is the feedback, exactly as before. */
async function copyPath(path: string): Promise<void> {
  if (await copyText(path)) return
  showToast({
    tone: 'danger',
    title: 'Copy failed',
    body: 'Another app is holding the system clipboard open — nothing was copied.'
  })
}
import { getPaneRemote } from '../../core/layout/pane-meta'
import { typeIntoPane } from '../../core/terminal/pane-input-port'
import { gitCheckIgnore, gitFilesUnwatch, gitFilesWatch, onGitFiles } from './git.client'
import { explorerOpen, explorerReveal, setActionRoot } from './explorer.client'
import { getWorkspaces, onWorkspacesChange, type WorkspaceInfo } from '../../core/workspace/workspace-info-port'
import { getFocusedPane, onFocusedPane } from '../../core/layout/focus'
import { setCommands } from '../../core/commands/command-port'
import { getTelemetry } from '../../core/telemetry'
import {
  explorerInit,
  explorerList,
  onExplorerChanged,
  persistOpen,
  persistShowHidden,
  persistWidth,
  unwatchAll,
  watchDirs,
  watchStats
} from './explorer.client'
import { dockLayoutBudget, onDockLayoutChange, requestDockLayout } from '../../core/layout/dock-budget'
import { setExplorerRevealHandler } from '../../core/shell/explorer-reveal-port'

/**
 * The explorer dock (Phase-11/03, ADR 0010): the 02 tree given a home — a right-side
 * sidebar rooted at the ACTIVE workspace's folder, toggled from the FAR RIGHT of the
 * app bar (`panel-right`, mirroring the rail's `panel-left` at the far left). The
 * browser dock is the precedent throughout: an `<aside>` flex sibling of `#content`,
 * a pointer-capture width handle, KV-persisted open/width.
 *
 * IT IS A WINDOW, NOT A MANAGER. Every verb here is read-only (list · expand ·
 * collapse); opening files and acting on them land in 06, liveness in 04.
 *
 * TWO LAWS IT HOLDS BY CONSTRUCTION:
 *  - **Never steals focus.** Opening, closing, re-rooting, and refreshing all leave
 *    DOM focus exactly where it was — a keystroke meant for an agent must never land
 *    in a tree (tmux-sidebar's virtue; the smoke asserts it).
 *  - **Closed costs zero.** No listing is issued while the dock is shut, and a
 *    workspace with no folder issues none at all — it gets an EmptyState instead.
 */

/** What the dock remembers per workspace, so switching back feels like returning. */
interface WsMemory {
  expandedDirs: string[]
  scrollTop: number
  selection: string
}

/** Keep the head and the tail — the middle is what a long path can afford to lose.
 *  The full path always rides the `title`. */
function middleTruncate(p: string, max = 38): string {
  if (p.length <= max) return p
  const head = Math.ceil((max - 1) / 2)
  const tail = max - 1 - head
  return p.slice(0, head) + '…' + p.slice(p.length - tail)
}

// ── Git decorations (11/05) ─────────────────────────────────────────────────
// git speaks repo-relative, forward-slashed; the tree speaks absolute, OS-native. The join
// happens HERE, on the one side that knows both (the goal's "renderer-side joins"), derived
// from the root's own spelling — never from a hardcoded platform assumption.

const sepOf = (p: string): string => (p.includes('\\') ? '\\' : '/')
const absOf = (root: string, rel: string): string => {
  const sep = sepOf(root)
  return (root.endsWith(sep) ? root : root + sep) + rel.split('/').join(sep)
}
const relOf = (root: string, abs: string): string => {
  const sep = sepOf(root)
  const rest = abs.slice(root.length).replace(/^[\\/]+/, '')
  return rest.split(sep).join('/')
}
const parentOf = (abs: string): string => {
  const i = abs.lastIndexOf(sepOf(abs))
  return i <= 0 ? '' : abs.slice(0, i)
}

/** Path-boundary containment without importing host path APIs into the renderer. */
const pathKey = (value: string): string => {
  const slash = value.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-z]:\//i.test(slash) ? slash.toLowerCase() : slash
}
const isWithin = (root: string, candidate: string, allowRoot = false): boolean => {
  const r = pathKey(root)
  const c = pathKey(candidate)
  return !!r && (allowRoot && c === r ? true : c.startsWith(`${r}/`))
}

/** A rename IS a modification you can see the shape of — VS Code shows R, we render M and
 *  spend the sixth letter nowhere (RESEARCH §2: the badge letters are community-documented,
 *  the SPLIT is the part that matters). */
const LETTER: Record<GitFileStatus, string> = {
  modified: 'M',
  added: 'A',
  untracked: 'U',
  deleted: 'D',
  conflicted: 'C',
  renamed: 'M'
}
type Tone = NonNullable<FileTreeDecoration['tone']>
const toneOf = (s: GitFileStatus): Tone => (s === 'renamed' ? 'modified' : s)
/** What a FOLDER inherits when its descendants disagree: the loudest thing under it. A
 *  conflict must not hide behind an untracked sibling. */
const TONE_RANK: Record<Tone, number> = { conflicted: 5, deleted: 4, modified: 3, added: 2, untracked: 1 }

export const explorerFeature: UiFeature = {
  name: 'explorer',
  mount(ctx) {
    let open = false
    let width = 0 // set by init before first paint
    let showHidden = false
    let rootPath = '' // '' = nothing rooted (no workspace, or no folder)
    let wsId = ''
    let selection = ''
    let rootGeneration = 0
    const memory = new Map<string, WsMemory>()
    const listCalls: string[] = [] // DEV spy (the smoke proves laziness + zero-cost-closed)

    // ── Git decoration state (11/05) ──
    let gitRoot = '' // '' = not a repo (or not yet known) — and then NO git traffic happens at all
    let gitFiles: GitFileState[] = []
    let gitTruncated = false
    let gitEvents = 0 // DEV spy: an idle repo must produce ZERO of these
    const ignoredByDir = new Map<string, Set<string>>() // dir -> its ignored children (abs). One spawn each.
    let ignoreBusy = false
    let lens = false
    let lensSaved: string[] = []

    // ── Actions (11/06) ──
    // The shell flavor and platform are fetched ONCE and cached, because a `dragstart`
    // handler is synchronous — there is no awaiting the answer mid-drag.
    let flavor: ShellFlavor = 'posix'
    let platform = ''
    void clipboardEnv().then((e) => {
      flavor = e.flavor
      platform = e.platform
    })
    const actions: { verb: string; path: string }[] = [] // DEV spy

    // ── The tree. `list` is INJECTED (ADR 0004) — the component never sees a channel.
    const tree: FileTreeHandle = createFileTree({
      list: (path, hidden): Promise<ExplorerResult> => {
        listCalls.push(path)
        return explorerList(path, hidden)
      },
      // Enter or double-click on a FILE opens it with the OS. Directories keep toggling —
      // the APG default action for a treeitem, and the thing a person expects.
      onActivate: (entry) => void doOpen(entry),
      onContextMenu: (entry, at) => showRowMenu(entry, at),
      onDragStart: (entry, e) => fillDrag(entry, e),
      onSelect: (entry) => {
        selection = entry.path
      },
      // Expansion moved — by a click, a keystroke, or a dir an agent deleted out from
      // under us (the tree prunes it). Either way the VISIBLE set changed, so the
      // watcher pool is told immediately: watch what's visible, nothing else.
      onExpandedChange: () => {
        saveMemory()
        pushWatch()
        void refreshIgnored() // a newly expanded dir has children git has not been asked about
      }
    })

    // ── Chrome ────────────────────────────────────────────────────────────────
    const wsDot = el('span', { class: 'explorer-ws-dot' })
    const wsName = el('span', { class: 'explorer-ws-name' })
    const rootLabel = el('div', { class: 'explorer-root' })
    const title = el('div', { class: 'explorer-dock-title' }, [el('div', { class: 'explorer-ws' }, [wsDot, wsName]), rootLabel])

    const refreshBtn = IconButton({ icon: 'rotate-cw', label: 'Refresh', title: 'Refresh', onClick: () => void refresh() })
    const collapseBtn = IconButton({ icon: 'contract-v', label: 'Collapse all', title: 'Collapse all', onClick: () => void collapseAll() })
    const hiddenBtn = IconButton({
      icon: 'sparkles',
      label: 'Show hidden files',
      title: 'Show hidden files',
      onClick: () => void toggleHidden()
    })
    const closeBtn = IconButton({ icon: 'x', label: 'Close explorer', title: 'Close (Ctrl+Shift+E)', onClick: () => toggle(false) })
    const header = el('div', { class: 'explorer-dock-header' }, [
      title,
      el('div', { class: 'explorer-dock-actions' }, [refreshBtn, collapseBtn, hiddenBtn, closeBtn])
    ])

    // The Changes lens (RESEARCH §5): the changed-files view every orchestrator converged on —
    // except ours is the SAME tree, filtered, so you never lose the shape of the project. Hidden
    // entirely outside a repo: a lens over nothing is a lie.
    let lensCount = CountBadge(0, { label: '0 changed files' })
    const lensChip = el('button', { class: 'explorer-lens', type: 'button', title: 'Show only what changed' }, [
      el('span', { text: 'Changes' }),
      lensCount
    ])
    lensChip.hidden = true
    lensChip.addEventListener('click', () => void setLens(!lens))
    const bar = el('div', { class: 'explorer-dock-bar' }, [lensChip])

    const emptyHost = el('div', { class: 'explorer-empty', hidden: true })
    const body = el('div', { class: 'explorer-dock-body' }, [tree.el, emptyHost])
    const handle = el('div', { class: 'explorer-dock-handle' })
    handle.tabIndex = 0
    handle.setAttribute('role', 'separator')
    handle.setAttribute('aria-orientation', 'vertical')
    handle.setAttribute('aria-label', 'Resize file explorer')

    const dock = el('aside', { class: 'explorer-dock', hidden: true, ariaLabel: 'File explorer' }, [handle, header, bar, body])
    // Esc leaves the lens — but only when focus is INSIDE the dock, so a pane's Esc still
    // belongs to the pane (and a modal's still belongs to the modal).
    dock.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !lens) return
      e.preventDefault()
      e.stopPropagation()
      void setLens(false)
    })
    // Ctrl/Cmd+C copies the selected path. The tree's own handler ignores chords (its
    // type-ahead is printable-only), so this rides alongside it rather than fighting it.
    dock.addEventListener('keydown', (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'c') return
      if (!selection) return
      e.preventDefault()
      actions.push({ verb: 'copy', path: selection })
      void copyPath(selection)
    })
    // LAST in #main — outermost right. With the browser dock open the row reads
    // `#rail | #content | .browser-dock | .explorer-dock` (the browser feature mounts
    // first and inserts itself directly after #content).
    ctx.content.parentElement?.append(dock)

    // ── Width: clamped so the grid always keeps room ──────────────────────────
    let widthTimer: number | undefined
    function clamp(w: number): number {
      // The panes' floor is the real cap: with BOTH docks open a drag can never squeeze
      // the terminals below EXPLORER_MIN_CONTENT — the grid is what this app is for.
      const cap = Math.min(Math.round(window.innerWidth * 0.4), dockLayoutBudget().explorerMax)
      return Math.max(EXPLORER_MIN_WIDTH, Math.min(Math.round(w), cap))
    }
    function applyWidth(persist = true): void {
      width = clamp(width)
      dock.style.width = `${width}px`
      handle.setAttribute('aria-valuemin', String(EXPLORER_MIN_WIDTH))
      // `clamp` also applies the 40vw cap; ARIA must advertise the maximum the
      // keyboard can actually reach, not only the shared budget's looser cap.
      handle.setAttribute('aria-valuemax', String(clamp(Number.MAX_SAFE_INTEGER)))
      handle.setAttribute('aria-valuenow', String(width))
      if (!persist) return
      window.clearTimeout(widthTimer)
      widthTimer = window.setTimeout(() => persistWidth(width), 400) // the browser.width cadence
    }
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      try {
        handle.setPointerCapture(e.pointerId)
      } catch {
        /* a synthetic pointer (the smoke's drag) has no capture to take */
      }
      const startX = e.clientX
      const startW = width
      const move = (ev: PointerEvent): void => {
        width = startW + (startX - ev.clientX) // the dock grows leftward
        applyWidth()
      }
      const up = (): void => {
        handle.removeEventListener('pointermove', move)
        handle.removeEventListener('pointerup', up)
        handle.removeEventListener('pointercancel', up)
      }
      handle.addEventListener('pointermove', move)
      handle.addEventListener('pointerup', up)
      handle.addEventListener('pointercancel', up)
    })
    handle.addEventListener('keydown', (e) => {
      const budget = dockLayoutBudget()
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
      e.preventDefault()
      if (e.key === 'ArrowLeft') width += e.shiftKey ? 64 : 16
      else if (e.key === 'ArrowRight') width -= e.shiftKey ? 64 : 16
      else if (e.key === 'Home') width = EXPLORER_MIN_WIDTH
      else width = budget.explorerMax
      applyWidth()
    })
    onDockLayoutChange(() => applyWidth(false))

    // ── The liveness law (11/04, ADR 0010.d) ──────────────────────────────────
    // What is VISIBLE is the root plus every expanded dir — that, and nothing else, is
    // what main watches. The root leads the array: it is the dir agents write into most,
    // and the pool honours the order as priority when handles run short.
    const batchLog: string[][] = [] // DEV spy: the smoke counts batches, not guesses
    function pushWatch(): void {
      if (!open) return unwatchAll() // a closed dock watches nothing, ever
      watchDirs(rootPath ? [rootPath, ...tree.expandedDirs()] : [])
    }

    // ONE coalesced batch per burst: re-list exactly these dirs, splice in place.
    // Expansion, selection, and scroll survive (the tree never touches them here), and an
    // identical listing is zero DOM work.
    onExplorerChanged((dirs) => {
      if (!open || !rootPath) return
      batchLog.push(dirs)
      // A dir whose entries moved may have gained or lost an ignored child, so its
      // check-ignore answer is stale — THIS is what invalidates the cache (11/05).
      for (const d of dirs) ignoredByDir.delete(d)
      void tree.applyChanged(dirs).then(() => refreshIgnored())
    })

    // ── Git decorations (11/05) ───────────────────────────────────────────────
    // Not one new poller: these arrive on the tick `git/probe.ts` has always run, carrying
    // the porcelain lines it always read and always threw away.
    const isUnderRoot = (abs: string): boolean => isWithin(rootPath, abs)

    /** Files wear a letter AND a colour; folders inherit the colour of the loudest thing
     *  beneath them and NO letter — VS Code's `FileDecoration.propagate`, exactly. */
    function rebuildDecorations(): void {
      if (!gitRoot) {
        tree.setDecorations(null)
        return
      }
      const dec = new Map<string, FileTreeDecoration>()
      for (const f of gitFiles) {
        const abs = absOf(gitRoot, f.path)
        const tone = toneOf(f.state)
        dec.set(abs, { ...dec.get(abs), letter: LETTER[f.state], tone })
        for (let p = parentOf(abs); p && p.length > gitRoot.length; p = parentOf(p)) {
          const cur = dec.get(p)
          if (!cur?.tone || TONE_RANK[tone] > TONE_RANK[cur.tone]) dec.set(p, { ...cur, tone })
        }
      }
      // Dimming last, and NON-destructively: a file that is both ignored and changed keeps
      // its badge (git tracked it before someone added the pattern — the user needs to see that).
      for (const set of ignoredByDir.values()) {
        for (const abs of set) dec.set(abs, { ...dec.get(abs), ignored: true })
      }
      tree.setDecorations(dec)
    }

    /** ONE `check-ignore` batch per EXPANDED dir, cached until that dir's listing changes.
     *  Sequential on purpose: expanding fifty folders must not fork fifty gits at once. */
    async function refreshIgnored(): Promise<void> {
      if (!gitRoot || !open || ignoreBusy) return
      const dirs = [rootPath, ...tree.expandedDirs()].filter((d) => d && !ignoredByDir.has(d))
      if (!dirs.length) return
      ignoreBusy = true
      try {
        for (const dir of dirs) {
          const entries = tree.entriesOf(dir)
          if (!entries.length) continue // not listed yet (or genuinely empty): ask nothing, cache nothing
          const ignored = await gitCheckIgnore(gitRoot, entries.map((e) => relOf(gitRoot, e.path)))
          ignoredByDir.set(dir, new Set(ignored.map((r) => absOf(gitRoot, r))))
        }
      } finally {
        ignoreBusy = false
      }
      rebuildDecorations()
    }

    function paintLensChip(): void {
      const n = gitFiles.length
      const next = CountBadge(n, { label: `${n} changed ${n === 1 ? 'file' : 'files'}` })
      lensCount.replaceWith(next)
      lensCount = next
      lensChip.hidden = !gitRoot
      lensChip.title = gitTruncated ? `First ${n} changed files — the rest are not shown` : 'Show only what changed'
    }

    onGitFiles((e) => {
      if (!open || !rootPath) return // a closed dock is not a consumer (and never registered one)
      gitEvents++
      gitRoot = e.root
      gitFiles = e.files
      gitTruncated = e.truncated
      paintLensChip()
      rebuildDecorations()
      void refreshIgnored()
      if (lens) void applyLens() // the lens follows the status list as it moves
    })

    /** The changed paths AND the dirs between them and the root — a file with no visible
     *  ancestors renders nowhere, so the lens must carry both. */
    function lensSets(): { paths: Set<string>; dirs: string[] } {
      const paths = new Set<string>()
      const dirs: string[] = []
      for (const f of gitFiles) {
        const abs = absOf(gitRoot, f.path)
        if (!isUnderRoot(abs)) continue // changed outside the folder we are showing
        paths.add(abs)
        for (let p = parentOf(abs); p && p.length > rootPath.length; p = parentOf(p)) {
          if (!paths.has(p)) dirs.push(p)
          paths.add(p)
        }
      }
      return { paths, dirs }
    }

    async function applyLens(): Promise<void> {
      const { paths, dirs } = lensSets()
      await tree.setExpanded(dirs) // ancestors open so the changes are actually reachable
      tree.setFilter(paths)
      pushWatch()
    }

    async function setLens(on: boolean): Promise<void> {
      if (on === lens || !gitRoot) return
      lens = on
      lensChip.classList.toggle('is-active', lens)
      dock.classList.toggle('is-lens', lens)
      if (lens) {
        lensSaved = tree.expandedDirs() // …restored EXACTLY on the way out
        await applyLens()
      } else {
        tree.setFilter(null)
        await tree.setExpanded(lensSaved)
        pushWatch()
      }
      saveMemory()
    }

    // ── Rooting + per-workspace memory ────────────────────────────────────────
    function activeWs(): WorkspaceInfo | null {
      const s = getWorkspaces()
      return s.workspaces.find((w) => w.id === s.activeId) ?? null
    }

    function saveMemory(): void {
      if (!wsId || !rootPath) return
      memory.set(wsId, { expandedDirs: tree.expandedDirs(), scrollTop: tree.el.scrollTop, selection })
    }

    // ── Actions: delegate, copy, type. Never execute. (11/06) ─────────────────
    // THE CUSTODY LINE (ADR 0010): open and reveal hand the path to the OS and to the
    // user's own tools; send-to-pane TYPES it and stops. Nothing here writes a file, and
    // nothing here presses Enter — an agent pane's stdin belongs to the user.

    const REFUSAL_COPY: Record<string, string> = {
      missing: 'That file is gone',
      'outside-root': 'That path is outside this folder',
      invalid: 'That is not a full path',
      denied: 'Your system would not open it'
    }
    async function dispatch(verb: 'open' | 'reveal', entry: ExplorerEntry): Promise<void> {
      actions.push({ verb, path: entry.path })
      const res = verb === 'open' ? await explorerOpen(entry.path) : await explorerReveal(entry.path)
      // A refusal is a STATE, said plainly — never a dialog, never a crash. `ok` only ever
      // meant "dispatched": what opens it, and whether anything does, is their machine's call.
      if (!res.ok) showToast({ tone: 'danger', title: REFUSAL_COPY[res.reason ?? 'denied'] ?? 'That could not be opened' })
    }
    const doOpen = (entry: ExplorerEntry): Promise<void> => dispatch('open', entry)
    const doReveal = (entry: ExplorerEntry): Promise<void> => dispatch('reveal', entry)

    /** Relative to the explorer's root — what a person would actually type into a README. */
    const relToRoot = (p: string): string => (rootPath && isUnderRoot(p) ? p.slice(rootPath.length).replace(/^[\\/]+/, '') : p)

    /** A loaded entry by absolute path. The dev surface needs the ENTRY, not just a string,
     *  so a smoke drives exactly the code path a click drives. */
    function findEntry(path: string): ExplorerEntry | null {
      for (const dir of [rootPath, ...tree.expandedDirs()]) {
        const hit = tree.entriesOf(dir).find((e) => e.path === path)
        if (hit) return hit
      }
      return null
    }

    /**
     * The text we hand a pane. RELATIVE to that pane's own cwd when the file sits under it
     * (that is what a person types), ABSOLUTE otherwise — a relative path that escapes the
     * cwd would be a lie. Quoted per-OS by the shared quoter, which also strips control
     * characters: a filename cannot smuggle a newline, and therefore cannot press Enter.
     */
    function insertTextFor(entry: ExplorerEntry): string {
      const focused = getFocusedPane()
      const cwd = focused?.cwd ?? ''
      const under = !!cwd && isWithin(cwd, entry.path)
      const rel = under ? entry.path.slice(cwd.length).replace(/^[\\/]+/, '') : ''
      const raw = rel || entry.path
      // A REMOTE pane's shell lives on the ssh host: quote POSIX (the terminal's own rule).
      const f = focused && getPaneRemote(focused.paneId) ? 'posix' : flavor
      return quotePathForShell(raw, f as ShellFlavor)
    }

    function sendToPane(entry: ExplorerEntry): void {
      const focused = getFocusedPane()
      if (!focused) return
      actions.push({ verb: 'send', path: entry.path })
      // Padded on BOTH sides, the dropped-file precedent: the leading space detaches it from
      // whatever is at the cursor, the trailing one starts the next argument. NO carriage
      // return — not here, not ever. We type; the user executes.
      typeIntoPane(focused.paneId, ' ' + insertTextFor(entry) + ' ')
    }

    /** Absolute path as a file:// URI, for a drop onto something outside the app. */
    const fileUrlOf = (p: string): string => {
      const s = p.replace(/\\/g, '/')
      return encodeURI('file://' + (s.startsWith('/') ? s : '/' + s))
    }

    function fillDrag(entry: ExplorerEntry, e: DragEvent): void {
      const dt = e.dataTransfer
      if (!dt) return
      dt.effectAllowed = 'copy'
      const quoted = insertTextFor(entry)
      // OUR marker. A pane accepts a text drop ONLY when it sees this — dragging arbitrary
      // selected text out of another app must never type itself into a terminal.
      dt.setData(EXPLORER_DRAG_TYPE, '1')
      dt.setData('text/plain', quoted) // the pane reads this; an editor gets the same, quoted
      dt.setData('text/uri-list', fileUrlOf(entry.path)) // an OS target gets the plain path
    }

    function showRowMenu(entry: ExplorerEntry, at: { x: number; y: number; row: HTMLElement }): void {
      const focused = getFocusedPane()
      const revealLabel =
        platform === 'darwin' ? 'Reveal in Finder' : platform === 'win32' ? 'Reveal in File Explorer' : 'Show in file manager'
      const items: ContextMenuEntry[] = [
        { label: 'Open', icon: 'arrow-right', onSelect: () => void doOpen(entry) },
        { label: revealLabel, icon: 'folder-open', onSelect: () => void doReveal(entry) },
        { separator: true },
        { label: 'Copy path', icon: 'copy', hint: 'Ctrl+C', onSelect: () => void copyPath(entry.path) },
        { label: 'Copy relative path', icon: 'copy', onSelect: () => void copyPath(relToRoot(entry.path)) },
        { separator: true },
        {
          label: 'Send to pane',
          icon: 'terminal',
          // Disabled rather than hidden: the verb exists, it just has nowhere to go — and a
          // menu whose shape changes under you is a menu you stop trusting.
          disabled: !focused,
          hint: focused ? undefined : 'no focused pane',
          onSelect: () => sendToPane(entry)
        }
      ]
      openContextMenu({ items, x: at.x, y: at.y, returnFocus: at.row, ariaLabel: 'File actions' })
    }

    /** Every scrap of git state, dropped. Called when we leave a folder or shut the dock —
     *  decorations from the LAST repo must never be painted over the next one's files. */
    function dropGit(): void {
      if (gitRoot) gitFilesUnwatch(gitRoot)
      gitRoot = ''
      gitFiles = []
      gitTruncated = false
      ignoredByDir.clear()
      lens = false
      lensSaved = []
      lensChip.hidden = true
      lensChip.classList.remove('is-active')
      dock.classList.remove('is-lens')
      tree.setFilter(null)
      tree.setDecorations(null)
    }

    /** Re-root to the active workspace. Called ONLY while open — a closed dock lists
     *  nothing, ever (the smoke counts the calls). */
    async function root(): Promise<void> {
      const generation = ++rootGeneration
      const ws = activeWs()
      const nextId = ws?.id ?? ''
      const nextRoot = ws?.cwd ?? ''
      if (nextId === wsId && nextRoot === rootPath && nextRoot) return // already there

      saveMemory() // remember where we were before we leave
      dropGit()
      // No action is valid between roots. Clear the main-process guard before the first
      // await, then publish the new boundary only if this generation still owns the dock.
      setActionRoot('')
      wsId = nextId
      rootPath = nextRoot
      selection = ''

      wsDot.style.background = ws?.color ?? 'transparent'
      wsName.textContent = ws?.name ?? ''
      rootLabel.textContent = nextRoot ? middleTruncate(nextRoot) : ''
      rootLabel.title = nextRoot

      // A workspace with no folder is not an error and not an empty tree — it is a
      // state, and it costs ZERO listings. Clear first: the folder we just left must
      // not leave ITS filenames sitting in the DOM behind this empty state.
      if (!nextRoot) {
        tree.clear()
        tree.el.hidden = true
        emptyHost.hidden = false
        if (!emptyHost.firstChild) {
          emptyHost.append(
            EmptyState({
              icon: 'folder',
              title: 'This workspace has no folder',
              body: 'Workspaces started without a folder have nothing to show here. Open one with a folder to browse it.'
            })
          )
        }
        pushWatch() // nothing visible -> nothing watched
        return
      }
      tree.el.hidden = false
      emptyHost.hidden = true

      await tree.setRoot(nextRoot)
      if (generation !== rootGeneration || activeWs()?.id !== nextId) return
      const mem = memory.get(nextId)
      if (mem) {
        // Coming back should feel like returning, not like arriving.
        await tree.setExpanded(mem.expandedDirs)
        if (generation !== rootGeneration || activeWs()?.id !== nextId) return
        if (mem.selection) await tree.reveal(mem.selection)
        if (generation !== rootGeneration || activeWs()?.id !== nextId) return
        tree.el.scrollTop = mem.scrollTop // last: reveal() may have scrolled to the selection
      }
      applyHere()
      pushWatch() // the new workspace's visible set — the old one's watchers are dropped
      setActionRoot(nextRoot) // …and the action guard's boundary moves with us
      // DORMANCY: main resolves the repo root with a filesystem walk. A folder that is not in
      // a repo registers nothing, is never probed, and never spawns `git` — so a non-repo
      // workspace costs exactly zero, and the Changes chip stays hidden because there is
      // nothing truthful to put in it.
      gitFilesWatch(nextRoot)
    }

    onWorkspacesChange(() => {
      if (open) void root() // closed: nothing happens, nothing is listed
    })

    // ── Soft "you are here" ───────────────────────────────────────────────────
    // The focused pane's own cwd (a worktree, OSC-7-refined), tinted IF its row is
    // already on screen. Never expands to reach it; never scrolls to it. Looking is
    // not navigating — the sidebar answers "where am I", it does not move you.
    let focusedCwd = ''
    function applyHere(): void {
      const under = !!rootPath && !!focusedCwd && isWithin(rootPath, focusedCwd)
      tree.setHere(under ? focusedCwd : null)
    }
    onFocusedPane((f) => {
      focusedCwd = f?.cwd ?? ''
      if (open) applyHere()
    })

    // ── Header actions ────────────────────────────────────────────────────────
    async function refresh(): Promise<void> {
      if (!rootPath) return
      // Surgical: re-list what is ON SCREEN (the root + every expanded dir). An
      // unchanged listing is zero DOM work — the tree's own change-only rule.
      await tree.applyChanged([rootPath, ...tree.expandedDirs()])
      applyHere()
    }
    async function collapseAll(): Promise<void> {
      await tree.setExpanded([])
      saveMemory()
      pushWatch() // every collapsed dir gives its watcher back
    }
    async function toggleHidden(): Promise<void> {
      showHidden = !showHidden
      hiddenBtn.classList.toggle('is-active', showHidden)
      hiddenBtn.title = showHidden ? 'Hide hidden files' : 'Show hidden files'
      persistShowHidden(showHidden)
      await tree.setShowHidden(showHidden)
    }

    // ── One toggle, four doors ────────────────────────────────────────────────
    const toggleBtn = IconButton({
      icon: 'panel-right',
      label: 'File explorer',
      title: 'File explorer (Ctrl+Shift+E)',
      class: 'explorer-toggle',
      onClick: () => toggle(!open)
    })
    ctx.titlebarEnd.append(toggleBtn)

    // The dock is workspace-scoped: with ZERO workspaces there is no folder to show
    // and no pane to act into — opening it would be a room with no house. Every open
    // path (button, Ctrl+Shift+E, the palette verb, the boot restore) funnels through
    // toggle(), so the refusal below is the whole story; the button additionally
    // reads disabled so the state is visible, not just inert. When the LAST workspace
    // goes, the dock force-closes WITHOUT persisting — the saved preference survives
    // the valley and the dock returns with the next workspace.
    let persistedOpen = false
    onWorkspacesChange((snapshot) => {
      const none = snapshot.workspaces.length === 0
      toggleBtn.disabled = none
      toggleBtn.title = none ? 'File explorer — create a workspace first' : 'File explorer (Ctrl+Shift+E)'
      if (none && open) toggle(false, { persist: false })
      else if (!none && !open && persistedOpen) toggle(true, { persist: false })
    })

    function toggle(next: boolean, opts: { persist?: boolean } = {}): void {
      if (next && getWorkspaces().workspaces.length === 0) return // no workspace, no dock
      if (open === next) return
      open = next
      dock.hidden = !open
      requestDockLayout()
      toggleBtn.classList.toggle('is-active', open)
      if (opts.persist !== false) {
        persistedOpen = open
        persistOpen(open)
      }
      if (open) {
        void root() // …which pushes the watch set once it knows what is visible
      } else {
        saveMemory()
        unwatchAll() // CLOSED COSTS ZERO: every handle closed, the poll parked, on the spot
        dropGit() // …and the git root unregistered, so the tick stops probing for us too
        setActionRoot('') // no folder on screen, no boundary — and therefore NO actions
      }
      // NO focus() call, deliberately: the pane the user was typing in keeps the caret.
      getTelemetry().captureEvent({ name: 'explorer.dock', props: { open } }) // boolean only — never a path (ADR 0005)
    }

    // Ctrl/Cmd+Shift+E. Capture, like the rail's Ctrl+Shift+B: a pane's terminal would
    // otherwise swallow it. Shift is required — plain Ctrl+E is a real readline keystroke.
    window.addEventListener(
      'keydown',
      (e) => {
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'e') {
          e.preventDefault()
          e.stopPropagation()
          toggle(!open)
        }
      },
      true
    )

    setCommands('explorer', [
      { id: 'explorer.toggle', title: 'Toggle file explorer', hint: 'Explorer', kbd: 'Ctrl+Shift+E', run: () => toggle(!open) }
    ])

    // The Brain view's "show me this file" (ADR 0018/10): open the dock if it is
    // shut, wait out the re-root it may have just started, then the tree's own
    // reveal (expand ancestors, select, scroll). A path outside this workspace's
    // folder shows nothing — the dock never lists outside its root.
    setExplorerRevealHandler((path) => {
      void (async () => {
        if (!open) toggle(true)
        for (let i = 0; i < 40 && !(rootPath && isWithin(rootPath, path, true)); i++) {
          await new Promise((r) => setTimeout(r, 50))
        }
        if (!rootPath || !isWithin(rootPath, path, true)) return
        await tree.reveal(path)
        selection = path
        saveMemory()
      })()
    })

    // ── Persisted boot state, applied BEFORE the dock first paints ────────────
    void explorerInit().then((init) => {
      width = init.width
      applyWidth(false) // restoring is not a change — nothing to persist back
      showHidden = init.showHidden
      hiddenBtn.classList.toggle('is-active', showHidden)
      hiddenBtn.title = showHidden ? 'Hide hidden files' : 'Show hidden files'
      // Restore the INTENT; the open itself may be refused right now (the workspace
      // list often lands after this init) — the workspaces subscriber above reopens
      // the moment a workspace exists. persist:false either way: a restore is not a
      // change, and a refusal must not erase the preference it was refusing.
      persistedOpen = init.open
      if (init.open) toggle(true, { persist: false })
    })

    exposeForDev()
    function exposeForDev(): void {
      if (!import.meta.env.DEV) return
      const w = window as unknown as { __mogging?: Record<string, unknown> }
      w.__mogging = w.__mogging ?? {}
      w.__mogging.explorer = {
        toggle: (next: boolean) => {
          toggle(next)
          return true
        },
        isOpen: () => open,
        width: () => width,
        rootPath: () => rootPath,
        within: (root: string, candidate: string, allowRoot = false) => isWithin(root, candidate, allowRoot),
        expandedDirs: () => tree.expandedDirs(),
        showHidden: () => showHidden,
        // The listing spy: proves laziness, the no-cwd zero, and closed-costs-zero.
        listCalls: () => [...listCalls],
        resetCalls: () => {
          listCalls.length = 0
          return true
        },
        rowNames: () => [...dock.querySelectorAll('.ft-row .ft-name')].map((n) => n.textContent ?? ''),
        hereRow: () => dock.querySelector('.ft-row.is-here .ft-name')?.textContent ?? '',
        // ── The liveness law, made assertable (11/04) ──
        watchStats, // -> { handles, polls, suspended } straight from main's live pool
        batches: () => batchLog.map((b) => [...b]), // every coalesced batch this session
        resetBatches: () => {
          batchLog.length = 0
          return true
        },
        selection: () => selection,
        scrollTop: () => tree.el.scrollTop,
        // ── Git decorations (11/05) ──
        gitRoot: () => gitRoot,
        gitFiles: () => gitFiles.map((f) => ({ ...f })),
        gitEvents: () => gitEvents, // an idle repo must not move this
        resetGitEvents: () => {
          gitEvents = 0
          return true
        },
        /** What a row actually WEARS — read from the DOM, not from our own map. */
        decorationOf: (path: string) => {
          const rows = [...dock.querySelectorAll('.ft-row')]
          const row = rows.find((r) => (r as HTMLElement).title === path)
          if (!row) return null
          const cls = [...row.classList]
          return {
            tone: cls.find((c) => c.startsWith('is-git-'))?.slice('is-git-'.length) ?? null,
            letter: row.querySelector('.ft-badge')?.textContent ?? null,
            ignored: cls.includes('is-ignored'),
            name: row.querySelector('.ft-name')?.textContent ?? ''
          }
        },
        // ── Actions (11/06) ──
        actionLog: () => actions.map((a) => ({ ...a })),
        resetActions: () => {
          actions.length = 0
          return true
        },
        /** The exact text send-to-pane and drag would insert — quoted, and never terminated. */
        insertTextFor: (path: string) => {
          const e = findEntry(path)
          return e ? insertTextFor(e) : ''
        },
        // RAW paths on purpose: the smoke must be able to aim an outside-root or vanished
        // path at MAIN's guard and read the typed refusal it returns. A local pre-check here
        // would test nothing but itself.
        // `osOpen`/`osReveal`, not `open`/`reveal`: the tree's `reveal` (scroll a row into
        // view) already owns that name, and TREELIVE/TREEGIT drive it.
        osOpen: (path: string) => {
          actions.push({ verb: 'open', path })
          return explorerOpen(path)
        },
        osReveal: (path: string) => {
          actions.push({ verb: 'reveal', path })
          return explorerReveal(path)
        },
        sendToPane: (path: string) => {
          const e = findEntry(path)
          if (e) sendToPane(e)
          return !!e
        },
        menuFor: (path: string) => {
          const row = [...dock.querySelectorAll('.ft-row')].find((r) => (r as HTMLElement).title === path)
          const e = findEntry(path)
          if (!row || !e) return false
          const box = row.getBoundingClientRect()
          showRowMenu(e, { x: Math.round(box.left + 24), y: Math.round(box.bottom), row: row as HTMLElement })
          return true
        },
        /** The dataTransfer a drag would carry — built through the REAL handler. */
        dragPayload: (path: string) => {
          const e = findEntry(path)
          if (!e) return null
          const data: Record<string, string> = {}
          const dt = {
            effectAllowed: '',
            setData: (type: string, value: string) => {
              data[type] = value
            }
          }
          fillDrag(e, { dataTransfer: dt } as unknown as DragEvent)
          return data
        },
        lens: () => lens,
        setLens: async (on: boolean) => {
          await setLens(on)
          return true
        },
        lensCount: () => Number(lensChip.querySelector('.count-badge')?.textContent ?? -1),
        lensVisible: () => !lensChip.hidden,
        setScrollTop: (px: number) => {
          tree.el.scrollTop = px
          return true
        },
        reveal: async (path: string) => {
          await tree.reveal(path)
          return true
        },
        setExpanded: async (dirs: string[]) => {
          await tree.setExpanded(dirs)
          saveMemory()
          pushWatch()
          return true
        },
        // The gallery stages a fixture tree (no username in any visible path) without
        // inventing a workspace — the `openWizard({ cwd })` precedent.
        setRootForShot: async (path: string) => {
          dropGit()
          rootPath = path
          wsId = ''
          rootLabel.textContent = middleTruncate(path)
          rootLabel.title = path
          tree.el.hidden = false
          emptyHost.hidden = true
          await tree.setRoot(path)
          pushWatch()
          setActionRoot(path)
          gitFilesWatch(path) // the shot must photograph REAL decorations, not a bare tree
          return true
        },
        expand: async (path: string) => {
          await tree.setExpanded([...tree.expandedDirs(), path])
          saveMemory()
          pushWatch()
          return true
        }
      }
    }
  }
}
