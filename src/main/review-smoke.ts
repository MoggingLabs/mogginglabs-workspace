import { app, type BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorktree } from '@backend/features/worktrees'
import { redactSecrets, REDACTED } from '@backend/features/review'

// Env-gated pre-ship review smoke (MOGGING_REVIEW, Phase-3/04). Proves the DoD end to
// end: worktree -> redacted diff -> text-only DOM -> guarded merge.
//   A. redaction unit asserts (every pattern class + a benign control line)
//   B. planted fake ghp_/sk-/PEM/password secrets NEVER survive the diff IPC
//   C. a hostile "<script>" diff line reaches the modal as TEXT (no element created)
//   D. merge: dirty repo refused -> clean repo merges -> conflicting branch reports
//      'conflict' and leaves the merge paused (MERGE_HEAD present) for a terminal.
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'mogging-review-'))
  git(repo, ['init'])
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repo, ['config', 'user.email', 'smoke@mogging.test'])
  git(repo, ['config', 'user.name', 'Mogging Smoke'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(repo, 'README.md'), 'line one\nline two\nline three\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'init'])
  return repo
}

const FAKE_GHP = 'ghp_' + 'A1b2C3d4E5f6G7h8J9k0A1b2C3d4E5f6' // planted, fake
const FAKE_SK = 'sk-' + 'testFAKEtestFAKEtestFAKE1234'

export function runReviewSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 120000) // safety net
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      // ── A. Redaction unit asserts (pure module) ──────────────────────────────
      const cases: Array<[string, boolean]> = [
        [`token = ${FAKE_GHP}`, true],
        [`const k = "${FAKE_SK}"`, true],
        ['-----BEGIN RSA PRIVATE KEY-----\nMIIfake\n-----END RSA PRIVATE KEY-----', true],
        ['AKIAIOSFODNN7EXAMPLE', true],
        ['password: hunter2secret', true],
        ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9P', true],
        ['const total = items.length + 3 // benign', false]
      ]
      const unitOk = cases.every(([text, shouldHit]) => {
        const r = redactSecrets(text)
        return shouldHit ? r.redactions > 0 && !r.text.includes(text.slice(-8)) : r.redactions === 0 && r.text === text
      })

      // ── Stage: repo + worktree with a normal edit AND planted secrets ────────
      const repo = makeRepo()
      const wt = await createWorktree(repo)
      if (!wt.ok || !wt.path || !wt.branch) throw new Error('worktree create failed')
      writeFileSync(join(wt.path, 'README.md'), 'line one CHANGED\nline two\nline three\n')
      writeFileSync(
        join(wt.path, 'config.ts'),
        `export const token = "${FAKE_GHP}"\nexport const api = "${FAKE_SK}"\n` +
          `export const html = "<script>alert(1)</script><img src=x onerror=alert(2)>"\n`
      )
      git(wt.path, ['add', '-A'])
      git(wt.path, ['commit', '-m', 'agent work'])

      await sleep(1500) // boot settles

      // ── B. Diff over real IPC: secrets scrubbed, structure sane ──────────────
      const diff = (await ES(
        `window.bridge.invoke('review:diff', ${JSON.stringify({ repo, worktree: wt.path })})`
      )) as {
        base: string
        branch: string
        files: { path: string; additions: number; hunks: string[] }[]
        redactions: number
        error?: string
      }
      const allText = JSON.stringify(diff)
      const diffOk =
        !diff.error &&
        diff.base === 'main' &&
        diff.branch === wt.branch &&
        diff.files.length === 2 &&
        diff.files.some((f) => f.path === 'README.md' && f.hunks.length > 0)
      const redactedOk =
        diff.redactions >= 2 &&
        !allText.includes(FAKE_GHP) &&
        !allText.includes(FAKE_SK) &&
        allText.includes(REDACTED.replace(/[«»]/g, (c) => c)) // literal marker present

      // ── C. DOM safety: the hostile line is TEXT, never markup ────────────────
      await ES(`window.__mogging.review.open(${JSON.stringify(repo)}, ${JSON.stringify(wt.path)})`)
      await sleep(900)
      const dom = (await ES(
        `(() => {
          const modal = document.querySelector('.review-modal')
          if (!modal) return { present: false }
          return {
            present: true,
            scripts: modal.querySelectorAll('script').length,
            imgs: modal.querySelectorAll('img').length,
            hunkHasScriptText: (modal.textContent || '').includes('<script>alert(1)</script>'),
            fileCount: modal.querySelectorAll('.review-file').length
          }
        })()`
      )) as { present: boolean; scripts: number; imgs: number; hunkHasScriptText: boolean; fileCount: number }
      const domOk = dom.present && dom.scripts === 0 && dom.imgs === 0 && dom.hunkHasScriptText && dom.fileCount === 2
      // Bug #2: `.review-modal` IS the overlay (modal.el) — `.parentElement` was <body>.
      await ES(`(() => { const m = document.querySelector('.review-modal'); m && m.remove(); return 1 })()`)

      // ── D. Merge: dirty refused -> clean merges -> conflict pauses ───────────
      // 4/03: the reviewer gate now fronts the merge verb — this smoke exercises the
      // HUMAN path (typed override); the reviewer path is MOGGING_GATE's job.
      const mergeVia = (branch: string): Promise<{ ok: boolean; state: string }> =>
        ES(
          `window.bridge.invoke('review:merge', ${JSON.stringify({ repo, branch, override: 'override' })})`
        ) as Promise<{ ok: boolean; state: string }>

      writeFileSync(join(repo, 'README.md'), 'line one\nline two DIRTY\nline three\n')
      const dirtyRes = await mergeVia(wt.branch)
      git(repo, ['checkout', '--', 'README.md']) // clean again
      const cleanRes = await mergeVia(wt.branch)
      const mergedFileArrived = existsSync(join(repo, 'config.ts'))
      const log = git(repo, ['log', '--oneline', '-3'])

      // Conflict case: a second worktree edits the SAME line main just changed.
      const wt2 = await createWorktree(repo)
      if (!wt2.ok || !wt2.path || !wt2.branch) throw new Error('worktree2 create failed')
      writeFileSync(join(wt2.path, 'README.md'), 'line one WT2\nline two\nline three\n')
      git(wt2.path, ['add', '-A'])
      git(wt2.path, ['commit', '-m', 'conflicting work'])
      writeFileSync(join(repo, 'README.md'), 'line one MAIN\nline two\nline three\n')
      git(repo, ['add', '-A'])
      git(repo, ['commit', '-m', 'main moved'])
      const conflictRes = await mergeVia(wt2.branch)
      const mergePaused = existsSync(join(repo, '.git', 'MERGE_HEAD'))

      const mergeOk =
        dirtyRes.state === 'dirty' &&
        cleanRes.ok === true &&
        cleanRes.state === 'merged' &&
        mergedFileArrived &&
        log.includes('agent work') &&
        conflictRes.ok === false &&
        conflictRes.state === 'conflict' &&
        mergePaused

      const pass = unitOk && diffOk && redactedOk && domOk && mergeOk
      result = { pass, unitOk, diffOk, redactedOk, domOk, dom, mergeOk, dirtyRes, cleanRes, conflictRes, mergePaused, redactions: diff.redactions }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'review-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(run, 2500))
  else setTimeout(run, 2500)
}
