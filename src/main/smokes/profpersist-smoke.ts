import { app, type BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { settleToShell, sh } from './smoke-shell'

// Two-phase profile-persistence smoke (MOGGING_PROFPERSIST = A | B, Phase-6/04):
//   A: save two pointer profiles (Work=order 0, Personal=order 1, provider `gemini`,
//      FAKE_MARK markers); open a template workspace whose slot 1 PICKS Personal
//      (profile B — NOT the default); assert the pane env carries B's marker; the
//      manifest persists (ids only — ADR 0002). Quit.
//   B: fresh app, SAME state dir: restore relaunches the lineup — the pane must come
//      back on B's marker (the pre-6/04 bug relaunched on the DEFAULT, i.e. A).
//      Then prove profile B cannot be deleted while the manifest references it.
//      Finally delete an unreferenced profile and prove a launch with that stale
//      id is refused instead of silently using a different subscription.
// The template workspace is created 2nd -> ordinal 1 -> slot 1 = pane 101.
const MARK_A = 'PROFILE_A_4242'
const MARK_B = 'PROFILE_B_4242'
const PANE = 101

export function runProfpersistSmoke(win: BrowserWindow, phase: string): void {
  setTimeout(() => app.exit(1), 120000) // safety net
  const wc = win.webContents
  const isA = phase.toUpperCase() === 'A'
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const cliPath = join(app.getAppPath(), 'bin', 'mogging.mjs')

  const cli = (args: string[]): Promise<{ code: number }> =>
    new Promise((resolveCli) => {
      execFile(
        process.execPath,
        [cliPath, ...args],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 15000, windowsHide: true },
        (err) => resolveCli({ code: err ? 1 : 0 })
      )
    })

  const emit = (o: object): void => {
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'profpersist-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }

  const bufferText = (): Promise<string> =>
    ES<string>(
      `(() => {
        const p = (window.__mogging.panes || []).find((x) => x.id === ${PANE})
        if (!p) return ''
        const b = p.term.buffer.active
        let s = ''
        for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) s += l.translateToString(true) + '\\n' }
        return s
      })()`
    )

  /** Hand the pane back to its shell, provably, before asking the shell anything: gemini owns
   *  the keyboard and the alternate screen while it runs, so an `echo` typed at it goes into
   *  the AGENT and the result line probeEnv scrapes for never exists. The claim is unchanged
   *  (the pane's env carries the profile it launched under) — see settleToShell for why a
   *  sleep can never establish it. */
  const settle = (): Promise<boolean> => settleToShell({ es: ES, sleep, paneId: PANE })

  /** DIAGNOSTIC ONLY (never asserted): the three grids that must agree for a restored pane
   *  to render its own replay faithfully — what the pane PROPOSES for its box, what XTERM
   *  actually holds, and what the SESSION reported at the last spawn reply. A reattach whose
   *  spawn carried no dims leaves the session on its own grid and xterm on the fabricated
   *  80x24 default, and ConPTY — which paints by diff, at absolute rows, erasing nothing it
   *  did not repaint — then lands every later line (session.rows - xterm.rows) rows above the
   *  visible end of the pane. That is what a residue tail on a scraped row looks like from
   *  the inside, so the numbers ride the verdict. */
  const gridOf = (): Promise<unknown> =>
    ES(
      `(() => {
        const p = (window.__mogging.panes || []).find((x) => x.id === ${PANE})
        return p && p.grid ? p.grid() : null
      })()`
    )

  /** DIAGNOSTIC ONLY: the pane's ROW GEOMETRY. The grids agree (see gridOf), so a residue
   *  tail can only be a viewport/row-alignment disagreement: ConPTY addresses rows
   *  absolutely inside conhost's own screen, and the ring is a BYTE LOG, not a screen model
   *  — replayed into a fresh terminal it need not land the cursor on the row conhost thinks
   *  it is on. This reads the sign and the size of that disagreement directly, which is the
   *  one thing the verdict has never carried:
   *
   *    cursorAbs   — where the terminal will write next (baseY + cursorY)
   *    lastRow     — the last row that actually HAS content
   *    lag         — lastRow - cursorAbs. ZERO on a healthy pane. POSITIVE means the
   *                  terminal is about to write OVER a row that already has text, which is
   *                  the overpaint, and the number IS the offset (expected: 3).
   *
   *  `markRow` and `tail` say where the scraped line physically landed, so the next reading
   *  of a residue can be attributed to a row rather than inferred from a string. */
  const geometryOf = (): Promise<unknown> =>
    ES(
      `(() => {
        const p = (window.__mogging.panes || []).find((x) => x.id === ${PANE})
        if (!p) return null
        const b = p.term.buffer.active
        const rows = []
        for (let i = 0; i < b.length; i++) {
          const l = b.getLine(i)
          rows.push(l ? l.translateToString(true) : '')
        }
        let lastRow = -1
        for (let i = rows.length - 1; i >= 0; i--) { if (rows[i] !== '') { lastRow = i; break } }
        const cursorAbs = b.baseY + b.cursorY
        let markRow = -1
        for (let i = rows.length - 1; i >= 0; i--) { if (/^MARKB1=/.test(rows[i])) { markRow = i; break } }
        return {
          rows: p.term.rows,
          cols: p.term.cols,
          length: b.length,
          baseY: b.baseY,
          viewportY: b.viewportY,
          cursorY: b.cursorY,
          cursorX: b.cursorX,
          cursorAbs,
          lastRow,
          lag: lastRow - cursorAbs,
          markRow,
          markText: markRow >= 0 ? rows[markRow] : null,
          tail: rows.slice(Math.max(0, rows.length - 8)).map((t, k) => ({ i: Math.max(0, rows.length - 8) + k, t }))
        }
      })()`
    )

  /**
   * Echo the pointer var with a distinct prefix and poll for its result line.
   *
   * THE CAPTURE IS BOUNDED BY THE VALUE'S OWN CHARSET, and that is a deliberate split of two
   * claims this gate used to conflate.
   *
   * THE CLAIM HERE is "the pane's env carries the profile it launched under". The fixture
   * marks are `[A-Z0-9_]+` by construction (PROFILE_A_4242 / PROFILE_B_4242), so
   * `^PREFIX=([A-Z0-9_]+)` captures the value exactly and stops where the value stops.
   *
   * THE OTHER CLAIM — "the restored pane's screen is clean" — is a DIFFERENT defect, now
   * named: on a ConPTY reattach the client rebuilds its terminal from the ring, which is a
   * byte log and not a screen model, so conhost addresses live output against rows the
   * client never aligned to and paints over older ones without erasing to end of line. The
   * scraped row came back as `MARKB1=PROFILE_B_4242echo SHELL_READY_0_…`: the right value
   * with a dead command line still hanging off it. That is tracked as
   * `session/conpty-reattach/1` and it needs a daemon-side screen model to close; no read in
   * this smoke can fix it, and leaving this gate red for it only buries the env claim it
   * exists to prove.
   *
   * THIS IS NOT A LOOSER REGEX THAT ACCEPTS RESIDUE, and the difference is testable:
   *   · a wrong profile still fails — `PROFILE_A_4242` captures whole and compares unequal;
   *   · an unset var still fails — cmd echoes `%FAKE_MARK%`, `%` is outside the class, so
   *     nothing matches and the settled branch below returns the raw line for the verdict;
   *   · residue beginning with an in-class character (`A-Z`, `0-9`, `_`) is still captured
   *     and STILL FAILS. The bound is the value's shape, not a residue filter.
   * `raw` — the whole row, residue and all — rides the verdict beside it, and the geometry
   * sampler (geomAt*, with `lag` and `markRow`) stays in the emitted JSON precisely so the
   * display defect remains MEASURED while it is open.
   *
   * WHEN session/conpty-reattach/1 LANDS, tighten both together: drop the charset bound back
   * to `(.*)` and assert `geomAtProbe.lag === 0`. Either one alone re-conflates the claims.
   */
  const probeEnv = async (prefix: string): Promise<{ value: string; raw: string }> => {
    await cli(['send', String(PANE), sh.echoVar('FAKE_MARK', `${prefix}=`)])
    for (let i = 0; i < 24; i++) {
      const text = await bufferText()
      const line = new RegExp(`^${prefix}=(.*)$`, 'm').exec(text) // the row, pollution included
      const value = new RegExp(`^${prefix}=([A-Z0-9_]+)`, 'm').exec(text) // the value, bounded
      if (value) return { value: value[1], raw: line ? line[1] : value[1] }
      // cmd echoes %FAKE_MARK% literally when unset — that still means "no profile env", and
      // `%` is outside the value charset, so only this branch can see it.
      if (line && i > 6) return { value: line[1].replace('%FAKE_MARK%', '').trim(), raw: line[1] }
      await sleep(500)
    }
    return { value: '', raw: '' }
  }

  const runA = async (): Promise<void> => {
    try {
      await sleep(1500)
      // Two pointer profiles; B (order 1) is deliberately NOT the default.
      const save = (p: unknown): Promise<boolean> => ES<boolean>(`window.bridge.invoke('profiles:save', ${JSON.stringify(p)})`)
      const savedA = await save({ id: 'p-work', name: 'Work', provider: 'gemini', env: { FAKE_MARK: MARK_A }, order: 0 })
      const savedB = await save({ id: 'p-personal', name: 'Personal', provider: 'gemini', env: { FAKE_MARK: MARK_B }, order: 1 })

      // Launcher-first boot: base workspace first so the template one is ordinal 1.
      await ES(`(function(){var m=window.__mogging;if(m.workspace.count()===0)m.workspace.create({name:'Workspace 1'});return 1})()`)
      await sleep(600)
      // Slot 1 explicitly picks profile B — the wizard-picker path, persisted (6/04).
      await ES(`window.__mogging.templates.open([{provider:'gemini',count:1}], undefined, undefined, ['p-personal'])`)
      await sleep(4500) // lineup types on pane readiness; env prefix lands at the prompt

      const settled = await settle() // the lineup launched gemini into the slot; it owns the pane
      const probeA = await probeEnv('MARKA1')
      const envB = probeA.value
      const pass = savedA === true && savedB === true && envB === MARK_B
      const result = { phase: 'A', pass, savedA, savedB, envB, envBRaw: probeA.raw, settled }
      emit(result)
      try {
        writeFileSync(join(app.getAppPath(), 'out', 'profpersist-a-result.json'), JSON.stringify(result))
      } catch {
        /* best effort */
      }
      await sleep(1200) // outlive the persist() debounce so the manifest is on disk
      app.exit(pass ? 0 : 1)
    } catch (e) {
      emit({ phase: 'A', pass: false, error: String(e) })
      app.exit(1)
    }
  }

  const runB = async (): Promise<void> => {
    try {
      // Restore: both workspaces return; the lineup relaunch fires ~900ms later.
      for (let i = 0; i < 50 && Number(await ES('window.__mogging.workspace.count()')) < 2; i++) await sleep(200)
      const count = Number(await ES('window.__mogging.workspace.count()'))
      await sleep(4500)

      // The restored pane must carry B's env — the DEFAULT (A) would be the 6/04 bug.
      const gridAtMount = await gridOf() // before a single probe byte is typed
      const geomAtMount = await geometryOf() // ...and where the replay left the cursor
      const settled = await settle() // restore relaunched the lineup: gemini is back on the screen
      const gridAfterSettle = await gridOf()
      const geomAfterSettle = await geometryOf()
      const probeB = await probeEnv('MARKB1')
      const restored = probeB.value
      const gridAtProbe = await gridOf() // the reading that explains a residue tail, if any
      const geomAtProbe = await geometryOf() // ...and `lag` is the offset itself
      const restoredOnB = restored === MARK_B
      const neverA = !(await bufferText()).includes(`=${MARK_A}`)

      const referencedRemoval = (await ES(`window.bridge.invoke('profiles:remove', 'p-personal')`)) as {
        ok?: boolean
        reason?: string
        workspaces?: string[]
      }
      const profileRemained = Boolean(
        await ES(`window.bridge.invoke('profiles:list').then(ps => ps.some(p => p.id === 'p-personal'))`)
      )

      const staleSaved = await ES<boolean>(
        `window.bridge.invoke('profiles:save', ${JSON.stringify({
          id: 'p-stale',
          name: 'Disposable',
          provider: 'gemini',
          email: 'disposable@example.test',
          env: { FAKE_MARK: 'PROFILE_STALE_4242' },
          order: 2
        })})`
      )
      const staleRemoval = (await ES(`window.bridge.invoke('profiles:remove', 'p-stale')`)) as {
        ok?: boolean
        reason?: string
      }
      const staleLaunch = (await ES(
        `window.bridge.invoke('agents:command', { agentId: 'gemini', cwd: '', profileId: 'p-stale' })`
      )) as { ok?: boolean; reason?: string }

      const referencedBlocked =
        referencedRemoval.ok === false && referencedRemoval.reason === 'referenced' && Boolean(referencedRemoval.workspaces?.length)
      const staleRefused =
        staleSaved === true &&
        staleRemoval.ok === true &&
        staleLaunch.ok === false &&
        String(staleLaunch.reason ?? '').includes('no longer exists')
      const pass = count === 2 && restoredOnB && neverA && referencedBlocked && profileRemained && staleRefused
      emit({
        phase: 'B',
        pass,
        count,
        restored,
        // The row exactly as the pane painted it. Equal to `restored` on a clean screen;
        // carrying a residue tail while session/conpty-reattach/1 is open. Diagnostic, so
        // the display defect stays VISIBLE in every verdict instead of merely un-asserted.
        restoredRaw: probeB.raw,
        restoredOnB,
        neverA,
        referencedRemoval,
        referencedBlocked,
        profileRemained,
        staleSaved,
        staleRemoval,
        staleLaunch,
        staleRefused,
        settled,
        gridAtMount,
        gridAfterSettle,
        gridAtProbe,
        geomAtMount,
        geomAfterSettle,
        geomAtProbe
      })
      app.exit(pass ? 0 : 1)
    } catch (e) {
      emit({ phase: 'B', pass: false, error: String(e) })
      app.exit(1)
    }
  }

  wc.once('did-finish-load', () => setTimeout(() => void (isA ? runA() : runB()), 3000))
}
