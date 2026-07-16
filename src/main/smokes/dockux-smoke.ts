import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setAgentConsent, setDrivingForSmoke } from '../browser-dock'
import { probeContrastAcrossThemes } from './aa-probe'

// Env-gated browser-dock + shortcuts UX smoke (MOGGING_DOCKUX, Phase-8.5/08b). This
// gate exists for AUDIT § Blockers #1: the surface that says "an agent is holding the
// wheel of your browser" had no CSS rule and no test. Zero network.
//
//   GUARD (step 1, written BEFORE the restyle): while driving === true —
//     .browser-dock carries agent-driving; .browser-agent-banner is not hidden;
//     .browser-agent-stop is present and hit-testable (a real box, in the viewport);
//     .browser-agent-label has non-empty text at computed font-size >= 11px, a
//     non-transparent colour, AA against its real composited background.
//   Then (a) the guard STILL passes after the restyle; (b) driving === false hides the
//   banner and removes Stop; (c) .browser-confirm-text / .browser-agentweb-note-text have
//   rules of their own; (d) the ? overlay's row count equals Settings § Shortcuts';
//   (e) .shortcuts-row padding is a --sp-* stop and every dock control >= 28px;
//   (f) AA on the possession text, four themes.
// Verdict -> out/dockux-result.json. Inert unless MOGGING_DOCKUX is set.

