import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// PANERESTART gate: a dead pane is a STATE with a way back, not a dead end. The live
// incident (2026-07-23): two agent panes' processes died, each pane froze behind a bare
// gray "[process exited]" — no exit code, no recovery, and every keystroke silently
// swallowed by a PTY that no longer existed. The fix is one seam (terminal-pane.ts):
//
//   verdict  → the epitaph names the exit code ("[process exited (code N)]") — a crash,
//              a clean exit and a kill are distinguishable from the pane itself
//   banner   → an in-pane affordance (.pane-dead-banner) says the pane is dead where the
//              user is looking and offers Restart
//   gate     → keystrokes into a dead pane are GATED at term.onData, never forwarded to
//              a daemon that has no session for the id (the "frozen" feel)
//   restart  → the banner's button respawns the SAME id in place through the one spawn
//              door (spawnPty → the daemon's ensure(), the reconnect-replay road), with
//              prior scrollback kept above the fresh prompt
//
// The input gate is proven honestly: the ptyWrites spy first sees a LIVE keystroke reach
// the wire (the spy works), then sees a DEAD one reach nothing (the gate works) — both
// driven through xterm's own input path (term.input → onData), the road real typing takes.
// Real PTY death (`exit` typed into the shell), real respawn, zero fixtures, zero network.
// Writes out/panerestart-result.json, then exits (0=pass, 1=fail).
export function runPaneRestartSmoke(win: BrowserWindow): void {
  const resultPath = join(process.cwd(), 'out', 'panerestart-result.json')
  // The watchdog WRITES its verdict: a red that times out with no result file is
  // indistinguishable from an environment death — and undiagnosable after the fact.
  const watchdog = setTimeout(() => {
    try {
      writeFileSync(resultPath, JSON.stringify({ pass: false, timeout: true }, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(1)
  }, 150000)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  /** Poll until `js` (a renderer expression returning boolean) holds. Budgets are per
   *  stage and deliberately SHORT after the first (a green stage settles in ~1s; only a
   *  red burns its budget) so a fully red run still finishes inside the watchdog and
   *  writes a diagnosable per-stage result. */
  const until = async (js: string, tries = 40, gapMs = 250): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      if (await ES<boolean>(js)) return true
      await sleep(gapMs)
    }
    return false
  }

  const pane = (paneId: number): string => `(window.__mogging.panes || []).find(p => p.id === ${paneId})`
  /** De-wrapped buffer text: ConPTY reflow wraps output at the pane's live width, which
   *  splits any needle across rows (the BRAINMILESTONE capture trap) — every buffer
   *  assert joins rows before matching. */
  const joined = (paneId: number): string => `${pane(paneId)}.text().split('\\n').join('')`

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      await sleep(1500)
      await ES(`window.__mogging.workspace.create({ name: 'PaneRestart', cwd: ${JSON.stringify(process.cwd())} })`)
      await sleep(900)
      const active = (await ES(`window.__mogging.workspace.active()`)) as { ordinal: number }
      const paneId = active.ordinal * 100 + 1

      // ── live: the shell is up and the spy sees a real keystroke reach the wire ─────
      // The one generous budget (spawn can be slow on CI) — and an early bail: a pane
      // that never lived is an environment death, not a verdict on the restart seam.
      const paneWasLive = await until(`!!window.__mogging.agents.paneLive(${paneId})`, 60, 500)
      if (!paneWasLive) throw new Error('pane never came live — environment, not the seam')
      await ES(`(() => { window.__mogging.ptyWrites = []; return 1 })()`)
      await ES(`(() => { ${pane(paneId)}.term.input('live-probe'); return 1 })()`)
      const spySawLive = await until(
        `window.__mogging.ptyWrites.some(w => w.id === ${paneId} && String(w.data).includes('live-probe'))`,
        20, 250
      )
      // Clear the typed probe so it never executes; the shell just sees an empty line.
      await ES(`(() => { ${pane(paneId)}.term.input('\\u0003'); return 1 })()`)

      // ── death: real PTY exit; the epitaph must NAME the code, the banner must offer
      //    Restart, and the pane must hold the dead fact itself ────────────────────────
      await ES(`(() => { ${pane(paneId)}.write('exit\\r'); return 1 })()`)
      const exitCodeShown = await until(
        `(() => { const p = ${pane(paneId)}; return !!p && /\\[process exited \\(code \\d+\\)\\]/.test(${joined(paneId)}) })()`
      )
      const deadFact = await until(`(() => { const p = ${pane(paneId)}; return !!p && p.dead() })()`)
      const bannerShown = await until(
        `(() => { const b = document.querySelector('.layout-slot[data-pane-id="${paneId}"] .pane-dead-banner'); ` +
        `return !!b && !!b.querySelector('.pane-dead-restart') })()`
      )

      // Seed REAL scrollback depth before the restart: the fresh shell's first ConPTY
      // frame repaints the SCREEN (that is what a booting shell does), so only content
      // that has scrolled past the viewport can prove "restart keeps history". 120 lines
      // exceed any pane height; the early ones land in true scrollback.
      await ES(
        `(() => { const p = ${pane(paneId)}; let s = ''; ` +
        `for (let i = 1; i <= 120; i++) s += 'fill-' + i + '-end\\r\\n'; ` +
        `p.term.write(s); return 1 })()`
      )
      const fillPainted = await until(`${joined(paneId)}.includes('fill-120-end')`, 20, 250)

      // ── gate: a keystroke into the dead pane must never reach the wire ─────────────
      await ES(`(() => { window.__mogging.ptyWrites = []; ${pane(paneId)}.term.input('ghost\\r'); return 1 })()`)
      await sleep(700)
      const deadInputGated =
        (await ES<number>(`window.__mogging.ptyWrites.filter(w => w.id === ${paneId}).length`)) === 0

      // ── restart: the banner's button respawns the same id in place ─────────────────
      await ES(
        `(() => { document.querySelector('.layout-slot[data-pane-id="${paneId}"] .pane-dead-restart').click(); return 1 })()`
      )
      const aliveAgain = await until(`(() => { const p = ${pane(paneId)}; return !!p && !p.dead() })()`)
      const bannerGone = await until(
        `!document.querySelector('.layout-slot[data-pane-id="${paneId}"] .pane-dead-banner')`
      )
      // The reopened gate + a real respawn: the SAME user input path now reaches a real
      // shell, which echoes the marker back. Retries, not one shot: the fresh PTY boots.
      let respawnedShell = false
      for (let i = 0; i < 6 && !respawnedShell; i++) {
        await ES(`(() => { ${pane(paneId)}.term.input('echo resurrect-${paneId}\\r'); return 1 })()`)
        respawnedShell = await until(
          `(() => { const t = ${joined(paneId)}; ` +
          `return t.split('resurrect-${paneId}').length > 2 })()`, // typed once + echoed back ≥ once
          10, 500
        )
      }
      // In place, not wiped: the prior life's history is still in SCROLLBACK above. Three
      // needles from different depths — the live-probe keystroke, the epitaph's head, and
      // the seeded fill's first line. Deliberately NOT the viewport's last rows: the fresh
      // shell's boot frame repaints the screen area (that is a shell booting, not a wipe),
      // and the exit code was asserted while the pane sat dead — when it matters.
      const scrollbackKept = await ES<boolean>(
        `(() => { const t = ${joined(paneId)}; ` +
        `return t.includes('live-probe') && t.includes('[process exit') && t.includes('fill-1-end') })()`
      )
      const scrollbackTail = await ES<string>(`(() => { const p = ${pane(paneId)}; return p ? p.text().replace(/\\n+/g, '\\n').slice(-1500) : '' })()`)
      await ES(`(() => { delete window.__mogging.ptyWrites; return 1 })()`)

      const pass =
        paneWasLive && spySawLive &&
        exitCodeShown && deadFact && bannerShown && fillPainted &&
        deadInputGated &&
        aliveAgain && bannerGone && respawnedShell && scrollbackKept
      result = {
        pass, paneWasLive, spySawLive, exitCodeShown, deadFact, bannerShown, fillPainted,
        deadInputGated, aliveAgain, bannerGone, respawnedShell, scrollbackKept,
        scrollbackTail
      }
    } catch (error) {
      result = { pass: false, error: String(error) }
    }
    clearTimeout(watchdog)
    try {
      writeFileSync(resultPath, JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(run, 1200))
  else setTimeout(run, 1200)
}
