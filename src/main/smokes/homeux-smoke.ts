import { app, type BrowserWindow } from 'electron'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeContrastAcrossThemes } from './aa-probe'

// Env-gated Home + first-run smoke (MOGGING_HOMEUX, Phase-8.5/06; recut for the
// last-session restore card). Fresh userData.
//   (a) the hero + a house EmptyState render — and the empty card carries NO button
//       (the hero's "New workspace" directly above is the ONE road; a second copy in
//       the card was removed on review, and this asserts the absence so it cannot
//       quietly come back); the hero CTA opens the wizard;
//   (b) checklist rows are detection-HONEST, in both directions: row ①'s done-state equals
//       real PATH detection, the install rows are EXACTLY the CLIs that are really missing
//       (here: none — asserted as absence), and an agent forced to read as missing renders
//       the install row it promises, with its command and a copy chip that carries it;
//   (c) the restore card is fed by the REAL pipeline, not a fixture: a non-empty
//       workspace:saveState mirrors into the snapshot, the empty save that follows HOLDS it
//       (shrink-hold — session-restore.ts), and Home renders the held session: both
//       workspaces, honest totals;
//   (d) bug #1: with every REQUIRED row done and NOTHING saved by fixture, the card
//       self-dismisses and never returns. Detection is real (no fixture), so where a CLI
//       is installed we assert the dismiss; where none is, the card HONESTLY stays — the
//       checklist must never fake a tick (the whole point of 6/01). Either way the OLD
//       immortal-checklist bug (a non-optional power-up row, now REMOVED #21) is gone.
//   (e) MEASURED, not claimed: hero→grid gap >= --sp-6, restore-card padding >= --sp-4;
//   (f) AA >= 4.5 on the card text in all four themes, via the shared src/main/aa-probe.ts.
//   (g) audit 34 — the IA contract: clicking Restore rebuilds EVERY workspace of the held
//       session and lands on the GRID (never back on Home — view-port.ts enforces the
//       invariant both ways), and there is NO titlebar Home affordance, by design. Home is
//       the boot launcher and the zero-workspace empty state; recents and presets live in
//       the wizard, and Home's own offer is the one thing the wizard can't do: put the
//       whole previous session back.
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

      // (a) hero + a house EmptyState (fresh boot: no snapshot yet) — with NO button
      // inside it. The error state's Retry is a different EmptyState (ASYNCSTATE owns
      // it); the CALM one is a sentence, and the hero above is the one new-workspace
      // road. Asserting absence is what makes the removal permanent.
      const heroOk = await ES<boolean>(`!!document.querySelector('#view-home .home-hero')`)
      const emptyOk = await waitTrue(
        `(() => { const e = document.querySelector('.home-resume .empty-state'); return !!e && !e.querySelector('button') })()`
      )

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

      // (c) Seed the snapshot through the REAL pipeline — no fixture, no store poke. A
      // non-empty save mirrors into the snapshot; the empty save that follows is the
      // teardown and must HOLD it (shrink-hold). This is exactly a user closing their
      // last workspaces: the store empties, the session survives.
      const anchorA = mkdtempSync(join(tmpdir(), 'mog-homeux-a-'))
      const anchorB = mkdtempSync(join(tmpdir(), 'mog-homeux-b-'))
      const working = {
        workspaces: [
          {
            id: 'homeux-alpha',
            name: 'Alpha',
            color: '#4cc38a',
            cwd: anchorA,
            ordinal: 1,
            paneCount: 2,
            assignments: ['claude', 'shell']
          },
          {
            id: 'homeux-bravo',
            name: 'Bravo',
            color: '#3b9eff',
            cwd: anchorB,
            ordinal: 2,
            paneCount: 1
          }
        ],
        activeId: 'homeux-alpha',
        theme: 'midnight'
      }
      await ES(`window.bridge.invoke('workspace:saveState', ${JSON.stringify(working)})`)
      const empty = { workspaces: [], activeId: null, theme: 'midnight' }
      await ES(`window.bridge.invoke('workspace:saveState', ${JSON.stringify(empty)})`)
      await ES(`window.__mogging.home.refresh()`)
      const cardOk = await waitTrue(
        `(() => {
          const card = document.querySelector('.home-resume-card')
          if (!card) return false
          const names = [...card.querySelectorAll('.home-resume-name')].map((n) => n.textContent)
          const totals = card.querySelector('.home-resume-totals')?.textContent || ''
          return names.includes('Alpha') && names.includes('Bravo') &&
            card.querySelectorAll('.home-resume-row').length === 2 &&
            /2 workspaces/.test(totals) && /3 terminals/.test(totals) && /1 agent/.test(totals)
        })()`
      )

      // (e) measured spacing on the real box.
      const measured = await ES<{ gap: number; pad: number; sp6: number; sp4: number }>(`(() => {
        const gap = parseFloat(getComputedStyle(document.querySelector('#view-home')).rowGap) || 0
        const card = document.querySelector('.home-resume-card')
        const pad = card ? parseFloat(getComputedStyle(card).paddingTop) : 0
        const sp6 = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sp-6')) || 0
        const sp4 = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sp-4')) || 0
        return { gap, pad, sp6, sp4 }
      })()`)
      const spacingOk = measured.gap >= measured.sp6 - 0.5 && measured.pad >= measured.sp4 - 0.5

      // (f) AA on the card text, four themes, via the shared probe (which owns the freeze).
      // .firstrun-cli-cmd is measured on the row (b2) forced into existence — before this, the
      // selector matched nothing here and the probe scored a contrast nobody was reading.
      const PROBES = [
        '.home-resume-title',
        '.home-resume-name',
        '.home-resume-path',
        '.home-resume-when',
        '.home-resume-totals',
        '.firstrun-row-title',
        '.firstrun-cli-cmd'
      ]
      const aa = await probeContrastAcrossThemes({ es: ES, sleep, selectors: PROBES })
      const aaOk = aa.failures.length === 0 && aa.missing.length === 0

      // Detection is honest again for everything below — (d) turns on what is REALLY installed.
      await ES(`window.__mogging.firstrun.forceMissing([])`)
      await ES(`window.__mogging.firstrun.refresh()`)
      await sleep(300)

      // (c cont.) one click puts the whole session back: BOTH workspaces, not a re-open of one.
      const wsBefore = await ES<number>(`window.__mogging.workspace.list().length`)
      await ES(`document.querySelector('.home-resume-card').click()`)
      const restoredOk = await waitTrue(
        `(() => {
          const list = window.__mogging.workspace.list()
          return list.length === ${wsBefore + 2} &&
            list.some((w) => w.name === 'Alpha') && list.some((w) => w.name === 'Bravo')
        })()`,
        30,
        200
      )

      // (g) audit 34 — the navigation contract, RATIFIED. Home and the grid are the two
      // halves of ONE invariant: exactly one of them can be right, and the workspace
      // count decides which. Workspaces now exist (from (c)), so the app must be on
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
      // gate). Recents and presets live in the wizard, which is reachable at any time
      // (Ctrl+T); Home's restore card exists only where it can act — the zero-workspace
      // launcher — so a Home button would buy nothing and re-open the dead end a prior
      // audit closed. A future half-applied "add a Home button" change trips HERE.
      const noHomeBtn = await ES<boolean>(
        `!document.querySelector('.titlebar-right [aria-label="Home" i]') && !document.querySelector('.titlebar-right [title="Home" i]')`
      )

      // (d) bug #1: required rows done (workspaces now exist from (c)), NOTHING saved by
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

      const pass =
        heroOk &&
        emptyOk &&
        cliHonest &&
        missingHonest &&
        installChipOk &&
        cardOk &&
        spacingOk &&
        aaOk &&
        restoredOk &&
        gridOk &&
        noHomeBtn &&
        dismissOk &&
        wizardOk
      result = {
        pass,
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
        restoredOk,
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
