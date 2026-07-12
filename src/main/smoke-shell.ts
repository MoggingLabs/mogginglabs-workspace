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
 * Put a pane back at a SHELL PROMPT, and PROVE it, before a smoke types a shell command
 * into it (Phase-11).
 *
 * Every env/cwd probe in this repo works the same way: type a command, read the answer out
 * of the pane's buffer. That is only meaningful if a SHELL is the thing reading the keyboard.
 * When an agent CLI holds the pane it is not: the agent owns the keyboard and the ALTERNATE
 * screen, so the command lands in the agent's prompt and the answer the probe scrapes for
 * never exists. The gates that did this used to "work" for the worst possible reason — the
 * CLI was not installed on the machine, so the launch quietly no-opped and the shell was
 * still there. The day it got installed, they failed as "the product is broken".
 *
 * The fix is not a longer sleep. A sleep is a guess about how long a CLI takes to boot, and
 * on Windows (`.ps1` -> node) that guess loses often enough to be worthless: interrupt too
 * early and the ^C lands before the CLI installs its handler, the CLI comes up AFTER it, and
 * it swallows the probe. So: interrupt, then ROUND-TRIP a unique sentinel through the shell
 * and wait for it to come back. Retry the interrupt while it does not. We return only when a
 * shell has demonstrably executed something.
 *
 * Callers get a boolean, not an exception — a smoke asserting on the env still fails on its
 * own terms, and the flag says whether the pane ever came back, which is the first question
 * anyone debugging it will ask.
 */
export async function settleToShell(opts: {
  es: <T = unknown>(js: string) => Promise<T>
  sleep: (ms: number) => Promise<void>
  paneId: number
  tries?: number
}): Promise<boolean> {
  const { es, sleep, paneId } = opts
  const tries = opts.tries ?? 4

  const write = (data: string): Promise<unknown> =>
    es(`(window.bridge.send('terminal:write', { id: ${paneId}, data: ${JSON.stringify(data)} }), 1)`)
  const bufferText = (): Promise<string> =>
    es<string>(
      `(() => {
        const p = (window.__mogging.panes || []).find((x) => x.id === ${paneId})
        if (!p) return ''
        const b = p.term.buffer.active
        let s = ''
        for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) s += l.translateToString(true) + '\\n' }
        return s
      })()`
    )

  for (let attempt = 0; attempt < tries; attempt++) {
    // One ^C cancels the CLI's current input; the second exits it — the same interrupt the
    // app's own usage-limit failover sends before it relaunches an agent, and what a person
    // has to do. A CLI still BOOTING has not installed its handler yet and ignores both,
    // which is exactly why this is a loop and not a sequence.
    await write('\x03')
    await sleep(400)
    await write('\x03')
    await sleep(600)
    // cmd.exe's own question, and a trap for everything after it: interrupting a BATCH script
    // (every npm CLI shim on Windows is one) leaves "Terminate batch job (Y/N)?" waiting, and
    // it eats the next line typed at it — including the sentinel. Answer it only when it is
    // really there; guessing at a `Y` would type a stray command into a healthy shell.
    if (/Terminate batch job \(Y\/N\)\?/i.test(await bufferText())) {
      await write('Y\r')
      await sleep(500)
    }
    // A bare token needs no quoting in either dialect, so this one echo is honest on both.
    const token = `SHELL_READY_${attempt}_${Date.now().toString(36).toUpperCase()}`
    await write(`echo ${token}\r`)
    for (let i = 0; i < 12; i++) {
      await sleep(250)
      // The proof is the COLUMN: a shell's output starts at column 0, while the echoed command
      // line carries the prompt in front of it and an agent that swallowed the keystrokes
      // paints them inside its own frame. Only a line that IS the token means a shell ran it.
      if (new RegExp(`^${token}$`, 'm').test(await bufferText())) return true
    }
  }
  return false
}

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
