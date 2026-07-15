import { app, type BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeContrastAcrossThemes, type AaProbeResult } from './aa-probe'
import { setAgentConsent, setDrivingForSmoke } from '../browser-dock'
import { emitBridgeEvent, saveWebhook } from '../event-bridge'
import { getUsageService } from '../usage'
import { BUDGET } from './milestone-smoke'

// Env-gated UX MILESTONE smoke (MOGGING_UXMILESTONE, Phase-8.5/09). The freeze gate:
// one fixture world, ZERO network, the whole revamp asserted as a SYSTEM. Not a new
// surface — every hook and selector below is owned by an earlier pack step (02–08c);
// this smoke proves they still compose after the pack, and that nothing that mattered
// before it — a possession banner, a consent line, an attention chip, a review gate,
// the trail's honesty promise, the frame budget — was dimmed on the way. The two
// sanctioned new files of 09 are this smoke and scripts/check-audit.mjs.
//
//   (a) fresh boot → Home hero + checklist card (06) → the wizard opens as ONE page
//       (02), a folder is picked by CLICKS through the browser (03), launch opens the
//       workspace;
//   (b) Settings: shell + grouped nav (04); Integrations (05) and Usage (05b) open
//       OVERVIEW-FIRST, disclosure persists across a leave/return, and a seeded
//       attention chip shows THROUGH a collapsed header (collapse != hide); every
//       legacy DOM hook a prior gate reads still resolves;
//   (c) board + palette (07); a destructive confirm focuses the SAFE action (07b);
//       chrome — a one-line pane header + tabs that overflow, not shrink (08); the
//       possession banner unmissable while an agent drives (08b);
//   (d) the spacing gate frozen: `check-spacing.mjs --max 0`, every bucket zero;
//   (e) SAFETY UNDIMMED — possession label, consent copy, an attention state, the
//       review-gate indicator and the trail's "never sent anywhere" line all hold AA
//       at their pre-pack prominence, measured across four themes via aa-probe.ts;
//   (f) the perf BUDGET, sampled DURING the composed surface against the UNCHANGED
//       docs/05 numbers (BUDGET in milestone-smoke.ts — the one source of truth).
// Verdict → out/uxmilestone-result.json. Inert unless MOGGING_UXMILESTONE is set.

