import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Env-gated scroll-anchor + overlay-scrollbar smoke (MOGGING_PANESCROLL). This gate
// exists because of a real regression: entering a workspace whose panes held long agent
// conversations (codex, but it was never about codex — the pane, not the CLI, owns the
// viewport) left EVERY pane scrolled to the top of its history. The pane must follow its
// newest output unless a human moved it, and the bar must be an overlay that shows itself
// only when it is wanted.
//
// The contract, in the order the assertions below run:
//   A ANCHOR      streaming output keeps the viewport at the newest line.
//   B REVEAL      output arriving while the pane is HIDDEN, then a workspace switch back
//                 (the reported bug: hidden fit + reveal reflow + replay burst) — the pane
//                 comes back AT the end of the conversation, not the top.
//   C REFIT       a zoom/restore cycle over deep scrollback does not strand the viewport.
//   D USER SCROLL a real wheel-up detaches the pane, and further output must NOT yank it
//                 back: the line you stopped on stays put.
//   E QUIET       an agent's cursor-position AUTO-REPLY (ESC[6n → xterm answers on the
//                 onData channel) must not read as typing and re-anchor the pane. This is
//                 the trap the naive fix falls into: agents poll it constantly.
//   F RETURN      the jump pill puts you back on the stream (and re-arms the anchor).
//   G TYPING      typing at the prompt re-arms it too.
//   H OVERLAY     invisible at rest; visible ONLY in its own right-edge lane (hovering
//                 the pane anywhere else shows nothing — and no stylesheet rule may
//                 reintroduce that), plus a flash while scrolling that fades.
//   I ENDS        the rail is full height: at the newest line the thumb sits flush on the
//                 floor, at the oldest flush against the ceiling.
//   K KEYBOARD    the same scrollback with no mouse at all (audit 31): Shift+PageUp/PageDown
//                 page, Shift+Home/End reach its ends, Shift+End re-arms the anchor — and not
//                 one of them reaches the shell (Shift+Home/End used to type ESC[1;2H/F into
//                 the agent, because xterm reads them as cursor keys, not scroll keys). The
//                 rail is aria-hidden decoration once the buffer is keyboard-reachable; the
//                 jump pill, a real button, is not.
//
// Every step drives the SHIPPED listeners with real events at real targets (wheel on the
// xterm viewport, pointerenter on the lane, click on the pill, keydown on the pane) —
// nothing here calls the anchor's API directly, so a fix that only works in the gate
// cannot pass it.

