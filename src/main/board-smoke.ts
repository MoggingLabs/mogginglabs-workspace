import { app, ipcMain, type BrowserWindow } from 'electron'
import { TerminalChannels } from '@contracts'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { capturePaneTokenForSmoke, settleToShell, sh } from './smoke-shell'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

// Env-gated Kanban-board smoke (MOGGING_BOARD, Phase-3/05):
//   1. a card persists across a renderer reload (db round-trip, not memory)
//   2. "Start agent on card" binds a pane (paneId = ordinal*100+1, lane -> doing)
//      and the task text is WRITTEN to that pane's PTY, once the agent is listening
//   3. flipping the bound pane to attention flags the card (orange + "needs you")
//   4. the reviewer's approval flags the card with a push-fed ✓-chip; removing the
//      worktree clears it (4/03 polish)
//   5. closing the pane unbinds the card (paneId cleared, persisted)
//
// Provider 'gemini' is a REAL launch. (2) used to scrape the pane's xterm buffer for the task
// text — an assertion about GEMINI's rendering, which the board neither owns nor can promise:
// a real agent takes the ALTERNATE screen, so the text it was handed is never echoed there and
// the gate failed as "the board is broken". The board's contract is the task IS the agent's
// first prompt: it must WRITE that text to that pane, once something is listening. So we
// witness the write itself, at the terminal effect (main's terminal:write, the same seam the
// pane's PTY is fed from), and we witness the daemon's typed-launch DETECTION for the pane —
// then assert the write carried the exact prompt, to the exact pane, AFTER the agent was seen
// running. That is stronger than the scrape ever was, and it is true whatever is on the PATH.
const MARKER = 'TASK_MARKER_4242'
const NOTES = 'Reverse the polarity of the neutron flow.'
/** The board's own fallback timer (startOnCard). A write that lands a beat after DETECTION is
 *  the feature working; one that lands on this timer is the feature guessing. */
const HAND_AFTER_DETECT_MS = 3000

