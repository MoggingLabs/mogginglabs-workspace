import { EXPLORER_LIST_CAP, type ExplorerEntry, type ExplorerResult } from '@contracts'
import { el, clear } from './dom'
import { icon } from './icons'
import { Pill } from './pill'
import { EmptyState } from './empty-state'

/**
 * The file tree (Phase-11/02, ADR 0010): ONE virtualized flat list wearing tree
 * semantics — the VS Code shape (RESEARCH §2), clean-room. An expansion-map over
 * lazy nodes is flattened to a VISIBLE-ROWS array on every mutation; the DOM
 * holds only a window of viewport ± overscan rows over a full-height spacer, so
 * ten thousand entries cost the same paint as thirty.
 *
 * Because rows virtualize, tree ARIA is mandatory, not decorative (RESEARCH §6):
 * `aria-level` / `aria-setsize` / `aria-posinset` are required exactly when the
 * full set is NOT in the DOM. One row holds tabindex 0 (roving), the APG keyboard
 * map is implemented verbatim, and filenames are UNTRUSTED content — `textContent`
 * only, never markup.
 *
 * The component never touches IPC: the caller injects `list` (the
 * `folder-browser.ts` posture, ADR 0004), so this is drivable from a test with a
 * stub. Every entry arrives carrying its own absolute path; the only path
 * arithmetic here is slicing a caller-supplied descendant path against the root
 * it gave us (reveal).
 */

export interface FileTreeOpts {
  /** Injected loader — the explorer feature passes its typed `explorer:list` client. */
  list: (path: string, showHidden: boolean) => Promise<ExplorerResult>
  /** Enter / double-click on a FILE. Directories toggle instead (the APG default action). */
  onActivate?: (entry: ExplorerEntry) => void
  /** Right-click, Shift+F10, or the ContextMenu key on a row (11/06). The component reports
   *  WHERE and ON WHAT; what the menu contains is the owner's business, not the tree's. */
  onContextMenu?: (entry: ExplorerEntry, at: { x: number; y: number; row: HTMLElement }) => void
  /** A row started a drag. The owner fills the dataTransfer — the tree owns no payload format. */
  onDragStart?: (entry: ExplorerEntry, e: DragEvent) => void
  /** Selection moved (selection follows focus, the single-select tree idiom). */
  onSelect?: (entry: ExplorerEntry) => void
  /** The expanded set changed by USER action (04 wires this to `explorer:watch`). */
  onExpandedChange?: (dirs: string[]) => void
  showHidden?: boolean
}

/** One visible row. Real entries carry `expanded` when they are directories;
 *  synthetic rows (loading / refusal / truncated tail / empty) carry their flag
 *  and reuse `entry` for path context only. */
export interface FileTreeRow {
  entry: ExplorerEntry
  level: number
  expanded?: boolean
  loading?: boolean
  refusal?: 'denied' | 'missing' | 'not-a-directory' | 'invalid'
  truncated?: boolean
  empty?: boolean
  posinset: number
  setsize: number
}

/**
 * A row's paint, computed by the OWNER and handed down (11/05). The component knows nothing
 * about git — it renders a letter, an ink family, and a dim flag. Decorations are PAINT: they
 * never reorder, hide, or mutate an entry.
 */
export interface FileTreeDecoration {
  /** M/A/U/D/C — files only. A folder takes the COLOUR and no letter (VS Code's
   *  `FileDecoration.propagate`: the badge belongs to the file that changed). */
  letter?: string
  tone?: 'modified' | 'added' | 'untracked' | 'deleted' | 'conflicted'
  /** git ignores this path: dim it. Still selectable, still navigable — dimmed, never hidden. */
  ignored?: boolean
}

