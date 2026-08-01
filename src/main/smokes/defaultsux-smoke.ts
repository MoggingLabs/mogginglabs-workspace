// MOGGING_DEFAULTSUX — the defaults face (ADR 0022, phase-defaults/04), composed
// in the REAL Settings UI on provider claude with three isolated homes (the
// offline agent-settings home as the primary + two pointer-profile homes):
//
//   · the "Applies to" control renders on an eligible row and DEFAULTS to
//     All accounts (shared-by-default is the posture, pinning the deliberate act);
//   · the first cross-account Save is announced ONCE (the consent dialog), and the
//     second is quiet (rememberKey) — while every save still lands in all homes;
//   · the smart-promote chip surfaces a key ≥2 homes already agree on, and one
//     click makes it the managed default (through the same consent path);
//   · a pin authored from a profile target shows "Pinned" + "Reset to default",
//     moves ONLY its own home, and the reset re-inherits the shared value live;
//   · no filesystem path leaks into the DOM.
import { app, type BrowserWindow } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSettingsStore } from '../app-settings'

export function runDefaultsUxSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 200_000)
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
  /** The row whose <code> shortPath equals the given catalog path, by search. */
  const rowScript = (path: string): string =>
    `[...document.querySelectorAll('.agentcfg-setting')].find((row) => row.querySelector('code')?.textContent === ${JSON.stringify(path)})`
  const search = async (text: string): Promise<void> => {
    await execute(`(() => {
      const input = document.querySelector('.agentcfg-search-input');
      input.value = ${JSON.stringify(text)}; input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      const store = getSettingsStore()
      if (!store) throw new Error('settings store unavailable')
      // Three claude homes: the offline isolated primary + two pointer profiles.
      const primaryDir = join(app.getPath('userData'), 'agent-settings-home', '.claude')
      const homeA = join(app.getPath('userData'), 'defaultsux-claude-work')
      const homeB = join(app.getPath('userData'), 'defaultsux-claude-personal')
      for (const dir of [primaryDir, homeA, homeB]) mkdirSync(dir, { recursive: true })
      const files = {
        primary: join(primaryDir, 'settings.json'),
        a: join(homeA, 'settings.json'),
        b: join(homeB, 'settings.json')
      }
      // `model` agrees across every home (the promote seed); foreign bytes ride.
      for (const file of Object.values(files)) {
        writeFileSync(file, '{\n  "model": "claude-fixture-1",\n  "foreignSetting": true\n}\n', 'utf8')
      }
      store.saveProfile({ id: 'defaultsux-work', name: 'Work', provider: 'claude', env: { CLAUDE_CONFIG_DIR: homeA }, order: 1 })
      store.saveProfile({ id: 'defaultsux-personal', name: 'Personal', provider: 'claude', env: { CLAUDE_CONFIG_DIR: homeB }, order: 2 })

      const autoIn = (file: string): boolean | undefined => {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
        return parsed.autoCompactEnabled as boolean | undefined
      }
      const foreignKept = (): boolean => Object.values(files).every((file) => readFileSync(file, 'utf8').includes('"foreignSetting": true'))

      // Land on the claude settings detail.
      await execute(`document.querySelector('.titlebar-right .icon-btn[aria-label="Settings"]')?.click()`)
      await sleep(350)
      await execute(`document.querySelector('.settings-nav-item[data-target="providers"]')?.click()`)
      await waitTrue(`document.querySelectorAll('.settings-section[data-section="providers"] .prov-item').length === 5`)
      await execute(`document.querySelector('.prov-item[data-provider="claude"] .prov-row')?.click()`)
      const detailReady = await waitTrue(`!!document.querySelector('.agentcfg-workspace:not([hidden]) .agentcfg-scope-select')`, 90)

      // 1) The Applies-to control renders and DEFAULTS to All accounts.
      await search('autoCompactEnabled')
      const appliesReady = await waitTrue(`!!(${rowScript('autoCompactEnabled')})?.querySelector('.agentcfg-applies')`)
      const appliesDefaultsToAll = await execute<boolean>(`(${rowScript('autoCompactEnabled')})?.querySelector('.agentcfg-applies')?.value === 'all'`)

      // 2) First cross-account Save → the consent dialog, ONCE.
      await execute(`(() => {
        const row = ${rowScript('autoCompactEnabled')};
        row?.querySelector('.switch-input')?.click();
        [...(row?.querySelectorAll('button') || [])].find((button) => button.textContent?.trim() === 'Save')?.click();
      })()`)
      const consentShown = await waitTrue(`!![...document.querySelectorAll('.modal button')].find((button) => button.textContent?.includes('Manage everywhere'))`)
      const consentHonest = await execute<boolean>(`/all 3 of your/.test(document.querySelector('.modal')?.textContent || '') && /primary ~\\/\\.claude/.test(document.querySelector('.modal')?.textContent || '')`)
      // Opt out of re-asking (the house dialog remembers only when the session
      // checkbox is TICKED), then confirm — the "once, not twice" half of the bite.
      await execute(`(() => {
        const box = document.querySelector('.modal input[type="checkbox"]');
        if (box && !box.checked) box.click();
        [...document.querySelectorAll('.modal button')].find((button) => button.textContent?.includes('Manage everywhere'))?.click();
      })()`)
      const managedBadge = await waitTrue(`!!(${rowScript('autoCompactEnabled')})?.querySelector('.agentcfg-setting-badges')?.textContent?.includes('Account default')`, 90)
      const stopManaging = await execute<boolean>(`!![...((${rowScript('autoCompactEnabled')})?.querySelectorAll('button') || [])].find((button) => button.textContent?.includes('Stop managing everywhere'))`)
      // Value-agnostic: the switch started from the catalog default — assert every
      // home AGREES on whatever the first save produced, not on a guessed literal.
      // POLLED, like secondSaved below: the fan-out to the secondary homes is async,
      // and a one-shot read here raced it — red on the CI Windows sweep (run
      // 30690209434) and once locally on slow I/O, green on every re-run. The badge
      // only proves the PRIMARY write; the secondary files earn their own wait.
      let firstSaveEverywhere = false
      for (let attempt = 0; attempt < 40 && !firstSaveEverywhere; attempt += 1) {
        const firstValue = autoIn(files.primary)
        firstSaveEverywhere = firstValue !== undefined && autoIn(files.a) === firstValue && autoIn(files.b) === firstValue
        if (!firstSaveEverywhere) await sleep(250)
      }

      // 3) The second save is QUIET — rememberKey — and still lands everywhere.
      await execute(`(() => {
        const row = ${rowScript('autoCompactEnabled')};
        row?.querySelector('.switch-input')?.click();
        [...(row?.querySelectorAll('button') || [])].find((button) => button.textContent?.trim() === 'Save')?.click();
      })()`)
      await sleep(700)
      const secondSaveQuiet = await execute<boolean>(`![...document.querySelectorAll('.modal button')].find((button) => button.textContent?.includes('Manage everywhere'))`)
      const secondSaved = await waitTrue(`(${rowScript('autoCompactEnabled')})?.querySelector('.agentcfg-setting-badges')?.textContent?.includes('Account default')`, 90) &&
        await (async () => {
          for (let index = 0; index < 40; index += 1) {
            if (autoIn(files.primary) === !firstValue && autoIn(files.a) === !firstValue && autoIn(files.b) === !firstValue) return true
            await sleep(200)
          }
          return false
        })()

      // 4) The promote chip: `model` agrees in all three homes, no default yet.
      await search('model')
      const chipReady = await waitTrue(`!!(${rowScript('model')})?.querySelector('.agentcfg-promote button')`, 90)
      const chipHonest = await execute<boolean>(`/All 3 accounts use claude-fixture-1/.test((${rowScript('model')})?.querySelector('.agentcfg-promote')?.textContent || '')`)
      await execute(`(${rowScript('model')})?.querySelector('.agentcfg-promote button')?.click()`)
      const promoted = await waitTrue(`(${rowScript('model')})?.querySelector('.agentcfg-setting-badges')?.textContent?.includes('Account default')`, 90)
      const chipGone = await execute<boolean>(`!(${rowScript('model')})?.querySelector('.agentcfg-promote')`)

      // 5) A pin from a profile target: only ITS home moves; Reset re-inherits.
      await execute(`(() => {
        const select = document.querySelector('.agentcfg-scope-select');
        const option = [...(select?.options || [])].find((entry) => entry.textContent?.includes('Work'));
        if (select && option) { select.value = option.value; select.dispatchEvent(new Event('change', { bubbles: true })); }
      })()`)
      await waitTrue(`!!document.querySelector('.agentcfg-workspace:not([hidden]) .agentcfg-scope-select')`, 90)
      await search('autoCompactEnabled')
      const profileRowReady = await waitTrue(`!!(${rowScript('autoCompactEnabled')})?.querySelector('.agentcfg-applies')`, 90)
      await execute(`(() => {
        const row = ${rowScript('autoCompactEnabled')};
        const applies = row?.querySelector('.agentcfg-applies');
        if (applies) { applies.value = 'this'; applies.dispatchEvent(new Event('change', { bubbles: true })); }
        row?.querySelector('.switch-input')?.click();
        [...(row?.querySelectorAll('button') || [])].find((button) => button.textContent?.trim() === 'Save')?.click();
      })()`)
      const pinnedBadge = await waitTrue(`!!(${rowScript('autoCompactEnabled')})?.querySelector('.agentcfg-setting-badges')?.textContent?.includes('Pinned')`, 90)
      // The pin flipped ONLY its own home back to firstValue; the default (now
      // !firstValue after save 2) still owns the other two.
      const pinMovedOneHome = autoIn(files.a) === firstValue && autoIn(files.primary) === !firstValue && autoIn(files.b) === !firstValue
      const resetReady = await execute<boolean>(`!![...((${rowScript('autoCompactEnabled')})?.querySelectorAll('button') || [])].find((button) => button.textContent?.includes('Reset to default'))`)
      await execute(`[...((${rowScript('autoCompactEnabled')})?.querySelectorAll('button') || [])].find((button) => button.textContent?.includes('Reset to default'))?.click()`)
      const reinherited = await (async () => {
        for (let index = 0; index < 40; index += 1) {
          if (autoIn(files.a) === !firstValue) return true
          await sleep(200)
        }
        return false
      })()
      const resetBadge = await waitTrue(`(${rowScript('autoCompactEnabled')})?.querySelector('.agentcfg-setting-badges')?.textContent?.includes('Account default')`, 90)

      // 6) Hygiene: no config-home path in the DOM; foreign bytes intact.
      const noPathLeak = await execute<boolean>(`!document.body.innerText.includes(${JSON.stringify(homeA)}) && !document.body.innerText.includes(${JSON.stringify(primaryDir)})`)
      const foreignSurvived = foreignKept()

      const pass = detailReady && appliesReady && appliesDefaultsToAll && consentShown && consentHonest &&
        managedBadge && stopManaging && firstSaveEverywhere && secondSaveQuiet && secondSaved &&
        chipReady && chipHonest && promoted && chipGone &&
        profileRowReady && pinnedBadge && pinMovedOneHome && resetReady && reinherited && resetBadge &&
        noPathLeak && foreignSurvived
      result = {
        pass,
        detailReady,
        appliesReady,
        appliesDefaultsToAll,
        consentShown,
        consentHonest,
        managedBadge,
        stopManaging,
        firstSaveEverywhere,
        secondSaveQuiet,
        secondSaved,
        chipReady,
        chipHonest,
        promoted,
        chipGone,
        profileRowReady,
        pinnedBadge,
        pinMovedOneHome,
        resetReady,
        reinherited,
        resetBadge,
        noPathLeak,
        foreignSurvived
      }
    } catch (error) {
      result = { pass: false, error: error instanceof Error ? error.stack ?? error.message : String(error) }
    }
    try {
      mkdirSync(join(process.cwd(), 'out'), { recursive: true })
      writeFileSync(join(process.cwd(), 'out', 'defaultsux-result.json'), JSON.stringify(result, null, 2))
    } catch {
      // Best effort; missing output is a loud gate failure.
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 2_500))
  else setTimeout(() => void run(), 2_500)
}
