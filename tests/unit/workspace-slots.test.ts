import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pathKeyOf } from '@contracts'

// FOUR CONTROLLER DEFECTS, ONE THEME: a manifest row is trusted about a pane the grid may not
// have, or may not own.
//
// controller.ts touches the DOM and GridLayout, so it is not importable here. `pathKeyOf` is a
// pure contract; the rest is asserted over source, anchored on brace-matched method bodies.

const src = readFileSync(resolve(import.meta.dirname, '../../src/ui/features/workspace/controller.ts'), 'utf8')

const bodyOf = (signature: string): string => {
  const start = src.indexOf(signature)
  expect(start, `${signature} not found`).toBeGreaterThan(-1)
  let i = src.indexOf('{', start + signature.length - 1)
  let depth = 0
  const from = i
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(from, i + 1)
  }
  throw new Error(`unbalanced braces after ${signature}`)
}

describe('one project, one workspace', () => {
  // openForCwd compared `v.meta.cwd === cwd` raw, so two spellings of one folder opened two
  // workspaces — each with its own panes, roles and grant.
  it('pathKeyOf folds the things that are the same folder', () => {
    expect(pathKeyOf('C:\\Proj\\')).toBe(pathKeyOf('c:/proj'))
    expect(pathKeyOf('/srv/app/')).toBe(pathKeyOf('/srv/app'))
  })

  it('does NOT fold a POSIX path, where case is real', () => {
    // A blanket toLowerCase would merge two directories that genuinely differ.
    expect(pathKeyOf('/srv/App')).not.toBe(pathKeyOf('/srv/app'))
  })

  it('openForCwd compares by key, not by string', () => {
    expect(bodyOf('openForCwd(cwd: string): WorkspaceMeta')).toMatch(
      /pathKeyOf\(v\.meta\.cwd\) === pathKeyOf\(cwd\)/
    )
  })
})

describe('the manifest follows the layout, not the other way round', () => {
  const body = bodyOf('private applyResolvedLayout(')

  // applyRegions returns false WITHOUT touching the tree, and this wrote paneCount and
  // persisted regardless — saving a manifest whose pane count did not match its own tree.
  it('writes paneCount only after the layout actually took', () => {
    expect(body).toMatch(/if \(!apply\(\)\) return/)
    expect(body.indexOf('if (!apply()) return')).toBeLessThan(body.indexOf('a.meta.paneCount = count'))
  })

  it('the refusal is not discarded at the reorganize door', () => {
    // `void view.layout.applyRegions(spec)` threw the answer away.
    expect(src).toMatch(/applyResolvedLayout\(view, count, \(\) => view\.layout\.applyRegions\(spec\)\)/)
    expect(src, 'void discards the refusal').not.toMatch(/\(\) => void view\.layout\.applyRegions/)
  })
})

describe('seeding walks the slots the grid HAS', () => {
  const body = bodyOf('private applyResolvedLayout(')

  // paneIdForSlot returns the formula id when the manifest has no override, and a pane that
  // MOVED to another workspace keeps its id — so a dense 1..paneCount walk called setPaneCwd
  // on ids belonging to another workspace's live panes. The right set was computed three lines
  // above and discarded.
  it('passes the template’s slots to publishPaneCwds', () => {
    expect(body).toMatch(/publishPaneCwds\(\s*a\.meta,/)
    expect(body, 'a bare publishPaneCwds(meta) defaults to a dense walk').not.toMatch(
      /publishPaneCwds\(a\.meta\)/
    )
  })

  it('reads the template once and reuses it', () => {
    expect(body.match(/peekTemplate\(count\)/g) ?? [], 'two reads can disagree').toHaveLength(1)
  })

  // Same family: a role left on a slot the tree no longer holds published against another
  // workspace's pane. launchLineup has always gated on layout.paneIds(); this did not.
  it('publishRoles is told which slots are live', () => {
    expect(src).toMatch(/private publishRoles\(meta: WorkspaceMeta, slots\?: number\[\]\)/)
    expect(bodyOf('private publishRoles(')).toMatch(/liveSlots && !liveSlots\.has\(i \+ 1\)/)
  })

  it('and create() passes the sparse set it already computed', () => {
    expect(src).toMatch(/this\.publishRoles\(meta, slots\)/)
  })
})
