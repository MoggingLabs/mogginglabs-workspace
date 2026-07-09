import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { probeContrastAcrossThemes } from './aa-probe'

// Env-gated feedback-language smoke (MOGGING_FEEDBACKUX, Phase-8.5/07b). One family:
//   (a) success + error toasts share the tone family, stack at the token gap, and both
//       animate OUT (the family's one curve applies on leave, not just the toast);
//   (b) a destructive confirm focuses the SAFE action + the danger verb is emphasized;
//   (c) closing a workspace with a live agent ALWAYS confirms — twice, no remember-me
//       (bug #8's regression: the kill-agents confirm can never be silenced);
//   (d) both review-gate states render, distinguishable WITHOUT colour (icon + word);
//   (e) the review footer is safe-first (Cancel/Close precede the danger merge);
//   (f) two EmptyState consumers render an action (the empty board lanes);
//   (g) AA ≥ 4.5 on the feedback surfaces across all four themes, via the shared probe.
export function runFeedbackUxSmoke(win: BrowserWindow): void {
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

      // (a) toasts — tone family, token stacking gap, animate out.
      // Wrap: the toast handle returns a dismisser fn, which executeJavaScript can't clone.
      await ES(`(window.__mogging.toast('success', 'Saved', 'Your changes are saved.'), 1)`)
      await ES(`(window.__mogging.toast('danger', 'Upload failed', 'The server refused the request.'), 1)`)
      await sleep(300)
      const toasts = await ES<{ n: number; family: boolean; gap: number; sp2: number; outAnim: boolean }>(`(() => {
        const host = document.querySelector('.toast-host')
        const success = document.querySelector('.toast--success'), danger = document.querySelector('.toast--danger')
        const family = !!success && !!danger && success.classList.contains('toast') && danger.classList.contains('toast')
        const gap = host ? parseFloat(getComputedStyle(host).gap) : -1
        const sp2 = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sp-2'))
        // the family's OUT curve is defined: mark one leaving, read its computed animation.
        success && success.classList.add('is-leaving')
        const outAnim = success ? getComputedStyle(success).animationName.includes('toast-out') : false
        return { n: document.querySelectorAll('.toast').length, family, gap, sp2, outAnim }
      })()`)
      // dismiss both -> they leave via the out-animation and detach.
      await ES(`document.querySelectorAll('.toast-dismiss').forEach((b) => b.click())`)
      await sleep(500)
      const toastsGone = await ES<boolean>(`document.querySelectorAll('.toast').length === 0`)
      const toastsOk = toasts.n >= 2 && toasts.family && Math.abs(toasts.gap - toasts.sp2) < 0.5 && toasts.outAnim && toastsGone

      // (b)+(c) workspace-close confirm — safe-focused, danger-emphasized, always asks.
      await ES(`window.__mogging.workspace.create({ name: 'Feedback' })`)
      await sleep(1400)
      const meta = await ES<{ id: string; ordinal: number }>(`window.__mogging.workspace.active()`)
      const wsId = meta.id
      const paneId = meta.ordinal * 100 + 1
      await ES(`window.__mogging.attention.setPaneState(${paneId}, 'busy')`)
      await sleep(300)
      await ES(`document.querySelector('.workspace-tab[data-ws-id="${wsId}"] .ws-close')?.click()`)
      await sleep(500)
      const confirm1 = await ES<{ shown: boolean; focusSafe: boolean; emphasized: boolean; hasRemember: boolean }>(`(() => {
        const overlay = document.querySelector('.modal-overlay')
        if (!overlay) return { shown: false, focusSafe: false, emphasized: false, hasRemember: true }
        const danger = overlay.querySelector('.btn--danger'), ghost = overlay.querySelector('.btn--ghost')
        const border = danger ? getComputedStyle(danger).borderTopColor : 'rgba(0, 0, 0, 0)'
        return {
          shown: !!danger,
          focusSafe: !!ghost && document.activeElement === ghost, // Cancel focused
          emphasized: border !== 'rgba(0, 0, 0, 0)' && border !== 'transparent', // bug #6: a danger border, not bare text
          hasRemember: !!overlay.querySelector('input[type="checkbox"]') // bug #8: NO remember-me
        }
      })()`)
      await ES(`document.querySelector('.modal-overlay .btn--ghost')?.click()`) // Cancel — keeps it
      await sleep(500)
      // Close AGAIN — a confirm that could be silenced would now skip; it must re-ask.
      await ES(`document.querySelector('.workspace-tab[data-ws-id="${wsId}"] .ws-close')?.click()`)
      await sleep(500)
      const confirm2Shown = await ES<boolean>(`!!document.querySelector('.modal-overlay .btn--danger')`)
      await ES(`document.querySelector('.modal-overlay .btn--ghost')?.click()`)
      await sleep(400)
      const confirmOk = confirm1.shown && confirm1.focusSafe && confirm1.emphasized && !confirm1.hasRemember && confirm2Shown

      // (d)+(e) review — gate states distinguishable without colour + safe-first footer.
      await ES(`window.__mogging.review.showFixture(false)`)
      await waitTrue(`!!document.querySelector('.review-modal .review-gate-closed')`)
      const gateClosed = await ES<{ ok: boolean; hasIcon: boolean; text: string }>(`(() => {
        const chip = document.querySelector('.review-modal .review-gate-closed')
        return chip ? { ok: true, hasIcon: !!chip.querySelector('svg'), text: (chip.textContent || '').trim() } : { ok: false, hasIcon: false, text: '' }
      })()`)
      const footer = await ES<{ safeFirst: boolean; mergeDanger: boolean; closeI: number; mergeI: number }>(`(() => {
        const btns = [...document.querySelectorAll('.review-footer .btn')]
        const texts = btns.map((b) => (b.textContent || '').trim())
        const closeI = texts.findIndex((t) => /^Close$/.test(t))
        const mergeI = texts.findIndex((t) => /merge/i.test(t))
        return { closeI, mergeI, safeFirst: closeI >= 0 && mergeI >= 0 && closeI < mergeI, mergeDanger: !!btns[mergeI]?.classList.contains('btn--danger') }
      })()`)
      await ES(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
      await sleep(500)
      await ES(`window.__mogging.review.showFixture(true)`)
      await waitTrue(`!!document.querySelector('.review-modal .review-gate-open')`)
      const gateOpen = await ES<{ ok: boolean; hasIcon: boolean; text: string }>(`(() => {
        const chip = document.querySelector('.review-modal .review-gate-open')
        return chip ? { ok: true, hasIcon: !!chip.querySelector('svg'), text: (chip.textContent || '').trim() } : { ok: false, hasIcon: false, text: '' }
      })()`)
      await ES(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
      await sleep(500)
      // Distinguishable without colour = distinct icon AND distinct word (not just tint).
      const gateOk = gateClosed.ok && gateOpen.ok && gateClosed.hasIcon && gateOpen.hasIcon && gateClosed.text !== gateOpen.text
      const footerOk = footer.safeFirst && footer.mergeDanger

      // (f) EmptyState.action — the fresh board's empty lanes each render an action.
      await ES(`document.querySelector('.titlebar-right .icon-btn[aria-label="Board"]')?.click()`)
      await waitTrue(`!!document.querySelector('#content.view-board')`)
      await sleep(400)
      const empties = await ES<{ empties: number; withAction: number }>(`(() => {
        const all = [...document.querySelectorAll('.board-lane .empty-state')]
        return { empties: all.length, withAction: all.filter((e) => !!e.querySelector('button')).length }
      })()`)
      const emptyActionOk = empties.withAction >= 2

      // (g) AA on the feedback surfaces — set a scene that holds them all on screen.
      await ES(`(window.__mogging.toast('info', 'Heads up', 'A neutral message for contrast.'), 1)`)
      await ES(`window.__mogging.review.showFixture(false)`)
      await sleep(500)
      const aa = await probeContrastAcrossThemes({
        es: ES,
        sleep,
        selectors: ['.toast-title', '.toast-body', '.review-gate', '.btn--danger', '.empty-title', '.empty-body']
      })
      const aaOk = aa.failures.length === 0 && aa.missing.length === 0

      const pass = toastsOk && confirmOk && gateOk && footerOk && emptyActionOk && aaOk
      result = {
        pass,
        toastsOk,
        toasts,
        confirmOk,
        confirm1,
        confirm2Shown,
        gateOk,
        gateClosed,
        gateOpen,
        footerOk,
        footer,
        emptyActionOk,
        empties,
        aaOk,
        aaFailures: aa.failures,
        aaMissing: aa.missing,
        aaWorst: aa.worst
      }
    } catch (e) {
      result = { pass: false, error: e instanceof Error ? e.message : String(e) }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'feedbackux-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}
