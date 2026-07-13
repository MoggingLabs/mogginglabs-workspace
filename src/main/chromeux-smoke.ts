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
      win.setSize(1450, 680)
      await sleep(800)

      stage = 'c-measure'
      const c = await ES<Record<string, unknown>>(`(async () => {
        try {
          const sleep = ms => new Promise(r => setTimeout(r, ms))
          // The state glyph is gated on a tracked provider session (availability
          // contract) — adopt one so the anchored/allLit checks have a dot to measure.
          window.__mogging.agents.adopt(${paneId}, 'claude', '')
          const slot = document.querySelector('.layout-slot[data-pane-id="${paneId}"]')
          if (!slot) return { ok: false, reason: 'no remote pane slot', paneId: ${paneId} }
          // 900px of pane: above every collapse threshold (the ladder's widest rule
          // fires at an 835px pane), so "everything fits" is measured on a bar the
          // ladder provably leaves alone — independent of monitor and rail geometry.
          slot.style.width = '900px'
          await sleep(150)
          // Light the chips INSIDE the measuring task: a real MCP/git status push
          // between an earlier lightChips call and this read used to re-hide the
          // forced chips (the sweep's isolated userdata has no MCP servers and the
          // measured slot is remote, so no port ever lights them for real). Nothing
          // can interleave between this call and the synchronous reads below.
          const p = (window.__mogging.panes || []).find(p => p.id === ${paneId})
          if (p && p.lightChips) p.lightChips()
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
          slot.style.width = ''
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

      // ── (j): PROGRESSIVE COLLAPSE. Four things are never surrendered — the state
      //    glyph, agent-CLI mark, ⋯ menu and ×. Between them the bar retires
      //    into the ⋯ menu in a FIXED order, least-identifying first: gauge "% used" text
      //    → branch → expand trio → mcp → claims → role → remote → (last) the gauge disc.
      //    The title is the last thing standing, never the first to go: it used to be the
      //    ONLY shrinkable item and hit 0px on an 862px pane while four chips kept full
      //    width and were clipped away invisibly. ──
      stage = 'j-collapse'
      const j = await ES<Record<string, unknown>>(`(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms))
        // The state glyph is gated on a tracked provider session (availability
        // contract) — adopt one so the never-surrendered anchor exists to assert.
        window.__mogging.agents.adopt(${paneId}, 'claude', '')
        const slot = document.querySelector('.layout-slot[data-pane-id="${paneId}"]')
        if (!slot) return { ok: false, reason: 'no slot' }
        const shown = sel => { const el = slot.querySelector(sel); return !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0 }
        const expandShown = () => [...slot.querySelectorAll('.pane-act-expand')].filter(e => getComputedStyle(e).display !== 'none').length
        // The pane's own width drives the container queries; drive it directly. Chips are
        // re-lit AFTER each resize settles (a real MCP/git push may re-hide the forced
        // chips during the sleep), and the reads that follow are synchronous with the
        // relight, so nothing can interleave.
        const host = slot.parentElement
        const p = (window.__mogging.panes || []).find(p => p.id === ${paneId})
        const at = async px => { slot.style.width = px + 'px'; await sleep(120)
          if (p && p.lightChips) p.lightChips()
          return { pct: shown('.pane-context .ctx-pct'), git: shown('.pane-git'),
                   expand: expandShown(), mcp: shown('.pane-mcp'),
                   claims: shown('.pane-claims'), role: shown('.pane-role'), remote: shown('.pane-remote'),
                   title: shown('.pane-title'), state: shown('.pane-state'), agent: shown('.pane-agent'), close: shown('.pane-act-close'),
                   menu: shown('.pane-act:not(.pane-act-expand):not(.pane-act-close)'),
                   ctxDisc: shown('.pane-context .ctx-disc') } }
        // Checkpoints straddle the 2026-07-10 re-derived ladder (global.css: thresholds
        // are CONTENT-box widths — each rule fires at a pane ~15px wider than its number).
        // The bar is CROWDED (every chip lit), so the :has()-gated rules apply: pct 820,
        // branch 760, trio 740, mcp restart-form 645, claims 525, role 470, remote 355,
        // disc 135. Each step sits ≥10px from the thresholds on both sides.
        const steps = { w900: await at(900), w800: await at(800), w765: await at(765),
                        w700: await at(700), w620: await at(620), w505: await at(505),
                        w455: await at(455), w340: await at(340), w140: await at(140) }
        slot.style.width = ''
        await sleep(150)
        // The title is exempt only at 140px: below the 200px retirement rung it moves
        // into the menu while the compact four-anchor chrome holds.
        const anchorsHold = Object.entries(steps).every(([k, s]) =>
          s.state && s.agent && s.close && s.menu && (k === 'w140' || s.title))
        const order =
          steps.w900.pct && steps.w900.git && steps.w900.expand === 3 && steps.w900.mcp &&
          steps.w900.claims && steps.w900.role && steps.w900.remote &&   // wide: everything
          !steps.w800.pct && steps.w800.git && steps.w800.expand === 3 && // 1st: the gauge text
          !steps.w765.git && steps.w765.expand === 3 &&                   // 2nd: the branch chip
          steps.w700.expand === 0 && steps.w700.mcp &&                    // 3rd: the expand trio
          !steps.w620.mcp && steps.w620.claims &&                         // 4th: mcp (restart form)
          !steps.w505.claims && steps.w505.role &&                        // 5th: claims
          !steps.w455.role && steps.w455.remote &&                        // 6th: role
          !steps.w340.remote &&                                           // 7th: remote
          !steps.w140.title && !steps.w140.ctxDisc                        // 8th/9th: title, then disc
        // The gauge's DISC (color ramp + sweep) survives every retirement above it and
        // yields only below 135px of content — where even 16px would push the anchors off.
        const ctxGauge = steps.w900.ctxDisc && steps.w700.ctxDisc && steps.w340.ctxDisc
        return { ok: anchorsHold && order && ctxGauge, anchorsHold, order, ctxGauge, steps, hasHost: !!host }
      })()`)

      // ── (k): THE 132px COMPACT CONTRACT. At the hard floor the exact four
      //    anchors fit without overlap. The overflow menu is body-portaled, remains in
      //    the viewport, carries retired facts, and Rename works from that menu. ──
      stage = 'k-compact-contract'
      win.setSize(600, 480)
      await sleep(700)
      const k = await ES<Record<string, unknown>>(`(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms))
        const slot = document.querySelector('.layout-slot[data-pane-id="${paneId}"]')
        if (!slot) return { ok: false, reason: 'no slot' }
        const pane = (window.__mogging.panes || []).find(p => p.id === ${paneId})
        window.__mogging.agents.adopt(${paneId}, 'claude', '')
        window.__mogging.context.set(${paneId}, 62)
        slot.style.width = '132px'
        await sleep(120)
        if (pane && pane.lightChips) pane.lightChips()
        if (pane && pane.seedMenuFacts) pane.seedMenuFacts()

        const selectors = {
          state: '.pane-state', agent: '.pane-agent',
          menu: '[aria-label="Pane menu"]', close: '[aria-label="Close terminal"]'
        }
        const probe = async px => {
          slot.style.width = px + 'px'
          await sleep(45)
          const nodes = Object.fromEntries(Object.entries(selectors).map(([name, sel]) => [name, slot.querySelector(sel)]))
          const header = slot.querySelector('.pane-header')
          const grid = slot.querySelector('.pane-header-grid')
          const left = slot.querySelector('.pane-head-left')
          const actions = slot.querySelector('.pane-actions')
          const context = slot.querySelector('.pane-context .ctx-disc')
          const rect = el => el && el.getBoundingClientRect()
          const inside = (child, ancestor) => {
            const c = rect(child), a = rect(ancestor)
            return !!c && !!a && c.left >= a.left - 1 && c.right <= a.right + 1 && c.top >= a.top - 1 && c.bottom <= a.bottom + 1
          }
          const rects = Object.fromEntries(Object.entries(nodes).map(([name, el]) => {
            const r = rect(el)
            return [name, r ? { left: r.left, right: r.right, width: r.width } : null]
          }))
          const ordered = Object.values(rects).filter(Boolean).sort((a, b) => a.left - b.left)
          const hs = getComputedStyle(header)
          const queryWidth = Math.round(header.clientWidth - parseFloat(hs.paddingLeft) - parseFloat(hs.paddingRight))
          const anchorsVisible = Object.values(nodes).every(el => el && getComputedStyle(el).display !== 'none' && rect(el).width >= 8)
          const noOverlap = ordered.every((r, index) => index === 0 || r.left >= ordered[index - 1].right - 0.5)
          const shown = sel => { const el = slot.querySelector(sel); return !!el && getComputedStyle(el).display !== 'none' && rect(el).width > 0 }
          const contextShown = shown('.pane-context')
          const actionContainer = getComputedStyle(actions).display === 'contents' ? grid : actions
          const ancestry = [
            [nodes.state, left], [nodes.agent, left], [left, grid],
            [nodes.menu, actionContainer], [nodes.close, actionContainer], [actionContainer, grid],
            [grid, header], [header, slot]
          ]
          if (contextShown) ancestry.push([context, actionContainer])
          const ancestorContained = ancestry.every(([child, ancestor]) => inside(child, ancestor))
          const clustersSeparated = rect(left).right <= rect(contextShown ? context : nodes.menu).left + 0.5
          const dotAgentGap = rect(nodes.agent).left - rect(nodes.state).right
          const agentContextGap = contextShown ? rect(context).left - rect(nodes.agent).right : null
          const signalGapMatched = agentContextGap == null || Math.abs(dotAgentGap - agentContextGap) <= 0.5
          return {
            px, paneWidth: rect(slot).width, queryWidth, rects, anchorsVisible,
            noOverlap, ancestorContained, clustersSeparated,
            contextShown, titleShown: shown('.pane-title'),
            dotAgentGap, agentContextGap, signalGapMatched
          }
        }
        const exact = await probe(132)
        const aboveContext = await probe(153) // 136px content: immediately above max-width:135
        const aboveCompactGaps = await probe(175) // 158px content: immediately above max-width:157
        const aboveTitle = await probe(218) // 201px content: immediately above max-width:200
        const samples = [exact, aboveContext, aboveCompactGaps, aboveTitle]
        const sampleGeometry = samples.every(s => s.anchorsVisible && s.noOverlap && s.ancestorContained && s.clustersSeparated)
        const signalRhythm = [exact, aboveContext, aboveCompactGaps].every(s =>
          Math.abs(s.dotAgentGap - 8) <= 0.5 &&
          (s.agentContextGap == null || Math.abs(s.agentContextGap - 8) <= 0.5) &&
          s.signalGapMatched)
        const transitions = Math.abs(exact.paneWidth - 132) <= 0.5 && exact.queryWidth === 115 && !exact.contextShown && !exact.titleShown &&
          aboveContext.queryWidth === 136 && aboveContext.contextShown && !aboveContext.titleShown &&
          aboveCompactGaps.queryWidth === 158 && aboveCompactGaps.contextShown && !aboveCompactGaps.titleShown &&
          aboveTitle.queryWidth === 201 && aboveTitle.contextShown && aboveTitle.titleShown
        await probe(132)
        const retiredInline = ['.pane-title', '.pane-remote', '.pane-role', '.pane-claims', '.pane-mcp', '.pane-git', '.pane-act-expand', '.pane-context']
          .every(sel => [...slot.querySelectorAll(sel)].every(el => getComputedStyle(el).display === 'none'))

        const menuButton = slot.querySelector('[aria-label="Pane menu"]')
        menuButton.click()
        await sleep(80)
        const menu = document.getElementById('pane-menu-${paneId}')
        if (!menu || menu.hidden) return { ok: false, reason: 'menu did not open', exact, transitions }
        const menuRect = menu.getBoundingClientRect()
        const portaled = menu.parentElement === document.body && !slot.contains(menu)
        const viewportContained = menuRect.left >= 7 && menuRect.top >= 7 && menuRect.right <= innerWidth - 7 && menuRect.bottom <= innerHeight - 7
        const menuText = (menu.textContent || '').replace(/\\s+/g, ' ').trim()
        const paneFact = 'Pane: ' + (slot.querySelector('.pane-title').textContent || '').trim()
        const factNeedles = [
          paneFact, 'Agent CLI: claude', 'Status:', 'Remote: devbox-01', 'Role: Reviewer',
          'Claims: 2 file patterns', 'MCP: 2 tools connected', 'Agent context: 62% used',
          'Branch: feat/menu-facts'
        ]
        const retiredFacts = factNeedles.every(needle => menuText.includes(needle))
        const actionNeedles = [
          'Expand to whole workspace', 'Expand across full width', 'Expand to full height',
          'Split right', 'Split down', 'Rename', 'Clear terminal',
          'Copy working directory', 'Show claims'
        ]
        const retiredActions = actionNeedles.every(needle => menuText.includes(needle))

        const renameItem = [...menu.querySelectorAll('.menu-item')].find(el => (el.textContent || '').trim() === 'Rename')
        if (!renameItem) return { ok: false, reason: 'no Rename item', menuText }
        renameItem.click()
        await sleep(50)
        const overlay = document.querySelector('.modal-overlay:not(.is-closing)')
        const input = overlay && overlay.querySelector('.pane-title-input')
        const renamePortaled = !!overlay && overlay.parentElement === document.body && !!input
        if (input) {
          input.value = 'Compact smoke pane'
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        }
        await sleep(300)
        const titleUpdated = (slot.querySelector('.pane-title').textContent || '').trim() === 'Compact smoke pane'
        menuButton.click()
        await sleep(80)
        const renamedInMenu = (menu.textContent || '').includes('Pane: Compact smoke pane')

        const menuItem = needle => [...menu.querySelectorAll('.menu-item')]
          .find(el => (el.textContent || '').includes(needle))
        const expandItem = menuItem('Expand to whole workspace')
        if (!expandItem) return { ok: false, reason: 'no Expand menu item' }
        expandItem.click()
        await sleep(100)
        const expandedViaMenu = slot.dataset.expandMode === 'full'
        menuButton.click()
        await sleep(80)
        const restoreItem = menuItem('Restore grid')
        if (!restoreItem) return { ok: false, reason: 'no Restore menu item', expandedViaMenu }
        restoreItem.click()
        await sleep(100)
        const restoredViaMenu = !slot.dataset.expandMode

        const beforeSplitIds = window.__mogging.layout.paneIds()
        menuButton.click()
        await sleep(80)
        const splitItem = menuItem('Split right')
        if (!splitItem) return { ok: false, reason: 'no Split menu item' }
        splitItem.click()
        await sleep(180)
        const afterSplitIds = window.__mogging.layout.paneIds()
        const addedPaneId = afterSplitIds.find(id => !beforeSplitIds.includes(id))
        const splitViaMenu = afterSplitIds.length === beforeSplitIds.length + 1 && addedPaneId != null
        if (addedPaneId != null) window.__mogging.layout.close(addedPaneId)
        await sleep(160)
        const splitCleanup = window.__mogging.layout.paneCount() === beforeSplitIds.length

        menuButton.click()
        await sleep(80)
        const activeWorkspaceId = window.__mogging.workspace.active().id
        const workspaces = window.__mogging.workspace.list()
        const otherIndex = workspaces.findIndex(ws => ws.id !== activeWorkspaceId)
        window.__mogging.workspace.switchByIndex(otherIndex)
        await sleep(100)
        const closesOnWorkspaceSwitch = menu.hidden && !menu.contains(document.activeElement)
        window.__mogging.workspace.switchByIndex(workspaces.findIndex(ws => ws.id === activeWorkspaceId))
        await sleep(100)
        slot.style.width = ''
        return {
          ok: sampleGeometry && signalRhythm && transitions && retiredInline && portaled && viewportContained &&
            retiredFacts && retiredActions && renamePortaled && titleUpdated && renamedInMenu &&
            expandedViaMenu && restoredViaMenu && splitViaMenu && splitCleanup && closesOnWorkspaceSwitch,
          sampleGeometry, signalRhythm, transitions, samples, retiredInline,
          portaled, viewportContained, menuRect: { left: menuRect.left, top: menuRect.top, right: menuRect.right, bottom: menuRect.bottom },
          retiredFacts, factNeedles, retiredActions, actionNeedles,
          renamePortaled, titleUpdated, renamedInMenu,
          expandedViaMenu, restoredViaMenu, splitViaMenu, splitCleanup, closesOnWorkspaceSwitch
        }
      })()`)

      // ── (l): HARD WIDTH FLOOR. Exercise the real allocator through every curated
      //    template, a wide→minimum window resize, and alternating nested splits. ──
      stage = 'l-pane-floor'
      win.setSize(1200, 760)
      await sleep(650)
      const lWide = await ES<Record<string, unknown>>(`(async () => {
        window.__mogging.layout.apply(16)
        await new Promise(r => setTimeout(r, 300))
        const widths = [...document.querySelectorAll('.workspace-view.active .layout-slot')].map(el => el.getBoundingClientRect().width)
        return { ok: widths.length === 16 && widths.every(w => w >= 131.5), widths }
      })()`)
      win.setSize(600, 760)
      await sleep(800)
      const l = await ES<Record<string, unknown>>(`(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms))
        const m = window.__mogging
        const read = expected => {
          const host = document.querySelector('.workspace-view.active')
          const slots = [...host.querySelectorAll(':scope > .layout-grid > .layout-slot')]
          const widths = slots.map(el => el.getBoundingClientRect().width)
          const canvas = host.querySelector(':scope > .layout-grid')
          const maxScrollLeft = Math.max(0, host.scrollWidth - host.clientWidth)
          const beforeScrollLeft = host.scrollLeft
          if (maxScrollLeft > 0) host.scrollLeft = Math.min(17, maxScrollLeft)
          const overflowX = getComputedStyle(host).overflowX
          const scrollReachable = maxScrollLeft === 0 ||
            ((overflowX === 'auto' || overflowX === 'scroll') && host.scrollLeft > 0)
          host.scrollLeft = beforeScrollLeft
          return {
            ok: slots.length === expected && widths.every(w => w >= 131.5),
            count: slots.length, min: widths.length ? Math.min(...widths) : 0,
            widths, hostClientWidth: host.clientWidth, hostScrollWidth: host.scrollWidth,
            canvasWidth: canvas.getBoundingClientRect().width,
            overflowX, maxScrollLeft, scrollReachable
          }
        }
        const shrink16 = read(16)
        const scrollDismiss = async () => {
          const host = document.querySelector('.workspace-view.active')
          const menuButton = host.querySelector('.pane-act-menu')
          host.scrollLeft = 0
          await sleep(40)
          menuButton.click()
          await sleep(80)
          const menu = document.getElementById(menuButton.getAttribute('aria-controls'))
          const opened = !!menu && !menu.hidden
          host.scrollLeft = Math.min(31, Math.max(0, host.scrollWidth - host.clientWidth))
          await sleep(80)
          const closed = !!menu && menu.hidden && !menu.contains(document.activeElement)
          host.scrollLeft = 0
          return { ok: opened && closed, opened, closed }
        }
        const scrollDismissesMenu = await scrollDismiss()
        const expandedViewport = async mode => {
          const host = document.querySelector('.workspace-view.active')
          const paneId = m.layout.paneIds()[0]
          const maxScrollLeft = Math.max(0, host.scrollWidth - host.clientWidth)
          host.scrollLeft = Math.min(23, maxScrollLeft)
          await sleep(40)
          m.layout.expand(paneId, mode)
          await sleep(100)
          const slot = host.querySelector('.layout-slot[data-pane-id="' + paneId + '"]')
          const measure = () => {
            const hr = host.getBoundingClientRect(), sr = slot.getBoundingClientRect()
            return Math.abs(sr.left - hr.left) <= 1 && Math.abs(sr.width - host.clientWidth) <= 1
          }
          const initial = measure()
          if (maxScrollLeft > 30) {
            host.scrollLeft = Math.min(47, maxScrollLeft)
            await sleep(80)
          }
          const followsScroll = measure()
          const originalStyle = host.getAttribute('style')
          const originalWidth = host.clientWidth
          const resizedTargetWidth = Math.max(132, originalWidth - 24)
          host.style.flex = 'none'
          host.style.width = resizedTargetWidth + 'px'
          await sleep(100)
          const resizedHostWidth = host.clientWidth
          const hostResized = Math.abs(resizedHostWidth - resizedTargetWidth) <= 1
          const followsResize = measure()
          if (originalStyle == null) host.removeAttribute('style')
          else host.setAttribute('style', originalStyle)
          await sleep(100)
          const restoredHostWidth = host.clientWidth
          const hostRestored = Math.abs(restoredHostWidth - originalWidth) <= 1
          const restoresResize = measure()
          m.layout.expand(paneId, mode)
          await sleep(80)
          host.scrollLeft = 0
          return {
            ok: initial && followsScroll && hostResized && followsResize && hostRestored && restoresResize,
            initial, followsScroll, hostResized, resizedHostWidth, resizedTargetWidth,
            followsResize, hostRestored, restoredHostWidth, originalWidth, restoresResize, mode
          }
        }
        const fullViewport = await expandedViewport('full')
        const rowViewport = await expandedViewport('row')
        const templates = {}
        for (const count of [1, 2, 4, 6, 8, 9, 12, 16]) {
          m.layout.apply(count)
          await sleep(140)
          templates[count] = read(count)
        }
        m.layout.apply(1)
        await sleep(120)
        m.layout.split('h'); await sleep(120)
        m.layout.split('v'); await sleep(120)
        m.layout.split('h'); await sleep(180)
        const nested = read(4)
        const scrollsWhenNeeded = shrink16.hostScrollWidth > shrink16.hostClientWidth && shrink16.scrollReachable &&
          nested.hostScrollWidth > nested.hostClientWidth && nested.scrollReachable
        return {
          ok: shrink16.ok && Object.values(templates).every(x => x.ok) && nested.ok &&
            scrollsWhenNeeded && scrollDismissesMenu.ok && fullViewport.ok && rowViewport.ok,
          shrink16, templates, nested, scrollsWhenNeeded, scrollDismissesMenu, fullViewport, rowViewport
        }
      })()`)
      l.ok = Boolean(l.ok && lWide.ok)
      l.wide16 = lWide

      const pass = Boolean(a.ok && b.ok && c.ok && d.ok && e.ok && f.ok && g.ok && h.ok && i.ok && j.ok && k.ok && l.ok)
      result = { pass, a, b, c, d, e, f, g, h, i, j, k, l }
    } catch (err) {
      result = { pass: false, stage, error: String(err) }
    }
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}
