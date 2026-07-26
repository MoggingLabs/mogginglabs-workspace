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
import { paneHasAgent } from '../agent-presence'

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
// Plus five REFUSALS: a vanished cwd (F018), a save that cannot re-derive its sessions (it
// HOLDS them rather than erasing them), a pane CLOSED under a waiting lineup (the launch bails
// before consuming its intent), the same lineup when a SPLIT hands its id to a brand-new pane
// (identity, not the id, decides — nothing is typed into the stranger), and a held session
// whose SLOT has since been re-let to a moved pane (the graft is refused, rather than arming
// one pane's conversation inside another).
// Writes out/resume-result.json, then exits (0=pass, 1=fail).

const UUID_A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
// The session armed on the SHELL slot for the cancel-mid-flight act — a second uuid, so the
// intent that must survive is provably that act's own and not step (2)'s leftover.
const UUID_B = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
// ...and a third for the moved-pane act, so the session that must NOT travel is provably the
// one Delta recorded and not a leftover of either act above.
const UUID_C = 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa'
const CLOSED_PANE = 102 // Alpha slot 2: a shell, so nothing else ever books it agent-bearing
const MOVED_PANE = 205 // born in Bravo (ordinal 2), dragged into Delta's slot 1

/** One workspace's row in the stored snapshot — meta plus the per-slot sessions. */
type SnapshotRow = NonNullable<ReturnType<typeof lastSessionSnapshotForSmoke>>['workspaces'][number]

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

      // Fresh userData: nothing to restore, and Home says so calmly — a sentence with
      // NO button in it (the hero above is the one new-workspace road).
      const noSnapshot = (await ES(`window.bridge.invoke('workspace:lastSession')`)) === null
      const emptyOffered = await waitTrue(
        `(() => { const e = document.querySelector('.home-resume .empty-state'); return !!e && !e.querySelector('button') })()`
      )

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

      // ── row 25 "empty": a save that cannot RE-DERIVE the sessions must HOLD them ──
      // The boot restore fires its own debounced mirror save ~400ms after launch, at a moment
      // when the context monitor has locked NO session logs at all — so paneSessionsFor answers
      // undefined for every workspace. That rewrite ERASED the exact-session ids this card
      // exists to carry, and every save after it (the teardown ones) is HELD — so a user who
      // booted, worked and closed with no lock-bearing save in between came back to a bare
      // `--resume`: the CLI's session PICKER instead of their conversation. Reproduce the boot
      // save exactly — take the lock away, re-save the SAME working set (same count, so it
      // mirrors) — and the ids it cannot re-derive must still be there afterwards.
      // The recolour is the WITNESS that this save really rewrote Alpha's row, so a hold (which
      // would leave step (2)'s snapshot in place, sessions and all) cannot pass for a hold-what-
      // you-cannot-re-derive. Nothing downstream reads a workspace's colour.
      setPaneSessionLogOverrideForSmoke(101, null)
      const blindColor = '#ff2f8e'
      await save([{ ...wsA, color: blindColor }, wsB], 'resume-a')
      const snapAfterBlind = lastSessionSnapshotForSmoke()
      const blindSaveHeldSessions =
        snapAfterBlind?.workspaces.length === 2 &&
        snapAfterBlind.workspaces[0]?.color === blindColor &&
        snapAfterBlind.workspaces[0]?.paneSessions?.[0]?.provider === 'claude' &&
        snapAfterBlind.workspaces[0]?.paneSessions?.[0]?.file === sessionFile &&
        snapAfterBlind.workspaces[0]?.paneSessions?.[0]?.sessionId === UUID_A
      setPaneSessionLogOverrideForSmoke(101, { provider: 'claude', file: sessionFile })

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

      // ── F018: a restore/launch whose cwd has VANISHED must refuse, not book the pane ──
      // controller.create passes the stored cwd straight to the launch; the daemon's pickCwd
      // silently falls back to $HOME when it is gone, so the app booked the pane agent-bearing
      // and spent its one-shot overrides on a session that never `cd`'d there. Main now refuses.
      const deadCwd = join(tmpdir(), 'mogging-vanished-cwd-747474')
      const DEAD_PANE = 747
      const deadLaunch = await ES<{ ok?: boolean; reason?: string }>(
        `window.bridge.invoke('agents:command', { agentId: 'claude', cwd: ${JSON.stringify(deadCwd)}, paneId: ${DEAD_PANE} })`
      )
      const missingCwdRefused =
        deadLaunch?.ok === false && /no longer exists/.test(deadLaunch.reason ?? '') && paneHasAgent(DEAD_PANE) === false

      // ── row 25 "cancel-mid-flight": a pane closed under a WAITING lineup spends nothing ──
      // forgetPane resolves the liveness waiters FALSE, and the local branch had no equivalent
      // of the remote branch's bail — so the launch ran on into a pane that no longer exists:
      // it consumed the one-shot restore intent, spent the session config overrides, booked a
      // non-existent pane agent-bearing, and typed the resume command into an id the app
      // REUSES. F018's stance, for a vanished PANE rather than a vanished cwd.
      //
      // Arm the intent on the SHELL slot (pane 102 — never launched into, so a set presence bit
      // could only be this launch's own signature), then start the resume lineup and close the
      // pane in the SAME tick: launchInPane is already parked on its first await when the ✕ path
      // runs (requestClosePane -> closePane -> rebuild -> publishSlots -> dispose is synchronous
      // for a shell pane with no session and no live work), so the close lands mid-flight and
      // the spawn-settled waiter it re-enters is the one that answers false 15s later.
      const sessionFileB = join(tmpdir(), 'mog-resume-home', 'projects', 'x', `${UUID_B}.jsonl`)
      setPaneSessionLogOverrideForSmoke(CLOSED_PANE, { provider: 'claude', file: sessionFileB })
      await save([wsA, wsB], 'resume-a') // same count: mirrors, and slot 2 now carries a session
      await ES(`window.bridge.invoke('workspace:restoreSession')`) // arms an intent per slot
      const cancelArmed = resumeIntentsForSmoke().some(
        (i) => i.paneId === CLOSED_PANE && i.sessionId === UUID_B
      )
      setPaneSessionLogOverrideForSmoke(CLOSED_PANE, null)
      // "101,102|101": the pane really was in the active grid, and the close really took it out.
      const cancelCloseIds = await ES<string>(
        `(() => {
          const before = window.__mogging.layout.paneIds().join(',')
          window.__mogging.agents.launchIn(${CLOSED_PANE}, 'claude', ${JSON.stringify(cwdA)}, undefined, true).catch(() => {})
          window.__mogging.layout.close(${CLOSED_PANE})
          return before + '|' + window.__mogging.layout.paneIds().join(',')
        })()`
      )
      // The re-entered spawn-settled waiter answers false at its own 15s timeout and only THEN
      // is the gone-check reached — so the reading has to sit past it, with room for the two
      // IPC round trips a pre-fix run would spend on the way to consuming the intent.
      await sleep(20000)
      const cancelIds = cancelCloseIds.split('|')
      const armedAfterCancel = resumeIntentsForSmoke()
      const cancelMidFlightRefused =
        cancelArmed &&
        (cancelIds[0]?.split(',') ?? []).includes(String(CLOSED_PANE)) &&
        !(cancelIds[1]?.split(',') ?? []).includes(String(CLOSED_PANE)) &&
        armedAfterCancel.some((i) => i.paneId === CLOSED_PANE && i.sessionId === UUID_B) &&
        paneHasAgent(CLOSED_PANE) === false

      // ── row 26 "recycled-id": a lineup parked on a CLOSED pane must not type into the
      // pane that takes its id ─────────────────────────────────────────────────────────
      // The far side of row 25. `gone` is per-ID and any mark() clears it, so the stranger
      // pane's own first sign of life is what un-flags the id: the new pane's spawn reply
      // both clears `gone` AND resolves the waiter the parked lineup is sitting on, TRUE.
      // isPaneGone then reads false and the lineup ran on and typed `claude --resume <the
      // DEAD pane's uuid>` into a terminal the user had just split open — someone else's
      // conversation, in a pane that never asked for one. Identity across a reuse belongs to
      // the pane-instance port, not to the id, and the launch path now reads both.
      //
      // Row 25 left pane 102 closed, so seed a real one first: an xterm that has not mounted
      // reports NO instance, and an undefined capture rightly accepts the mount (restore asks
      // for its lineup before the grid builds the panes) — which would make this act vacuous.
      await ES(`window.__mogging.layout.split('h'); 1`)
      const recycledSeeded = await waitTrue(
        `window.__mogging.layout.paneIds().includes(${CLOSED_PANE}) && window.__mogging.agents.paneLive(${CLOSED_PANE})`,
        60,
        250
      )
      setPaneSessionLogOverrideForSmoke(CLOSED_PANE, { provider: 'claude', file: sessionFileB })
      await save([wsA, wsB], 'resume-a') // same count: mirrors, and slot 2 carries UUID_B again
      await ES(`window.bridge.invoke('workspace:restoreSession')`)
      const recycledArmed = resumeIntentsForSmoke().some(
        (i) => i.paneId === CLOSED_PANE && i.sessionId === UUID_B
      )
      setPaneSessionLogOverrideForSmoke(CLOSED_PANE, null)
      // The spy the shipped client already feeds (agents.client's devSpy) — planted before the
      // launch, so a typed line has nowhere to hide.
      await ES(`window.__mogging.ptyWrites = []; 1`)
      // Park the lineup, take its pane away, and hand the id straight to a stranger: the split
      // takes the lowest free slot, which is the one just vacated.
      const recycledCloseIds = await ES<string>(
        `(() => {
          const before = window.__mogging.layout.paneIds().join(',')
          window.__mogging.agents.launchIn(${CLOSED_PANE}, 'claude', ${JSON.stringify(cwdA)}, undefined, true).catch(() => {})
          window.__mogging.layout.close(${CLOSED_PANE})
          const afterClose = window.__mogging.layout.paneIds().join(',')
          window.__mogging.layout.split('h')
          return before + '|' + afterClose
        })()`
      )
      // Wait for the RECYCLE itself rather than a clock: the new pane speaking is the moment
      // `gone` is cleared and the moment the parked waiter is released, so past it the old
      // bytes had nothing left standing between them and the write.
      const recycledLive = await waitTrue(
        `window.__mogging.layout.paneIds().includes(${CLOSED_PANE}) && window.__mogging.agents.paneLive(${CLOSED_PANE})`,
        60,
        250
      )
      // ...then poll for the defect's own signature, which exits the moment it appears — a
      // pre-fix run spends only the one command-build round trip getting here.
      const recycledTyped = await waitTrue(
        `(window.__mogging.ptyWrites || []).some((w) => w.id === ${CLOSED_PANE})`,
        40,
        250
      )
      const recycledWrites = await ES<Array<{ id: number; data: string }>>(
        `(window.__mogging.ptyWrites || []).filter((w) => w.id === ${CLOSED_PANE}).map((w) => ({ id: w.id, data: String(w.data).slice(0, 200) }))`
      )
      const recycledSession = await ES<{ provider?: string } | null>(
        `window.__mogging.agents.session(${CLOSED_PANE}) || null`
      )
      // The intent is the other half: unspent, so the pane that OWNS it can still be restored.
      const recycledIntentHeld = resumeIntentsForSmoke().some(
        (i) => i.paneId === CLOSED_PANE && i.sessionId === UUID_B
      )
      const recycledIds = recycledCloseIds.split('|')
      // Count TYPING, not bytes. A pane that takes focus answers the wire on its own:
      // xterm writes CSI I / CSI O for focus tracking, and CPR and DA replies arrive the
      // same way. None of it is a launch. Asserting zero WRITES red a CORRECT build on
      // Windows CI for exactly that reason, and this repo has been here before - terminal
      // auto-replies once cleared the attention latch on the same mistake. Reuses this
      // file's own stripAnsi rather than a second copy of the escape grammar.
      const recycledTypedBytes = recycledWrites.filter(
        (w) => stripAnsi(String(w.data)).trim() !== ''
      )
      const recycledIdRefused =
        recycledSeeded &&
        recycledArmed &&
        (recycledIds[0]?.split(',') ?? []).includes(String(CLOSED_PANE)) &&
        !(recycledIds[1]?.split(',') ?? []).includes(String(CLOSED_PANE)) &&
        recycledLive && // the id really was re-let, so the guard really was under test
        !recycledTyped &&
        // Count TYPING, not bytes. A pane that takes focus answers the wire on its own:
        // xterm's focus tracking writes CSI I / CSI O, and CPR and DA replies arrive the same
        // way — none of it is a launch. Asserting `recycledWrites.length === 0` therefore red
        // a CORRECT build on Windows CI, where the fresh pane focused and reported it
        // (`[{"id":102,"data":"[O"},{"id":102,"data":"[I"}]`). This repo has been
        // here before: terminal auto-replies once cleared the attention latch for the same
        // reason. The claim is that the parked lineup typed nothing into a pane it no longer
        // owns, so the assertion is over payload — anything that is not a bare control reply.
        recycledTypedBytes.length === 0 &&
        !recycledWrites.some((w) => w.data.includes(UUID_B)) &&
        recycledIntentHeld &&
        recycledSession?.provider !== 'claude'

      // ── the hold above is keyed by PANE, not by slot ─────────────────────────────────
      // A held array is a list of SLOTS, and armResumeIntents resolves it through the meta it
      // rides — so grafting one onto a meta whose `paneIds` have MOVED re-keys every session
      // onto the new occupant. Delta records a session on its slot 1 (the formula's pane 401);
      // the lock then goes away, exactly as in the blind save above, so the graft is the ONLY
      // path a session can still reach the snapshot. Two blind saves follow. The first leaves
      // the pane map alone and must still HOLD (else the refusal below proves nothing but a
      // disabled fallback); the second hands slot 1 to pane 205, dragged in from Bravo, and
      // must refuse — pane 401 left and took its conversation with it. Pre-fix the session
      // follows the SLOT, and restoring types Delta's conversation into Bravo's terminal while
      // the pane that owns it resumes nothing.
      const sessionFileC = join(tmpdir(), 'mog-resume-home', 'projects', 'x', `${UUID_C}.jsonl`)
      const wsD = {
        id: 'resume-d',
        name: 'Delta',
        color: '#f5a524',
        cwd: cwdB,
        ordinal: 4,
        paneCount: 2,
        assignments: ['claude', 'shell']
      }
      const deltaRow = (): SnapshotRow | undefined =>
        lastSessionSnapshotForSmoke()?.workspaces.find((w) => w.id === 'resume-d')
      setPaneSessionLogOverrideForSmoke(401, { provider: 'claude', file: sessionFileC })
      await save([wsA, wsB, wsD], 'resume-a') // growth: mirrors, and Delta records slot 1
      const movedRecorded = deltaRow()?.paneSessions?.[0]?.sessionId === UUID_C
      setPaneSessionLogOverrideForSmoke(401, null) // blind from here — only the hold can answer
      const movedColor = '#7c5cff' // the witness that each blind save really rewrote Delta's row
      await save([wsA, wsB, { ...wsD, color: movedColor }], 'resume-a')
      const unmovedRow = deltaRow()
      const movedHeldWhenUnmoved =
        unmovedRow?.color === movedColor && unmovedRow?.paneSessions?.[0]?.sessionId === UUID_C
      await save([wsA, wsB, { ...wsD, color: movedColor, paneIds: [MOVED_PANE, null] }], 'resume-a')
      const movedRow = deltaRow()
      await ES(`window.bridge.invoke('workspace:restoreSession')`) // arms an intent per slot
      const armedAfterMove = resumeIntentsForSmoke()
      const movedPaneNotArmed =
        movedRecorded &&
        movedHeldWhenUnmoved &&
        movedRow?.paneIds?.[0] === MOVED_PANE && // the moved meta really landed in the snapshot
        !armedAfterMove.some((i) => i.paneId === MOVED_PANE) &&
        !armedAfterMove.some((i) => i.sessionId === UUID_C)

      const pass =
        missingCwdRefused &&
        cancelMidFlightRefused &&
        recycledIdRefused &&
        movedPaneNotArmed &&
        blindSaveHeldSessions &&
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
        missingCwdRefused,
        deadLaunch,
        cancelMidFlightRefused,
        cancelArmed,
        cancelCloseIds,
        armedAfterCancel,
        recycledIdRefused,
        recycledWrites,
        recycledTypedBytes, // the same list with the terminal's own answerbacks removed
        recycledIntentHeld,
        recycledSession,
        recycledSeeded,
        recycledArmed,
        recycledCloseIds,
        recycledLive,
        recycledTyped,
        movedPaneNotArmed,
        movedRecorded,
        movedHeldWhenUnmoved,
        movedSessions: movedRow?.paneSessions ?? null,
        armedAfterMove,
        blindSaveHeldSessions,
        blindSaveSessions: snapAfterBlind?.workspaces[0]?.paneSessions ?? null,
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
      setPaneSessionLogOverrideForSmoke(CLOSED_PANE, null)
      setPaneSessionLogOverrideForSmoke(401, null)
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
