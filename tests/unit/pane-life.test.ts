import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { freshPaneLife } from '@ui/core/terminal/pane-life'
import {
  isPaneLive,
  isPaneRemoteReady,
  isPaneSpawnSettled,
  markPaneLive,
  markPaneReattached,
  markPaneRemoteReady,
  markPaneSpawnSettled,
  retirePaneLife,
  wasPaneReattached,
  whenPaneRemoteReady
} from '@ui/core/terminal/liveness-port'

// A PANE ID OUTLIVES ITS SHELLS.
//
// `restart()` respawns a dead pane under the same id, and the daemon's `ensure()` respawns a
// removed id on reconnect. Every mark in liveness-port describes a SHELL — "produced output",
// "authenticated past SSH", "was already running when we asked" — so a mark that survives into
// the next life is a statement about a process that no longer exists.
//
// It was dropped only in dispose(). A restarted REMOTE pane therefore read as remote-READY
// before its new SSH connection had authenticated, and as already-reattached, which suppresses
// the relaunch a fresh shell needs.
//
// The trap this file exists to hold: the pane's own latches make each mark fire ONCE. Clearing
// the port alone leaves them set, the marks are never re-raised, and "wrongly ready" becomes
// "never ready". Both halves, or neither.

let next = 9000
const paneId = (): number => next++

describe('retirePaneLife drops every mark', () => {
  it('clears live, spawn-settled, remote-ready and reattached together', () => {
    const id = paneId()
    markPaneLive(id)
    markPaneSpawnSettled(id)
    markPaneRemoteReady(id)
    markPaneReattached(id)
    expect([isPaneLive(id), isPaneSpawnSettled(id), isPaneRemoteReady(id), wasPaneReattached(id)]).toEqual([
      true,
      true,
      true,
      true
    ])

    retirePaneLife(id)
    expect([isPaneLive(id), isPaneSpawnSettled(id), isPaneRemoteReady(id), wasPaneReattached(id)]).toEqual([
      false,
      false,
      false,
      false
    ])
  })

  // THE finding. A remote pane that has authenticated, then died, then restarted, must not
  // still claim its NEW connection is past SSH auth.
  it('a restarted remote pane is not remote-ready until the new shell says so', () => {
    const id = paneId()
    markPaneRemoteReady(id)
    retirePaneLife(id) // <- restart()
    expect(isPaneRemoteReady(id)).toBe(false)
    markPaneRemoteReady(id) // the NEW shell reports past auth
    expect(isPaneRemoteReady(id)).toBe(true)
  })

  it('releases waiters rather than stranding them', async () => {
    const id = paneId()
    const waiting = whenPaneRemoteReady(id)
    retirePaneLife(id)
    // A waiter from the dead life must resolve false, not hang forever and not resolve true.
    await expect(waiting).resolves.toBe(false)
  })

  it('is safe on an id that was never marked', () => {
    expect(() => retirePaneLife(paneId())).not.toThrow()
  })
})

describe('the two halves stay wired together', () => {
  // terminal-pane.ts is renderer code and cannot be instantiated here (no DOM, no Electron),
  // so the WIRING is asserted over its source. Both halves of the fix are one fix: clearing
  // the port without re-arming the latches is the "never ready" regression, and re-arming the
  // latches without clearing the port is the original finding. A future edit that drops either
  // call reintroduces one of them.
  const src = readFileSync(resolve(import.meta.dirname, '../../src/ui/features/terminal/terminal-pane.ts'), 'utf8')

  /** The body of a method, brace-matched — not a line window, which would drift. */
  const bodyOf = (signature: string): string => {
    const start = src.indexOf(signature)
    expect(start, `${signature} not found — the method was renamed, not deleted, surely?`).toBeGreaterThan(-1)
  // The BODY brace, which is the first one followed by a newline. A plain indexOf('{')
    // latches onto a brace in the SIGNATURE and matches an entirely wrong span (see
    // tests/unit/source-body.ts, where this is shared for new tests).
    let i = src.indexOf('{\n', start)
    let depth = 0
    const from = i
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}' && --depth === 0) return src.slice(from, i + 1)
    }
    throw new Error(`unbalanced braces after ${signature}`)
  }

  it('restart() retires the port marks AND re-arms the latches', () => {
    const body = bodyOf('private restart(): void')
    expect(body, 'restart() must drop the dead shell’s marks').toContain('retirePaneLife(this.id)')
    expect(body, 'restart() must re-arm the once-per-life latches').toContain('freshPaneLife()')
  })

  it('dispose() retires them too — the other end of a life', () => {
    // Anchored at column 2: the class method, not the `{ dispose(): void }` handle types.
    expect(bodyOf('\n  dispose(): void')).toContain('retirePaneLife(this.id)')
  })

  // If a latch is re-declared as its own field, it escapes freshPaneLife() and the next
  // restart silently stops resetting it — exactly how three of the four got left behind.
  it('no per-life latch is declared as a bare field again', () => {
    for (const key of Object.keys(freshPaneLife())) {
      expect(src, `${key} must live on this.life, not as its own field`).not.toMatch(
        new RegExp(`private\\s+${key}\\s*[:=]`)
      )
    }
  })
})

describe('freshPaneLife re-arms every once-per-life latch', () => {
  // Each of these gates exactly one mark. Left latched across a restart, the corresponding
  // mark can never be raised again — so the port clear above would leave the pane permanently
  // not-live and never-remote-ready.
  it('starts every latch un-fired', () => {
    expect(freshPaneLife()).toEqual({
      liveMarked: false,
      remoteReadyMarked: false,
      remoteReadyProbe: '',
      captureEmitted: false
    })
  })

  it('hands back a NEW object, so the dead life cannot be mutated into the new one', () => {
    const a = freshPaneLife()
    a.liveMarked = true
    a.remoteReadyProbe = ']777;mogging-rem'
    const b = freshPaneLife()
    expect(b.liveMarked).toBe(false)
    expect(b.remoteReadyProbe).toBe('')
    expect(b).not.toBe(a)
  })

  // The partial-OSC probe is the subtle one: a half-matched readiness sequence left over from
  // the previous shell's output can COMPLETE against the next shell's first bytes, marking a
  // pane ready on a sequence no single shell ever emitted.
  it('drops a partial readiness probe', () => {
    const a = freshPaneLife()
    a.remoteReadyProbe = 'mogging-remote-rea'
    expect(freshPaneLife().remoteReadyProbe).toBe('')
  })
})
