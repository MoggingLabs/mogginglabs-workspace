import type { DirResult, ListDirRequest } from '@contracts'
import { el, icon } from '../../components'
import { resolveCdTarget } from './cd-path'
import {
  applyCompletion,
  commonPrefix,
  completionContext,
  filterCompletions,
  type CompletionContext
} from './cd-complete'

/**
 * The cd LINE itself: one mono input behind a `❯`, a completion menu under it,
 * and a refusal hint beside the prompt. Contract (wizard revamp, 2026-07-16):
 *
 *   - only `cd`/`chdir` execute. Anything else — a bare path, `ls`, `git` — is
 *     refused in place with a hint. The path bar above is where raw paths go.
 *   - Tab completes like a shell: one match completes and descends; several
 *     first extend to the shared prefix, then cycle; Shift+Tab cycles back.
 *   - typing keeps a live menu of matching folders (↓/↑ walk it, Enter runs the
 *     line, Escape restores what you had typed and closes the menu — and only
 *     the menu: the wizard page's own Escape stays reachable one press later).
 *
 * All path math is cd-path/cd-complete (pure); every folder name shown here came
 * from ONE `fs:listDir` round trip, cached per folder until the line executes.
 */

export interface CdLineOpts {
  listDir: (req: ListDirRequest) => Promise<DirResult>
  /** The folder relative arguments resolve against — the live selection. */
  base: () => string
  /** The `~` target (and the fallback when nothing is chosen yet). */
  home: () => string
  /** A resolved target — the caller feeds it to the selection controller. */
  onCd: (target: string) => void
}

export interface CdLineHandle {
  el: HTMLElement
  input: HTMLInputElement
  /** Gate handles: the live menu, the highlight, the refusal hint. */
  suggestions(): string[]
  selectedIndex(): number
  hint(): string
  /** Await the in-flight listing+filter pass (gates race the 120ms debounce). */
  settle(): Promise<void>
  dispose(): void
}

/** Menu size: enough to aim at, never a wall — narrowing is one keystroke away. */
const MENU_CAP = 12
const SUGGEST_DEBOUNCE_MS = 120

const HINTS: Record<string, string> = {
  'not-cd': 'Only cd works here — try cd ../other-project',
  'no-previous': 'No previous folder yet — cd somewhere first.',
  'no-home': 'No home folder known yet — use a full path.'
}

