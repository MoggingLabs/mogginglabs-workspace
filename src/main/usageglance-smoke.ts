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
// catalog provider WITH a statusUrl, two profiles) plus a cooler 'codex' one (a strip
// is only a strip above one provider):
//   (a) a provider-tab click sets KV usage.display.mode=pinned + pin;
//   (b) the popover opens <100ms from cache (median of 3, double-rAF);
//   (c) .usage-verdict === pace.text VERBATIM, .usage-pace-delta matches a signed %,
//       .usage-reset starts "resets in";
//   (d) focus SURVIVES a background repaint (the poll used to destroy the focused tile, so a
//       keyboard user's Enter went nowhere), and Enter on a sibling flips order-0 with the
//       .usage-switch-hint saying "running panes keep";
//   (e) Esc and click-away both close;
//   (f) the gauge track + .usage-foot border RE-THEME (bug #4 — real house tokens);
//   (g) "Status Page" calls browser:openExternal with the provider's statusUrl;
//   (h) audit 32 — the MANUAL order is honored: order='manual' sorts the strip by
//       pinOrder (both ways), and order='severity' IGNORES a pinOrder that disagrees
//       (the fixtures are built to disagree: claude runs out, codex has surplus);
//   (i) audit 32 — the strip is a real APG tablist: role=tablist, ONE tab stop
//       (roving tabIndex), aria-controls -> a role=tabpanel, Left/Right move focus AND
//       selection; and every painted bar is a role=progressbar whose aria-valuenow is
//       the percentage it draws.
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
      // A SECOND provider, because a tab STRIP is only a strip above one — and a
      // deliberately COOLER one: codex's lanes pace to `surplus` where claude's pace
      // to `runs-out`. That disagreement is the whole point of (h)'s negative case:
      // under order='severity' the strip cannot come out in the pinOrder by accident.
      const codex = {
        providerId: 'codex',
        profileId: 'default', // no profile targets codex — the seam calls that lane 'default'
        planLabel: 'Plus',
        windows: [
          { label: 'Session (5h)', usedPct: 5, resetsAt: new Date(now + 3 * 3600_000).toISOString(), windowMs: 5 * 3600_000 },
          { label: 'Weekly', usedPct: 10, resetsAt: new Date(now + 2 * 86400_000).toISOString(), windowMs: 7 * 86400_000 }
        ],
        fetchedAt: now,
        health: 'fresh'
      }
      const dir = mkdtempSync(join(tmpdir(), 'mog-glance-'))
      const fx = join(dir, 'claude.json')
      writeFileSync(fx, JSON.stringify([plan('main', 82), plan('backup', 30), codex]))
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

      // ── (c) pace under EVERY window (both limits forecast themselves): the
      //    plan-level verdict (worst window) appears VERBATIM among them, every
      //    paceable window carries a signed delta, resets render. ──
      stage = 'c-pace'
      const paceText = await ES<string>(
        `window.bridge.invoke('usage:list').then((plans) => plans.find((p) => p.providerId === 'claude' && p.profileId === 'main')?.pace?.text ?? '')`
      )
      const cInfo = await ES<{ verdicts: string[]; deltas: string[]; reset: string }>(`(() => {
        const vs = [...document.querySelectorAll('.usage-popover .usage-verdict')].map((v) => v.textContent || '')
        const ds = [...document.querySelectorAll('.usage-popover .usage-pace-delta')].map((d) => d.textContent || '')
        const r = document.querySelector('.usage-popover .usage-reset')
        return { verdicts: vs, deltas: ds, reset: r ? r.textContent : '' }
      })()`)
      const cOk =
        !!paceText &&
        cInfo.verdicts.includes(paceText) &&
        cInfo.verdicts.length >= 2 && // session AND weekly each pace themselves
        cInfo.deltas.length === cInfo.verdicts.length &&
        cInfo.deltas.every((d) => /[+\-−]?\d+%/.test(d)) &&
        cInfo.reset.startsWith('resets in')

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
      // First, the bug this used to die on. A background snapshot repaints the popover, which
      // DESTROYS the focused tile — so a keyboard user's Enter went nowhere, and this gate flaked
      // on the same race. Mark the focused node, drive a REAL refresh through the push path, and
      // require: the node was genuinely replaced, and the focus came back with the lane.
      const marked = await ES<boolean>(`(() => {
        const t = document.querySelector('.usage-popover .usage-tile[data-profile="backup"]')
        if (!t) return false
        t.dataset.smokeMark = '1'
        t.focus()
        return document.activeElement === t
      })()`)
      svc.refresh() // the poll that used to land under the user's hands and take the focus away
      let repaint = { repainted: false, focused: false }
      tries = 0
      while (!repaint.repainted && tries++ < 40) {
        await sleep(150)
        repaint = await ES<{ repainted: boolean; focused: boolean }>(`(() => {
          const t = document.querySelector('.usage-popover .usage-tile[data-profile="backup"]')
          if (!t) return { repainted: false, focused: false }
          return { repainted: t.dataset.smokeMark !== '1', focused: document.activeElement === t }
        })()`)
      }
      const focusSurvivesRefresh = marked && repaint.repainted && repaint.focused

      // Now the switch itself. focus + check + dispatch inside ONE synchronous script: nothing
      // can repaint between them, so the handler cannot find a stale activeElement. The switch is
      // idempotent (it makes `backup` the order-0 lane), so a retry is safe if it did not land.
      let flipped = false
      let sent = ''
      const isFlipped = (): boolean =>
        (kv.listProfiles() ?? []).filter((p) => p.provider === 'claude').sort((a, b) => a.order - b.order)[0]?.id === 'backup'
      for (let attempt = 0; attempt < 3 && !flipped; attempt++) {
        sent = await ES<string>(`(() => {
          const t = document.querySelector('.usage-popover .usage-tile[data-profile="backup"]')
          if (!t) return 'no-tile'
          t.focus()
          if (document.activeElement !== t) return 'not-focused'
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
          return 'sent'
        })()`)
        for (tries = 0; !flipped && tries < 25; tries++) {
          await sleep(200)
          flipped = isFlipped()
        }
      }
      await sleep(200)
      const hintOk = (await ES<string>(`document.querySelector('.usage-popover .usage-switch-hint')?.textContent ?? ''`)).includes('running panes keep')
      const dOk = flipped && hintOk && focusSurvivesRefresh

      // ── (e) Esc + click-away both close ──
      stage = 'e-dismiss'
      await ES(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
      const escClosed = await ES<boolean>(`document.querySelector('.usage-popover').hidden === true`)
      await ES(`window.__mogging.usage.open()`)
      await ES(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
      const awayClosed = await ES<boolean>(`document.querySelector('.usage-popover').hidden === true && document.querySelector('.usage-gauge').getAttribute('aria-expanded') === 'false'`)
      const eOk = escClosed && awayClosed

      // ── (h) the MANUAL order is HONORED (audit 32). `usage.display.order` and
      //    `usage.display.pinOrder` are a fully-built, persisted control — Settings
      //    § Usage writes both, main validates and stores both — that the popover
      //    never READ: the strip was severity-sorted unconditionally, so the knob
      //    was decorative. Every step below is a real DOM TRANSITION (the strip has
      //    to move to satisfy it), so none of them can pass on a stale paint.
      stage = 'h-order'
      await ES(`window.__mogging.usage.open()`)
      const tabOrder = (): Promise<string[]> =>
        ES<string[]>(`[...document.querySelectorAll('.usage-popover .usage-tab:not(.usage-tab-mode)')].map((t) => t.dataset.tab)`)
      const setOrder = async (order: string, pinOrder: string[]): Promise<void> => {
        await ES(`window.bridge.invoke('usage:displaySet', ${JSON.stringify({ order, pinOrder })})`)
      }
      // Poll for the want, then report what we actually saw — a timeout returns the
      // LAST order, so a broken sort fails the compare instead of hanging the gate.
      const waitOrder = async (want: string[]): Promise<string[]> => {
        let seen: string[] = []
        for (let i = 0; i < 40; i++) {
          seen = await tabOrder()
          if (seen.join(',') === want.join(',')) return seen
          await sleep(120)
        }
        return seen
      }
      const sevOrder = await tabOrder() // the severity truth, before any manual order
      await setOrder('manual', ['codex', 'claude'])
      const manualAB = await waitOrder(['codex', 'claude']) // moved AWAY from severity
      await setOrder('manual', ['claude', 'codex'])
      const manualBA = await waitOrder(['claude', 'codex']) // ...and back, on the pin alone
      await setOrder('manual', ['codex', 'claude'])
      await waitOrder(['codex', 'claude']) // park the strip ON the pin order...
      await setOrder('severity', ['codex', 'claude']) // ...so severity has something to disprove
      const sevAgain = await waitOrder(['claude', 'codex'])
      const hOk =
        sevOrder.join(',') === 'claude,codex' && // runs-out speaks first (09's rule)
        manualAB.join(',') === 'codex,claude' &&
        manualBA.join(',') === 'claude,codex' &&
        sevAgain.join(',') === 'claude,codex' &&
        sevAgain.join(',') !== 'codex,claude' // the pinOrder it was handed, and ignored

      // ── (i) the strip is a REAL tablist (audit 32), not buttons wearing role=tab:
      //    ONE tab stop for the whole strip (roving tabIndex — every tab was natively
      //    tabbable, so Tab walked the user through N providers), aria-controls that
      //    resolves to an actual role=tabpanel, and Left/Right that move focus AND
      //    selection. Plus the bars: a track that paints a width and says nothing is a
      //    picture — every one of them now carries role=progressbar + the number it draws.
      stage = 'i-a11y'
      const a11y = await ES<{
        tablist: boolean
        tabs: number
        selected: number
        zeros: number
        selectedIsZero: boolean
        othersAreMinusOne: boolean
        controls: boolean
        panelRole: string
        bars: { role: string; now: string; min: string; max: string; width: string }[]
      }>(`(() => {
        const strip = document.querySelector('.usage-popover .usage-tabs')
        const tabs = [...document.querySelectorAll('.usage-popover .usage-tab')]
        const sel = tabs.filter((t) => t.getAttribute('aria-selected') === 'true')
        const panelId = tabs.length ? (tabs[0].getAttribute('aria-controls') || '') : ''
        const panel = panelId ? document.getElementById(panelId) : null
        return {
          tablist: !!strip && strip.getAttribute('role') === 'tablist',
          tabs: tabs.length,
          selected: sel.length,
          zeros: tabs.filter((t) => t.tabIndex === 0).length,
          selectedIsZero: sel.length === 1 && sel[0].tabIndex === 0,
          othersAreMinusOne: tabs.filter((t) => t.getAttribute('aria-selected') !== 'true').every((t) => t.tabIndex === -1),
          controls: !!panelId && tabs.every((t) => t.getAttribute('aria-controls') === panelId),
          panelRole: panel ? (panel.getAttribute('role') || '') : '',
          bars: [...document.querySelectorAll('.usage-popover .usage-track, .usage-gauge .usage-track')].map((b) => {
            const f = b.querySelector('.usage-fill')
            return {
              role: b.getAttribute('role') || '',
              now: b.getAttribute('aria-valuenow') || '',
              min: b.getAttribute('aria-valuemin') || '',
              max: b.getAttribute('aria-valuemax') || '',
              width: f ? f.style.width : ''
            }
          })
        }
      })()`)
      const barsOk =
        a11y.bars.length >= 4 && // 2 gauge + >= 2 window rows (+ the lane tiles)
        a11y.bars.every(
          (b) =>
            b.role === 'progressbar' &&
            b.min === '0' &&
            b.max === '100' &&
            b.now !== '' &&
            Number(b.now) === Math.round(parseFloat(b.width || '0')) // the value IS the pixels
        )

      // Left/Right move focus AND selection. The select repaints the strip, so this
      // also proves focus survives the repaint the keystroke itself causes.
      const stripTabs = await ES<string[]>(`[...document.querySelectorAll('.usage-popover .usage-tab')].map((t) => t.dataset.tab)`)
      const readTab = `(() => {
        const a = document.activeElement
        const sel = document.querySelector('.usage-popover .usage-tab[aria-selected="true"]')
        return { focus: a instanceof HTMLElement ? (a.dataset.tab || '') : '', selected: sel ? (sel.dataset.tab || '') : '' }
      })()`
      const from = await ES<string>(`(() => {
        const t = document.querySelector('.usage-popover .usage-tab[aria-selected="true"]') || document.querySelector('.usage-popover .usage-tab')
        if (!t) return ''
        t.focus()
        return t.dataset.tab || ''
      })()`)
      const iFrom = stripTabs.indexOf(from)
      const wantRight = stripTabs[(iFrom + 1) % stripTabs.length]
      await ES(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`)
      await sleep(350)
      const right = await ES<{ focus: string; selected: string }>(readTab)
      await ES(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))`)
      await sleep(350)
      const left = await ES<{ focus: string; selected: string }>(readTab)
      const arrowOk =
        !!from &&
        iFrom >= 0 &&
        wantRight !== from &&
        right.focus === wantRight &&
        right.selected === wantRight && // selection FOLLOWS focus
        left.focus === from &&
        left.selected === from // ...and comes back
      const iOk =
        a11y.tablist &&
        a11y.tabs >= 4 && // All · Auto · claude · codex
        a11y.selected === 1 &&
        a11y.zeros === 1 && // exactly ONE tab stop
        a11y.selectedIsZero &&
        a11y.othersAreMinusOne &&
        a11y.controls &&
        a11y.panelRole === 'tabpanel' &&
        barsOk &&
        arrowOk

      // Cleanup so nothing after us inherits the staged profiles / fixture.
      kv.removeProfile('main')
      kv.removeProfile('backup')
      delete process.env.MOGGING_USAGE_FIXTURE
      getUsageService()?.refresh()

      const pass = Boolean(aOk && openFast && cOk && dOk && eOk && fOk && gOk && hOk && iOk)
      result = {
        pass,
        aOk,
        openFast,
        openMs,
        openBudget,
        cOk,
        paceText,
        cInfo,
        dOk,
        flipped,
        sent,
        hintOk,
        focusSurvivesRefresh,
        marked,
        repaint,
        eOk,
        escClosed,
        awayClosed,
        fOk,
        dark,
        light,
        gOk,
        openedUrl: cap.url,
        gClick,
        hOk,
        sevOrder,
        manualAB,
        manualBA,
        sevAgain,
        iOk,
        a11y,
        barsOk,
        arrowOk,
        from,
        wantRight,
        right,
        left
      }
    } catch (e) {
      result = { pass: false, stage, error: e instanceof Error ? e.message : String(e) }
    }
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  setTimeout(() => void run(), 1200)
}
