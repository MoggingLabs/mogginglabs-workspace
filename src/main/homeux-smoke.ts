import { app, type BrowserWindow } from 'electron'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeContrastAcrossThemes } from './aa-probe'

// Env-gated Home + first-run smoke (MOGGING_HOMEUX, Phase-8.5/06). Fresh userData.
//   (a) the hero + a house EmptyState render; the hero CTA opens the wizard;
//   (b) checklist rows are detection-HONEST — a missing CLI shows an install row + a
//       copy chip, and row ①'s done-state equals real PATH detection (never a fixed answer);
//   (c) a seeded recent renders as a Card and reopens the workspace on click;
//   (d) bug #1: with every REQUIRED row done and NOTHING saved by fixture, the card
//       self-dismisses and never returns. Detection is real (no fixture), so where a CLI
//       is installed we assert the dismiss; where none is, the card HONESTLY stays — the
//       checklist must never fake a tick (the whole point of 6/01). Either way the OLD
//       immortal-checklist bug (a non-optional power-up row, now REMOVED #21) is gone.
//   (e) MEASURED, not claimed: hero→grid gap >= --sp-6, recent-card padding >= --sp-4;
//   (f) AA >= 4.5 on the card text in all four themes, via the shared src/main/aa-probe.ts.
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

      // (b) the checklist is detection-honest: row ① tracks real PATH detection, and a
      // missing CLI carries an install row + a copy chip.
      const anyCli = await ES<boolean>(`window.bridge.invoke('agents:detect').then((a) => (a||[]).some((x) => x.installed))`)
      const cliRowDone = await ES<boolean>(`!!document.querySelectorAll('.firstrun-row')[0]?.classList.contains('is-done')`)
      const cliHonest = cliRowDone === anyCli
      const installChipOk = await ES<boolean>(`!!document.querySelector('.firstrun-cli-missing .firstrun-copy')`)

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
      const PROBES = ['.home-recent-name', '.home-recent-path', '.home-recent-when', '.home-recent-chip', '.firstrun-row-title', '.firstrun-cli-cmd']
      const aa = await probeContrastAcrossThemes({ es: ES, sleep, selectors: PROBES })
      const aaOk = aa.failures.length === 0 && aa.missing.length === 0

      // (c) the recent Card reopens the workspace on click.
      const wsBefore = await ES<number>(`window.__mogging.workspace.list().length`)
      await ES(`document.querySelector('.home-recent').click()`)
      const openedOk = await waitTrue(`window.__mogging.workspace.list().length > ${wsBefore}`, 30, 200)

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

      const pass = heroOk && emptyOk && cliHonest && installChipOk && cardOk && spacingOk && aaOk && openedOk && dismissOk && wizardOk
      result = {
        pass,
        heroOk,
        emptyOk,
        anyCli,
        cliRowDone,
        cliHonest,
        installChipOk,
        cardOk,
        measured,
        spacingOk,
        aaOk,
        aaFailures: aa.failures,
        aaMissing: aa.missing,
        aaWorst: aa.worst,
        openedOk,
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
