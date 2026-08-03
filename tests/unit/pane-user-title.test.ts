import { describe, expect, it } from 'vitest'
import type { PaneId } from '@contracts'
import {
  getPaneLabel,
  getPaneUserTitle,
  onPaneUserTitle,
  setPaneLabel,
  setPaneUserTitle
} from '@ui/core/layout/pane-meta'

// A TYPED NAME IS NOT A LAUNCH LABEL.
//
// The pane header renders `userTitle || oscTitle || label || "Terminal N"`
// (terminal-pane.ts). The label is provider identity ("Claude Code"), set by the
// agents feature at launch, and the agent's live OSC task title is MEANT to
// outrank it. A name the user typed into the rename dialog is a decision that
// outranks both — so it lives in its own field. When rename wrote into the label,
// the very next OSC title the CLI emitted took the header back, while the rename
// dialog kept showing the stored name: the "my name vanished but the dialog
// remembers it" bug this file exists to hold shut.

let next = 7000
const paneId = (): PaneId => next++ as PaneId

describe('pane user title port', () => {
  it('is a separate field from the launch label', () => {
    const id = paneId()
    setPaneLabel(id, 'Claude Code')
    setPaneUserTitle(id, 'usage icon')
    expect(getPaneLabel(id)).toBe('Claude Code')
    expect(getPaneUserTitle(id)).toBe('usage icon')
    // A later launch relabels the pane without eating the typed name.
    setPaneLabel(id, 'Codex')
    expect(getPaneUserTitle(id)).toBe('usage icon')
  })

  it('an empty commit clears the name (back to automatic titles)', () => {
    const id = paneId()
    setPaneUserTitle(id, 'usage icon')
    setPaneUserTitle(id, '')
    expect(getPaneUserTitle(id)).toBeUndefined()
  })

  it('notifies subscribers on set and on clear', () => {
    const id = paneId()
    const seen: string[] = []
    const off = onPaneUserTitle((pid, title) => {
      if (pid === id) seen.push(title)
    })
    setPaneUserTitle(id, 'usage icon')
    setPaneUserTitle(id, '')
    off()
    setPaneUserTitle(id, 'after-unsubscribe')
    expect(seen).toEqual(['usage icon', ''])
  })
})
