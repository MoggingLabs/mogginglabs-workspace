import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Env-gated GLOBAL-SHORTCUT smoke (MOGGING_KBGLOBAL).
//
// THE REGRESSION THIS EXISTS FOR. Audit finding 29 put `shortcutsBlocked(e.target)` in front of
// every global chord, and `isEditableTarget()` matched any <textarea> by tagName. xterm reads the
// keyboard through a hidden <textarea class="xterm-helper-textarea">, and terminal-pane.ts focuses
// it on every pane and workspace switch — so a focused TERMINAL, this app's resting state, was
// indistinguishable from a focused webhook-URL box. Every chord died the moment a pane had focus:
// Ctrl+Shift+D, Ctrl+T, Ctrl+Shift+Enter, Ctrl+Alt+arrows, Ctrl+1..9, Ctrl+Shift+G, Ctrl+Shift+U.
// Silently, with no toast — the handler returns before it can even refuse. The comment directly
// above that guard says the listener captures and stops propagation "so xterm never sees these":
// the chords exist to be pressed while you type in a terminal, and the guard made the terminal the
// one place they could not be pressed.
//
// WHY KBSHORTCUTS DID NOT CATCH IT, AND COULD NOT. That gate proves the shortcut list is
// DOCUMENTED — the ? overlay and the Settings page render the same rows — and never presses one of
// them. Its single synthetic key goes to `window.dispatchEvent`, so `e.target` is the window, not an
// element, and sails straight past the guard that was broken. A gate that picks its own event target
// cannot test a bug about which element the event targets. That is the whole trap, and it is why the
// keys are not pressed here the way a script finds convenient.
//
// SO THIS GATE NEVER NAMES A TARGET. Keys are injected over CDP (Input.dispatchKeyEvent) as real
// trusted events, and CHROMIUM routes each one to whatever the app actually focused — the same
// routing a user's keypress gets. The premise is asserted, never assumed: before any chord, the gate
// proves the focused element really is a <textarea> living inside .xterm. If xterm ever stops reading
// the keyboard that way, this says so out loud instead of quietly passing on a "terminal" that no
// longer is one.
//
// BOTH DIRECTIONS, because the fix and the finding have to hold at the same time:
//   POSITIVE  from a focused terminal every chord lands, across all THREE handlers that share the
//             guard (workspace, Board, Browser dock) — the failure that shipped.
//   NEGATIVE  from the workspace RENAME field, Ctrl+Shift+D must not split and Ctrl+Shift+G must not
//             open the Board — finding 29 itself. That input's own keydown calls stopPropagation(),
//             which never protected it (the app listens in CAPTURE), so `isEditableTarget` is the
//             only thing standing there. Deleting the guard to "fix" the terminal re-breaks this, and
//             re-adding a tagName test to fix THIS re-breaks the terminal. The gate refuses both.
// The positive runs FIRST and through the same dispatch, so a gate that passes because the app went
// deaf — or because the keys never arrived — is impossible.

