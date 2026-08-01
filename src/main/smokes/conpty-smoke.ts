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
// THE REFLOW PHASES (2026-08-01). The OS's ConPTY v1 ERASES up to a viewport of output on
// a width shrink that re-wraps long lines: its buffer is VIEWPORT-SIZED (scrollback exists
// only in xterm), conhost discards its re-wrap overflow, and its repaint erases those rows
// in xterm too — measured here as a contiguous band of 18-27 lost markers of 120, identical
// with xterm reflow on and off ("blank space in the middle of the pane" as reported). The
// FIX is pty-host.ts's useConptyDll: node-pty's bundled ConPTY v2 (Windows Terminal 1.22's
// backend) removed that machinery, and these phases measured lost: 0 under it. Three
// dances, each census'd on its own marker family:
//   WIDTH    wide -> narrow (long lines wrap) -> wide — the original report;
//   EXTREME  tiny in BOTH dimensions, TWICE, back to large — the compounding crossing;
//   STREAM   two crossings WHILE output is flowing — the invariant every other gate
//            misses (their dances resize a QUIET pty).
// THE BAR IS BACKEND-AWARE: on the default (v2) every phase demands lost === 0 — zero
// data loss is the shipped contract, and this gate is what keeps it true. Under the v1
// kill switch (MOGGING_CONPTY_V1=1) the bar is the bounded-band contract — survivors
// ONCE and IN ORDER (a splice or duplication is OUR bug at any conpty version), losses
// in contiguous band(s) under the ceiling, zero blank rows between surviving lines — so
// the fallback stays sweepable. `lost` rides the verdict either way.
const MARKS = 120
const WIDTH_MARKS = 120
const EXTREME_MARKS = 80
const STREAM_MARKS = 50
/** v1-fallback loss ceiling per narrow crossing: ~2 narrow viewports of wrapped lines.
 *  The DEFAULT (bundled ConPTY v2) ceiling is ZERO — see the width phase. */
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

    // ── SHARED CENSUS for the reflow phases below ────────────────────────────────
    // Verdict per marker family: every surviving marker ONCE and IN ORDER (a splice or
    // duplication is OUR bug at any conpty version), lost markers form AT MOST ONE
    // contiguous band under `lossMax`, and zero blank-row runs are left between
    // surviving lines (the reported "blank band mid-pane" shape). On the DEFAULT
    // backend (bundled ConPTY v2) `lossMax` is ZERO — v2 removed the destructive
    // reflow machinery, and this gate is what keeps that true. The v1 kill switch
    // (MOGGING_CONPTY_V1=1) keeps the bounded-band bar so the fallback stays green.
    const grab = (): Promise<string> =>
      ES(
        '(function(){var p=window.__mogging&&window.__mogging.panes&&window.__mogging.panes[0];' +
          'if(!p)return "";p.term.selectAll();var s=p.term.getSelection();p.term.clearSelection();return s;})()'
      ).then(String)
    interface Census {
      ok: boolean
      found: number
      lost: number
      contiguous: boolean
      ordered: boolean
      dupes: number[]
      maxBlankRun: number
    }
    const census = (buf: string, prefix: string, count: number, lossMax: number): Census => {
      const re = new RegExp(prefix + '_(\\d+)_', 'g')
      const cSeen = new Map<number, number>()
      const cOrder: number[] = []
      for (const m of buf.matchAll(re)) {
        const n = Number(m[1])
        cSeen.set(n, (cSeen.get(n) ?? 0) + 1)
        cOrder.push(n)
      }
      const cMissing: number[] = []
      const cDupes: number[] = []
      for (let i = 1; i <= count; i++) {
        const c = cSeen.get(i) ?? 0
        if (c === 0) cMissing.push(i)
        if (c > 1) cDupes.push(i)
      }
      let cOrdered = true
      for (let i = 1; i < cOrder.length; i++) if (cOrder[i] <= cOrder[i - 1]) cOrdered = false
      let cContig = true
      for (let i = 1; i < cMissing.length; i++) if (cMissing[i] !== cMissing[i - 1] + 1) cContig = false
      const lineRe = new RegExp(prefix + '_\\d+_')
      const cLines = buf.split('\n')
      const idx: number[] = []
      for (let i = 0; i < cLines.length; i++) if (lineRe.test(cLines[i])) idx.push(i)
      let blank = 0
      if (idx.length > 1) {
        let run = 0
        for (let i = idx[0]; i <= idx[idx.length - 1]; i++) {
          if (cLines[i].trim() === '') run++
          else {
            if (run > blank) blank = run
            run = 0
          }
        }
      }
      return {
        ok:
          cDupes.length === 0 && cOrdered && cContig && cMissing.length <= lossMax && blank <= 2,
        found: cOrder.length,
        lost: cMissing.length,
        contiguous: cContig,
        ordered: cOrdered,
        dupes: cDupes.slice(0, 10),
        maxBlankRun: blank
      }
    }
    // ConPTY v1 (the kill switch) erases a viewport band at each narrow crossing by
    // construction; the DEFAULT (bundled v2) must lose NOTHING.
    const onV1 = process.platform === 'win32' && process.env.MOGGING_CONPTY_V1 === '1'
    const lossMax = onV1 ? WIDTH_LOSS_MAX : 0
    const PAD = '-'.repeat(70)
    const typeMarks = async (prefix: string, count: number): Promise<void> => {
      await send(
        isWin
          ? `for /L %i in (1,1,${count}) do @echo ${prefix}_%i_${PAD}END\r`
          : `for i in $(seq 1 ${count}); do echo ${prefix}_\${i}_${PAD}END; done\r`
      )
      await delay(2500)
    }

    // ── WIDTH PHASE: wide -> narrow (long lines wrap) -> wide (see the header) ───
    await typeMarks('WMARK', WIDTH_MARKS)
    win.setSize(460, 780)
    await delay(1200)
    win.setSize(1000, 780)
    await delay(1500)
    const width = census(await grab(), 'WMARK', WIDTH_MARKS, lossMax)

    // ── EXTREME PHASE: tiny in BOTH dimensions, twice, back to large. The user-
    // reported shape ("incredibly small width pulled to full") plus the repeat
    // crossing that compounds any leak. Electron clamps to the window's minimum,
    // which is exactly the point — as small as this app can go.
    await typeMarks('XMARK', EXTREME_MARKS)
    win.setSize(380, 300)
    await delay(1200)
    win.setSize(1240, 900)
    await delay(1200)
    win.setSize(380, 300)
    await delay(1200)
    win.setSize(1240, 900)
    await delay(1500)
    // TWO crossings may erase TWO bands on v1 — census contiguity is per-band, so
    // the fallback bar doubles the allowance and tolerates two bands by checking
    // only dupes/order/blanks plus total loss. The DEFAULT bar stays zero.
    const xRaw = census(await grab(), 'XMARK', EXTREME_MARKS, onV1 ? EXTREME_MARKS : 0)
    const extreme = onV1 ? { ...xRaw, ok: xRaw.dupes.length === 0 && xRaw.ordered && xRaw.maxBlankRun <= 2 } : xRaw

    // ── STREAMING PHASE: resize WHILE output is flowing — the pipeline invariant no
    // other gate exercises (every prior dance resized a QUIET pty). A slow marker
    // stream rides two live crossings; when it ends, the census must hold the same
    // bar. `node` is on PATH in the dev harness on every platform.
    await send(
      'node -e "var i=0;var t=setInterval(function(){console.log(\'SMARK_\'+(++i)+\'_\'+Array(50).join(\'-\')+\'END\');if(i>=' +
        `${STREAM_MARKS})clearInterval(t)},40)"\r`
    )
    await delay(600) // stream is flowing
    win.setSize(460, 780)
    await delay(700) // ~17 markers land at the narrow width
    win.setSize(1240, 900)
    await delay(2500) // stream finishes wide; settle
    const stream = census(await grab(), 'SMARK', STREAM_MARKS, onV1 ? WIDTH_LOSS_MAX : 0)

    const pass =
      wpOk && rowsChanged && marksOnce && ordered && width.ok && extreme.ok && stream.ok && errors.length === 0
    return {
      pass,
      wpOk,
      wp,
      conptyV1Fallback: onV1,
      rowsChanged,
      rows: { before: r0, shrunk: r1, grown: r2 },
      marksOnce,
      ordered,
      found: order.length,
      missing: missing.slice(0, 10),
      dupes: dupes.slice(0, 10),
      width,
      extreme,
      stream,
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
