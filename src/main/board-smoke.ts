import { app, type BrowserWindow } from 'electron'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

// Env-gated Kanban-board smoke (MOGGING_BOARD, Phase-3/05):
//   1. a card persists across a renderer reload (db round-trip, not memory)
//   2. "Start agent on card" binds a pane (paneId = ordinal*100+1, lane -> doing)
//      and the task text reaches the PTY as the first prompt (marker in the buffer)
//   3. flipping the bound pane to attention flags the card (orange + "needs you")
//   4. the reviewer's approval flags the card with a push-fed ✓-chip; removing the
//      worktree clears it (4/03 polish)
//   5. closing the pane unbinds the card (paneId cleared, persisted)
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

      // 2) anchor workspace — a REPO, so start-on-card isolates in a worktree (the
      // ✓-chip keys on the worktree branch).
      const anchor = mkdtempSync(join(tmpdir(), 'mogging-board-'))
      git(anchor, ['init'])
      git(anchor, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
      git(anchor, ['config', 'user.email', 'smoke@mogging.test'])
      git(anchor, ['config', 'user.name', 'Mogging Smoke'])
      git(anchor, ['config', 'commit.gpgsign', 'false'])
      writeFileSync(join(anchor, 'readme.txt'), 'anchor\n')
      git(anchor, ['add', '-A'])
      git(anchor, ['commit', '-m', 'init'])
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

      // 4b) reviewer approval -> push-fed ✓-chip; worktree removal clears it.
      const cliPath = join(app.getAppPath(), 'bin', 'mogging.mjs')
      const cli = (args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number }> =>
        new Promise((resolveCli) => {
          execFile(
            process.execPath,
            [cliPath, ...args],
            { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...extraEnv }, timeout: 15000, windowsHide: true },
            (err) => resolveCli({ code: err ? 1 : 0 })
          )
        })
      const gitQ = await ES(`window.bridge.invoke('git:query', ${JSON.stringify(anchor)})`)
      const wtRoot = join(anchor, '.mogging', 'worktrees')
      const wtDirs = existsSync(wtRoot) ? readdirSync(wtRoot) : []
      const branch = wtDirs.length === 1 ? `mogging/${wtDirs[0]}` : ''
      await cli(['role', String(paneId), 'reviewer'])
      const approveExit = (await cli(['approve', branch], { MOGGING_PANE_ID: String(paneId) })).code
      let approvedChipOk = false
      for (let i = 0; i < 20 && !approvedChipOk; i++) {
        await sleep(500)
        approvedChipOk = (await ES(
          `(() => { const c = document.querySelector('.board-card[data-card-id="${cardId}"] .board-chip-approved'); return !!c })()`
        )) as boolean
      }
      // The launch command cd'd the pane INTO its worktree — step it out first
      // (Windows refuses to remove a directory that is a process's cwd).
      await ES(`window.bridge.send('terminal:write', { id: ${paneId}, data: ${JSON.stringify(`cd /d "${anchor}"\r`)} })`)
      await sleep(1200)
      const removed = await ES(
        `window.bridge.invoke('worktrees:remove', ${JSON.stringify({ repo: anchor, path: join(wtRoot, wtDirs[0] ?? ''), force: true })})`
      )
      let approvedChipGone = false
      for (let i = 0; i < 20 && !approvedChipGone; i++) {
        await sleep(500)
        approvedChipGone = (await ES(
          `(() => { const c = document.querySelector('.board-card[data-card-id="${cardId}"] .board-chip-approved'); return !c })()`
        )) as boolean
      }

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

      const pass = persistOk && bindOk && promptOk && attnOk && approvedChipOk && approvedChipGone && unbindOk
      result = { pass, persistOk, bindOk, promptOk, attnOk, attn, approveExit, approvedChipOk, approvedChipGone, removed, branch, gitQ, wtDirs, unbindOk, paneId, cardId }
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
