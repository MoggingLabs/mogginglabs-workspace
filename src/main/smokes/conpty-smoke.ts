import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'

// Env-gated ConPTY-coherence smoke (MOGGING_CONPTY=1): reproduce the resize smear, don't
// just assert the config that prevents it.
//
// THE BUG THIS GUARDS. ConPTY grows a terminal by appending empty rows at the bottom; a unix
// pty pulls scrollback back down. If xterm is not told the pty is ConPTY (Terminal#windowsPty,
// seeded from SpawnResult.pty — daemon protocol v4), it takes the unix path, the two viewports
// drift by the rows they disagreed about, and ConPTY's answer to EVERY resize — a full repaint
// of conhost's screen buffer from ESC[H — lands offset, splicing stale rows into the live
// frame. In the buffer that reads as DUPLICATED or reordered lines.
//
// So the gate types numbered markers into a real shell, drags the window height down and back
// up across row boundaries (grow is the dangerous direction), and then asserts on the pane's
// whole buffer: every marker exactly once, in order. A config regression (windowsPty dropped,
// SpawnResult.pty lost in the protocol, pty-emulation mis-mapped) fails THIS assertion — not a
// mock of it. The config is still reported (wpOk) for diagnosis, but the verdict is behavioral.
//
// Runs on every OS: markers-once-in-order is a universal terminal-correctness invariant, so
// the posix sweeps get a real (if weaker) resize-coherence check for free; wpOk additionally
// requires windowsPty = { backend:'conpty', buildNumber >= 18309 } on win32 — 18309 is the
// support floor pty-host enforces, NOT xterm's 21376 reflow threshold (CI's windows-latest is
// Server 2022 / build 20348, where reflow-off is xterm's correct conservative path).
//
// THE WIDTH PHASE (2026-08-01). Width is gated SEPARATELY because its correctness bar is
// structurally lower, and the gate must say so rather than pretend: ConPTY's internal buffer
// is VIEWPORT-SIZED (scrollback exists only in xterm), so a width shrink that re-wraps long
// lines overflows conhost's own buffer, conhost DISCARDS the overflow, and its answering
// repaint erases those rows in xterm too. Measured on build 26200: a 120-long-marker narrow
// crossing loses a contiguous band of ~27 trailing markers — identically with xterm reflow
// on and off (proven both ways), so no renderer configuration can prevent it; only conhost
// keeping real scrollback would ("blank space in the middle of the pane" as reported). What
// IS ours to guarantee, and what this phase pins: survivors stay ONCE and IN ORDER (no
// splice, no duplication), the loss is AT MOST ONE contiguous band bounded by ~two narrow
// viewports, and no blank rows are left between surviving lines. A regression anywhere in
// our stack (windowsPty, fit, replay) breaks one of those long before it breaks nothing.
const MARKS = 120
const WIDTH_MARKS = 120
/** Loss ceiling for the width crossing: ~2 narrow viewports of wrapped long lines. */
const WIDTH_LOSS_MAX = 60

