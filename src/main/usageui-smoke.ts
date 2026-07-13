import { app, type BrowserWindow } from 'electron'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setFakeMode } from '@backend/features/usage'
import { softGapMs } from './smoke-shell'
import { getUsageService } from './usage'

// Env-gated usage-UI smoke (MOGGING_USAGEUI, Phase-7/03). FAKE-adapter world.
// RE-BASELINED to GAUGE-ONLY in 8.5/08c: the popover was recut to the CodexBar
// dropdown, so its grouped-tile / switcher structure moved to USAGEGLANCE. This
// gate keeps the parts the recut does NOT touch — the titlebar gauge:
//   1. the gauge lives in the titlebar right cluster; fills track the merged
//      (highest-severity) plan; aria-expanded starts false
//   2. click -> the popover paints in <100ms (cached snapshot, no fetch wait)
//   3. dismiss: Esc closes; click-away closes; aria-expanded tracks — and (3b,
//      audit 32) Esc is a LAYER key, not a broadcast: with Settings open behind
//      it, ONE Escape closes the popover and leaves Settings standing; the NEXT
//      one (popover already closed) is Settings' own and leaves the page
//   4. gauge states are fixture-driven: a hot fixture arms is-warn + the
//      >=90% badge; an error flip dims to is-stale; and (4b, audit 32) an EMPTY
//      world clears the gauge COMPLETELY — glyph, %, label, warn, stale, badge
//      and both fills — instead of leaving the last plan's paint on an is-off icon
//   5. the gear (kept as the popover's Settings… action) lands on Settings § Usage
export function runUsageUiSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 90000) // safety net
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const waitTrue = async (js: string, tries = 30, gap = 200): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      if (await ES<boolean>(js).catch(() => false)) return true
      await sleep(gap)
    }
    return false
  }

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
      // Let the first poll land + the renderer receive it (the popover paints tiles).
      let tries = 0
      while ((await ES<number>(`document.querySelectorAll('.usage-tile').length`)) === 0 && tries++ < 50) {
        await ES(`window.__mogging.usage && 1`)
        await sleep(200)
        await ES(`(document.querySelector('.usage-popover')?.hidden === false) ? 1 : (window.__mogging.usage.open(), 1)`)
      }
      await ES(`window.__mogging.usage.close()`)

      // 1 ── gauge presence + fills. Default mode is MERGED (7/10): the gauge
      // mirrors the highest-severity plan — exhausted, 100/100.
      const gaugeOk = await ES<boolean>(
        `!!document.querySelector('.titlebar-right .usage-gauge') && document.querySelector('.usage-gauge').getAttribute('aria-expanded') === 'false'`
      )
      const fills = await ES<string>(
        `[...document.querySelectorAll('.usage-gauge .usage-fill')].map(f => f.style.width).join('|')`
      )
      const fillsOk = fills === '100%|100%'

      // 2 ── the CLICK path opens the popover (aria-expanded flips)
      await ES(`document.querySelector('.usage-gauge').click()`)
      const expandedOk = await ES<boolean>(`document.querySelector('.usage-gauge').getAttribute('aria-expanded') === 'true'`)

      // open latency <100ms perceived (click -> painted, double-rAF). Median of 3
      // open/close cycles — a single cold sample is noisy under the full-sweep tail.
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

      // 3 ── dismiss grammar
      await ES(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
      const escClosed = await ES<boolean>(`document.querySelector('.usage-popover').hidden === true`)
      await ES(`window.__mogging.usage.open()`)
      await ES(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
      const awayClosed = await ES<boolean>(
        `document.querySelector('.usage-popover').hidden === true && document.querySelector('.usage-gauge').getAttribute('aria-expanded') === 'false'`
      )

      // 3b ── Esc is a LAYER key. Settings (settings/index.ts) and the wizard both
      // leave their page on an Escape that is NOT already defaultPrevented — so a
      // popover that closed itself and said nothing let the SAME keypress close the
      // page behind it: one press, two dismissals, and the user lands somewhere
      // they never asked to go. Open Settings, open the popover ON TOP of it, send
      // ONE Escape: the popover goes, Settings STAYS.
      await ES(`(document.querySelector('.titlebar-right .icon-btn[aria-label="Settings"]')?.click(), 1)`)
      const settingsUp = await waitTrue(`document.querySelector('#app').classList.contains('view-settings')`)
      await ES(`window.__mogging.usage.open()`)
      await sleep(150)
      await ES(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
      await sleep(150)
      const layered = await ES<{ popHidden: boolean; stillSettings: boolean }>(`(() => ({
        popHidden: document.querySelector('.usage-popover').hidden === true,
        stillSettings: document.querySelector('#app').classList.contains('view-settings')
      }))()`)
      const escLayerOk = settingsUp && layered.popHidden && layered.stillSettings
      // ...and it is not a SINK either. With the popover closed the handler returns
      // before it touches the key, so the very next Escape is Settings' own and
      // leaves the page — swallowing Esc for a hidden popover would be the same bug
      // wearing the other coat.
      await ES(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
      const escFallsThrough = await waitTrue(`!document.querySelector('#app').classList.contains('view-settings')`)

      // 4 ── fixture-driven gauge states: hot fixture -> warn + badge.
      // The CONTENT options go on FIRST (7/10): the glyph, the percent and the
      // provider label only paint under show-glyph/show-pct/show-label, and 4b's
      // stale-content bug is invisible without them — a gauge that lies quietly is
      // still lying, and this gate is the only reader that would ever notice.
      await ES(`window.bridge.invoke('usage:displaySet', { showPct: true, showLabel: true, showGlyph: true })`)
      const optsOn = await waitTrue(
        `(() => { const g = document.querySelector('.usage-gauge'); return g.classList.contains('show-pct') && g.classList.contains('show-label') && g.classList.contains('show-glyph') })()`
      )
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

      // 4b ── the EMPTY world: every plan gone (the last provider disabled, the CLI
      // signed out). paintGauge's no-plan branch used to reset the badge and the two
      // data-attrs and RETURN — so the glyph, the percent, the provider label,
      // is-warn and is-stale all kept whatever the last usable plan painted. `is-off`
      // is not the safety net it looks like: it only zeroes the bar FILL in CSS,
      // while the glyph/percent/label ride an INDEPENDENT class set. With the content
      // options on (step 4) the gauge went on reading "93% · fake" — badged, warned,
      // dimmed — under its own title saying "not configured yet". Every field below
      // is asserted CLEARED, and every one of them failed before the fix.
      setFakeMode('ok') // an erroring adapter re-serves the last good data as STALE — that is not "empty"
      const empty = join(dir, 'empty.json')
      writeFileSync(empty, '[]')
      process.env.MOGGING_USAGE_FIXTURE = empty
      svc.refresh()
      const offOk = await waitTrue(`document.querySelector('.usage-gauge').classList.contains('is-off')`, 40, 200)
      // The popover keeps its LAST paint while hidden, fills and all — reopen it once
      // so the bars still in the document are the ones the GAUGE owns (with no plans
      // the popover is the empty menu, which is itself the assertion below).
      await ES(`(window.__mogging.usage.open(), window.__mogging.usage.close(), 1)`)
      const off = await ES<{
        isOff: boolean
        isWarn: boolean
        isStale: boolean
        badgeHidden: boolean
        pct: string
        label: string
        glyphKids: number
        fills: string[]
        popFills: number
        title: string
      }>(`(() => {
        const g = document.querySelector('.usage-gauge')
        return {
          isOff: g.classList.contains('is-off'),
          isWarn: g.classList.contains('is-warn'),
          isStale: g.classList.contains('is-stale'),
          badgeHidden: document.querySelector('.usage-badge').hidden === true,
          pct: document.querySelector('.usage-pct-num').textContent,
          label: document.querySelector('.usage-glabel').textContent,
          glyphKids: document.querySelector('.usage-glyph').children.length,
          fills: [...document.querySelectorAll('.usage-gauge .usage-fill, .usage-popover .usage-fill')].map((f) => f.style.width),
          popFills: document.querySelectorAll('.usage-popover .usage-fill').length,
          title: g.title
        }
      })()`)
      const clearedOk =
        offOk &&
        off.isOff &&
        !off.isWarn &&
        !off.isStale &&
        off.badgeHidden &&
        off.pct === '' &&
        off.label === '' &&
        off.glyphKids === 0 &&
        off.popFills === 0 && // an empty popover has no bars to be stale
        off.fills.length >= 2 && // ...so these are the gauge's own two, and both are zeroed
        off.fills.every((w) => w === '0%')

      delete process.env.MOGGING_USAGE_FIXTURE
      svc.refresh()

      // 5 ── the gear (the popover's Settings… action) deep-links to Settings § Usage
      await ES(`window.__mogging.usage.open()`)
      await sleep(200)
      await ES(`document.querySelector('.usage-gear').click()`)
      await sleep(400)
      const gearOk = await ES<boolean>(
        `!!document.querySelector('.settings-section[data-section="usage"]') && !!document.querySelector('.usage-prov-row[data-provider="fake"]') && !!document.querySelector('.usage-alert-cfg .usage-thr-warn')`
      )

      const pass =
        gaugeOk &&
        fillsOk &&
        openFast &&
        expandedOk &&
        escClosed &&
        awayClosed &&
        escLayerOk &&
        escFallsThrough &&
        optsOn &&
        warnOk &&
        staleOk &&
        clearedOk &&
        gearOk
      result = {
        pass,
        gaugeOk,
        fillsOk,
        openMs,
        opens,
        openBudget,
        openFast,
        expandedOk,
        escClosed,
        awayClosed,
        escLayerOk,
        settingsUp,
        layered,
        escFallsThrough,
        optsOn,
        warnOk,
        staleOk,
        clearedOk,
        offOk,
        off,
        gearOk
      }
    } catch (e) {
      result = { pass: false, error: e instanceof Error ? e.message : String(e) }
    }
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  // Give the renderer a beat to mount before driving it.
  setTimeout(() => void run(), 1200)
}
