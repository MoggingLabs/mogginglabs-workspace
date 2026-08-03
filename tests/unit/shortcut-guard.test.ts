import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isEditableElement,
  shortcutsBlocked,
  typingBlocksShortcuts,
  type EditableProbe
} from '@ui/core/commands/context'
import { currentChordPlatform } from '@ui/core/commands/chords'
import { isModKey } from '@ui/core/commands/shortcuts'

// THE GUARD THAT ONLY HELD IN THE CAPTURE PHASE.
//
// KBGLOBAL section 8 is a negative control: open the workspace RENAME field, press the app's
// chords, demand nothing fires. On macOS it caught the Board escaping — Ctrl+Shift+D (⌘+Shift+D)
// did nothing, Ctrl+Shift+G (⌘+Shift+G) opened the Board — while Windows and Linux passed.
//
// The two chords ran the SAME guard, `shortcutsBlocked(e.target)`. What differed was the phase:
// the workspace's pane verbs listen in CAPTURE, the Board's toggle listened in BUBBLE. A capture
// listener is always on the path to the focused element, so `e.target` IS the focused <input> and
// the guard bites. A bubble listener is not: it hears an event only when the focused field did not
// swallow it, so the events it sees are the ones targeting something ELSE — window, <body>, a rail
// tab, or a document the browser dock re-dispatched a guest chord to. Asking only about the target
// there is asking the one question that cannot come back true.
//
// Windows never showed it because the rename input's own keydown calls stopPropagation(): the event
// died before window-bubble, so the Board handler was never reached and the guard was never asked.
// The gate passed on that stopPropagation(), not on the guard — which is precisely what the gate's
// own header says it must not do.
//
// WHY IT SURFACED NOW: the app's modifier became the platform's OWN (⌘ on macOS, Ctrl elsewhere)
// instead of `ctrlKey || metaKey`. The gate used to hardcode the CDP Ctrl bit, so on macOS section 8
// pressed a modifier the app now ignores and passed for the wrong reason. Pressing ⌘ made the
// escape visible. Both halves are pinned below, because the second is what unmasked the first.
//
// This runs under node with no DOM, so the DOM is the two lines of stub below and the rule is
// asserted directly — the same reason chords.ts takes a plain object rather than a KeyboardEvent.

/** The minimum of an element that context.ts's `probe()` reads, plus EventTarget's surface
 *  so it can BE the event's target — which is the whole subject here. */
class FakeElement implements EventTarget {
  readonly tagName: string
  readonly isContentEditable: boolean
  private readonly xterm: boolean
  constructor(tag: string, opts: { contentEditable?: boolean; inXterm?: boolean } = {}) {
    this.tagName = tag
    this.isContentEditable = !!opts.contentEditable
    this.xterm = !!opts.inXterm
  }
  closest(selector: string): FakeElement | null {
    return selector === '.xterm' && this.xterm ? this : null
  }
  addEventListener(): void {
    /* a stand-in: nothing here ever dispatches */
  }
  removeEventListener(): void {
    /* a stand-in: nothing here ever dispatches */
  }
  dispatchEvent(): boolean {
    return false
  }
}

/** Install a DOM just deep enough for the guard: what has the caret, and is a modal up? */
function dom(focused: unknown, opts: { modal?: boolean } = {}): void {
  vi.stubGlobal('HTMLElement', FakeElement)
  vi.stubGlobal('document', {
    activeElement: focused,
    querySelector: (sel: string) => (opts.modal && sel === '.modal-overlay' ? {} : null)
  })
}

const renameInput = (): FakeElement => new FakeElement('INPUT')
const body = (): FakeElement => new FakeElement('BODY')
/** xterm's hidden keyboard proxy: a <textarea>, but it IS the terminal, not a form field. */
const terminalProxy = (): FakeElement => new FakeElement('TEXTAREA', { inXterm: true })

afterEach(() => vi.unstubAllGlobals())

// ── the platform seam the gate now presses ───────────────────────────────────────────────────
describe('the macOS code path', () => {
  it('currentChordPlatform() reads navigator.platform — the seam that makes this testable', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' })
    expect(currentChordPlatform()).toBe('mac')
    vi.stubGlobal('navigator', { platform: 'Win32' })
    expect(currentChordPlatform()).toBe('other')
  })

  // Why section 8 changed verdict: on macOS the app now answers to ⌘ and ignores Ctrl, so a gate
  // that pressed Ctrl was pressing a chord nothing listened for. The negative passed because the
  // key was inert, not because the guard held.
  it('on macOS the Board answers to ⌘+Shift+G and IGNORES Ctrl+Shift+G', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' })
    expect(boardChordPressed({ metaKey: true, shiftKey: true, code: 'KeyG' })).toBe(true)
    expect(boardChordPressed({ ctrlKey: true, shiftKey: true, code: 'KeyG' })).toBe(false)
  })
})

/** features/board/index.ts's predicate, verbatim: `isModKey(e) && e.shiftKey && !e.altKey && e.code === 'KeyG'`. */
function boardChordPressed(e: Partial<KeyboardEvent> & { code: string }): boolean {
  const ev = { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...e } as KeyboardEvent
  return isModKey(ev) && ev.shiftKey && !ev.altKey && ev.code === 'KeyG'
}