export function runConptySmoke(win: BrowserWindow): void {
  const errors: string[] = []
  const wc = win.webContents
  let done = false

  wc.setBackgroundThrottling(false) // unfocused/occluded windows throttle timers; measure our code
  wc.on('render-process-gone', (_e, d) => errors.push('render-process-gone: ' + JSON.stringify(d)))
  wc.on('did-fail-load', (_e, code, desc) => errors.push('did-fail-load: ' + code + ' ' + desc))

  const write = (result: object): void => {
    const json = JSON.stringify(result)
    console.log('CONPTY_RESULT ' + json)
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'conpty-result.json'), json)
    } catch {
      /* best-effort */
    }
  }

  const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const ES = (js: string): Promise<unknown> => wc.executeJavaScript(js)
  const send = (d: string): Promise<unknown> =>
    ES('window.bridge.send("terminal:write",{id:1,data:' + JSON.stringify(d) + '});')
  const rows = async (): Promise<number> =>
    Number(
      await ES(
        '(function(){var p=window.__mogging&&window.__mogging.panes&&window.__mogging.panes[0];' +
          'return p?p.rows():-1;})()'
      )
    )

  async function core(): Promise<Record<string, unknown>> {
    await ES(
      '(function(){var m=window.__mogging;' +
        'if(m&&m.workspace&&m.workspace.count()===0){m.workspace.create({name:"Workspace 1"});}' +
        'else if(m&&m.workspace){m.workspace.switchByIndex(0);}return true;})()'
    )
    await delay(2500) // pane 1 spawns; SpawnResult.pty applies windowsPty before first output

    // The config under test, as xterm actually holds it (not as we intended to set it).
    const wp = (await ES(
      '(function(){var p=window.__mogging&&window.__mogging.panes&&window.__mogging.panes[0];' +
        'var w=p&&p.term.options.windowsPty;return w?{backend:w.backend||null,buildNumber:w.buildNumber||0}:null;})()'
    )) as { backend: string | null; buildNumber: number } | null
    const wpOk =
      process.platform === 'win32'
        ? wp?.backend === 'conpty' && (wp?.buildNumber ?? 0) >= 18309
        : !wp?.backend // posix panes must NOT claim a Windows pty

    // Numbered markers through the real shell. `@echo` suppresses per-line command echo on
    // cmd; the one typed line contains only "CMARK_%i" / "CMARK_$i" (no digits), so counting
    // /CMARK_(\d+)/ can never match the command itself.
    const isWin = process.platform === 'win32'
    await send(
      isWin
        ? `for /L %i in (1,1,${MARKS}) do @echo CMARK_%i\r`
        : `for i in $(seq 1 ${MARKS}); do echo CMARK_$i; done\r`
    )
    await delay(2500)

    // The resize dance. Height only (width reflow is a separate xterm path — one variable at a
    // time), settle > REFIT_SETTLE_MS (120) + ConPTY's repaint each step. GROW is where the two
    // growth rules diverge, so end on two grows.
    const r0 = await rows()
    win.setSize(1000, 420)
    await delay(900)
    const r1 = await rows()
    win.setSize(1000, 640)
    await delay(900)
    win.setSize(1000, 780)
    await delay(1200)
    const r2 = await rows()
    const rowsChanged = r0 > 0 && r1 > 0 && r1 < r0 && r2 > r1 // shrank, then grew — or the test proved nothing

    // The verdict: the pane's ENTIRE buffer (scrollback + viewport), marker census.
    const text = String(
      await ES(
        '(function(){var p=window.__mogging&&window.__mogging.panes&&window.__mogging.panes[0];' +
          'if(!p)return "";p.term.selectAll();var s=p.term.getSelection();p.term.clearSelection();return s;})()'
      )
    )
    const seen = new Map<number, number>()
    const order: number[] = []
    for (const m of text.matchAll(/CMARK_(\d+)/g)) {
      const n = Number(m[1])
      seen.set(n, (seen.get(n) ?? 0) + 1)
      order.push(n)
    }
    const missing: number[] = []
    const dupes: number[] = []
    for (let i = 1; i <= MARKS; i++) {
      const c = seen.get(i) ?? 0
      if (c === 0) missing.push(i)
      if (c > 1) dupes.push(i)
    }
    let ordered = true
    for (let i = 1; i < order.length; i++) if (order[i] <= order[i - 1]) ordered = false

    const marksOnce = missing.length === 0 && dupes.length === 0

    // ── WIDTH PHASE (see the header) ─────────────────────────────────────────────
    // Long markers that WRAP at narrow width; then wide -> narrow -> wide. The census
    // asserts the bounded-band contract, not marks-once — ConPTY erases a viewport's
    // worth at the crossing by design (its buffer IS the viewport).
    const PAD = '-'.repeat(70)
    await send(
      isWin
        ? `for /L %i in (1,1,${WIDTH_MARKS}) do @echo WMARK_%i_${PAD}END\r`
        : `for i in $(seq 1 ${WIDTH_MARKS}); do echo WMARK_\${i}_${PAD}END; done\r`
    )
    await delay(2500)
    win.setSize(460, 780)
    await delay(1200)
    win.setSize(1000, 780)
    await delay(1500)
    const wtext = String(
      await ES(
        '(function(){var p=window.__mogging&&window.__mogging.panes&&window.__mogging.panes[0];' +
          'if(!p)return "";p.term.selectAll();var s=p.term.getSelection();p.term.clearSelection();return s;})()'
      )
    )
    const wseen = new Map<number, number>()
    const worder: number[] = []
    for (const m of wtext.matchAll(/WMARK_(\d+)_/g)) {
      const n = Number(m[1])
      wseen.set(n, (wseen.get(n) ?? 0) + 1)
      worder.push(n)
    }
    const wmissing: number[] = []
    const wdupes: number[] = []
    for (let i = 1; i <= WIDTH_MARKS; i++) {
      const c = wseen.get(i) ?? 0
      if (c === 0) wmissing.push(i)
      if (c > 1) wdupes.push(i)
    }
    let wordered = true
    for (let i = 1; i < worder.length; i++) if (worder[i] <= worder[i - 1]) wordered = false
    // One contiguous band at most: erased content is a single viewport region, never
    // interleaved holes (holes = a splice, which IS our bug to catch).
    let contiguous = true
    for (let i = 1; i < wmissing.length; i++) if (wmissing[i] !== wmissing[i - 1] + 1) contiguous = false
    // No blank rows left BETWEEN surviving lines — the reported artifact shape.
    const wlines = wtext.split('\n')
    const wmarkIdx: number[] = []
    for (let i = 0; i < wlines.length; i++) if (/WMARK_\d+_/.test(wlines[i])) wmarkIdx.push(i)
    let maxBlankRun = 0
    if (wmarkIdx.length > 1) {
      let run = 0
      for (let i = wmarkIdx[0]; i <= wmarkIdx[wmarkIdx.length - 1]; i++) {
        if (wlines[i].trim() === '') run++
        else {
          if (run > maxBlankRun) maxBlankRun = run
          run = 0
        }
      }
    }
    const widthOk =
      wdupes.length === 0 && wordered && contiguous && wmissing.length <= WIDTH_LOSS_MAX && maxBlankRun <= 2

    const pass = wpOk && rowsChanged && marksOnce && ordered && widthOk && errors.length === 0
    return {
      pass,
      wpOk,
      wp,
      rowsChanged,
      rows: { before: r0, shrunk: r1, grown: r2 },
      marksOnce,
      ordered,
      found: order.length,
      missing: missing.slice(0, 10),
      dupes: dupes.slice(0, 10),
      width: {
        ok: widthOk,
        found: worder.length,
        lost: wmissing.length,
        contiguous,
        ordered: wordered,
        dupes: wdupes.slice(0, 10),
        maxBlankRun
      },
      errors
    }
  }

  const finish = (extra?: string): void => {
    if (done) return
    done = true
    if (extra) errors.push(extra)
    void (async () => {
      try {
        const result = await core()
        write(result)
        app.exit(result.pass === true ? 0 : 1)
      } catch (e) {
        write({ pass: false, errors: [...errors, 'conpty smoke exception: ' + String(e)] })
        app.exit(1)
      }
    })()
  }

  wc.once('did-finish-load', () => setTimeout(() => finish(), 2000))
  setTimeout(() => finish('TIMEOUT: did-finish-load never fired within 40s'), 40000)
}