export function runUxMilestoneSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 300000) // safety net — this composes ~six surfaces
  const wc = win.webContents
  wc.setBackgroundThrottling(false) // (f) measures OUR frames, not compositor scheduling
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const waitTrue = async (js: string, tries = 30, gap = 250): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      if (await ES<boolean>(js).catch(() => false)) return true
      await sleep(gap)
    }
    return false
  }

  // The possession guard, verbatim from dockux — the § Blockers #1 contract, re-asserted
  // in the composed world so a later step can never quietly un-style the banner.
  const GUARD_JS = `(() => {
    const dock = document.querySelector('.browser-dock')
    const banner = document.querySelector('.browser-agent-banner')
    const stop = document.querySelector('.browser-agent-stop')
    const label = document.querySelector('.browser-agent-label')
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
    const cs = label ? getComputedStyle(label) : null
    const fontPx = cs ? parseFloat(cs.fontSize) : 0
    const parts = cs ? (cs.color.match(/[\\d.]+/g) || []).map(Number) : []
    const alpha = parts.length === 4 ? parts[3] : 1
    const labelOk = !!label && (label.textContent || '').trim().length > 0 && fontPx >= 11 && alpha > 0
    return { ok: driving && bannerShown && hitTestable(stop) && labelOk, driving, bannerShown, stopHit: hitTestable(stop), labelOk, fontPx }
  })()`

  const openSettings = async (target: string): Promise<void> => {
    await ES(`(document.querySelector('.titlebar-right .icon-btn[aria-label="Settings"]')?.click(), 1)`)
    await sleep(400)
    await ES(`(document.querySelector('.settings-nav-item[data-target="${target}"]')?.click(), 1)`)
    await sleep(400)
  }
  const leaveSettings = async (): Promise<void> => {
    await ES(`document.querySelector('.settings-back')?.click()`)
    await sleep(300)
  }
  const cardOpen = (id: string): Promise<boolean> =>
    ES<boolean>(`document.querySelector('.collapsible-card[data-collapsible="${id}"]')?.classList.contains('is-open') === true`)
  const toggleCard = (id: string): Promise<unknown> =>
    ES(`(document.querySelector('.collapsible-card[data-collapsible="${id}"] .cc-toggle')?.click(), 1)`)

  // A calm/hot usage fixture — the same shape setusage seeds, so Usage renders on the
  // FAKE adapter (usage.ts recognizes MOGGING_UXMILESTONE as a fixture world; no network).
  const usageFixture = (usedPct: number, weekPct: number, label: string): void => {
    const dir = mkdtempSync(join(tmpdir(), 'mog-uxm-usage-'))
    const f = join(dir, 'fx.json')
    writeFileSync(
      f,
      JSON.stringify([
        {
          providerId: 'fake',
          profileId: 'default',
          planLabel: label,
          windows: [
            { label: 'Session (5h)', usedPct, resetsAt: new Date(Date.now() + 2 * 3600_000).toISOString() },
            { label: 'Weekly', usedPct: weekPct, resetsAt: new Date(Date.now() + 40 * 3600_000).toISOString() }
          ],
          fetchedAt: Date.now(),
          health: 'fresh'
        }
      ])
    )
    process.env.MOGGING_USAGE_FIXTURE = f
    getUsageService()?.refresh()
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    let stage = 'init'
    // Aggregate the (e) safety probe across the scenes each surface lives in.
    const safety = { failures: [] as string[], missing: [] as string[], worst: null as number | null }
    const foldIn = (r: AaProbeResult, only?: string[]): void => {
      const keep = (s: string): boolean => (only ? only.some((sel) => s.includes(sel)) : true)
      safety.failures.push(...r.failures.filter(keep))
      safety.missing.push(...r.missing.filter((m) => (only ? only.includes(m) : true)))
      if (r.worst != null) safety.worst = safety.worst == null ? r.worst : Math.min(safety.worst, r.worst)
    }

    try {
      await sleep(1800)

      // ══ (a) boot → Home → wizard-one-page → folder-by-click → launch ════════════
      stage = 'a-home'
      await ES(`try{localStorage.removeItem('mogging.firstrun.dismissed')}catch{}`)
      await ES(`window.__mogging.firstrun && window.__mogging.firstrun.refresh()`)
      await ES(`window.__mogging.home && window.__mogging.home.refresh()`)
      const homeOk = await waitTrue(
        `!!document.querySelector('#view-home .home-hero') && !!document.querySelector('.firstrun-card') && document.querySelectorAll('.firstrun-row').length >= 3`
      )

      stage = 'a-wizard'
      const root = mkdtempSync(join(tmpdir(), 'mog-uxm-'))
      for (const d of ['alpha', 'project']) mkdirSync(join(root, d))
      // The wizard opens as ONE full page, rooted at the fixture, mix pre-set to a custom
      // command so launch needs no installed CLI (matches wizardux).
      await ES(`window.__mogging.templates.openWizard({ cwd: ${JSON.stringify(root)}, paneCount: 2, mix: [{ provider: 'custom:echo hi', count: 2 }] })`)
      await sleep(900)
      const shape = await ES<{ cards: number; steppers: number; overlays: number; app: boolean; rail: number }>(`(() => ({
        cards: document.querySelectorAll('#view-wizard .wizard > .card').length,
        steppers: document.querySelectorAll('.wizard-stepper').length,
        overlays: document.querySelectorAll('.modal-overlay').length,
        app: document.getElementById('app').classList.contains('view-wizard'),
        rail: document.querySelector('#rail')?.getBoundingClientRect().width ?? 0
      }))()`)
      const onePageOk = shape.cards === 3 && shape.steppers === 0 && shape.overlays === 0 && shape.app && shape.rail > 0

      stage = 'a-folderpick'
      // Pick a child folder BY CLICK — cwd, path bar and browser selection move as one.
      await ES(`(() => {
        const r = [...document.querySelectorAll('#view-wizard .fb-row')].find((x) => x.querySelector('.fb-row-name')?.textContent === 'project')
        r && r.click(); return 1
      })()`)
      await sleep(350)
      const pick = await ES<{ bar: string; sel: boolean }>(`(() => {
        const r = [...document.querySelectorAll('#view-wizard .fb-row')].find((x) => x.querySelector('.fb-row-name')?.textContent === 'project')
        return { bar: document.querySelector('#view-wizard .path-input-field')?.value ?? '', sel: !!r && r.classList.contains('is-selected') }
      })()`)
      const sot = await ES<{ agree: boolean }>(`window.__mogging.wizardPath()`)
      const folderPickOk = pick.bar === join(root, 'project') && pick.sel && sot.agree

      stage = 'a-launch'
      await ES(`document.querySelector('#view-wizard .wizard-footer .btn--primary').click()`)
      const launchOk = await waitTrue(`!!document.querySelector('#content.view-grid') && (window.__mogging.layout.paneCount?.() ?? 0) === 2`)
      const wsId = await ES<string>(`window.__mogging.workspace.active()?.id`)
      const a = { ok: homeOk && onePageOk && folderPickOk && launchOk, homeOk, onePageOk, folderPickOk, launchOk, shape, pick }

      // ══ (b) Settings — shell + grouped nav; overview-first; attention through fold ══
      stage = 'b-integrations-seed'
      // A failing webhook, entirely offline: port 1 on loopback refuses instantly — the
      // health flips to 'failing' with no packet leaving the host.
      const saved = saveWebhook({ label: 'uxm-dead-hook', url: 'http://127.0.0.1:1/hook', events: ['notify'] })
      emitBridgeEvent('notify', { workspace: wsId, note: 'fixture' })

      stage = 'b-shell'
      await openSettings('integrations')
      const navOk = await ES<boolean>(
        `document.querySelectorAll('.settings-nav-group').length >= 2 && !!document.querySelector('.settings-nav-item[data-target="integrations"]')`
      )

      stage = 'b-overview'
      // Three stats since app-held connections landed (Connections · Servers ·
      // Service keys) — webhooks and the trail report on their own tabs now.
      // Connections shows 'none' at zero, never '—'.
      const overviewOk = await waitTrue(
        `[...document.querySelectorAll('.integux-stats .integux-stat-value')].length === 3 &&
         [...document.querySelectorAll('.integux-stats .integux-stat-value')].every(e => (e.textContent||'').trim() && e.textContent.trim() !== '—')`
      )

      stage = 'b-legacy-hooks'
      // Every selector a prior gate (INTEGUX / WEBTRAIL / the gallery) reads must resolve
      // even with the cards folded — the body is hidden, never unbuilt. (The trail's
      // hooks moved with it to the Activity tab — asserted in stage e-trail-aa.)
      const HOOKS = ['.integux-intro', '.integux-privacy', '.integux-empty', '.toolplan-empty']
      const hookMap: Record<string, boolean> = {}
      for (const sel of HOOKS) hookMap[sel] = await waitTrue(`!!document.querySelector(${JSON.stringify(sel)})`, 20, 200)
      const hooksOk = Object.values(hookMap).every(Boolean)

      stage = 'b-attention-fold'
      // The seeded failing webhook reads 'failing' on its OWN tab now — per-row
      // health on an always-open page; there is no fold left to bury it under.
      await ES(`(document.querySelector('.settings-nav-item[data-target="webhooks"]')?.click(), 1)`)
      await sleep(400)
      const failingShown = await waitTrue(`!!document.querySelector('.evbridge-health.is-failing')`, 40, 250)
      const hookRowShown = await ES<boolean>(
        `[...document.querySelectorAll('.mgr-row .mgr-label')].some(e => (e.textContent||'').includes('uxm-dead-hook'))`
      )
      const attentionOk = failingShown && hookRowShown
      await ES(`(document.querySelector('.settings-nav-item[data-target="integrations"]')?.click(), 1)`)
      await sleep(300)

      stage = 'b-persist'
      // Disclosure persists across a leave/return. Connections is the default-open
      // card now (catalog starts folded): fold Connections, open Grants, come back —
      // both choices stick.
      const connectionsDefault = await cardOpen('connections')
      await toggleCard('connections')
      await sleep(150)
      await toggleCard('grants')
      await sleep(150)
      await leaveSettings()
      await openSettings('integrations')
      const persistOk = connectionsDefault && !(await cardOpen('connections')) && (await cardOpen('grants'))

      stage = 'b-usage'
      // Usage opens overview-first; a HOT fixture posts .usage-fill.is-hot on the collapsed
      // Providers header — the second attention-through-collapse, on the second surface.
      usageFixture(96, 91, 'Fake Pro (hot)')
      await ES(`(document.querySelector('.settings-nav-item[data-target="usage"]')?.click(), 1)`)
      await sleep(500)
      const usageOverviewOk = await waitTrue(`!!document.querySelector('.usage-tab .usage-overview')`)
      const usageHotOk = await waitTrue(`!!document.querySelector('.collapsible-card[data-collapsible="providers"] .cc-attn .usage-fill.is-hot')`, 50, 200)
      await leaveSettings()
      const b = { ok: navOk && overviewOk && hooksOk && attentionOk && persistOk && usageOverviewOk && usageHotOk, navOk, overviewOk, hooksOk, hookMap, attentionOk, persistOk, usageOverviewOk, usageHotOk, savedOk: saved.ok }

      // ══ (c) board + palette; safe-focused confirm; chrome; possession ═══════════
      stage = 'c-board'
      await ES(`document.querySelector('.titlebar-right .icon-btn[aria-label="Board"]')?.click()`)
      await waitTrue(`!!document.querySelector('#content.view-board')`)
      await sleep(300)
      const cardId = await ES<string>(`window.__mogging.board.createCard('Ship the parser rewrite', 'Notes the agent should get.')`)
      await ES(`(async () => {
        const c = window.__mogging.board.list().find((x) => x.id === ${JSON.stringify(cardId)})
        if (c) { await window.bridge.invoke('board:save', { ...c, paneId: 101, workspaceId: 'fx-ws' }); await window.__mogging.board.refresh() }
        return 1
      })()`)
      await ES(`window.__mogging.attention.setPaneState(101, 'attention')`)
      await ES(`window.bridge.invoke('integrations:link:set', { cardId: ${JSON.stringify(cardId)}, input: 'acme/web#12', cadence: 0 })`)
      await ES(`window.__mogging.board.refresh()`)
      await waitTrue(`!!document.querySelector('.board-card[data-card-id=${JSON.stringify(cardId)}] .board-link-chip')`, 40, 200)
      const chipRow = await ES<{ ok: boolean; dc: number; n: number }>(`(() => {
        const card = document.querySelector('.board-card[data-card-id=${JSON.stringify(cardId)}]')
        const attn = card?.querySelector('.board-chip-attention'), link = card?.querySelector('.board-link-chip')
        const chips = [...(card?.querySelectorAll('.board-card-foot > *') ?? [])].filter((n) => n.getClientRects().length)
        if (!attn || !link) return { ok: false, dc: -1, n: chips.length }
        const ra = attn.getBoundingClientRect(), rl = link.getBoundingClientRect()
        const dc = Math.abs((ra.top + ra.bottom) / 2 - (rl.top + rl.bottom) / 2)
        return { ok: dc <= 2 && chips.length >= 2, dc, n: chips.length }
      })()`)
      const countsOk = await ES<boolean>(`(() => {
        const lanes = [...document.querySelectorAll('.board-lane')]
        return lanes.length === 4 && lanes.every((l) => { const b = l.querySelector('.board-lane-head .count-badge'); return b && Number(b.textContent) === l.querySelectorAll('.board-card').length })
      })()`)
      const boardOk = chipRow.ok && countsOk

      stage = 'c-palette'
      await ES(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`)
      await waitTrue(`document.querySelector('.palette-overlay') && !document.querySelector('.palette-overlay').hidden`)
      const emptyRank = await ES<{ ok: boolean; pri: number[] }>(`(() => {
        const PRI = { Workspace: 6, Board: 5, Integrations: 4, App: 3, Trust: 2, Appearance: 1 }
        const pri = [...document.querySelectorAll('.palette-item')].map((it) => PRI[it.querySelector('.palette-item-hint')?.textContent] ?? 2)
        let nonIncreasing = true
        for (let i = 1; i < pri.length; i++) if (pri[i] > pri[i - 1]) nonIncreasing = false
        return { ok: nonIncreasing && new Set(pri).size >= 2, pri }
      })()`)
      await ES(`(() => { const i = document.querySelector('.palette-input'); i.value = 'board'; i.dispatchEvent(new Event('input')) })()`)
      await sleep(200)
      const highlightOk = await ES<boolean>(`!!document.querySelector('.palette-item .palette-match')`)
      await ES(`document.querySelector('.palette-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`)
      await sleep(300)
      const paletteClosed = await ES<boolean>(`document.querySelector('.palette-overlay').hidden === true`)
      const paletteOk = emptyRank.ok && highlightOk && paletteClosed

      stage = 'c-confirm'
      // A destructive confirm focuses the SAFE action, emphasizes the danger verb, and can
      // NEVER be silenced (bug #8): close a workspace holding a busy pane.
      await ES(`window.__mogging.workspace.create({ name: 'Feedback' })`)
      await sleep(1400)
      const meta = await ES<{ id: string; ordinal: number }>(`window.__mogging.workspace.active()`)
      await ES(`window.__mogging.attention.setPaneState(${meta.ordinal * 100 + 1}, 'busy')`)
      await sleep(300)
      await ES(`document.querySelector('.workspace-tab[data-ws-id="${meta.id}"] .ws-close')?.click()`)
      await sleep(500)
      const confirm = await ES<{ shown: boolean; focusSafe: boolean; emphasized: boolean; hasRemember: boolean }>(`(() => {
        const overlay = document.querySelector('.modal-overlay')
        if (!overlay) return { shown: false, focusSafe: false, emphasized: false, hasRemember: true }
        const danger = overlay.querySelector('.btn--danger'), ghost = overlay.querySelector('.btn--ghost')
        const border = danger ? getComputedStyle(danger).borderTopColor : 'rgba(0, 0, 0, 0)'
        return {
          shown: !!danger,
          focusSafe: !!ghost && document.activeElement === ghost,
          emphasized: border !== 'rgba(0, 0, 0, 0)' && border !== 'transparent',
          hasRemember: !!overlay.querySelector('input[type="checkbox"]')
        }
      })()`)
      await ES(`document.querySelector('.modal-overlay .btn--ghost')?.click()`)
      await sleep(400)
      const confirmOk = confirm.shown && confirm.focusSafe && confirm.emphasized && !confirm.hasRemember

      stage = 'c-chrome-tabs'
      // Grow the roster to 8 and shrink the window: the rail SCROLLS with an edge fade and
      // its tabs never shrink (08 — "scroll, not shrink").
      await ES(`(() => { const m = window.__mogging; for (let i = m.workspace.count(); i < 8; i++) m.workspace.create({ name: 'WS ' + (i + 1), activate: false }); m.workspace.switchByIndex(0); return 1 })()`)
      await sleep(2600)
      win.setSize(1200, 460)
      await sleep(700)
      const tabs = await ES<{ ok: boolean; count: number; scroll: boolean; fade: boolean; same: boolean }>(`(() => {
        const el = document.getElementById('workspace-tabs')
        const t = [...document.querySelectorAll('.workspace-tab')]
        const cs = getComputedStyle(el)
        const scroll = el.scrollHeight > el.clientHeight + 1
        const fade = el.classList.contains('fade-bot') || el.classList.contains('fade-top')
        const mask = (cs.maskImage && cs.maskImage !== 'none') || (cs.webkitMaskImage && cs.webkitMaskImage !== 'none')
        const hs = t.map((x) => Math.round(x.getBoundingClientRect().height)); const h0 = hs[0] || 0
        const same = hs.length >= 8 && hs.every((h) => h === h0) && h0 >= 40
        return { ok: scroll && fade && !!mask && same, count: t.length, scroll, fade, same }
      })()`)

      stage = 'c-chrome-pane'
      // A remote+role pane, narrow, renders a ONE-LINE header — state dot leading, chips
      // truncated not wrapped (bugs #9 + #12). Remote on slot idx 1 (see remote-smoke).
      const paneId = await ES<number>(`(() => {
        const m = window.__mogging
        m.workspace.create({ name: 'Remote', paneCount: 4, remotes: [null, { hostId: 'uxm-host', name: 'devbox-01' }, null, null], roles: [null, 'Reviewer', null, null] })
        return m.workspace.active().ordinal * 100 + 2
      })()`)
      await sleep(2600)
      // Wide enough that every chip is DRAWN: below ~540px of pane width the pane-bar
      // container queries retire them into the ⋯ menu by design (chromeux-smoke stage j
      // owns that contract). This gate is about the one-line/no-wrap layout, so it needs
      // the chips present — at 600px they are correctly gone, and `present` would fail.
      win.setSize(1450, 680)
      await sleep(800)
      // A 4-pane workspace tiles 2×2 (grid-layout: ceil(sqrt(4))=2 cols), so each pane is
      // only ~715px — and the FULLY lit bar (mcp "restart +2" · claims · role · remote ·
      // a full git chip · title) overflows that, so pane-header-fit CORRECTLY retires the
      // trailing left chips (role, remote) into ⋯. That is the overflow working, not the
      // no-wrap layout failing. Solo the measured pane to the whole window first so the bar
      // has the room the `present` check assumes — then nothing retires and the one-line
      // contract is what gets measured.
      await ES(`window.__mogging.layout.expand(${paneId}, 'full')`)
      await sleep(400)
      await ES(`(() => { const p = (window.__mogging.panes || []).find((p) => p.id === ${paneId}); if (p && p.lightChips) p.lightChips(); return 1 })()`)
      await sleep(400)
      const pane = await ES<{ ok: boolean; headerH: number; stateLeading: boolean; clipped: boolean; noWrapStyle: boolean; centersAligned: boolean; present: boolean }>(`(() => {
        // The state glyph is gated on a tracked provider session (availability
        // contract) — adopt one so the present check has a dot with real width.
        window.__mogging.agents.adopt(${paneId}, 'claude', '')
        const slot = document.querySelector('.layout-slot[data-pane-id="${paneId}"]')
        const left = slot?.querySelector('.pane-head-left'), header = slot?.querySelector('.pane-header')
        if (!left || !header) return { ok: false, headerH: -1, stateLeading: false, clipped: false, noWrapStyle: false, centersAligned: false, present: false }
        const q = (s) => left.querySelector(s)
        // The always-present chips (state/remote/role). NOT the trailing .pane-mcp — it is the
        // last, clippable chip and legitimately renders width 0 on the narrow header (the
        // overflow working). Requiring it > 0 is what false-failed CHROMEUX/UXMILESTONE on CI.
        const els = [q('.pane-state'), q('.pane-remote'), q('.pane-role')]
        const present = els.every((el) => el && el.getBoundingClientRect().width > 0)
        const headerH = Math.round(header.getBoundingClientRect().height)
        const fec = left.firstElementChild
        const stateLeading = !!fec && fec.classList.contains('pane-state')
        const cs = getComputedStyle(left)
        const clipped = cs.overflow === 'hidden' || cs.overflowX === 'hidden'
        // "chips truncate, never wrap" is the CSS CONTRACT — flex-wrap:nowrap + overflow:hidden —
        // asserted directly. A pixel-center proxy over ALL children false-fails when a trailing
        // chip clips to 0 width (the overflow WORKING, not a wrap); it was deterministic on CI's
        // soft-GL. Centers of the VISIBLE chips are kept as a diagnostic only.
        const noWrapStyle = cs.flexWrap === 'nowrap'
        const vis = [...left.children].filter((ch) => ch.getBoundingClientRect().width > 0)
        const mids = vis.map((ch) => { const r = ch.getBoundingClientRect(); return Math.round(r.top + r.height / 2) })
        const centersAligned = mids.length > 0 && mids.every((mid) => Math.abs(mid - mids[0]) <= 3)
        // <= 50: --pane-header-h (48px) + its 1px bottom rule. Taller means the chips
        // wrapped — the regression this asserts against — not merely that the bar grew.
        return { ok: present && headerH <= 50 && stateLeading && clipped && noWrapStyle, headerH, stateLeading, clipped, noWrapStyle, centersAligned, present }
      })()`)
      win.setSize(1200, 800)
      await sleep(500)
      const chromeOk = tabs.ok && pane.ok

      stage = 'c-possession'
      // An agent takes the wheel: the possession banner is present, styled, hit-testable
      // (§ Blockers #1), and it is NOT always-on (it appears only while driving).
      await ES(`window.__mogging.workspace.create({ name: 'Dock' })`)
      await sleep(1200)
      const dockWs = await ES<string>(`window.__mogging.workspace.active().id`)
      await ES(`window.__mogging.browser.toggle(true)`)
      await sleep(400)
      await ES(`window.__mogging.browser.setProfile('agent-web')`)
      await sleep(500)
      setAgentConsent(true, dockWs)
      setDrivingForSmoke(dockWs, true, 'example.com')
      await sleep(450)
      const possession = await ES<{ ok: boolean; driving: boolean; bannerShown: boolean; stopHit: boolean; labelOk: boolean }>(GUARD_JS)
      const c = { ok: boardOk && paletteOk && confirmOk && chromeOk && possession.ok, boardOk, chipRow, paletteOk, emptyRank, confirmOk, confirm, tabs, pane, possession }

      // ══ (e-possession/consent) AA on the possession + consent copy, while driving ══
      stage = 'e-possession-aa'
      foldIn(
        await probeContrastAcrossThemes({ es: ES, sleep, selectors: ['.browser-agent-label', '.browser-confirm-text', '.browser-agentweb-note-text'] })
      )

      // ══ (e-review) the review-gate indicator, its own scene ══
      stage = 'e-review-aa'
      await ES(`window.__mogging.review.showFixture(false)`)
      await waitTrue(`!!document.querySelector('.review-modal .review-gate')`)
      const gate = await ES<{ ok: boolean; hasIcon: boolean; text: string }>(`(() => {
        const chip = document.querySelector('.review-modal .review-gate-closed')
        return chip ? { ok: true, hasIcon: !!chip.querySelector('svg'), text: (chip.textContent || '').trim() } : { ok: false, hasIcon: false, text: '' }
      })()`)
      foldIn(await probeContrastAcrossThemes({ es: ES, sleep, selectors: ['.review-gate'] }))
      await ES(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
      await sleep(400)

      // ══ (e-trail + attention) the honesty line and an attention state, in Settings ══
      // The trail lives on Trust › Activity now (always open, no fold to prise); the
      // failing-health tone reads on the Webhooks tab. Probe each where it renders.
      stage = 'e-trail-aa'
      await openSettings('activity')
      await sleep(400)
      const trailHonestyOk = await ES<boolean>(
        `(document.querySelector('.trail-honesty')?.textContent || '').includes('never sent anywhere')`
      )
      foldIn(await probeContrastAcrossThemes({ es: ES, sleep, selectors: ['.trail-honesty'] }))
      await ES(`(document.querySelector('.settings-nav-item[data-target="webhooks"]')?.click(), 1)`)
      await sleep(400)
      foldIn(await probeContrastAcrossThemes({ es: ES, sleep, selectors: ['.evbridge-health.is-failing'] }))
      await leaveSettings()
      const e = {
        ok: safety.failures.length === 0 && safety.missing.length === 0 && gate.ok && gate.hasIcon && trailHonestyOk,
        gate,
        trailHonestyOk,
        failures: safety.failures,
        missing: safety.missing,
        worst: safety.worst
      }

      // ══ (d) the spacing gate, frozen at --max 0 (the real script, the one source) ══
      stage = 'd-spacing'
      const spacing = runSpacingGate()

      // ══ (f) the perf budget, sampled DURING the composed surface ═══════════════════
      // docs/05 budgets STEADY-STATE frame time — "worst rAF gap, during the stress
      // torrent AND idle", measured on a WARM grid — not the one-time cost of building a
      // view for the first time. So warm each composed view once OUTSIDE the window, then
      // sample the worst gap the surface sustains during warm workspace switches + an idle
      // tail: the same shape milestone-smoke and perception-smoke measure. Heap is read at
      // the end, with the whole composed world (10 workspaces, a board, a dock) still built.
      stage = 'f-budget'
      const budget = await ES<{ maxGapMs: number; longFrames100: number; frames: number; heapMB: number }>(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
        const m = window.__mogging
        const board = document.querySelector('.titlebar-right .icon-btn[aria-label="Board"]')
        // warm: pay each view's first-build cost before the sampler opens. (Home used to
        // be warmed here too; with workspaces built it is unreachable by design now.)
        board?.click(); await sleep(350); board?.click(); await sleep(350)
        m.workspace.switchByIndex(0); await sleep(500); m.workspace.switchByIndex(1); await sleep(900); m.workspace.switchByIndex(0); await sleep(500)
        const gaps = []
        let last = performance.now(); let on = true
        const tick = (now) => { gaps.push(now - last); last = now; if (on) requestAnimationFrame(tick) }
        requestAnimationFrame(tick)
        for (let i = 0; i < 8; i++) { m.workspace.switchByIndex(i % 2); await sleep(240) } // warm switches (GL warm)
        await sleep(1400) // idle window
        on = false
        const heapMB = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1
        return { maxGapMs: Math.round(Math.max.apply(null, gaps) * 10) / 10, longFrames100: gaps.filter((g) => g > 100).length, frames: gaps.length, heapMB }
      })()`)
      const gapOk = budget.maxGapMs <= BUDGET.maxFrameGapMs
      const heapOk = budget.heapMB === -1 || budget.heapMB <= BUDGET.maxHeapMB
      const f = {
        ok: gapOk && heapOk,
        gapOk,
        heapOk,
        sampled: budget,
        against: { maxFrameGapMs: BUDGET.maxFrameGapMs, maxHeapMB: BUDGET.maxHeapMB }
      }

      const pass = a.ok && b.ok && c.ok && spacing.ok && e.ok && f.ok
      result = { pass, a, b, c, d: spacing, e, f }
    } catch (err) {
      result = { pass: false, stage, error: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err) }
    }

    try {
      delete process.env.MOGGING_USAGE_FIXTURE
      getUsageService()?.refresh()
    } catch {
      /* best effort */
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'uxmilestone-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}

/**
 * (d) — run the REAL spacing gate at its freeze ceiling. Reuses the Electron binary as
 * Node (ELECTRON_RUN_AS_NODE) so there is no PATH dependency and no reimplementation:
 * `scripts/check-spacing.mjs --max 0` exits 0 only when every bucket — including the
 * shared `—` row — is zero. 01 shipped a broken awk that over-counted 33 as 94; this
 * runs the node script that replaced it.
 */
function runSpacingGate(): { ok: boolean; violations: number; out: string } {
  try {
    const out = execFileSync(process.execPath, ['scripts/check-spacing.mjs', '--max', '0'], {
      cwd: app.getAppPath(),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8'
    })
    const m = out.match(/spacing violations:\s*(\d+)/)
    return { ok: true, violations: m ? Number(m[1]) : 0, out: out.trim() }
  } catch (err) {
    const e = err as { stdout?: string | Buffer; stderr?: string | Buffer }
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.toString()
    const m = out.match(/spacing violations:\s*(\d+)/)
    return { ok: false, violations: m ? Number(m[1]) : -1, out: out.trim().slice(0, 800) }
  }
}
