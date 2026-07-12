import { app } from 'electron'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { EXPLORER_LIST_CAP, type ExplorerEntry, type ExplorerResult } from '@contracts'
import { listDir } from '@backend/features/fs-browse'
import { handleExplorerList } from './explorer'

// Env-gated explorer-list smoke (MOGGING_FSLIST, Phase-11/01) — WINDOWLESS, zero UI,
// zero network, no daemon. Proves the read service every later explorer step consumes,
// through the exact validation seam `explorer:list` binds (`handleExplorerList`).
// Fixture: nested dirs + files, dotfile + dotdir, a `.git` repo dir, a broken symlink,
// 1500 siblings, a denied dir. Asserts:
//   (a) files AND dirs, dirs first, case-insensitive within each group;
//   (b) hidden filtered by default, `showHidden` reveals both kinds;
//   (c) EXPLORER_LIST_CAP + `truncated`;
//   (d) typed refusals, all four reasons — junk shapes refuse, never throw;
//   (e) `isRepo` true exactly on the repo dir (files never carry the key);
//   (f) the broken symlink is LISTED as a file, no throw;
//   (g) FOLDERPICK parity: `fs:listDir` byte-identical after the fs-paths extraction
//       (dirs only, files never listed, crumbs/parent/drive-roots intact).
// Verdict: out/fslist-result.json.

interface Fixture {
  root: string
  locked: string
  deniedCreated: boolean
  linkCreated: boolean
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'mog-fslist-'))
  // Dirs and files deliberately interleave alphabetically ACROSS groups, so a
  // lexicographic-only sort would fail the dirs-first assertion.
  for (const d of ['Apple', 'banana', 'Zeta', 'repo']) mkdirSync(join(root, d))
  mkdirSync(join(root, 'Apple', 'sub')) // nested dir …
  writeFileSync(join(root, 'Apple', 'inner.txt'), 'nested file\n') // … + nested file
  mkdirSync(join(root, 'repo', '.git')) // -> the isRepo probe
  mkdirSync(join(root, '.hushdir')) // hidden dir
  writeFileSync(join(root, '.hushfile'), 'hidden file\n')
  for (const f of ['alpha.txt', 'Beta.md', 'zulu.log']) writeFileSync(join(root, f), f + '\n')

  const many = join(root, 'many')
  mkdirSync(many)
  for (let i = 0; i < EXPLORER_LIST_CAP + 500; i++) writeFileSync(join(many, 'f' + String(i).padStart(4, '0')), '')

  // A dead symlink. win32 file symlinks need Developer Mode/admin; fall back to a
  // junction (also a reparse point Node reports as a symlink), then to skipping the
  // assertion honestly — the smoke says which condition it could build.
  let linkCreated = false
  for (const type of ['file', 'junction'] as const) {
    try {
      symlinkSync(join(root, 'no-such-target'), join(root, 'dead-link'), type)
      linkCreated = true
      break
    } catch {
      /* try the next flavor */
    }
  }

  // A really unreadable folder — the folderpick-smoke recipe verbatim, including the
  // verify step (a CI runner account can hold a privilege that bypasses its own /deny).
  const locked = join(root, 'locked')
  mkdirSync(locked)
  let deniedCreated = false
  try {
    if (process.platform === 'win32') {
      execFileSync('icacls', [locked, '/deny', `${process.env.USERNAME}:(RX)`], { stdio: 'ignore', windowsHide: true })
      deniedCreated = true
    } else if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      chmodSync(locked, 0o000)
      deniedCreated = true
    }
  } catch {
    /* couldn't create the condition — the smoke says so rather than pretending */
  }
  if (deniedCreated) {
    try {
      readdirSync(locked)
      deniedCreated = false
    } catch {
      /* good — the deny binds, the folder is genuinely unreadable */
    }
  }
  return { root, locked, deniedCreated, linkCreated }
}

