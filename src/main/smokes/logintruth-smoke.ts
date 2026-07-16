import { app, type BrowserWindow } from 'electron'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Env-gated login-truth smoke (MOGGING_LOGINTRUTH, profiles simplified part 3):
// a profile's email is a LABEL — nothing can route the CLI's own OAuth to it — so
// every place the label could silently drift from the home's REAL login must say so.
//   1. `profiles:list` decorates rows with the home's CHECKED login state:
//      a fixture login -> { signedIn, email }; an empty home -> signed-out fact
//   2. label sanctity: a user-added profile's email is NEVER rewritten by the
//      reconciler, even while its home holds a different account
//   3. a DETECTED row (login-*) is the opposite contract: its email FOLLOWS the
//      login when the account changes; its name never moves (it's the user's)
//   4. `agents:command` states the sign-in facts: empty home -> { expected },
//      mismatched home -> { expected, actual }, matching home -> nothing
//   5. Settings § Profiles renders the drift: the mismatch warning pill and the
//      not-signed-in-yet pill, on the right rows
//   6. a real launch under a fresh-home profile raises the pick-this-email toast
// All claude/gemini homes here are fixtures under tmp; the DEFAULT claude home is
// re-aimed via the ambient CLAUDE_CONFIG_DIR pointer this process already honors
// (resolveHome), so the machine's real ~/.claude is never read into an assertion.
const MACHINE_1 = 'machine1@mogging.test'
const MACHINE_2 = 'machine2@mogging.test'
const REAL = 'real@mogging.test'
const LABEL = 'label@mogging.test'
const FRESH = 'fresh@mogging.test'
const GEM_FRESH = 'gfresh@mogging.test'
const GEM_MATCH = 'gmatch@mogging.test'