const SCRIPT = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const m = window.__mogging
  if (!m || !m.workspace || !m.layout) return { pass: false, error: 'no dev handles' }

  const FLASH_MS = 900          // pane-scrollbar ACTIVE_MS
  const REST_MS = FLASH_MS + 500 // long enough for the flash to have faded
  const fail = []
  const check = (name, ok, detail) => { if (!ok) fail.push(name + (detail ? ': ' + detail : '')) ; return ok }

  // Feed the pane's TERMINAL directly: this is the exact path a PTY stream, a reattach
  // replay and a restore repaint all land on — without needing a shell to cooperate.
  const feed = (p, n, tag) => new Promise((r) => {
    let s = ''
    for (let i = 0; i < n; i++) s += tag + ' ' + i + '\\r\\n'
    p.term.write(s, r)
  })
  const q = (p, sel) => p.el().querySelector(sel)
  // A real wheel over the terminal is TWO things, and the gate must reproduce both:
  //   1. the wheel EVENT, which the pane's anchor observes (a human is driving), and
  //   2. the browser's DEFAULT ACTION — xterm's viewport is a natively scrollable div,
  //      and moving its scrollTop is what actually walks the buffer (xterm syncs from it).
  // A dispatched WheelEvent is untrusted, so the engine performs no default action for it;
  // the gate performs it. This is exactly why the anchor may not decide from scroll EVENTS
  // alone — the native path can move the user without emitting one.
  const SETTLE_MS = 600 // > the anchor's gesture window: the gesture must come to rest
  // A wheel over a terminal is TWO things, and a gate can only ever dispatch the first:
  //   1. the EVENT, which the pane's anchor observes (a human is driving) — dispatched here
  //      onto the real element, so the listener that runs is the shipped one; and
  //   2. the resulting SCROLL, which no dispatched event can produce: untrusted events get no
  //      default action, and xterm 6 refuses them outright (verified against every candidate
  //      element — .xterm, .xterm-screen, .xterm-viewport, .xterm-scrollable-element — none
  //      move the buffer). Under xterm 5 this half was the viewport div's scrollTop; xterm 6
  //      retired that for its own scrollable element, so the gate performs the engine's own
  //      action instead: scroll the buffer by the lines that delta is worth.
  // What is under test is the ANCHOR and the BAR — does a human leaving the bottom detach the
  // pane, and does the agent's next output then leave them where they stopped — not xterm's
  // wheel plumbing.
  const wheel = (p, dy) => {
    const el = q(p, '.xterm-scrollable-element') || q(p, '.xterm-viewport') || q(p, '.xterm')
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, deltaMode: 0, bubbles: true, cancelable: true }))
    const cell = Math.max(1, el.getBoundingClientRect().height / Math.max(1, p.rows()))
    p.term.scrollLines(Math.round(dy / cell)) // the default action the engine would have run
  }
  const opacity = (p) => Number(getComputedStyle(q(p, '.pane-slider')).opacity)

  // --- Setup: 4 panes with deep scrollback ----------------------------------------
  if (m.workspace.count() === 0) m.workspace.create({ name: 'Panes' })
  await sleep(600)
  m.layout.apply(4)
  for (let i = 0; i < 100 && (m.panes || []).length < 4; i++) await sleep(200)
  const panes = (m.panes || []).slice(0, 4)
  if (panes.length < 4) return { pass: false, error: 'expected 4 panes, got ' + panes.length }
  await sleep(2000) // shells reach their prompts
  for (const p of panes) await feed(p, 400, 'HIST')
  await sleep(400)

  // --- A · ANCHOR: streaming stays at the newest line ------------------------------
  for (const p of panes) await feed(p, 60, 'STREAM')
  await sleep(300)
  const a = panes.map((p) => p.scroll())
  check('A anchor', a.every((s) => s.atBottom && s.following && s.baseY > 0), JSON.stringify(a))
  check('A no pill at bottom', a.every((s) => !s.jumpShown))

  // --- B · THE REPORTED BUG: a NON-USER scroll must never survive --------------------
  // What actually stranded those codex panes at the top of their conversations is a scroll
  // nobody asked for, arriving with the reattach replay. The gate does not care WHICH
  // sequence in that replay does it (an app-level jump, a scroll region, a reflow): it
  // asserts the invariant we ship — the ONLY thing allowed to leave the bottom is a human.
  // So it strands the panes deliberately, exactly as the bug does, and demands they recover.
  //
  // B1 · while VISIBLE: a stray scroll to the top, mid-stream. Corrected immediately.
  for (const p of panes) p.term.scrollToTop()
  await sleep(500)
  const b1 = panes.map((p) => p.scroll())
  check('B1 stray scroll corrected', b1.every((s) => s.atBottom && s.following), JSON.stringify(b1))

  // B2 · while HIDDEN, then revealed: the reported path end to end — the panes take their
  // replay burst blind (fitted against a zero-height body), get stranded at the top, and
  // the user walks back into the workspace. They must be AT the end of the conversation.
  m.workspace.create({ name: 'Away' })
  await sleep(900) // panes hidden: they fit against a zero-height body
  for (const p of panes) {
    await feed(p, 500, 'HIDDEN') // the daemon's scrollback replay
    p.term.scrollToTop() // ...and whatever in it strands the viewport
  }
  await sleep(400)
  m.workspace.switchByIndex(0)
  await sleep(1800) // reveal: refit + reflow + WebGL re-acquire settle
  const b = panes.map((p) => p.scroll())
  check('B2 reveal lands at the end', b.every((s) => s.atBottom && s.following), JSON.stringify(b))
  check('B2 no pill on arrival', b.every((s) => !s.jumpShown))

  // --- C · REFIT: zoom churn over deep scrollback -----------------------------------
  for (let i = 0; i < 2; i++) { m.layout.zoom(); await sleep(700) } // even count -> grid restored
  await sleep(900)
  const c = panes.map((p) => p.scroll())
  check('C refit', c.every((s) => s.atBottom && s.following), JSON.stringify(c))

  // --- D · USER SCROLL: a wheel-up detaches, and output must not yank it back -------
  const p0 = panes[0]
  const probe = (p) => {
    const vp = q(p, '.xterm-viewport')
    return {
      id: p.id,
      connected: p.el().isConnected,
      rows: p.rows(),
      lines: p.bufferLines(),
      renderer: p.renderer(),
      vpScrollTop: vp ? vp.scrollTop : -1,
      vpScrollHeight: vp ? vp.scrollHeight : -1,
      vpClientHeight: vp ? vp.clientHeight : -1
    }
  }
  const diag = { paneCount: (m.panes || []).length, ids: (m.panes || []).map((x) => x.id), before: probe(p0) }
  wheel(p0, -600)
  await sleep(SETTLE_MS)
  diag.after = probe(p0)
  const dUp = p0.scroll()
  check('D wheel scrolled up', !dUp.atBottom && dUp.viewportY < dUp.baseY, JSON.stringify(dUp))
  check('D anchor released', !dUp.following)
  check('D pill offered', dUp.jumpShown)
  const heldAt = dUp.viewportY
  await feed(p0, 200, 'AFTER')
  await sleep(500)
  const dHold = p0.scroll()
  check('D viewport held', dHold.viewportY === heldAt && !dHold.atBottom, 'held=' + heldAt + ' now=' + dHold.viewportY)
  check('D still released', !dHold.following)
  // ...and the panes nobody touched are still following.
  const dOthers = panes.slice(1).map((p) => p.scroll())
  check('D others unaffected', dOthers.every((s) => s.atBottom && s.following))

  // --- E · QUIET: an agent's cursor-position query must not re-anchor the pane ------
  // ESC[6n makes xterm answer through onData — the same channel typing uses. An anchor
  // that listened there would drag the user back to the bottom on the agent's schedule.
  await new Promise((r) => p0.term.write('\\x1b[6n', r))
  await new Promise((r) => p0.term.write('\\x1b[c', r)) // device attributes: another auto-reply
  await feed(p0, 40, 'POLL')
  await sleep(500)
  const e = p0.scroll()
  check('E auto-replies quiet', e.viewportY === heldAt && !e.following, JSON.stringify(e))

  // --- F · RETURN: the jump pill re-attaches ----------------------------------------
  q(p0, '.pane-jump').click()
  await sleep(400)
  const f = p0.scroll()
  check('F pill returns', f.atBottom && f.following && !f.jumpShown, JSON.stringify(f))
  await feed(p0, 60, 'RESUMED')
  await sleep(300)
  check('F follows again', p0.scroll().atBottom)

  // --- G · TYPING re-arms the anchor -------------------------------------------------
  wheel(p0, -600)
  await sleep(SETTLE_MS)
  check('G scrolled up', !p0.scroll().following)
  q(p0, '.pane-body').dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
  await feed(p0, 20, 'TYPED')
  await sleep(400)
  const g = p0.scroll()
  check('G typing re-anchors', g.atBottom && g.following, JSON.stringify(g))

  // --- H · OVERLAY: invisible at rest, visible only in its own lane ------------------
  await sleep(REST_MS) // let the scroll flash fade
  const hRest = opacity(p0)
  check('H invisible at rest', hRest === 0, 'opacity=' + hRest)
  // Hovering the pane BODY is not hovering the bar: nothing may reveal it.
  q(p0, '.pane-body').dispatchEvent(new PointerEvent('pointerenter', { bubbles: false }))
  await sleep(200)
  check('H body hover shows nothing', opacity(p0) === 0)
  // No stylesheet may reintroduce the pane-wide hover reveal (the old rule).
  let paneHoverRule = ''
  for (const sheet of document.styleSheets) {
    let rules
    try { rules = sheet.cssRules } catch (_) { continue }
    for (const r of rules) {
      const sel = r.selectorText || ''
      if (/pane-body:hover/.test(sel) && /pane-slider/.test(sel)) paneHoverRule = sel
    }
  }
  check('H no pane-wide hover rule', paneHoverRule === '', paneHoverRule)
  // The lane itself: pointer in -> visible; pointer out -> gone.
  const lane = q(p0, '.pane-slider')
  lane.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false }))
  await sleep(250)
  const hHot = opacity(p0)
  check('H lane hover reveals', hHot === 1,
    'opacity=' + hHot + ' classes=' + lane.className + ' sliders=' + p0.el().querySelectorAll('.pane-slider').length)
  lane.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false }))
  await sleep(300)
  check('H leaves again', opacity(p0) === 0)
  // Scrolling flashes it, and the flash fades on its own. POLLED to the transition's end,
  // not sampled at a fixed beat: under CI's software compositor the opacity ramp is still
  // mid-flight at 150ms (the class is already 'is-active'), and the claim under test is that
  // the flash HAPPENS — not that it completes inside one frame budget.
  wheel(p0, -300)
  let hFlash = opacity(p0)
  for (let i = 0; i < 16 && hFlash !== 1; i++) {
    await sleep(50)
    hFlash = opacity(p0)
  }
  check('H flashes while scrolling', hFlash === 1, 'classes=' + q(p0, '.pane-slider').className)
  await sleep(REST_MS)
  check('H flash fades', opacity(p0) === 0)

  // --- I · ENDS: the rail is full height, so the ends are the real ends ---------------
  q(p0, '.pane-jump').click() // back to the newest line
  await sleep(400)
  const gBot = p0.sliderGeometry()
  check('I thumb on the floor', gBot && Math.abs(gBot.thumbBottom - gBot.trackBottom) <= 1, JSON.stringify(gBot))
  wheel(p0, -100000) // all the way up
  await sleep(SETTLE_MS)
  const top = p0.scroll()
  const gTop = p0.sliderGeometry()
  check('I scrolled to the top', top.viewportY === 0, JSON.stringify(top))
  check('I thumb on the ceiling', gTop && Math.abs(gTop.thumbTop - gTop.trackTop) <= 1, JSON.stringify(gTop))
  // And from the very top, the pill still brings the conversation back.
  q(p0, '.pane-jump').click()
  await sleep(400)
  check('I pill from the top', p0.scroll().atBottom)

  // --- J · EVERY TERMINAL, EVERY CLI --------------------------------------------------
  // The anchor and the bar belong to the PANE, so they cannot be a property of which CLI
  // is running in it — an agent is just a process the pane hosts. This step refuses to
  // take that on architecture alone and proves it: each CLI's characteristic output shape
  // is streamed into its own pane, each pane is then stranded exactly as the bug strands
  // it, and every one of them must come back to the end of its conversation with a working
  // overlay bar. If someone ever gives one CLI a bespoke terminal, this fails.
  const CR = String.fromCharCode(13)
  const ESC = String.fromCharCode(27)
  const CLIS = [
    // claude: OSC 133 command marks around its turns, OSC 0 window titles.
    { name: 'claude', line: (i) => ESC + ']133;C' + String.fromCharCode(7) + 'claude turn ' + i + CR +
        ESC + ']0;claude' + String.fromCharCode(7) + 'thinking...' + CR + ESC + ']133;D;0' + String.fromCharCode(7) },
    // codex: the reported offender — heavy repaint traffic. Cursor save/restore, a scroll
    // REGION (DECSTBM), cursor addressing, and the CPR query it polls constantly.
    { name: 'codex', line: (i) => ESC + '7' + ESC + '[1;40r' + ESC + '[2K' + 'codex step ' + i + CR +
        ESC + '[6n' + ESC + '8' + ESC + '[?25h' + 'tool call ' + i + CR },
    // gemini: SGR-heavy streaming with erase-in-line rewrites.
    { name: 'gemini', line: (i) => ESC + '[38;5;33m' + 'gemini ' + i + ESC + '[0m' + ESC + '[K' + CR },
    // ...and a plain shell, which must be no different.
    { name: 'shell', line: (i) => '$ echo ' + i + CR + 'out ' + i + CR }
  ]
  m.layout.apply(4)
  await sleep(800)
  const jp = (m.panes || []).slice(0, 4)
  const jRes = []
  for (let i = 0; i < CLIS.length; i++) {
    const p = jp[i]
    const cli = CLIS[i]
    let s = ''
    for (let n = 0; n < 300; n++) s += cli.line(n)
    await new Promise((r) => p.term.write(s, r))
    await sleep(200)
    const streaming = p.scroll()
    p.term.scrollToTop() // strand it, exactly as the bug does
    await sleep(500)
    const recovered = p.scroll()
    jRes.push({ cli: cli.name, streamedAtBottom: streaming.atBottom, recovered: recovered.atBottom,
      following: recovered.following, hasBar: !!q(p, '.pane-slider'), hasPill: !!q(p, '.pane-jump') })
  }
  check('J every CLI streams at the bottom', jRes.every((r) => r.streamedAtBottom), JSON.stringify(jRes))
  check('J every CLI recovers from a stray scroll', jRes.every((r) => r.recovered && r.following), JSON.stringify(jRes))
  check('J every CLI pane has the overlay bar', jRes.every((r) => r.hasBar && r.hasPill), JSON.stringify(jRes))

  // ...and across a FULL grid, not just the panes this gate happened to poke: every pane
  // the app can show carries the same anchor and the same bar.
  m.layout.apply(8)
  for (let i = 0; i < 60 && (m.panes || []).length < 8; i++) await sleep(200)
  await sleep(1500)
  const all = (m.panes || []).slice(0, 8)
  for (const p of all) {
    await feed(p, 200, 'GRID')
    p.term.scrollToTop()
  }
  await sleep(900)
  const grid = all.map((p) => ({ id: p.id, ok: p.scroll().atBottom && !!q(p, '.pane-slider') }))
  check('J whole grid anchored + barred', grid.length === 8 && grid.every((r) => r.ok), JSON.stringify(grid))

  // --- K · THE KEYBOARD: the same scrollback, without a mouse --------------------------
  // Everything above drives a POINTER. But the slide bar is a pointer scrub by construction and
  // the jump pill is a click, so the keyboard needs its own door — and half of it was missing:
  // xterm answers Shift+PageUp/PageDown itself, but Shift+Home/End are cursor keys to it, so the
  // two ENDS of the history were unreachable AND every press typed ESC[1;2H / ESC[1;2F straight
  // into the agent. The pane owns all four now (terminal-pane.ts handleKey), and they must behave
  // exactly as the wheel does: move the real viewport, detach the anchor, and — for Shift+End —
  // re-attach it. Real KeyboardEvents at the REAL target (xterm's helper textarea, which is where
  // its keydown listener lives), carrying the keyCodes a real key press carries: xterm's key table
  // switches on keyCode, so an event without one would silently exercise nothing.
  const kp = (m.panes || [])[0]
  const KEYS = { PageUp: 33, PageDown: 34, End: 35, Home: 36 }
  const ta = () => q(kp, '.xterm-helper-textarea') || kp.term.textarea
  // term.onData IS the wire to the PTY — terminal-pane.ts pipes it straight to terminalClient.write.
  // Anything landing here is a byte the shell would have seen.
  const sent = []
  const wire = kp.term.onData((d) => { sent.push(d) })
  const key = async (name, shift) => {
    ta().dispatchEvent(new KeyboardEvent('keydown', {
      key: name, code: name, keyCode: KEYS[name], which: KEYS[name],
      shiftKey: !!shift, bubbles: true, cancelable: true
    }))
    await sleep(150)
  }
  await feed(kp, 400, 'KEYS')
  await sleep(400)
  const kBase = kp.scroll()
  check('K starts at the bottom', kBase.atBottom && kBase.baseY > 0, JSON.stringify(kBase))

  await key('PageUp', true)
  const kUp = kp.scroll()
  check('K Shift+PageUp scrolls up', kUp.viewportY < kBase.viewportY && !kUp.atBottom, JSON.stringify(kUp))
  // A page is a screenful minus one line of overlap — xterm's own scrollPages(rows-1), unchanged.
  check('K a page is a screenful', kBase.viewportY - kUp.viewportY === kp.rows() - 1,
    'moved=' + (kBase.viewportY - kUp.viewportY) + ' rows=' + kp.rows())
  await sleep(SETTLE_MS) // the anchor's gesture window closes and it reads where we came to rest
  const kRested = kp.scroll()
  check('K anchor released by the keyboard', !kRested.following && kRested.jumpShown, JSON.stringify(kRested))
  await feed(kp, 120, 'AFTER-KEYS') // ...and the agent's next output must not yank the reader back
  await sleep(400)
  check('K viewport held under output', kp.scroll().viewportY === kUp.viewportY, JSON.stringify(kp.scroll()))

  await key('PageDown', true)
  check('K Shift+PageDown pages back down', kp.scroll().viewportY > kUp.viewportY, JSON.stringify(kp.scroll()))
  await key('Home', true)
  check('K Shift+Home reaches the oldest line', kp.scroll().viewportY === 0, JSON.stringify(kp.scroll()))
  await key('End', true)
  const kEnd = kp.scroll()
  check('K Shift+End returns to the newest', kEnd.atBottom && !kEnd.jumpShown, JSON.stringify(kEnd))
  check('K Shift+End re-arms the anchor', kEnd.following, JSON.stringify(kEnd))
  await feed(kp, 40, 'FOLLOW') // re-armed for REAL: the next output follows on its own
  await sleep(300)
  check('K follows again after Shift+End', kp.scroll().atBottom, JSON.stringify(kp.scroll()))
  wire.dispose()
  // THE NEGATIVE: not one byte of any of that reached the shell. Before the fix, Shift+Home and
  // Shift+End alone would have put ESC[1;2H and ESC[1;2F on this wire.
  check('K no scroll key reached the shell', sent.length === 0, JSON.stringify(sent))
  // ...and the positive control, on the SAME dispatch path: the pane did not simply go deaf.
  const typed = []
  const wire2 = kp.term.onData((d) => { typed.push(d) })
  ta().dispatchEvent(new KeyboardEvent('keydown', {
    key: 'x', code: 'KeyX', keyCode: 88, which: 88, bubbles: true, cancelable: true
  }))
  await sleep(200)
  wire2.dispose()
  check('K ordinary keys still reach the shell', typed.join('') === 'x', JSON.stringify(typed))

  // The rail is DECORATION now that the buffer is keyboard-reachable, and it says so — a
  // pointer-only scrub must not sit in a screen reader's tree announcing a position it cannot act
  // on. The JUMP PILL is the exception and stays announced: it is a real labelled button.
  const decor = ['.pane-slider', '.pane-slider-track', '.pane-slider-thumb'].map((sel) => q(kp, sel)?.getAttribute('aria-hidden'))
  check('K the slide bar is declared decorative', decor.every((v) => v === 'true'), JSON.stringify(decor))
  const pill = q(kp, '.pane-jump')
  check('K the jump pill stays announced', !!pill && !pill.hasAttribute('aria-hidden') && !!pill.getAttribute('aria-label'),
    pill ? pill.className + ' aria-hidden=' + pill.getAttribute('aria-hidden') : 'no pill')

  return { pass: fail.length === 0, failures: fail, diag, cli: jRes, keys: { sent, typed, decor }, panes: panes.map((p) => p.scroll()) }
})()`

export function runPaneScrollSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 210000) // safety net
  const wc = win.webContents
  wc.setBackgroundThrottling(false) // hidden-workspace phases must keep their rAFs

  const errors: string[] = []
  wc.on('console-message', (...args: unknown[]) => {
    const a1 = args[1] as { level?: unknown; message?: unknown } | number | string
    const level = a1 && typeof a1 === 'object' ? a1.level : a1
    const message = a1 && typeof a1 === 'object' ? String(a1.message ?? '') : String(args[2] ?? '')
    if (level === 3 || level === 'error') errors.push('console.error: ' + message)
  })
  wc.on('render-process-gone', (_e, details) => errors.push('render-process-gone: ' + details.reason))

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      result = (await wc.executeJavaScript(SCRIPT, true)) as Record<string, unknown>
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    result.rendererErrors = errors
    if (errors.length) result.pass = false
    try {
      writeFileSync(join(process.cwd(), 'out', 'panescroll-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }
  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(run, 2500))
  else setTimeout(run, 2500)
}
