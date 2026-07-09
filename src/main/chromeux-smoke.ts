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
        const lead = document.querySelector('.titlebar-lead')
        const brand = document.querySelector('#titlebar .brand')
        const toggle = lead && lead.querySelector('.rail-toggle')
        const all = [...cluster.querySelectorAll('button')]
        const fixed = [...cluster.querySelectorAll(':scope > button')] // home/board/settings
        // The rail toggle LEADS the bar's left cell now (it belongs over the column it
        // collapses), so it is measured with the cluster it shares a hit target with.
        const size = [...all, ...(toggle ? [toggle] : [])].map(el => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) } })
        const w0 = size[0] ? size[0].w : 0, h0 = size[0] ? size[0].h : 0
        // 29px = the enlarged bar's icon button (#titlebar .icon-btn). One uniform hit
        // target across every control in the bar is the contract; the number tracks it.
        const sameHit = size.length >= 4 && size.every(s => s.w === w0 && s.h === h0) && w0 >= 27 && w0 <= 31
        const toggleLeads = !!toggle && !!brand &&
          lead.firstElementChild === toggle &&
          toggle.getBoundingClientRect().left < brand.getBoundingClientRect().left
        const gaps = []
        for (let i = 1; i < fixed.length; i++) {
          gaps.push(Math.round(fixed[i].getBoundingClientRect().left - fixed[i - 1].getBoundingClientRect().right))
        }
        // >= 1: the fixed controls are Board + Settings. Home was removed (it is the boot
        // launcher / zero-workspace empty state, never a destination), so there is one gap
        // to check, not two. The contract — every gap identical, at --sp-1 — is unchanged.
        const g0 = gaps[0]
        const sameGap = gaps.length >= 1 && gaps.every(g => Math.abs(g - g0) <= 1) && g0 >= 3 && g0 <= 5
        const noHomeBtn = !document.querySelector('#titlebar .icon-btn[aria-label="Home"]')
        return { ok: sameHit && sameGap && toggleLeads && noHomeBtn, count: all.length, fixed: fixed.length, w0, h0, gaps, sameHit, sameGap, toggleLeads, noHomeBtn }
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
      // WIDE enough that every chip fits: the pane-bar container queries retire chips
      // below ~540px of PANE width, and a 2×2 grid gives each pane (win - rail)/2.
      win.setSize(1450, 680)
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
          // context = the agent context gauge — it lives in the RIGHT action cluster
          // (status, not identity), so it is queried from the header, and anchored
          // like the rest in EITHER form (full bar wide; the disc when compressed).
          const els = { state: q('.pane-state'), remote: q('.pane-remote'), role: q('.pane-role'), claims: q('.pane-claims'), mcp: q('.pane-mcp'), context: header.querySelector('.pane-context') }
          const widthOf = el => (el ? Math.round(el.getBoundingClientRect().width) : null)
          const presentMap = { state: widthOf(els.state), remote: widthOf(els.remote), role: widthOf(els.role), claims: widthOf(els.claims), mcp: widthOf(els.mcp), context: widthOf(els.context) }
          // At THIS width (a wide pane) the bar shows everything: every chip is in the DOM
          // and drawn. Narrow panes retire them into the ⋯ menu instead — that is stage (j),
          // below. The old form of this check asserted the chips survived a 600px window by
          // clipping under .pane-head-left's overflow; they no longer clip, they collapse.
          const anchored = Object.values(els).every(el => el && el.getBoundingClientRect().width > 0)
          const allLit = Object.values(els).every(el => !!el)
          const headerH = Math.round(header.getBoundingClientRect().height)
          // ONE LINE, not "short": the bar is --pane-header-h (48px) + its 1px rule.
          // Anything taller means the chips wrapped, which is the thing under test.
          const oneLine = headerH <= 50
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

      // ── (d): the grid-layout button is present in the grid, absent elsewhere — and
      //    Home is UNREACHABLE while a workspace exists (view('home') must not leave
      //    the grid). Both halves of the same invariant: the grid owns the app. ──
      win.setSize(1200, 760)
      await sleep(500)
      stage = 'd-views'
      const d = await ES<Record<string, unknown>>(`(async () => {
        const m = window.__mogging
        const sleep = ms => new Promise(r => setTimeout(r, ms))
        const disp = () => { const el = document.querySelector('.layout-launcher'); return el ? getComputedStyle(el).display : 'absent' }
        const viewClass = () => document.getElementById('content').className
        m.view('grid'); await sleep(180); const grid = disp()
        m.view('home'); await sleep(180); const home = disp()
        // The workspaces built above make Home a road to nowhere: the port redirects it.
        const homeBlocked = viewClass().includes('view-grid')
        m.view('board'); await sleep(180); const board = disp()
        m.view('settings'); await sleep(180); const settings = disp()
        m.view('grid'); await sleep(150)
        return {
          ok: grid !== 'none' && grid !== 'absent' && homeBlocked && board === 'none' && settings === 'none',
          grid, home, homeBlocked, board, settings
        }
      })()`)

      // ── (h): collapsing the rail RESIZES its tabs; it never re-lays them out. Each
      //    tab becomes a square, every icon keeps the x it had INSIDE its tab, and no
      //    tab moves in y. This is the contract the old collapse rule broke (it re-
      //    centred the icon and shortened the header, shifting the whole list). ──
      stage = 'h-rail-collapse'
      const h = await ES<Record<string, unknown>>(`(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms))
        const app = document.getElementById('app')
        const read = () => [...document.querySelectorAll('.workspace-tab')].map(t => {
          const tr = t.getBoundingClientRect(), ir = t.querySelector('.ws-icon').getBoundingClientRect()
          return { w: Math.round(tr.width), h: Math.round(tr.height), y: Math.round(tr.top), iconDx: Math.round(ir.left - tr.left) }
        })
        if (app.classList.contains('rail-collapsed')) { document.querySelector('.rail-toggle').click(); await sleep(400) }
        const before = read()
        document.querySelector('.rail-toggle').click()
        await sleep(500) // past the --dur-2 width transition
        const collapsed = app.classList.contains('rail-collapsed')
        const after = read()
        document.querySelector('.rail-toggle').click(); await sleep(400) // restore
        const n = Math.min(before.length, after.length)
        const square = n > 0 && after.slice(0, n).every(t => Math.abs(t.w - t.h) <= 1)
        const sameIconDx = n > 0 && after.slice(0, n).every((t, i) => t.iconDx === before[i].iconDx)
        const sameY = n > 0 && after.slice(0, n).every((t, i) => Math.abs(t.y - before[i].y) <= 1)
        const sameH = n > 0 && after.slice(0, n).every((t, i) => t.h === before[i].h)
        return {
          ok: collapsed && square && sameIconDx && sameY && sameH,
          collapsed, square, sameIconDx, sameY, sameH, n,
          before: before[0], after: after[0]
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

      // ── (i): the close button TAKES the pane-count's slot — it never joins it. The
      //    reveal fires on :hover AND :focus-within (the tab is tabindex=0, so a click
      //    focuses it), so the hide must fire on both too, or a clicked tab shows the
      //    count and the × crowding its label for as long as it keeps focus. ──
      stage = 'i-tab-badges'
      const i = await ES<Record<string, unknown>>(`(() => {
        const tab = document.querySelector('.workspace-tab')
        if (!tab) return { ok: false, reason: 'no tab' }
        const disp = sel => { const el = tab.querySelector(sel); return el ? getComputedStyle(el).display : 'absent' }
        const restCount = disp('.ws-count'), restClose = disp('.ws-close')
        tab.focus()
        const focusCount = disp('.ws-count'), focusClose = disp('.ws-close')
        tab.blur()
        return {
          ok: restCount !== 'none' && restClose === 'none' && focusCount === 'none' && focusClose !== 'none',
          restCount, restClose, focusCount, focusClose
        }
      })()`)

      // ── (j): PROGRESSIVE COLLAPSE. Two things are never surrendered — the state glyph
      //    (which agent, doing what) and the × (get out). Between them the bar retires
      //    into the ⋯ menu in a FIXED order, least-identifying first: branch → expand trio
      //    → mcp → claims → role → remote. The title is the last thing standing, never the
      //    first to go: it used to be the ONLY shrinkable item and hit 0px on an 862px
      //    pane while four chips kept full width and were clipped away invisibly. ──
      stage = 'j-collapse'
      const j = await ES<Record<string, unknown>>(`(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms))
        const slot = document.querySelector('.layout-slot[data-pane-id="${paneId}"]')
        if (!slot) return { ok: false, reason: 'no slot' }
        const shown = sel => { const el = slot.querySelector(sel); return !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0 }
        const expandShown = () => [...slot.querySelectorAll('.pane-act-expand')].filter(e => getComputedStyle(e).display !== 'none').length
        // The pane's own width drives the container queries; drive it directly.
        const host = slot.parentElement
        const at = async px => { slot.style.width = px + 'px'; await sleep(120)
          return { git: shown('.pane-git'), expand: expandShown(), mcp: shown('.pane-mcp'),
                   claims: shown('.pane-claims'), role: shown('.pane-role'), remote: shown('.pane-remote'),
                   title: shown('.pane-title'), state: shown('.pane-state'), close: shown('.pane-act-close'),
                   menu: shown('.pane-act:not(.pane-act-expand):not(.pane-act-close)'),
                   ctxDisc: shown('.pane-context .ctx-disc') } }
        const steps = { w900: await at(900), w700: await at(700), w600: await at(600),
                        w500: await at(500), w440: await at(440), w380: await at(380), w300: await at(300) }
        slot.style.width = ''
        await sleep(150)
        const anchorsHold = Object.values(steps).every(s => s.state && s.close && s.menu && s.title)
        const order =
          steps.w900.git && steps.w900.expand === 3 &&      // wide: everything
          !steps.w700.git && steps.w700.expand === 3 &&      // 1st to go: the branch chip
          !steps.w600.git && steps.w600.expand === 0 &&      // 2nd: the expand trio
          !steps.w500.mcp && steps.w500.claims &&            // 3rd: mcp
          !steps.w440.claims && steps.w440.role &&           // 4th: claims
          !steps.w380.role && steps.w380.remote &&           // 5th: role
          !steps.w300.remote                                 // 6th: remote
        // The context gauge (Claude Code's own disc + "62% used") has ONE form and
        // never retires: visible at every width — context nearing full must stay
        // visible on the tightest grid.
        const ctxGauge = steps.w900.ctxDisc && steps.w700.ctxDisc && steps.w300.ctxDisc
        return { ok: anchorsHold && order && ctxGauge, anchorsHold, order, ctxGauge, steps, hasHost: !!host }
      })()`)

      const pass = Boolean(a.ok && b.ok && c.ok && d.ok && e.ok && f.ok && g.ok && h.ok && i.ok && j.ok)
      result = { pass, a, b, c, d, e, f, g, h, i, j }
    } catch (err) {
      result = { pass: false, stage, error: String(err) }
    }
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}
