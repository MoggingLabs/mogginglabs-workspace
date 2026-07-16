import { app, type BrowserWindow } from 'electron'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeContrastAcrossThemes } from './aa-probe'

// Env-gated Home + first-run smoke (MOGGING_HOMEUX, Phase-8.5/06). Fresh userData.
//   (a) the hero + a house EmptyState render; the hero CTA opens the wizard;
//   (b) checklist rows are detection-HONEST, in both directions: row ①'s done-state equals
//       real PATH detection, the install rows are EXACTLY the CLIs that are really missing
//       (here: none — asserted as absence), and an agent forced to read as missing renders
//       the install row it promises, with its command and a copy chip that carries it;
//   (c) a seeded recent renders as a Card and reopens the workspace on click;
//   (d) bug #1: with every REQUIRED row done and NOTHING saved by fixture, the card
//       self-dismisses and never returns. Detection is real (no fixture), so where a CLI
//       is installed we assert the dismiss; where none is, the card HONESTLY stays — the
//       checklist must never fake a tick (the whole point of 6/01). Either way the OLD
//       immortal-checklist bug (a non-optional power-up row, now REMOVED #21) is gone.
//   (e) MEASURED, not claimed: hero→grid gap >= --sp-6, recent-card padding >= --sp-4;
//   (f) AA >= 4.5 on the card text in all four themes, via the shared src/main/aa-probe.ts.
//   (g) audit 34 — the IA contract: opening a recent lands on the GRID (never back on
//       Home — view-port.ts enforces the invariant both ways), and there is NO titlebar
//       Home affordance, by design. Home is the boot launcher and the zero-workspace
//       empty state; its recents and presets are fully covered by the wizard;
//   (h) the zero-workspace LOCKDOWN (2026-07-16/17), both edges: at boot (no
//       workspaces) the rail does not render and all THREE chrome toggles — rail,
//       file explorer, browser — read disabled with the REASON in their tooltips
//       ("create a workspace first"), the explorer un-OPENABLE at the capability
//       (toggle() refuses; the button is just the visible half). With a workspace
//       the toggles wake (tooltips back to their shortcut forms) and the explorer
//       truly opens. Closing the LAST workspace returns Home, force-closes the
//       docks, and re-arms the lockdown.
export function runHomeUxSmoke(win: BrowserWindow): void {
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

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      await sleep(1500)
      await ES(`try{localStorage.removeItem('mogging.firstrun.dismissed')}catch{}`)
      await ES(`window.__mogging.firstrun && window.__mogging.firstrun.refresh()`)
      await ES(`window.__mogging.home && window.__mogging.home.refresh()`)
      await waitTrue(`document.querySelectorAll('.firstrun-row').length >= 3`)

      // (a) hero + a house EmptyState with a CTA (fresh boot: no recents yet).
      const heroOk = await ES<boolean>(`!!document.querySelector('#view-home .home-hero')`)
      const emptyOk = await waitTrue(
        `!!document.querySelector('.home-recents-grid .empty-state') && !!document.querySelector('.home-recents-grid .empty-state button')`
      )

      // (h) BOOT half of the zero-workspace lockdown: no rail rendered, all THREE
      // chrome toggles (rail · explorer · browser) disabled WITH the reason in their
      // tooltips, and the explorer un-openable at the CAPABILITY — the dev handle
      // drives the same toggle() every door (button/shortcut/palette) uses.
      const bootLock = await ES<{
        railHidden: boolean
        railToggleDisabled: boolean
        explorerDisabled: boolean
        browserDisabled: boolean
        explorerRefused: boolean
        tooltipsExplain: boolean
      }>(`(() => {
        const railEl = document.getElementById('rail')
        const railBtn = document.querySelector('#titlebar .rail-toggle')
        const expBtn = document.querySelector('#titlebar .explorer-toggle')
        const webBtn = document.querySelector('.titlebar-right button[aria-label="Browser"]')
        window.__mogging.explorer.toggle(true)
        return {
          railHidden: !railEl || railEl.offsetParent === null,
          railToggleDisabled: railBtn?.disabled === true,
          explorerDisabled: expBtn?.disabled === true,
          browserDisabled: webBtn?.disabled === true,
          explorerRefused: window.__mogging.explorer.isOpen() === false,
          tooltipsExplain: [railBtn, expBtn, webBtn].every((b) => /create a workspace first/i.test(b?.title ?? ''))
        }
      })()`)
      const bootLockOk =
        bootLock.railHidden &&
        bootLock.railToggleDisabled &&
        bootLock.explorerDisabled &&
        bootLock.browserDisabled &&
        bootLock.explorerRefused &&
        bootLock.tooltipsExplain

      // (b) the checklist is detection-honest, in BOTH directions.
      type Agent = { id: string; name: string; installed: boolean; installHint?: string }
      const agents = await ES<Agent[]>(`window.bridge.invoke('agents:detect')`)
      const anyCli = agents.some((a) => a.installed)
      const cliRowDone = await ES<boolean>(`!!document.querySelectorAll('.firstrun-row')[0]?.classList.contains('is-done')`)
      const cliHonest = cliRowDone === anyCli

      // (b1) The install rows are EXACTLY the CLIs that are really missing — no more, no fewer.
      // On this machine every CLI is installed, so the honest answer is NO rows, and that is
      // asserted here as a positive claim. The gate used to demand a row unconditionally, i.e.
      // it demanded the checklist lie; it "passed" only where the CLIs were absent.
      const trulyMissing = agents.filter((a) => !a.installed && a.installHint)
      const rowsWhenNoneMissing = await ES<number>(`document.querySelectorAll('.firstrun-cli-missing').length`)
      const missingHonest = rowsWhenNoneMissing === trulyMissing.length

      // (b2) The OTHER branch — the one a new user actually meets, and the one no machine here
      // can reach by itself. Force an installed agent to read as missing through the DEV seam
      // (firstrun.forceMissing fakes the detection INPUT only) and hold the real render path to
      // its promise: one new row, naming that agent, carrying its install command verbatim, with
      // a copy chip that would copy exactly that command.
      const victim = agents.find((a) => a.installed && a.installHint) ?? agents.find((a) => a.installHint)
      if (!victim) throw new Error('no agent adapter carries an installHint — the row can never render')
      await ES(`window.__mogging.firstrun.forceMissing([${JSON.stringify(victim.id)}])`)
      await ES(`window.__mogging.firstrun.refresh()`)
      const row = await (async (): Promise<{ found: boolean; rows: number; cmd: string; copy: boolean; copies: string }> => {
        for (let i = 0; i < 25; i++) {
          const r = await ES<{ found: boolean; rows: number; cmd: string; copy: boolean; copies: string }>(`(() => {
            const rows = [...document.querySelectorAll('.firstrun-cli-missing')]
            const r = rows.find((x) => (x.querySelector('.firstrun-cli-name')?.textContent || '') === ${JSON.stringify(victim.name)})
            const copy = r ? r.querySelector('.firstrun-copy') : null
            return {
              found: !!r,
              rows: rows.length,
              cmd: r ? (r.querySelector('.firstrun-cli-cmd')?.textContent || '') : '',
              copy: !!copy,
              copies: copy ? (copy.title || '') : ''
            }
          })()`)
          if (r.found) return r
          await sleep(200)
        }
        return { found: false, rows: 0, cmd: '', copy: false, copies: '' }
      })()
      // The chip is asserted by what it WOULD copy (its title is the command it writes to the
      // clipboard). Clicking it would clobber the clipboard of whoever is running this.
      const installChipOk =
        row.found &&
        row.rows === trulyMissing.length + (victim.installed ? 1 : 0) &&
        row.cmd === victim.installHint &&
        row.copy &&
        row.copies === victim.installHint

      // Seed a recent, then re-read Home.
      const anchor = mkdtempSync(join(tmpdir(), 'mog-homeux-'))
      const state = {
        workspaces: [],
        activeId: null,
        theme: 'midnight',
        recents: [{ name: 'Seeded', cwd: anchor, paneCount: 2, assignments: ['claude', 'shell'], lastUsedAt: Date.now() - 3 * 3600_000 }]
      }
      await ES(`window.bridge.invoke('workspace:saveState', ${JSON.stringify(state)})`)
      await ES(`window.__mogging.home.refresh()`)
      const cardOk = await waitTrue(
        `!!document.querySelector('.home-recent') && /Seeded/.test(document.querySelector('.home-recent-name')?.textContent || '')`
      )

      // (e) measured spacing on the real box.
      const measured = await ES<{ gap: number; pad: number; sp6: number; sp4: number }>(`(() => {
        const gap = parseFloat(getComputedStyle(document.querySelector('#view-home')).rowGap) || 0
        const card = document.querySelector('.home-recent')
        const pad = card ? parseFloat(getComputedStyle(card).paddingTop) : 0
        const sp6 = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sp-6')) || 0
        const sp4 = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sp-4')) || 0
        return { gap, pad, sp6, sp4 }
      })()`)
      const spacingOk = measured.gap >= measured.sp6 - 0.5 && measured.pad >= measured.sp4 - 0.5

      // (f) AA on the card text, four themes, via the shared probe (which owns the freeze).
      // .firstrun-cli-cmd is measured on the row (b2) forced into existence — before this, the
      // selector matched nothing here and the probe scored a contrast nobody was reading.
      const PROBES = ['.home-recent-name', '.home-recent-path', '.home-recent-when', '.home-recent-chip', '.firstrun-row-title', '.firstrun-cli-cmd']
      const aa = await probeContrastAcrossThemes({ es: ES, sleep, selectors: PROBES })
      const aaOk = aa.failures.length === 0 && aa.missing.length === 0

      // Detection is honest again for everything below — (d) turns on what is REALLY installed.
      await ES(`window.__mogging.firstrun.forceMissing([])`)
      await ES(`window.__mogging.firstrun.refresh()`)
      await sleep(300)

      // (c) the recent Card reopens the workspace on click.
      const wsBefore = await ES<number>(`window.__mogging.workspace.list().length`)
      await ES(`document.querySelector('.home-recent').click()`)
      const openedOk = await waitTrue(`window.__mogging.workspace.list().length > ${wsBefore}`, 30, 200)

      // (g) audit 34 — the navigation contract, RATIFIED. Home and the grid are the two
      // halves of ONE invariant: exactly one of them can be right, and the workspace
      // count decides which. A workspace now exists (from (c)), so the app must be on
      // the GRID and Home must be gone — view-port.ts:41 sends every road to Home
      // there, because an empty grid was a dead end (UX-16) and a permanent Home
      // entry is its mirror image: a door to a room that is no longer furnished.
      const gridOk = await waitTrue(
        `document.querySelector('#app').classList.contains('view-grid') && !document.querySelector('#app').classList.contains('view-home')`,
        30,
        200
      )
      // ...and the static half of the same contract: there is NO titlebar Home
      // affordance, BY DESIGN (titlebar.ts says so in a comment; this says so in a
      // gate). Recents and presets — the only two things Home carries — are fully
      // duplicated by the wizard, which is reachable at any time (Ctrl+T), so a Home
      // button would buy nothing and re-open the dead end a prior audit closed. A
      // future half-applied "add a Home button" change trips HERE, not in production.
      const noHomeBtn = await ES<boolean>(
        `!document.querySelector('.titlebar-right [aria-label="Home" i]') && !document.querySelector('.titlebar-right [title="Home" i]')`
      )

      // (d) bug #1: required rows done (a workspace now exists from (c)), NOTHING saved by
      // fixture → the card self-dismisses & stays gone where a CLI is installed; else it
      // honestly stays (row ① truthfully undone).
      await ES(`try{localStorage.removeItem('mogging.firstrun.dismissed')}catch{}`)
      await ES(`window.__mogging.firstrun.refresh()`)
      await sleep(500)
      let dismissOk = false
      if (anyCli) {
        dismissOk = await waitTrue(`document.querySelector('.firstrun-card').hidden === true`, 30, 200)
        await ES(`window.__mogging.firstrun.refresh()`)
        await sleep(300)
        dismissOk = dismissOk && (await ES<boolean>(`document.querySelector('.firstrun-card').hidden === true`))
      } else {
        dismissOk = await ES<boolean>(`document.querySelector('.firstrun-card').hidden === false`)
      }

      // (a cont.) the hero CTA opens the wizard (terminal — this navigates to the wizard page).
      await ES(`[...document.querySelectorAll('.home-hero button')].find((b) => /New workspace/.test(b.textContent))?.click()`)
      const wizardOk = await waitTrue(
        `!!document.querySelector('#content.view-wizard') || (!!document.querySelector('#view-wizard') && getComputedStyle(document.querySelector('#view-wizard')).display !== 'none')`,
        20,
        200
      )

      // (h) LIVE half: with a workspace (from (c)) the toggles are awake — their
      // tooltips back to the shortcut forms — and the explorer truly opens…
      const awake = await ES<{
        railToggleEnabled: boolean
        explorerEnabled: boolean
        browserEnabled: boolean
        explorerOpens: boolean
        tooltipsRestored: boolean
      }>(`(() => {
        const railBtn = document.querySelector('#titlebar .rail-toggle')
        const expBtn = document.querySelector('#titlebar .explorer-toggle')
        const webBtn = document.querySelector('.titlebar-right button[aria-label="Browser"]')
        window.__mogging.explorer.toggle(true)
        return {
          railToggleEnabled: railBtn?.disabled === false,
          explorerEnabled: expBtn?.disabled === false,
          browserEnabled: webBtn?.disabled === false,
          explorerOpens: window.__mogging.explorer.isOpen() === true,
          tooltipsRestored: [railBtn, expBtn, webBtn].every((b) => /Ctrl\\+Shift\\+[BEU]/.test(b?.title ?? ''))
        }
      })()`)
      // …and closing the LAST workspace returns Home, force-closes the explorer
      // (without erasing its open preference), and re-arms the whole lockdown.
      // Real close verb — the same door the rail ✕ uses; idle shells skip the
      // live-work confirm, but click it defensively if this host says otherwise.
      await ES(`window.__mogging.workspace.list().forEach((w) => window.__mogging.workspace.close(w.id))`)
      await ES(`document.querySelector('.modal-overlay .btn--danger')?.click()`)
      const homeReturned = await waitTrue(
        `document.querySelector('#app').classList.contains('view-home') && (window.__mogging.workspace.count() === 0)`,
        30,
        200
      )
      const relock = await ES<{
        railToggleDisabled: boolean
        explorerDisabled: boolean
        browserDisabled: boolean
        explorerClosed: boolean
      }>(`(() => {
        window.__mogging.explorer.toggle(true)
        return {
          railToggleDisabled: document.querySelector('#titlebar .rail-toggle')?.disabled === true,
          explorerDisabled: document.querySelector('#titlebar .explorer-toggle')?.disabled === true,
          browserDisabled: document.querySelector('.titlebar-right button[aria-label="Browser"]')?.disabled === true,
          explorerClosed: window.__mogging.explorer.isOpen() === false
        }
      })()`)
      const lockdownOk =
        awake.railToggleEnabled &&
        awake.explorerEnabled &&
        awake.browserEnabled &&
        awake.explorerOpens &&
        awake.tooltipsRestored &&
        homeReturned &&
        relock.railToggleDisabled &&
        relock.explorerDisabled &&
        relock.browserDisabled &&
        relock.explorerClosed

      const pass =
        heroOk &&
        emptyOk &&
        cliHonest &&
        missingHonest &&
        installChipOk &&
        cardOk &&
        spacingOk &&
        aaOk &&
        openedOk &&
        gridOk &&
        noHomeBtn &&
        dismissOk &&
        wizardOk &&
        bootLockOk &&
        lockdownOk
      result = {
        pass,
        bootLockOk,
        bootLock,
        lockdownOk,
        awake,
        homeReturned,
        relock,
        heroOk,
        emptyOk,
        anyCli,
        cliRowDone,
        cliHonest,
        missingHonest,
        trulyMissing: trulyMissing.map((a) => a.id),
        forcedMissing: victim.id,
        row,
        installChipOk,
        cardOk,
        measured,
        spacingOk,
        aaOk,
        aaFailures: aa.failures,
        aaMissing: aa.missing,
        aaWorst: aa.worst,
        openedOk,
        gridOk,
        noHomeBtn,
        dismissOk,
        wizardOk
      }
    } catch (e) {
      result = { pass: false, error: e instanceof Error ? e.message : String(e) }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'homeux-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}
