import { app, type BrowserWindow } from 'electron'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setFakeMode } from '@backend/features/usage'
import { softGapMs } from './smoke-shell'
import { getUsageService } from './usage'

// Env-gated usage-UI smoke (MOGGING_USAGEUI, Phase-7/03). FAKE-adapter world.
//   1. the gauge lives in the titlebar right cluster; fills track the ACTIVE
//      tile's window pcts; aria-expanded starts false
//   2. click -> the popover paints in <100ms (cached snapshot, no fetch wait)
//   3. tiles: all 7 fixtures render, grouped under one provider; verdict
//      lines equal the IPC payload's formatter text VERBATIM; countdowns
//      present on rows with resets
//   4. dismiss: Esc closes; click-away closes; aria-expanded tracks
//   5. gauge states are fixture-driven: a hot fixture arms is-warn + the
//      >=90% badge; an error flip dims to is-stale
//   6. the gear lands on Settings with the usage section present
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

      // 2 ── open <100ms perceived (click -> painted, double-rAF)
      const openMs = await ES<number>(`new Promise((res) => {
        const t0 = performance.now()
        document.querySelector('.usage-gauge').click()
        requestAnimationFrame(() => requestAnimationFrame(() => res(performance.now() - t0)))
      })`)
      const openBudget = softGapMs(100) // frame-timing: soft-GL CI relaxes LOUDLY, desktop stays strict
      const openFast = openMs < openBudget
      const expandedOk = await ES<boolean>(`document.querySelector('.usage-gauge').getAttribute('aria-expanded') === 'true'`)

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
        `!!document.querySelector('.settings-section[data-section="usage"]') && !!document.querySelector('.usage-stub-row[data-provider="fake"]')`
      )

      const pass =
        gaugeOk && fillsOk && openFast && expandedOk && tileCount === 7 && groupCount === 1 && verdictsOk && countdownOk && escClosed && awayClosed && warnOk && staleOk && gearOk
      result = { pass, gaugeOk, fillsOk, openMs, openBudget, openFast, expandedOk, tileCount, groupCount, verdictsOk, countdownOk, escClosed, awayClosed, warnOk, staleOk, gearOk }
    } catch (e) {
      result = { pass: false, error: e instanceof Error ? e.message : String(e) }
    }
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  // Give the renderer a beat to mount before driving it.
  setTimeout(() => void run(), 1200)
}
