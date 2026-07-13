import { FS_DRIVE_ROOT, FS_LIST_CAP, type DirEntry, type DirListing, type DirRefusal, type DirResult, type ListDirRequest } from '@contracts'
import { el, clear } from './dom'
import { icon } from './icons'
import { Button } from './button'
import { Pill } from './pill'
import { EmptyState } from './empty-state'
import { createCheckbox } from './checkbox'

/**
 * A read-only directory browser (Phase-8.5/03): breadcrumb · folder list · footer.
 *
 * SELECTION MODEL, because it is the thing everything else follows from. Arriving in
 * a folder selects it — the breadcrumb's last segment fills in, and that folder is
 * what the caller receives. Clicking a row selects that CHILD instead (one click to
 * pick). Enter, double-click, or → descends into it, which makes it the current
 * folder and re-selects it. So there is exactly one selection at all times and it is
 * always a real directory.
 *
 * The component never touches IPC: the caller injects `listDir`, so `components/`
 * stays free of channels (ADR 0004) and this is drivable from a test with a stub.
 * All path arithmetic already happened in the main process — every entry and every
 * breadcrumb arrives carrying its own absolute path.
 */

export interface FolderBrowserOpts {
  showHidden?: boolean
  /** Injected loader — the wizard passes its typed client. */
  listDir: (req: ListDirRequest) => Promise<DirResult>
  /** Fires ONLY on user action inside the browser. The owner then updates the
   *  selection, and (because it caused nothing here) never writes back. */
  onSelect?: (path: string) => void
}

export interface FolderBrowserHandle {
  el: HTMLElement
  /** The directory currently being listed. */
  path(): string
  /** The chosen folder — the current directory, or a clicked child of it. */
  selected(): string
  /**
   * Adopt a listing the OWNER already fetched, and the selection the owner holds.
   * Silent — never fires `onSelect`. `selected` may be `''` (looking, not choosing)
   * or a child of `listing.path` (the owner's cwd after a pick).
   */
  applyListing(listing: DirListing, selected: string): void
  /** Render a refusal without moving the selection: the last good place stays on screen. */
  showRefusal(refusal: DirRefusal): void
  refresh(): Promise<void>
  /** Move DOM focus into the list, onto the active row. */
  focusList(): void
}

const REFUSALS: Record<string, { title: string; body: string }> = {
  denied: { title: 'This folder is locked', body: 'Your account does not have permission to look inside it.' },
  missing: { title: "That folder isn't there", body: 'It may have been moved or renamed. Check the path, or go up a level.' },
  'not-a-directory': { title: 'That is a file, not a folder', body: 'Pick the folder that contains it.' },
  invalid: { title: 'Not a full path', body: 'Type an absolute path — one that starts at a drive or at /.' }
}

REFUSALS.unavailable = {
  title: 'Could not verify this folder',
  body: 'The filesystem service did not answer. Try again before launching.'
}

