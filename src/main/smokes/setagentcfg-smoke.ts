import { app, type BrowserWindow } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSettingsStore } from '../app-settings'

/** Composed Settings UI gate for the five-provider configuration control plane. */
export function runSetAgentConfigSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 180_000)
  const wc = win.webContents
  const execute = <T = unknown>(script: string): Promise<T> => wc.executeJavaScript(script, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  const waitTrue = async (script: string, tries = 60, gap = 200): Promise<boolean> => {
    for (let index = 0; index < tries; index += 1) {
      if (await execute<boolean>(script).catch(() => false)) return true
      await sleep(gap)
    }
    return false
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      const store = getSettingsStore()
      if (!store) throw new Error('settings store unavailable')
      const project = join(app.getPath('userData'), 'agentcfg-ui-project')
      mkdirSync(project, { recursive: true })
      store.save({
        workspaces: [{
          id: 'agentcfg-ui-workspace',
          name: 'Agent config fixture',
          color: '#fd8d03',
          cwd: project,
          ordinal: 0,
          paneCount: 1,
          remotes: [{ hostId: 'agentcfg-remote', name: 'Smoke remote' }]
        }],
        activeId: 'agentcfg-ui-workspace',
        theme: 'midnight'
      })
      store.saveRemote({ id: 'agentcfg-remote', name: 'Smoke remote', host: 'smoke.example', platform: 'posix' })

      const home = join(app.getPath('userData'), 'agent-settings-home')
      const claudeFile = join(home, '.claude', 'settings.json')
      mkdirSync(join(home, '.claude'), { recursive: true })
      writeFileSync(claudeFile, `{
  "permissions": { "defaultMode": "default" },
  "foreignSetting": true
}
`, 'utf8')

      await execute(`document.querySelector('.titlebar-right .icon-btn[aria-label="Settings"]')?.click()`)
      await sleep(350)
      await execute(`document.querySelector('.settings-nav-item[data-target="providers"]')?.click()`)
      // Scoped to the providers SECTION: the global count also caught the session-alerts
      // rows (static .prov-item/.prov-row reuse) — first in this tab, now on Notifications
      // (F-08) — and pinned a number that broke the moment they rendered.
      const landingReady = await waitTrue(`document.querySelectorAll('.settings-section[data-section="providers"] .prov-item').length === 5`)
      const rowsAccessible = await execute<boolean>(`[...document.querySelectorAll('.settings-section[data-section="providers"] .prov-row')].every((row) => row.getAttribute('role') === 'button' && row.tabIndex === 0)`)
      await execute(`document.querySelector('.prov-item[data-provider="claude"] .prov-row')?.click()`)
      const detailReady = await waitTrue(`!!document.querySelector('.agentcfg-workspace:not([hidden]) .agentcfg-scope-select')`, 90)
      const categoryCount = await execute<number>(`document.querySelectorAll('.agentcfg-category').length`)
      const scopeCount = await execute<number>(`document.querySelector('.agentcfg-scope-select')?.options.length || 0`)
      const renderedCount = await execute<number>(`document.querySelectorAll('.agentcfg-setting').length`)
      const catalogCount = await execute<number>(`[...document.querySelectorAll('.agentcfg-category-count')].reduce((sum, node) => sum + Number(node.textContent || 0), 0)`)
      const lazyCategoryOk = renderedCount > 0 && catalogCount >= 200 && renderedCount < catalogCount
      mkdirSync(join(process.cwd(), 'out'), { recursive: true })
      writeFileSync(join(process.cwd(), 'out', 'setagentcfg-detail.png'), (await wc.capturePage()).toPNG())

      // The catalog produces typed controls: boolean -> switch, enum -> select.
      await execute(`(() => {
        const input = document.querySelector('.agentcfg-search-input');
        input.value = 'autoCompactEnabled'; input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`)
      const booleanControl = await waitTrue(`!!document.querySelector('.agentcfg-setting .switch-input')`)
      await execute(`(() => {
        const input = document.querySelector('.agentcfg-search-input');
        input.value = 'permissions.defaultMode'; input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`)
      const enumControl = await waitTrue(`!!document.querySelector('.agentcfg-setting select.agentcfg-input')`)
      const currentVisible = await execute<boolean>(`(() => {
        const row = document.querySelector('.agentcfg-setting');
        return !!row && /This layer/.test(row.textContent || '') && /Effective/.test(row.textContent || '') && /default/i.test(row.textContent || '');
      })()`)

      await execute(`(() => {
        const row = document.querySelector('.agentcfg-setting');
        const select = row?.querySelector('select.agentcfg-input');
        const option = [...(select?.options || [])].find((entry) => entry.textContent === 'bypassPermissions');
        if (select && option) { select.value = option.value; select.dispatchEvent(new Event('change', { bubbles: true })); }
        [...(row?.querySelectorAll('button') || [])].find((button) => button.textContent?.trim() === 'Save')?.click();
      })()`)
      const dangerConfirm = await waitTrue(`!![...document.querySelectorAll('.modal button')].find((button) => button.textContent?.includes('Apply setting'))`)
      await execute(`[...document.querySelectorAll('.modal button')].find((button) => button.textContent?.includes('Apply setting'))?.click()`)
      const saved = await waitTrue(`(() => {
        const row = document.querySelector('.agentcfg-setting');
        return !!row?.querySelector('.agentcfg-release') && /managed|pending restart|synced/i.test(row.textContent || '');
      })()`, 90)
      const fileAfterSave = readFileSync(claudeFile, 'utf8')
      const bypassWritten = /"defaultMode"\s*:\s*"bypassPermissions"/.test(fileAfterSave) && fileAfterSave.includes('"foreignSetting": true')

      const noPathLeak = await execute<boolean>(`!document.body.innerText.includes(${JSON.stringify(home)})`)

      // Remote targets are explicit, unknown, and read-only—never local values in disguise.
      await execute(`(() => {
        const select = document.querySelector('.agentcfg-scope-select');
        const option = [...(select?.options || [])].find((entry) => entry.textContent?.includes('Smoke remote'));
        if (select && option) { select.value = option.value; select.dispatchEvent(new Event('change', { bubbles: true })); }
      })()`)
      const remoteReadOnly = await waitTrue(`(() => {
        const row = document.querySelector('.agentcfg-setting');
        return !!row?.classList.contains('is-readonly') && /Unknown/.test(row.textContent || '') && /SSH settings are read-only/.test(row.textContent || '');
      })()`, 90)

      // Return to the user layer and release ownership by restoring the captured baseline.
      await execute(`(() => {
        const select = document.querySelector('.agentcfg-scope-select');
        const option = [...(select?.options || [])].find((entry) => entry.textContent?.trim() === 'All projects');
        if (select && option) { select.value = option.value; select.dispatchEvent(new Event('change', { bubbles: true })); }
      })()`)
      const userReloaded = await waitTrue(`!!document.querySelector('.agentcfg-setting .agentcfg-release')`, 90)
      await execute(`(() => {
        const row = document.querySelector('.agentcfg-setting');
        [...(row?.querySelectorAll('button') || [])].find((button) => button.textContent?.includes('Restore original'))?.click();
      })()`)
      const released = await waitTrue(`!document.querySelector('.agentcfg-setting .agentcfg-release')`, 90)
      const restored = /"defaultMode"\s*:\s*"default"/.test(readFileSync(claudeFile, 'utf8'))

      const pass = landingReady && rowsAccessible && detailReady && categoryCount >= 8 && scopeCount >= 6 && lazyCategoryOk &&
        booleanControl && enumControl && currentVisible && dangerConfirm && saved && bypassWritten && noPathLeak &&
        remoteReadOnly && userReloaded && released && restored
      result = {
        pass,
        landingReady,
        rowsAccessible,
        detailReady,
        categoryCount,
        scopeCount,
        renderedCount,
        catalogCount,
        lazyCategoryOk,
        booleanControl,
        enumControl,
        currentVisible,
        dangerConfirm,
        saved,
        bypassWritten,
        noPathLeak,
        remoteReadOnly,
        userReloaded,
        released,
        restored
      }
    } catch (error) {
      result = { pass: false, error: error instanceof Error ? error.stack ?? error.message : String(error) }
    }
    try {
      mkdirSync(join(process.cwd(), 'out'), { recursive: true })
      writeFileSync(join(process.cwd(), 'out', 'setagentcfg-result.json'), JSON.stringify(result, null, 2))
    } catch {
      // Best effort; missing output is a loud gate failure.
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 2_500))
  else setTimeout(() => void run(), 2_500)
}
