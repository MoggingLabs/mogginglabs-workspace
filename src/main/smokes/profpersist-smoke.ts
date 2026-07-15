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

  /** Echo the pointer var with a distinct prefix and poll for its result line. */
  const probeEnv = async (prefix: string): Promise<string> => {
    await cli(['send', String(PANE), sh.echoVar('FAKE_MARK', `${prefix}=`)])
    for (let i = 0; i < 24; i++) {
      const text = await bufferText()
      const m = new RegExp(`^${prefix}=(.*)$`, 'm').exec(text)
      // cmd echoes %FAKE_MARK% literally when unset — that still means "no profile env".
      if (m && !m[1].includes('%FAKE_MARK%') && m[1].trim() !== '') return m[1].trim()
      if (m && i > 6) return m[1].replace('%FAKE_MARK%', '').trim() // settled: genuinely unset
      await sleep(500)
    }
    return ''
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
      await sleep(4500) // launchLineup (+900ms) + env prefix lands at the prompt

      const settled = await settle() // the lineup launched gemini into the slot; it owns the pane
      const envB = await probeEnv('MARKA1')
      const pass = savedA === true && savedB === true && envB === MARK_B
      const result = { phase: 'A', pass, savedA, savedB, envB, settled }
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
      const settled = await settle() // restore relaunched the lineup: gemini is back on the screen
      const restored = await probeEnv('MARKB1')
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
        restoredOnB,
        neverA,
        referencedRemoval,
        referencedBlocked,
        profileRemained,
        staleSaved,
        staleRemoval,
        staleLaunch,
        staleRefused,
        settled
      })
      app.exit(pass ? 0 : 1)
    } catch (e) {
      emit({ phase: 'B', pass: false, error: String(e) })
      app.exit(1)
    }
  }

  wc.once('did-finish-load', () => setTimeout(() => void (isA ? runA() : runB()), 3000))
}
