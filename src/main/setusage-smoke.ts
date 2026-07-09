import { app, type BrowserWindow } from 'electron'
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getUsageService } from './usage'

// Env-gated Usage-tab + popover smoke (MOGGING_SETUSAGE, Phase-8.5/05b). FAKE world
// (the gate is recognized as a usage-fixture world in usage.ts). The three surfaces
// nothing owned, now on the 01 primitives:
//   (a) the tab opens OVERVIEW-ONLY — the band shows, all seven Cards are folded; a
//       hand-expand SURVIVES a leave/return (disclosure persists per section);
//   (b) a HOT fixture auto-expands Providers AND posts `.usage-fill.is-hot` on its
//       always-visible header — attention beats persistence, collapse is not hide;
//   (c) every USAGESET/USAGEUI hook still resolves THROUGH the folded cards (the body
//       is hidden, never unbuilt), and the one-home singletons stay singular;
//   (d) the popover gauge track + foot border CHANGE with the theme — bug #4's
//       regression test (nine dead tokens now read real house tokens, so they theme);
//   (e) no `var(--r-md` on a non-radius property in any `.usage` rule — bug #5;
//   (f) the profile form wears real FieldGroup labels and a secret-shaped value is
//       refused into `.settings-error`.
export function runSetUsageSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 150000) // safety net
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
  const cardOpen = (id: string): Promise<boolean> =>
    ES<boolean>(`document.querySelector('.collapsible-card[data-collapsible="${id}"]')?.classList.contains('is-open') === true`)
  const toggle = (id: string): Promise<unknown> =>
    ES(`(document.querySelector('.collapsible-card[data-collapsible="${id}"] .cc-toggle')?.click(), 1)`)
  const openUsage = async (): Promise<void> => {
    await ES(`(document.querySelector('.titlebar-right .icon-btn[aria-label="Settings"]')?.click(), 1)`)
    await sleep(400)
    await ES(`(document.querySelector('.settings-nav-item[data-target="usage"]')?.click(), 1)`)
    await sleep(400)
  }
  const leave = async (): Promise<void> => {
    await ES(`document.querySelector('.settings-back')?.click()`)
    await sleep(300)
  }

  const CARDS = ['providers', 'plans', 'pace', 'alerts', 'display', 'history', 'privacy']
  const fixture = (plans: unknown[]): void => {
    const dir = mkdtempSync(join(tmpdir(), 'mog-setusage-'))
    const f = join(dir, 'fx.json')
    writeFileSync(f, JSON.stringify(plans))
    process.env.MOGGING_USAGE_FIXTURE = f
    getUsageService()?.refresh()
  }
  const plan = (label: string, s: number, w: number): unknown => ({
    providerId: 'fake',
    profileId: 'default',
    planLabel: label,
    windows: [
      { label: 'Session (5h)', usedPct: s, resetsAt: new Date(Date.now() + 2 * 3600_000).toISOString() },
      { label: 'Weekly', usedPct: w, resetsAt: new Date(Date.now() + 40 * 3600_000).toISOString() }
    ],
    fetchedAt: Date.now(),
    health: 'fresh'
  })

  // (e) runs in MAIN over the CSS source: no `.usage` rule may reach var(--r-md) on a
  // non-radius property (the `.workspace-tab` inset that legitimately does is not a
  // `.usage` selector, so it is correctly ignored).
  const rmdScopedOk = (): { ok: boolean; offenders: string[] } => {
    const offenders: string[] = []
    try {
      const css = readFileSync(join(app.getAppPath(), 'src', 'ui', 'styles', 'global.css'), 'utf8')
      let sel = ''
      for (const raw of css.split('\n')) {
        const t = raw.trim()
        if (t.endsWith('{')) sel = t.slice(0, -1).trim()
        if (t.includes('var(--r-md') && sel.includes('.usage')) {
          const prop = t.split(':')[0].trim().toLowerCase()
          if (prop !== 'border-radius' && !prop.endsWith('-radius')) offenders.push(`${sel} :: ${t}`)
        }
      }
    } catch (e) {
      offenders.push(`read failed: ${String(e)}`)
    }
    return { ok: offenders.length === 0, offenders }
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      const svc = getUsageService()
      if (!svc) throw new Error('usage service not registered')

      // A CALM snapshot: nothing hot, nothing errored — no card earns attention.
      fixture([plan('Fake Pro', 42, 18)])
      await waitTrue(`document.querySelectorAll('.usage-class-group').length >= 5`, 60, 200)
      await openUsage()

      // (a) OVERVIEW-ONLY. Fold anything the boot snapshot may have opened, persist that,
      // then reopen: the band is present and every Card is folded under calm data.
      await ES(`document.querySelectorAll('.usage-tab .collapsible-card.is-open .cc-toggle').forEach((b) => b.click())`)
      await sleep(150)
      await leave()
      await openUsage()
      const overviewShown = await ES<boolean>(`!!document.querySelector('.usage-tab .usage-overview')`)
      const openStates = await Promise.all(CARDS.map((id) => cardOpen(id)))
      const overviewOnly = overviewShown && openStates.every((o) => !o)

      // (a) persistence: hand-expand Plans; leave/return; still open, Providers still shut.
      await toggle('plans')
      await sleep(150)
      await leave()
      await openUsage()
      const persistOk = (await cardOpen('plans')) && !(await cardOpen('providers'))
      await toggle('plans') // fold it again for the rest

      // (c) hooks resolve THROUGH the folded cards; the one-home singletons stay singular.
      const hooksOk = await waitTrue(`(() => {
        const q = (s) => document.querySelector(s), n = (s) => document.querySelectorAll(s).length
        return n('.usage-class-group') >= 5 && !!q('.usage-prov-row') && !!q('.usage-search') &&
          !!q('.usage-plan-row') && !!q('.usage-display-reset') && !!q('.usage-privacy-block') &&
          !!q('.usage-alert-cfg .usage-thr-warn') &&
          n('.usage-display-cfg') === 1 && n('.usage-alert-cfg') === 1 && n('.usage-pace-cfg') === 1 &&
          n('.usage-stub-row') === 0
      })()`)

      // (b) a HOT fixture opens Providers and posts .usage-fill.is-hot on its header.
      fixture([plan('Fake Pro (hot)', 96, 91)])
      const hotHeader = `.collapsible-card[data-collapsible="providers"] .cc-attn .usage-fill.is-hot`
      const attnShown = await waitTrue(`!!document.querySelector('${hotHeader}')`, 50, 200)
      const providersAutoOpen = await cardOpen('providers')
      const hotOk = attnShown && providersAutoOpen

      // (d) the popover gauge track + foot border participate in the theme (bug #4).
      await ES(`window.__mogging.setTheme('midnight')`)
      await sleep(200)
      await ES(`window.__mogging.usage.open()`)
      await sleep(250)
      const readColors = (): Promise<{ track: string; foot: string }> =>
        ES(`(() => {
          const tr = document.querySelector('.usage-gauge .usage-track'), ft = document.querySelector('.usage-foot')
          return { track: tr ? getComputedStyle(tr).backgroundColor : '', foot: ft ? getComputedStyle(ft).borderTopColor : '' }
        })()`)
      const dark = await readColors()
      await ES(`window.__mogging.setTheme('light')`)
      await sleep(300)
      const light = await readColors()
      await ES(`window.__mogging.setTheme('midnight')`)
      await ES(`window.__mogging.usage.close()`)
      const themeOk = !!dark.track && !!dark.foot && dark.track !== light.track && dark.foot !== light.foot

      // (e) bug #5 regression: no var(--r-md on a non-radius property in any .usage rule.
      const rmd = rmdScopedOk()

      // (f) the profile form wears FieldGroup labels; a secret is refused inline.
      await ES(`(document.querySelector('.settings-nav-item[data-target="profiles"]')?.click(), 1)`)
      await sleep(300)
      await ES(`document.querySelector('button[aria-label="Add profile"]')?.click()`)
      await sleep(300)
      const labelsOk = await ES<boolean>(`document.querySelectorAll('.ph-form .field-group-label').length >= 3`)
      await ES(`(() => {
        const set = (s, v) => { const i = document.querySelector(s); if (i) { i.value = v; i.dispatchEvent(new Event('input')) } }
        set('.prof-name', 'Smoke')
        set('.prof-env-key', 'FAKE_KEY')
        set('.prof-env-val', 'sk-THISLOOKSLIKEASECRET1234567890')
        const b = document.querySelector('button[aria-label="Save profile"]'); if (b) b.click()
      })()`)
      const refusalOk = await waitTrue(
        `(() => { const e = document.querySelector('.settings-error'); return !!(e && !e.hidden && /secret/i.test(e.textContent || '')) })()`,
        20,
        200
      )
      const formOk = labelsOk && refusalOk

      delete process.env.MOGGING_USAGE_FIXTURE
      getUsageService()?.refresh()

      const pass = overviewOnly && persistOk && hooksOk && hotOk && themeOk && rmd.ok && formOk
      result = {
        pass,
        overviewOnly,
        overviewShown,
        openStates,
        persistOk,
        hooksOk,
        hotOk,
        attnShown,
        providersAutoOpen,
        themeOk,
        dark,
        light,
        rmdOk: rmd.ok,
        rmdOffenders: rmd.offenders,
        labelsOk,
        refusalOk
      }
    } catch (e) {
      result = { pass: false, error: e instanceof Error ? e.message : String(e) }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'setusage-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}