export function createFolderBrowser(opts: FolderBrowserOpts): FolderBrowserHandle {
  let listing: DirListing | null = null
  /** The last listing that actually OPENED. A refusal keeps it, because it is the only way
   *  back out of one: the crumbs are drawn from it, and the refusal panel's escape goes to it. */
  let lastGood: DirListing | null = null
  let refusal: { reason: string; path: string } | null = null
  let cur = ''
  let selected = ''
  let showHidden = opts.showHidden ?? false
  let active = 0 // index into `rows` — roving tabindex, mirrors grid-preview.ts
  let filter = ''
  let rows: { label: string; path: string; entry: DirEntry | null }[] = []

  const crumbs = el('nav', { class: 'fb-crumbs', ariaLabel: 'Folder path' })
  // tabIndex -1: the list is the focus of LAST resort. The keydown listener lives here, so
  // when a branch renders no rows at all (a filter that matches nothing), something inside
  // must still be able to take a keystroke — or the Esc that clears it never arrives. Never
  // in the tab order; the roving row is the tab stop.
  const list = el('div', { class: 'fb-list', role: 'listbox', ariaLabel: 'Folders', tabIndex: -1 })
  const filterChip = el('span', { class: 'fb-filter' })
  const truncNote = el('span', { class: 'fb-trunc' })

  const hidden = createCheckbox({
    checked: showHidden,
    label: 'Show hidden folders',
    // Re-list the same folder. `keepSelection` because revealing dotfolders is not
    // a navigation — it must not quietly re-select the current directory over a
    // child the user had picked.
    onChange: (on) => {
      showHidden = on
      void load(cur, { keepSelection: true })
    }
  })

  const foot = el('div', { class: 'fb-foot' }, [
    hidden.el,
    filterChip,
    truncNote,
    // Scope honesty (step 4): say what this reads, where the user is reading.
    el('span', {
      class: 'fb-note',
      text: 'Reads folder names only — nothing is indexed, watched, or sent anywhere.'
    })
  ])

  const root = el('div', { class: 'folder-browser' }, [crumbs, list, foot])

  // ── rendering ────────────────────────────────────────────────────────────────
  function renderCrumbs(): void {
    clear(crumbs)
    // A refusal nulls `listing` — but the trail is how you climb OUT of one. Keep the last
    // good crumbs on screen, or a locked folder leaves the component with nothing focusable
    // in it anywhere: the refusal used to be a picture with no way back.
    const trail = (listing ?? lastGood)?.crumbs ?? []
    trail.forEach((c, i) => {
      if (i > 0) crumbs.append(el('span', { class: 'fb-crumb-sep' }, [icon('chevron-right', 12)]))
      const isCurrent = i === trail.length - 1
      const b = el('button', {
        class: 'fb-crumb' + (isCurrent ? ' is-current' : '') + (isCurrent && selected === cur ? ' is-selected' : ''),
        type: 'button',
        text: c.label,
        title: c.path || 'This PC',
        onClick: () => void load(c.path)
      })
      if (isCurrent) b.setAttribute('aria-current', 'location')
      crumbs.append(b)
    })
  }

  function visibleEntries(): DirEntry[] {
    const f = filter.toLowerCase()
    const ents = listing?.entries ?? []
    return f ? ents.filter((e) => e.name.toLowerCase().includes(f)) : ents
  }

  /** The list only CLAIMS to be a listbox while it holds options. A refusal panel, an empty
   *  state, and the refusal's own button are not `option`s, and a listbox may own nothing
   *  else — so the role leaves with the rows instead of lying about what is inside. */
  function listRole(hasOptions: boolean): void {
    if (hasOptions) list.setAttribute('role', 'listbox')
    else list.removeAttribute('role')
  }

  /**
   * The way OUT of a dead end. A refusal renders no rows, and it used to render no crumbs
   * either, so NOTHING in the component could take a keystroke: press Enter on a locked
   * folder and focus fell to <body> — and since the keydown listener lives on `list`, the
   * browser went keyboard-dead where it stood. It cannot offer "up": a refusal carries no
   * `parent` (fs.ipc.ts) and @ui may not derive one (ADR 0004). So it goes back to the last
   * folder that opened — which, when you descended INTO the refusal, is exactly where up was.
   */
  function refusalWayOut(): HTMLElement {
    const back = lastGood
    const b = back
      ? Button({
          label: 'Go back',
          icon: 'chevron-left',
          variant: 'ghost',
          size: 'sm',
          title: back.path || 'This PC',
          onClick: () => void load(back.path)
        })
      : // Nothing has opened yet (the owner handed us a bad path on arrival). Re-asking is
        // the only honest offer — and it is the one the `unavailable` copy already makes.
        Button({ label: 'Try again', icon: 'rotate-cw', variant: 'ghost', size: 'sm', title: cur, onClick: () => void load(cur) })
    b.style.marginTop = 'var(--sp-3)'
    return b
  }

  /** Focus whatever the list is currently offering: the active row, else the refusal's own
   *  escape, else the list itself. One of the three must always hold focus — see renderList. */
  function focusActive(): void {
    const node = rows.length ? list.children[active] : (list.querySelector('.fb-refusal button') ?? list)
    if (node instanceof HTMLElement) node.focus()
  }

  function renderList(): void {
    // Type-to-filter repaints the WHOLE list on every keystroke, and clear() drops the
    // focused row on the floor: focus falls to <body>, and because the keydown listener
    // lives on `list`, the SECOND character never arrives — one letter and the browser is
    // dead. So remember whether we held focus, and hand it to whatever replaced the row.
    // (file-tree.ts's setActive has done exactly this from the start.)
    const hadFocus = list.contains(document.activeElement)
    drawList()
    if (hadFocus) focusActive()
  }

  function drawList(): void {
    clear(list)
    rows = []
    // The chip is the only proof the filter exists, so every branch below must leave it
    // true — including the ones that return early, which used to leave it stale.
    filterChip.textContent = filter ? `filter: ${filter}` : ''

    // Before the first listing lands: nothing. Not an EmptyState — "this folder is
    // empty" would be a claim we have not checked yet.
    if (!listing && !refusal) {
      listRole(false)
      return
    }

    if (refusal) {
      listRole(false)
      const r = REFUSALS[refusal.reason] ?? REFUSALS.missing
      list.append(
        el('div', { class: 'fb-refusal' }, [
          el('span', { class: 'fb-refusal-icon' }, [icon('alert', 20)]),
          el('div', {}, [
            el('div', { class: 'fb-refusal-title', text: r.title }),
            el('div', { class: 'fb-refusal-body', text: r.body }),
            refusalWayOut()
          ])
        ])
      )
      truncNote.textContent = ''
      return
    }

    // The ".." row is a first-class option, so arrow keys reach it.
    if (listing?.parent != null) {
      rows.push({ label: '..', path: listing.parent, entry: null })
    }
    for (const e of visibleEntries()) rows.push({ label: e.name, path: e.path, entry: e })

    if (!rows.length) {
      // No options — so no listbox, and no row to focus either: renderList parks focus on
      // the list itself, which is what makes "Press Esc to clear" a promise we can keep.
      listRole(false)
      list.append(
        filter
          ? EmptyState({ icon: 'search', title: 'No folder matches', body: `Nothing here contains “${filter}”. Press Esc to clear.` })
          : EmptyState({ icon: 'folder', title: 'This folder is empty', body: 'No subfolders — you can still choose it.' })
      )
      truncNote.textContent = ''
      return
    }

    listRole(true)
    if (active >= rows.length) active = rows.length - 1
    if (active < 0) active = 0

    rows.forEach((r, i) => {
      const isUp = r.entry === null
      const row = el(
        'div',
        {
          class: 'fb-row' + (isUp ? ' fb-row--up' : ''),
          role: 'option',
          tabIndex: i === active ? 0 : -1,
          title: r.path,
          onClick: () => {
            setActive(i)
            if (isUp) void load(r.path)
            else select(r.path) // one click PICKS; it must not rebuild the list…
          },
          onDblclick: () => void load(r.path) // …or this second click would land on a new node
        },
        [
          el('span', { class: 'fb-row-icon' }, [icon(isUp ? 'chevron-left' : 'folder', 14)]),
          el('span', { class: 'fb-row-name', text: isUp ? '..' : r.label }),
          r.entry?.isRepo ? Pill({ text: 'repo', tone: 'accent', icon: 'git-branch' }) : null
        ]
      )
      list.append(row)
    })
    paintSelection()

    truncNote.textContent = listing?.truncated ? `First ${FS_LIST_CAP} folders — type to narrow.` : ''
  }

  /** Selection is a CLASS change, never a re-render — see the onClick note above. */
  function paintSelection(): void {
    rows.forEach((r, i) => {
      const node = list.children[i]
      if (!(node instanceof HTMLElement)) return
      const isSel = r.entry !== null && selected === r.path
      node.classList.toggle('is-selected', isSel)
      node.setAttribute('aria-selected', String(isSel))
    })
  }

  function setActive(i: number): void {
    active = i
    rows.forEach((_, j) => {
      const node = list.children[j]
      if (node instanceof HTMLElement) node.tabIndex = j === active ? 0 : -1
    })
  }

  function paint(): void {
    renderCrumbs()
    renderList()
  }

  // ── navigation ───────────────────────────────────────────────────────────────
  let nav = 0 // monotonic: a slow listing must never overwrite a newer one

  /** Adopt a listing the owner fetched, plus the owner's selection (may be ''). */
  function applyListing(l: DirListing, sel: string): void {
    nav++
    listing = l
    lastGood = l
    refusal = null
    cur = l.path // canonical: what main says, not what we asked for
    selected = sel // the OWNER decides what is chosen — looking is not choosing
    filter = ''
    active = 0
    paint()
  }

  /**
   * A refused folder is shown WITHOUT moving the selection. Typing `C:\Us` on the way
   * to `C:\Users` must not throw away where you are, and a vanished folder must not
   * silently become your workspace root.
   */
  function showRefusal(r: DirRefusal): void {
    nav++
    listing = null
    refusal = { reason: r.reason, path: r.path }
    cur = r.path
    filter = ''
    active = 0
    paint()
  }

  /** User-initiated navigation: fetch, then tell the owner where we landed. */
  async function load(dir: string, o: { keepSelection?: boolean } = {}): Promise<void> {
    const token = ++nav
    let res: DirResult
    try {
      res = await opts.listDir({ path: dir, showHidden })
    } catch {
      res = { ok: false, reason: 'missing', path: dir } // the channel itself failed
    }
    if (token !== nav) return // a newer navigation already landed
    filter = ''
    active = 0
    if (res.ok) {
      listing = res
      lastGood = res
      refusal = null
      cur = res.path
      if (!o.keepSelection) selected = cur
      paint()
      if (!o.keepSelection) opts.onSelect?.(selected) // the owner decides what this means
      return
    }
    // Refused: keep `selected` where it was, so the owner's cwd and ours never diverge.
    listing = null
    refusal = { reason: res.reason, path: res.path }
    cur = res.path
    paint()
  }

  function select(p: string): void {
    selected = p
    renderCrumbs() // the current crumb loses its "selected" fill to the picked child
    paintSelection()
    opts.onSelect?.(p)
  }

  function move(next: number): void {
    if (!rows.length) return
    setActive(Math.max(0, Math.min(rows.length - 1, next)))
    const node = list.children[active]
    if (node instanceof HTMLElement) {
      node.focus()
      node.scrollIntoView({ block: 'nearest' })
    }
  }

  list.addEventListener('keydown', (e: KeyboardEvent) => {
    const k = e.key
    if (k === 'ArrowDown') return (e.preventDefault(), move(active + 1))
    if (k === 'ArrowUp') return (e.preventDefault(), move(active - 1))
    if (k === 'Home') return (e.preventDefault(), move(0))
    if (k === 'End') return (e.preventDefault(), move(rows.length - 1))
    if (k === 'Enter' || k === 'ArrowRight') {
      const r = rows[active]
      if (!r) return
      e.preventDefault()
      void load(r.path)
      return
    }
    if (k === 'Backspace' || k === 'ArrowLeft') {
      e.preventDefault()
      if (filter) {
        filter = filter.slice(0, -1)
        paint()
      } else if (listing?.parent != null) {
        void load(listing.parent)
      }
      return
    }
    if (k === 'Escape' && filter) {
      // Own this Escape: the wizard page's Esc would otherwise leave the whole view.
      e.preventDefault()
      e.stopPropagation()
      filter = ''
      paint()
      return
    }
    // Type-to-filter: printable characters only, never a chord.
    if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      filter += k
      active = 0
      paint()
    }
  })

  // The browser never opens itself. Its owner holds the selection and hands it the
  // first listing — so there is exactly one place that decides where we are.
  paint()

  return {
    el: root,
    path: () => cur,
    selected: () => selected,
    applyListing,
    showRefusal,
    refresh: () => load(cur, { keepSelection: true }),
    focusList: () => focusActive() // a refusal has no rows — it hands focus to its own way out
  }
}

/** Re-exported so callers can ask for the Windows drive list without a magic string. */
export { FS_DRIVE_ROOT }
