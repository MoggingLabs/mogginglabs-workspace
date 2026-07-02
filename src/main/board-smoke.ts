import { app, type BrowserWindow } from 'electron'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Env-gated Kanban-board smoke (MOGGING_BOARD, Phase-3/05):
//   1. a card persists across a renderer reload (db round-trip, not memory)
//   2. "Start agent on card" binds a pane (paneId = ordinal*100+1, lane -> doing)
//      and the task text reaches the PTY as the first prompt (marker in the buffer)
//   3. flipping the bound pane to attention flags the card (orange + "needs you")
//   4. closing the pane unbinds the card (paneId cleared, persisted)
// Provider 'gemini' is deliberately not installed here: the launch no-ops, but the
// prompt write + binding (the board's own responsibilities) are fully exercised.
const MARKER = 'TASK_MARKER_4242'

export function runBoardSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 120000) // safety net
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      await sleep(1500) // launcher-first boot settles

      // 1) create -> reload -> still there (proves the db, not the cache).
      const cardId = String(
        await ES(`window.__mogging.board.createCard(${JSON.stringify(MARKER + ' fix the flux capacitor')}, 'Reverse the polarity of the neutron flow.')`)
      )
      await sleep(600)
      const reloaded = new Promise<void>((res) => wc.once('did-finish-load', () => res()))
      wc.reload()
      await reloaded
      await sleep(3000) // features remount, board loads from db
      type Card = { id: string; title: string; lane: string; paneId?: number | null }
      const afterReload = (await ES(`window.__mogging.board.list()`)) as Card[]
      const persisted = afterReload.find((c) => c.id === cardId)
      const persistOk = !!persisted && persisted.title.includes(MARKER) && persisted.lane === 'todo'

      // 2) anchor workspace (plain dir; worktree isolation is 03's smoke) + start.
      const anchor = mkdtempSync(join(tmpdir(), 'mogging-board-'))
      writeFileSync(join(anchor, 'readme.txt'), 'anchor\n')
      await ES(`window.__mogging.workspace.create({ name: 'Anchor', cwd: ${JSON.stringify(anchor)} })`)
      await sleep(1800)
      const started = (await ES(`window.__mogging.board.startOnCard(${JSON.stringify(cardId)}, 'gemini')`)) as boolean
      await sleep(1200)
      const afterStart = (await ES(`window.__mogging.board.list()`)) as Card[]
      const bound = afterStart.find((c) => c.id === cardId)
      const paneId = bound?.paneId ?? 0
      const bindOk = started && !!bound && !!paneId && paneId % 100 === 1 && bound.lane === 'doing'

      // 3) the task IS the first prompt: the marker lands in the pane's buffer.
      const bufferText = (id: number): Promise<string> =>
        ES<string>(
          `(() => {
            const p = (window.__mogging.panes || []).find((x) => x.id === ${id})
            if (!p) return ''
            const b = p.term.buffer.active
            let s = ''
            for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) s += l.translateToString(true) + '\\n' }
            return s
          })()`
        )
      let promptOk = false
      for (let i = 0; i < 30; i++) {
        if ((await bufferText(paneId)).includes(MARKER)) {
          promptOk = true
          break
        }
        await sleep(500)
      }

      // 4) attention flip -> the card flags orange with a "needs you" chip.
      await ES(`window.__mogging.attention.setPaneState(${paneId}, 'attention')`)
      await sleep(600)
      const attn = (await ES(
        `(() => {
          const card = document.querySelector('.board-card[data-card-id="${cardId}"]')
          if (!card) return { found: false }
          return {
            found: true,
            flagged: card.getAttribute('data-attention') === 'true',
            chip: !!card.querySelector('.board-chip-attention')
          }
        })()`
      )) as { found: boolean; flagged?: boolean; chip?: boolean }
      const attnOk = attn.found && attn.flagged === true && attn.chip === true

      // 5) closing the pane unbinds the card (persisted, not just visual).
      await ES(`window.__mogging.layout.close(${paneId})`)
      let unbindOk = false
      for (let i = 0; i < 20; i++) {
        const list = (await ES(`window.__mogging.board.list()`)) as Card[]
        const c = list.find((x) => x.id === cardId)
        if (c && (c.paneId == null || c.paneId === 0)) {
          unbindOk = true
          break
        }
        await sleep(400)
      }

      const pass = persistOk && bindOk && promptOk && attnOk && unbindOk
      result = { pass, persistOk, bindOk, promptOk, attnOk, attn, unbindOk, paneId, cardId }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'board-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(run, 2500))
  else setTimeout(run, 2500)
}
