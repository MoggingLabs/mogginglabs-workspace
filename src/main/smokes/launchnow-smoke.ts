import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'

// LAUNCHNOW gate (MOGGING_LAUNCHNOW): the instant-launch contract, both halves.
//
// Part 1 (2026-07) removed the fixed 900ms lineup delay; part 2 moved fresh-lineup
// delivery into the SPAWN itself (SpawnRequest.run → the daemon types the command as
// the shell's first act — no idle-prompt window, no renderer-typed line to watch land).
// The assertions pin the MECHANISM, not wall-clock totals:
//
//   A. spawn-run CLI delivery: a template's claude slot runs its launch command with
//      ZERO renderer terminal:write of it (the ptyWrites spy proves the negative — the
//      buffer cannot: the echo looks identical either way), the command is IN the pane
//      (the backend really typed it), bookkeeping still lands (lastLaunch + session —
//      identity must not depend on who typed), and the shell slot stays clean.
//   B. spawn-run custom delivery: the wizard custom row rides the same seam — its
//      marker OUTPUT appears with zero renderer writes into the pane.
//   C. the typed FALLBACK bites: with the build stretched past the pane's claim window
//      (the setSpawnRunHold dev seam), the command is typed exactly ONCE, only after
//      the pane's first output (write.at >= paneLiveAt) — i.e. the pre-spawn-run path
//      is intact, ordered, and never double-delivers.
//
// A reintroduced fixed delay, a lost fallback, a double delivery, or bookkeeping that
// only the typed path performs — each fails exactly one named flag here.
// Writes out/launchnow-result.json, then exits (0=pass, 1=fail).

const CLAUDE_PANE = 102 // 2nd workspace (ordinal 1) -> base 100; mix [shell, claude] -> slot 2
const SHELL_PANE = 101
const CUSTOM_PANE = 201 // 3rd workspace (ordinal 2), single custom slot
const FALLBACK_PANE = 301 // 4th workspace (ordinal 3), single claude slot, build held
const CUSTOM_MARK = 'LAUNCHNOW_SPAWNRUN_31337'

