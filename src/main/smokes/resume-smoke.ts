import { app, type BrowserWindow } from 'electron'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  lastSessionSnapshotForSmoke,
  resumeIntentsForSmoke,
  setPaneSessionLogOverrideForSmoke
} from '../session-restore'
import { appSettingsDebug } from '../app-settings'

// Env-gated last-session RESUME smoke (MOGGING_RESUME). Fresh userData, real daemon.
// The whole "Restore last working session" promise end to end, through the SHIPPED
// pipeline only — the one seam fakes the context monitor's session-log lock (a real
// lock needs a live CLI writing transcripts), everything else is the product:
//   (1) MIRROR       a non-empty workspace:saveState lands in the snapshot; a fresh
//                    working set REPLACES the previous one (browser semantics);
//   (2) ENRICH       the slot whose pane holds a locked claude session log records
//                    provider + file + the uuid-shaped resume id, via the REAL
//                    noteWorkspaceSave path;
//   (3) SHRINK-HOLD  the teardown (shrinking saves, then the empty one) leaves the
//                    snapshot untouched — the last working SESSION survives its own close;
//   (4) OFFER        Home's card renders the held session from the real channel;
//   (5) CUSTODY      workspace:restoreSession's payload carries NO session-log path —
//                    those stay main-side, armed as intents (ADR 0002 / context.ts rule);
//   (6) RESTORE      clicking the card rebuilds BOTH workspaces with their identity
//                    (ids, cwds, counts) and reveals the grid;
//   (7) EXACT RESUME the relaunched claude pane is TYPED `claude --resume <THE uuid>` —
//                    observed in the pane's own PTY echo — and the armed intent is
//                    consumed (empty map afterwards; consume-once).
// Writes out/resume-result.json, then exits (0=pass, 1=fail).

const UUID_A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

const stripAnsi = (s: string): string =>
  s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[=>]/g, '')

