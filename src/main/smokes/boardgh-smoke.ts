import { app, type BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setBoardGhWorld } from '../boardgh-audit-fixture'
import { githubBoardDebug } from '../github-board'
import { boardDebug } from '../board'
import { getSettingsStore } from '../app-settings'
import { linkForCard } from '../services'

// Env-gated Board↔GitHub gate (MOGGING_BOARDGH, ADR 0015) — ZERO network: the
// gh/git subprocess seam is a deterministic fixture world, so every assertion
// is about OUR behavior, never GitHub's availability.
//   (a) detect: origin remote -> "owner/repo", persisted on the board
//   (b) import: open issues -> linked BACKLOG cards; re-import creates ZERO
//       duplicates; a malformed gh answer is a labeled refusal, not a crash
//   (c) write-back is a WALL by default: push + close refuse NAMING the Board
//       settings grant, and NO gh mutation verb is ever executed while off
//   (d) the UI enable flow is a RISK CONFIRM: the checkbox alone does not
//       enable; Cancel keeps it off; confirming enables
//   (e) with write-back on: push creates the issue via gh, links it, and
//       narrates in the activity log; close closes the LINKED issue
//   (f) rules: prMergedToDone moves a pr-linked card to Done only when the
//       rule is ON; autoLinkPr links the branch's PR when a card enters Review
export function runBoardGhSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 150000) // safety net
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const waitTrue = async (probe: () => Promise<boolean> | boolean, tries = 30, gap = 200): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      if (await probe()) return true
      await sleep(gap)
    }
    return false
  }
  const git = (cwd: string, args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      await sleep(1800)

      // The fixture gh/git world — every command it ever sees is recorded.
      const ghCalls: string[][] = []
      let issueListBody = JSON.stringify([
        { number: 7, title: 'Fix crash on resize', body: 'stack trace here' },
        { number: 9, title: 'Add docs for the wizard', body: '' }
      ])
      setBoardGhWorld({
        linkService: 'fake',
        run: (cmd, args) => {
          ghCalls.push([cmd, ...args])
          if (cmd === 'git' && args.includes('get-url')) {
            return Promise.resolve({ ok: true, stdout: 'https://github.com/acme/web.git\n' })
          }
          if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
            return Promise.resolve({ ok: true, stdout: issueListBody })
          }
          if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
            return Promise.resolve({ ok: true, stdout: JSON.stringify([{ number: 41 }]) })
          }
          if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'create') {
            return Promise.resolve({ ok: true, stdout: 'https://github.com/acme/web/issues/55\n' })
          }
          if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'close') {
            return Promise.resolve({ ok: true, stdout: 'closed\n' })
          }
          return Promise.resolve({ ok: false, stdout: '', reason: `fixture: unexpected ${cmd} ${args.join(' ')}` })
        }
      })

      // A real repo folder anchors the board (projectKey), fixture answers gh.
      const repo = mkdtempSync(join(tmpdir(), 'mogging-bgh-'))
      git(repo, ['init'])
      git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
      git(repo, ['config', 'user.email', 'smoke@mogging.test'])
      git(repo, ['config', 'user.name', 'Mogging Smoke'])
      git(repo, ['config', 'commit.gpgsign', 'false'])
      writeFileSync(join(repo, 'a.txt'), 'a\n')
      git(repo, ['add', '-A'])
      git(repo, ['commit', '-m', 'init'])
      await ES(`window.__mogging.workspace.create({ name: 'GH', cwd: ${JSON.stringify(repo)} })`)
      await sleep(1500)
      const board = boardDebug().ensureForCwd(repo)
      const store = getSettingsStore()
      if (!store) throw new Error('no settings store')

      // (a) detect + persist.
      const detected = await githubBoardDebug.ghDetect(board.id)
      const boardAfterDetect = store.getBoard(board.id)
      const detectOk = detected.ok && detected.repoRef === 'acme/web' && boardAfterDetect?.repoRef === 'acme/web'

      // (b) import: 2 issues -> 2 linked backlog cards; idempotent on repeat.
      const imported = await githubBoardDebug.ghImport({ boardId: board.id })
      const cards = store.listCards(board.id)
      const issueCards = cards.filter((c) => c.title === 'Fix crash on resize' || c.title === 'Add docs for the wizard')
      const linksOk = issueCards.every((c) => linkForCard(c.id)?.ref.startsWith('acme/web#'))
      const again = await githubBoardDebug.ghImport({ boardId: board.id })
      const importOk =
        imported.ok &&
        (imported.ok ? imported.created : 0) === 2 &&
        issueCards.length === 2 &&
        issueCards.every((c) => c.lane === 'backlog') &&
        linksOk &&
        again.ok &&
        (again.ok ? again.created : 0) === 0
      // Malformed gh output is a labeled refusal, not a crash.
      issueListBody = 'this is not json'
      const malformed = await githubBoardDebug.ghImport({ boardId: board.id })
      const malformedOk = !malformed.ok && /not JSON/i.test(malformed.ok ? '' : malformed.reason)

      // (c) write-back OFF: refuse naming the grant; gh never ran a mutation.
      const target = issueCards[0]
      const freshCardId = (await ES(
        `window.__mogging.board.createCard('Push me to GitHub', 'body text')`
      )) as string
      await sleep(300)
      const pushRefused = await githubBoardDebug.ghPush(freshCardId)
      const closeRefused = await githubBoardDebug.ghClose(target.id)
      const mutationsWhileOff = ghCalls.filter((c) => c[0] === 'gh' && (c[2] === 'create' || c[2] === 'close')).length
      const wallOk =
        !pushRefused.ok &&
        /Board settings/.test(pushRefused.ok ? '' : pushRefused.reason) &&
        !closeRefused.ok &&
        mutationsWhileOff === 0

      // (d) the UI risk confirm: checkbox alone never enables; Cancel keeps off.
      await ES(`document.querySelector('.titlebar-right .icon-btn[aria-label="Board"]')?.click()`)
      await waitTrue(() => ES<boolean>(`!!document.querySelector('#content.view-board')`))
      await ES(`document.querySelector('.board-head-menu')?.click()`)
      await waitTrue(() => ES<boolean>(`!!document.querySelector('.ctx-menu .ctx-item')`))
      await ES(`[...document.querySelectorAll('.ctx-menu .ctx-item')].find((x) => /Board settings/.test(x.textContent || ''))?.click()`)
      await waitTrue(() => ES<boolean>(`!!document.querySelector('.board-settings')`))
      const clickWriteBack = (): Promise<unknown> =>
        ES(`(() => {
          const t = [...document.querySelectorAll('.board-settings-toggle')].find((x) => /Write-back/.test(x.textContent || ''))
          const input = t && t.querySelector('input')
          if (!input) return false
          input.click()
          return true
        })()`)
      // The settings sheet is ALSO a modal — every probe scopes to the TOPMOST
      // overlay so the confirm's Cancel is the one clicked, never the sheet's.
      const topOverlay = `[...document.querySelectorAll('.modal-overlay:not(.is-closing)')].pop()`
      await clickWriteBack()
      const confirmUp = await waitTrue(
        () => ES<boolean>(`/CREATE and CLOSE/i.test((${topOverlay})?.textContent || '')`),
        20
      )
      await ES(`[...(${topOverlay})?.querySelectorAll('button') ?? []].find((b) => /^Cancel$/.test((b.textContent || '').trim()))?.click()`)
      await sleep(400)
      const stillOff = store.getBoard(board.id)?.config.github.writeBack === false
      await clickWriteBack()
      await waitTrue(() => ES<boolean>(`!![...(${topOverlay})?.querySelectorAll('button') ?? []].find((b) => /Enable write-back/.test(b.textContent || ''))`), 20)
      await ES(`[...(${topOverlay})?.querySelectorAll('button') ?? []].find((b) => /Enable write-back/.test(b.textContent || ''))?.click()`)
      const onNow = await waitTrue(() => store.getBoard(board.id)?.config.github.writeBack === true, 25)
      // close the settings sheet (now the topmost overlay again)
      await ES(`[...(${topOverlay})?.querySelectorAll('button') ?? []].find((b) => /^Cancel$/.test((b.textContent || '').trim()))?.click()`)
      const confirmFlowOk = confirmUp && stillOff && onNow

      // (e) write-back ON: push creates + links + narrates; close closes.
      const pushed = await githubBoardDebug.ghPush(freshCardId)
      const pushedLink = linkForCard(freshCardId)
      const pushActivity = store
        .listBoardActivity(freshCardId)
        .some((a) => a.verb === 'github' && a.detail.includes('acme/web#55'))
      const closeNow = await githubBoardDebug.ghClose(freshCardId)
      const ghMutations = ghCalls.filter((c) => c[0] === 'gh' && (c[2] === 'create' || c[2] === 'close'))
      const writeBackOk =
        pushed.ok &&
        (pushed.ok ? pushed.ref : '') === 'acme/web#55' &&
        pushedLink?.ref === 'acme/web#55' &&
        pushedLink?.kind === 'issue' &&
        pushActivity &&
        closeNow.ok &&
        ghMutations.length === 2

      // (f) rules. prMergedToDone: OFF -> no move; ON -> Done + narrated.
      const prCardId = String(await ES(`window.__mogging.board.createCard('PR ruled card', '')`))
      await sleep(300)
      boardDebug().patchDirect(prCardId, { lane: 'doing' }, 'sync')
      const prLink = { id: 'lnk_fx', service: 'fake', cardId: prCardId, kind: 'pr' as const, ref: 'acme/web#77', cadence: 'manual' as const }
      const mergedStatus = { linkId: 'lnk_fx', health: 'fresh' as const, state: 'merged' as const, fetchedAt: Date.now() }
      const prCard = store.getCard(prCardId)
      if (!prCard) throw new Error('pr card vanished')
      githubBoardDebug.applyTransitionRules(prCard, prLink, mergedStatus)
      const notMoved = store.getCard(prCardId)?.lane === 'doing'
      const withRule = store.getBoard(board.id)
      if (withRule) {
        const patched = { ...withRule.config, rules: { ...withRule.config.rules, prMergedToDone: true, autoLinkPr: true } }
        store.updateBoardRow({ ...withRule, config: patched, updatedAt: Date.now() })
      }
      const prCardAgain = store.getCard(prCardId)
      if (prCardAgain) githubBoardDebug.applyTransitionRules(prCardAgain, prLink, mergedStatus)
      const movedToDone = store.getCard(prCardId)?.lane === 'done'
      const ruleNarrated = store.listBoardActivity(prCardId).some((a) => a.verb === 'rule' && /merged/.test(a.detail))
      // autoLinkPr: a branch-carrying card entering Review links its PR.
      const autoCardId = String(await ES(`window.__mogging.board.createCard('Auto link me', '')`))
      await sleep(300)
      boardDebug().patchDirect(autoCardId, { branch: 'mogging/abc123' }, 'sync')
      boardDebug().patchDirect(autoCardId, { lane: 'review' }, 'sync')
      const autoLinked = await waitTrue(() => linkForCard(autoCardId)?.ref === 'acme/web#41', 25)
      const rulesOk = notMoved && movedToDone && ruleNarrated && autoLinked

      const pass = detectOk && importOk && malformedOk && wallOk && confirmFlowOk && writeBackOk && rulesOk
      result = {
        pass,
        detectOk,
        importOk,
        importedCount: imported.ok ? imported.created : imported.reason,
        malformedOk,
        wallOk,
        pushRefusedMsg: pushRefused.ok ? '' : pushRefused.reason,
        mutationsWhileOff,
        confirmFlowOk,
        confirmUp,
        stillOff,
        onNow,
        writeBackOk,
        pushedRef: pushed.ok ? pushed.ref : pushed.reason,
        rulesOk,
        notMoved,
        movedToDone,
        ruleNarrated,
        autoLinked,
        ghCallCount: ghCalls.length
      }
    } catch (e) {
      result = { pass: false, error: e instanceof Error ? (e.stack ?? e.message) : String(e) }
    }
    setBoardGhWorld(null)
    try {
      writeFileSync(join(process.cwd(), 'out', 'boardgh-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 2500))
  else setTimeout(() => void run(), 2500)
}
