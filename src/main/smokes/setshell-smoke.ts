import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { probeContrastAcrossThemes } from './aa-probe'

// Env-gated Settings-shell smoke (MOGGING_SETSHELL, Phase-8.5/04). Asserts:
//   (a) the nav renders all nine tabs with an icon each, under four group heads,
//       and the selection survives a leave/return (the persisted tab key);
//   (b) MEASURED, not claimed: the content column is capped, card padding >= --sp-4,
//       and two adjacent FieldGroups sit >= --sp-3 apart;
//   (c) every tab still switches by `.settings-nav-item[data-target=…]` click, and
//       exactly one `.settings-section` is un-hidden — the contract KBSHORTCUTS,
//       USAGESET, INTEGUX, WEBTRAIL and the gallery all key off;
//   (d) a theme change from the Appearance card still applies live;
//   (e) AA CONTRAST, in all four themes, on every text class the shell introduces.
//
// (e) needed a WCAG probe. There wasn't one: the prompt says to "reuse the Phase-5
// contrast probe helper", and no such helper exists — `git log -S luminance` finds
// one commit whose only surviving trace is prose in docs/11 and comments in
// global.css. Every AA number in this repo has been a claim, never a check. So the
// probe ships here: sRGB linearization, relative luminance, and real alpha
// compositing up the ancestor chain (the nav's active fill is `--accent-weak`,
// an rgba() — measuring it against `transparent` would score it as pure black).

/**
 * Everything the 8.5/04 shell puts words on, plus the error ink it repoints.
 * `.card-title` is deliberately absent: Card only emits it for the `title` shorthand,
 * and every card here passes an explicit `header`. Probing it would read `null` in
 * every theme, and the `missing` guard below would (correctly) call that a rotted
 * selector rather than a pass.
 */
const PROBES = [
  '.settings-section-head .section-header-title',
  '.settings-section-head .section-header-caption',
  '.settings-nav-group',
  '.settings-nav-item:not(.is-active)', // distinct nodes: the active item is first in DOM,
  '.settings-nav-item.is-active', // so a bare `.settings-nav-item` would measure it twice
  '.card .section-header-title',
  '.card .section-header-caption',
  '.card-caption',
  '.field-group-label',
  '.field-group-hint',
  '.toggle-row-label',
  '.toggle-row-hint',
  '.settings-scope',
  '.settings-probe-error' // a .settings-error clone, injected: it only renders on a failed save
]