export function runLoginTruthSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 150000) // safety net
  // BEFORE anything lists profiles: aim the claude DEFAULT home at a fixture, so
  // login-claude derives from files this smoke owns (never the machine's real login).
  const defaultHome = mkdtempSync(join(tmpdir(), 'mogging-lt-default-'))
  process.env.CLAUDE_CONFIG_DIR = defaultHome
  const writeClaudeLogin = (home: string, email: string): void =>
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email } }))
  writeClaudeLogin(defaultHome, MACHINE_1)

  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      await sleep(1500)

      // ── fixtures: one mismatched claude home, one empty; one matching gemini
      // home, one empty (gemini probes <base>/.gemini — the pointer quirk) ──────
      const mismatchHome = mkdtempSync(join(tmpdir(), 'mogging-lt-mismatch-'))
      writeClaudeLogin(mismatchHome, REAL)
      const freshHome = mkdtempSync(join(tmpdir(), 'mogging-lt-fresh-'))
      const gemFreshBase = mkdtempSync(join(tmpdir(), 'mogging-lt-gfresh-'))
      const gemMatchBase = mkdtempSync(join(tmpdir(), 'mogging-lt-gmatch-'))
      const gemDir = join(gemMatchBase, '.gemini')
      mkdirSync(gemDir, { recursive: true })
      writeFileSync(join(gemDir, 'oauth_creds.json'), '{}')
      writeFileSync(join(gemDir, 'google_accounts.json'), JSON.stringify({ active: GEM_MATCH }))

      const save = (p: unknown): Promise<boolean> =>
        ES<boolean>(`window.bridge.invoke('profiles:save', ${JSON.stringify(p)})`)
      const savedOk =
        (await save({ id: 'p-mm', name: 'Mislabeled', provider: 'claude', email: LABEL, env: { CLAUDE_CONFIG_DIR: mismatchHome }, order: 5 })) &&
        (await save({ id: 'p-fresh', name: 'FreshHome', provider: 'claude', email: FRESH, env: { CLAUDE_CONFIG_DIR: freshHome }, order: 6 })) &&
        (await save({ id: 'g-fresh', name: 'GemFresh', provider: 'gemini', email: GEM_FRESH, env: { GEMINI_CLI_HOME: gemFreshBase }, order: 0 })) &&
        (await save({ id: 'g-match', name: 'GemMatch', provider: 'gemini', email: GEM_MATCH, env: { GEMINI_CLI_HOME: gemMatchBase }, order: 1 }))

      type Prof = { id: string; name: string; email?: string; login?: { signedIn: boolean; email?: string } }
      const list = (): Promise<Prof[]> => ES(`window.bridge.invoke('profiles:list')`) as Promise<Prof[]>

      // ── 1+2. decoration states the home's reality; the user label never moves ─
      const l1 = await list()
      const byId = (l: Prof[], id: string): Prof | undefined => l.find((p) => p.id === id)
      const mm1 = byId(l1, 'p-mm')
      const fresh1 = byId(l1, 'p-fresh')
      const gm1 = byId(l1, 'g-match')
      const decorationOk =
        mm1?.login?.signedIn === true && mm1.login.email === REAL &&
        fresh1?.login?.signedIn === false &&
        gm1?.login?.signedIn === true && gm1.login.email === GEM_MATCH
      const labelKept1 = mm1?.email === LABEL

      // ── 3. the DETECTED row follows the login; its name never moves ──────────
      const det1 = byId(l1, 'login-claude')
      const detCreatedOk = det1?.email === MACHINE_1
      writeClaudeLogin(defaultHome, MACHINE_2)
      const l2 = await list()
      const det2 = byId(l2, 'login-claude')
      const detFollowsOk = det2?.email === MACHINE_2 && det2?.name === det1?.name
      const labelKept2 = byId(l2, 'p-mm')?.email === LABEL

      // ── 4. the launch seam states the sign-in facts (facts only, never a gate) ─
      const anchor = mkdtempSync(join(tmpdir(), 'mogging-lt-anchor-'))
      writeFileSync(join(anchor, 'a.txt'), 'x\n')
      type Cmd = { ok: boolean; reason?: string; signIn?: { expected: string; actual?: string } }
      const command = (agentId: string, profileId: string): Promise<Cmd> =>
        ES(
          `window.bridge.invoke('agents:command', { agentId: ${JSON.stringify(agentId)}, profileId: ${JSON.stringify(profileId)}, cwd: ${JSON.stringify(anchor)} })`
        ) as Promise<Cmd>
      const cmdFresh = await command('gemini', 'g-fresh')
      const cmdMatch = await command('gemini', 'g-match')
      const cmdMismatch = await command('claude', 'p-mm')
      const seamFreshOk = cmdFresh.ok && cmdFresh.signIn?.expected === GEM_FRESH && cmdFresh.signIn.actual === undefined
      const seamMatchOk = cmdMatch.ok && cmdMatch.signIn === undefined
      const seamMismatchOk = cmdMismatch.ok && cmdMismatch.signIn?.expected === LABEL && cmdMismatch.signIn.actual === REAL

      // ── 6 (before Settings holds the screen). a real launch raises the toast ──
      await ES(`window.__mogging.workspace.create({ name: 'LT', cwd: ${JSON.stringify(anchor)} })`)
      await sleep(2500)
      const base = ((await ES('window.__mogging.workspace.active()')) as { ordinal: number }).ordinal * 100
      const pane = base + 1
      await ES(`window.__mogging.agents.launchIn(${pane}, 'gemini', ${JSON.stringify(anchor)})`)
      let toastOk = false
      for (let i = 0; i < 24 && !toastOk; i++) {
        toastOk = (await ES(
          `(() => {
            const t = [...document.querySelectorAll('.toast')].map((x) => x.textContent || '')
            return t.some((s) => s.includes('Sign in to set up') && s.includes(${JSON.stringify(GEM_FRESH)}))
          })()`
        )) as boolean
        if (!toastOk) await sleep(500)
      }

      // ── 5. Settings § Profiles renders the drift on the right rows ───────────
      await ES(`document.querySelector('.titlebar-right .icon-btn[aria-label="Settings"]').click()`)
      let pillsOk = false
      let pillDiag: unknown
      for (let i = 0; i < 20 && !pillsOk; i++) {
        await sleep(500)
        pillDiag = await ES(
          `(() => {
            const rows = [...document.querySelectorAll('.ph-profiles .ph-row')]
            const rowOf = (name) => rows.find((r) => (r.querySelector('.ph-row-name span')?.textContent || '') === name)
            const pills = (r) => r ? [...r.querySelectorAll('.pill')].map((p) => p.textContent || '') : null
            return { mm: pills(rowOf('Mislabeled')), fresh: pills(rowOf('FreshHome')), match: pills(rowOf('GemMatch')) }
          })()`
        )
        const d = pillDiag as { mm?: string[] | null; fresh?: string[] | null; match?: string[] | null }
        pillsOk =
          !!d.mm?.some((t) => t.includes(`signed in as ${REAL}`)) &&
          !!d.fresh?.some((t) => t.includes('not signed in yet')) &&
          !!d.match && !d.match.some((t) => t.includes('signed in as') || t.includes('not signed in'))
      }

      const pass =
        savedOk && decorationOk && labelKept1 && detCreatedOk && detFollowsOk && labelKept2 &&
        seamFreshOk && seamMatchOk && seamMismatchOk && toastOk && pillsOk
      result = {
        pass, savedOk, decorationOk, labelKept1, detCreatedOk, detFollowsOk, labelKept2,
        seamFreshOk, seamMatchOk, seamMismatchOk, toastOk, pillsOk,
        // Diagnostics, not claims — the raw facts each verdict was computed from.
        mm1, fresh1, gm1, det1, det2, cmdFresh, cmdMatch, cmdMismatch: { ...cmdMismatch, command: undefined }, pillDiag
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'logintruth-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(run, 2500))
  else setTimeout(run, 2500)
}
