import { app, type BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MOD_KEY_FIELD } from './kit'

// Env-gated wizard-isolation SUCCESS smoke (MOGGING_WIZARDISO). WIZARDFAIL proves the
// wizard's isolation failure paths roll back; NOTHING proved the success path through
// the REAL page — WORKTREE drives the `templates.openIsolated` dev handle, which
// bypasses the checkbox, syncIsolate, tryLaunch, and openPlannedWorkspaceFromTemplate
// entirely. This gate walks the exact user path: open the wizard at a repo, wait for
// the git probe, open Advanced, click "Isolate each agent in its own git worktree",
// Launch — then demands testimony: two managed worktrees exist, the workspace's
// paneCwds point INTO them, and each pane's SHELL really ran there (a `custom:`
// provider writes `git branch --show-current` into branch.txt at its own cwd).
// Also owns the layout menu's verbs since the reorganize redesign: the MANUAL
// isolated terminal (the popover's "New terminal…" row opens the pane-creation
// modal, whose isolate tick must go live for a repo folder and put the new pane in
// a worktree of its own), the isolated BATCH (N worktrees in one gesture —
// worktrees must equal panes added, and the return is true only when every
// requested terminal opened), the PLAIN batch (N terminals, zero worktrees), and
// REORGANIZE (the Reorganize row opens the wizard's layout PAINTER in a modal;
// applying a custom arrangement + new count reshapes to exactly that spec, gated by
// the live-work confirm on a drop, survivors preserved).
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

      // ── Manual flow (layout menu → "New terminal…" modal) ──────────────────────
      // The popover's two stepper rows collapsed into ONE row that opens the pane-creation
      // modal (workspace/index.ts: `New terminal…` → controller.openNewTerminals()), whose
      // isolate tick is the manual twin of the wizard's checkbox and applies to every
      // terminal it creates. The claim under test is unchanged — the REAL titlebar surface,
      // not the controller method, must add a pane whose manifest cwd is a THIRD worktree —
      // so only the path to it moved. `.layout-menu-add-isolated` no longer exists.
      const menuClicked = await ES<boolean>(`(async () => {
        document.querySelector('.layout-launcher > button')?.click()
        await new Promise((r) => setTimeout(r, 50))
        const row = document.querySelector('.layout-menu-add')
        if (!(row instanceof HTMLElement)) return false
        row.click()
        await new Promise((r) => setTimeout(r, 250))
        return !!document.querySelector('.modal .ntm-body')
      })()`)
      // The modal IS the wizard's painter now, over this workspace's real grid: the two
      // terminals already open are drawn as LOCKED tiles, and every gesture that would
      // disturb one is refused — a click does not open its picker or split it, and the
      // lattice will not offer a grid too small to hold them. That refusal is what lets
      // this dialog have no destructive confirm at all: it can only ever add.
      const painter = await ES<{
        shell: boolean
        lockedTiles: number
        tilesAfterLockedClick: number
        menuAfterLockedClick: boolean
        oneByOneBlocked: boolean
        twoByTwoOffered: boolean
      }>(`(async () => {
        const q = (s) => document.querySelector(s)
        const shell = !!q('.modal .ntm-body .grid-painter') && !!q('.modal .gp-lattice') && !!q('.modal .gp-canvas')
        const tiles = () => document.querySelectorAll('.modal .gp-region').length
        const lockedTiles = document.querySelectorAll('.modal .gp-region.is-locked').length
        const before = tiles()
        q('.modal .gp-region.is-locked')?.click()
        await new Promise((r) => setTimeout(r, 150))
        const cellAt = (r, c) => q('.modal .gp-cell[data-r="' + r + '"][data-c="' + c + '"]')
        return {
          shell,
          lockedTiles,
          tilesAfterLockedClick: tiles(),
          menuAfterLockedClick: !!q('.context-menu'),
          oneByOneBlocked: !!cellAt(0, 0)?.disabled,   // 1 tile < 2 open terminals
          twoByTwoOffered: cellAt(1, 1)?.disabled === false
        }
      })()`)
      const painterOk =
        painter.shell &&
        painter.lockedTiles === 2 &&
        painter.tilesAfterLockedClick === painter.lockedTiles + 1 && // 2 locked + the 1 being added
        !painter.menuAfterLockedClick &&
        painter.oneByOneBlocked &&
        painter.twoByTwoOffered
      // The modal's isolate box rides the SAME git preflight as the wizard's, and starts
      // unticked in a fresh profile (no remembered lineup). Poll it LIVE, then tick it: a box
      // that never enables for a repo folder is the "wasn't possible to isolate" bug class
      // this gate exists for, exactly as at the wizard's own checkbox above.
      const manualBox = await ES<{ found: boolean; live: boolean; checked: boolean }>(`(async () => {
        const find = () => [...document.querySelectorAll('.modal .wizard-option-row label')]
          .find((item) => item.textContent?.includes('Isolate each terminal'))?.querySelector('input')
        for (let i = 0; i < 40; i++) {
          const b = find()
          if (b instanceof HTMLInputElement && !b.disabled) break
          await new Promise((r) => setTimeout(r, 250))
        }
        const b = find()
        if (!(b instanceof HTMLInputElement)) return { found: false, live: false, checked: false }
        if (!b.disabled && !b.checked) b.click()
        return { found: true, live: !b.disabled, checked: b.checked }
      })()`)
      const manualBoxLive = manualBox.found && manualBox.live && manualBox.checked
      // Confirm by the primary action, the way a user leaves this dialog.
      await ES(`document.querySelector('.modal .confirm-actions .btn--primary')?.click()`)
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
      // Pressed with the modifier THIS platform is bound to (⌘ on macOS, Ctrl elsewhere): the
      // workspace listener gates on isModKey, which core/commands/chords.ts made the platform's
      // own and never both. A hardcoded Ctrl on a Mac splits nothing, so the claim being tested
      // ("this chord splits, and splits PLAIN") would pass for the wrong reason.
      const worktreesBeforePlain = readdirSync(wtRoot).length
      await ES(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ${MOD_KEY_FIELD}: true, shiftKey: true, bubbles: true, cancelable: true }))`)
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

      // ── PLAIN batch: the New-terminal stepper — N panes in one gesture, ZERO
      // worktrees. splitActive returns nothing, so the honest-count contract is
      // pinned against the workspace's OWN quoted headroom (layout.status) instead:
      // the batch must add exactly min(2, headroom) — a clamped screen stays green
      // for the clamp, a count-ignoring regression reds for the shortfall.
      const panesBeforePlainBatch = panesAfterBatch
      const worktreesBeforePlainBatch = readdirSync(wtRoot).length
      const statusBeforePlainBatch = await ES<{ panes: number; cap: number } | null>(`window.__mogging.layout.status()`)
      const plainBatchExpected = statusBeforePlainBatch
        ? Math.min(2, Math.max(0, statusBeforePlainBatch.cap - statusBeforePlainBatch.panes))
        : 2
      await ES(`window.__mogging.layout.split(undefined, 2)`)
      let panesAfterPlainBatch = panesBeforePlainBatch
      for (let i = 0; i < 20; i++) {
        await sleep(300)
        panesAfterPlainBatch = await ES<number>(`window.__mogging.layout.paneCount()`)
        if (panesAfterPlainBatch >= panesBeforePlainBatch + plainBatchExpected) break
      }
      const plainBatchAdded = panesAfterPlainBatch - panesBeforePlainBatch
      const plainBatchOk =
        plainBatchAdded === plainBatchExpected && readdirSync(wtRoot).length === worktreesBeforePlainBatch

      // ── REORGANIZE: the layout PAINTER, on a live workspace. Three claims:
      //   (a) the titlebar Reorganize row opens the wizard's painter in a MODAL;
      //   (b) applying a CUSTOM arrangement + a NEW (lower) count reshapes to exactly
      //       that spec — a full-width top pane over two below — proving the painted
      //       arrangement drives the grid, not a canonical fallback;
      //   (c) because the drop closes live panes (the wizard panes carry sessions), the
      //       live-work CONFIRM fires first, and confirming preserves the survivors
      //       (every surviving pane id existed before — none rebuilt);
      //   (d) THE HOLE — an EQUAL-count reshape over a gap in the slot numbering closes
      //       nothing, so it must not ask. This is the negative claim the whole feature
      //       rests on; see the block comment where it runs.
      const reorg = await ES<{
        modalOpened: boolean
        modalClosed: boolean
        after: number
        rows: number[]
        confirmShown: boolean
        topWide: boolean
        preserved: boolean
        holeBefore: number[]
        holeConfirm: boolean
        holeApplied: boolean
        holeAfter: number[]
        holeOrderKept: boolean
      }>(`(async () => {
        const m = window.__mogging
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
        const box = (id) => document.querySelector('.layout-slot[data-pane-id="' + id + '"]').getBoundingClientRect()
        const rowsOf = () => {
          const boxes = m.layout.paneIds().map((id) => ({ y: Math.round(box(id).top) }))
          const tops = [...new Set(boxes.map((b) => b.y))].sort((a, b) => a - b)
          const bands = []
          for (const t of tops) { if (!bands.length || t - bands[bands.length - 1] > 8) bands.push(t) }
          return bands.map((band) => boxes.filter((b) => Math.abs(b.y - band) <= 8).length)
        }

        // (a) the real Reorganize row opens the painter modal.
        document.querySelector('.layout-launcher > button')?.click()
        await sleep(80)
        document.querySelector('.layout-menu-reorganize')?.click()
        await sleep(220)
        const modalOpened =
          !!document.querySelector('.modal .grid-painter') &&
          !!document.querySelector('.modal .gp-lattice') &&
          !!document.querySelector('.modal .gp-canvas')
        ;[...document.querySelectorAll('.modal button')].find((b) => /^cancel$/i.test((b.textContent || '').trim()))?.click()
        await sleep(400)
        const modalClosed = !document.querySelector('.modal .grid-painter')

        // (b)+(c) apply a custom, smaller layout directly; the confirm must gate the drop.
        // The plain shells that will close aren't "live", so make the doomed pane busy —
        // now the drop genuinely closes live work and the confirm is owed. The closing set
        // is decided by READING ORDER, not slot number (splitLine inserts a new leaf beside
        // its target, so numbering stopped meaning position at the first split), so the
        // victim is the BOTTOM-RIGHT pane: certainly outside the first 3 when shrinking to
        // 3. Under the ALERTAGREE tracked gate a state only sticks on a TRACKED pane (as a
        // real session's would be), so claim it first — else setPaneState falls on the floor
        // and nothing reads as live.
        const readingOrder = (ids) =>
          ids
            .map((id) => ({ id, r: box(id) }))
            .sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left)
            .map((e) => e.id)
        const beforeIds = m.layout.paneIds()
        const victim = readingOrder(beforeIds).at(-1)
        m.attention.setPaneTracked(victim, true)
        m.attention.setPaneState(victim, 'busy')
        await sleep(150)
        const spec = { rows: 2, cols: 2, regions: [{ r: 0, c: 0, rs: 1, cs: 2 }, { r: 1, c: 0, rs: 1, cs: 1 }, { r: 1, c: 1, rs: 1, cs: 1 }] }
        const done = m.layout.reorganizeApply(spec) // Promise — blocks on the confirm
        let confirmShown = false
        for (let i = 0; i < 30 && !confirmShown; i++) {
          await sleep(100)
          const btn = [...document.querySelectorAll('.modal button')].find((b) => /close panes and reorganize/i.test(b.textContent || ''))
          if (btn) { confirmShown = true; btn.click() }
        }
        await done
        await sleep(500)
        const ids = m.layout.paneIds()
        const topWide = (() => {
          if (ids.length !== 3) return false
          const rects = ids.map(box).sort((a, b) => a.top - b.top)
          return rects.slice(1).every((r) => rects[0].width >= r.width * 1.8) // top spans both columns
        })()
        const preserved = ids.every((id) => beforeIds.includes(id)) // survivors reused, none rebuilt
        // Read the shrink's verdict NOW — phase (d) below reshapes the same workspace again.
        const after = m.layout.paneCount()
        const rows = rowsOf()

        // (d) THE HOLE. Close a pane in the MIDDLE of the slot numbering and reorganize at
        // the SAME count. Neither removeLeaf nor serializeTree renumbers, so the gap is real
        // and outlives a restart; the chooser used to walk 1..N taking "live or free" and
        // grabbed the hole AHEAD of the highest live slot — killing a running agent on a
        // reshape that creates and destroys nothing. The proof is NEGATIVE: no confirm is
        // owed, nothing dies, and the pane on the left is still the pane on the left.
        const sorted = ids.slice().sort((a, b) => a - b)
        const mid = sorted[sorted.length - 2] // second highest ⇒ the gap sits BELOW a live slot
        const doomed = sorted[sorted.length - 1] // what the old chooser would have dropped
        m.layout.close(mid)
        for (let i = 0; i < 20 && m.layout.paneIds().length > 2; i++) {
          await sleep(150)
          document.querySelector('.modal-overlay:not(.is-closing) .btn--danger')?.click()
        }
        const holeBefore = m.layout.paneIds()
        m.attention.setPaneTracked(doomed, true)
        m.attention.setPaneState(doomed, 'busy')
        await sleep(150)
        const leftBefore = readingOrder(holeBefore)[0]
        const evenSpec = { rows: 1, cols: 2, regions: [{ r: 0, c: 0, rs: 1, cs: 1 }, { r: 0, c: 1, rs: 1, cs: 1 }] }
        const holeDone = m.layout.reorganizeApply(evenSpec)
        let holeConfirm = false
        for (let i = 0; i < 12 && !holeConfirm; i++) {
          await sleep(100)
          const btn = [...document.querySelectorAll('.modal button')].find((b) => /close panes and reorganize/i.test(b.textContent || ''))
          if (btn) { holeConfirm = true; btn.click() } // click anyway, so the promise settles
        }
        const holeApplied = await holeDone
        await sleep(400)
        const holeAfter = m.layout.paneIds()
        const holeOrderKept = readingOrder(holeAfter)[0] === leftBefore

        return {
          modalOpened, modalClosed, after, rows, confirmShown, topWide, preserved,
          holeBefore, holeConfirm, holeApplied, holeAfter, holeOrderKept
        }
      })()`)
      // An equal-count reshape over a slot gap: it closes nothing, so it must neither ASK
      // (holeConfirm) nor silently refuse (holeApplied — the old limit() clamp returned
      // false with no message), no pane may die or be rebuilt, and the left pane must still
      // be the left pane: a reshape is a resize, not a shuffle.
      const holeOk =
        reorg.holeBefore.length === 2 &&
        reorg.holeConfirm === false &&
        reorg.holeApplied === true &&
        reorg.holeAfter.length === 2 &&
        reorg.holeAfter.every((id) => reorg.holeBefore.includes(id)) &&
        reorg.holeOrderKept
      const reorganizeOk =
        reorg.modalOpened &&
        reorg.modalClosed &&
        reorg.confirmShown &&
        reorg.after === 3 &&
        JSON.stringify(reorg.rows) === JSON.stringify([1, 2]) &&
        reorg.topWide &&
        reorg.preserved &&
        holeOk

      // ── PLACEMENT: the painted spec decides WHERE, on a fresh workspace so the claim
      // is about geometry and not about whatever the earlier phases left behind. Applying
      // "one full-width row on top, two below" to a 1-pane workspace must (a) keep the
      // pane that was already there, (b) put it top-left, where its locked tile was, and
      // (c) land the two new terminals in the bottom row. The old path could not express
      // any of this: it split the FOCUSED pane along its longer axis, N times, off itself.
      const placeDir = mkdtempSync(join(tmpdir(), 'mog-wiziso-place-'))
      await ES(`window.__mogging.workspace.create({ name: 'Placement', cwd: ${JSON.stringify(placeDir)} })`)
      await sleep(900)
      const place = await ES<{
        applied: boolean
        before: number[]
        after: number[]
        kept: boolean
        rows: number[]
        topWide: boolean
      }>(`(async () => {
        const m = window.__mogging
        const box = (id) => document.querySelector('.layout-slot[data-pane-id="' + id + '"]').getBoundingClientRect()
        const before = m.layout.paneIds()
        const spec = { rows: 2, cols: 2, regions: [
          { r: 0, c: 0, rs: 1, cs: 2 }, { r: 1, c: 0, rs: 1, cs: 1 }, { r: 1, c: 1, rs: 1, cs: 1 }
        ] }
        const applied = await m.layout.newTerminalsApply({
          spec,
          // The pane ids, in the READING order the modal captures them in — a count
          // cannot say which, and the controller now checks the set.
          liveIds: m.layout.liveOrder(),
          entries: [{ provider: 'shell' }, { provider: 'shell' }],
          isolate: false
        })
        await new Promise((r) => setTimeout(r, 800))
        const after = m.layout.paneIds()
        const rects = after.map((id) => ({ id, r: box(id) })).sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left)
        const tops = [...new Set(rects.map((e) => Math.round(e.r.top)))].sort((a, b) => a - b)
        const bands = []
        for (const t of tops) { if (!bands.length || t - bands[bands.length - 1] > 8) bands.push(t) }
        return {
          applied,
          before,
          after,
          // The pane that already existed survives AND is the one in the full-width row.
          kept: before.every((id) => after.includes(id)) && rects[0].id === before[0],
          rows: bands.map((band) => rects.filter((e) => Math.abs(e.r.top - band) <= 8).length),
          topWide: rects.slice(1).every((e) => rects[0].r.width >= e.r.width * 1.8)
        }
      })()`)
      const placementOk =
        place.applied &&
        place.before.length === 1 &&
        place.after.length === 3 &&
        place.kept &&
        JSON.stringify(place.rows) === JSON.stringify([1, 2]) &&
        place.topWide

      // ── RE-SEED: the workspace can change while the New-terminals dialog is up, and the
      // dialog must REDRAW rather than dead-end. The locked prefix is positional — tile k
      // stands for the k-th live pane — so a pane closing underneath invalidates the whole
      // canvas, not just one tile. It must lose a locked tile AND say why.
      const reseed = await ES<{ opened: boolean; lockedBefore: number; lockedAfter: number; note: string }>(`(async () => {
        const m = window.__mogging
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
        const locked = () => document.querySelectorAll('.modal .gp-region.is-locked').length
        m.layout.newTerminals()
        await sleep(400)
        const opened = !!document.querySelector('.modal .ntm-body .grid-painter')
        const lockedBefore = locked()
        // Close a pane from OUTSIDE the dialog — the control-API verb, not the dialog's own.
        const victim = m.layout.paneIds().slice().sort((a, b) => a - b).at(-1)
        m.layout.close(victim)
        for (let i = 0; i < 20 && locked() === lockedBefore; i++) await sleep(200)
        const note = document.querySelector('.modal .ntm-reseed')
        const text = note && !note.hidden ? note.textContent || '' : ''
        document.querySelector('.modal .btn--ghost')?.click()
        await sleep(300)
        return { opened, lockedBefore, lockedAfter: locked(), note: text }
      })()`)
      const reseedOk =
        reseed.opened &&
        reseed.lockedBefore === 3 &&
        reseed.lockedAfter === 2 &&
        /closed in this workspace/i.test(reseed.note)

      // ── READING ORDER: the order the placement painter labels its locked tiles in.
      // `paneIds()` is a depth-first TREE walk and diverges from what the screen reads the
      // moment a split nests — split right, then split the left pane down, and the tree
      // h[v[1,3],2] walks 1,3,2 while the eye reads 1,2,3. A painter that labels from one
      // and lands through the other puts another terminal's name on every locked tile.
      // Built with EXPLICIT directions, because auto-direction depends on the pane's aspect.
      const orderDir = mkdtempSync(join(tmpdir(), 'mog-wiziso-order-'))
      await ES(`window.__mogging.workspace.create({ name: 'Order', cwd: ${JSON.stringify(orderDir)} })`)
      await sleep(900)
      const order = await ES<{ tree: number[]; reading: number[]; byRect: number[]; nested: boolean }>(`(async () => {
        const m = window.__mogging
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
        const box = (id) => document.querySelector('.layout-slot[data-pane-id="' + id + '"]').getBoundingClientRect()
        m.layout.split('h')
        await sleep(600)
        // Split moved focus to the new pane; aim the second split at the FIRST one again.
        // MOUSEDOWN, not click: grid-layout focuses on mousedown, and el.click() fires
        // neither — the second split would land on the wrong pane and the tree would come
        // out flat, which the nested check below would then (correctly) call a failure.
        const first = m.layout.paneIds().slice().sort((a, b) => a - b)[0]
        document
          .querySelector('.layout-slot[data-pane-id="' + first + '"]')
          ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
        await sleep(200)
        m.layout.split('v')
        await sleep(800)
        const tree = m.layout.paneIds()
        const reading = m.layout.liveOrder()
        const byRect = tree
          .map((id) => ({ id, r: box(id) }))
          .sort((a, b) => (Math.abs(a.r.top - b.r.top) > 8 ? a.r.top - b.r.top : a.r.left - b.r.left))
          .map((e) => e.id)
        return { tree, reading, byRect, nested: JSON.stringify(tree) !== JSON.stringify(byRect) }
      })()`)
      const readingOrderOk =
        order.tree.length === 3 &&
        // The fixture must actually be nested, or the claim below is vacuous.
        order.nested &&
        JSON.stringify(order.reading) === JSON.stringify(order.byRect)

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

      const pass =
        checkboxLive &&
        checked &&
        opened &&
        dirs.length === 2 &&
        cwdsAreWorktrees &&
        shellsIsolated &&
        menuClicked &&
        painterOk &&
        manualBoxLive &&
        manualIsolated &&
        plainStaysPlain &&
        batchOk &&
        plainBatchOk &&
        reorganizeOk &&
        placementOk &&
        readingOrderOk &&
        reseedOk &&
        fakeRefusedHonestly
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
        painterOk,
        painter,
        manualBox,
        manualBoxLive,
        manualIsolated,
        manualCwd,
        plainStaysPlain,
        batchOk,
        batchAdded,
        batchReturned,
        plainBatchOk,
        plainBatchAdded,
        reorganizeOk,
        holeOk,
        reorg,
        placementOk,
        place,
        readingOrderOk,
        order,
        reseedOk,
        reseed,
        fakeRefusedHonestly
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