export function runLaunchNowSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 150000) // safety net
  const wc = win.webContents
  let done = false
  const ES = (js: string): Promise<unknown> => wc.executeJavaScript(js)
  const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const emit = (o: object): void => {
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'launchnow-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }

  interface SpyWrite {
    id: number
    data: string
    at: number
  }

  // Launch-shaped: a cd/Set-Location prefix naming the CLI — the exact line a launch types.
  const launchWritesOf = (paneId: number, needle: string): string =>
    `(function(){var ws=(window.__mogging.ptyWrites||[]).filter(function(w){` +
    `return w.id===${paneId}&&/^(cd|chdir|Set-Location)\\b/i.test(String(w.data))&&String(w.data).indexOf(${JSON.stringify(needle)})>=0});` +
    `return JSON.stringify(ws);})()`
  // NOT "any write": xterm's terminal auto-replies (CPR/DA answers) ride terminal:write
  // and land in the spy too — the negative is "the LAUNCH LINE was never typed".
  const markWritesOf = (paneId: number, mark: string): string =>
    `JSON.stringify((window.__mogging.ptyWrites||[]).filter(function(w){` +
    `return w.id===${paneId}&&String(w.data).indexOf(${JSON.stringify(mark)})>=0}))`
  const paneText = (paneId: number): string =>
    `(function(){var ps=(window.__mogging&&window.__mogging.panes)||[];var p=ps.find(function(x){return x.id===${paneId}});return p?p.text():'';})()`

  const run = async (): Promise<void> => {
    if (done) return
    done = true
    try {
      await delay(500)
      // Launcher-first boot: base workspace first so the template ones start at ordinal 1.
      await ES(
        '(function(){var m=window.__mogging;' +
          'if(m&&m.workspace&&m.workspace.count()===0)m.workspace.create({name:"Workspace 1"});return 1;})()'
      )
      await delay(600)
      // Both spies BEFORE any open — every launch byte and build call is caught.
      await ES('(function(){window.__mogging.ptyWrites=[];window.__mogging.agentCommandCalls=[];return 1;})()')

      // ── A: spawn-run CLI delivery ──────────────────────────────────────────────
      await ES("window.__mogging.templates.open([{provider:'shell',count:1},{provider:'claude',count:1}])")
      // Settled = bookkeeping landed (session written) AND the command echoed in the pane.
      let aText = ''
      let aSession: { provider?: string } | null = null
      for (let i = 0; i < 80; i++) {
        await delay(250)
        aText = String(await ES(paneText(CLAUDE_PANE)))
        aSession = (await ES(`window.__mogging.agents.session(${CLAUDE_PANE})`)) as { provider?: string } | null
        if (/claude/.test(aText) && aSession) break
      }
      await delay(1000) // settle window: a late (wrong) typed duplicate would land here
      const aTypedWrites = JSON.parse(String(await ES(launchWritesOf(CLAUDE_PANE, 'claude')))) as SpyWrite[]
      const aShellWrites = JSON.parse(String(await ES(launchWritesOf(SHELL_PANE, 'claude')))) as SpyWrite[]
      const aLast = (await ES(`window.__mogging.agents.lastLaunch(${CLAUDE_PANE})`)) as { provider?: string }
      const spawnRunDelivered = /claude/.test(aText) && aTypedWrites.length === 0
      const spawnRunBookkept = aLast?.provider === 'claude' && aSession?.provider === 'claude'
      const shellPaneClean = aShellWrites.length === 0

      // ── B: spawn-run custom delivery ───────────────────────────────────────────
      await ES(`window.__mogging.templates.open([{provider:'custom:echo ${CUSTOM_MARK}',count:1}])`)
      let bText = ''
      for (let i = 0; i < 60; i++) {
        await delay(250)
        bText = String(await ES(paneText(CUSTOM_PANE)))
        if (bText.indexOf(CUSTOM_MARK) >= 0) break
      }
      await delay(500)
      const bWrites = JSON.parse(String(await ES(markWritesOf(CUSTOM_PANE, CUSTOM_MARK)))) as SpyWrite[]
      const customDelivered = bText.indexOf(CUSTOM_MARK) >= 0 && bWrites.length === 0

      // ── C: the typed fallback bites ────────────────────────────────────────────
      await ES('window.__mogging.agents.setSpawnRunHold(6000)')
      await ES("window.__mogging.templates.open([{provider:'claude',count:1}])")
      let cWrites: SpyWrite[] = []
      for (let i = 0; i < 100 && cWrites.length === 0; i++) {
        await delay(250)
        cWrites = JSON.parse(String(await ES(launchWritesOf(FALLBACK_PANE, 'claude')))) as SpyWrite[]
      }
      await delay(1500) // settle: a double delivery would add a second write here
      cWrites = JSON.parse(String(await ES(launchWritesOf(FALLBACK_PANE, 'claude')))) as SpyWrite[]
      const cLiveAt = (await ES(`window.__mogging.agents.paneLiveAt(${FALLBACK_PANE})`)) as number | null
      const cLast = (await ES(`window.__mogging.agents.lastLaunch(${FALLBACK_PANE})`)) as { provider?: string }
      await ES('window.__mogging.agents.setSpawnRunHold(0)')
      const fallbackTypedOnce = cWrites.length === 1
      const fallbackOrdered = fallbackTypedOnce && cLiveAt !== null && cWrites[0].at >= cLiveAt
      const fallbackBookkept = cLast?.provider === 'claude'

      const pass =
        spawnRunDelivered &&
        spawnRunBookkept &&
        shellPaneClean &&
        customDelivered &&
        fallbackTypedOnce &&
        fallbackOrdered &&
        fallbackBookkept
      emit({
        pass,
        spawnRunDelivered,
        spawnRunBookkept,
        shellPaneClean,
        customDelivered,
        fallbackTypedOnce,
        fallbackOrdered,
        fallbackBookkept,
        aTypedWriteCount: aTypedWrites.length,
        aLast,
        aSession,
        aTail: pass ? undefined : aText.slice(-400),
        bWriteCount: bWrites.length,
        bTail: pass ? undefined : bText.slice(-400),
        cWriteCount: cWrites.length,
        cLiveAt,
        cWriteAt: cWrites[0]?.at ?? null,
        cLast
      })
      app.exit(pass ? 0 : 1)
    } catch (e) {
      emit({ pass: false, error: String(e) })
      app.exit(1)
    }
  }

  wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
}