export function runDockUxSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 140000) // safety net
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const emit = (o: object): void => {
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'dockux-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }

  // The possession guard, as a renderer expression returning its verdict object. Kept as
  // a named string so (a) can run the EXACT same assertion after the restyle.
  const GUARD_JS = `(() => {
    const dock = document.querySelector('.browser-dock')
    const banner = document.querySelector('.browser-agent-banner')
    const stop = document.querySelector('.browser-agent-stop')
    const label = document.querySelector('.browser-agent-name')
    const hitTestable = (el) => {
      if (!el) return false
      const r = el.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) return false
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2
      if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return false
      const hit = document.elementFromPoint(cx, cy)
      return !!hit && (hit === el || el.contains(hit) || hit.contains(el))
    }
    const driving = !!dock && dock.classList.contains('agent-driving')
    const bannerShown = !!banner && !banner.hidden && banner.getBoundingClientRect().height > 0
    const stopHit = hitTestable(stop)
    const cs = label ? getComputedStyle(label) : null
    const fontPx = cs ? parseFloat(cs.fontSize) : 0
    const parts = cs ? (cs.color.match(/[\\d.]+/g) || []).map(Number) : []
    const alpha = parts.length === 4 ? parts[3] : 1
    const labelOk = !!label && (label.textContent || '').trim().length > 0 && fontPx >= 11 && alpha > 0
    return { ok: driving && bannerShown && stopHit && labelOk, driving, bannerShown, stopHit, labelOk, fontPx, alpha, labelText: label ? label.textContent : null }
  })()`

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    let stage = 'init'
    try {
      await sleep(1800)

      // ── Setup: a workspace whose pane is a CLAUDE agent, dock open, agent-web
      //    profile, consent, and DRIVING (with the driving pane, so the possession
      //    UI can name it — goals 5/6) ──
      stage = 'setup'
      await ES(`window.__mogging.workspace.create({ name: 'Dock', assignments: ['claude'] })`)
      await sleep(1200)
      const ws = await ES<{ id: string; ordinal: number }>(`window.__mogging.workspace.active()`)
      const wsId = ws.id
      const drivingPane = String(ws.ordinal * 100 + 1)
      await ES(`window.__mogging.browser.toggle(true)`)
      await sleep(400)
      await ES(`window.__mogging.browser.setProfile('agent-web')`)
      await sleep(500)
      setAgentConsent(true, wsId)
      setDrivingForSmoke(wsId, true, 'example.com', drivingPane) // banner + confirm bar + IDENTITY, held stable
      await sleep(450)

      // ── (g) The Comet possession UI names WHICH agent + shows the live action + glow
      //    (goals 5/6): the banner reads "Claude Code · pane N", the action line is
      //    present, the dock wears the animated glow, and the titlebar pill names it too. ──
      stage = 'g-identity'
      const g = await ES<Record<string, unknown>>(`(() => {
        const B = window.__mogging.browser
        const name = B.agentBannerName()
        const action = B.agentBannerAction()
        const glow = B.dockDrivingGlow()
        const globalText = B.globalPossessionText()
        const nameOk = /Claude Code/.test(name) && new RegExp('pane ${drivingPane}').test(name)
        const globalOk = /Claude Code/.test(globalText)
        const glowLayer = !!document.querySelector('.browser-dock.agent-driving')
        const dot = document.querySelector('.browser-agent-dot')
        const dotShown = !!dot && dot.getBoundingClientRect().width > 0
        return { ok: nameOk && !!action && glow && globalOk && glowLayer && dotShown, name, action, glow, globalText, dotShown }
      })()`)

      // ── (a) the guard, verbatim, now after the restyle ──
      stage = 'a-guard'
      const a = await ES<Record<string, unknown>>(GUARD_JS)

      // ── (f) AA on the possession text — label + consent + honesty, four themes ──
      stage = 'f-aa'
      const aa = await probeContrastAcrossThemes({
        es: ES,
        sleep,
        selectors: ['.browser-agent-name', '.browser-confirm-text', '.browser-agentweb-note-text']
      })
      const guardAaOk = !aa.failures.some((s) => s.includes('.browser-agent-name')) && !aa.missing.includes('.browser-agent-name')
      const f = { ok: aa.failures.length === 0 && aa.missing.length === 0, ...aa }

      // ── (c) the consent + honesty spans have rules of their OWN (differ from a bare
      //    <span> dropped into the same parent) — the "no CSS rule" finding, closed ──
      stage = 'c-rules'
      const c = await ES<Record<string, unknown>>(`(() => {
        // A rule of its OWN = the span's computed size/colour OVERRIDES what it would
        // inherit from its parent (what a bare <span> in the same place would show). If
        // the span had no rule it would match its parent exactly, and this fails.
        const check = (sel) => {
          const el = document.querySelector(sel)
          if (!el || !el.parentElement) return { ok: false, reason: 'missing ' + sel }
          const a = getComputedStyle(el), p = getComputedStyle(el.parentElement)
          const sizeDiff = !!a.fontSize && a.fontSize !== p.fontSize
          const colorDiff = !!a.color && a.color !== p.color
          return { ok: sizeDiff || colorDiff, sel, size: a.fontSize, parentSize: p.fontSize, color: a.color, parentColor: p.color, sizeDiff, colorDiff }
        }
        const confirmText = check('.browser-confirm-text')
        const noteText = check('.browser-agentweb-note-text')
        return { ok: confirmText.ok && noteText.ok, confirmText, noteText }
      })()`)

      // ── (e-controls) every visible dock control is a real hit target (>= 28px). The
      //    26px shared .icon-btn is the sanctioned primitive (kept in 08), out of scope. ──
      stage = 'e-controls'
      const eControls = await ES<Record<string, unknown>>(`(() => {
        const sels = ['.browser-agent-stop', '.browser-agentweb-sites', '.browser-confirm-btn', '.browser-profile-opt']
        const measured = []
        for (const sel of sels) {
          for (const el of document.querySelectorAll(sel)) {
            const h = Math.round(el.getBoundingClientRect().height)
            if (h > 0) measured.push({ sel, h })
          }
        }
        const ok = measured.length >= 4 && measured.every((m) => m.h >= 28)
        return { ok, measured, min: measured.length ? Math.min(...measured.map((m) => m.h)) : 0 }
      })()`)

      // ── (b) driving === false → the banner is hidden and Stop is gone (the guard proves
      //    presence; this proves possession chrome is NOT always-on) ──
      stage = 'b-idle'
      setDrivingForSmoke(wsId, false)
      await sleep(400)
      const b = await ES<Record<string, unknown>>(`(() => {
        const dock = document.querySelector('.browser-dock')
        const banner = document.querySelector('.browser-agent-banner')
        const stop = document.querySelector('.browser-agent-stop')
        const bannerHidden = !!banner && (banner.hidden || banner.getBoundingClientRect().height === 0)
        const stopGone = !stop || stop.getBoundingClientRect().height === 0 || stop.offsetParent === null
        const notDriving = !!dock && !dock.classList.contains('agent-driving')
        return { ok: bannerHidden && stopGone && notDriving, bannerHidden, stopGone, notDriving }
      })()`)

      // ── (d) the ? overlay's row count equals Settings § Shortcuts' (KB-01, one source) ──
      stage = 'd-shortcuts'
      await ES(`window.__mogging.view('settings')`)
      await sleep(300)
      await ES(`window.__mogging.settingsTab('shortcuts')`)
      await sleep(300)
      const settingsRows = await ES<number>(`document.querySelectorAll('.settings-section[data-section="shortcuts"] .shortcuts-row').length`)
      await ES(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true }))`)
      await sleep(300)
      const overlayRows = await ES<number>(`document.querySelectorAll('.modal-overlay .shortcuts-row').length`)
      // ── (e-shortcuts) the row padding is a --sp-* stop (a multiple of 4), never the old 5px ──
      const eShortcuts = await ES<Record<string, unknown>>(`(() => {
        const row = document.querySelector('.shortcuts-row')
        if (!row) return { ok: false, reason: 'no row' }
        const cs = getComputedStyle(row)
        const pt = parseFloat(cs.paddingTop), pb = parseFloat(cs.paddingBottom)
        const isStop = (v) => v % 4 === 0
        return { ok: isStop(pt) && isStop(pb) && pt !== 5, paddingTop: pt, paddingBottom: pb }
      })()`)
      await ES(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
      const d = { ok: overlayRows === settingsRows && overlayRows >= 10, overlayRows, settingsRows }
      const e = { ok: Boolean(eControls.ok && eShortcuts.ok), controls: eControls, shortcuts: eShortcuts }

      const pass = Boolean(a.ok && guardAaOk && b.ok && c.ok && d.ok && e.ok && f.ok && g.ok)
      result = { pass, a: { ...a, aaOk: guardAaOk }, b, c, d, e, f, g }
    } catch (err) {
      result = { pass: false, stage, error: String(err) }
    }
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}
