import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Scratch directories for tests, and a cleanup that cannot fail the suite.
 *
 * `rmSync(dir, { recursive: true, force: true })` in an `afterAll` throws EPERM on Windows
 * whenever anything still holds a handle — a git process that has not fully exited, an
 * indexer, antivirus. `force: true` suppresses "does not exist"; it does nothing about
 * "in use", and there is no retry.
 *
 * Observed: worktree-dirty-guard's five tests all PASSED and the file reported FAIL, because
 * the teardown threw. A suite that can go red for a reason unrelated to the code under test is
 * the same defect class as a gate that can go green for one — it makes the signal untrustworthy
 * in the direction that costs an investigation.
 *
 * A leftover temp directory is not a test result. Retry a few times, then let the OS sweep it.
 * spawn-tool.test.ts already had the try/catch; this is that, made shared and given retries.
 */
export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function removeTempDir(dir: string): void {
  try {
    // maxRetries/retryDelay are handled inside rmSync for EBUSY/ENOTEMPTY/EPERM on Windows.
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {
    /* Still held. The OS temp sweep gets it; a stale scratch dir is not a failing test. */
  }
}

/** Drain a list of scratch dirs. Empties the array, so a second call is a no-op. */
export function removeTempDirs(dirs: string[]): void {
  for (const dir of dirs.splice(0)) removeTempDir(dir)
}

/**
 * Make a path stop resolving, and PROVE it. For SETUP, never for teardown.
 *
 * `removeTempDir` swallows failure on purpose — a leftover scratch directory is not a test
 * result, and a cleanup that throws turns a passing suite red. That is exactly wrong when the
 * removal is the thing under test: worktree-dirty-guard removes a worktree out from under git
 * to provoke an unreadable status, and when Windows kept a handle the directory survived, git
 * read a clean worktree, and the test failed intermittently on an assertion about something
 * else entirely.
 *
 * `rmSync` THROWS on EPERM rather than returning quietly, so the first version of this helper
 * never reached its own check: the raw `EPERM, Permission denied: \\?\C:\...` escaped and the
 * message below was unreachable code. That is the failure a full-suite run produced — a bare
 * EPERM pointing at a temp path, with nothing to say it was a setup step rather than the guard
 * under test. Catch the throw, give the handle longer to clear than a single retry budget
 * allows, and only then report — naming the path, and saying whose problem it is.
 */
export function removeTempDirOrThrow(dir: string): void {
  // Two rounds: Windows releases a directory handle asynchronously after the holding process
  // exits, and a loaded machine (three Electron gates alongside the unit suite) outlasts one.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch {
      /* still held — fall through and check, then retry once */
    }
    if (!existsSync(dir)) return
  }
  throw new Error(
    `setup could not remove ${dir} — something still holds a handle; the test's precondition is unmet`
  )
}