export function runBoardSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 120000) // safety net
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  // THE WITNESS. Every byte the renderer sends to a PTY arrives here (daemon-relay listens on
  // the same channel and forwards it to the daemon) — so this sees the board's write exactly as
  // the pane's shell will, with no TUI in between to decide whether to echo it.
  const writes: { at: number; id: number; data: string }[] = []
  const onWrite = (_e: unknown, cmd: { id?: number; data?: string }): void => {
    writes.push({ at: Date.now(), id: Number(cmd?.id), data: String(cmd?.data ?? '') })
  }
  ipcMain.on(TerminalChannels.write, onWrite)

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      await sleep(1500) // launcher-first boot settles

      // 1) create -> reload -> still there (proves the db, not the cache).
      const title = `${MARKER} fix the flux capacitor`
      const cardId = String(
        await ES(`window.__mogging.board.createCard(${JSON.stringify(title)}, ${JSON.stringify(NOTES)})`)
      )
      await sleep(600)
      const reloaded = new Promise<void>((res) => wc.once('did-finish-load', () => res()))
      wc.reload()
      await reloaded
      await sleep(3000) // features remount, board loads from db

      // The second witness, registered AFTER the reload (which wipes the window): the daemon's
      // typed-launch detection — an agent CLI really appeared in the pane's PTY subtree. This is
      // the cue startOnCard now waits for, so it is the cue we hold it to.
      await ES(`(() => {
        const w = window
        w.__boardDetections = []
        window.bridge.on('terminal:agent', (p) => {
          if (p && p.agentId) w.__boardDetections.push({ id: Number(p.id), agentId: String(p.agentId), at: Date.now() })
        })
        return 1
      })()`)
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

      // 3) the task IS the first prompt — the board's actual contract, in three parts: the
      //    exact text, to the exact pane, only once an agent is really there to read it.
      const expected = `${title}\n\n${NOTES}\r`
      type Detection = { id: number; agentId: string; at: number }
      const detections = (): Promise<Detection[]> => ES<Detection[]>(`(window.__boardDetections || []).slice()`)
      let promptWrite: { at: number; id: number; data: string } | undefined
      let detected: Detection | undefined
      for (let i = 0; i < 40 && !promptWrite; i++) {
        promptWrite = writes.find((w) => w.id === paneId && w.data.includes(MARKER))
        detected = detected ?? (await detections()).find((d) => d.id === paneId)
        if (!promptWrite) await sleep(500)
      }
      detected = detected ?? (await detections()).find((d) => d.id === paneId)
      const textOk = promptWrite?.data === expected // the WHOLE task — title, blank line, notes
      const handMs = promptWrite && detected ? promptWrite.at - detected.at : null
      // Ordering, not duration: the write must FOLLOW the daemon's verdict that an agent is
      // running in this pane, and follow it by a beat — a write that arrived first, or minutes
      // later, is the 9s fallback timer firing, which means detection never worked.
      const afterDetectOk = handMs != null && handMs >= 0 && handMs <= HAND_AFTER_DETECT_MS
      const promptOk = textOk && !!detected && afterDetectOk

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

      // 4c) 5/05: the Board is a FULL-APP view — while it is open the rail is gone;
      // toggling back to the grid restores it.
      await ES(`document.querySelector('.titlebar-right .icon-btn[aria-label="Board"]').click()`)
      await sleep(500)
      const noRailOk = (await ES(
        `(() => {
          const rail = document.getElementById('rail')
          return document.querySelector('#content.view-board') !== null &&
            rail !== null && getComputedStyle(rail).display === 'none'
        })()`
      )) as boolean
      await ES(`document.querySelector('.titlebar-right .icon-btn[aria-label="Board"]').click()`)
      await sleep(400)
      const railBackOk = (await ES(
        `(() => { const rail = document.getElementById('rail'); return rail !== null && getComputedStyle(rail).display !== 'none' })()`
      )) as boolean

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
      // The USER names the reviewer. `mogging role` writes only the DAEMON's map, which every
      // pane can write and which no longer confers sign-off authority (daemon-relay: appRoles)
      // — a reviewer named that way would produce an approval the app correctly ignores.
      await ES(`window.__mogging.workspace.setRole(${paneId}, 'reviewer')`)
      await sleep(400) // the role reaches main (the trusted IPC) and the daemon
      const settled = await settleToShell({ es: ES, sleep, paneId })
      const paneToken = await capturePaneTokenForSmoke({
        write: async (command) => {
          const sent = await cli(['send', String(paneId), command])
          if (sent.code !== 0) throw new Error(`could not probe pane ${paneId}`)
        },
        sleep
      })
      const approveExit = (
        await cli(['approve', branch], {
          MOGGING_PANE_ID: String(paneId),
          MOGGING_PANE_TOKEN: paneToken
        })
      ).code
      let approvedChipOk = false
      for (let i = 0; i < 20 && !approvedChipOk; i++) {
        await sleep(500)
        approvedChipOk = (await ES(
          `(() => { const c = document.querySelector('.board-card[data-card-id="${cardId}"] .board-chip-approved'); return !!c })()`
        )) as boolean
      }
      // The launch command cd'd the pane INTO its worktree, and Windows refuses to remove a
      // directory that is a process's cwd — so the pane has to step out. But the AGENT owns the
      // keyboard: a `cd` typed at it goes into the agent's prompt, the pane never moves, and the
      // removal fails with a permission error that looks like anything but what it is. Get the
      // shell back and PROVE it before typing at it (settleToShell) — the sequence the product
      // requires of a person, which the gate used to sleep through.
      await ES(`window.bridge.send('terminal:write', { id: ${paneId}, data: ${JSON.stringify(sh.cd(anchor) + '\r')} })`)
      await sleep(1500)
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

      const pass = persistOk && bindOk && promptOk && attnOk && noRailOk && railBackOk && approvedChipOk && approvedChipGone && unbindOk
      result = { pass, persistOk, bindOk, promptOk, textOk, afterDetectOk, handMs, detected, wrote: promptWrite, settled, attnOk, attn, noRailOk, railBackOk, approveExit, approvedChipOk, approvedChipGone, removed, branch, gitQ, wtDirs, unbindOk, paneId, cardId }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    ipcMain.off(TerminalChannels.write, onWrite)
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
