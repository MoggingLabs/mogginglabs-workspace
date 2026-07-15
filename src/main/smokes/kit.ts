import { app } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// The gate kit — the three primitives every one of the ~110 smokes hand-rolled for
// itself (result-writing, sleeping, waiting on a condition). Nothing here changes a
// gate's semantics; it removes the per-file re-invention. New gates use the kit;
// existing gates migrate opportunistically whenever they are next touched (churning
// the whole safety net in one pass is how a safety net breaks).

/** Write `out/<name>-result.json` — the verdict file qa-smokes.sh reads (its `verdict`
 *  helper trusts `pass === true` and nothing else). Pretty-printed for the human who
 *  opens it on a failure. */
export function writeResult(name: string, result: { pass: boolean } & Record<string, unknown>): void {
  const file = join(app.getAppPath(), 'out', `${name}-result.json`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(result, null, 2))
}

/** The sleep every smoke wrote inline. */
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Poll `check` until it holds or `timeoutMs` elapses. Returns whether it held —
 * callers assert on the RESULT, so a timeout is a normal false verdict, never a throw
 * (a gate's failure story belongs in its result JSON, not in an unhandled rejection).
 */
export async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs: number, stepMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return true
    if (Date.now() >= deadline) return false
    await sleep(stepMs)
  }
}
