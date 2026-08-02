import { mkdtempSync, rmSync } from 'node:fs'
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
