import { app, shell, type BrowserWindow } from 'electron'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getUsageService } from './usage'
import { getSettingsStore } from './app-settings'
import { softGapMs } from './smoke-shell'

// Env-gated Usage-GLANCE smoke (MOGGING_USAGEGLANCE, Phase-8.5/08c). FAKE-adapter
// world. The popover is recut to the CodexBar dropdown (provider tabs → the selected
// provider's active lane); the gauge is UNTOUCHED. Asserts, on 'claude' fixtures (a
// catalog provider WITH a statusUrl, two profiles):
//   (a) a provider-tab click sets KV usage.display.mode=pinned + pin;
//   (b) the popover opens <100ms from cache (median of 3, double-rAF);
//   (c) .usage-verdict === pace.text VERBATIM, .usage-pace-delta matches a signed %,
//       .usage-reset starts "resets in";
//   (d) Enter on a sibling flips order-0 and the .usage-switch-hint says "running panes keep";
//   (e) Esc and click-away both close;
//   (f) the gauge track + .usage-foot border RE-THEME (bug #4 — real house tokens);
//   (g) "Status Page" calls browser:openExternal with the provider's statusUrl.
// Verdict -> out/usageglance-result.json. Inert unless MOGGING_USAGEGLANCE is set.
export function runUsageGlanceSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 90000) // safety net
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const emit = (o: object): void => {
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'usageglance-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    let stage = 'init'
    try {
      const svc = getUsageService()
      if (!svc) throw new Error('usage service not registered')
      const kv = getSettingsStore()
      if (!kv) throw new Error('settings store not registered')

      // (g) prep: window.bridge is a FROZEN contextBridge object, so a renderer spy can't
      // hook invoke. Capture browser:openExternal at its terminal effect instead — the
      // handler calls this same shell.openExternal in main (no network; we stub the open).
      const cap: { url: string | null } = { url: null }
      const shellRef = shell as unknown as { openExternal: (u: string) => Promise<void> }
      const origOpen = shellRef.openExternal
      shellRef.openExternal = (u: string): Promise<void> => {
        cap.url = u
        return Promise.resolve()
      }

      // ── Fixtures: one catalog provider ('claude', has a statusUrl), two profiles,
      //    each with a Session + a Weekly window that PACES (used > elapsed). ──
      stage = 'setup'
      const now = Date.now()
      const plan = (profileId: string, weekly: number) => ({
        providerId: 'claude',
        profileId,
        planLabel: 'Max',
        windows: [
          { label: 'Session (5h)', usedPct: 45, resetsAt: new Date(now + 3 * 3600_000).toISOString(), windowMs: 5 * 3600_000 },
          { label: 'Weekly', usedPct: weekly, resetsAt: new Date(now + 2 * 86400_000).toISOString(), windowMs: 7 * 86400_000 }
        ],
        fetchedAt: now,
        health: 'fresh'
      })
      const dir = mkdtempSync(join(tmpdir(), 'mog-glance-'))
      const fx = join(dir, 'claude.json')
      writeFileSync(fx, JSON.stringify([plan('main', 82), plan('backup', 30)]))
      process.env.MOGGING_USAGE_FIXTURE = fx
      // The active lane is order 0 ('main'); 'backup' is the sibling.
      kv.saveProfile({ id: 'main', name: 'Main', provider: 'claude', env: {}, order: 0 })
      kv.saveProfile({ id: 'backup', name: 'Backup', provider: 'claude', env: {}, order: 1 })
      await ES(`window.bridge.invoke('usage:displaySet', { mode: 'merged', pin: '' })`)
      svc.refresh()

      // Wait for the recut popover to paint from the fixtures.
      let tries = 0
      await ES(`window.__mogging.usage.open()`)
      while ((await ES<number>(`document.querySelectorAll('.usage-popover .usage-tab').length`)) < 3 && tries++ < 50) {
        await sleep(200)
        await ES(`(document.querySelector('.usage-popover')?.hidden === false) ? 1 : (window.__mogging.usage.open(), 1)`)
      }
      await ES(`window.__mogging.usage.close()`)

      // ── (b) open latency <100ms (median of 3, double-rAF) ──
      stage = 'b-open'
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
      const openMs = opens[1]
      const openBudget = softGapMs(100)
      const openFast = openMs < openBudget

      // ── (c) pace line under Weekly: verdict verbatim + signed delta + reset ──
      stage = 'c-pace'
      const paceText = await ES<string>(
        `window.bridge.invoke('usage:list').then((plans) => plans.find((p) => p.providerId === 'claude' && p.profileId === 'main')?.pace?.text ?? '')`
      )
      const cInfo = await ES<{ verdict: string; delta: string; reset: string }>(`(() => {
        const v = document.querySelector('.usage-popover .usage-verdict')
        const d = document.querySelector('.usage-popover .usage-pace-delta')
        const r = document.querySelector('.usage-popover .usage-reset')
        return { verdict: v ? v.textContent : '', delta: d ? d.textContent : '', reset: r ? r.textContent : '' }
      })()`)
      const cOk = !!paceText && cInfo.verdict === paceText && /[+\-−]?\d+%/.test(cInfo.delta) && cInfo.reset.startsWith('resets in')

      // ── (g) Status Page → browser:openExternal (captured at shell.openExternal) ──
      stage = 'g-status'
      const gClick = await ES<{ found: boolean; count: number; texts: string[] }>(`(() => {
        const acts = [...document.querySelectorAll('.usage-popover .usage-action')]
        const b = acts.find((x) => (x.textContent || '').includes('Status Page'))
        if (b) b.click()
        return { found: !!b, count: acts.length, texts: acts.map((x) => (x.textContent || '').trim()) }
      })()`)
      await sleep(300) // the click's IPC round-trip to the openExternal handler
      shellRef.openExternal = origOpen // restore before anything else opens a link
      const gOk = !!cap.url && cap.url.startsWith('https://status.')

      // ── (f) the gauge track + .usage-foot border RE-THEME (bug #4) ──
      stage = 'f-theme'
      const readTheme = async (t: string): Promise<{ track: string; foot: string }> => {
        await ES(`window.__mogging.setTheme(${JSON.stringify(t)})`)
        await sleep(220)
        return ES(`(() => {
          const tr = document.querySelector('.usage-gauge .usage-track')
          const ft = document.querySelector('.usage-popover .usage-foot')
          return { track: tr ? getComputedStyle(tr).backgroundColor : '', foot: ft ? getComputedStyle(ft).borderTopColor : '' }
        })()`)
      }
      const dark = await readTheme('midnight')
      const light = await readTheme('light')
      await ES(`window.__mogging.setTheme('midnight')`)
      await sleep(120)
      const fOk = !!dark.track && !!dark.foot && dark.track !== light.track && dark.foot !== light.foot

      // ── (a) a provider-tab click sets KV mode=pinned + pin ──
      stage = 'a-tab'
      await ES(`document.querySelector('.usage-popover .usage-tab[data-tab="claude"]').click()`)
      tries = 0
      while (kv.getSetting('usage.display.mode') !== 'pinned' && tries++ < 40) await sleep(120)
      const aOk = kv.getSetting('usage.display.mode') === 'pinned' && kv.getSetting('usage.display.pin') === 'claude'

      // ── (d) Enter on the sibling flips order-0 + the switch hint ──
      stage = 'd-switch'
      await ES(`(() => { const t = document.querySelector('.usage-popover .usage-tile[data-profile="backup"]'); t.focus(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })()`)
      let flipped = false
      tries = 0
      while (!flipped && tries++ < 40) {
        await sleep(200)
        const mine = (kv.listProfiles() ?? []).filter((p) => p.provider === 'claude').sort((a, b) => a.order - b.order)
        flipped = mine[0]?.id === 'backup'
      }
      await sleep(200)
      const hintOk = (await ES<string>(`document.querySelector('.usage-popover .usage-switch-hint')?.textContent ?? ''`)).includes('running panes keep')
      const dOk = flipped && hintOk

      // ── (e) Esc + click-away both close ──
      stage = 'e-dismiss'
      await ES(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
      const escClosed = await ES<boolean>(`document.querySelector('.usage-popover').hidden === true`)
      await ES(`window.__mogging.usage.open()`)
      await ES(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
      const awayClosed = await ES<boolean>(`document.querySelector('.usage-popover').hidden === true && document.querySelector('.usage-gauge').getAttribute('aria-expanded') === 'false'`)
      const eOk = escClosed && awayClosed

      // Cleanup so nothing after us inherits the staged profiles / fixture.
      kv.removeProfile('main')
      kv.removeProfile('backup')
      delete process.env.MOGGING_USAGE_FIXTURE
      getUsageService()?.refresh()

      const pass = Boolean(aOk && openFast && cOk && dOk && eOk && fOk && gOk)
      result = { pass, aOk, openFast, openMs, openBudget, cOk, paceText, cInfo, dOk, flipped, hintOk, eOk, escClosed, awayClosed, fOk, dark, light, gOk, openedUrl: cap.url, gClick }
    } catch (e) {
      result = { pass: false, stage, error: e instanceof Error ? e.message : String(e) }
    }
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  setTimeout(() => void run(), 1200)
}
