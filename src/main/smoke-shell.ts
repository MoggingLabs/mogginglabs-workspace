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

export const sh = { cd, chain, echoVar, appendLine, writeLine, mkdirWrite, clearEnvRun }

/**
 * CI software-GL mode (Phase-6/02). `MOGGING_CI_GPU=soft` — set ONLY by the Linux
 * CI sweep (xvfb + SwiftShader) — relaxes FRAME-GAP budgets by the given factor.
 * Desktop budgets are untouched; every use prints loudly so a relaxed run can
 * never masquerade as a real one. Latency/fps/heap claims are never relaxed.
 */
export function softGapMs(desktopMs: number, factor = 4): number {
  if (process.env.MOGGING_CI_GPU !== 'soft') return desktopMs
  const relaxed = desktopMs * factor
  console.warn(
    `⚠ MOGGING_CI_GPU=soft — frame-gap budget relaxed ${desktopMs}ms -> ${relaxed}ms (software-GL CI only)`
  )
  return relaxed
}
