/**
 * The ONE place smokes are allowed to speak a shell dialect (Phase-6/02).
 * Everything typed into a PANE by a smoke goes through these helpers, which emit
 * cmd.exe on win32 and POSIX sh elsewhere — the CLAIM a smoke asserts never
 * changes per platform, only the probe command that exercises it.
 */

const WIN = process.platform === 'win32'

/** Change directory (cmd needs /d to cross drives). */
function cd(dir: string): string {
  return WIN ? `cd /d "${dir}"` : `cd "${dir}"`
}

/** Join commands so each runs only if the previous succeeded. */
function chain(...parts: string[]): string {
  return parts.filter(Boolean).join(' && ')
}

/** Echo an environment variable, optionally with a literal prefix — the house
 *  probe for "did the env reach the pane" (`MARKVALUE=%V%` / `MARKVALUE=$V`). */
function echoVar(name: string, prefix = ''): string {
  return WIN ? `echo ${prefix}%${name}%` : `echo "${prefix}$${name}"`
}

/** Append a literal line to a file (creates it if missing). */
function appendLine(text: string, file: string): string {
  return WIN ? `echo ${text}>> ${file}` : `echo "${text}" >> "${file}"`
}

/** Write a literal line to a file (truncates). */
function writeLine(text: string, file: string): string {
  return WIN ? `echo ${text}> ${file}` : `echo "${text}" > "${file}"`
}

/** Ensure a (relative) directory exists, then write a line into a file inside it.
 *  `relDir`/`relFile` use forward slashes; converted per-platform. */
function mkdirWrite(relDir: string, relFile: string, text: string): string {
  if (WIN) {
    const d = relDir.replaceAll('/', '\\')
    const f = relFile.replaceAll('/', '\\')
    return `(if not exist ${d} mkdir ${d}) && echo ${text}> ${f}`
  }
  return `mkdir -p "${relDir}" && echo "${text}" > "${relFile}"`
}

/** Unset an env var in the CURRENT pane session — profile env persists in the
 *  session by design (cmd `set` / POSIX `export` parity, 6/01), so a probe that
 *  asserts "the new launch added no env" must clear the residue first. */
function unsetVar(name: string): string {
  return WIN ? `set "${name}="` : `unset ${name}`
}

/** Run `command` in `cwd` with the named env vars CLEARED for that command —
 *  the agent-launch probe (a nested agent must not inherit the outer session). */
function clearEnvRun(cwd: string, vars: string[], command: string): string {
  if (WIN) {
    const sets = vars.map((v) => `set "${v}="`).join(' & ')
    return `cd /d "${cwd}" & ${sets} & ${command}`
  }
  const clears = vars.map((v) => `${v}=`).join(' ')
  return `cd "${cwd}" && ${clears} ${command}`
}

export const sh = { cd, chain, echoVar, appendLine, writeLine, mkdirWrite, clearEnvRun, unsetVar }

/**
 * CI soft-GPU mode (Phase-6/02). `MOGGING_CI_GPU=soft` — set ONLY by CI sweep
 * jobs whose frame timing isn't the app's to control: Linux (xvfb + SwiftShader
 * raster physics) and macOS (shared-vCPU VMs with bimodal scheduling — 57fps one
 * run, 19.8fps the next on identical code, runs 28657760100/28658338954). It
 * relaxes FRAME-GAP budgets by the given factor. Desktop budgets are untouched;
 * every use prints loudly so a relaxed run can never masquerade as a real one.
 * Echo-latency/heap/correctness claims are never relaxed.
 */
export function softGapMs(desktopMs: number, factor = 4): number {
  if (process.env.MOGGING_CI_GPU !== 'soft') return desktopMs
  const relaxed = desktopMs * factor
  console.warn(
    `⚠ MOGGING_CI_GPU=soft — frame-timing budget relaxed ${desktopMs}ms -> ${relaxed}ms (software-GL CI only)`
  )
  return relaxed
}

/** Same contract for fps FLOORS (fps = 1/frame-gap — the same physical phenomenon:
 *  SwiftShader rasters a 16-pane grid at ~15-19 fps regardless of app health).
 *  Correctness and heap claims are NEVER relaxed. */
export function softFps(desktopFps: number, divisor = 3): number {
  if (process.env.MOGGING_CI_GPU !== 'soft') return desktopFps
  const relaxed = Math.round(desktopFps / divisor)
  console.warn(
    `⚠ MOGGING_CI_GPU=soft — fps floor relaxed ${desktopFps} -> ${relaxed} (software-GL CI only)`
  )
  return relaxed
}

/** Same contract for the keystroke->echo budget. Originally held strict on the
 *  theory that echo is a daemon round-trip, GPU-independent. MEASURED reality on
 *  windows-latest CI: the VIRTUALIZED PTY round-trip floors at ~85ms (samples
 *  52-91ms, median ~85 even in a low-contention 2-gate run) — while REAL Windows
 *  hardware echoes at <5ms (dev-machine local sweeps) and Linux/macOS at ~1-2ms.
 *  So the strict 60ms is systematically wrong ONLY on the CI VM — the same
 *  non-representative-VM artifact soft mode exists for. Relaxed on soft CI only,
 *  loudly; every real environment (including real Windows) keeps the strict 60ms.
 *  A genuine regression slows every environment and still fails. */
export function softEchoMs(desktopMs: number, factor = 3): number {
  if (process.env.MOGGING_CI_GPU !== 'soft') return desktopMs
  const relaxed = Math.round(desktopMs * factor)
  console.warn(
    `⚠ MOGGING_CI_GPU=soft — echo budget relaxed ${desktopMs}ms -> ${relaxed}ms (virtualized-PTY CI VM only; real hardware <5ms)`
  )
  return relaxed
}