function cleanup(f: Fixture): void {
  try {
    if (process.platform === 'win32') execFileSync('icacls', [f.locked, '/remove:d', String(process.env.USERNAME)], { stdio: 'ignore', windowsHide: true })
    else chmodSync(f.locked, 0o700)
  } catch {
    /* best effort */
  }
  try {
    rmSync(f.root, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

const names = (r: ExplorerResult): string[] => (r.ok ? r.entries.map((e) => e.name) : [])
const before = (list: string[], a: string, b: string): boolean => list.indexOf(a) >= 0 && list.indexOf(a) < list.indexOf(b)

export async function runFsListSmoke(): Promise<void> {
  const resultFile = join(app.getAppPath(), 'out', 'fslist-result.json')
  // RE-ENTRY guard (electron-vite dev respawns electron after app.exit): a previous
  // pass already wrote its verdict — leave it alone. qa-smokes.sh removes the file
  // before each run; do the same for a manual run.
  if (existsSync(resultFile)) {
    app.exit(0)
    return
  }
  const write = (o: object): void => {
    try {
      mkdirSync(dirname(resultFile), { recursive: true })
      writeFileSync(resultFile, JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }
  setTimeout(() => {
    write({ pass: false, error: 'TIMEOUT: fslist smoke did not complete' })
    app.exit(1)
  }, 60000)

  const fx = makeFixture()
  try {
    // ── (a) files AND dirs, dirs first, case-insensitive within each group ────────
    const rootList = handleExplorerList({ path: fx.root })
    const n = names(rootList)
    const entryByName = (name: string): ExplorerEntry | undefined => (rootList.ok ? rootList.entries.find((e) => e.name === name) : undefined)
    const kinds = rootList.ok ? rootList.entries.map((e) => e.kind) : []
    const filesAndDirs = kinds.includes('dir') && kinds.includes('file')
    const dirsFirst = kinds.lastIndexOf('dir') < kinds.indexOf('file')
    const dirsSorted = before(n, 'Apple', 'banana') && before(n, 'banana', 'repo') && before(n, 'repo', 'Zeta')
    const filesSorted = before(n, 'alpha.txt', 'Beta.md') && before(n, 'Beta.md', 'zulu.log')
    const nested = handleExplorerList({ path: join(fx.root, 'Apple') })
    const nestedOk =
      nested.ok &&
      nested.parent === fx.root &&
      nested.entries.map((e) => `${e.kind}:${e.name}`).join(',') === 'dir:sub,file:inner.txt'
    const listingOk = rootList.ok && filesAndDirs && dirsFirst && dirsSorted && filesSorted && nestedOk && rootList.truncated === false

    // Canonical form: a trailing separator and the bare spelling are ONE directory.
    const trailing = handleExplorerList({ path: fx.root + sep })
    const parentOk = rootList.ok && trailing.ok && trailing.path === rootList.path && rootList.parent === dirname(fx.root)

    // ── (b) hidden filtered by default; showHidden reveals both kinds ─────────────
    const shown = handleExplorerList({ path: fx.root, showHidden: true })
    const sn = names(shown)
    const hiddenOk =
      !n.includes('.hushdir') &&
      !n.includes('.hushfile') &&
      sn.includes('.hushdir') &&
      sn.includes('.hushfile') &&
      (shown.ok ? shown.entries.find((e) => e.name === '.hushdir')?.kind === 'dir' && shown.entries.find((e) => e.name === '.hushfile')?.kind === 'file' : false)

    // ── (c) cap + truncated ────────────────────────────────────────────────────────
    const big = handleExplorerList({ path: join(fx.root, 'many') })
    const capOk = big.ok && big.entries.length === EXPLORER_LIST_CAP && big.truncated === true

    // ── (d) typed refusals, all four reasons — junk never throws ──────────────────
    const denied = handleExplorerList({ path: fx.locked })
    const missing = handleExplorerList({ path: join(fx.root, 'nope') })
    const notDir = handleExplorerList({ path: join(fx.root, 'alpha.txt') })
    const relative = handleExplorerList({ path: join('not', 'absolute') })
    const junk = [handleExplorerList(null), handleExplorerList(undefined), handleExplorerList({}), handleExplorerList({ path: 42 }), handleExplorerList('junk')]
    const deniedOk = fx.deniedCreated ? !denied.ok && denied.reason === 'denied' : true
    const refusalsOk =
      deniedOk &&
      !missing.ok && missing.reason === 'missing' &&
      !notDir.ok && notDir.reason === 'not-a-directory' &&
      !relative.ok && relative.reason === 'invalid' &&
      junk.every((r) => !r.ok && r.reason === 'invalid')

    // ── (e) isRepo true exactly on the repo dir; files never carry the key ────────
    const repoOk =
      rootList.ok &&
      entryByName('repo')?.isRepo === true &&
      rootList.entries.every((e) => e.name === 'repo' || e.isRepo !== true) &&
      rootList.entries.every((e) => e.kind === 'dir' || !('isRepo' in e))

    // ── (f) the broken symlink is listed as a file — and nothing threw to get here ─
    const linkOk = fx.linkCreated ? entryByName('dead-link')?.kind === 'file' : true

    // ── per-OS roots, the FS_DRIVE_ROOT precedent ──────────────────────────────────
    const driveList = handleExplorerList({ path: '' })
    const rootsOk =
      process.platform === 'win32'
        ? driveList.ok && driveList.parent === null && driveList.entries.some((e) => e.name === 'C:') && driveList.entries.every((e) => e.kind === 'dir')
        : !driveList.ok && driveList.reason === 'invalid' && (() => { const r = handleExplorerList({ path: '/' }); return r.ok && r.parent === null })()

    // ── (g) FOLDERPICK parity: fs:listDir behaves byte-identically post-refactor ──
    const fsRoot = listDir({ path: fx.root })
    const fsNames = fsRoot.ok ? fsRoot.entries.map((e) => e.name) : []
    const fsTrailing = listDir({ path: fx.root + sep })
    const fsDrives = process.platform === 'win32' ? listDir({ path: '' }) : null
    const folderpickOk =
      fsRoot.ok &&
      fsNames.join(',') === ['Apple', 'banana', 'locked', 'many', 'repo', 'Zeta'].join(',') && // dirs only, sorted, hidden filtered — files never listed
      fsRoot.entries.find((e) => e.name === 'repo')?.isRepo === true &&
      fsRoot.parent === dirname(fx.root) &&
      fsRoot.crumbs[fsRoot.crumbs.length - 1]?.label === basename(fx.root) &&
      fsTrailing.ok && fsTrailing.path === fsRoot.path &&
      (process.platform !== 'win32' || (!!fsDrives && fsDrives.ok && fsDrives.parent === null && fsDrives.entries.some((e) => e.name === 'C:')))

    const pass = listingOk && parentOk && hiddenOk && capOk && refusalsOk && repoOk && linkOk && rootsOk && folderpickOk
    write({
      pass,
      listingOk, filesAndDirs, dirsFirst, dirsSorted, filesSorted, nestedOk,
      parentOk, hiddenOk, capOk,
      refusalsOk, deniedCreated: fx.deniedCreated, denied, missing: !missing.ok && missing.reason, notDir: !notDir.ok && notDir.reason,
      repoOk, linkOk, linkCreated: fx.linkCreated, rootsOk, folderpickOk,
      rootNames: n, shownNames: sn, fsNames,
      bigCount: big.ok ? big.entries.length : -1,
      platform: process.platform
    })
    cleanup(fx)
    app.exit(pass ? 0 : 1)
  } catch (e) {
    write({ pass: false, error: String(e) })
    cleanup(fx)
    app.exit(1)
  }
}