export function runResumeSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 200000) // safety net
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const waitTrue = async (js: string, tries = 30, gap = 200): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      if (await ES<boolean>(js).catch(() => false)) return true
      await sleep(gap)
    }
    return false
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      await sleep(2000)

      // Fresh userData: nothing to restore, and Home says so calmly.
      const noSnapshot = (await ES(`window.bridge.invoke('workspace:lastSession')`)) === null
      const emptyOffered = await waitTrue(`!!document.querySelector('.home-resume .empty-state')`)

      // The boot restore() always fires ONE debounced save (empty, on a fresh profile).
      // Wait it out so it can never interleave the sequence below: a background empty
      // save landing between the two shrink saves would make the next one read as
      // growth and re-mirror — a harness flake wearing a product bug's face.
      for (let i = 0; i < 40 && appSettingsDebug().saves < 1; i++) await sleep(250)
      await sleep(700) // a second queued debounce collapses into the save we just saw

      // The one seam: pane 101 (workspace ordinal 1, slot 1) "has" a locked claude
      // session log. The file's NAME is the identity — it never needs to exist.
      const sessionFile = join(tmpdir(), 'mog-resume-home', 'projects', 'x', `${UUID_A}.jsonl`)
      setPaneSessionLogOverrideForSmoke(101, { provider: 'claude', file: sessionFile })

      const cwdA = mkdtempSync(join(tmpdir(), 'mog-resume-a-'))
      const cwdB = mkdtempSync(join(tmpdir(), 'mog-resume-b-'))
      const save = (workspaces: unknown[], activeId: string | null): Promise<unknown> =>
        ES(
          `window.bridge.invoke('workspace:saveState', ${JSON.stringify({
            workspaces,
            activeId,
            theme: 'midnight'
          })})`
        )
      const wsA = {
        id: 'resume-a',
        name: 'Alpha',
        color: '#4cc38a',
        cwd: cwdA,
        ordinal: 1,
        paneCount: 2,
        assignments: ['claude', 'shell']
      }
      const wsB = { id: 'resume-b', name: 'Bravo', color: '#3b9eff', cwd: cwdB, ordinal: 2, paneCount: 1 }
      const wsC = { id: 'resume-c', name: 'Casual', color: '#b98aff', cwd: cwdB, ordinal: 3, paneCount: 1 }

      // (1) MIRROR + browser semantics: a session of one replaces nothing; the real
      // working set that follows REPLACES the quick one (0→1 growth, then 1→2 growth).
      await save([wsC], 'resume-c')
      const snapAfterQuick = lastSessionSnapshotForSmoke()
      const quickMirrored = snapAfterQuick?.workspaces.length === 1 && snapAfterQuick.workspaces[0]?.id === 'resume-c'

      await save([wsA, wsB], 'resume-a')
      const snapWorking = lastSessionSnapshotForSmoke()
      const workingMirrored =
        snapWorking?.workspaces.length === 2 &&
        snapWorking.workspaces[0]?.id === 'resume-a' &&
        snapWorking.workspaces[1]?.id === 'resume-b' &&
        (snapWorking.savedAt ?? 0) > 0 &&
        snapWorking.activeId === 'resume-a'

      // (2) ENRICH — through the real save path: slot 1 carries the locked log + the
      // uuid its NAME encodes; the shell slot records nothing; Bravo records nothing.
      const paneSessions = snapWorking?.workspaces[0]?.paneSessions
      const enriched =
        paneSessions?.[0]?.provider === 'claude' &&
        paneSessions?.[0]?.file === sessionFile &&
        paneSessions?.[0]?.sessionId === UUID_A &&
        paneSessions?.[1] == null &&
        snapWorking?.workspaces[1]?.paneSessions === undefined

      // (3) SHRINK-HOLD: the teardown — close Alpha (2→1), then close Bravo (1→0).
      // Neither save may touch the snapshot: the last working SESSION is both of them.
      await save([wsB], 'resume-b')
      const heldThroughShrink = lastSessionSnapshotForSmoke()?.workspaces.length === 2
      await save([], null)
      const heldThroughEmpty = lastSessionSnapshotForSmoke()?.workspaces.length === 2

      // (4) OFFER — Home renders the HELD session, not the store's (empty) truth.
      await ES(`window.__mogging.home.refresh()`)
      const cardOffered = await waitTrue(
        `(() => {
          const card = document.querySelector('.home-resume-card')
          if (!card) return false
          const names = [...card.querySelectorAll('.home-resume-name')].map((n) => n.textContent)
          const totals = card.querySelector('.home-resume-totals')?.textContent || ''
          return names.includes('Alpha') && names.includes('Bravo') && /2 workspaces/.test(totals) && /3 terminals/.test(totals)
        })()`
      )

      // (5) CUSTODY — the restore payload names workspaces, never session-log files.
      // (This invoke also arms intents; the card click below re-arms them fresh.)
      const custodyOk = await ES<boolean>(`(async () => {
        const info = await window.bridge.invoke('workspace:restoreSession')
        if (!info || !info.workspaces || info.workspaces.length !== 2) return false
        const raw = JSON.stringify(info)
        return !raw.includes('paneSessions') && !raw.includes('.jsonl')
      })()`)

      // Capture pane 101's PTY stream BEFORE anything can type into it.
      await ES(
        "window.__cap='';if(!window.__capHooked){window.__capHooked=true;" +
          "window.bridge.on('terminal:data',function(e){if(e&&e.id===101){window.__cap+=e.data;}});}1"
      )

      // (6) RESTORE — the shipped click.
      await ES(`document.querySelector('.home-resume-card').click()`)
      const restored = await waitTrue(
        `(() => {
          const list = window.__mogging.workspace.list()
          return list.length === 2 &&
            list.some((w) => w.id === 'resume-a' && w.name === 'Alpha' && w.ordinal === 1 && w.paneCount === 2) &&
            list.some((w) => w.id === 'resume-b' && w.name === 'Bravo' && w.ordinal === 2 && w.paneCount === 1)
        })()`,
        40,
        250
      )
      const gridOk = await waitTrue(
        `document.querySelector('#app').classList.contains('view-grid') && !document.querySelector('#app').classList.contains('view-home')`,
        30,
        200
      )

      // (7) EXACT RESUME — the relaunched claude pane is typed the flag AND the uuid.
      // The echo is the PTY's own render of the typed line: strip ANSI, drop ALL
      // whitespace (ConPTY wraps long lines mid-token), then look for the contiguous
      // command. 45s budget: the launch waits for the pane's first output.
      let despaced = ''
      let resumeTyped = false
      for (let i = 0; i < 45 && !resumeTyped; i++) {
        await sleep(1000)
        const cap = String(await ES('window.__cap'))
        despaced = stripAnsi(cap).replace(/\s+/g, '')
        resumeTyped = despaced.includes(`claude--resume${UUID_A}`)
      }
      // ...and the armed intent was CONSUMED by that launch (consume-once): the map is
      // empty — pane 102 was a shell and Bravo's pane never had one to begin with.
      const intentsAfter = resumeIntentsForSmoke()
      const intentConsumed = resumeTyped && intentsAfter.length === 0

      const pass =
        noSnapshot &&
        emptyOffered &&
        quickMirrored &&
        workingMirrored &&
        enriched &&
        heldThroughShrink &&
        heldThroughEmpty &&
        cardOffered &&
        custodyOk &&
        restored &&
        gridOk &&
        resumeTyped &&
        intentConsumed
      result = {
        pass,
        noSnapshot,
        emptyOffered,
        quickMirrored,
        workingMirrored,
        enriched,
        heldThroughShrink,
        heldThroughEmpty,
        cardOffered,
        custodyOk,
        restored,
        gridOk,
        resumeTyped,
        intentConsumed,
        intentsAfter,
        echoTail: despaced.slice(-600)
      }
    } catch (e) {
      result = { pass: false, error: e instanceof Error ? e.message : String(e) }
    } finally {
      setPaneSessionLogOverrideForSmoke(101, null)
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'resume-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}
