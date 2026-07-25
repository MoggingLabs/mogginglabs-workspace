import { app, type BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setWorktreeAuditFault, worktreeAuditFault } from '../worktree-audit-faults'

// Env-gated worktree-isolation smoke (MOGGING_WORKTREE, Phase-3/03):
//  1. throwaway repo -> open a workspace with TWO isolated agent slots (dev handle;
//     a `custom:` provider whose command writes the shell's LIVE branch into a file
//     at the shell's own cwd — no TUI launches, and the file is the testimony).
//  2. assert: two worktrees under <repo>/.mogging/worktrees, `git worktree list`
//     agrees, each pane's branch chip shows its own mogging/<slug> branch — AND each
//     pane's SHELL really runs inside its worktree. The chip reads the published
//     pane-cwd port, so it stays green even when the shell spawned somewhere else
//     entirely; only the shell can say where it is. (Regression 2026-07-09: the
//     GridLayout constructor applies a 1-pane grid, which spawned pane 1's PTY before
//     the controller published its cwd seed — slot 1's shell opened in $HOME while
//     its chip claimed mogging/<slug>. `custom:` providers launch verbatim, no
//     `cd` prefix, so they surface the true spawn cwd.)
//  3. removal is dirty-SAFE: a dirty worktree is refused, force removes it, a clean
//     one removes first try. Repo HEAD is byte-identical before/after everything.
//  4. …and the refusal that arrives LATE still has a working door. The controller
//     closes the pane BEFORE removing, and the backend re-checks dirtiness on every
//     non-force removal, so a worktree that passed the pane's own pre-check can come
//     back 'dirty' once the pane (and its ⋯ menu) no longer exists. The second toast's
//     "Remove anyway" is then the only force step left, and it must not depend on the
//     dead element's bubbling event to reach anyone.
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'mogging-wt-'))
  git(repo, ['init'])
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repo, ['config', 'user.email', 'smoke@mogging.test'])
  git(repo, ['config', 'user.name', 'Mogging Smoke'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(repo, 'README.md'), 'hello\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'init'])
  return repo
}

export function runWorktreeSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 150000) // safety net (gate budget is 240s — see qa-smokes.sh)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      const repo = makeRepo()
      const headBefore = git(repo, ['rev-parse', 'HEAD'])
      await sleep(1500) // launcher-first boot settles

      // Open 2 isolated agent slots (1x2 grid) via the wizard's isolation path. The
      // custom command is each pane's testimony: it runs at the shell's real cwd.
      const provider = 'custom:git branch --show-current > branch.txt'
      const opened = (await ES(
        `window.__mogging.templates.openIsolated(${JSON.stringify(repo)}, [{provider:${JSON.stringify(provider)},count:2}])`
      )) as { paneCount: number; assignments: string[]; paneCwds: (string | null)[] }
      const paneCwds = (opened?.paneCwds ?? []).filter((p): p is string => !!p)
      const openedOk = opened?.paneCount === 2 && paneCwds.length === 2

      // Filesystem + git agree: two managed worktrees on mogging/ branches.
      const wtRoot = join(repo, '.mogging', 'worktrees')
      const dirs = existsSync(wtRoot) ? readdirSync(wtRoot) : []
      const porcelain = git(repo, ['worktree', 'list', '--porcelain'])
      // The CLAIM is "git lists a worktree at each pane's cwd"; the PROBE must
      // compare CANONICAL paths. windows-latest hands out TEMP in 8.3 short
      // form (C:\Users\RUNNER~1\...) so the pane cwd and git's long-form
      // porcelain paths never match textually (found by the 6/03 sweep, run
      // 28669886364). realpath expands the alias; slashes + case normalize for
      // NTFS's case-insensitivity (win32 only — POSIX compares exact).
      const norm = (s: string): string => {
        const t = s.replaceAll('\\', '/')
        return process.platform === 'win32' ? t.toLowerCase() : t
      }
      const canon = (p: string): string => {
        try {
          return norm(realpathSync.native(p))
        } catch {
          return norm(p)
        }
      }
      const porcelainNorm = norm(porcelain)
      // Either form may be the one git recorded (macOS: /var/... symlinks to
      // /private/var/... and realpath crosses that boundary) — accept both.
      const gitAgrees =
        dirs.length === 2 &&
        paneCwds.every((p) => porcelainNorm.includes(canon(p)) || porcelainNorm.includes(norm(p)))
      const branches = git(repo, ['branch', '--list', 'mogging/*'])
      const branchesOk = branches.split('\n').filter((b) => b.trim()).length === 2

      // Each pane's chip resolves ITS OWN mogging/<slug> branch (git port, polled).
      const base = ((await ES('window.__mogging.workspace.active()')) as { ordinal: number }).ordinal * 100
      const chipBranch = async (id: number): Promise<string> =>
        String(
          await ES(
            `(()=>{const el=document.querySelector('.layout-slot[data-pane-id="${id}"] .pane-branch');return el?el.textContent:'';})()`
          )
        )
      let chip1 = ''
      let chip2 = ''
      for (let i = 0; i < 30; i++) {
        chip1 = await chipBranch(base + 1)
        chip2 = await chipBranch(base + 2)
        if (chip1.includes('mogging/') && chip2.includes('mogging/') && chip1 !== chip2) break
        await sleep(500)
      }
      const chipsOk = chip1.includes('mogging/') && chip2.includes('mogging/') && chip1 !== chip2

      // Each pane's shell wrote its live branch AT ITS OWN CWD (lineup launch). Both
      // files must land inside the worktrees and name two distinct mogging/ branches.
      // (PowerShell's `>` writes UTF-16LE — strip NULs before comparing.)
      let shellFiles: Record<string, string> = {}
      let shellsOk = false
      for (let i = 0; i < 60 && !shellsOk; i++) {
        await sleep(500)
        shellFiles = {}
        for (const p of paneCwds) {
          const f = join(p, 'branch.txt')
          if (existsSync(f)) shellFiles[p] = readFileSync(f, 'utf8').replace(/[\u0000\uFEFF]/g, '').trim()
        }
        const vals = Object.values(shellFiles)
        shellsOk = vals.length === 2 && vals.every((b) => b.startsWith('mogging/')) && new Set(vals).size === 2
      }
      // The testimony must not contaminate the dirty-safety phase below — an untracked
      // file reads as dirty, and worktree #2 is asserted clean-removable.
      for (const p of paneCwds) rmSync(join(p, 'branch.txt'), { force: true })

      // Removal safety — drive the real IPC from the renderer, like the pane menu does.
      const removeVia = (path: string, force: boolean): Promise<{ ok: boolean; reason?: string }> =>
        ES(
          `window.bridge.invoke('worktrees:remove', ${JSON.stringify({ repo, path, force })})`
        ) as Promise<{ ok: boolean; reason?: string }>
      const clickMenuItem = (paneId: number, label: string): Promise<boolean> =>
        ES<boolean>(`(() => {
          const slot = document.querySelector('.layout-slot[data-pane-id="${paneId}"]')
          const opener = slot?.querySelector('.pane-act-menu')
          if (!(opener instanceof HTMLButtonElement)) return false
          opener.click()
          const item = Array.from(document.querySelectorAll('#pane-menu-${paneId} .menu-item'))
            .find((el) => (el.textContent ?? '').trim() === ${JSON.stringify(label)})
          if (!(item instanceof HTMLButtonElement)) return false
          item.click()
          return true
        })()`)
      const clickToastAction = (label: string): Promise<boolean> =>
        ES<boolean>(`(() => {
          const button = Array.from(document.querySelectorAll('.toast-action'))
            .find((el) => (el.textContent ?? '').trim() === ${JSON.stringify(label)})
          if (!(button instanceof HTMLButtonElement)) return false
          button.click()
          return true
        })()`)
      const confirmPaneClose = async (): Promise<boolean> => {
        for (let i = 0; i < 50; i++) {
          const clicked = await ES<boolean>(`(() => {
            const button = Array.from(document.querySelectorAll('.modal-overlay:not(.is-closing) .confirm-actions button'))
              .find((el) => (el.textContent ?? '').trim() === 'Close pane')
            if (!(button instanceof HTMLButtonElement)) return false
            button.click()
            return true
          })()`)
          if (clicked) return true
          await sleep(100)
        }
        return false
      }
      const waitGone = async (path: string): Promise<boolean> => {
        for (let i = 0; i < 120; i++) {
          if (!existsSync(path)) return true
          await sleep(100)
        }
        return false
      }
      const waitRemovalComplete = async (paneId: number): Promise<boolean> => {
        for (let i = 0; i < 120; i++) {
          const complete = await ES<boolean>(`(() => {
            const events = window.__mogging.workspace.worktreeRemovalAudit()
              .filter((event) => event.paneId === ${paneId} && event.stage === 'remove-result')
            return events.at(-1)?.ok === true
          })()`)
          if (complete) return true
          await sleep(100)
        }
        return false
      }
      writeFileSync(join(paneCwds[0], 'dirty.txt'), 'uncommitted\n')
      // The dirty REFUSAL is a git-level check (before any delete), so it holds
      // whether or not the pane is open.
      const dirtyRefused = await removeVia(paneCwds[0], false)
      const dirtyMenuClicked = await clickMenuItem(base + 1, 'Remove worktree…')
      await sleep(700)
      const dirtyUiRefused = await ES<boolean>(`(() => {
        const pane = document.querySelector('.layout-slot[data-pane-id="${base + 1}"]')
        const toast = Array.from(document.querySelectorAll('.toast'))
          .find((el) => el.querySelector('.toast-title')?.textContent === 'Worktree has uncommitted changes')
        return !!pane && !!toast && !!Array.from(toast.querySelectorAll('.toast-action'))
          .find((el) => (el.textContent ?? '').trim() === 'Remove anyway')
      })()`)
      const noRemovalBeforeForce =
        existsSync(paneCwds[0]) &&
        (await ES<unknown[]>(`window.__mogging.workspace.worktreeRemovalAudit()`)).length === 0
      const forceClicked = await clickToastAction('Remove anyway')
      const dirtyCloseConfirmed = await confirmPaneClose()
      const forcedGone = await waitGone(paneCwds[0])
      const dirtyRemovalComplete = await waitRemovalComplete(base + 1)
      // Windows refuses to delete a directory that is a live process's CWD — each
      // pane's own shell keeps ITS worktree open, so ANY delete (clean or forced)
      // hits "Permission denied" on windows-latest (never on POSIX, which unlinks
      // a busy dir). The real "remove worktree" UX closes the pane first; close
      // BOTH, then retry each delete while the OS releases the handles.
      setWorktreeAuditFault({ lockPath: paneCwds[1], failures: 2 })
      const cleanMenuClicked = await clickMenuItem(base + 2, 'Remove worktree…')
      const cleanCloseConfirmed = await confirmPaneClose()
      const cleanGone = await waitGone(paneCwds[1])
      const cleanRemovalComplete = await waitRemovalComplete(base + 2)
      const lockAttempts = worktreeAuditFault()?.attempts ?? 0
      setWorktreeAuditFault(null)

      type OrderEvent = {
        paneId: number
        stage: 'request' | 'pane-closed' | 'remove-attempt' | 'remove-result'
        attempt?: number
        paneStillMounted: boolean
        ok?: boolean
        reason?: string
      }
      const orderEvents = await ES<OrderEvent[]>(`window.__mogging.workspace.worktreeRemovalAudit()`)
      const orderedFor = (paneId: number): boolean => {
        const events = orderEvents.filter((event) => event.paneId === paneId)
        const requested = events.findIndex((event) => event.stage === 'request')
        const closed = events.findIndex((event) => event.stage === 'pane-closed')
        const firstRemove = events.findIndex((event) => event.stage === 'remove-attempt')
        const attempts = events.filter((event) => event.stage === 'remove-attempt')
        const results = events.filter((event) => event.stage === 'remove-result')
        return requested >= 0 && closed > requested && firstRemove > closed &&
          events[requested]?.paneStillMounted === true && events[closed]?.paneStillMounted === false &&
          attempts.length > 0 && attempts.every((event) => event.paneStillMounted === false) &&
          results.at(-1)?.ok === true
      }
      const dirtyOrderOk = orderedFor(base + 1)
      const cleanOrderOk = orderedFor(base + 2)
      const cleanResults = orderEvents.filter(
        (event) => event.paneId === base + 2 && event.stage === 'remove-result'
      )
      const lockRetryOk =
        lockAttempts >= 3 &&
        cleanResults.length >= 3 &&
        cleanResults[0]?.reason === 'error' &&
        cleanResults[1]?.reason === 'error' &&
        cleanResults.at(-1)?.ok === true
      const activeAfter = await ES<{ paneCwds?: (string | null)[] }>(`window.__mogging.workspace.active()`)
      const liveAfter = await ES<number[]>(`window.__mogging.layout.paneIds()`)
      const replacementSlot = liveAfter[0] - base - 1
      const replacementOk =
        liveAfter.length === 1 &&
        !liveAfter.includes(base + 2) &&
        activeAfter.paneCwds?.[replacementSlot] === repo
      const cleanRemoved = { ok: cleanGone }
      const forcedRemoved = { ok: forcedGone }
      const removalOk =
        dirtyRefused.ok === false &&
        dirtyRefused.reason === 'dirty' &&
        dirtyMenuClicked && dirtyUiRefused && noRemovalBeforeForce && forceClicked && dirtyCloseConfirmed &&
        dirtyRemovalComplete && cleanMenuClicked && cleanCloseConfirmed && cleanRemovalComplete &&
        cleanRemoved.ok === true && forcedRemoved.ok === true &&
        dirtyOrderOk && cleanOrderOk && lockRetryOk && replacementOk

      // ── The 'dirty' refusal that arrives AFTER the pane is already gone ──────────
      // The pre-check half above is the EASY half: the pane is still mounted, so its
      // "Remove anyway" retry has a listener to reach. This is the other half. The
      // controller closes the pane FIRST and the backend re-checks dirtiness on every
      // NON-force removal, so a worktree the pane's own pre-check read CLEAN can still
      // come back 'dirty' with the pane — and the ⋯ entry that was the only other door —
      // already gone. That second toast's "Remove anyway" used to dispatch a BUBBLING
      // event from a DETACHED element; the controller's listener is on the workspace
      // container, so it reached nobody, the promise never settled, and the worktree
      // could not be force-removed by ANY route. A fresh workspace with one isolated
      // slot, because the two above are spent — this runs after their assertions read.
      const postProvider = 'custom:git status --short' // read-only: the worktree stays CLEAN
      const postOpened = (await ES(
        `window.__mogging.templates.openIsolated(${JSON.stringify(repo)}, [{provider:${JSON.stringify(postProvider)},count:1}])`
      )) as { paneCwds: (string | null)[] }
      const postCwd = (postOpened?.paneCwds ?? []).find((p): p is string => !!p) ?? ''
      // Canonical spelling captured while the directory still EXISTS — realpath cannot
      // resolve an 8.3 alias after the delete, and a post-hoc canon would make the
      // "git no longer lists it" check pass by simply never matching (see canon above).
      const postCanon = postCwd ? canon(postCwd) : ''
      const postPorcelainBefore = git(repo, ['worktree', 'list', '--porcelain'])
      const postRegisteredBefore =
        !!postCwd &&
        (norm(postPorcelainBefore).includes(postCanon) || norm(postPorcelainBefore).includes(norm(postCwd)))
      // The new workspace's pane id is READ from the layout, never re-derived from the
      // ordinal formula. Its meta's own paneCwds is what proves the read landed on the
      // NEW workspace: the old one is also down to a single (replacement) pane.
      let postPaneId = 0
      for (let i = 0; i < 100 && !postPaneId; i++) {
        const meta = await ES<{ paneCwds?: (string | null)[] } | null>(`window.__mogging.workspace.active()`)
        const ids = await ES<number[]>(`window.__mogging.layout.paneIds()`)
        if (postCwd && meta?.paneCwds?.[0] === postCwd && ids.length === 1) postPaneId = ids[0]
        else await sleep(100)
      }
      // Clear the board: an earlier phase's toast must not answer for this one, and a FULL
      // stack (4) would queue this pane's refusal instead of showing it.
      await ES(`Array.from(document.querySelectorAll('.toast .toast-dismiss')).forEach((el) => el.click()); 0`)
      // The ⋯ entry exists only once the pane-cwd port has published this pane's worktree
      // (buildMenu reads the projection), so keep opening until the entry is really there.
      // A failed probe leaves the menu OPEN and its stale entries in the DOM — close it
      // first, or the retry clicks yesterday's menu instead of a freshly built one.
      const openMenuItemWhenReady = async (paneId: number, label: string): Promise<boolean> => {
        for (let i = 0; i < 80; i++) {
          const clicked = await ES<boolean>(`(() => {
            const slot = document.querySelector('.layout-slot[data-pane-id="${paneId}"]')
            const opener = slot ? slot.querySelector('.pane-act-menu') : null
            if (!(opener instanceof HTMLButtonElement)) return false
            const menu = document.getElementById('pane-menu-${paneId}')
            if (menu && !menu.hidden) opener.click()
            opener.click()
            const item = Array.from(document.querySelectorAll('#pane-menu-${paneId} .menu-item'))
              .find((el) => (el.textContent ?? '').trim() === ${JSON.stringify(label)})
            if (!(item instanceof HTMLButtonElement)) return false
            item.click()
            return true
          })()`)
          if (clicked) return true
          await sleep(100)
        }
        return false
      }
      const postAudit = (): Promise<OrderEvent[]> =>
        ES<OrderEvent[]>(
          `window.__mogging.workspace.worktreeRemovalAudit().filter((event) => event.paneId === ${postPaneId})`
        )
      const postMenuClicked = postPaneId > 0 && (await openMenuItemWhenReady(postPaneId, 'Remove worktree…'))
      // 'request' is journaled the instant the controller RECEIVES the dispatch, which can
      // only happen after the pane's own pre-check read this tree clean from a MOUNTED
      // element — no toast was raised, so this is the clean-worktree path.
      let postRequested = false
      for (let i = 0; i < 100 && !postRequested; i++) {
        const events = await postAudit()
        postRequested = events[0]?.stage === 'request' && events[0]?.paneStillMounted === true
        if (!postRequested) await sleep(100)
      }
      // Dirty the tree while the close is still pending on its confirm. This is a FENCE,
      // not a race: the snapshot below is taken AFTER the write, and 'request' still being
      // the only entry means no removal has run yet — so the backend's re-check, which
      // cannot happen before the first 'remove-attempt', is guaranteed to see this file.
      // If the sequence ever slips, this field goes red instead of the case quietly
      // passing as a second copy of the pre-check half.
      if (postCwd) writeFileSync(join(postCwd, 'dirty.txt'), 'uncommitted after the pre-check\n')
      const postFenceEvents = await postAudit()
      const postFencedBeforeClose = postFenceEvents.length === 1 && postFenceEvents[0].stage === 'request'
      const postCloseConfirmed = await confirmPaneClose()
      // The refusal the pre-check cannot produce: reason 'dirty', pane already unmounted.
      let postDirtyAfterClose = false
      for (let i = 0; i < 150 && !postDirtyAfterClose; i++) {
        const last = (await postAudit()).filter((event) => event.stage === 'remove-result').at(-1)
        postDirtyAfterClose = last?.ok === false && last?.reason === 'dirty' && last?.paneStillMounted === false
        if (!postDirtyAfterClose) await sleep(100)
      }
      const postPresentAfterRefusal = !!postCwd && existsSync(postCwd)
      const postPaneGone = await ES<boolean>(`window.__mogging.layout.paneIds().indexOf(${postPaneId}) < 0`)
      // The last door: pane gone, menu gone, one toast left holding the only force step.
      let postSecondToast = false
      for (let i = 0; i < 60 && !postSecondToast; i++) {
        postSecondToast = await ES<boolean>(`(() => {
          const toast = Array.from(document.querySelectorAll('.toast'))
            .find((el) => el.querySelector('.toast-title')?.textContent === 'Worktree has uncommitted changes')
          if (!toast) return false
          return !!Array.from(toast.querySelectorAll('.toast-action'))
            .find((el) => (el.textContent ?? '').trim() === 'Remove anyway')
        })()`)
        if (!postSecondToast) await sleep(100)
      }
      // node-pty exits asynchronously and Windows will not delete a dead process's former
      // cwd until its handle is gone. The controller's retry loop covers that for its own
      // removals; this force goes straight down the backend door and gets ONE shot, so let
      // the just-closed pane's shell drain first. The toast lives 10s — this spends 2.
      await sleep(2000)
      const postForceClicked = await clickToastAction('Remove anyway')
      // The promise SETTLED — pre-fix nothing ever came back, so this toast, not merely the
      // vanished directory, is the difference between the two builds. Watched BEFORE the
      // filesystem: it is raised on an ok result (the directory is already gone by then)
      // and it only lives 6s, so waiting on the disk first could outlast the testimony.
      let postSuccessToast = false
      for (let i = 0; i < 120 && !postSuccessToast; i++) {
        postSuccessToast = await ES<boolean>(
          `Array.from(document.querySelectorAll('.toast .toast-title')).some((el) => (el.textContent ?? '').trim() === 'Worktree removed')`
        )
        if (!postSuccessToast) await sleep(100)
      }
      const postGone = await waitGone(postCwd)
      const postEvents = await postAudit()
      const postStages = postEvents.map((event) => event.stage).join(',')
      // The FIXED path does not re-enter the controller: with no pane left to sequence
      // there is nothing to close, so the journal ENDS at the refusal and the force is a
      // direct backend call. A second 'remove-attempt' here would mean the retry went back
      // through the pane's event — the very thing a detached element cannot do.
      const postAuditOk =
        postStages === 'request,pane-closed,remove-attempt,remove-result' &&
        postEvents[0]?.paneStillMounted === true &&
        postEvents.slice(1).every((event) => event.paneStillMounted === false)
      // A NON-force removal can never delete a dirty worktree, and this one was refused for
      // exactly that. So a tree that is now gone was removed by the FORCE call and nothing
      // else — "removed" and "was never dirty" are not confusable here. git agrees.
      const postPorcelainAfter = git(repo, ['worktree', 'list', '--porcelain'])
      const postUnregistered =
        !norm(postPorcelainAfter).includes(postCanon) && !norm(postPorcelainAfter).includes(norm(postCwd))
      const postCloseOk =
        !!postCwd && postPaneId > 0 && postRegisteredBefore && postMenuClicked && postRequested &&
        postFencedBeforeClose && postCloseConfirmed && postDirtyAfterClose && postPresentAfterRefusal &&
        postPaneGone && postSecondToast && postForceClicked && postGone && postSuccessToast &&
        postAuditOk && postUnregistered

      // Read-only guarantee: the repo's HEAD/branch never moved.
      const headAfter = git(repo, ['rev-parse', 'HEAD'])
      const branchAfter = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
      const repoIntact = headBefore === headAfter && branchAfter === 'main'

      const pass =
        openedOk && gitAgrees && branchesOk && chipsOk && shellsOk && removalOk && postCloseOk && repoIntact
      result = {
        pass,
        openedOk,
        gitAgrees,
        branchesOk,
        chipsOk,
        chip1,
        chip2,
        shellsOk,
        shellFiles,
        removalOk,
        dirtyRefused,
        dirtyMenuClicked,
        dirtyUiRefused,
        noRemovalBeforeForce,
        forceClicked,
        dirtyCloseConfirmed,
        dirtyRemovalComplete,
        cleanRemoved,
        forcedRemoved,
        cleanCloseConfirmed,
        cleanRemovalComplete,
        dirtyOrderOk,
        cleanOrderOk,
        lockRetryOk,
        lockAttempts,
        replacementOk,
        liveAfter,
        orderEvents,
        postCloseOk,
        postCwd,
        postPaneId,
        postRegisteredBefore,
        postMenuClicked,
        postRequested,
        postFencedBeforeClose,
        postCloseConfirmed,
        postDirtyAfterClose,
        postPresentAfterRefusal,
        postPaneGone,
        postSecondToast,
        postForceClicked,
        postGone,
        postSuccessToast,
        postAuditOk,
        postStages,
        postUnregistered,
        postEvents,
        repoIntact,
        dirs
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'worktree-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(run, 2500))
  else setTimeout(run, 2500)
}
