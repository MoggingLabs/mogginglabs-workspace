import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IntegrationsChannels, type AgentInfo, type HostedCliId } from '@contracts'
import { getSettingsStore } from '../app-settings'
import { setAgentDetectOverrideForSmoke } from '../agents'
import { authRunnerAuditState, setAuthRunnerAuditCommands } from '../authrunner-audit-faults'

// Audit regression gate for P1/23. The catalog connect write is intercepted,
// but every authorization runs through a real visible plain-shell pane. This
// keeps the gate deterministic and prevents it touching a developer's CLI
// config while still proving terminal readiness, command completion and UI.
export function runAuthRunnerSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 90000)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  const installed: AgentInfo[] = [
    { id: 'claude', name: 'Claude Code', installed: true, installHint: '' },
    { id: 'codex', name: 'Codex', installed: true, installHint: '' },
    { id: 'gemini', name: 'Gemini', installed: true, installHint: '' }
  ]
  const success = (label: string): string => process.platform === 'win32' ? `echo ${label}` : `printf ${label}`
  // Both spellings exit SEVEN: the gemini row's title assertion below pins /code 7/ on every
  // platform, and `false` (the old POSIX stub) exits 1 — authored-on-Windows drift that made
  // this gate red on linux/mac only.
  const failure = process.platform === 'win32' ? 'cmd.exe /d /c exit 7' : 'sh -c "exit 7"'

  const openCard = async (label: string): Promise<boolean> => {
    const opened = await ES<boolean>(`(() => {
      const card = [...document.querySelectorAll('.cat-card')].find((item) => item.querySelector('.mgr-label')?.textContent?.trim() === ${JSON.stringify(label)})
      // F-22 renamed the CARD's opener to 'Add to CLI…' ('Connect' is reserved for
      // account connections); the panel's confirm below is still 'Connect'.
      const button = [...(card?.querySelectorAll('button') ?? [])].find((item) => item.textContent?.includes('Add to CLI'))
      if (!(button instanceof HTMLButtonElement)) return false
      button.click()
      return true
    })()`)
    await sleep(150)
    return opened
  }

  const connectPanel = async (): Promise<boolean> => {
    const clicked = await ES<boolean>(`(() => {
      const button = [...document.querySelectorAll('.cat-panel button')].find((item) => item.textContent?.trim() === 'Connect')
      if (!(button instanceof HTMLButtonElement)) return false
      button.click()
      return true
    })()`)
    await sleep(350)
    return clicked
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      await sleep(1500)
      setAgentDetectOverrideForSmoke(installed)
      setAuthRunnerAuditCommands({
        'claude-code': success('AUTH_CLAUDE'),
        codex: success('AUTH_CODEX_<id>'),
        gemini: failure
      })
      await ES(`window.__mogging.workspace.create({ name: 'Auth anchor', cwd: ${JSON.stringify(process.cwd())} })`)
      await sleep(800)

      const noAuthImported = await ES<{ ok: boolean }>(`window.bridge.invoke(${JSON.stringify(IntegrationsChannels.catImport)}, JSON.stringify({
        id: 'audit-open-auth',
        label: 'Audit Open Auth',
        transport: 'stdio',
        urlOrCommand: 'node audit-open-auth.mjs',
        authKinds: ['none'],
        envRefSlots: []
      }))`)
      await ES(`window.__mogging.view('settings'); window.__mogging.settingsTab('integrations')`)
      await sleep(1600)
      // The store/inventory split (2026-07-18): the preset catalog lives in the
      // Library overlay — open it before driving `.cat-*` selectors.
      await ES(`(document.querySelector('.integux-library-cta')?.click(), 1)`)
      await sleep(900)

      // The alternate TOKEN radio must be the value sent to connect. It shows
      // the env/vault route and never creates an OAuth action.
      const tokenCard = await openCard('GitHub')
      const tokenSelected = await ES<boolean>(`(() => {
        const radios = [...document.querySelectorAll('.cat-panel .cat-auth-radio')]
        const token = radios[1]
        if (!(token instanceof HTMLInputElement)) return false
        token.click()
        return token.checked
      })()`)
      const tokenConnected = await connectPanel()
      const tokenUi = await ES<{ note: boolean; authorizeButtons: number }>(`(() => {
        const panel = document.querySelector('.cat-panel')
        return {
          note: !!panel?.textContent?.includes('Token auth selected'),
          authorizeButtons: [...(panel?.querySelectorAll('button') ?? [])].filter((button) => /Authoriz|Retry authorization|Starting/.test(button.textContent ?? '')).length
        }
      })()`)

      // OAuth renders one action per hosted CLI. Two commands succeed and one
      // deliberately exits 7 so both completion states are visible and retryable.
      const oauthCard = await openCard('GitHub')
      const oauthSelected = await ES<boolean>(`(() => {
        const oauth = document.querySelector('.cat-panel .cat-auth-radio')
        return oauth instanceof HTMLInputElement && oauth.checked
      })()`)
      const oauthConnected = await connectPanel()
      // Toasts auto-dismiss, and three auth runs settle at different moments — a
      // one-shot DOM snapshot after `settled` misses whichever finish toasts have
      // already expired (observed: codex's success and gemini's failure gone while
      // their settled BUTTON states prove both fired). Accumulate titles from the
      // moment the runs start instead, so the assertion reads what actually fired.
      await ES(`(() => {
        window.__mogToasts = window.__mogToasts || []
        if (!window.__mogToastObs) {
          const collect = () => document.querySelectorAll('.toast-title').forEach((t) => {
            const s = t.textContent || ''
            if (s && !window.__mogToasts.includes(s)) window.__mogToasts.push(s)
          })
          window.__mogToastObs = new MutationObserver(collect)
          window.__mogToastObs.observe(document.body, { childList: true, subtree: true })
          collect()
        }
        return 1
      })()`)
      const oauthStarted = await ES<{ count: number; pending: boolean }>(`(() => {
        const buttons = [...document.querySelectorAll('.cat-panel button')].filter((button) => /^Authorize in /.test(button.textContent ?? ''))
        buttons.forEach((button) => button.click())
        return {
          count: buttons.length,
          pending: buttons.every((button) => button.disabled && button.getAttribute('aria-busy') === 'true')
        }
      })()`)

      let oauthUi: Record<string, string | boolean> = {}
      for (let attempt = 0; attempt < 50; attempt++) {
        oauthUi = await ES<Record<string, string | boolean>>(`(() => {
          const buttons = [...document.querySelectorAll('.cat-panel button')]
          const by = (needle) => buttons.find((button) => button.textContent?.includes(needle))
          const claude = by('Claude Code')
          const codex = by('Codex')
          const gemini = by('Gemini')
          return {
            claude: claude?.textContent ?? '',
            claudeTitle: claude?.getAttribute('title') ?? '',
            codex: codex?.textContent ?? '',
            codexTitle: codex?.getAttribute('title') ?? '',
            gemini: gemini?.textContent ?? '',
            geminiTitle: gemini?.getAttribute('title') ?? '',
            settled: !!claude && !!codex && !!gemini && !claude.disabled && !codex.disabled && !gemini.disabled
          }
        })()`)
        if (oauthUi.settled) break
        await sleep(300)
      }
      const providerResults: Record<HostedCliId, boolean> = {
        'claude-code': oauthUi.claude === 'Authorized in Claude Code' && /successful/.test(String(oauthUi.claudeTitle)),
        codex: oauthUi.codex === 'Authorized in Codex' && /successful/.test(String(oauthUi.codexTitle)),
        gemini: oauthUi.gemini === 'Retry authorization in Gemini' && /code 7/.test(String(oauthUi.geminiTitle))
      }
      // The finish toasts can trail the settled buttons by several seconds: with three
      // 9s start toasts holding the stack at MAX_STACK, the later finishes QUEUE (by
      // design — a toast is never destroyed before it has been seen, RC3) and mount only
      // as the starts expire. Wait for both signatures rather than sampling one instant.
      let finishToasts: string[] = []
      for (let i = 0; i < 40; i++) {
        finishToasts = await ES<string[]>(`window.__mogToasts.slice()`)
        if (finishToasts.some((t) => t.includes('authorized in')) && finishToasts.some((t) => t.includes('authorization failed'))) break
        await sleep(500)
      }

      // A no-auth preset has neither OAuth actions nor token instructions. It
      // still carries the explicit `none` selection through connect.
      const noneCard = await openCard('Audit Open Auth')
      const noneConnected = await connectPanel()
      const noneUi = await ES<{ tokenNote: boolean; authorizeButtons: number }>(`(() => {
        const panel = document.querySelector('.cat-panel')
        return {
          tokenNote: !!panel?.textContent?.includes('Token auth selected'),
          authorizeButtons: [...(panel?.querySelectorAll('button') ?? [])].filter((button) => /Authoriz|Retry authorization|Starting/.test(button.textContent ?? '')).length
        }
      })()`)

      const audit = authRunnerAuditState()
      const selections = audit?.connects.map((item) => ({
        presetId: item.presetId,
        authKind: item.authKind,
        clis: item.clis
      })) ?? []
      const selectionKinds = selections.map((item) => item.authKind)
      const selectionsHonored =
        JSON.stringify(selectionKinds) === JSON.stringify(['token', 'oauth', 'none']) &&
        selections.every((item) => item.clis.length === 3)
      const authWorkspaces = (getSettingsStore()?.load().workspaces ?? []).filter((workspace) => workspace.name.startsWith('Authorize GitHub'))
      const plainShells =
        authWorkspaces.length === 3 &&
        authWorkspaces.every((workspace) => workspace.paneCount === 1 && workspace.assignments?.length === 1 && workspace.assignments[0] === 'shell')
      const completionVisible =
        Object.values(providerResults).every(Boolean) &&
        finishToasts.some((title) => title.includes('authorized in')) &&
        finishToasts.some((title) => title.includes('authorization failed'))

      const pass =
        noAuthImported.ok &&
        tokenCard && tokenSelected && tokenConnected && tokenUi.note && tokenUi.authorizeButtons === 0 &&
        oauthCard && oauthSelected && oauthConnected && oauthStarted.count === 3 && oauthStarted.pending &&
        completionVisible &&
        noneCard && noneConnected && !noneUi.tokenNote && noneUi.authorizeButtons === 0 &&
        selectionsHonored && plainShells
      result = {
        pass,
        noAuthImported,
        token: { tokenCard, tokenSelected, tokenConnected, tokenUi },
        oauth: { oauthCard, oauthSelected, oauthConnected, oauthStarted, oauthUi, providerResults, finishToasts },
        none: { noneCard, noneConnected, noneUi },
        selections,
        selectionsHonored,
        authWorkspaces: authWorkspaces.map((workspace) => ({
          id: workspace.id,
          name: workspace.name,
          paneCount: workspace.paneCount,
          assignments: workspace.assignments
        })),
        plainShells,
        completionVisible
      }
    } catch (error) {
      result = { pass: false, error: String(error) }
    } finally {
      setAgentDetectOverrideForSmoke(null)
      setAuthRunnerAuditCommands(null)
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'authrunner-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(run, 1200))
  else setTimeout(run, 1200)
}