export function runSetShellSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 150000) // safety net
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  // Section order (the DOM order of `.settings-section`).
  const TABS = ['appearance', 'terminal', 'clipboard', 'providers', 'profiles', 'usage', 'integrations', 'webhooks', 'privacy', 'browser', 'activity', 'account', 'shortcuts', 'about']
  // Nav order — GROUPED, so it is deliberately not the section order. Asserting both
  // catches a tab that vanishes from the rail while its section still exists.
  // 'account' joined the Trust group with phase-accounts (Settings › Account — the
  // claims-only plan panel, docs/19); this list rotted for one sweep because no
  // post-accounts battery carried SETSHELL.
  const NAV_ORDER = ['appearance', 'terminal', 'clipboard', 'providers', 'profiles', 'integrations', 'usage', 'webhooks', 'privacy', 'browser', 'activity', 'account', 'shortcuts', 'about']

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      await sleep(1500)
      await ES(`(document.querySelector('.titlebar-right .icon-btn[aria-label="Settings"]')?.click(), 1)`)
      await sleep(700)

      // ── (a) the nav is a map: every tab, an icon each, four group heads ──────
      const nav = await ES<{ items: string[]; withIcon: number; groups: string[]; backBtn: boolean }>(`(() => {
        const items = [...document.querySelectorAll('.settings-nav-item')]
        return {
          items: items.map((b) => b.dataset.target),
          withIcon: items.filter((b) => b.querySelector('svg')).length,
          groups: [...document.querySelectorAll('.settings-nav-group')].map((g) => g.textContent),
          backBtn: !!document.querySelector('.settings-back')
        }
      })()`)
      const navOk =
        JSON.stringify(nav.items) === JSON.stringify(NAV_ORDER) && // grouped order
        JSON.stringify([...nav.items].sort()) === JSON.stringify([...TABS].sort()) && // no tab lost
        nav.withIcon === TABS.length &&
        JSON.stringify(nav.groups) === JSON.stringify(['Workspace', 'Agents & tools', 'Trust', 'System']) &&
        nav.backBtn

      // ── (c) every tab switches, and exactly one section is visible ───────────
      const switched: Record<string, { visible: string[]; active: string | null }> = {}
      for (const id of TABS) {
        await ES(`document.querySelector('.settings-nav-item[data-target="${id}"]').click()`)
        await sleep(120)
        switched[id] = await ES(`(() => ({
          visible: [...document.querySelectorAll('.settings-section')].filter((s) => !s.hidden).map((s) => s.dataset.section),
          active: document.querySelector('.settings-nav-item.is-active')?.dataset.target ?? null
        }))()`)
      }
      const tabsOk = TABS.every((id) => switched[id].visible.length === 1 && switched[id].visible[0] === id && switched[id].active === id)

      // ── (a cont.) the chosen tab survives a leave/return ─────────────────────
      await ES(`document.querySelector('.settings-nav-item[data-target="browser"]').click()`)
      await sleep(200)
      const storedTab = await ES<string | null>(`localStorage.getItem('mogging.settingsTab')`)
      await ES(`document.querySelector('.settings-back').click()`) // leave
      await sleep(400)
      await ES(`(document.querySelector('.titlebar-right .icon-btn[aria-label="Settings"]')?.click(), 1)`)
      await sleep(500)
      const restored = await ES<string | null>(`document.querySelector('.settings-nav-item.is-active')?.dataset.target ?? null`)
      const persistOk = storedTab === 'browser' && restored === 'browser'

      // ── (b) the spacing CLAIM, measured on a light tab ───────────────────────
      await ES(`document.querySelector('.settings-nav-item[data-target="terminal"]').click()`)
      await sleep(250)
      const spacing = await ES<{ colMax: number; pagePad: number; cardPad: number; fgGap: number; groups: number }>(`(() => {
        const main = document.querySelector('.settings-page > .two-column-main')
        const page = document.querySelector('.settings-page')
        const card = document.querySelector('.settings-section[data-section="terminal"] .card')
        const body = card.querySelector('.card-body')
        return {
          colMax: parseFloat(getComputedStyle(main).maxWidth),
          pagePad: parseFloat(getComputedStyle(page).paddingLeft),
          cardPad: parseFloat(getComputedStyle(card).paddingTop),
          fgGap: parseFloat(getComputedStyle(body).rowGap),
          groups: body.querySelectorAll(':scope > .field-group').length
        }
      })()`)
      // --sp-6 page padding, --sp-4 card padding, >= --sp-3 between sibling knobs.
      const spacingOk =
        spacing.colMax > 0 && spacing.pagePad >= 32 && spacing.cardPad >= 16 && spacing.fgGap >= 12 && spacing.groups === 2

      // ── (d) the theme still applies live from the Appearance card ────────────
      await ES(`document.querySelector('.settings-nav-item[data-target="appearance"]').click()`)
      await sleep(200)
      const before = await ES<string>(`getComputedStyle(document.documentElement).getPropertyValue('--bg-app')`)
      await ES(`(() => {
        const grid = document.querySelector('.settings-section[data-section="appearance"] .theme-grid')
        const btn = [...grid.querySelectorAll('.theme-tile')].find((b) => /light/i.test(b.querySelector('.theme-tile-name').textContent))
        btn.click()
      })()`)
      await sleep(400)
      const after = await ES<string>(`getComputedStyle(document.documentElement).getPropertyValue('--bg-app')`)
      const themeLiveOk = before.trim() !== after.trim() && !!after.trim()

      // ── (e) AA contrast, every theme, every text class the shell introduces ──
      // A `.settings-error` only exists after a failed profile save, so its class is
      // measured on a clone parked in the same card it would render in.
      await ES(`(() => {
        const host = document.querySelector('.settings-section[data-section="appearance"] .card-body')
        if (!document.querySelector('.settings-probe-error')) {
          const p = document.createElement('p')
          p.className = 'settings-error settings-probe-error'
          p.textContent = 'probe'
          host.append(p)
        }
      })()`)

      // The probe — sRGB linearization, alpha compositing, AND the transition freeze
      // that once made this very check read a fade frame — is src/main/aa-probe.ts now.
      // 06 extracted it without SETSHELL losing a measured number; the freeze is no
      // longer something this caller has to remember.
      const { contrast, failures, missing, worst } = await probeContrastAcrossThemes({ es: ES, sleep, selectors: PROBES })
      const contrastOk = failures.length === 0 && missing.length === 0
      await ES(`document.querySelector('.settings-probe-error')?.remove()`)

      // Settings § About IS the update surface (no dedicated Updates tab — that is the
      // convention for an app this size: Obsidian, GitHub Desktop, Chrome). The card must
      // carry the version, a check button, the last-checked line and BOTH toggles.
      //
      // The last-checked line is the one that must never quietly disappear. A dead feed and a
      // healthy-but-quiet feed are both SILENCE; only a timestamp tells them apart, and its
      // absence is exactly how a 404ing updater survived nine releases. If a future refactor
      // tidies it away, this fails.
      await ES(`document.querySelector('.settings-nav-item[data-target="about"]').click()`)
      await sleep(200)
      const updates = await ES<{ version: boolean; check: boolean; checked: boolean; toggles: number }>(
        `(() => {
           const root = document.querySelector('.settings-section[data-section="about"]')
           if (!root) return { version: false, check: false, checked: false, toggles: -1 }
           return {
             version: !!root.querySelector('.update-version'),
             check: [...root.querySelectorAll('button')].some(b => /Check for updates/i.test(b.textContent||'')),
             checked: !!root.querySelector('.update-checked'),
             toggles: [...root.querySelectorAll('.switch-input')].length
           }
         })()`
      )
      // Two toggles, and only two: pre-release + install-on-quit. A third appearing here is
      // very likely the "turn updates off" switch this design deliberately refuses to ship.
      const updatesOk = updates.version && updates.check && updates.checked && updates.toggles === 2

      const pass = navOk && tabsOk && persistOk && spacingOk && themeLiveOk && contrastOk && updatesOk
      result = {
        pass,
        navOk,
        nav,
        updatesOk,
        updates,
        tabsOk,
        switched,
        persistOk,
        storedTab,
        restored,
        spacingOk,
        spacing,
        themeLiveOk,
        before: before.trim(),
        after: after.trim(),
        contrastOk,
        failures,
        missing,
        worst,
        contrast
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'setshell-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}
