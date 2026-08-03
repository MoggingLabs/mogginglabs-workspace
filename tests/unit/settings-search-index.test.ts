import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// THE SILENT SEARCH BREAK, pinned.
//
// Settings search is a DOM walk: it finds knobs by querying a fixed set of class names —
// .toggle-row, .field-group-label, .cc-title and friends. Nothing connects those strings
// to the components that PRODUCE them. Rename a class in collapsible-card or the field
// helpers and search does not throw, does not warn, and does not fail a gate; that kind of
// row simply stops being findable, and the only way to notice is to search for a knob you
// happen to know is there.
//
// So the coupling is asserted instead: every class the walk depends on must still be
// produced somewhere in the UI. This cannot prove search RANKS well, but it catches the
// failure that has no other symptom.

const SRC = 'src/ui'
const INDEX = 'src/ui/features/settings/index.ts'

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((e) => {
    const p = join(dir, e)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })

/** The class names buildSearchIndex queries for. Lifted from the source, not restated —
 *  a restated copy would agree with itself forever while the walk drifted. */
function selectorsInBuildSearchIndex(): string[] {
  const src = readFileSync(INDEX, 'utf8')
  const fn = /const buildSearchIndex = \(\): void => \{([\s\S]*?)\n {4}\}/.exec(src)
  if (!fn) throw new Error('could not lift buildSearchIndex from ' + INDEX + ' — its shape changed')
  return [...fn[1].matchAll(/querySelector(?:All)?<[^>]*>\('([^']+)'\)|querySelector\('([^']+)'\)/g)]
    .map((m) => m[1] ?? m[2])
    .flatMap((sel) => sel.split(/\s+/))
    .filter((part) => part.startsWith('.'))
    .map((part) => part.slice(1))
    .filter((c, i, a) => a.indexOf(c) === i)
}

describe('settings search index', () => {
  const selectors = selectorsInBuildSearchIndex()

  it('lifts a non-trivial selector set (a blind lift would assert nothing)', () => {
    expect(selectors.length).toBeGreaterThanOrEqual(6)
  })

  it('every class the walk depends on is still produced by some component', () => {
    // A class counts as PRODUCED only where it is rendered, never where it is queried.
    // Searching the raw text makes the assertion self-satisfying: the selector matches its
    // own querySelector call, so a renamed class still "exists" and this passes while
    // search is broken. (The break proof caught exactly that — renaming .cc-title left it
    // green.) Excluding the whole querying FILE is too blunt in the other direction: the
    // settings page legitimately renders .settings-section-head itself. So strip selector
    // arguments and keep everything else.
    const ui = walk(SRC)
      .map((f) => readFileSync(f, 'utf8').replace(/querySelector(?:All)?(?:<[^>]*>)?\((['"`])[^'"`]*\1\)/g, ''))
      .join('\n')
    // Whole class TOKENS, not substrings. `cc-title-${seq}` is an element id, and a
    // substring match counts it as producing the class `cc-title` — which is how the first
    // version of this test stayed green through a rename of the real thing.
    const produced = new Set<string>()
    for (const m of ui.matchAll(/(['"`])([^'"`\n]*)\1/g)) {
      for (const token of m[2].split(/\s+/)) if (token) produced.add(token)
    }
    const orphans = selectors.filter((c) => !produced.has(c))
    expect(orphans, `search queries classes nothing renders: ${orphans.join(', ')}`).toEqual([])
  })
})