export function createCdLine(opts: CdLineOpts): CdLineHandle {
  let ctx: CompletionContext | null = null
  let all: string[] = [] // the full match list (cycling order)
  let extra = 0 // matches beyond MENU_CAP — shown, not cycled
  let sel = -1
  let stem = '' // what Escape restores — the line as typed before cycling
  let open = false
  let previousDir = '' // `cd -`
  let suggestToken = 0
  let suggestTimer: ReturnType<typeof setTimeout> | undefined
  let blurTimer: ReturnType<typeof setTimeout> | undefined
  let inFlight: Promise<void> = Promise.resolve()
  let disposed = false
  let cache: { dir: string; hidden: boolean; names: string[] | null } | null = null

  const input = el('input', {
    class: 'input input--mono wizard-cd-input',
    type: 'text',
    placeholder: 'cd ../other-project',
    ariaLabel: 'Change folder with a cd command',
    // The APG combobox wiring: the menu is a listbox the input controls.
    role: 'combobox',
    attrs: { 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': 'wizard-cd-listbox' }
  })

  const menu = el('div', { class: 'wizard-cd-suggest', role: 'listbox', attrs: { id: 'wizard-cd-listbox' }, hidden: true })
  const hintEl = el('span', { class: 'wizard-cd-hint', role: 'status' })
  const row = el('div', { class: 'wizard-cd-row' }, [
    el('span', { class: 'wizard-cd-prompt', text: '❯' }),
    input,
    hintEl
  ])
  const root = el('div', { class: 'wizard-cd' }, [row, menu])

  const setHint = (text: string): void => {
    hintEl.textContent = text
    row.classList.toggle('has-hint', !!text)
    if (text) {
      row.classList.remove('cd-shake')
      void row.offsetWidth // restart the refusal nudge
      row.classList.add('cd-shake')
    }
  }

  function closeMenu(): void {
    open = false
    sel = -1
    menu.hidden = true
    menu.replaceChildren()
    input.setAttribute('aria-expanded', 'false')
    input.removeAttribute('aria-activedescendant')
  }

  function paintMenu(): void {
    menu.replaceChildren()
    all.forEach((name, i) => {
      const opt = el(
        'div',
        {
          class: 'wizard-cd-option' + (i === sel ? ' is-active' : ''),
          role: 'option',
          attrs: { id: `wizard-cd-opt-${i}` }
        },
        [icon('folder', 12), el('span', { class: 'wizard-cd-option-name', text: name })]
      )
      opt.setAttribute('aria-selected', String(i === sel))
      // pointerdown, not click: the input must keep focus through the pick, or the
      // blur handler tears the menu down before the click could land on anything.
      opt.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        pick(i)
      })
      menu.append(opt)
    })
    if (extra > 0) menu.append(el('div', { class: 'wizard-cd-more', text: `+${extra} more — keep typing` }))
    menu.hidden = false
    open = true
    input.setAttribute('aria-expanded', 'true')
    if (sel >= 0) input.setAttribute('aria-activedescendant', `wizard-cd-opt-${sel}`)
    else input.removeAttribute('aria-activedescendant')
    menu.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' })
  }

  /** One folder, one round trip — re-listed only when the folder (or the
   *  dotfolder ask) changes, or after an executed cd invalidates the world. */
  async function listNames(dir: string, hidden: boolean): Promise<string[] | null> {
    if (cache && cache.dir === dir && cache.hidden === hidden) return cache.names
    let names: string[] | null = null
    try {
      const res = await opts.listDir({ path: dir, showHidden: hidden })
      names = res.ok ? res.entries.map((entry) => entry.name) : null
    } catch {
      names = null
    }
    cache = { dir, hidden, names }
    return names
  }

  async function runSuggest(): Promise<void> {
    const token = ++suggestToken
    const value = input.value
    const c = completionContext(value, opts.base(), opts.home())
    if (!c) {
      closeMenu()
      return
    }
    const names = await listNames(c.dir, c.wantHidden)
    if (disposed || token !== suggestToken) return // superseded by newer input
    const matches = names ? filterCompletions(names, c.prefix) : []
    if (!matches.length) {
      closeMenu()
      return
    }
    ctx = c
    all = matches.slice(0, MENU_CAP)
    extra = matches.length - all.length
    sel = -1
    stem = value
    paintMenu()
  }

  const scheduleSuggest = (): void => {
    if (suggestTimer) clearTimeout(suggestTimer)
    suggestTimer = setTimeout(() => {
      suggestTimer = undefined
      inFlight = runSuggest()
    }, SUGGEST_DEBOUNCE_MS)
  }

  /** Move the highlight and put that candidate ON the line (menu-complete style).
   *  The menu session stays pinned to the stem's context — cycling never re-filters. */
  function cycle(next: number): void {
    if (!ctx || !all.length) return
    sel = ((next % all.length) + all.length) % all.length
    input.value = applyCompletion(ctx, all[sel]!, false)
    paintMenu()
  }

  /** Commit a candidate: complete it fully, descend, and offer the next level. */
  function pick(i: number): void {
    if (!ctx || !all[i]) return
    input.value = applyCompletion(ctx, all[i]!, true)
    closeMenu()
    input.focus()
    inFlight = runSuggest()
  }

  async function complete(back: boolean): Promise<void> {
    if (suggestTimer) {
      // Tab beat the debounce — the menu the user is completing against is the
      // one this keystroke SHOULD have opened. Run it now.
      clearTimeout(suggestTimer)
      suggestTimer = undefined
      await runSuggest()
    } else if (!open) {
      await runSuggest()
    }
    if (!open || !ctx) return
    if (sel === -1) {
      if (all.length === 1) {
        pick(0)
        return
      }
      const shared = commonPrefix(all)
      if (shared && shared.length > ctx.prefix.length) {
        // Extend silently to the shared prefix; the next Tab starts the cycle.
        input.value = applyCompletion(ctx, shared, false)
        await runSuggest()
        return
      }
      cycle(back ? all.length - 1 : 0)
      return
    }
    cycle(back ? sel - 1 : sel + 1)
  }

  function exec(): void {
    const base = opts.base()
    const res = resolveCdTarget(input.value, base, opts.home(), previousDir)
    if (!res.ok) {
      if (res.reason !== 'empty') setHint(HINTS[res.reason] ?? HINTS['not-cd']!)
      return
    }
    previousDir = base
    cache = null // the world may change under a new folder — never complete from a stale one
    opts.onCd(res.target)
    input.value = ''
    setHint('')
    closeMenu()
  }

  input.addEventListener('input', () => {
    setHint('')
    scheduleSuggest()
  })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault()
      inFlight = complete(e.shiftKey)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      exec()
      return
    }
    if (e.key === 'Escape') {
      if (!open) return // closed: the wizard page's own Escape may have it
      e.preventDefault()
      e.stopPropagation()
      input.value = stem
      closeMenu()
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (open) cycle(e.key === 'ArrowDown' ? sel + 1 : sel - 1)
      else inFlight = runSuggest()
    }
  })
  input.addEventListener('blur', () => {
    // Deferred: a pointerdown on an option refocuses the input first.
    blurTimer = setTimeout(() => {
      if (!row.parentElement || document.activeElement !== input) closeMenu()
    }, 120)
  })

  return {
    el: root,
    input,
    suggestions: () => [...all],
    selectedIndex: () => sel,
    hint: () => hintEl.textContent ?? '',
    settle: async () => {
      if (suggestTimer) {
        clearTimeout(suggestTimer)
        suggestTimer = undefined
        inFlight = runSuggest()
      }
      await inFlight
    },
    dispose: () => {
      disposed = true
      if (suggestTimer) clearTimeout(suggestTimer)
      if (blurTimer) clearTimeout(blurTimer)
      closeMenu()
    }
  }
}
