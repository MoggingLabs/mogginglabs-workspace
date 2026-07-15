import { app, ipcMain, type BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TerminalChannels } from '@contracts'

// Regression gate for audit P0/03. A failed or unknown agent must NEVER turn a Board
// card's prose into shell input. The positive handoff remains BOARD; this gate holds the
// negative path: no typed-launch detection -> no task write, an explicit sticky error, and
// an action back to the diagnostic pane.
const MARKER = 'BOARD_FAIL_CLOSED_7171'
const REUSE_MARKER = 'BOARD_REUSED_PANE_7171'
const SLOW_MARKER = 'BOARD_SLOW_READY_7171'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

export function runBoardFailSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 90000)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const writes: { id: number; data: string }[] = []
  const onWrite = (_e: unknown, cmd: { id?: number; data?: string }): void => {
    writes.push({ id: Number(cmd?.id), data: String(cmd?.data ?? '') })
  }
  ipcMain.on(TerminalChannels.write, onWrite)

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      const repo = mkdtempSync(join(tmpdir(), 'mogging-board-fail-'))
      git(repo, ['init'])
      git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
      git(repo, ['config', 'user.email', 'smoke@mogging.test'])
      git(repo, ['config', 'user.name', 'Mogging Smoke'])
      git(repo, ['config', 'commit.gpgsign', 'false'])
      writeFileSync(join(repo, 'README.md'), 'board fail-closed\n')
      git(repo, ['add', '-A'])
      git(repo, ['commit', '-m', 'init'])

      await sleep(1800)
      await ES(`window.__mogging.workspace.create({ name: 'Anchor', cwd: ${JSON.stringify(repo)} })`)
      await sleep(1500)
      const cardId = String(await ES(`window.__mogging.board.createCard(${JSON.stringify(`${MARKER} do not execute`)}, 'echo SHOULD_NOT_RUN')`))
      const started = Boolean(await ES(`window.__mogging.board.startOnCard(${JSON.stringify(cardId)}, 'missing-audit-agent')`))

      // Start a second handoff, then retire and recreate its exact numeric pane
      // id before publishing a running-agent verdict. A stale timer/listener must
      // not write the old card into the replacement shell.
      const reuseCardId = String(await ES(`window.__mogging.board.createCard(${JSON.stringify(`${REUSE_MARKER} do not execute`)}, '')`))
      const reuseStarted = Boolean(await ES(`window.__mogging.board.startOnCard(${JSON.stringify(reuseCardId)}, 'missing-audit-agent')`))
      await sleep(500)
      const reuseBefore = ((await ES(`window.__mogging.board.list()`)) as { id: string; paneId?: number; workspaceId?: string }[])
        .find((c) => c.id === reuseCardId)
      const reusePane = reuseBefore?.paneId ?? 0
      await ES(`window.__mogging.layout.split('h')`)
      await sleep(350)
      await ES(`window.__mogging.layout.close(${reusePane})`)
      await sleep(350)
      await ES(`window.__mogging.layout.split('h')`)
      await sleep(500)
      const idWasReused = Boolean(await ES(`window.__mogging.layout.paneIds().includes(${reusePane})`))
      await ES(`window.__mogging.agents.detected({ id: ${reusePane}, agentId: 'claude', cwd: '', sinceMs: Date.now() })`)

      // A third handoff becomes ready just before its startup deadline. The
      // readiness verdict owns the subsequent 800 ms settle beat; the failure
      // timer must not win merely because that beat crosses nine seconds.
      const slowCardId = String(await ES(`window.__mogging.board.createCard(${JSON.stringify(`${SLOW_MARKER} hand off`)}, '')`))
      const slowStarted = Boolean(await ES(`window.__mogging.board.startOnCard(${JSON.stringify(slowCardId)}, 'missing-audit-agent')`))
      await sleep(8500)
      const slowBefore = ((await ES(`window.__mogging.board.list()`)) as { id: string; paneId?: number }[])
        .find((c) => c.id === slowCardId)
      const slowPane = slowBefore?.paneId ?? 0
      await ES(`window.__mogging.agents.detected({ id: ${slowPane}, agentId: 'claude', cwd: '', sinceMs: Date.now() })`)
      await sleep(1300)

      const cards = (await ES(`window.__mogging.board.list()`)) as { id: string; lane: string; paneId?: number; workspaceId?: string }[]
      const card = cards.find((c) => c.id === cardId)
      const markerWrites = writes.filter((w) => w.data.includes(MARKER))
      const reuseWrites = writes.filter((w) => w.data.includes(REUSE_MARKER))
      const slowWrites = writes.filter((w) => w.data.includes(SLOW_MARKER))
      const toast = (await ES(`(() => {
        const t = [...document.querySelectorAll('.toast--danger')].find((e) => e.querySelector('.toast-title')?.textContent === 'Agent did not start')
        return t ? {
          title: t.querySelector('.toast-title')?.textContent,
          body: t.querySelector('.toast-body')?.textContent,
          action: t.querySelector('.toast-action')?.textContent
        } : null
      })()`)) as { title?: string; body?: string; action?: string } | null
      const failClosed = markerWrites.length === 0
      const paneReuseClosed = reuseStarted && idWasReused && reuseWrites.length === 0
      const slowReadyHandedOff = slowStarted && slowPane > 0 && slowWrites.length === 1
      const boundForDiagnosis = started && !!card?.paneId && !!card.workspaceId && card.lane === 'doing'
      const honestToast =
        toast?.title === 'Agent did not start' &&
        toast.body?.includes('task was not sent') === true &&
        toast.action === 'Open pane'

      await ES(`document.querySelector('.toast--danger .toast-action')?.click()`)
      await sleep(300)
      const actionOpenedGrid = Boolean(await ES(`!document.querySelector('#view-grid')?.hidden`))
      const pass = failClosed && paneReuseClosed && slowReadyHandedOff && boundForDiagnosis && honestToast && actionOpenedGrid
      result = {
        pass,
        failClosed,
        markerWrites,
        paneReuseClosed,
        reusePane,
        idWasReused,
        reuseWrites,
        slowReadyHandedOff,
        slowPane,
        slowWrites,
        boundForDiagnosis,
        honestToast,
        actionOpenedGrid,
        card,
        toast
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    } finally {
      ipcMain.off(TerminalChannels.write, onWrite)
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'boardfail-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(run, 1200))
  else setTimeout(run, 1200)
}
