import { app, type BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Env-gated per-pane git smoke (MOGGING_GIT). Proves the Phase-2/03 Definition of Done end to end
// (these GATE the pass):
//  1. Build a throwaway git repo (branch "mogging-test", one commit).
//  2. Open a workspace pointed at it -> the pane's git chip resolves to that branch, CLEAN.
//  3. Edit a tracked file -> the chip's dirty flag flips true (poll-driven refresh).
//  4. A cwd that is NOT a repo yields null (the pane shows nothing, no error).
//  5. Read-only proof: HEAD is byte-identical before and after all probing.
// Plus a BEST-EFFORT (non-gating) OSC-7 refinement check: emit an OSC 7 cwd (a 2nd repo) onto the
// pane's PTY -> the chip should RETARGET to that repo's branch, exercising the full cwd relay
// (PTY -> OscParser -> [daemon protocol] -> terminal:cwd -> pane-cwd port -> git chip). It's not
// gated because OSC 7 is a daemon-side capability: a SURVIVING pre-2/03 daemon (ADR 0006) won't
// emit cwd until it restarts, and git correctly falls back to the workspace-cwd seed. `retarget`
// is recorded so a current-daemon / in-proc run still shows it working.
// The repo setup + edit happen here in main (real fs/git); the assertions read the renderer's
// git port via the dev handle (window.__mogging.git).

const CLEAN_TIMEOUT = 20000
const DIRTY_TIMEOUT = 20000
const OSC_TIMEOUT = 10000
const STEP_MS = 500

interface SmokeGit {
  root: string
  branch: string
  detached: boolean
  ahead: number
  behind: number
  dirty: boolean
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

/** Create a deterministic throwaway repo on a named branch with one committed file. */
function makeRepo(branch: string): string {
  const repo = mkdtempSync(join(tmpdir(), 'mogging-git-'))
  git(repo, ['init'])
  git(repo, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]) // name the initial branch on any git
  git(repo, ['config', 'user.email', 'smoke@mogging.test'])
  git(repo, ['config', 'user.name', 'Mogging Smoke'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(repo, 'README.md'), 'hello\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'init'])
  return repo
}

export function runGitSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 90000) // safety net

  const exec = <T = unknown>(js: string): Promise<T> => win.webContents.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  const readStatus = (paneId: number): Promise<SmokeGit | null> =>
    exec<SmokeGit | null>(`window.__mogging.git.status(${paneId})`)

  const pollStatus = async (
    paneId: number,
    pred: (s: SmokeGit | null) => boolean,
    timeoutMs: number
  ): Promise<SmokeGit | null> => {
    const start = Date.now()
    let last: SmokeGit | null = null
    while (Date.now() - start < timeoutMs) {
      last = await readStatus(paneId)
      if (pred(last)) return last
      await sleep(STEP_MS)
    }
    return last
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      const repo = makeRepo('mogging-test')
      const repo2 = makeRepo('osc-branch') // OSC 7 will retarget the pane's chip to this repo
      const nonRepo = mkdtempSync(join(tmpdir(), 'mogging-nogit-'))
      const headBefore = git(repo, ['rev-parse', 'HEAD'])

      // Open a workspace pointed at the repo; derive its first pane id from the ordinal.
      const opened = await exec<{ ordinal: number; cwd: string }>(
        `(() => { const ws = window.__mogging.workspace.openForCwd(${JSON.stringify(repo)}); ` +
          `return { ordinal: ws.ordinal, cwd: ws.cwd }; })()`
      )
      const paneId = opened.ordinal * 100 + 1

      // 1) Repo resolves to the right branch, initially clean.
      const clean = await pollStatus(paneId, (s) => !!s && !s.dirty && s.branch === 'mogging-test', CLEAN_TIMEOUT)

      // 2) Edit a tracked file -> dirty flips true (caught by the backend poll).
      appendFileSync(join(repo, 'README.md'), 'a local uncommitted edit\n')
      const dirty = await pollStatus(paneId, (s) => !!s && s.dirty, DIRTY_TIMEOUT)

      // 2b) The user-facing DoD: the pane's .pane-git CHIP (not just the port) renders the branch
      //     and the dirty dot. Read the actual DOM in the pane's slot.
      const chip = await exec<{ text: string; hasGit: boolean; dirty: boolean } | null>(
        `(()=>{const el=document.querySelector('.layout-slot[data-pane-id="${paneId}"] .pane-git');` +
          `return el?{text:(el.textContent||''),hasGit:el.classList.contains('has-git'),` +
          `dirty:el.classList.contains('dirty')}:null;})()`
      )

      // 3) A non-repo cwd -> null (nothing shown, no error).
      const none = await exec<SmokeGit | null>(`window.__mogging.git.query(${JSON.stringify(nonRepo)})`)

      // 4) Read-only: nothing we did mutated the repo.
      const headAfter = git(repo, ['rev-parse', 'HEAD'])
      const branchAfter = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])

      // 5) BEST-EFFORT OSC 7 refinement (not gated — see header): emit repo2's cwd onto the pane's
      //    PTY via a node one-liner; the chip should retarget to repo2's branch.
      const repo2uri = 'file://host/' + repo2.replace(/\\/g, '/') // OSC 7 wants forward slashes
      const oscEmit =
        `node -e "process.stdout.write(String.fromCharCode(27)+']7;${repo2uri}'+String.fromCharCode(7))"\r`
      await exec(`window.bridge.send("terminal:write",{id:${paneId},data:${JSON.stringify(oscEmit)}})`)
      const retarget = await pollStatus(paneId, (s) => !!s && s.branch === 'osc-branch', OSC_TIMEOUT)
      const oscRetargeted = !!retarget && retarget.branch === 'osc-branch'

      const pass =
        !!clean &&
        clean.branch === 'mogging-test' &&
        clean.detached === false &&
        clean.dirty === false &&
        !!dirty &&
        dirty.dirty === true &&
        dirty.branch === 'mogging-test' &&
        !!chip &&
        chip.hasGit === true &&
        chip.text.includes('mogging-test') &&
        chip.dirty === true &&
        none === null &&
        headBefore === headAfter &&
        branchAfter === 'mogging-test'

      result = { pass, paneId, clean, dirty, chip, none, headBefore, headAfter, branchAfter, oscRetargeted, retarget }
      for (const d of [repo, repo2, nonRepo]) {
        try {
          rmSync(d, { recursive: true, force: true })
        } catch {
          /* best effort */
        }
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'git-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => setTimeout(run, 3000))
  else setTimeout(run, 3000)
}
