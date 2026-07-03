import { app, type BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Env-gated profiles + failover smoke (MOGGING_PROFILES, Phase-4/04):
//   1. two pointer profiles save; a secret-shaped env value CANNOT even be saved
//   2. a launch under the default profile really changes the pane's environment
//      (cmd `set` prefix -> `echo %VAR%` expands to profile A's marker)
//   3. `mogging notify --event usage-limit` in-pane -> the manual failover TOAST
//   4. auto-failover ON -> a second limit relaunches on profile B in the SAME pane
//      (same PTY — scrollback survives), environment now shows B's marker
// Provider 'gemini': adapter exists (command builds), CLI not installed here — the
// env plumbing is what's under test, deterministically.
const MARK_A = 'PROFILE_A_4242'
const MARK_B = 'PROFILE_B_4242'

export function runProfilesSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 150000) // safety net
  const wc = win.webContents
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

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      await sleep(1500)

      // ── 1. Save two pointer profiles; the deny-list refuses a secret shape ───
      const save = (p: unknown): Promise<boolean> =>
        ES<boolean>(`window.bridge.invoke('profiles:save', ${JSON.stringify(p)})`)
      const savedA = await save({ id: 'p-a', name: 'Work', provider: 'gemini', env: { FAKE_MARK: MARK_A }, order: 0 })
      const savedB = await save({ id: 'p-b', name: 'Personal', provider: 'gemini', env: { FAKE_MARK: MARK_B }, order: 1 })
      const denied = await save({
        id: 'p-x',
        name: 'Evil',
        provider: 'gemini',
        env: { FAKE_KEY: 'sk-FAKEFAKEFAKEFAKEFAKE1234' },
        order: 2
      })
      type Prof = { id: string }
      const list = (await ES(`window.bridge.invoke('profiles:list')`)) as Prof[]
      const saveOk = savedA === true && savedB === true && denied === false && list.length === 2 && list.every((p) => p.id !== 'p-x')

      // ── 2. Launch under the DEFAULT profile -> env reaches the pane ──────────
      const anchor = mkdtempSync(join(tmpdir(), 'mogging-prof-'))
      writeFileSync(join(anchor, 'a.txt'), 'x\n')
      await ES(`window.__mogging.workspace.create({ name: 'P', cwd: ${JSON.stringify(anchor)} })`)
      await sleep(2500)
      const base = ((await ES('window.__mogging.workspace.active()')) as { ordinal: number }).ordinal * 100
      const pane = base + 1
      await ES(`window.__mogging.agents.launchIn(${pane}, 'gemini', ${JSON.stringify(anchor)})`)
      await sleep(2000)
      const bufferText = (): Promise<string> =>
        ES<string>(
          `(() => {
            const p = (window.__mogging.panes || []).find((x) => x.id === ${pane})
            if (!p) return ''
            const b = p.term.buffer.active
            let s = ''
            for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) s += l.translateToString(true) + '\\n' }
            return s
          })()`
        )
      await cli(['send', String(pane), 'echo MARKVALUE=%FAKE_MARK%'])
      let envAOk = false
      for (let i = 0; i < 24 && !envAOk; i++) {
        envAOk = (await bufferText()).includes(`MARKVALUE=${MARK_A}`)
        if (!envAOk) await sleep(500)
      }
      const launchCtxA = (await ES(`window.__mogging.agents.lastLaunch(${pane})`)) as { profileId?: string }
      const defaultOk = launchCtxA.profileId === 'p-a'

      // ── 3. usage-limit -> the manual failover toast appears ──────────────────
      await cli(['send', String(pane), `node "${cliPath}" notify --event usage-limit`])
      let toastOk = false
      for (let i = 0; i < 30 && !toastOk; i++) {
        toastOk = (await ES(
          `(() => {
            const t = [...document.querySelectorAll('.toast')].find((x) => (x.textContent || '').includes('Usage limit'))
            return !!(t && t.querySelector('.toast-action'))
          })()`
        )) as boolean
        if (!toastOk) await sleep(500)
      }

      // ── 4. auto-failover -> second limit relaunches on B, same pane ──────────
      await ES(`window.__mogging.agents.setAutoFailover(true)`)
      await cli(['send', String(pane), `node "${cliPath}" notify --event usage-limit`])
      await sleep(4000) // ^C + 900ms + relaunch settles
      await cli(['send', String(pane), 'echo MARKVALUE=%FAKE_MARK%'])
      let envBOk = false
      for (let i = 0; i < 24 && !envBOk; i++) {
        envBOk = (await bufferText()).includes(`MARKVALUE=${MARK_B}`)
        if (!envBOk) await sleep(500)
      }
      const launchCtxB = (await ES(`window.__mogging.agents.lastLaunch(${pane})`)) as { profileId?: string }
      const failoverOk = launchCtxB.profileId === 'p-b'
      // Same PTY: the ORIGINAL profile-A marker is still in scrollback.
      const scrollbackSurvived = (await bufferText()).includes(`MARKVALUE=${MARK_A}`)
      const paneCount = Number(await ES('window.__mogging.layout.paneCount()'))

      // ── 5. The Settings PAGE path (5/05 — was a modal): the gear opens the
      // full-app page (rail hidden), the deny-list refusal renders inline, a clean
      // pointer saves, and Esc returns to the grid with the SAME active workspace.
      await ES(`document.querySelector('.titlebar-right .icon-btn[aria-label="Settings"]').click()`)
      await sleep(900)
      const pageOpenOk = (await ES(
        `(() => {
          const rail = document.getElementById('rail')
          return document.querySelector('#content.view-settings #view-settings') !== null &&
            rail !== null && getComputedStyle(rail).display === 'none'
        })()`
      )) as boolean
      await ES(`document.querySelector('.icon-btn[aria-label="Add profile"], button[aria-label="Add profile"]').click()`)
      await sleep(400)
      const fillAndSave = (name: string, key: string, value: string): Promise<unknown> =>
        ES(
          `(() => {
            const set = (sel, v) => { const i = document.querySelector(sel); i.value = v; i.dispatchEvent(new Event('input')) }
            set('.prof-name', ${JSON.stringify(name)})
            set('.prof-env-key', ${JSON.stringify(key)})
            set('.prof-env-val', ${JSON.stringify(value)})
            document.querySelector('button[aria-label="Save profile"]').click()
            return 1
          })()`
        )
      await fillAndSave('FormProf', 'FAKE_KEY', 'sk-FAKEFAKEFAKEFAKE999')
      let formDenyOk = false
      for (let i = 0; i < 12 && !formDenyOk; i++) {
        await sleep(400)
        formDenyOk = (await ES(
          `(() => { const e = document.querySelector('.settings-error'); return !!(e && !e.hidden && /secret/i.test(e.textContent || '')) })()`
        )) as boolean
      }
      await fillAndSave('FormProf', 'FAKE_MARK', 'PROFILE_C_OK')
      let formSaveOk = false
      for (let i = 0; i < 12 && !formSaveOk; i++) {
        await sleep(400)
        formSaveOk = (await ES(
          `(() => { const l = document.querySelector('.ph-profiles'); return !!(l && (l.textContent || '').includes('FormProf')) })()`
        )) as boolean
      }

      // ── 6. Esc leaves the page back to the grid; rail + active workspace intact.
      await ES(`(window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })), 1)`)
      await sleep(600)
      const returnOk = (await ES(
        `(() => {
          const rail = document.getElementById('rail')
          const ws = window.__mogging.workspace.active()
          return document.querySelector('#content.view-settings') === null &&
            rail !== null && getComputedStyle(rail).display !== 'none' &&
            !!ws && ws.name === 'P'
        })()`
      )) as boolean

      const pass =
        saveOk && envAOk && defaultOk && toastOk && envBOk && failoverOk && scrollbackSurvived && paneCount === 1 &&
        pageOpenOk && formDenyOk && formSaveOk && returnOk
      result = { pass, saveOk, envAOk, defaultOk, toastOk, envBOk, failoverOk, scrollbackSurvived, paneCount, pageOpenOk, formDenyOk, formSaveOk, returnOk, launchCtxA, launchCtxB }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'profiles-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(run, 2500))
  else setTimeout(run, 2500)
}