export interface FileTreeHandle {
  el: HTMLElement
  /** Re-root the tree: expansion, selection, and every cached listing reset. */
  setRoot(path: string): Promise<void>
  /** Empty the tree — no root, no rows, no DOM — WITHOUT issuing a listing. What a
   *  workspace with no folder gets: the previous workspace's filenames must not sit
   *  in the DOM behind an empty state (11/03). Also cancels any listing in flight. */
  clear(): void
  /** Expand ancestors down to `path` (must live under the root), select and scroll to it. */
  reveal(path: string): Promise<void>
  /** Re-list these dirs if cached; an IDENTICAL listing (name+kind+repo sequence)
   *  is zero DOM work. 04 feeds this from coalesced `explorer:changed` batches. */
  applyChanged(dirs: string[]): Promise<void>
  expandedDirs(): string[]
  /** Restore a persisted expansion set (03) — loads whatever the set makes visible. */
  setExpanded(dirs: string[]): Promise<void>
  setShowHidden(v: boolean): Promise<void>
  /** The soft "you are here" tint (11/03): the focused pane's cwd. Tints ONLY if that
   *  row already exists — never expands to reach it, never scrolls to it. `null` clears. */
  setHere(path: string | null): void
  /** Paint-only (11/05): decorations by ABSOLUTE path. Never changes which rows exist. */
  setDecorations(dec: Map<string, FileTreeDecoration> | null): void
  /** The Changes lens (11/05): render ONLY these paths. `null` restores the whole tree.
   *  The owner passes the changed files AND their ancestor dirs, or the tree renders nothing. */
  setFilter(paths: Set<string> | null): void
  /** A dir's cached children — what the owner needs to ask git about, without a second listing. */
  entriesOf(dir: string): ExplorerEntry[]
  focusList(): void
}

/** Fixed row pitch — the house hitbox floor. The smoke computes its DOM bound from these. */
export const FILE_TREE_ROW_H = 28
export const FILE_TREE_OVERSCAN = 8

/** Refusals as one dimmed line — the fb-refusal copy, at row size. */
const REFUSAL_TEXT: Record<string, string> = {
  denied: 'No permission to look inside',
  missing: "This folder isn't there any more",
  'not-a-directory': 'Not a folder',
  invalid: 'Unreadable path'
}

/**
 * The APG type-ahead window. The buffer MUST die on its own. An immortal one turns the next
 * lone keystroke into a search for "za" — which matches nothing, so focus stays stuck where
 * the 'z' left it — and it goes on swallowing the Escape that belonged to the view around us.
 */
const TYPE_AHEAD_MS = 500

interface DirState {
  children: ExplorerEntry[] | null
  refusal: FileTreeRow['refusal'] | null
  truncated: boolean
  loading: Promise<void> | null
  sig: string
  gen: number
}

/** Change-only signature: what the tree renders from a listing, and nothing else. */
const sigOf = (r: ExplorerResult): string =>
  r.ok ? r.entries.map((e) => `${e.kind}:${e.isRepo ? '*' : ''}${e.name}`).join('\n') + (r.truncated ? '\n+' : '') : `!${r.reason}`

