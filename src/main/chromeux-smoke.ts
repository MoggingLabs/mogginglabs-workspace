import { app, type BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { probeContrastAcrossThemes } from './aa-probe'

// Env-gated chrome-UX smoke (MOGGING_CHROMEUX, Phase-8.5/08). The titlebar, workspace
// rail and pane headers, asserted as a rendered contract — the surfaces graded
// Titlebar B→A, Workspace tabs A−→A, Pane headers B+→A:
//   (a) the right-cluster buttons share one hitbox + one gap (computed);
//   (b) 8 workspaces → the rail scrolls with an edge fade, and its tabs never shrink;
//   (c) a pane with remote+role+claims+mcp lit renders a ONE-LINE header — chips
//       truncated not wrapped, the state dot leading (bugs #9 + #12);
//   (d) the grid-layout button is ABSENT on Home, Board and Settings (bug #11);
//   (e) data-attention still fires (the rail's latched ring survived the restyle);
//   (f) no un-tokened radius in the step-08 chrome (the radius-ramp decision landed);
//   (g) the chrome text holds AA across every theme (via aa-probe.ts).
// Verdict → out/chromeux-result.json. Inert unless MOGGING_CHROMEUX is set.

/** (f) — the same selector-tracking scan check-spacing.mjs uses, for radius. Scoped to
 *  the surfaces THIS step owns (titlebar / rail / pane headers); the browser dock and
 *  shortcuts chrome are 08b's, so their radii are deliberately out of scope here. */
function scanChromeRadii(): { ok: boolean; violations: string[]; error?: string } {
  const CHROME08 = /pane-|titlebar|brand|workspace-tab|\bws-|rail-|#rail|workspace-tabs|layout-menu/
  const RADIUS = /border-radius\s*:/
  const BAREPX = /\b\d+px\b/
  const SELECTOR = /^\s*[.#[a-zA-Z]/
  try {
    const file = join(app.getAppPath(), 'src', 'ui', 'styles', 'global.css')
    const text = readFileSync(file, 'utf8')
    let selector = ''
    const violations: string[] = []
    text.split('\n').forEach((line, i) => {
      if (line.includes('{') && SELECTOR.test(line)) selector = line.split('{')[0].trim()
      if (!RADIUS.test(line)) return
      const val = line.split(':')[1] ?? ''
      if (BAREPX.test(val) && CHROME08.test(selector)) violations.push(`${i + 1}: ${selector} — ${line.trim()}`)
    })
    return { ok: violations.length === 0, violations }
  } catch (e) {
    return { ok: false, violations: [], error: String(e) }
  }
}

export function runChromeUxSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 200000) // safety net
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  const emit = (o: object): void => {
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'chromeux-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    let stage = 'init'
    try {
      await sleep(2000)

      // ── Build the roster: 8 workspaces (no per-create grid reveal), then activate #1
      //    so the grid — and its titlebar layout button — is on screen. ──
      stage = 'create8'
      await ES(`(() => {
        const m = window.__mogging
        const have = m.workspace.count()
        for (let i = have; i < 8; i++) m.workspace.create({ name: 'WS ' + (i + 1), activate: false })
        m.workspace.switchByIndex(0)
        return true
      })()`)
      await sleep(3200)

      // ── (a) + (b): a short window so 8 tabs overflow the rail. ──
      win.setSize(1200, 460)
      await sleep(700)

      stage = 'b-rail'
      const b = await ES<Record<string, unknown>>(`(() => {
        const tabsEl = document.getElementById('workspace-tabs')
        const tabs = [...document.querySelectorAll('.workspace-tab')]
        const cs = getComputedStyle(tabsEl)
        const railScrolls = tabsEl.scrollHeight > tabsEl.clientHeight + 1
        // At rest (scrollTop 0) with overflow, only the bottom edge has scrolled-past
        // content, so fade-bot is set (top stays clear — the first tab is never dimmed).
        const hasFadeClass = tabsEl.classList.contains('fade-bot') || tabsEl.classList.contains('fade-top')
        const maskApplied = (cs.maskImage && cs.maskImage !== 'none') || (cs.webkitMaskImage && cs.webkitMaskImage !== 'none')
        const heights = tabs.map(t => Math.round(t.getBoundingClientRect().height))
        const h0 = heights[0] || 0
        const tabsSameHeight = heights.length >= 8 && heights.every(h => h === h0) && h0 >= 40
        return {
          ok: railScrolls && hasFadeClass && !!maskApplied && tabsSameHeight,
          count: tabs.length, railScrolls, hasFadeClass, maskApplied: !!maskApplied,
          tabsSameHeight, h0, scrollH: tabsEl.scrollHeight, clientH: tabsEl.clientHeight
        }
      })()`)

      stage = 'a-cluster'
      const a = await ES<Record<string, unknown>>(`(() => {
        const cluster = document.querySelector('.titlebar-right')
        const all = [...cluster.querySelectorAll('button')]
        const fixed = [...cluster.querySelectorAll(':scope > button')] // home/board/toggle/settings
        const size = all.map(el => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) } })
        const w0 = size[0] ? size[0].w : 0, h0 = size[0] ? size[0].h : 0
        const sameHit = size.length >= 4 && size.every(s => s.w === w0 && s.h === h0) && w0 >= 24 && w0 <= 30
        const gaps = []
        for (let i = 1; i < fixed.length; i++) {
          gaps.push(Math.round(fixed[i].getBoundingClientRect().left - fixed[i - 1].getBoundingClientRect().right))
        }
        const g0 = gaps[0]
        const sameGap = gaps.length >= 2 && gaps.every(g => Math.abs(g - g0) <= 1) && g0 >= 3 && g0 <= 5
        return { ok: sameHit && sameGap, count: all.length, fixed: fixed.length, w0, h0, gaps, sameHit, sameGap }
      })()`)

      // ── (e): a non-active workspace's pane needs input → its tab latches the ring. ──
      stage = 'e-attention'
      const e = await ES<Record<string, unknown>>(`(async () => {
        const m = window.__mogging
        const sleep = ms => new Promise(r => setTimeout(r, ms))
        const active = m.workspace.active()
        const target = m.workspace.list().find(w => w.id !== active.id)
        if (!target) return { ok: false, reason: 'no non-active workspace' }
        m.attention.setPaneState(target.ordinal * 100 + 1, 'attention')
        await sleep(250)
        const tab = document.querySelector('.workspace-tab[data-ws-id="' + target.id + '"]')
        const fired = !!tab && tab.getAttribute('data-attention') === 'attention'
        const badge = tab && tab.querySelector('.ws-attn')
        const badgeShown = !!badge && !badge.hidden && (badge.textContent || '').trim().length > 0
        return { ok: fired && badgeShown, fired, badgeShown }
      })()`)

      // ── (c): a remote + role pane (real construction path), 2×2 so it is narrow. ──
      stage = 'c-createRemote'
      // Remote + role on slot index 1 (pane base+2), NOT index 0: the first pane is built
      // by the GridLayout constructor BEFORE publishRemotes runs (controller.ts), so a
      // slot-0 remote chip never renders — the same reason remote-smoke uses slot 2.
      const paneId = await ES<number>(`(() => {
        const m = window.__mogging
        m.workspace.create({
          name: 'Remote', paneCount: 4,
          remotes: [null, { hostId: 'chromeux-host', name: 'devbox-01' }, null, null],
          roles: [null, 'Reviewer', null, null]
        })
        return m.workspace.active().ordinal * 100 + 2
      })()`)
      await sleep(2600)
      win.setSize(600, 680) // narrow → the 4 chips overflow the pane's head-left cluster
      await sleep(800)
      await ES(`(() => {
        const p = (window.__mogging.panes || []).find(p => p.id === ${paneId})
        if (p && p.lightChips) p.lightChips()
        return true
      })()`)
      await sleep(400)

      stage = 'c-measure'
      const c = await ES<Record<string, unknown>>(`(() => {
        try {
          const slot = document.querySelector('.layout-slot[data-pane-id="${paneId}"]')
          if (!slot) return { ok: false, reason: 'no remote pane slot', paneId: ${paneId} }
          const header = slot.querySelector('.pane-header')
          const left = slot.querySelector('.pane-head-left')
          if (!header || !left) return { ok: false, reason: 'no header/left', hasHeader: !!header, hasLeft: !!left }
          const q = s => left.querySelector(s)
          const els = { state: q('.pane-state'), remote: q('.pane-remote'), role: q('.pane-role'), claims: q('.pane-claims'), mcp: q('.pane-mcp') }
          const widthOf = el => (el ? Math.round(el.getBoundingClientRect().width) : null)
          const presentMap = { state: widthOf(els.state), remote: widthOf(els.remote), role: widthOf(els.role), claims: widthOf(els.claims), mcp: widthOf(els.mcp) }
          // The always-present chips (state/remote/role) must anchor the header at width > 0,
          // and all five must be LIT (in the DOM — that is the "all four chips lit" scenario
          // this test stages). The trailing .pane-mcp legitimately clips to width 0 on the
          // narrow header (the overflow working); requiring it > 0 is what deterministically
          // false-failed this gate on CI's soft-GL (mcp measured 0 on all three OSes, 8.5/09).
          const anchored = [els.state, els.remote, els.role].every(el => el && el.getBoundingClientRect().width > 0)
          const allLit = Object.values(els).every(el => !!el)
          const headerH = Math.round(header.getBoundingClientRect().height)
          const oneLine = headerH <= 30
          const fec = left.firstElementChild
          const stateLeading = !!fec && fec.classList.contains('pane-state')
          const stateLeftMost = els.state && els.remote
            ? els.state.getBoundingClientRect().left <= els.remote.getBoundingClientRect().left + 1 : false
          const cs = getComputedStyle(left)
          const clipped = cs.overflow === 'hidden' || cs.overflowX === 'hidden'
          const overflowed = left.scrollWidth > left.clientWidth + 1
          // "chips truncate, never wrap" is the CSS CONTRACT: flex-wrap:nowrap + overflow:hidden.
          // Assert it directly. The pixel-center proxy over ALL children false-fails when a
          // trailing chip clips to 0 width (the overflow WORKING) — kept as a diagnostic
          // (centersAligned over the VISIBLE chips), not the gate.
          const noWrapStyle = cs.flexWrap === 'nowrap'
          const mids = [...left.children].filter(ch => ch.getBoundingClientRect().width > 0).map(ch => { const r = ch.getBoundingClientRect(); return Math.round(r.top + r.height / 2) })
          const centersAligned = mids.length > 0 && mids.every(mid => Math.abs(mid - mids[0]) <= 3)
          return {
            ok: anchored && allLit && oneLine && stateLeading && stateLeftMost && clipped && noWrapStyle,
            anchored, allLit, presentMap, headerH, oneLine, stateLeading, stateLeftMost, clipped, overflowed, noWrapStyle, centersAligned,
            firstChild: fec ? fec.className : null,
            allRemotes: document.querySelectorAll('.pane-remote').length
          }
        } catch (e) {
          return { ok: false, __err: String((e && e.stack) || e) }
        }
      })()`)

      // ── (d): the grid-layout button is present in the grid, absent elsewhere. ──
      win.setSize(1200, 760)
      await sleep(500)
      stage = 'd-views'
      const d = await ES<Record<string, unknown>>(`(async () => {
        const m = window.__mogging
        const sleep = ms => new Promise(r => setTimeout(r, ms))
        const disp = () => { const el = document.querySelector('.layout-launcher'); return el ? getComputedStyle(el).display : 'absent' }
        m.view('grid'); await sleep(180); const grid = disp()
        m.view('home'); await sleep(180); const home = disp()
        m.view('board'); await sleep(180); const board = disp()
        m.view('settings'); await sleep(180); const settings = disp()
        m.view('grid'); await sleep(150)
        return {
          ok: grid !== 'none' && grid !== 'absent' && home === 'none' && board === 'none' && settings === 'none',
          grid, home, board, settings
        }
      })()`)

      // ── (f): no un-tokened radius in the step-08 chrome (Node-side static scan). ──
      const f = scanChromeRadii()

      // ── (g): the chrome text I restyled holds AA in every theme. ──
      stage = 'g-aa'
      const gProbe = await probeContrastAcrossThemes({
        es: ES,
        sleep,
        selectors: ['.pane-title', '.pane-role', '.ws-label', '.brand-name']
      })
      const g = { ok: gProbe.failures.length === 0 && gProbe.missing.length === 0, ...gProbe }

      const pass = Boolean(a.ok && b.ok && c.ok && d.ok && e.ok && f.ok && g.ok)
      result = { pass, a, b, c, d, e, f, g }
    } catch (err) {
      result = { pass: false, stage, error: String(err) }
    }
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}
