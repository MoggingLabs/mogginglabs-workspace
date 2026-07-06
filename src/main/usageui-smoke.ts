import { app, type BrowserWindow } from 'electron'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setFakeMode } from '@backend/features/usage'
import { softGapMs } from './smoke-shell'
import { getUsageService } from './usage'
import { getSettingsStore } from './app-settings'

// Env-gated usage-UI smoke (MOGGING_USAGEUI, Phase-7/03). FAKE-adapter world.
//   1. the gauge lives in the titlebar right cluster; fills track the ACTIVE
//      tile's window pcts; aria-expanded starts false
//   2. click -> the popover paints in <100ms (cached snapshot, no fetch wait)
//   3. tiles: all 11 fixtures render, grouped under one provider; verdict
//      lines equal the IPC payload's formatter text VERBATIM; countdowns
//      present on rows with resets
//   4. dismiss: Esc closes; click-away closes; aria-expanded tracks
//   5. gauge states are fixture-driven: a hot fixture arms is-warn + the
//      >=90% badge; an error flip dims to is-stale
//   6. the gear lands on Settings with the usage section present
//   7. 7/09 operational: severity orders tiles (runs-out first), the seam's
//      'default' lane carries the identity treatment until profiles exist,
//      a re-armed warn threshold toasts the FORMATTER line verbatim with the
//      failover suggestion, the suggestion click and tile-Enter both drive
//      the ONE Phase-4 pointer flip, and the one-line hint appears
export function runUsageUiSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 90000) // safety net
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  const emit = (o: object): void => {
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'usageui-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      const svc = getUsageService()
      if (!svc) throw new Error('usage service not registered')
      // Let the first poll land + the renderer receive it.
      let tries = 0
      while ((await ES<number>(`document.querySelectorAll('.usage-tile').length`)) === 0 && tries++ < 50) {
        await ES(`window.__mogging.usage && 1`)
        await sleep(200)
        await ES(`(document.querySelector('.usage-popover')?.hidden === false) ? 1 : (window.__mogging.usage.open(), 1)`)
      }
      await ES(`window.__mogging.usage.close()`)

      // 1 ── gauge presence + fills (active tile = Fake Pro normal: 42 / 31)
      const gaugeOk = await ES<boolean>(
        `!!document.querySelector('.titlebar-right .usage-gauge') && document.querySelector('.usage-gauge').getAttribute('aria-expanded') === 'false'`
      )
      const fills = await ES<string>(
        `[...document.querySelectorAll('.usage-gauge .usage-fill')].map(f => f.style.width).join('|')`
      )
      const fillsOk = fills === '42%|31%'

      // 2 ── the CLICK path opens the popover (aria-expanded flips)
      await ES(`document.querySelector('.usage-gauge').click()`)
      const expandedOk = await ES<boolean>(`document.querySelector('.usage-gauge').getAttribute('aria-expanded') === 'true'`)

      // open latency <100ms perceived (click -> painted, double-rAF). Measure the
      // MEDIAN of 3 open/close cycles — a single cold sample is noisy under a
      // full-sweep marathon tail (a real open is ~20ms; the median rejects the
      // outlier without relaxing the budget). Desktop stays strict; softGapMs
      // relaxes ONLY under soft-GL CI, loudly.
      const opens: number[] = []
      for (let i = 0; i < 3; i++) {
        await ES(`window.__mogging.usage.close()`)
        await sleep(60)
        opens.push(
          await ES<number>(`new Promise((res) => {
            const t0 = performance.now()
            window.__mogging.usage.open()
            requestAnimationFrame(() => requestAnimationFrame(() => res(performance.now() - t0)))
          })`)
        )
      }
      opens.sort((a, b) => a - b)
      const openMs = opens[1] // median of 3
      const openBudget = softGapMs(100)
      const openFast = openMs < openBudget

      // 3 ── tiles + verdict wording (DOM text === the IPC formatter output)
      const tileCount = await ES<number>(`document.querySelectorAll('.usage-tile').length`)
      const groupCount = await ES<number>(`document.querySelectorAll('.usage-group-label').length`)
      const verdictsOk = await ES<boolean>(`window.bridge.invoke('usage:list').then((plans) => {
        for (const p of plans) {
          const tile = document.querySelector('.usage-tile[data-profile="' + p.profileId + '"]')
          if (!tile) return false
          const v = tile.querySelector('.usage-verdict')
          if (p.pace) { if (!v || v.textContent !== p.pace.text) return false }
        }
        return true
      })`)
      const countdownOk = await ES<boolean>(
        `[...document.querySelectorAll('.usage-tile[data-profile="default"] .usage-reset')].length >= 2 && document.querySelector('.usage-reset').textContent.startsWith('resets in')`
      )

      // 4 ── dismiss grammar
      await ES(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
      const escClosed = await ES<boolean>(`document.querySelector('.usage-popover').hidden === true`)
      await ES(`window.__mogging.usage.open()`)
      await ES(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
      const awayClosed = await ES<boolean>(
        `document.querySelector('.usage-popover').hidden === true && document.querySelector('.usage-gauge').getAttribute('aria-expanded') === 'false'`
      )

      // 5 ── fixture-driven gauge states: hot fixture -> warn + badge
      const dir = mkdtempSync(join(tmpdir(), 'mog-usageui-'))
      const hot = join(dir, 'hot.json')
      writeFileSync(
        hot,
        JSON.stringify([
          {
            providerId: 'fake',
            profileId: 'default',
            planLabel: 'Fake Pro (hot)',
            windows: [
              { label: 'Session (5h)', usedPct: 93, resetsAt: new Date(Date.now() + 4 * 3600_000).toISOString() },
              { label: 'Weekly', usedPct: 88, resetsAt: new Date(Date.now() + 90 * 3600_000).toISOString() }
            ],
            fetchedAt: Date.now(),
            health: 'fresh'
          }
        ])
      )
      process.env.MOGGING_USAGE_FIXTURE = hot
      svc.refresh()
      tries = 0
      let warnOk = false
      while (!warnOk && tries++ < 40) {
        await sleep(200)
        warnOk = await ES<boolean>(
          `document.querySelector('.usage-gauge').classList.contains('is-warn') && document.querySelector('.usage-badge').hidden === false`
        )
      }
      // error flip -> stale dim (last good kept)
      setFakeMode('error')
      svc.refresh()
      tries = 0
      let staleOk = false
      while (!staleOk && tries++ < 40) {
        await sleep(200)
        staleOk = await ES<boolean>(`document.querySelector('.usage-gauge').classList.contains('is-stale')`)
      }
      setFakeMode('ok')
      delete process.env.MOGGING_USAGE_FIXTURE

      // 6 ── the gear deep-links to Settings § Usage
      await ES(`window.__mogging.usage.open()`)
      await ES(`document.querySelector('.usage-gear').click()`)
      await sleep(400)
      const gearOk = await ES<boolean>(
        `!!document.querySelector('.settings-section[data-section="usage"]') && !!document.querySelector('.usage-stub-row[data-provider="fake"]') && !!document.querySelector('.usage-alert-cfg .usage-thr-warn')`
      )

      // 7 ── 7/09 operational: ordering, identity, thresholds, switching.
      const kv = getSettingsStore()
      await ES(`window.__mogging.usage.open()`)
      // section 5's single-plan fixture is gone; wait for the full set back
      tries = 0
      while ((await ES<number>(`document.querySelectorAll('.usage-tile').length`)) !== 11 && tries++ < 40) await sleep(200)
      // severity orders tiles: exhausted (100%, runs-out) speaks first
      const firstProfile = await ES<string>(`document.querySelector('.usage-tile')?.dataset.profile ?? ''`)
      const orderOk = firstProfile === 'exhausted'
      // no profiles yet -> the seam's 'default' lane carries the treatment
      const defaultActiveOk = await ES<boolean>(
        `document.querySelector('.usage-tile[data-profile="default"]').classList.contains('is-active')`
      )
      // stage the Phase-4 pair: exhausted is ACTIVE (order 0), an idle sibling
      kv?.saveProfile({ id: 'exhausted', name: 'Main', provider: 'fake', env: {}, order: 0 })
      kv?.saveProfile({ id: 'fresh-reset', name: 'Backup', provider: 'fake', env: {}, order: 1 })
      // re-arm the warn threshold so the next push refires WITH the suggestion
      kv?.setSetting('usage.thr.fake.exhausted', '')
      getUsageService()?.refresh()
      let suggestBody = ''
      tries = 0
      while (!suggestBody && tries++ < 40) {
        await sleep(250)
        suggestBody = await ES<string>(
          `(() => { const t = [...document.querySelectorAll('.toast')].find((x) => [...x.querySelectorAll('.toast-action')].some((b) => b.textContent === 'Fail over to Backup')); return t ? (t.querySelector('.toast-body')?.textContent ?? '') : '' })()`
        )
      }
      // toast copy === the 7/02 formatter output, VERBATIM (IPC is the oracle)
      const exPaceText = await ES<string>(
        `window.bridge.invoke('usage:list').then((plans) => plans.find((p) => p.profileId === 'exhausted')?.pace?.text ?? '')`
      )
      const toastCopyOk = !!suggestBody && suggestBody === exPaceText
      // identity follows the store: exhausted (order 0) is now the active tile
      await ES(`window.__mogging.usage.close()`)
      await ES(`window.__mogging.usage.open()`)
      await sleep(400)
      const activeMarkOk = await ES<boolean>(
        `document.querySelector('.usage-tile[data-profile="exhausted"]').classList.contains('is-active')`
      )
      // the suggestion click drives THE switch (one implementation, trigger #2)
      await ES(
        `[...document.querySelectorAll('.toast .toast-action')].find((b) => b.textContent === 'Fail over to Backup').click()`
      )
      let switchedOk = false
      tries = 0
      while (!switchedOk && tries++ < 40) {
        await sleep(200)
        const mine = (kv?.listProfiles() ?? []).filter((p) => p.provider === 'fake').sort((a, b) => a.order - b.order)
        switchedOk = mine[0]?.id === 'fresh-reset'
      }
      // treatment follows immediately + the one-line "running panes" hint
      await ES(`window.__mogging.usage.close()`)
      await ES(`window.__mogging.usage.open()`)
      await sleep(400)
      const activeFollowOk = await ES<boolean>(
        `document.querySelector('.usage-tile[data-profile="fresh-reset"]').classList.contains('is-active') && !document.querySelector('.usage-tile[data-profile="exhausted"]').classList.contains('is-active')`
      )
      const hintOk = await ES<boolean>(
        `(document.querySelector('.usage-switch-hint')?.textContent ?? '').includes('running panes keep')`
      )
      // Enter on a tile is trigger #1 of the same switch: back to Main
      await ES(
        `(() => { const t = document.querySelector('.usage-tile[data-profile="exhausted"]'); t.focus(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })()`
      )
      let enterOk = false
      tries = 0
      while (!enterOk && tries++ < 40) {
        await sleep(200)
        const mine = (kv?.listProfiles() ?? []).filter((p) => p.provider === 'fake').sort((a, b) => a.order - b.order)
        enterOk = mine[0]?.id === 'exhausted'
      }
      await ES(`window.__mogging.usage.close()`)
      kv?.removeProfile('exhausted')
      kv?.removeProfile('fresh-reset')
      const operationalOk = orderOk && defaultActiveOk && toastCopyOk && activeMarkOk && switchedOk && activeFollowOk && hintOk && enterOk

      const pass =
        gaugeOk && fillsOk && openFast && expandedOk && tileCount === 11 && groupCount === 1 && verdictsOk && countdownOk && escClosed && awayClosed && warnOk && staleOk && gearOk && operationalOk
      result = { pass, gaugeOk, fillsOk, openMs, opens, openBudget, openFast, expandedOk, tileCount, groupCount, verdictsOk, countdownOk, escClosed, awayClosed, warnOk, staleOk, gearOk, operationalOk, orderOk, defaultActiveOk, suggestBody, exPaceText, toastCopyOk, activeMarkOk, switchedOk, activeFollowOk, hintOk, enterOk }
    } catch (e) {
      result = { pass: false, error: e instanceof Error ? e.message : String(e) }
    }
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  // Give the renderer a beat to mount before driving it.
  setTimeout(() => void run(), 1200)
}