// CDP modifier bitmask: Alt=1 Ctrl=2 Meta=4 Shift=8. The workspace handler switches on
// e.key.toLowerCase(); Board and Browser switch on e.code — so every chord carries both, exactly as
// a real keypress does.
const CHORDS = {
  'Ctrl+Shift+D': { modifiers: 10, key: 'D', code: 'KeyD', vk: 68 },
  'Ctrl+Shift+Enter': { modifiers: 10, key: 'Enter', code: 'Enter', vk: 13 },
  'Ctrl+Alt+Right': { modifiers: 3, key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  'Ctrl+Shift+G': { modifiers: 10, key: 'G', code: 'KeyG', vk: 71 },
  'Ctrl+Shift+U': { modifiers: 10, key: 'U', code: 'KeyU', vk: 85 },
  'Ctrl+T': { modifiers: 2, key: 't', code: 'KeyT', vk: 84 },
  'Ctrl+1': { modifiers: 2, key: '1', code: 'Digit1', vk: 49 },
  'Ctrl+2': { modifiers: 2, key: '2', code: 'Digit2', vk: 50 },
  F2: { modifiers: 0, key: 'F2', code: 'F2', vk: 113 },
  Escape: { modifiers: 0, key: 'Escape', code: 'Escape', vk: 27 }
} as const
type Chord = keyof typeof CHORDS

interface Snap {
  panes: number
  focusedPane: number
  expanded: boolean
  view: string
  dockHidden: boolean | null
  ws: string | null
  activeTag: string
  activeCls: string
  inXterm: boolean
}

// Focus a terminal the way the app does, and REPORT what that actually focused. The gate asserts
// the answer; it never assumes it.
const PAGE = `
  window.__kb = {
    focusTerm: () => {
      const m = window.__mogging
      const id = (m.layout.paneIds() || [])[0]
      const p = (m.panes || []).find((x) => x.id === id)
      if (!p) return { ok: false, reason: 'no pane dev handle for ' + id }
      p.term.focus()
      const a = document.activeElement
      return { ok: true, paneId: id, tag: a.tagName, cls: String(a.className || ''), inXterm: !!a.closest('.xterm') }
    },
    focusTab: () => {
      const b = document.querySelector('.workspace-tab .ws-tab-activate')
      if (!b) return { ok: false, reason: 'no workspace tab' }
      b.focus()
      return { ok: true }
    },
    snap: () => {
      const m = window.__mogging
      const a = document.activeElement
      const dock = document.querySelector('.browser-dock')
      return {
        panes: m.layout.paneCount(),
        focusedPane: Number((document.querySelector('.layout-slot.focused') || {}).dataset?.paneId || 0),
        expanded: !!document.querySelector('.layout-slot.expanded'),
        view: String((document.querySelector('#content') || {}).className || ''),
        dockHidden: dock ? !!dock.hidden : null,
        ws: (m.workspace.active() || {}).name || null,
        activeTag: a ? a.tagName : '',
        activeCls: a ? String(a.className || '') : '',
        inXterm: !!(a && a.closest && a.closest('.xterm'))
      }
    }
  }
  0
`

export function runKbGlobalSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 180000)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const emit = (o: object): void => {
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'kbglobal-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }

  const fail: string[] = []
  const check = (name: string, ok: boolean, detail?: unknown): boolean => {
    if (!ok) fail.push(name + (detail === undefined ? '' : ': ' + JSON.stringify(detail)))
    return ok
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      // A real key, routed by the app's own focus. If CDP will not attach, the gate FAILS — it must
      // never quietly fall back to a synthetic dispatch that names its own target, because naming
      // the target is precisely how the old gate missed this.
      wc.debugger.attach('1.3')
      const press = async (name: Chord): Promise<void> => {
        const c = CHORDS[name]
        const ev = {
          modifiers: c.modifiers,
          key: c.key,
          code: c.code,
          windowsVirtualKeyCode: c.vk,
          nativeVirtualKeyCode: c.vk
        }
        await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...ev })
        await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...ev })
        await sleep(260)
      }
      const snap = (): Promise<Snap> => ES<Snap>('window.__kb.snap()')
      const focusTerm = (): Promise<{ ok: boolean; reason?: string; tag?: string; cls?: string; inXterm?: boolean }> =>
        ES('window.__kb.focusTerm()')

      await sleep(1500)
      await ES(PAGE)
      await ES('window.__mogging.workspace.create({ name: "Alpha", paneCount: 2 })')
      await sleep(2000)
      await ES('window.__mogging.workspace.create({ name: "Beta", paneCount: 1 })')
      await sleep(2000)
      await ES('window.__mogging.workspace.switchByIndex(0)')
      await sleep(1000)

      // ── 0 · THE PREMISE — a focused terminal really is a <textarea> inside .xterm ───────────────
      // Everything below tests "a chord fired while a TERMINAL had focus". If that premise ever
      // stops holding, every assertion after it would pass for the wrong reason.
      const f0 = await focusTerm()
      check('0 the pane dev handle exists', !!f0.ok, f0.reason)
      check('0 focusing a terminal focuses a TEXTAREA', f0.tag === 'TEXTAREA', f0)
      check('0 …and it is xterm’s, inside .xterm', !!f0.inXterm && String(f0.cls).includes('xterm-helper-textarea'), f0)

      // ── 1 · Ctrl+Shift+D — the chord that shipped dead ─────────────────────────────────────────
      const a0 = await snap()
      check('1 the terminal still holds focus', a0.inXterm, a0)
      await press('Ctrl+Shift+D')
      const a1 = await snap()
      check('1 Ctrl+Shift+D from a focused terminal adds a terminal', a1.panes === a0.panes + 1, {
        before: a0.panes,
        after: a1.panes
      })

      // ── 2 · Ctrl+Alt+→ — pane nav, the verb whose whole point is to work while you type ─────────
      await focusTerm()
      const b0 = await snap()
      await press('Ctrl+Alt+Right')
      const b1 = await snap()
      check('2 Ctrl+Alt+→ moves pane focus', b1.focusedPane !== b0.focusedPane && b1.focusedPane > 0, {
        from: b0.focusedPane,
        to: b1.focusedPane
      })

      // ── 3 · Ctrl+Shift+Enter — zoom, and back ──────────────────────────────────────────────────
      await focusTerm()
      await press('Ctrl+Shift+Enter')
      const c1 = await snap()
      check('3 Ctrl+Shift+Enter zooms the focused pane', c1.expanded, c1)
      await press('Ctrl+Shift+Enter')
      const c2 = await snap()
      check('3 …and pressing it again restores the grid', !c2.expanded, c2)

      // ── 4 · Ctrl+Shift+G — the BOARD handler, a second listener behind the same guard ───────────
      await focusTerm()
      await press('Ctrl+Shift+G')
      const d1 = await snap()
      check('4 Ctrl+Shift+G opens the Board from a focused terminal', d1.view.includes('view-board'), d1.view)
      await ES('window.__mogging.view("grid")')
      await sleep(500)

      // ── 5 · Ctrl+Shift+U — the BROWSER handler, the third ───────────────────────────────────────
      await focusTerm()
      const e0 = await snap()
      await press('Ctrl+Shift+U')
      const e1 = await snap()
      check('5 Ctrl+Shift+U opens the browser dock from a focused terminal', e1.dockHidden === false, {
        before: e0.dockHidden,
        after: e1.dockHidden
      })
      // Opening the dock parks the caret in its URL field, so the terminal has to take focus back
      // before the same chord can close it — the app's own behaviour, not a workaround.
      await focusTerm()
      await press('Ctrl+Shift+U')
      const e2 = await snap()
      check('5 …and closes it again', e2.dockHidden === true, e2.dockHidden)

      // ── 6 · Ctrl+1 / Ctrl+2 — workspace switching ──────────────────────────────────────────────
      await focusTerm()
      await press('Ctrl+2')
      const g1 = await snap()
      check('6 Ctrl+2 switches to the second workspace', g1.ws === 'Beta', g1.ws)
      await focusTerm()
      await press('Ctrl+1')
      const g2 = await snap()
      check('6 Ctrl+1 switches back to the first', g2.ws === 'Alpha', g2.ws)

      // ── 7 · Ctrl+T — new workspace (the wizard, or an instant workspace if it is not up) ────────
      await focusTerm()
      const h0 = await snap()
      const wsBefore = await ES<number>('window.__mogging.workspace.count()')
      await press('Ctrl+T')
      await sleep(600)
      const h1 = await snap()
      const wsAfter = await ES<number>('window.__mogging.workspace.count()')
      check('7 Ctrl+T reaches the app from a focused terminal', !h1.view.includes('view-grid') || wsAfter > wsBefore, {
        view: [h0.view, h1.view],
        count: [wsBefore, wsAfter]
      })
      await ES('window.__mogging.view("grid")')
      await ES('window.__mogging.workspace.switchByIndex(0)')
      await sleep(800)

      // ── 8 · THE NEGATIVE — finding 29 must still hold ──────────────────────────────────────────
      // The workspace rename field. Its own keydown calls stopPropagation(), which never protected
      // it, because the app's shortcut layer listens in CAPTURE — the event is the app's before the
      // input ever sees it. `isEditableTarget` is the only thing standing here. Section 1 already
      // proved this exact dispatch DOES split when a terminal holds focus, so a pass here cannot be
      // the app going deaf.
      await ES('window.__kb.focusTab()')
      await sleep(200)
      await press('F2')
      const n0 = await snap()
      check('8 F2 opens the rename field and focuses it', n0.activeTag === 'INPUT' && n0.activeCls.includes('ws-rename'), {
        tag: n0.activeTag,
        cls: n0.activeCls
      })
      check('8 …and that field is NOT inside a terminal', !n0.inXterm, n0)
      await press('Ctrl+Shift+D')
      const n1 = await snap()
      check('8 Ctrl+Shift+D while renaming must NOT add a terminal', n1.panes === n0.panes, {
        before: n0.panes,
        after: n1.panes
      })
      await press('Ctrl+Shift+G')
      const n2 = await snap()
      check('8 Ctrl+Shift+G while renaming must NOT open the Board', !n2.view.includes('view-board'), n2.view)
      await press('Escape')
      await sleep(300)

      const pass = fail.length === 0
      result = { pass, failures: fail, premise: f0, panes: { start: a0.panes, afterSplit: a1.panes } }
    } catch (e) {
      result = { pass: false, error: String(e), failures: fail }
    }
    try {
      wc.debugger.detach()
    } catch {
      /* never attached */
    }
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 2500))
  else setTimeout(() => void run(), 2500)
}
