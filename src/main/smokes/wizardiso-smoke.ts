import { app, type BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Env-gated wizard-isolation SUCCESS smoke (MOGGING_WIZARDISO). WIZARDFAIL proves the
// wizard's isolation failure paths roll back; NOTHING proved the success path through
// the REAL page — WORKTREE drives the `templates.openIsolated` dev handle, which
// bypasses the checkbox, syncIsolate, tryLaunch, and openPlannedWorkspaceFromTemplate
// entirely. This gate walks the exact user path: open the wizard at a repo, wait for
// the git probe, open Advanced, click "Isolate each agent in its own git worktree",
// Launch — then demands testimony: two managed worktrees exist, the workspace's
// paneCwds point INTO them, and each pane's SHELL really ran there (a `custom:`
// provider writes `git branch --show-current` into branch.txt at its own cwd).
// Also owns the layout menu's ISOLATION verbs: the single row, the BATCH stepper
// (N worktrees in one gesture — worktrees must equal panes added, and the return
// is true only when every requested terminal opened), and the picker's live-work
// gate (a template tile that would close a busy pane is aria-disabled with a
// reason, un-clickable, and re-lights when the pane calms).
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'mog-wiziso-'))
  git(repo, ['init', '-q'])
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repo, ['config', 'user.email', 'smoke@mogging.test'])
  git(repo, ['config', 'user.name', 'Wizard Iso Smoke'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(repo, 'README.md'), 'isolation success path\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'init'])
  return repo
}

export function runWizardIsoSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 150000)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      const repo = makeRepo()
      await sleep(1500)

      const provider = 'custom:git branch --show-current > branch.txt'
      await ES(
        `window.__mogging.templates.openWizard({ cwd: ${JSON.stringify(repo)}, paneCount: 2, mix: [{ provider: ${JSON.stringify(provider)}, count: 2 }] })`
      )
      await sleep(1200) // git probe + registry refresh settle

      // The checkbox must be LIVE for a repo folder — a disabled box here is the
      // "wasn't possible to isolate" bug class this gate exists for.
      const boxState = await ES<{ found: boolean; disabled: boolean; hint: string }>(`(() => {
        document.querySelectorAll('#view-wizard .wizard-adv').forEach((d) => (d.open = true))
        const label = [...document.querySelectorAll('#view-wizard label')]
          .find((item) => item.textContent?.includes('Isolate each agent'))
        const box = label?.querySelector('input')
        return {
          found: box instanceof HTMLInputElement,
          disabled: !!box?.disabled,
          hint: label?.parentElement?.querySelector('.wizard-hint')?.textContent ?? ''
        }
      })()`)
      const checkboxLive = boxState.found && !boxState.disabled

      const checked = await ES<boolean>(`(() => {
        const label = [...document.querySelectorAll('#view-wizard label')]
          .find((item) => item.textContent?.includes('Isolate each agent'))
        const box = label?.querySelector('input')
        if (box instanceof HTMLInputElement && !box.checked) box.click()
        return box instanceof HTMLInputElement && box.checked
      })()`)

      const before = await ES<number>(`window.__mogging.workspace.count()`)
      await ES(`document.querySelector('#view-wizard .wizard-footer .btn--primary')?.click()`)

      // Poll for the workspace to open (worktree creation is async over IPC).
      let opened = false
      for (let i = 0; i < 40 && !opened; i++) {
        await sleep(500)
        opened = (await ES<number>(`window.__mogging.workspace.count()`)) === before + 1
      }
      const status = await ES<string>(
        `document.querySelector('#view-wizard .path-input-status')?.textContent ?? ''`
      )

      // Two managed worktrees, and the workspace's paneCwds point INTO them.
      const wtRoot = join(repo, '.mogging', 'worktrees')
      const dirs = existsSync(wtRoot) ? readdirSync(wtRoot) : []
      const active = await ES<{ paneCwds?: (string | null)[] } | null>(
        `window.__mogging.workspace.active()`
      )
      const paneCwds = (active?.paneCwds ?? []).filter((p): p is string => !!p)
      const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase()
      const cwdsAreWorktrees =
        paneCwds.length === 2 &&
        paneCwds.every((p) => norm(p).includes(norm(wtRoot))) &&
        new Set(paneCwds.map(norm)).size === 2

      // Shell testimony: each pane's process ran `git branch --show-current` at ITS
      // OWN cwd. Poll — the PTYs spawn after the workspace opens.
      let branches: string[] = []
      for (let i = 0; i < 40; i++) {
        branches = paneCwds
          .map((p) => join(p, 'branch.txt'))
          .filter((f) => existsSync(f))
          .map((f) => readFileSync(f, 'utf8').trim())
        if (branches.length === 2 && branches.every((b) => b)) break
        await sleep(500)
      }
      const shellsIsolated =
        branches.length === 2 &&
        branches.every((b) => b.startsWith('mogging/')) &&
        new Set(branches).size === 2

      // ── Manual flow (layout menu): "New isolated terminal (worktree)" ──────────
      // Drive the REAL titlebar menu, not the controller method: the row must exist,
      // and clicking it must add one pane whose manifest cwd is a THIRD worktree.
      const menuClicked = await ES<boolean>(`(async () => {
        document.querySelector('.layout-launcher > button')?.click()
        await new Promise((r) => setTimeout(r, 50))
        const row = document.querySelector('.layout-menu-add-isolated')
        if (!(row instanceof HTMLElement)) return false
        row.click()
        return true
      })()`)
      let manualIsolated = false
      let manualCwd = ''
      for (let i = 0; i < 30 && !manualIsolated; i++) {
        await sleep(500)
        const snap = await ES<{ paneCwds?: (string | null)[] } | null>(`window.__mogging.workspace.active()`)
        const count = await ES<number>(`window.__mogging.layout.paneCount()`)
        manualCwd = snap?.paneCwds?.[2] ?? ''
        manualIsolated =
          count === 3 &&
          !!manualCwd &&
          norm(manualCwd).includes(norm(wtRoot)) &&
          !paneCwds.some((p) => norm(p) === norm(manualCwd)) &&
          (existsSync(wtRoot) ? readdirSync(wtRoot).length : 0) === 3

      }

      // ── Ctrl+Shift+D stays PLAIN: the real keydown must split without a worktree ──
      const worktreesBeforePlain = readdirSync(wtRoot).length
      await ES(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }))`)
      let plainSplit = false
      for (let i = 0; i < 20 && !plainSplit; i++) {
        await sleep(300)
        plainSplit = (await ES<number>(`window.__mogging.layout.paneCount()`)) === 4
      }
      const plainStaysPlain = plainSplit && readdirSync(wtRoot).length === worktreesBeforePlain

      // ── Batch: the layout menu's stepper promises N isolated terminals in ONE
      // gesture. Geometry-relative on purpose (a small screen may trim the batch):
      // the invariants are worktrees == panes added (no litter, no shortfall) and a
      // return value that is true exactly when every REQUESTED terminal opened —
      // never the literal number 2.
      const panesBeforeBatch = await ES<number>(`window.__mogging.layout.paneCount()`)
      const worktreesBeforeBatch = readdirSync(wtRoot).length
      const batchReturned = await ES<boolean>(`window.__mogging.layout.splitIsolated(undefined, 2)`)
      let panesAfterBatch = panesBeforeBatch
      for (let i = 0; i < 20; i++) {
        await sleep(300)
        panesAfterBatch = await ES<number>(`window.__mogging.layout.paneCount()`)
        if (panesAfterBatch >= panesBeforeBatch + 2) break
      }
      const batchAdded = panesAfterBatch - panesBeforeBatch
      const batchWorktrees = readdirSync(wtRoot).length - worktreesBeforeBatch
      const batchOk =
        batchAdded >= 1
          ? batchWorktrees === batchAdded && batchReturned === (batchAdded === 2)
          : batchReturned === false && batchWorktrees === 0 // a full grid refuses with no litter

      // ── The Pedro case: a folder wearing an EMPTY `.git` is NOT a repo. The manual
      // isolated row must refuse honestly — no pane, no worktree litter.
      const fakeRepo = mkdtempSync(join(tmpdir(), 'mog-wiziso-fake-'))
      mkdirSync(join(fakeRepo, '.git'))
      await ES(`window.__mogging.workspace.create({ name: 'FakeRepo', cwd: ${JSON.stringify(fakeRepo)} })`)
      await sleep(800)
      const beforeFake = await ES<number>(`window.__mogging.layout.paneCount()`)
      const refused = await ES<boolean>(`window.__mogging.layout.splitIsolated()`)
      await sleep(800)
      const fakeRefusedHonestly =
        refused === false &&
        (await ES<number>(`window.__mogging.layout.paneCount()`)) === beforeFake &&
        !existsSync(join(fakeRepo, '.mogging', 'worktrees'))

      // ── The picker refuses a shrink over LIVE work: in FakeRepo (no agent sessions,
      // so the gate is deterministic), split plain, mark the new pane busy, and the
      // 1-pane tile must be aria-disabled with a reason; its click must do nothing —
      // no shrink, no confirm dialog. Calm the pane and the SAME tile lights again:
      // the refusal derives from live state, not pane count.
      await ES(`window.__mogging.layout.split()`)
      for (let i = 0; i < 20; i++) {
        await sleep(300)
        if ((await ES<number>(`window.__mogging.layout.paneCount()`)) === beforeFake + 1) break
      }
      const tileGate = await ES<{
        split: boolean
        disabledWhileBusy: boolean
        reason: string
        ignored: boolean
        enabledWhenIdle: boolean
      }>(`(async () => {
        const m = window.__mogging
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
        const ids = m.layout.paneIds()
        const split = ids.length === ${beforeFake + 1}
        const newest = ids[ids.length - 1] // highest slot: closed by every smaller template
        m.attention.setPaneState(newest, 'busy')
        await sleep(150)
        const openMenu = async () => {
          document.querySelector('.layout-launcher > button')?.click()
          await sleep(80)
          return document.querySelector('.layout-menu .layout-tile') // first tile = the 1-pane template
        }
        const tile = await openMenu()
        const disabledWhileBusy = !!tile && tile.getAttribute('aria-disabled') === 'true'
        const reason = (tile && tile.title) || ''
        const before = m.layout.paneCount()
        if (tile) tile.click()
        await sleep(300)
        const ignored = m.layout.paneCount() === before && !document.querySelector('.modal-overlay')
        document.querySelector('.layout-launcher > button')?.click() // close (a close never re-renders)
        m.attention.setPaneState(newest, 'idle')
        await sleep(150)
        const tile2 = await openMenu()
        const enabledWhenIdle = !!tile2 && tile2.getAttribute('aria-disabled') !== 'true'
        document.querySelector('.layout-launcher > button')?.click()
        return { split, disabledWhileBusy, reason, ignored, enabledWhenIdle }
      })()`)
      const pickerGateOk =
        tileGate.split &&
        tileGate.disabledWhileBusy &&
        tileGate.reason.length > 0 &&
        tileGate.ignored &&
        tileGate.enabledWhenIdle

      const pass =
        checkboxLive &&
        checked &&
        opened &&
        dirs.length === 2 &&
        cwdsAreWorktrees &&
        shellsIsolated &&
        menuClicked &&
        manualIsolated &&
        plainStaysPlain &&
        batchOk &&
        fakeRefusedHonestly &&
        pickerGateOk
      result = {
        pass,
        checkboxLive,
        boxState,
        checked,
        opened,
        status,
        dirs,
        paneCwds,
        cwdsAreWorktrees,
        branches,
        shellsIsolated,
        menuClicked,
        manualIsolated,
        manualCwd,
        plainStaysPlain,
        batchOk,
        batchAdded,
        batchReturned,
        fakeRefusedHonestly,
        tileGate,
        pickerGateOk
      }
    } catch (error) {
      result = { pass: false, error: String(error) }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'wizardiso-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    console.log('[wizardiso-smoke]', JSON.stringify(result))
    app.exit(result.pass ? 0 : 1)
  }

  wc.once('did-finish-load', () => void run())
  if (!wc.isLoading()) void run()
}