// ── the rule itself ──────────────────────────────────────────────────────────────────────────
describe('isEditableElement', () => {
  it('is true for the text controls a keystroke belongs to', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT', 'input', 'textarea']) {
      expect(isEditableElement({ tag }), tag).toBe(true)
    }
    expect(isEditableElement({ tag: 'DIV', contentEditable: true })).toBe(true)
  })

  it('is false for everything else, and for nothing at all', () => {
    expect(isEditableElement(null)).toBe(false)
    expect(isEditableElement({ tag: 'BODY' })).toBe(false)
    expect(isEditableElement({ tag: 'BUTTON' })).toBe(false)
  })

  // FINDING 29's counterweight, and the reason a plain tagName test is not enough: xterm reads the
  // keyboard through a hidden <textarea> inside .xterm, and this app's resting state is a focused
  // terminal. Counting that as "typing" killed every chord — Ctrl+Shift+D, Ctrl+T, Ctrl+1..9 —
  // silently, in the one place they exist to be pressed.
  it('is FALSE for xterm’s keyboard proxy, textarea though it is', () => {
    expect(isEditableElement({ tag: 'TEXTAREA', inTerminal: true })).toBe(false)
  })
})

describe('typingBlocksShortcuts', () => {
  const input: EditableProbe = { tag: 'INPUT' }
  const bodyProbe: EditableProbe = { tag: 'BODY' }

  it('blocks from either side — the target OR the caret', () => {
    expect(typingBlocksShortcuts(input, bodyProbe)).toBe(true)
    expect(typingBlocksShortcuts(bodyProbe, input)).toBe(true)
    expect(typingBlocksShortcuts(input, input)).toBe(true)
  })

  it('allows when neither is a text field', () => {
    expect(typingBlocksShortcuts(bodyProbe, bodyProbe)).toBe(false)
    expect(typingBlocksShortcuts(null, null)).toBe(false)
  })

  it('a focused TERMINAL is not typing, from either side', () => {
    const term: EditableProbe = { tag: 'TEXTAREA', inTerminal: true }
    expect(typingBlocksShortcuts(term, term)).toBe(false)
    expect(typingBlocksShortcuts(null, term)).toBe(false)
  })
})

// ── the failure, reproduced ──────────────────────────────────────────────────────────────────
describe('shortcutsBlocked while the workspace rename field has the caret', () => {
  it('blocks when the event is aimed at the input — the CAPTURE case, which always held', () => {
    const input = renameInput()
    dom(input)
    expect(shortcutsBlocked(input)).toBe(true)
  })

  // THE REGRESSION. KBGLOBAL section 8 on macOS: ⌘+Shift+G reached the Board's window-BUBBLE
  // listener with a target that was not the rename field, and the guard — which asked only about
  // the target — said "not typing" while the caret sat in an <input>. The Board opened mid-rename.
  it('blocks when the event arrives at <body> while the input holds the caret', () => {
    dom(renameInput())
    expect(shortcutsBlocked(body())).toBe(true)
  })

  it('blocks when the target is window — not an element at all', () => {
    dom(renameInput())
    expect(shortcutsBlocked({} as EventTarget)).toBe(true)
  })

  // browser/index.ts relays a chord pressed inside the dock's <webview> guest by re-dispatching
  // `new KeyboardEvent('keydown', …)` on `document`. Its target is the document, so no target test
  // can ever see the app's focused field. Same hole, a second door.
  it('blocks a re-dispatched event whose target is the document', () => {
    const fakeDocumentAsTarget = {}
    dom(renameInput())
    expect(shortcutsBlocked(fakeDocumentAsTarget as EventTarget)).toBe(true)
  })

  // End to end: the chord matches on macOS, and the guard is what stops it. Both halves, in the
  // order the listener runs them — a Board that toggled here is the CI failure.
  it('the Board’s ⌘+Shift+G matches, and the guard still refuses it', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' })
    dom(renameInput())
    expect(boardChordPressed({ metaKey: true, shiftKey: true, code: 'KeyG' })).toBe(true)
    expect(shortcutsBlocked(body())).toBe(true)
  })
})

// ── and the positives it must not cost ───────────────────────────────────────────────────────
describe('shortcutsBlocked must NOT re-break the terminal', () => {
  it('allows a chord while a terminal holds the caret — the app’s resting state', () => {
    const term = terminalProxy()
    dom(term)
    expect(shortcutsBlocked(term)).toBe(false)
  })

  it('allows it when the event reaches window-bubble with a <body> target too', () => {
    dom(terminalProxy())
    expect(shortcutsBlocked(body())).toBe(false)
  })

  it('allows it when nothing at all has the caret', () => {
    dom(null)
    expect(shortcutsBlocked(body())).toBe(false)
  })
})

describe('shortcutsBlocked and a blocking modal', () => {
  it('refuses every chord while a .modal-overlay is up, whatever has focus', () => {
    dom(terminalProxy(), { modal: true })
    expect(shortcutsBlocked(terminalProxy())).toBe(true)
  })
})
