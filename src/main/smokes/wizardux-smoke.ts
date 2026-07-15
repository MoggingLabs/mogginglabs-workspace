import { app, type BrowserWindow } from 'electron'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Env-gated one-page-wizard smoke (MOGGING_WIZARDUX, Phase-8.5/02). The wizard is
// a full PAGE beside the workspace rail, not a modal. Asserts:
//   (a) ONE page — three Cards, zero steppers, no modal overlay; the rail is up
//       beside it (the whole point: configure the next workspace with the ones
//       you have still in view);
//   (b) the spacing CLAIM, measured — card padding >= --sp-4, inter-card gap
//       >= --sp-5, both read from getComputedStyle, not from the stylesheet;
//   (c) prefill lands in all three cards AT ONCE (folder · grid · mix);
//   (d) the Advanced disclosures start COLLAPSED and expand;
//   (e) an unset folder refuses to launch and says why, in place;
//   (f) launch from the single page opens the workspace with the chosen mix.
// Zero network.

export function runWizardUxSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 120000) // safety net
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  const emit = (o: object): void => {
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'wizardux-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }

  const waitFor = async (probe: () => Promise<boolean>, tries = 20, gapMs = 250): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      if (await probe()) return true
      await sleep(gapMs)
    }
    return false
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      await sleep(1500)
      const repo = mkdtempSync(join(tmpdir(), 'mog-wizux-'))
      const cwdJs = JSON.stringify(repo)

      // ── (e) first: an unset folder refuses to launch, in place ──────────────
      await ES(`window.__mogging.templates.openWizard()`)
      await sleep(700)
      await ES(`document.querySelector('#view-wizard .wizard-footer .btn--primary').click()`)
      await sleep(500)
      const refused = await ES<{ stillWizard: boolean; status: string; workspaces: number }>(`(() => ({
        stillWizard: !!document.querySelector('#content.view-wizard'),
        status: document.querySelector('#view-wizard .path-input-status')?.textContent ?? '',
        workspaces: (window.__mogging.workspace.count?.() ?? 0)
      }))()`)
      const invalidRefusedOk =
        refused.stillWizard && /pick a folder/i.test(refused.status) && refused.workspaces === 0

      // ── (a) ONE page: three cards, no stepper, no modal, rail beside it ─────
      const shape = await ES<{
        cards: number
        steppers: number
        overlays: number
        pageVisible: boolean
        railWidth: number
        appClass: boolean
      }>(`(() => ({
        cards: document.querySelectorAll('#view-wizard .wizard > .card').length,
        steppers: document.querySelectorAll('.wizard-stepper').length,
        overlays: document.querySelectorAll('.modal-overlay').length,
        pageVisible: !!document.querySelector('#view-wizard')?.offsetParent,
        railWidth: document.querySelector('#rail')?.getBoundingClientRect().width ?? 0,
        appClass: document.getElementById('app').classList.contains('view-wizard')
      }))()`)
      const onePageOk =
        shape.cards === 3 && shape.steppers === 0 && shape.overlays === 0 && shape.pageVisible && shape.appClass
      const railBesideOk = shape.railWidth > 0

      // ── (b) the spacing claim, MEASURED from computed styles ────────────────
      const spacing = await ES<{ pad: number; gap: number }>(`(() => {
        const card = document.querySelector('#view-wizard .wizard > .card')
        const col = document.querySelector('#view-wizard .wizard')
        return {
          pad: parseFloat(getComputedStyle(card).paddingTop),
          gap: parseFloat(getComputedStyle(col).rowGap)
        }
      })()`)
      const spacingOk = spacing.pad >= 16 && spacing.gap >= 24 // --sp-4 / --sp-5

      // ── (d) Advanced disclosures start COLLAPSED, then expand ───────────────
      const advBefore = await ES<{ total: number; open: number }>(`(() => {
        const d = [...document.querySelectorAll('#view-wizard .wizard-adv')]
        return { total: d.length, open: d.filter((x) => x.open).length }
      })()`)
      await ES(`(document.querySelectorAll('#view-wizard .wizard-adv').forEach((d) => (d.open = true)), 1)`)
      await sleep(300)
      const advBodyShown = await ES<boolean>(
        `[...document.querySelectorAll('#view-wizard .wizard-adv-body')].every((b) => b.getBoundingClientRect().height > 0)`
      )
      const disclosureOk = advBefore.total >= 2 && advBefore.open === 0 && advBodyShown

      // ── (c) prefill lands in ALL THREE cards at once ────────────────────────
      // A `custom:` mix needs no installed CLI, so this asserts on any machine.
      // It also exercises the auto-open rule: the custom command's only controls
      // live inside Agents › Advanced, so a prefilled mix must reveal them.
      await ES(`window.__mogging.templates.openWizard({ cwd: ${cwdJs}, paneCount: 6, mix: [{ provider: 'custom:echo hi', count: 2 }] })`)
      await sleep(800)
      const prefill = await ES<{
        folder: string
        grid: string
        custom: string
        meter: string
        advOpen: number
        customInAdvanced: boolean
      }>(`(() => ({
        folder: document.querySelector('#view-wizard .path-input-field')?.value ?? '',
        grid: document.querySelector('#view-wizard .layout-tile[aria-checked="true"] .layout-tile-count')?.textContent ?? '',
        custom: document.querySelector('#view-wizard .wizard-custom-input')?.value ?? '',
        meter: document.querySelector('#view-wizard .wizard-fill-label')?.textContent ?? '',
        advOpen: [...document.querySelectorAll('#view-wizard .wizard-adv')].filter((d) => d.open).length,
        customInAdvanced: !!document.querySelector('#view-wizard .wizard-adv .wizard-custom-input')
      }))()`)
      const prefillOk =
        prefill.folder === repo && // Where
        prefill.grid === '6' && // Layout
        prefill.custom === 'echo hi' && // Agents
        /2 \/ 6/.test(prefill.meter) &&
        prefill.customInAdvanced && // the rarely-used control is disclosed, not on the roster
        prefill.advOpen === 1 // ...and auto-opened, because the mix already set it

      // ── (f) launch from the single page opens the workspace with the mix ────
      await ES(`document.querySelector('#view-wizard .wizard-footer .btn--primary').click()`)
      const launched = await waitFor(async () =>
        ES<boolean>(`!!document.querySelector('#content.view-grid') && (window.__mogging.layout.paneCount?.() ?? 0) === 6`)
      )
      const panes = await ES<number>(`window.__mogging.layout.paneCount?.() ?? 0`)
      const launchOk = launched && panes === 6

      const pass = invalidRefusedOk && onePageOk && railBesideOk && spacingOk && disclosureOk && prefillOk && launchOk
      result = {
        pass,
        invalidRefusedOk,
        onePageOk,
        railBesideOk,
        spacingOk,
        spacing,
        disclosureOk,
        advBefore,
        prefillOk,
        prefill,
        launchOk,
        panes,
        shape
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}
