import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { probeContrastAcrossThemes } from './aa-probe'
import { getSettingsStore } from '../app-settings'

// Env-gated Board + palette smoke (MOGGING_BOARDUX, Phase-8.5/07). Fixture board, no
// agent launch (a card is bound to a fixture pane-id via board:save + attention).
//   (a) a card with a bound pane + a service link renders ONE aligned chip row (the
//       attention chip + the link chip share a baseline — bounding-box assert);
//   (b) lane headers show a CountBadge equal to the lane's card count, and the header
//       stays put while the lane's cards scroll;
//   (c) the ⋯ menu opens FULLY inside the viewport — not clipped by the lane scroller;
//   (d) Delete card raises a confirm; Cancel keeps the card (bug #7);
//   (e) the palette opens, an empty query ranks top verbs (categories descending, not
//       registration order), a typed query highlights matches, and Enter runs + closes;
//   (f) MEASURED: lane gutter ≥ --sp-4, card padding ≥ --sp-4;
//   (g) AA ≥ 4.5 on the card + lane text in all four themes, via the shared aa-probe.
export function runBoardUxSmoke(win: BrowserWindow): void {
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
      await ES(`document.querySelector('.titlebar-right .icon-btn[aria-label="Board"]')?.click()`)
      await waitTrue(`!!document.querySelector('#content.view-board')`)
      await sleep(300)

      // ── fixtures ──────────────────────────────────────────────────────────
      const cardId = await ES<string>(`window.__mogging.board.createCard('Ship the parser rewrite', 'Notes the agent should get.')`)
      // Bind a fixture pane-id (no launch) + flag attention -> the state chip renders;
      // a service link -> the link chip renders. Two chips on one card = an aligned row.
      await ES(`(async () => {
        const c = window.__mogging.board.list().find((x) => x.id === ${JSON.stringify(cardId)})
        if (c) { await window.bridge.invoke('board:patch', { id: c.id, patch: { paneId: 101, workspaceId: 'fx-ws' } }); await window.__mogging.board.refresh() }
        return 1
      })()`)
      await ES(`window.__mogging.attention.setPaneState(101, 'attention')`)
      await ES(`window.bridge.invoke('integrations:link:set', { cardId: ${JSON.stringify(cardId)}, input: 'acme/web#12', cadence: 0 })`)
      await ES(`window.__mogging.board.refresh()`)
      // Enough cards in one lane to force a scroll (for the sticky-header check).
      await ES(`for (let i = 0; i < 8; i++) window.__mogging.board.createCard('Backlog ' + i, '')`)
      await ES(`window.__mogging.board.refresh()`)
      await waitTrue(`!!document.querySelector('.board-card[data-card-id=${JSON.stringify(cardId)}] .board-link-chip')`, 40, 200)
      await sleep(300)

      // (a) ONE aligned chip row.
      const chipRow = await ES<{ ok: boolean; n: number; dc: number }>(`(() => {
        const card = document.querySelector('.board-card[data-card-id=${JSON.stringify(cardId)}]')
        const attn = card?.querySelector('.board-chip-attention'), link = card?.querySelector('.board-link-chip')
        const chips = [...(card?.querySelectorAll('.board-card-foot > *') ?? [])].filter((n) => n.getClientRects().length)
        if (!attn || !link) return { ok: false, n: chips.length, dc: -1 }
        const ra = attn.getBoundingClientRect(), rl = link.getBoundingClientRect()
        const dc = Math.abs((ra.top + ra.bottom) / 2 - (rl.top + rl.bottom) / 2)
        return { ok: dc <= 2 && chips.length >= 2, n: chips.length, dc }
      })()`)
      const chipRowOk = chipRow.ok

      // (b) lane counts (CountBadge) + sticky header under scroll.
      const lanes = await ES<{ lane: string; count: string | null; cards: number }[]>(`[...document.querySelectorAll('.board-lane')].map((l) => ({
        lane: l.dataset.lane,
        count: l.querySelector('.board-lane-head .count-badge')?.textContent ?? null,
        cards: l.querySelectorAll('.board-card').length
      }))`)
      const countsOk = lanes.length === 5 && lanes.every((l) => l.count != null && Number(l.count) === l.cards)
      const stickOk = await ES<boolean>(`(() => {
        const lane = document.querySelector('.board-lane[data-lane="todo"]')
        const head = lane.querySelector('.board-lane-head'), scroller = lane.querySelector('.board-lane-cards')
        const before = head.getBoundingClientRect().top
        scroller.scrollTop = 9999
        const after = head.getBoundingClientRect().top
        return Math.abs(before - after) <= 1
      })()`)

      // (c) ⋯ menu opens fully inside the viewport. Bounded WAIT, not a fixed sleep —
      // the same mount race (d) below already learned: at 200ms on a slow runner the
      // portal had not mounted, `!m` read as "clipped", and menuOk failed with the
      // product correct (windows sweep, run 29577387596).
      await ES(`document.querySelector('.board-card[data-card-id=${JSON.stringify(cardId)}] .board-card-more').click()`)
      await waitTrue(`!!document.querySelector('.ctx-menu .ctx-item')`)
      // The card ⋯ is a REAL menu now (role=menu/menuitem, roving focus, Escape, focus return),
      // portaled to <body> by the shared context-menu primitive — it is no longer a hand-rolled
      // `div.menu[hidden]` inside the card. Same contract, new selectors (finding 31).
      const menu = await ES<{ ok: boolean }>(`(() => {
        const m = document.querySelector('.ctx-menu')
        if (!m) return { ok: false }
        const r = m.getBoundingClientRect()
        return { ok: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight }
      })()`)
      const menuOk = menu.ok
      await ES(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
      await sleep(150)

      // (d) Delete card -> confirm; Cancel keeps the card. Bounded WAITS, not fixed
      // sleeps: the re-open after (c)'s dismissal raced a 200ms sleep in two separate
      // certification sweeps (menu not yet mounted -> the optional-chained Delete click
      // silently no-opped -> no modal, confirmShown false).
      await ES(`document.querySelector('.board-card[data-card-id=${JSON.stringify(cardId)}] .board-card-more').click()`)
      const menuReopened = await waitTrue(`!!document.querySelector('.ctx-menu .ctx-item')`)
      await ES(`[...document.querySelectorAll('.ctx-menu .ctx-item')].find((b) => /Delete card/.test(b.textContent || ''))?.click()`)
      await waitTrue(`!!document.querySelector('.modal-overlay')`)
      const confirmShown =
        menuReopened &&
        (await ES<boolean>(`!!document.querySelector('.modal-overlay') && /delete/i.test(document.querySelector('.modal-overlay')?.textContent || '')`))
      await ES(`[...document.querySelectorAll('.modal-overlay button')].find((b) => /^Cancel$/.test((b.textContent || '').trim()))?.click()`)
      await sleep(300)
      const cardKept = await ES<boolean>(`window.__mogging.board.list().some((c) => c.id === ${JSON.stringify(cardId)})`)
      const deleteConfirmOk = confirmShown && cardKept

      // (e) palette: empty-query top-verbs ranking, match highlight, Enter runs + closes.
      await ES(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`)
      await waitTrue(`document.querySelector('.palette-overlay') && !document.querySelector('.palette-overlay').hidden`)
      const empty = await ES<{ ok: boolean; pri: number[] }>(`(() => {
        const PRI = { Workspace: 6, Board: 5, Integrations: 4, App: 3, Trust: 2, Appearance: 1 }
        const pri = [...document.querySelectorAll('.palette-item')].map((it) => PRI[it.querySelector('.palette-item-hint')?.textContent] ?? 2)
        let nonIncreasing = true
        for (let i = 1; i < pri.length; i++) if (pri[i] > pri[i - 1]) nonIncreasing = false
        return { ok: nonIncreasing && new Set(pri).size >= 2, pri } // sorted by category, spanning ≥2 = not registration order
      })()`)
      await ES(`(() => { const i = document.querySelector('.palette-input'); i.value = 'board'; i.dispatchEvent(new Event('input')) })()`)
      await sleep(200)
      const highlightOk = await ES<boolean>(`!!document.querySelector('.palette-item .palette-match')`)
      await ES(`document.querySelector('.palette-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`)
      await sleep(300)
      const enterRan = await ES<boolean>(`document.querySelector('.palette-overlay').hidden === true`)
      const paletteOk = empty.ok && highlightOk && enterRan

      // (f) measured spacing (re-open the board; Enter may have navigated).
      await ES(`(document.querySelector('#content.view-board') ? 1 : (document.querySelector('.titlebar-right .icon-btn[aria-label="Board"]')?.click(), 1))`)
      await sleep(300)
      const measured = await ES<{ lanePad: number; cardPad: number; sp4: number }>(`(() => {
        const lane = document.querySelector('.board-lane'), card = document.querySelector('.board-card')
        const sp4 = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sp-4')) || 16
        return { lanePad: lane ? parseFloat(getComputedStyle(lane).paddingTop) : 0, cardPad: card ? parseFloat(getComputedStyle(card).paddingTop) : 0, sp4 }
      })()`)
      const spacingOk = measured.lanePad >= measured.sp4 - 0.5 && measured.cardPad >= measured.sp4 - 0.5

      // ── Board v2 visual system (M3): every cue is a RENDER of stored state ──
      // (h) priority edge, label dots, blocked + overdue chips — patched on,
      // painted on; patched off... covered by the filter reset below.
      await ES(`window.bridge.invoke('board:patch', { id: ${JSON.stringify(cardId)}, patch: {
        priority: 'urgent', labels: ['parser', 'perf'], blocked: true, blockedReason: 'waiting on the API freeze',
        dueAt: Date.now() - 86400000
      } })`)
      await waitTrue(`document.querySelector('.board-card[data-card-id=${JSON.stringify(cardId)}]')?.dataset.priority === 'urgent'`)
      const cues = await ES<{ labels: number; blocked: boolean; overdue: boolean; edge: string }>(`(() => {
        const card = document.querySelector('.board-card[data-card-id=${JSON.stringify(cardId)}]')
        return {
          labels: card?.querySelectorAll('.board-label').length ?? 0,
          blocked: !!card?.querySelector('.board-chip-blocked'),
          overdue: !!card?.querySelector('.board-chip-due.is-overdue'),
          edge: card?.dataset.priority ?? ''
        }
      })()`)
      const cuesOk = cues.edge === 'urgent' && cues.labels === 2 && cues.blocked && cues.overdue

      // (i) WIP limit: the lane head trades its badge for count/limit + is-over.
      const wipSet = await ES<boolean>(`(async () => {
        const b = window.__mogging.board.activeBoard()
        if (!b) return false
        await window.bridge.invoke('board:boardPatch', { id: b.id, patch: { config: { wip: { todo: 2 } } } })
        await window.__mogging.board.refresh()
        return true
      })()`)
      const wip = await ES<{ text: string; over: boolean }>(`(() => {
        const w = document.querySelector('.board-lane[data-lane="todo"] .board-wip')
        return { text: w?.textContent ?? '', over: !!w?.classList.contains('is-over') }
      })()`)
      const wipOk = wipSet && /\d+ \/ 2/.test(wip.text) && wip.over

      // (j) aging: an idle-in-WIP card wears its idle days (planted via the
      // store — trusted layer — because the one writer stamps updatedAt).
      const agedId = String(await ES(`window.__mogging.board.createCard('Aged card', 'sat around')`))
      await ES(`window.bridge.invoke('board:patch', { id: ${JSON.stringify(agedId)}, patch: { lane: 'doing' } })`)
      await sleep(300)
      const store = getSettingsStore()
      const agedRow = store?.getCard(agedId)
      if (store && agedRow) store.putCard({ ...agedRow, updatedAt: Date.now() - 5 * 86400000 })
      await ES(`window.__mogging.board.refresh()`)
      const aging = await waitTrue(
        `document.querySelector('.board-card[data-card-id=${JSON.stringify(agedId)}]')?.dataset.aged === 'true' && /idle \\d+d/.test(document.querySelector('.board-card[data-card-id=${JSON.stringify(agedId)}] .board-chip-aging')?.textContent || '')`
      )

      // (k) the filter actually filters: text narrows, the pill narrows, and
      // clearing restores — counts follow what is VISIBLE.
      const beforeFilter = await ES<number>(`document.querySelectorAll('.board-card').length`)
      await ES(`(() => { const i = document.querySelector('.board-filter-input'); i.value = 'parser'; i.dispatchEvent(new Event('input')) })()`)
      await sleep(300)
      const textFiltered = await ES<{ cards: number; title: string }>(`(() => ({
        cards: document.querySelectorAll('.board-card').length,
        title: document.querySelector('.board-card .board-card-title')?.textContent ?? ''
      }))()`)
      await ES(`(() => { const i = document.querySelector('.board-filter-input'); i.value = ''; i.dispatchEvent(new Event('input')) })()`)
      await sleep(200)
      await ES(`[...document.querySelectorAll('.board-filter-pill')].find((p) => /Urgent/.test(p.textContent || ''))?.click()`)
      await sleep(300)
      const pillFiltered = await ES<number>(`document.querySelectorAll('.board-card').length`)
      await ES(`[...document.querySelectorAll('.board-filter-pill')].find((p) => /Urgent/.test(p.textContent || ''))?.click()`)
      await sleep(300)
      const afterClear = await ES<number>(`document.querySelectorAll('.board-card').length`)
      const filterOk =
        beforeFilter > 2 &&
        textFiltered.cards === 1 &&
        textFiltered.title.includes('parser rewrite') &&
        pillFiltered === 1 &&
        afterClear === beforeFilter

      // (l) the detail modal edits metadata and shows the activity tail.
      await ES(`document.querySelector('.board-card[data-card-id=${JSON.stringify(agedId)}]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
      await waitTrue(`!!document.querySelector('.board-edit-priorities')`)
      const detailBits = await ES<{ activity: boolean; priorities: number }>(`(() => ({
        activity: !!document.querySelector('.board-activity'),
        priorities: document.querySelectorAll('.board-edit-priority').length
      }))()`)
      await ES(`[...document.querySelectorAll('.board-edit-priority')].find((b) => /High/.test(b.textContent || ''))?.click()`)
      await ES(`[...document.querySelectorAll('.modal-overlay button')].find((b) => /^Save$/.test((b.textContent || '').trim()))?.click()`)
      const savedPriority = await waitTrue(
        `document.querySelector('.board-card[data-card-id=${JSON.stringify(agedId)}]')?.dataset.priority === 'high'`
      )
      const detailOk = detailBits.activity && detailBits.priorities === 4 && savedPriority

      // (m) the archived viewer restores.
      await ES(`window.bridge.invoke('board:patch', { id: ${JSON.stringify(agedId)}, patch: { archivedAt: Date.now() } })`)
      await sleep(300)
      await ES(`document.querySelector('.board-head-menu')?.click()`)
      await waitTrue(`!!document.querySelector('.ctx-menu .ctx-item')`)
      await ES(`[...document.querySelectorAll('.ctx-menu .ctx-item')].find((x) => /Show archived/.test(x.textContent || ''))?.click()`)
      await waitTrue(`!!document.querySelector('.board-archived-row')`)
      await ES(`[...document.querySelectorAll('.board-archived-row button')].find((b) => /Restore/.test(b.textContent || ''))?.click()`)
      const restored = await waitTrue(
        `!!document.querySelector('.board-card[data-card-id=${JSON.stringify(agedId)}]')`,
        30,
        250
      )
      await ES(`[...document.querySelectorAll('.modal-overlay button')].find((b) => /^Close$/.test((b.textContent || '').trim()))?.click()`)
      await sleep(300)
      const archiveUiOk = restored

      // (g) AA on card + lane text — now INCLUDING the v2 cues — four themes.
      const aa = await probeContrastAcrossThemes({
        es: ES,
        sleep,
        selectors: [
          '.board-card-title',
          '.board-card-notes',
          '.board-lane-title',
          '.count-badge',
          '.board-chip',
          '.board-link-chip',
          '.board-wip',
          '.board-label',
          '.board-chip-blocked',
          '.board-chip-due',
          '.board-switcher-name'
        ]
      })
      const aaOk = aa.failures.length === 0 && aa.missing.length === 0

      const pass =
        chipRowOk && countsOk && stickOk && menuOk && deleteConfirmOk && paletteOk && spacingOk && aaOk &&
        cuesOk && wipOk && aging && filterOk && detailOk && archiveUiOk
      result = {
        pass,
        chipRowOk,
        chipRow,
        countsOk,
        lanes,
        stickOk,
        menuOk,
        deleteConfirmOk,
        confirmShown,
        cardKept,
        paletteOk,
        emptyRank: empty,
        highlightOk,
        enterRan,
        spacingOk,
        measured,
        cuesOk,
        cues,
        wipOk,
        wip,
        aging,
        filterOk,
        filter: { beforeFilter, textFiltered, pillFiltered, afterClear },
        detailOk,
        detailBits,
        archiveUiOk,
        aaOk,
        aaFailures: aa.failures,
        aaMissing: aa.missing,
        aaWorst: aa.worst
      }
    } catch (e) {
      result = { pass: false, error: e instanceof Error ? e.message : String(e) }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'boardux-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}