export function createFileTree(opts: FileTreeOpts): FileTreeHandle {
  let rootPath = ''
  let generation = 0 // setRoot invalidates every in-flight listing
  let showHidden = opts.showHidden ?? false
  const nodes = new Map<string, DirState>()
  const expanded = new Set<string>()
  let rows: FileTreeRow[] = []
  let active = 0
  let activePath = '' // survives flattening better than an index
  let selectedPath = ''
  let herePath = ''
  let typeAhead = ''
  let typeAheadTimer: ReturnType<typeof setTimeout> | null = null
  let decorations: Map<string, FileTreeDecoration> | null = null
  let filter: Set<string> | null = null // the Changes lens

  const body = el('div', { class: 'ft-body', role: 'none' })
  const scroller = el('div', { class: 'file-tree', role: 'tree', ariaLabel: 'Files' }, [body])

  // ── model ─────────────────────────────────────────────────────────────────────
  function state(dir: string): DirState {
    let st = nodes.get(dir)
    if (!st) {
      st = { children: null, refusal: null, truncated: false, loading: null, sig: '', gen: 0 }
      nodes.set(dir, st)
    }
    return st
  }

  /** Load a dir's children once; concurrent callers share the same flight. */
  function ensureLoaded(dir: string): Promise<void> {
    const st = state(dir)
    if (st.children || st.refusal) return Promise.resolve()
    if (st.loading) return st.loading
    const token = ++st.gen
    const gen = generation
    st.loading = (async () => {
      let res: ExplorerResult
      try {
        res = await opts.list(dir, showHidden)
      } catch {
        res = { ok: false, reason: 'missing', path: dir } // the loader itself failed
      }
      if (token !== st.gen || gen !== generation) return // superseded or re-rooted
      st.loading = null
      if (res.ok) {
        st.children = res.entries
        st.truncated = res.truncated
        st.refusal = null
      } else {
        st.refusal = res.reason
        st.children = null
      }
      st.sig = sigOf(res)
      refresh()
    })()
    refresh() // the loading row appears immediately
    return st.loading
  }

  /** Flatten the expansion-map into the visible-rows array. */
  function flatten(): void {
    rows = []
    if (rootPath) walk(rootPath, 1)
    // Re-derive the active index from its path; fall back to the nearest ancestor
    // still visible (a collapsed subtree lands focus on the dir that swallowed it).
    if (activePath) {
      let i = rows.findIndex((r) => r.entry.path === activePath)
      while (i < 0 && activePath.length > rootPath.length) {
        activePath = activePath.slice(0, Math.max(rootPath.length, activePath.search(/[\\/][^\\/]*$/)))
        i = rows.findIndex((r) => r.entry.path === activePath)
      }
      active = i >= 0 ? i : 0
    }
    if (active >= rows.length) active = Math.max(0, rows.length - 1)
  }

  function walk(dir: string, level: number): void {
    const st = nodes.get(dir)
    if (!st) return
    const holder: ExplorerEntry = { name: '', path: dir, kind: 'dir' }
    if (st.loading && !st.children) {
      rows.push({ entry: holder, level, loading: true, posinset: 1, setsize: 1 })
      return
    }
    if (st.refusal) {
      rows.push({ entry: holder, level, refusal: st.refusal, posinset: 1, setsize: 1 })
      return
    }
    // The lens narrows WHICH rows exist — the one sanctioned exception to "decorations are
    // paint". ARIA counts follow the filtered set, or a screen reader would announce
    // "1 of 40" over a list of three.
    const all = st.children ?? []
    const kids = filter ? all.filter((e) => filter?.has(e.path)) : all
    if (!kids.length) {
      // An expanded empty dir gets one dimmed row — the ROOT included. The root used to get
      // an EmptyState instead: a roleless <div>, appended straight into role="tree", which
      // left the tree's only child not a treeitem. A tree owns treeitems and groups and
      // nothing else, and a screen reader cannot walk what has no role.
      if (!filter) rows.push({ entry: holder, level, empty: true, posinset: 1, setsize: 1 })
      return
    }
    const capped = st.truncated && !filter
    const size = kids.length + (capped ? 1 : 0)
    kids.forEach((e, i) => {
      const isOpen = e.kind === 'dir' && expanded.has(e.path)
      rows.push({ entry: e, level, expanded: e.kind === 'dir' ? isOpen : undefined, posinset: i + 1, setsize: size })
      if (isOpen) walk(e.path, level + 1)
    })
    if (capped) rows.push({ entry: holder, level, truncated: true, posinset: size, setsize: size })
  }

  // ── virtualization ────────────────────────────────────────────────────────────
  let rafPending = false
  scroller.addEventListener('scroll', () => {
    if (rafPending) return
    rafPending = true
    requestAnimationFrame(() => {
      rafPending = false
      renderWindow()
    })
  })

  function refresh(): void {
    flatten()
    renderWindow()
  }

  function renderWindow(): void {
    const hadFocus = scroller.contains(document.activeElement)
    clear(body)
    if (!rows.length) {
      body.style.height = ''
      const root = nodes.get(rootPath)
      // Only the Changes lens can empty a LISTED tree now — an empty folder renders its own
      // (empty) treeitem (see walk). The panel still rides inside a `group`, because that and
      // `treeitem` are the only things a tree may own, and a bare <div> is neither.
      if (root?.children)
        body.append(
          el('div', { role: 'group' }, [
            EmptyState({ icon: 'folder', title: 'This folder is empty', body: 'Nothing here yet — agents will change that.' })
          ])
        )
      return
    }
    body.style.height = rows.length * FILE_TREE_ROW_H + 'px'
    const viewRows = Math.ceil(scroller.clientHeight / FILE_TREE_ROW_H) + 1 // +1: a mid-row scrollTop shows one extra partial
    const first = Math.max(0, Math.floor(scroller.scrollTop / FILE_TREE_ROW_H) - FILE_TREE_OVERSCAN)
    const count = Math.min(rows.length - first, viewRows + 2 * FILE_TREE_OVERSCAN)
    const frag = document.createDocumentFragment()
    for (let i = first; i < first + count; i++) frag.append(rowEl(rows[i], i))
    body.append(frag)
    // Roving tabindex: the active row holds 0; when it is scrolled out of the DOM,
    // the first rendered row takes it so the list stays tabbable.
    if (active < first || active >= first + count) {
      const firstRow = body.querySelector('.ft-row')
      if (firstRow instanceof HTMLElement) firstRow.tabIndex = 0
    } else if (hadFocus) {
      const node = body.children[active - first]
      if (node instanceof HTMLElement) node.focus({ preventScroll: true })
    }
  }

  function rowEl(r: FileTreeRow, i: number): HTMLElement {
    const meta = !!(r.loading || r.refusal || r.truncated || r.empty)
    const isDir = !meta && r.entry.kind === 'dir'
    const label = r.loading
      ? 'Loading…'
      : r.refusal
        ? (REFUSAL_TEXT[r.refusal] ?? REFUSAL_TEXT.missing)
        : r.truncated
          ? `Capped at ${EXPLORER_LIST_CAP.toLocaleString()} entries — the rest are not shown`
          : r.empty
            ? '(empty)'
            : r.entry.name
    const attrs: Record<string, string> = {
      'aria-level': String(r.level),
      'aria-setsize': String(r.setsize),
      'aria-posinset': String(r.posinset),
      'aria-selected': String(!meta && selectedPath === r.entry.path)
    }
    if (isDir) attrs['aria-expanded'] = String(!!r.expanded)
    if (meta) attrs['aria-disabled'] = 'true'
    const guides: HTMLElement[] = []
    for (let l = 1; l < r.level; l++) guides.push(el('span', { class: 'ft-guide' }))
    // The decoration split (RESEARCH §2): a file wears its letter AND its colour; a folder
    // wears only the colour its descendants propagated up to it.
    const dec = meta ? undefined : decorations?.get(r.entry.path)
    const node = el(
      'div',
      {
        class:
          'ft-row' +
          (meta ? ' ft-row--meta' : '') +
          (r.refusal ? ' ft-row--refusal' : '') +
          (i === active ? ' is-active' : '') +
          (!meta && selectedPath === r.entry.path ? ' is-selected' : '') +
          (!meta && herePath && herePath === r.entry.path ? ' is-here' : '') +
          (dec?.tone ? ' is-git-' + dec.tone : '') +
          (dec?.ignored ? ' is-ignored' : ''),
        role: 'treeitem',
        tabIndex: i === active ? 0 : -1,
        title: meta ? undefined : r.entry.path,
        attrs,
        style: { top: i * FILE_TREE_ROW_H + 'px' },
        onClick: (e) => {
          if (meta) return setActive(i, { select: false })
          setActive(i)
          // A native double-click is click, click, dblclick. Click 1 toggles the dir open and
          // renderWindow rebuilds the row under the pointer; click 2 then lands on that NEW
          // node and toggles it straight back shut — double-clicking a folder netted a flicker
          // and nothing else. `detail` counts the clicks in the sequence (1, then 2), so the
          // toggle belongs to the first one alone. A synthetic .click() carries detail 0 — a
          // real single click, and it still opens.
          if (isDir && e.detail <= 1) void toggle(r.entry.path)
        },
        onDblclick: () => {
          if (!meta && r.entry.kind === 'file') opts.onActivate?.(r.entry)
        }
      },
      [
        ...guides,
        isDir
          ? el('span', { class: 'ft-twist' + (r.expanded ? ' is-open' : '') }, [icon('chevron-right', 12)])
          : el('span', { class: 'ft-twist' }),
        el('span', { class: 'ft-ico' }, [
          r.refusal ? icon('alert', 12) : meta ? null : icon(isDir ? (r.expanded ? 'folder-open' : 'folder') : 'file', 14)
        ]),
        el('span', { class: 'ft-name', text: label }), // textContent ONLY — filenames are untrusted
        !meta && r.entry.isRepo ? Pill({ text: 'repo', tone: 'accent', icon: 'git-branch' }) : null,
        dec?.letter ? el('span', { class: 'ft-badge', text: dec.letter }) : null
      ]
    )

    // ── Actions (11/06). A synthetic row (loading, refusal, cap, empty) is not a file:
    //    it has no menu and it cannot be dragged.
    if (!meta) {
      node.addEventListener('contextmenu', (e: MouseEvent) => {
        e.preventDefault()
        setActive(i) // right-clicking a row SELECTS it — the menu must act on what you see highlighted
        opts.onContextMenu?.(r.entry, { x: e.clientX, y: e.clientY, row: node })
      })
      if (opts.onDragStart) {
        node.draggable = true
        node.addEventListener('dragstart', (e: DragEvent) => opts.onDragStart?.(r.entry, e))
      }
    }
    return node
  }

  // ── focus / selection ─────────────────────────────────────────────────────────
  function ensureVisible(i: number): void {
    const top = i * FILE_TREE_ROW_H
    if (top < scroller.scrollTop) scroller.scrollTop = top
    else if (top + FILE_TREE_ROW_H > scroller.scrollTop + scroller.clientHeight)
      scroller.scrollTop = top + FILE_TREE_ROW_H - scroller.clientHeight
  }

  function setActive(i: number, o: { select?: boolean; focus?: boolean } = {}): void {
    if (!rows.length) return
    // Never steal focus (the tmux-sidebar virtue): only move DOM focus when the
    // tree already holds it, or the caller explicitly asked (focusList).
    const hadFocus = scroller.contains(document.activeElement)
    active = Math.max(0, Math.min(rows.length - 1, i))
    const r = rows[active]
    activePath = r.entry.path
    const meta = !!(r.loading || r.refusal || r.truncated || r.empty)
    if (o.select !== false && !meta && selectedPath !== r.entry.path) {
      selectedPath = r.entry.path
      opts.onSelect?.(r.entry)
    }
    ensureVisible(active)
    renderWindow()
    if (hadFocus || o.focus) {
      const node = body.querySelector('.ft-row[tabindex="0"]')
      if (node instanceof HTMLElement) node.focus({ preventScroll: true })
    }
  }

  /** `child` lives strictly under `dir` (separator-boundary safe: `a\bc` ⊄ `a\b`). */
  const isUnder = (child: string, dir: string): boolean =>
    child.length > dir.length && child.startsWith(dir) && (dir.endsWith('\\') || dir.endsWith('/') || child[dir.length] === '\\' || child[dir.length] === '/')

  async function toggle(dir: string): Promise<void> {
    if (expanded.has(dir)) {
      expanded.delete(dir)
      if (isUnder(activePath, dir)) activePath = dir
      opts.onExpandedChange?.(expandedDirs())
      refresh()
    } else {
      expanded.add(dir)
      opts.onExpandedChange?.(expandedDirs())
      refresh()
      await ensureLoaded(dir)
    }
  }

  // ── keyboard: the APG tree map, verbatim ──────────────────────────────────────
  /** Drop the buffer AND the timer that would have dropped it — navigation ends a search. */
  function clearAhead(): void {
    typeAhead = ''
    if (typeAheadTimer != null) clearTimeout(typeAheadTimer)
    typeAheadTimer = null
  }

  /** Restart the window on every keystroke: a search is only alive while it is being typed. */
  function armAhead(): void {
    if (typeAheadTimer != null) clearTimeout(typeAheadTimer)
    typeAheadTimer = setTimeout(clearAhead, TYPE_AHEAD_MS)
  }

  scroller.addEventListener('keydown', (e: KeyboardEvent) => {
    const k = e.key
    const r = rows[active]
    if (k === 'ArrowDown') return (e.preventDefault(), clearAhead(), setActive(active + 1))
    if (k === 'ArrowUp') return (e.preventDefault(), clearAhead(), setActive(active - 1))
    if (k === 'Home') return (e.preventDefault(), clearAhead(), setActive(0))
    if (k === 'End') return (e.preventDefault(), clearAhead(), setActive(rows.length - 1))
    if (k === 'PageDown' || k === 'PageUp') {
      e.preventDefault()
      clearAhead()
      const page = Math.max(1, Math.floor(scroller.clientHeight / FILE_TREE_ROW_H))
      return setActive(active + (k === 'PageDown' ? page : -page))
    }
    if (k === 'ArrowRight') {
      e.preventDefault()
      clearAhead()
      if (!r || r.expanded === undefined) return
      if (!r.expanded) return void toggle(r.entry.path) // closed dir: open, focus stays
      const next = rows[active + 1]
      if (next && next.level > r.level) setActive(active + 1) // open dir: to first child
      return
    }
    if (k === 'ArrowLeft') {
      e.preventDefault()
      clearAhead()
      if (!r) return
      if (r.expanded) return void toggle(r.entry.path) // open dir: close, focus stays
      for (let j = active - 1; j >= 0; j--) {
        if (rows[j].level === r.level - 1) return setActive(j) // else: to parent
      }
      return
    }
    if (k === 'Enter') {
      e.preventDefault()
      if (!r || r.loading || r.refusal || r.truncated || r.empty) return
      if (r.entry.kind === 'dir') void toggle(r.entry.path) // the APG default action
      else opts.onActivate?.(r.entry)
      return
    }
    // The menu, without a mouse (11/06): Shift+F10 and the dedicated ContextMenu key are
    // what a keyboard user actually presses. Anchored to the ROW, not the pointer.
    if ((k === 'F10' && e.shiftKey) || k === 'ContextMenu') {
      e.preventDefault()
      if (!r || r.loading || r.refusal || r.truncated || r.empty) return
      const node = body.querySelector('.ft-row[tabindex="0"]')
      if (!(node instanceof HTMLElement)) return
      const box = node.getBoundingClientRect()
      opts.onContextMenu?.(r.entry, { x: Math.round(box.left + 24), y: Math.round(box.bottom), row: node })
      return
    }
    if (k === 'Escape' && typeAhead) {
      e.preventDefault()
      e.stopPropagation() // this Esc clears the type-ahead, not the surrounding view
      clearAhead() // …and the timer with it: nothing is left to fire into the next search
      return
    }
    // Type-ahead within visible rows (the folder-browser precedent): printable characters
    // only, never a chord. The buffer grows until Esc, navigation, or TYPE_AHEAD_MS of
    // silence — it used to grow until Esc and nothing else, so a search never really ended.
    if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      typeAhead += k.toLowerCase()
      armAhead()
      // APG's same-letter rule. A buffer of ONE repeated character is not a search for "aa"
      // — nothing is named that, so the old loop simply sat on the first 'a' forever. It
      // means "the NEXT thing starting with a", and because the scan always begins one row
      // BELOW the active one, pressing the key again walks to the following match.
      const needle = /^(.)\1*$/.test(typeAhead) ? typeAhead[0] : typeAhead
      for (let step = 1; step <= rows.length; step++) {
        const j = (active + step) % rows.length
        const c = rows[j]
        if (!c.loading && !c.refusal && !c.truncated && !c.empty && c.entry.name.toLowerCase().startsWith(needle)) {
          return setActive(j)
        }
      }
    }
  })

  // ── API ───────────────────────────────────────────────────────────────────────
  const expandedDirs = (): string[] => [...expanded]

  /** Reset every scrap of state. `generation++` is what makes it safe: a listing still
   *  in flight for the OLD root lands on a stale generation and is dropped, so it can
   *  never repopulate a tree that has moved on. */
  function reset(path: string): void {
    generation++
    rootPath = path
    nodes.clear()
    expanded.clear()
    rows = []
    active = 0
    activePath = ''
    selectedPath = ''
    herePath = ''
    clearAhead() // a pending timer would fire into the NEXT root and clear a live search there
    scroller.scrollTop = 0
    refresh()
  }

  async function setRoot(path: string): Promise<void> {
    reset(path)
    await ensureLoaded(path)
  }

  async function reveal(path: string): Promise<void> {
    if (!rootPath || !isUnder(path, rootPath)) return
    // Slice the caller's own path against the root it gave us — no OS arithmetic.
    const sep = path.includes('\\') ? '\\' : '/'
    const segs = path.slice(rootPath.length).split(/[\\/]+/).filter(Boolean)
    let acc = rootPath
    for (const seg of segs.slice(0, -1)) {
      acc = acc.endsWith(sep) ? acc + seg : acc + sep + seg
      if (!expanded.has(acc)) {
        expanded.add(acc)
        refresh()
      }
      await ensureLoaded(acc)
    }
    flatten()
    const i = rows.findIndex((r) => r.entry.path === path && !r.loading && !r.refusal && !r.truncated && !r.empty)
    if (i >= 0) setActive(i)
    else renderWindow()
  }

  /**
   * Drop every cached dir its parent no longer lists — the dir an agent DELETED while it
   * was expanded. It collapses into the parent's refreshed listing, and nothing crashes:
   * its rows are already gone (flatten only walks entries that exist), but leaving it in
   * `expanded` would keep it in the watch set forever, so main would keep polling a path
   * that isn't there. Returns whether anything was dropped.
   */
  function prune(): boolean {
    if (!rootPath) return false
    const alive = new Set<string>()
    const stack = [rootPath]
    while (stack.length) {
      const dir = stack.pop() as string
      if (alive.has(dir)) continue
      alive.add(dir)
      const st = nodes.get(dir)
      if (!st?.children) continue
      for (const e of st.children) if (e.kind === 'dir' && nodes.has(e.path)) stack.push(e.path)
    }
    let dropped = false
    for (const p of [...nodes.keys()]) {
      if (alive.has(p)) continue
      nodes.delete(p)
      dropped = true
    }
    for (const p of [...expanded]) {
      if (alive.has(p)) continue
      expanded.delete(p)
      dropped = true
    }
    return dropped
  }

  async function applyChanged(dirs: string[]): Promise<void> {
    const gen = generation
    let changed = false
    await Promise.all(
      dirs.map(async (dir) => {
        const st = nodes.get(dir)
        if (!st || (!st.children && !st.refusal)) return // never listed — nothing on screen from it
        const token = ++st.gen
        let res: ExplorerResult
        try {
          res = await opts.list(dir, showHidden)
        } catch {
          return // a failed re-list keeps the last good listing
        }
        if (token !== st.gen || gen !== generation) return
        const sig = sigOf(res)
        if (sig === st.sig) return // identical listing → zero DOM work
        st.sig = sig
        if (res.ok) {
          st.children = res.entries
          st.truncated = res.truncated
          st.refusal = null
        } else {
          st.refusal = res.reason
          st.children = null
        }
        changed = true
      })
    )
    if (gen !== generation) return // re-rooted mid-flight; this batch is about a tree that is gone
    if (!changed) return // nothing moved → zero DOM work, and the watch set is still right
    // Expansion, selection, and scroll all survive: refresh() re-flattens and repaints
    // the same window — it never touches scrollTop, `expanded`, or `selectedPath`.
    const dropped = prune()
    refresh()
    if (dropped) opts.onExpandedChange?.(expandedDirs()) // the dead dirs leave the watch set
  }

  async function setExpanded(dirs: string[]): Promise<void> {
    expanded.clear()
    for (const d of dirs) expanded.add(d)
    // Load whatever the set makes visible — deeper layers surface as parents land.
    for (;;) {
      flatten()
      const pending = rows
        .filter((r) => r.expanded === true)
        .map((r) => r.entry.path)
        .filter((p) => {
          const st = nodes.get(p)
          return !st || (!st.children && !st.refusal)
        })
      if (!pending.length) break
      await Promise.all(pending.map(ensureLoaded))
    }
    refresh()
  }

  async function setShowHidden(v: boolean): Promise<void> {
    if (showHidden === v) return
    showHidden = v
    // Re-list every dir we have listed; the per-dir signature keeps unchanged ones free.
    await applyChanged([...nodes.keys()])
  }

  return {
    el: scroller,
    setRoot,
    clear: () => reset(''), // no root -> flatten yields no rows -> the DOM empties. No listing.
    reveal,
    applyChanged,
    expandedDirs,
    setExpanded,
    setShowHidden,
    setHere: (p) => {
      const next = p ?? ''
      if (next === herePath) return
      herePath = next
      renderWindow() // paint-only: no listing, no expansion, no scroll (11/03's law)
    },
    setDecorations: (dec) => {
      decorations = dec
      renderWindow() // PAINT: the row set is untouched — nothing reorders, nothing hides
    },
    setFilter: (paths) => {
      filter = paths
      refresh() // the lens DOES change which rows exist, so re-flatten
    },
    entriesOf: (dir) => nodes.get(dir)?.children ?? [],
    focusList: () => setActive(active, { select: false, focus: true })
  }
}
