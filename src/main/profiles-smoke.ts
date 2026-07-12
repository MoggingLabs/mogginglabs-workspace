import { app, type BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sh } from './smoke-shell'

// Env-gated profiles + failover smoke (MOGGING_PROFILES, Phase-4/04):
//   1. two pointer profiles save; a secret-shaped env value CANNOT even be saved
//   2. a launch under the default profile really changes the pane's environment
//      (env prefix -> sh.echoVar expands to profile A's marker, per-platform)
//   3. `mogging notify --event usage-limit` in-pane -> the manual failover TOAST
//   4. auto-failover ON -> a second limit relaunches on profile B in the SAME pane
//      (same PTY — scrollback survives), environment now shows B's marker
// Provider 'gemini' is a REAL launch, and on a machine that HAS the CLI it behaves like
// one: it owns the keyboard and takes the alternate screen. Every shell probe below
// interrupts it first (see interruptAgent) — the env plumbing is still what's under test.
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
      type Prof = { id: string; provider: string }
      const list = (await ES(`window.bridge.invoke('profiles:list')`)) as Prof[]
      // Scope to the fixture provider: discovery may truthfully add THIS machine's
      // real logins (login-claude, …) to the list — they are not under test here.
      const mine = list.filter((p) => p.provider === 'gemini' && !p.id.startsWith('login-'))
      const saveOk = savedA === true && savedB === true && denied === false && mine.length === 2 && list.every((p) => p.id !== 'p-x')

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
      // gemini is a real TUI: it owns the keyboard and switches the terminal to the
      // ALTERNATE screen, which clears it. A shell command typed now lands in gemini's
      // prompt, not the shell, and the echoed marker this probe scrapes for is wiped the
      // moment gemini takes the screen. The gate only ever passed on machines where gemini
      // was NOT installed and the launch quietly no-opped. Interrupt the agent first (twice
      // — one ^C cancels the CLI's current input, the second exits it), which is what the
      // app's OWN usage-limit failover does before it relaunches (^C + 900ms, below). Not a
      // workaround: it is the sequence the product requires, and the gate was skipping it.
      const interruptAgent = async (): Promise<void> => {
        await ES(`window.bridge.send('terminal:write', { id: ${pane}, data: '\\u0003' })`)
        await sleep(700)
        await ES(`window.bridge.send('terminal:write', { id: ${pane}, data: '\\u0003' })`)
        await sleep(900)
      }
      await interruptAgent()
      await cli(['send', String(pane), sh.echoVar('FAKE_MARK', 'MARKVALUE=')])
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
      // The failover relaunched gemini on profile B — a NEW agent, holding the keyboard and
      // the alt screen again. The app's ^C killed the capped one, not this one.
      await interruptAgent()
      await cli(['send', String(pane), sh.echoVar('FAKE_MARK', 'MARKVALUE=')])
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
      // full-app page (rail hidden), a malformed subscription email is refused
      // inline, a clean name+email saves (env/order derived main-side), and Esc
      // returns to the grid with the SAME active workspace.
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
      // The simplified form: name + subscription email only (env/order derived main-side).
      const fillAndSave = (name: string, email: string): Promise<unknown> =>
        ES(
          `(() => {
            const set = (sel, v) => { const i = document.querySelector(sel); i.value = v; i.dispatchEvent(new Event('input')) }
            set('.prof-name', ${JSON.stringify(name)})
            set('.prof-email', ${JSON.stringify(email)})
            document.querySelector('button[aria-label="Save profile"]').click()
            return 1
          })()`
        )
      await fillAndSave('FormProf', 'not-an-email')
      let formDenyOk = false
      for (let i = 0; i < 12 && !formDenyOk; i++) {
        await sleep(400)
        formDenyOk = (await ES(
          `(() => { const e = document.querySelector('.settings-error'); return !!(e && !e.hidden && /email/i.test(e.textContent || '')) })()`
        )) as boolean
      }
      await fillAndSave('FormProf', 'form@mogging.test')
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

      // ── 7. THE ONE LAUNCH SEAM (0.8.1): a palette/menu launch (launchInFocused) goes
      // through the launch port, so the workspace manifest records the slot's assignment,
      // profile and launch cwd — launched any other way it worked live but was invisible
      // to restore (a pane added after workspace creation lost its whole session identity
      // on the next app restart while the reattached CLI kept visibly running).
      await ES(
        `(() => { const s = document.querySelector('.layout-slot[data-pane-id="${pane}"]');` +
          `if (s) s.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return 1 })()`
      )
      await sleep(300)
      await ES(`(window.__mogging.agents.launch('gemini', 'p-b'), 1)`)
      await sleep(1200)
      const seamMeta = (await ES(`window.__mogging.workspace.active()`)) as {
        assignments?: (string | null)[]
        profileIds?: (string | null)[]
        paneCwds?: (string | null)[]
      }
      const seamOk =
        seamMeta.assignments?.[0] === 'gemini' &&
        seamMeta.profileIds?.[0] === 'p-b' &&
        !!seamMeta.paneCwds?.[0]

      const pass =
        saveOk && envAOk && defaultOk && toastOk && envBOk && failoverOk && scrollbackSurvived && paneCount === 1 &&
        pageOpenOk && formDenyOk && formSaveOk && returnOk && seamOk
      result = { pass, saveOk, envAOk, defaultOk, toastOk, envBOk, failoverOk, scrollbackSurvived, paneCount, pageOpenOk, formDenyOk, formSaveOk, returnOk, seamOk, seamMeta, launchCtxA, launchCtxB }
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
