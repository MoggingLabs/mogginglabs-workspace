import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getUsageService } from '../usage'
import { keySlot, resolveKey, isKeyVaultAvailable } from '../usage-keys'
import { getSettingsStore } from '../app-settings'

// Env-gated Usage-tab smoke (MOGGING_USAGESET, Phase-7/12). FAKE world (the
// env starts with MOGGING_USAGE -> fixture-only registry, zero network).
// Drives the FULL Settings § Usage tab in the real renderer:
//   1. the grid renders ALL FIVE classes (4 catalog + the fake world's local)
//   2. search filters to a single row
//   3. enable reaches the POLLER live (snapshot shrinks/returns)
//   4. a pasted key flips to the saved/masked state with NO reveal anywhere —
//      the DOM never re-contains the value; Replace + Delete work
//      (vault-conditioned: a vault-less machine asserts the refusal instead)
//   5. an env-ref slot REFUSES a secret-shaped literal (always)
//   6. the web-session store-read opt-in persists per provider
//   7. the plans table renders the SAME (provider, profile) set as the
//      popover — one snapshot, two surfaces, asserted equal
//   8. a Switch flips the active profile through the ONE shared path
//   9. the tab's reset-style knob restyles every reset line (one formatter)
//  10. the privacy story is present; the old stub knobs render NOWHERE else
export function runUsageSetSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 120000) // safety net
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  const emit = (o: object): void => {
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'usageset-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      const svc = getUsageService()
      const kv = getSettingsStore()
      if (!svc || !kv) throw new Error('usage service/settings not ready')
      let tries = 0
      while (svc.list().length === 0 && tries++ < 50) await sleep(200)

      // Open Settings and land on § Usage.
      await ES(`(document.querySelector('.titlebar-right .icon-btn[aria-label="Settings"]')?.click(), 1)`)
      await sleep(400)
      await ES(`document.querySelector('.settings-nav-item[data-target="usage"]')?.click()`) // each tab is its own page (8) — select it
      tries = 0
      while ((await ES<number>(`document.querySelectorAll('.usage-class-group').length`)) < 5 && tries++ < 40) await sleep(200)

      // 1 ── all five classes render
      const klasses = await ES<string[]>(`[...document.querySelectorAll('.usage-class-group')].map((g) => g.dataset.klass)`)
      const gridOk =
        klasses.length === 5 && ['cli-store', 'api-key', 'cloud-cli', 'web-session', 'local'].every((k) => klasses.includes(k))

      // 2 ── search filters to one row
      await ES(
        `(() => { const s = document.querySelector('.usage-search'); s.value = 'openrouter'; s.dispatchEvent(new Event('input')) })()`
      )
      const searchOk =
        (await ES<number>(`document.querySelectorAll('.usage-prov-row').length`)) === 1 &&
        (await ES<string>(`document.querySelector('.usage-prov-row')?.dataset.provider ?? ''`)) === 'openrouter'
      await ES(`(() => { const s = document.querySelector('.usage-search'); s.value = ''; s.dispatchEvent(new Event('input')) })()`)
      await sleep(100)

      // 3 ── enable reaches the poller LIVE. A toggle here triggers a configSet ->
      // loadGrid re-render that REPLACES the checkbox, and an ENABLED provider makes the
      // poller emit on every tick — each emit re-renders the grid too. So a blind second
      // click can land on a freshly-rendered input before its `checked` reflects the write
      // and toggle the WRONG way. Drive to a TARGET state instead: click only when the live
      // checkbox disagrees, re-reading it each pass, so the test exercises the steady-state
      // "toggle -> poller" contract rather than a re-render race. Same driver serves step 6.
      const driveToggle = async (selector: string, want: boolean): Promise<void> => {
        for (let i = 0; i < 40; i++) {
          const checked = await ES<boolean | null>(
            `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.checked : null })()`
          )
          if (checked === want) return
          if (checked !== null) await ES(`document.querySelector(${JSON.stringify(selector)}).click()`)
          await sleep(200)
        }
      }
      const fakeEnable = '.usage-prov-row[data-provider="fake"] .usage-prov-enable input'
      await driveToggle(fakeEnable, false)
      tries = 0
      while (svc.list().length !== 0 && tries++ < 40) await sleep(150)
      const disabledOk = svc.list().length === 0
      await driveToggle(fakeEnable, true)
      tries = 0
      while (svc.list().length !== 11 && tries++ < 60) await sleep(200)
      const enabledOk = svc.list().length === 11

      // 4 ── paste-once, WRITE-ONLY forever (vault-conditioned probes).
      //      Value-set + click happen in ONE evaluation so an async grid
      //      re-render can never swap the input node in between.
      const SECRET = 'sk-or-v1-TABSMOKE-0123456789abcdef0123456789abcdef'
      const vaultAvailable = isKeyVaultAvailable()
      const clickKeyBtn = (label: string): Promise<boolean> =>
        ES<boolean>(
          `(() => { const b = [...document.querySelectorAll('.usage-prov-row[data-provider="openrouter"] .usage-key-ctl .btn')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true })()`
        )
      const pasteAndSave = (value: string, inputCls: string, btnLabel: string): Promise<boolean> =>
        ES<boolean>(
          `(() => { const row = document.querySelector('.usage-prov-row[data-provider="openrouter"]'); const i = row?.querySelector(${JSON.stringify('.' + inputCls)}); const b = [...(row?.querySelectorAll('.usage-key-ctl .btn') ?? [])].find((x) => x.textContent.trim() === ${JSON.stringify(btnLabel)}); if (!i || !b) return false; i.value = ${JSON.stringify(value)}; b.click(); return true })()`
        )
      // settle any in-flight grid re-render from the enable toggles first
      await sleep(600)
      const saveClicked = await pasteAndSave(SECRET, 'usage-key-input', 'Save')
      let keyOk = true
      const keySteps: Record<string, boolean> = {}
      if (vaultAvailable) {
        tries = 0
        while (keySlot('openrouter').kind !== 'keychain' && tries++ < 40) await sleep(150)
        keySteps.saved = keySlot('openrouter').kind === 'keychain'
        tries = 0
        while (!(await ES<boolean>(`!!document.querySelector('.usage-prov-row[data-provider="openrouter"] .usage-key-saved')`)) && tries++ < 40)
          await sleep(150)
        keySteps.chip = await ES<boolean>(`!!document.querySelector('.usage-prov-row[data-provider="openrouter"] .usage-key-saved')`)
        // masked forever: the value is in NO input and NO markup, and the
        // saved state offers Replace/Delete — nothing that could reveal
        keySteps.domClean = await ES<boolean>(
          `(() => { const sec = document.querySelector('.settings-section[data-section="usage"]'); const inputsClean = [...document.querySelectorAll('input')].every((i) => i.value !== ${JSON.stringify(SECRET)}); return inputsClean && !sec.innerHTML.includes(${JSON.stringify(SECRET)}) })()`
        )
        keySteps.revealAbsent = await ES<boolean>(
          `[...document.querySelectorAll('.usage-prov-row[data-provider="openrouter"] .usage-key-ctl .btn')].every((b) => ['Replace', 'Delete'].includes(b.textContent.trim()))`
        )
        // Replace re-opens the paste field (still write-only; nothing shown),
        // and a REAL replace lands a new ciphertext.
        await clickKeyBtn('Replace')
        keySteps.replaceField = await ES<boolean>(
          `(() => { const i = document.querySelector('.usage-prov-row[data-provider="openrouter"] .usage-key-input'); return !!i && i.value === '' })()`
        )
        const SECRET2 = SECRET + '-rotated'
        await pasteAndSave(SECRET2, 'usage-key-input', 'Save')
        tries = 0
        while (resolveKey('openrouter') !== SECRET2 && tries++ < 40) await sleep(150)
        keySteps.replaced = resolveKey('openrouter') === SECRET2
        tries = 0
        while (!(await ES<boolean>(`!!document.querySelector('.usage-prov-row[data-provider="openrouter"] .usage-key-saved')`)) && tries++ < 40)
          await sleep(150)
        await clickKeyBtn('Delete')
        tries = 0
        while (keySlot('openrouter').kind !== 'none' && tries++ < 40) await sleep(150)
        keySteps.deleted = keySlot('openrouter').kind === 'none' && resolveKey('openrouter') === null
        keyOk = Object.values(keySteps).every(Boolean)
      } else {
        tries = 0
        while (!(await ES<boolean>(`(document.querySelector('.usage-prov-row[data-provider="openrouter"] .usage-key-err')?.hidden ?? true) === false`)) && tries++ < 40)
          await sleep(150)
        const refusalShown = await ES<boolean>(
          `/env-ref/i.test(document.querySelector('.usage-prov-row[data-provider="openrouter"] .usage-key-err')?.textContent ?? '')`
        )
        keyOk = refusalShown && keySlot('openrouter').kind === 'none'
      }

      // 5 ── the env-ref slot refuses a secret-shaped LITERAL (vault-independent)
      await sleep(400) // settle the loadGrid from the Delete/refusal above
      const refClicked = await pasteAndSave(SECRET, 'usage-envref-input', 'Set ref')
      tries = 0
      let envRefRefused = false
      while (!envRefRefused && tries++ < 40) {
        await sleep(150)
        envRefRefused = await ES<boolean>(
          `(document.querySelector('.usage-prov-row[data-provider="openrouter"] .usage-key-err')?.hidden ?? true) === false`
        )
      }
      envRefRefused = envRefRefused && keySlot('openrouter').kind === 'none'

      // 6 ── web-session store-read opt-in persists (default OFF). The fake provider is
      // enabled now (step 3), so the poller's per-tick emit re-renders the grid under this
      // step. Unlike the enable toggle, webread's onChange does NOT loadGrid — the checkbox's
      // `checked` only refreshes on the next poll, whose snapshot can LAG the KV. So keying a
      // driver on the box's `checked` (driveToggle) reads a stale value and returns without
      // clicking. Key on the KV instead — the persisted truth, and the only thing our clicks
      // write (the poller reads it, never writes it) — so click-until-KV is race-proof.
      const cursorWebRead = '.usage-prov-row[data-provider="cursor"] .usage-webread input'
      const driveWebRead = async (target: '0' | '1'): Promise<boolean> => {
        for (let i = 0; i < 50; i++) {
          if (kv.getSetting('usage.webread.cursor') === target) return true
          await ES(`(() => { const el = document.querySelector(${JSON.stringify(cursorWebRead)}); if (el) el.click() })()`)
          await sleep(250)
        }
        return kv.getSetting('usage.webread.cursor') === target
      }
      const webReadOn = await driveWebRead('1')
      const webReadOk = webReadOn && (await driveWebRead('0'))

      // 7 ── plans table === popover tiles (one snapshot, two surfaces)
      await ES(`window.__mogging.usage.open()`)
      await sleep(300)
      const pairs = await ES<{ table: string[]; tiles: string[] }>(
        `({ table: [...document.querySelectorAll('.usage-plan-row')].map((r) => r.dataset.provider + '/' + r.dataset.profile).sort(),
            tiles: [...document.querySelectorAll('.usage-tile')].map((t) => t.dataset.provider + '/' + t.dataset.profile).sort() })`
      )
      await ES(`window.__mogging.usage.close()`)
      const plansMatchOk = pairs.table.length === 11 && JSON.stringify(pairs.table) === JSON.stringify(pairs.tiles)

      // 8 ── the plans-table Switch drives THE shared switch path
      kv.saveProfile({ id: 'exhausted', name: 'Main', provider: 'fake', env: {}, order: 0 })
      kv.saveProfile({ id: 'fresh-reset', name: 'Backup', provider: 'fake', env: {}, order: 1 })
      svc.refresh()
      tries = 0
      while (
        !(await ES<boolean>(`!!document.querySelector('.usage-plan-row[data-profile="fresh-reset"] .btn')`)) &&
        tries++ < 40
      )
        await sleep(200)
      await ES(`document.querySelector('.usage-plan-row[data-profile="fresh-reset"] .btn').click()`)
      tries = 0
      let switchOk = false
      while (!switchOk && tries++ < 40) {
        await sleep(200)
        const mine = kv.listProfiles().filter((p) => p.provider === 'fake').sort((a, b) => a.order - b.order)
        switchOk = mine[0]?.id === 'fresh-reset'
      }
      let activeFollowOk = false
      for (let i = 0; i < 40 && !activeFollowOk; i++) {
        await sleep(200)
        activeFollowOk = await ES<boolean>(
          `document.querySelector('.usage-plan-row[data-profile="fresh-reset"]')?.classList.contains('is-active') ?? false`
        )
      }
      kv.removeProfile('exhausted')
      kv.removeProfile('fresh-reset')

      // 9 ── the TAB's reset-style knob restyles every reset line (one formatter)
      await ES(
        `(() => { const s = document.querySelector('.usage-display-reset'); s.value = 'absolute'; s.dispatchEvent(new Event('change')) })()`
      )
      tries = 0
      let resetAbsOk = false
      while (!resetAbsOk && tries++ < 40) {
        await sleep(200)
        resetAbsOk = await ES<boolean>(`window.bridge.invoke('usage:list').then((plans) => {
          const t = plans.flatMap((p) => p.windows).filter((w) => w.resetText).map((w) => w.resetText)
          return t.length > 0 && t.every((x) => x.startsWith('resets ') && !x.startsWith('resets in '))
        })`)
      }
      await ES(
        `(() => { const s = document.querySelector('.usage-display-reset'); s.value = 'countdown'; s.dispatchEvent(new Event('change')) })()`
      )

      // 10 ── privacy in place + the old stub renders NOWHERE
      const privacyOk = await ES<boolean>(
        `(() => { const p = document.querySelector('.usage-privacy-block'); return !!p && /encrypted by your OS/.test(p.textContent) && /opt-in, OFF by default/.test(p.textContent) })()`
      )
      const oneHomeOk = await ES<boolean>(
        `document.querySelectorAll('.usage-stub-row').length === 0 && document.querySelectorAll('.usage-display-cfg').length === 1 && document.querySelectorAll('.usage-alert-cfg').length === 1 && document.querySelectorAll('.usage-cost-cfg').length === 1`
      )

      const pass =
        gridOk && searchOk && disabledOk && enabledOk && keyOk && envRefRefused && webReadOk && plansMatchOk && switchOk && activeFollowOk && resetAbsOk && privacyOk && oneHomeOk
      result = { pass, gridOk, klasses, searchOk, disabledOk, enabledOk, vaultAvailable, saveClicked, keyOk, keySteps, refClicked, envRefRefused, webReadOk, plansMatchOk, pairCount: pairs.table.length, switchOk, activeFollowOk, resetAbsOk, privacyOk, oneHomeOk }
    } catch (e) {
      result = { pass: false, error: e instanceof Error ? e.message : String(e) }
    }
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  setTimeout(() => void run(), 1500)
}
