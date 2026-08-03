// Keyboard chord matching. PURE — no DOM, no window, no platform read of its own.
//
// Three defects lived in the two-term boolean this replaces, and all three come from the
// same place: the rule was written out longhand at each listener, so each one got a
// slightly different rule.
//
//   1. `ctrlKey || metaKey` on EVERY platform. On Windows `metaKey` is the WINDOWS key, so
//      Win+K, Win+, and Win+E fired our chords — and several of those are OS-reserved
//      (Win+K is Cast), so the user gets our palette *and* Windows' panel from one press.
//      The platform modifier is Ctrl on Windows/Linux and Cmd on macOS; never both.
//
//   2. `e.key` for digits and punctuation. `e.key` is what the LAYOUT produced: on AZERTY
//      the top-row 1 key yields '&', on a German layout Ctrl+= needs AltGr. Chords are
//      about which PHYSICAL key was pressed, which is `e.code`. browser/index.ts already
//      had this right (`e.code === 'Equal'`); the rest did not.
//
//   3. Nothing said what a chord IS, so a listener could omit a modifier check entirely
//      and match a superset — Ctrl+K also firing on Ctrl+Shift+K, for instance.
//
// The matcher takes a plain object rather than a KeyboardEvent so the whole table can be
// asserted under node, on every runner, for both platforms — the divergence in (1) is
// invisible on the platform you happen to be testing.

/** The platform-agnostic description of a chord. */
export interface Chord {
  /** The PHYSICAL key: a KeyboardEvent.code value ('KeyK', 'Digit1', 'Equal', 'Slash'). */
  code: string
  /** Requires the platform modifier (Ctrl on Windows/Linux, Cmd on macOS). */
  mod?: boolean
  shift?: boolean
  alt?: boolean
}

/** The subset of a KeyboardEvent a chord decision may read. */
export interface ChordEvent {
  code: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

export type ChordPlatform = 'mac' | 'other'

/**
 * The platform modifier — Ctrl on Windows/Linux, Cmd on macOS, never both.
 *
 * Accepting both meant the Windows key worked as Ctrl on Windows. shortcuts.ts documented
 * that as deliberate ("the handlers accept on every platform via ctrlKey/metaKey"), which
 * is why it survived: the comment made the bug look like a decision.
 */
export function hasModKey(e: Pick<ChordEvent, 'ctrlKey' | 'metaKey'>, platform: ChordPlatform): boolean {
  return platform === 'mac' ? e.metaKey : e.ctrlKey
}

/**
 * Does this event press exactly this chord?
 *
 * EXACTLY: an unlisted modifier must be UP. Without that, Ctrl+K also matches Ctrl+Shift+K
 * and Ctrl+Alt+K, so one binding silently swallows chords meant for another.
 */
export function matchChord(chord: Chord, e: ChordEvent, platform: ChordPlatform): boolean {
  if (e.code !== chord.code) return false
  if (hasModKey(e, platform) !== !!chord.mod) return false
  if (e.shiftKey !== !!chord.shift) return false
  if (e.altKey !== !!chord.alt) return false
  // The modifier that is NOT the platform's own must be up: on Windows a chord is Ctrl+K,
  // and Win+Ctrl+K is a different press.
  return platform === 'mac' ? !e.ctrlKey : !e.metaKey
}

/** The running platform, read once. */
export const currentChordPlatform = (): ChordPlatform =>
  typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || '') ? 'mac' : 'other'
