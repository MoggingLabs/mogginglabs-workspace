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
  // Safety net: exit if a stage wedges. Raised 200s -> 300s when the identity-AA sweep (m)
  // landed — it creates a full 12-workspace roster and probes every colour across four themes
  // twice, which is real work the old ceiling did not budget for. Still a hang-catcher, not a
  // deadline the happy path approaches: a clean run emits and exits near 230s.
  setTimeout(() => app.exit(1), 300000)
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
        // The bar's CHROME CONTROLS — its icon buttons — and nothing else.
        //
        // This was a bare querySelectorAll('button'), which happened to name the same set
        // right up until the cluster gained a button that is not a control. It has two now:
        //   .browser-global-stop  — the "Agent driving browser" possession banner's Stop.
        //     browser/index.ts PREPENDS that banner into .titlebar-right, hidden until an
        //     agent actually drives a browser. Hidden measures 0x0, and prepended it LEADS
        //     the descendant order — so it became w0/h0 and the entire bar was measured
        //     against a button that is not on screen.
        //   the usage popover's rows, whenever it is open (it is a child of the cluster).
        // Neither was ever in this contract. "One uniform hit target" is a statement about
        // #titlebar .icon-btn — which is exactly what the 29px below has always tracked —
        // not about a text button inside a transient role=status banner, and not about the
        // innards of a popover. Popovers (.menu covers both the usage popover and the
        // layout menu) are excluded structurally rather than by their hidden-ness, so an
        // OPEN one cannot silently rejoin the measurement either.
        const all = [...cluster.querySelectorAll('.icon-btn')].filter(el => !el.closest('.menu'))
        const fixed = [...cluster.querySelectorAll(':scope > .icon-btn')] // board/settings
        // The rail toggle LEADS the bar's left cell now (it belongs over the column it
        // collapses), so it is measured with the cluster it shares a hit target with.
        const size = [...all, ...(toggle ? [toggle] : [])].map(el => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), cls: el.className, name: el.getAttribute('aria-label') } })
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
        // ...and the banner that broke this stage becomes an ASSERTION rather than an ambush.
        // Filtering it out and saying nothing would hide the regression that actually matters:
        // a possession banner shipped VISIBLE at rest would sail through every check above,
        // and it would be shouting "Agent driving browser" at a user with no agent. So: it is
        // in the cluster, it is quiet until an agent drives, and its Stop is not a hit target.
        const banner = cluster.querySelector('.browser-global-possession')
        const stop = banner && banner.querySelector('.browser-global-stop')
        const bannerQuiet = !!banner && banner.hidden === true && !!stop &&
          !stop.classList.contains('icon-btn') && stop.getBoundingClientRect().width === 0
        return {
          ok: sameHit && sameGap && toggleLeads && noHomeBtn && bannerQuiet,
          count: all.length, fixed: fixed.length, w0, h0, gaps, sizes: size,
          sameHit, sameGap, toggleLeads, noHomeBtn, bannerQuiet
        }
      })()`)

      // ── (e): a non-active workspace's pane needs input → its tab latches the ring. ──
      // ── (a2): THE TOP BAR NEVER OVERLAPS EITHER. The right cluster is rigid (icon
      //    buttons do not shrink) and `justify-self: end`, so a track narrower than the
      //    cluster made it overflow LEFTWARDS, over the command box — measured at 922px:
      //    track 310px, cluster 347px, the Board icon sitting on the box's right edge. The
      //    old defence was a 900px media query priced at "four 29px buttons", and features
      //    MOUNT their triggers into this cluster at runtime (there are six now), so the
      //    number was wrong the moment anyone added one. The columns reserve min-content
      //    now; this sweeps the band that was broken (900-960) and the rest of the range,
      //    and asserts what the eye asserts: nothing paints over anything. ──
      stage = 'a2-titlebar-fit'
      const TITLEBAR_FIT = `(() => {
        const bar = document.getElementById('titlebar')
        const R = el => el.getBoundingClientRect()
        const rendered = el => !!el && getComputedStyle(el).display !== 'none' && R(el).width > 0
        // The bar's real controls (popovers excluded structurally — see (a)) plus the brand
        // and the command box: everything that paints in this strip.
        const cands = [
          bar.querySelector('.rail-toggle'), bar.querySelector('.brand-logo'),
          bar.querySelector('.brand-name'), bar.querySelector('.brand-version'),
          bar.querySelector('.palette-trigger'),
          ...bar.querySelectorAll('.titlebar-right .icon-btn')
        ].filter(el => el && rendered(el) && !el.closest('.menu'))
        const leaves = cands.filter(el => !cands.some(o => o !== el && el.contains(o)))
        const clipOf = el => {
          let l = R(el).left, r = R(el).right
          for (const c of [el.closest('.titlebar-lead'), el.closest('.titlebar-center'), bar]) {
            if (c && c !== el) { l = Math.max(l, R(c).left); r = Math.min(r, R(c).right) }
          }
          return { name: el.getAttribute('aria-label') || el.className, left: l, right: r, width: Math.max(0, r - l) }
        }
        const boxes = leaves.map(clipOf).filter(b => b.width > 0.5)
        const overlaps = []
        for (let i = 0; i < boxes.length; i++) {
          for (let k = i + 1; k < boxes.length; k++) {
            const ov = Math.min(boxes[i].right, boxes[k].right) - Math.max(boxes[i].left, boxes[k].left)
            if (ov > 0.5) overlaps.push(boxes[i].name + '/' + boxes[k].name + '=' + Math.round(ov))
          }
        }
        // Every control stays reachable at every width (Win titlebar guidance), and the bar
        // itself never overflows the window.
        const controls = [...bar.querySelectorAll('.titlebar-right .icon-btn')].filter(el => !el.closest('.menu'))
        const controlsVisible = controls.length > 0 && controls.every(rendered)
        const noOverflow = bar.scrollWidth <= bar.clientWidth + 1
        return { width: innerWidth, overlaps, controlsVisible, noOverflow,
                 ok: overlaps.length === 0 && controlsVisible && noOverflow }
      })()`
      const titlebarProbes: Array<Record<string, unknown>> = []
      for (const width of [1600, 1200, 1000, 960, 940, 922, 900, 899, 800, 700, 600]) {
        win.setSize(width, 760)
        await sleep(320)
        titlebarProbes.push(await ES<Record<string, unknown>>(TITLEBAR_FIT))
      }
      win.setSize(1200, 460)
      await sleep(320)
      const a2 = {
        ok: titlebarProbes.length > 0 && titlebarProbes.every((p) => p.ok === true),
        overlaps: titlebarProbes.flatMap((p) => (p.overlaps as string[]).map((o) => `${p.width}:${o}`)),
        probes: titlebarProbes
      }

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
      //    reveal fires on :hover AND :focus-within, so the hide must fire on both too, or a
      //    clicked tab shows the count and the × crowding its label for as long as it keeps
      //    focus.
      //    The focus now lands on `.ws-tab-activate`, not the tab itself: the tab used to be
      //    a div[role=button] wrapping the close BUTTON — invalid content whose keydown
      //    handler also ate Enter/Space before close could ever see them (finding 30). The
      //    tab is a plain div now; the two real buttons inside it are what focus. The CSS
      //    keys on :focus-within, so the reveal contract this stage guards is unchanged. ──
      stage = 'i-tab-badges'
      const i = await ES<Record<string, unknown>>(`(() => {
        const tab = document.querySelector('.workspace-tab')
        if (!tab) return { ok: false, reason: 'no tab' }
        const activate = tab.querySelector('.ws-tab-activate')
        if (!activate) return { ok: false, reason: 'no activate button' }
        const disp = sel => { const el = tab.querySelector(sel); return el ? getComputedStyle(el).display : 'absent' }
        const restCount = disp('.ws-count'), restClose = disp('.ws-close')
        activate.focus()
        const focusCount = disp('.ws-count'), focusClose = disp('.ws-close')
        activate.blur()
        return {
          ok: restCount !== 'none' && restClose === 'none' && focusCount === 'none' && focusClose !== 'none',
          restCount, restClose, focusCount, focusClose
        }
      })()`)

      // ── (j): THE BAR FITS. Four things are never surrendered — the state glyph, the
      //    agent-CLI mark, ⋯ and ×. Everything else retires in a FIXED order, least-
      //    identifying first, and the contract this asserts is not a table of pixel
      //    thresholds — it is the four things that must be true AT EVERY WIDTH:
      //
      //      no overlap   nothing in this bar paints over anything else in it
      //      no clipping  nothing is cut off invisibly (the title is exempt: it
      //                   ellipsises by design, and its full text lives in ⋯)
      //      anchors      the four never-surrendered marks are always on screen
      //      order        what survives is a SUFFIX of the ladder: a rung can only be
      //                   lit if every rung after it is lit too
      //
      //    The old version of this stage asserted a per-width visibility table and passed
      //    while the bar was visibly broken: it never looked at geometry, so it never saw
      //    that on a 900px pane the branch chip's box was 24px wide with 370px of content
      //    painting across the gauge, the ⋯ and the ×. What retires is now MEASURED
      //    (pane-header-fit.ts) precisely because a width threshold cannot see how long an
      //    agent's title is — so the sweep runs TWICE, once with a short name and once
      //    with the long OSC title that broke it. ──
      stage = 'j-collapse'
      win.setSize(1600, 800) // wide enough to sweep the pane widths a 1×1 grid really reaches
      await sleep(600)
      const j = await ES<Record<string, unknown>>(`(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms))
        // The state glyph is gated on a tracked provider session (availability
        // contract) — adopt one so the never-surrendered anchor exists to assert.
        window.__mogging.agents.adopt(${paneId}, 'claude', '')
        const slot = document.querySelector('.layout-slot[data-pane-id="${paneId}"]')
        if (!slot) return { ok: false, reason: 'no slot' }
        const header = slot.querySelector('.pane-header')
        const p = (window.__mogging.panes || []).find(p => p.id === ${paneId})
        const titleEl = header.querySelector('.pane-title')
        const R = el => el.getBoundingClientRect()
        const rendered = el => !!el && getComputedStyle(el).display !== 'none' && R(el).width > 0

        const LEAF = {
          state: '.pane-state', remote: '.pane-remote', agent: '.pane-agent', role: '.pane-role',
          claims: '.pane-claims', mcp: '.pane-mcp', title: '.pane-title',
          gitIcon: '.pane-git > svg', branch: '.pane-branch', worktree: '.pane-worktree',
          dirty: '.pane-dirty', gitState: '.pane-git-state', gitStaged: '.pane-git-staged',
          gitComparison: '.pane-git-comparison', ctxDisc: '.ctx-disc', ctxPct: '.ctx-pct',
          menu: '[aria-label="Pane menu"]', close: '[aria-label="Close terminal"]'
        }
        // Retirement order (global.css). Survivors must be a suffix of it.
        const LADDER = ['ctxPct', 'worktree', 'gitStaged', 'gitComparison', 'gitState', 'expand', 'branch']

        // What the EYE sees: the element's rect, clipped by every box that clips it. Raw
        // rects would report a CLIPPED chip as an overlap; cluster boxes would have missed
        // the real one (the pill's box stayed 24px while its content painted 346px past it).
        const seen = el => {
          let l = R(el).left, r = R(el).right
          for (const c of [el.closest('.pane-git'), el.closest('.pane-head-left'), header]) {
            if (c && c !== el) { l = Math.max(l, R(c).left); r = Math.min(r, R(c).right) }
          }
          return { left: l, right: r, width: Math.max(0, r - l) }
        }

        // 'plain' is the app's ORDINARY pane and the one in the bug report: an agent in a
        // dirty repo, with no swarm role, no claims, no MCP chip and no remote. The crowded
        // fixture cannot afford a full branch chip at any width, so it can prove "nothing
        // overlaps" but it cannot prove "the NAME is what yields" — only this can.
        const plainify = () => {
          for (const sel of ['.pane-role', '.pane-claims', '.pane-mcp', '.pane-remote']) {
            const el = header.querySelector(sel)
            if (el) el.hidden = true
          }
          header.querySelector('.pane-branch').textContent = 'main'
          const wt = header.querySelector('.pane-worktree')
          if (wt) wt.hidden = true
          header.querySelector('.pane-git-state').textContent = '2 uncommitted'
          header.querySelector('.pane-git-staged').textContent = '0 staged'
          header.querySelector('.pane-git-comparison').textContent = '= main'
        }
        const at = async (px, title, plain) => {
          slot.style.width = px + 'px'
          await sleep(130)
          if (p && p.lightChips) p.lightChips() // a real MCP/git push can re-hide the forced chips
          if (plain) plainify()
          if (title != null) titleEl.textContent = title
          if (p && p.refit) p.refit()           // the fixture writes text behind the ports' back
          await sleep(140)

          const vis = {}, boxes = {}
          for (const name of Object.keys(LEAF)) {
            const el = header.querySelector(LEAF[name])
            vis[name] = rendered(el)
            if (vis[name]) boxes[name] = seen(el)
          }
          const trio = [...slot.querySelectorAll('.pane-act-expand')]
          vis.expand = trio.some(rendered)
          trio.filter(rendered).forEach(e => { boxes['expand:' + e.dataset.expand] = seen(e) })

          const names = Object.keys(boxes).filter(n => boxes[n].width > 0.5)
          const overlaps = []
          for (let i = 0; i < names.length; i++) {
            for (let k = i + 1; k < names.length; k++) {
              const A = boxes[names[i]], B = boxes[names[k]]
              const ov = Math.min(A.right, B.right) - Math.max(A.left, B.left)
              if (ov > 0.5) overlaps.push(names[i] + '/' + names[k] + '=' + Math.round(ov))
            }
          }
          // Cut off invisibly? Anything whose real box runs past the box that clips it is
          // losing information the ⋯ menu was supposed to be given instead.
          const clipped = []
          for (const name of Object.keys(LEAF)) {
            if (!vis[name] || name === 'title') continue
            const el = header.querySelector(LEAF[name])
            const clip = el.closest('.pane-git') || header
            const c = R(clip), raw = R(el)
            const hidden = Math.max(0, c.left - raw.left) + Math.max(0, raw.right - c.right)
            if (hidden > 1) clipped.push(name + '=' + Math.round(hidden))
          }
          // A rung is ELIGIBLE when it has data at all (the app hides an empty worktree /
          // staged chip outright) — a rung dark for want of data says nothing about order.
          const eligible = rung => {
            if (rung === 'expand') return trio.length > 0
            const el = header.querySelector(LEAF[rung])
            return !!el && !el.hidden
          }
          let orderOk = true
          for (let i = 0; i < LADDER.length; i++) {
            if (!eligible(LADDER[i]) || !vis[LADDER[i]]) continue
            for (let k = i + 1; k < LADDER.length; k++) {
              if (eligible(LADDER[k]) && !vis[LADDER[k]]) orderOk = false
            }
          }
          const git = header.querySelector('.pane-git')
          const left = header.querySelector('.pane-head-left')
          // Nothing may be holding more than it can show. (The title is exempt inside its
          // OWN box — it ellipsises — but its box is a child of the left cluster, so the
          // cluster's own overflow still has to be zero.)
          const over = {
            header: header.scrollWidth - header.clientWidth,
            left: left.scrollWidth - left.clientWidth,
            git: rendered(git) ? git.scrollWidth - git.clientWidth : 0
          }
          const fits = over.header <= 1 && over.left <= 1 && over.git <= 1
          // The title is exempt from the anchor rule only at the compact rungs, where it
          // moves into the ⋯ menu wholesale.
          const anchors = vis.state && vis.agent && vis.menu && vis.close
          const ok = overlaps.length === 0 && clipped.length === 0 && orderOk && fits && anchors
          const titleEllipsised = titleEl.scrollWidth > titleEl.clientWidth + 1
          return { px, ok, overlaps, clipped, orderOk, fits, over, anchors, titleEllipsised, vis }
        }

        const LONG = 'Review audit remediation handoff document'
        const WIDTHS = [1200, 1130, 1000, 900, 800, 765, 700, 620, 505, 455, 340, 218, 140]
        const shortName = []
        for (const w of WIDTHS) shortName.push(await at(w, 'Terminal 1', false))
        const longName = []
        for (const w of WIDTHS) longName.push(await at(w, LONG, false))
        const plainName = []
        for (const w of WIDTHS) plainName.push(await at(w, LONG, true))
        slot.style.width = ''
        await sleep(150)

        const probes = [...shortName, ...longName, ...plainName]
        const overlaps = probes.flatMap(s => s.overlaps.map(o => s.px + ':' + o))
        const clipped = probes.flatMap(s => s.clipped.map(c => s.px + ':' + c))
        const anchorsHold = probes.every(s => s.anchors)
        const orderHolds = probes.every(s => s.orderOk)
        const allFit = probes.every(s => s.fits)
        // The gauge's DISC (color ramp + sweep) outlives every rung above it, and the name
        // outlives the whole ladder — it is only ever ellipsised, never taken, until the
        // 200px compact rung moves it into the menu.
        const wide = shortName[0], narrow = longName[longName.length - 1]
        const ctxGauge = shortName.slice(0, -1).every(s => s.vis.ctxDisc)
        const titleSurvives = longName.filter(s => s.px > 218).every(s => s.vis.title)
        // THE BUG IN THE SCREENSHOTS, asserted: an ordinary agent pane in a dirty repo, a
        // long agent-set title, a wide pane. The NAME is what gives way — it ellipsises —
        // and the branch chip keeps every field it has. Before the fit pass the opposite
        // happened: the title took its full max-content, the chip's column collapsed, and
        // "= main" rendered on top of the gauge.
        const plainWide = plainName.filter(s => s.px >= 1130)
        const chipIntact = plainWide.length > 0 && plainWide.every(s =>
          s.vis.title && s.vis.branch && s.vis.gitState && s.vis.gitStaged && s.vis.gitComparison)
        // 1130px is the width from the report: the row is ~57px short of holding the whole
        // name AND the whole chip, and the name is what pays for it. (At 1200 everything
        // fits and nothing is asked to give — that is the same rule, not an exception.)
        const at1130 = plainName.find(s => s.px === 1130)
        const nameYieldsFirst = chipIntact && Boolean(at1130 && at1130.titleEllipsised)
        return {
          ok: overlaps.length === 0 && clipped.length === 0 && anchorsHold && orderHolds &&
              allFit && ctxGauge && titleSurvives && nameYieldsFirst,
          overlaps, clipped, anchorsHold, orderHolds, allFit, ctxGauge, titleSurvives, nameYieldsFirst,
          wide: wide && wide.vis, narrow: narrow && narrow.vis,
          shortName: shortName.map(s => ({ px: s.px, ok: s.ok, over: s.over, vis: s.vis })),
          longName: longName.map(s => ({ px: s.px, ok: s.ok, over: s.over, vis: s.vis })),
          plainName: plainName.map(s => ({ px: s.px, ok: s.ok, over: s.over, ell: s.titleEllipsised, vis: s.vis }))
        }
      })()`)
      win.setSize(1200, 760)
      await sleep(400)

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
        const titleRoom = await probe(300) // 283px content: the first width six characters really fit
        const samples = [exact, aboveContext, aboveCompactGaps, aboveTitle, titleRoom]
        const sampleGeometry = samples.every(s => s.anchorsVisible && s.noOverlap && s.ancestorContained && s.clustersSeparated)
        const signalRhythm = [exact, aboveContext, aboveCompactGaps].every(s =>
          Math.abs(s.dotAgentGap - 8) <= 0.5 &&
          (s.agentContextGap == null || Math.abs(s.agentContextGap - 8) <= 0.5) &&
          s.signalGapMatched)
        // The name is on the bar exactly while it FITS — measured, not at a guessed rung.
        // 201px of content cannot hold six characters beside a lit gauge and the four
        // anchors (it is 19px short), and the old 200px rung let it try: the title's box
        // was clipped by 33px, mid-glyph, and nothing asserted otherwise. It comes back the
        // moment there is room for it.
        const transitions = Math.abs(exact.paneWidth - 132) <= 0.5 && exact.queryWidth === 115 && !exact.contextShown && !exact.titleShown &&
          aboveContext.queryWidth === 136 && aboveContext.contextShown && !aboveContext.titleShown &&
          aboveCompactGaps.queryWidth === 158 && aboveCompactGaps.contextShown && !aboveCompactGaps.titleShown &&
          aboveTitle.queryWidth === 201 && aboveTitle.contextShown && !aboveTitle.titleShown &&
          titleRoom.contextShown && titleRoom.titleShown
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
      //
      // THE SHRINK ASKS FIRST NOW, and this stage has to answer it. `layout.apply` is the
      // centralized close policy's entry point for a layout shrink (audit finding 10 — the
      // same dialog WSCLOSE drives from pane chrome, the control API and the rail's Delete
      // key): a template that would close panes holding LIVE WORK confirms before destroying
      // them, and the promise apply() returns does not resolve until that dialog is answered.
      //
      // This gate adopts a claude session on the measured pane back in (c), so every shrink
      // below is precisely the case the policy exists for. Firing apply() and walking away
      // left the modal standing and the grid stuck at 16 panes for every template after the
      // first — the floor was never re-measured, and the stage failed on a dialog it had
      // simply declined to read.
      //
      // So: confirm, because shrinking IS what this stage came to measure — and record the
      // answer, which turns the policy from the thing that broke the stage into one more
      // thing it proves.
      const APPLY_TEMPLATE = `const applyTemplate = async n => {
        const done = window.__mogging.layout.apply(n) // may raise the confirm — do NOT await it yet
        await sleep(140)
        const danger = document.querySelector('.modal-overlay:not(.is-closing) .btn--danger')
        if (danger) danger.click()
        const applied = await done
        await sleep(180) // the grid re-lays out behind the dialog's close
        return { applied, confirmed: !!danger }
      }`
      stage = 'l-pane-floor'
      win.setSize(1200, 760)
      await sleep(650)
      const lWide = await ES<Record<string, unknown>>(`(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms))
        ${APPLY_TEMPLATE}
        // GROWTH is non-destructive and must never ask — a policy that nagged on every layout
        // change would be its own regression, so the silence is asserted, not assumed.
        const grow = await applyTemplate(16)
        const widths = [...document.querySelectorAll('.workspace-view.active .layout-slot')].map(el => el.getBoundingClientRect().width)
        return {
          ok: widths.length === 16 && widths.every(w => w >= 131.5) && grow.applied === true && grow.confirmed === false,
          grow, widths
        }
      })()`)
      win.setSize(600, 760)
      await sleep(800)
      const l = await ES<Record<string, unknown>>(`(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms))
        const m = window.__mogging
        ${APPLY_TEMPLATE}
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
          const applied = await applyTemplate(count)
          templates[count] = { ...read(count), ...applied }
        }
        await applyTemplate(1)
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

      // ── (m): the workspace IDENTITY holds AA — every colour, every state, every theme.
      //    (g) already probed `.ws-label`, and that is exactly why this was missed for so
      //    long: querySelector takes the FIRST match, the first tab is teal, and teal is one
      //    of the few identity colours that passed. The failure was never in the selector —
      //    it was in WHICH colour the selector happened to land on. Violet, rose and magenta
      //    were 2.9–3.8:1 on nord and nobody was looking.
      //    So the roster is probed BY ORDINAL — all 12 colours — on both grounds the rail inks
      //    ink onto, plus the two alert badges (text on a semantic fill, the only such text in
      //    the app). Two DOM states, two theme sweeps — theme-switching is the cost, so the
      //    count is kept to the minimum that still covers both grounds:
      //      REST — 12 idle tabs, glyph on the opaque --bg-inset chip; + the active tab's label
      //             on its tint; + tab 2/3 driven to attention/done for the two badges (those
      //             states are NOT `working`, so their glyphs stay on the rest ground too).
      //      LIT  — every background tab `busy` -> `.is-working`, so 12 glyphs on the 12%
      //             identity wash (the same ground the SELECTED tab paints, now the chips no
      //             longer stack). A latched alert would suppress `.is-working`, so the setup
      //             visits every workspace first to disarm the latches.
      //    Teal (tab 1) is the one active tab in REST, so it is measured on tint there, not
      //    inset — it is the strongest identity (7.7:1 on inset) and never the binding case.
      stage = 'm-ws-identity-aa'
      console.log('[chromeux] (m) identity AA — setup')
      const wsIcons: string[] = []
      for (let n = 1; n <= 12; n++) wsIcons.push(`#workspace-tabs .workspace-tab:nth-of-type(${n}) .ws-icon`)
      const activeLabel = '#workspace-tabs .workspace-tab.active .ws-label'
      const attnSel = '#workspace-tabs .workspace-tab:nth-of-type(2) .ws-attn'
      const doneSel = '#workspace-tabs .workspace-tab:nth-of-type(3) .ws-done'

      const setup = await ES<{ tabs: number; attn: boolean; done: boolean }>(`(async () => {
        const m = window.__mogging
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        for (let n = m.workspace.count(); n < 12; n++) m.workspace.create({ name: 'AA ' + (n + 1), activate: false })
        await sleep(600)
        const list = m.workspace.list()
        // Quiet every pane, then VISIT each workspace: focusing is the only thing that disarms a
        // latched alert, and a latched tab rings instead of ever showing the working chip.
        for (const w of list) m.attention.setPaneState(w.ordinal * 100 + 1, 'idle')
        for (let i = 0; i < list.length; i++) { m.workspace.switchByIndex(i); await sleep(50) }
        m.workspace.switchByIndex(0)
        // The two badges, on background tabs (attention/done are NOT working — the glyphs stay
        // on the rest ground, so this costs the rest sweep no coverage).
        m.attention.setPaneState(list[1].ordinal * 100 + 1, 'attention') // -> .ws-attn on tab 2
        m.attention.setPaneState(list[2].ordinal * 100 + 1, 'done') // -> .ws-done on tab 3
        await sleep(500)
        const vis = (s) => { const el = document.querySelector(s); return !!el && !el.hidden && el.getBoundingClientRect().width > 0 }
        return { tabs: m.workspace.count(), attn: vis(${JSON.stringify(attnSel)}), done: vis(${JSON.stringify(doneSel)}) }
      })()`)
      await sleep(300)

      console.log('[chromeux] (m) sweep 1/2 — rest glyphs + active label + badges')
      const mRest = await probeContrastAcrossThemes({ es: ES, sleep, selectors: [...wsIcons, activeLabel, attnSel, doneSel] })

      console.log('[chromeux] (m) sweep 2/2 — working/lit glyphs')
      const working = await ES<number>(`(async () => {
        const m = window.__mogging
        const list = m.workspace.list()
        // Every background tab to busy -> .is-working -> glyph on the --ws-tint wash. A couple
        // sit the state out (base-smoke workspaces on special panes — see the >= 8 floor below),
        // but their glyphs are still measured on the rest ground and still pass.
        for (let i = 1; i < list.length; i++) m.attention.setPaneState(list[i].ordinal * 100 + 1, 'busy')
        await new Promise(r => setTimeout(r, 500))
        return document.querySelectorAll('#workspace-tabs .workspace-tab.is-working').length
      })()`)
      const mLit = await probeContrastAcrossThemes({ es: ES, sleep, selectors: [...wsIcons, activeLabel] })
      console.log(`[chromeux] (m) done — worst rest ${mRest.worst}, worst lit ${mLit.worst}`)

      const mFail = [...mRest.failures, ...mLit.failures]
      const mMissing = [...new Set([...mRest.missing, ...mLit.missing])]
      const m = {
        ok:
          mFail.length === 0 && // THE verdict: zero identity/badge inks below AA, any theme
          mMissing.length === 0 && // and every selector was actually found + measured
          setup.tabs === 12 &&
          // A liveness floor, not an exact count: the lit chip must have rendered on enough
          // background tabs that the tint ground is broadly measured. NOT `=== 11` — the base
          // smoke (stages a–l) leaves a couple of workspaces on special panes (a remote
          // `chromeux-host` fixture, a failed spawn) that never enter `.is-working` when set
          // busy. Their glyphs still render in --ws-ink and are still measured + pass (that is
          // why `failures` stays NONE); they simply sit out the working STATE. Nine of eleven
          // is the steady figure; the floor leaves margin without pretending to an exactness
          // the shared roster cannot promise.
          working >= 8 &&
          setup.attn &&
          setup.done, // a badge that never showed is a badge that was never measured
        failures: mFail,
        missing: mMissing,
        tabs: setup.tabs,
        workingTabs: working,
        badgesShown: { attn: setup.attn, done: setup.done },
        worstRest: mRest.worst,
        worstLit: mLit.worst,
        rest: mRest.contrast,
        lit: mLit.contrast
      }
      // (m) writes its OWN verdict the instant it settles, not only into the combined result at
      // the very end. The identity-AA check is self-contained — it does not depend on stages
      // a–l — but the combined `emit` only fires after ALL of them, so under load a hang in an
      // unrelated late stage would take this verdict down with it and leave the AA question
      // unanswered. A dedicated file means the answer survives regardless. Best-effort.
      try {
        writeFileSync(join(app.getAppPath(), 'out', 'chromeux-identity-aa.json'), JSON.stringify(m, null, 2))
      } catch {
        /* best effort */
      }
      await ES(`(() => {
        const m = window.__mogging
        for (const w of m.workspace.list()) m.attention.setPaneState(w.ordinal * 100 + 1, 'idle')
        return true
      })()`)

      const pass = Boolean(
        a.ok && a2.ok && b.ok && c.ok && d.ok && e.ok && f.ok && g.ok && h.ok && i.ok && j.ok && k.ok && l.ok && m.ok
      )
      result = { pass, a, a2, b, c, d, e, f, g, h, i, j, k, l, m }
    } catch (err) {
      result = { pass: false, stage, error: String(err) }
    }
    console.log(`[chromeux] emitting verdict: pass=${result.pass}${result.stage ? ` (died at ${result.stage})` : ''}`)
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}
