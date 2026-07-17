import { app, type BrowserWindow } from 'electron'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Env-gated wizard-page smoke (MOGGING_WIZARDUX — Phase-8.5/02, redesigned 2026-07).
// The wizard is ONE compact flat page beside the rail. Asserts:
//   (a) FLAT — zero Cards, zero <details> disclosures, no modal overlay; the
//       controls that used to hide behind "Advanced" (custom command, isolation,
//       runs-on, presets) are VISIBLE immediately; the Presets section OFFERS
//       NOTHING (2026-07-16): no built-in mixes, no curated Swarm card — only
//       "Save as preset" and the user's own saves (a fresh profile shows the
//       empty-state hint). The RAIL is workspace-truthful (2026-07-17): with
//       ZERO workspaces the wizard runs FULL-BLEED (an empty rail column beside
//       it meant nothing); once workspaces exist, the rail is up beside it so
//       you configure the next workspace with the ones you have in view;
//   (b) the density claim, measured — flat sections with the division hairline,
//       inter-section gap >= --sp-5, all from getComputedStyle;
//   (c) prefill lands across the page at once (folder · painter · mix · meter);
//   (d) THE PAINTER, by real gestures — a lattice CLICK sizes the grid; a real
//       pointer DRAG across the canvas merges cells (readout says merged); a
//       click on the merged tile splits it back;
//   (e) an EMPTIED folder refuses to launch and says why, in place. (A fresh
//       wizard now defaults to $HOME — the guard is reached by clearing the bar,
//       which is still a real state: select-all + delete;)
//   (f) a merged layout LAUNCHES into real geometry: the workspace opens with
//       exactly that many panes and the merged pane truly spans the grid.
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

      // ── (e) first: an EMPTIED folder refuses to launch, in place ─────────────
      // A fresh wizard defaults to $HOME now, so the unset state is reached the way
      // a human reaches it: select-all + delete in the bar. Wait for the default to
      // land first — clearing a bar the default then overwrites would race it.
      await ES(`window.__mogging.templates.openWizard()`)
      await waitFor(async () => ES<boolean>(`(document.querySelector('#view-wizard .path-input-field')?.value ?? '') !== ''`))
      await ES(`(() => {
        const i = document.querySelector('#view-wizard .path-input-field')
        i.value = ''
        i.dispatchEvent(new Event('input', { bubbles: true }))
      })()`)
      await sleep(500)
      await ES(`document.querySelector('#view-wizard .wizard-footer .btn--primary').click()`)
      await sleep(500)
      const refused = await ES<{ stillWizard: boolean; status: string; workspaces: number }>(`(() => ({
        stillWizard: !!document.querySelector('#content.view-wizard'),
        status: document.querySelector('#view-wizard .path-input-status')?.textContent ?? '',
        workspaces: (window.__mogging.workspace.count?.() ?? 0)
      }))()`)
      const invalidRefusedOk =
        refused.stillWizard && /pick a folder/i.test(refused.status) && refused.workspaces === 0

      // ── (a) FLAT: no cards, no disclosures, everything visible ──────────────
      const shape = await ES<{
        cards: number
        details: number
        sections: number
        overlays: number
        pageVisible: boolean
        railWidth: number
        appClass: boolean
        customVisible: boolean
        isolateVisible: boolean
        remoteVisible: boolean
        painterVisible: boolean
        swarmCards: number
        presetCards: number
        presetHint: boolean
        saveBtn: boolean
      }>(`(() => {
        const visible = (sel) => {
          const n = document.querySelector(sel)
          return !!n && n.getBoundingClientRect().height > 0
        }
        return {
          cards: document.querySelectorAll('#view-wizard .card').length,
          details: document.querySelectorAll('#view-wizard details').length,
          sections: document.querySelectorAll('#view-wizard .wizard-sec').length,
          overlays: document.querySelectorAll('.modal-overlay').length,
          pageVisible: !!document.querySelector('#view-wizard')?.offsetParent,
          railWidth: document.querySelector('#rail')?.getBoundingClientRect().width ?? 0,
          appClass: document.getElementById('app').classList.contains('view-wizard'),
          customVisible: visible('#view-wizard .wizard-custom-input'),
          isolateVisible: visible('#view-wizard .wizard-option-row'),
          remoteVisible: visible('#view-wizard .wizard-remote-select'),
          painterVisible: visible('#view-wizard .grid-painter'),
          // Presets offer NOTHING: no curated Swarm card, no built-in mixes — a
          // fresh profile holds zero apply-cards, the empty-state hint, and Save.
          swarmCards: document.querySelectorAll('#view-wizard .wizard-preset-swarm').length,
          presetCards: document.querySelectorAll('#view-wizard .wizard-preset-apply').length,
          presetHint: /nothing saved yet/i.test(document.querySelector('#view-wizard .wizard-presets')?.textContent ?? ''),
          saveBtn: [...document.querySelectorAll('#view-wizard .wizard-sec-right button')]
            .some((b) => /save as preset/i.test(b.textContent ?? ''))
        }
      })()`)
      const flatOk =
        shape.cards === 0 &&
        shape.details === 0 &&
        shape.sections >= 5 &&
        shape.overlays === 0 &&
        shape.pageVisible &&
        shape.appClass &&
        shape.customVisible &&
        shape.isolateVisible &&
        shape.remoteVisible &&
        shape.painterVisible
      // ZERO workspaces here: the wizard is full-bleed — no empty rail column.
      const railHiddenAtZeroOk = shape.railWidth === 0
      const presetsOfferNothingOk = shape.swarmCards === 0 && shape.presetCards === 0 && shape.presetHint && shape.saveBtn

      // ── (b) the density claim, MEASURED from computed styles ────────────────
      const spacing = await ES<{ gap: number; hairline: number; headPad: number }>(`(() => {
        const col = document.querySelector('#view-wizard .wizard')
        const head = document.querySelector('#view-wizard .wizard-sec-head')
        const cs = getComputedStyle(head)
        return {
          gap: parseFloat(getComputedStyle(col).rowGap),
          hairline: parseFloat(cs.borderBottomWidth),
          headPad: parseFloat(cs.paddingBottom)
        }
      })()`)
      const spacingOk = spacing.gap >= 24 && spacing.hairline === 1 && spacing.headPad >= 12 // --sp-5 / hairline / --sp-3

      // ── (c) prefill lands across the page at once ───────────────────────────
      // A `custom:` mix needs no installed CLI, so this asserts on any machine.
      await ES(`window.__mogging.templates.openWizard({ cwd: ${cwdJs}, paneCount: 6, mix: [{ provider: 'custom:echo hi', count: 2 }] })`)
      await sleep(800)
      const prefill = await ES<{
        folder: string
        readout: string
        custom: string
        meter: string
      }>(`(() => ({
        folder: document.querySelector('#view-wizard .path-input-field')?.value ?? '',
        readout: document.querySelector('#view-wizard .wizard-layout-readout')?.textContent ?? '',
        custom: document.querySelector('#view-wizard .wizard-custom-input')?.value ?? '',
        meter: document.querySelector('#view-wizard .wizard-fill-label')?.textContent ?? ''
      }))()`)
      const prefillOk =
        prefill.folder === repo && // Where
        /^6 terminals · 2×3/.test(prefill.readout) && // Layout (painter readout)
        prefill.custom === 'echo hi' && // Agents
        /2 \/ 6/.test(prefill.meter)

      // ── (d) the painter, by REAL gestures ───────────────────────────────────
      // Size: click the 2×2 lattice cell (row 2, col 2).
      await ES(`(() => {
        const cell = [...document.querySelectorAll('#view-wizard .gp-cell')]
          .find((c) => c.dataset.r === '1' && c.dataset.c === '1')
        cell?.click()
      })()`)
      await sleep(200)
      const sized = await ES<{ readout: string; regions: number }>(`(() => ({
        readout: document.querySelector('#view-wizard .wizard-layout-readout')?.textContent ?? '',
        regions: window.__mogging.wizardLayout.spec().regions.length
      }))()`)
      const latticeSizesOk = /^4 terminals · 2×2/.test(sized.readout) && sized.regions === 4

      // Merge: a REAL pointer drag across the top row of the canvas.
      await ES(`(() => {
        const canvas = document.querySelector('#view-wizard .gp-canvas')
        const r = canvas.getBoundingClientRect()
        const at = (fx, fy) => ({ x: r.x + r.width * fx, y: r.y + r.height * fy })
        const fire = (type, p) => canvas.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, button: 0, buttons: 1, pointerId: 7
        }))
        const a = at(0.2, 0.25) // top-left cell
        const b = at(0.8, 0.25) // top-right cell
        fire('pointerdown', a)
        fire('pointermove', { x: (a.x + b.x) / 2, y: a.y })
        fire('pointermove', b)
        fire('pointerup', b)
      })()`)
      await sleep(250)
      const merged = await ES<{ readout: string; regions: number; spans: number }>(`(() => {
        const spec = window.__mogging.wizardLayout.spec()
        return {
          readout: document.querySelector('#view-wizard .wizard-layout-readout')?.textContent ?? '',
          regions: spec.regions.length,
          spans: spec.regions.filter((g) => g.rs > 1 || g.cs > 1).length
        }
      })()`)
      const dragMergesOk = /merged/.test(merged.readout) && merged.regions === 3 && merged.spans === 1

      // Split back: click the merged tile, then re-merge for the launch below.
      await ES(`(() => {
        const canvas = document.querySelector('#view-wizard .gp-canvas')
        const r = canvas.getBoundingClientRect()
        const p = { x: r.x + r.width * 0.5, y: r.y + r.height * 0.25 }
        const fire = (type) => canvas.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, button: 0, buttons: 1, pointerId: 8
        }))
        fire('pointerdown')
        fire('pointerup')
      })()`)
      await sleep(250)
      const unmerged = await ES<number>(`window.__mogging.wizardLayout.spec().regions.length`)
      const clickSplitsOk = unmerged === 4
      await ES(`window.__mogging.wizardLayout.merge(0, 0, 0, 1)`)
      await sleep(150)

      // ── (f) the merged layout launches into REAL geometry ───────────────────
      await ES(`document.querySelector('#view-wizard .wizard-footer .btn--primary').click()`)
      const launched = await waitFor(async () =>
        ES<boolean>(`!!document.querySelector('#content.view-grid') && (window.__mogging.layout.paneCount?.() ?? 0) === 3`)
      )
      await sleep(400)
      const geometry = await ES<{ slots: number; grid: number; top: number; bottoms: number[] }>(`(() => {
        const grid = document.querySelector('.workspace-view:not([hidden]) .layout-grid') ?? document.querySelector('.layout-grid')
        const slots = [...grid.querySelectorAll('.layout-slot')]
          .map((s) => s.getBoundingClientRect())
          .sort((a, b) => a.y - b.y || a.x - b.x)
        return {
          slots: slots.length,
          grid: grid.getBoundingClientRect().width,
          top: slots[0]?.width ?? 0,
          bottoms: slots.slice(1).map((s) => Math.round(s.width))
        }
      })()`)
      // The merged pane spans (allow the seam): full width vs ~half for the two below.
      const launchOk =
        launched &&
        geometry.slots === 3 &&
        geometry.top > geometry.grid * 0.9 &&
        geometry.bottoms.length === 2 &&
        geometry.bottoms.every((w) => w < geometry.grid * 0.6)

      // …and now that a workspace EXISTS, the reopened wizard has the rail up
      // beside it — the other half of the workspace-truthful rail (2026-07-17).
      await ES(`window.__mogging.templates.openWizard({ cwd: ${cwdJs} })`)
      await sleep(600)
      const railWithWorkspaces = await ES<number>(`document.querySelector('#rail')?.getBoundingClientRect().width ?? 0`)
      const railBesideOk = railWithWorkspaces > 0

      const pass =
        invalidRefusedOk &&
        flatOk &&
        railHiddenAtZeroOk &&
        railBesideOk &&
        presetsOfferNothingOk &&
        spacingOk &&
        prefillOk &&
        latticeSizesOk &&
        dragMergesOk &&
        clickSplitsOk &&
        launchOk
      result = {
        pass,
        invalidRefusedOk,
        flatOk,
        railHiddenAtZeroOk,
        railBesideOk,
        railWithWorkspaces,
        presetsOfferNothingOk,
        spacingOk,
        spacing,
        prefillOk,
        prefill,
        latticeSizesOk,
        sized,
        dragMergesOk,
        merged,
        clickSplitsOk,
        unmerged,
        launchOk,
        geometry,
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
