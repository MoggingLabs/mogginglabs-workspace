import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { probeContrastAcrossThemes } from './aa-probe'

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
        if (c) { await window.bridge.invoke('board:save', { ...c, paneId: 101, workspaceId: 'fx-ws' }); await window.__mogging.board.refresh() }
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
      const countsOk = lanes.length === 4 && lanes.every((l) => l.count != null && Number(l.count) === l.cards)
      const stickOk = await ES<boolean>(`(() => {
        const lane = document.querySelector('.board-lane[data-lane="todo"]')
        const head = lane.querySelector('.board-lane-head'), scroller = lane.querySelector('.board-lane-cards')
        const before = head.getBoundingClientRect().top
        scroller.scrollTop = 9999
        const after = head.getBoundingClientRect().top
        return Math.abs(before - after) <= 1
      })()`)

      // (c) ⋯ menu opens fully inside the viewport.
      await ES(`document.querySelector('.board-card[data-card-id=${JSON.stringify(cardId)}] .board-card-more').click()`)
      await sleep(200)
      const menu = await ES<{ ok: boolean }>(`(() => {
        const m = document.querySelector('.board-card-menu:not([hidden])')
        if (!m) return { ok: false }
        const r = m.getBoundingClientRect()
        return { ok: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight }
      })()`)
      const menuOk = menu.ok
      await ES(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
      await sleep(150)

      // (d) Delete card -> confirm; Cancel keeps the card.
      await ES(`document.querySelector('.board-card[data-card-id=${JSON.stringify(cardId)}] .board-card-more').click()`)
      await sleep(200)
      await ES(`[...document.querySelectorAll('.board-card-menu:not([hidden]) .menu-item')].find((b) => /Delete card/.test(b.textContent || ''))?.click()`)
      await sleep(300)
      const confirmShown = await ES<boolean>(`!!document.querySelector('.modal-overlay') && /delete/i.test(document.querySelector('.modal-overlay')?.textContent || '')`)
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

      // (g) AA on card + lane text, four themes.
      const aa = await probeContrastAcrossThemes({
        es: ES,
        sleep,
        selectors: ['.board-card-title', '.board-card-notes', '.board-lane-title', '.count-badge', '.board-chip', '.board-link-chip']
      })
      const aaOk = aa.failures.length === 0 && aa.missing.length === 0

      const pass = chipRowOk && countsOk && stickOk && menuOk && deleteConfirmOk && paletteOk && spacingOk && aaOk
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
