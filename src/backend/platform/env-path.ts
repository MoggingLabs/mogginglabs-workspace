import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/**
 * THE LIVE PATH — the fix for the app's oldest silent failure.
 *
 * A desktop process inherits ONE environment block, captured when it was launched, and
 * never learns anything again. On Windows that block comes from `explorer.exe`, itself
 * frozen at login. So the whole chain rots the moment a user installs a tool:
 *
 *   user installs Git at 21:03  ->  the app (started 20:33) still has no `C:\Program Files\Git\cmd`
 *   ->  execFile('git', …) is ENOENT  ->  `git worktree add` fails for EVERY agent
 *   ->  the wizard says "Could not isolate every agent" and nobody can tell why.
 *
 * That is not hypothetical: it is the exact failure this module was written for, measured
 * on a real install where the registry PATH carried Git and the app's PATH did not. The
 * same rot explains "I installed Claude Code and the app still says it isn't there" and
 * "the install button can't find npm" — one cause, three symptoms.
 *
 * The answer is to stop trusting the inherited snapshot as the whole truth. This module
 * reads the PATH that is true RIGHT NOW — the Windows registry (where `setx`, every
 * installer, and the System control panel actually write), or the user's login shell on
 * POSIX (where `.zshrc`/`.profile` actually write) — unions it with the well-known bin
 * directories package managers use, and merges the result into `process.env.PATH`.
 *
 * Rules this module holds to:
 *   · APPEND, never reorder. The app's own managed bin dir is prepended by cli-runtime.ts
 *     and must stay at index 0, so everything learned here lands at the END.
 *   · Only directories that EXIST are added — a PATH full of ghosts costs every spawn.
 *   · READ is cheap and always safe; WRITE (persisting to the user's environment) is a
 *     separate, explicit call. Reading is done at boot; writing happens only when a setup
 *     flow has just created a bin dir the user will want in their own terminals too.
 *   · Electron-free. `node:child_process` + `node:fs` only, like every other platform file.
 */

/** Where the authoritative entry list came from — reported so a diagnostic can say so. */
export type LivePathSource = 'registry' | 'login-shell' | 'process'

export interface LivePath {
  /** Every resolved entry, in order, de-duplicated. */
  entries: string[]
  /** Entries that were NOT already in `process.env.PATH` when this was resolved. */
  missing: string[]
  source: LivePathSource
}

/** Windows compares path entries case-insensitively; POSIX does not. */
const fold = (value: string): string =>
  process.platform === 'win32' ? value.replace(/[\\/]+$/, '').toLocaleLowerCase('en-US') : value.replace(/\/+$/, '')

export function pathEntries(value: string | undefined): string[] {
  return (value ?? '').split(delimiter).filter(Boolean)
}

/** Order-preserving de-dupe under the platform's own comparison rules. */
function dedupe(entries: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of entries) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    const key = fold(trimmed)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out
}

function isDir(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

/** What a command actually did. `ok` means it RAN and exited 0 — never "the answer is
 *  empty". `code` is the exit status, or null when the process never started (spawn
 *  failure) or was killed (our own timeout). */
export interface RunOutcome {
  ok: boolean
  code: number | null
  stdout: string
}

// Distinguishing "failed" from "empty" is the whole job of this type. Collapsing both to
// null is what let persistWindows read a timed-out `reg query` as "the user has no PATH"
// and then overwrite the real one — see the refusal in persistWindows below. The same
// rule is stated in setup.ts's capture(): an empty string from a command that failed
// means "we do not know", not "the answer is empty".
function run(file: string, args: string[], timeout = 6000): Promise<RunOutcome> {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        const out = String(stdout ?? '')
        if (!err) return resolve({ ok: true, code: 0, stdout: out })
        // execFile reports a non-zero EXIT as a numeric `code`, but a spawn failure as a
        // string errno ('ENOENT') and a timeout as a signal with no usable code at all.
        const code = typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : null
        resolve({ ok: false, code, stdout: out })
      })
    } catch {
      resolve({ ok: false, code: null, stdout: '' })
    }
  })
}

// ── Windows: the registry is where PATH actually lives ───────────────────────────────
//
// `reg query` is on every Windows install, needs no elevation to READ, and — unlike
// .NET's GetEnvironmentVariable — hands back the RAW value, so `%USERPROFILE%\bin`
// arrives unexpanded and we expand it ourselves against the live environment.

const REG_USER = ['HKCU\\Environment', '/v', 'Path']
const REG_MACHINE = ['HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', '/v', 'Path']

/** A `reg query` for one value has THREE answers, and conflating the last two is how a
 *  PATH gets destroyed:
 *    - the value, when the read succeeded and the dump held a `Path` row;
 *    - 'absent',  when the read succeeded and it did not (a fresh profile has no HKCU
 *      Path — writing a fresh one there is correct);
 *    - 'unknown', when the read itself failed (timeout, policy, EDR, spawn failure).
 *      Nothing may be written on this answer: we do not know what we would destroy. */
export type RegRead = { value: string; kind: string } | 'absent' | 'unknown'

/** Pull `Path`'s raw value + its type out of one `reg query` outcome. */
export function parseRegPath(res: RunOutcome | null): RegRead {
  if (!res) return 'unknown'
  const match = /^[ \t]*Path[ \t]+(REG_(?:EXPAND_)?SZ)[ \t]+(.*)$/im.exec(res.stdout)
  if (match) return { kind: match[1], value: match[2].replace(/\r$/, '').trim() }
  // A clean exit with no Path row means the value genuinely is not there. `reg query`
  // also exits 1 for "unable to find" — but it exits 1 for other refusals too, so that
  // code alone is not proof; the caller disambiguates by reading the KEY (see regReadUserPath).
  return res.ok ? 'absent' : 'unknown'
}

/** The value a RegRead carries, or '' for both no-value answers — for the read-only
 *  paths where an unknown and an absent PATH lead to the same fallback anyway. */
const regValue = (r: RegRead): string => (typeof r === 'string' ? '' : r.value)

/** Expand `%NAME%` against the live environment (case-insensitive, like Windows). */
export function expandWindowsVars(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/%([^%\r\n]+)%/g, (whole, name: string) => {
    const wanted = name.toLocaleUpperCase('en-US')
    for (const key of Object.keys(env)) {
      if (key.toLocaleUpperCase('en-US') === wanted) return env[key] ?? whole
    }
    return whole // an unknown variable stays literal rather than collapsing to ''
  })
}

async function windowsRegistryPath(): Promise<string[] | null> {
  const [machine, user] = await Promise.all([run('reg', ['query', ...REG_MACHINE]), run('reg', ['query', ...REG_USER])])
  const parsedMachine = parseRegPath(machine)
  const parsedUser = parseRegPath(user)
  // This path is READ-only, so an unknown and an absent value both degrade the same way
  // (to process PATH plus the well-known dirs) — the distinction only binds on the write.
  if (typeof parsedMachine === 'string' && typeof parsedUser === 'string') return null
  // Windows composes the effective PATH as system-then-user; keep that order so a user
  // override of a system tool keeps losing here exactly as it does in a real console.
  return dedupe([
    ...pathEntries(expandWindowsVars(regValue(parsedMachine))),
    ...pathEntries(expandWindowsVars(regValue(parsedUser)))
  ])
}

// ── POSIX: the login shell is where PATH actually lives ──────────────────────────────
//
// A GUI app on macOS is launched by `launchd`, which never sources a shell profile — so
// Homebrew, nvm, pyenv and every `~/.local/bin` install are invisible to it. Asking the
// user's own login shell is the only honest answer. Delimiters fence the value off from
// whatever the rc files print on the way (banners, direnv, fortune).

const FENCE = '__MOGGING_PATH__'

async function loginShellPath(): Promise<string[] | null> {
  const shell = process.env.SHELL
  if (!shell) return null
  // `-l` loads the profile (the whole point); `-i` is deliberately NOT passed — an
  // interactive shell can block on a prompt and some rc files refuse to run headless.
  const out = await run(shell, ['-lc', `printf '%s' "${FENCE}$PATH${FENCE}"`], 8000)
  // The fence is the real check — a shell that printed the pair told us the truth even
  // if some rc file on the way exited non-zero. Read-only, so a miss just degrades.
  const match = out.stdout ? new RegExp(`${FENCE}([^]*?)${FENCE}`).exec(out.stdout) : null
  if (!match) return null
  const entries = dedupe(pathEntries(match[1]))
  return entries.length ? entries : null
}

// ── The well-known bin directories, per platform ─────────────────────────────────────
//
// Belt and braces for the case the authoritative source cannot cover: an installer that
// wrote its PATH entry into a session the registry has not caught up with, a tool the
// user installed under a manager whose shim dir is only exported by an rc file we did
// not reach. Every candidate is filtered by existence, so this never invents entries.

export function wellKnownBinDirs(home = homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates: string[] = []
  if (process.platform === 'win32') {
    const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
    const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming')
    const localAppData = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    candidates.push(
      join(appData, 'npm'), // npm's default global prefix — where `claude` lands
      join(programFiles, 'nodejs'),
      join(programFiles, 'Git', 'cmd'),
      join(programFilesX86, 'Git', 'cmd'),
      join(localAppData, 'Programs', 'Git', 'cmd'), // Git for Windows, user-scope install
      join(programFiles, 'GitHub CLI'),
      join(localAppData, 'pnpm'),
      join(localAppData, 'Microsoft', 'WindowsApps'),
      join(home, '.bun', 'bin'),
      join(home, '.cargo', 'bin'),
      join(home, '.local', 'bin'),
      join(home, 'scoop', 'shims'),
      join(localAppData, 'Programs', 'Python', 'Launcher')
    )
  } else {
    candidates.push(
      '/opt/homebrew/bin', // Apple silicon Homebrew — never on a GUI app's default PATH
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      '/usr/local/sbin',
      '/snap/bin',
      join(home, '.local', 'bin'),
      join(home, '.npm-global', 'bin'),
      join(home, '.bun', 'bin'),
      join(home, '.cargo', 'bin'),
      join(home, '.deno', 'bin'),
      join(home, 'Library', 'pnpm'),
      join(home, 'go', 'bin')
    )
  }
  return dedupe(candidates).filter(isDir)
}

// ── Resolution ───────────────────────────────────────────────────────────────────────

let cached: LivePath | null = null
let inFlight: Promise<LivePath> | null = null

/** The PATH as it is RIGHT NOW, unioned with the process's own. Cached; call `refreshLivePath`
 *  to re-read after something has been installed. */
export function resolveLivePath(): Promise<LivePath> {
  if (cached) return Promise.resolve(cached)
  return refreshLivePath()
}

/** Re-read the authoritative PATH from scratch. Never throws: a failed read degrades to the
 *  process PATH plus whichever well-known directories exist, which is still strictly better
 *  than the snapshot alone. */
export function refreshLivePath(): Promise<LivePath> {
  inFlight ??= (async () => {
    const current = pathEntries(process.env.PATH)
    let authoritative: string[] | null = null
    let source: LivePathSource = 'process'
    try {
      authoritative = process.platform === 'win32' ? await windowsRegistryPath() : await loginShellPath()
      if (authoritative?.length) source = process.platform === 'win32' ? 'registry' : 'login-shell'
    } catch {
      authoritative = null
    }
    // The process's own entries come FIRST and keep their order: the app's managed bin dir
    // lives at index 0 and everything downstream (MOGGING_CLI, the mogging shim) depends on
    // it staying there. Everything learned is additive.
    const entries = dedupe([...current, ...(authoritative ?? []), ...wellKnownBinDirs()])
    const known = new Set(current.map(fold))
    const resolved: LivePath = { entries, missing: entries.filter((e) => !known.has(fold(e))), source }
    cached = resolved
    inFlight = null
    return resolved
  })()
  return inFlight
}

/**
 * Merge the live PATH into `process.env.PATH` (and make sure Windows can still resolve
 * `.CMD` shims, which is how every npm-installed CLI presents itself).
 *
 * Everything the app spawns from here on — `git`, an install shell, the PTY daemon, every
 * pane — inherits the result. Returns the entries that were actually new, so a caller can
 * tell the user what changed without re-deriving it.
 */
export async function applyLivePathToProcess(): Promise<string[]> {
  const live = await refreshLivePath()
  if (live.missing.length) process.env.PATH = live.entries.join(delimiter)
  if (process.platform === 'win32') {
    const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    for (const needed of ['.EXE', '.CMD', '.BAT']) {
      if (!exts.some((ext) => ext.toLocaleUpperCase('en-US') === needed)) exts.push(needed)
    }
    process.env.PATHEXT = exts.join(';')
  }
  return live.missing
}

/** Put `dir` on this process's PATH immediately (used the moment a setup step creates one).
 *  Appended, so the app's managed bin dir keeps index 0. Returns false when it was already there. */
export function addToProcessPath(dir: string): boolean {
  const current = pathEntries(process.env.PATH)
  if (current.some((entry) => fold(entry) === fold(dir))) return false
  process.env.PATH = [...current, dir].join(delimiter)
  cached = null // the cached union is stale the instant the process PATH moves
  return true
}

/**
 * Merge environment overlays so an overlay key REPLACES any case-variant of itself.
 *
 * Windows environment variables are case-INSENSITIVE, but a spread of `process.env` is a
 * plain object with whatever casing the OS stored (`Path`). Layering `{ PATH: … }` on top
 * of that produces an env block carrying BOTH `Path` and `PATH`, and which one the child
 * process ends up honouring is not defined anywhere. A PATH repair that lands in the loser
 * is worse than none — it looks applied and changes nothing.
 */
export function mergeEnv(
  base: NodeJS.ProcessEnv,
  ...overlays: (Record<string, string | undefined> | undefined)[]
): NodeJS.ProcessEnv {
  return mergeEnvFolding(process.platform === 'win32', base, ...overlays)
}

/** mergeEnv with the case-folding decision made by the CALLER rather than read from the
 *  ambient platform — the same treatment wellKnownBinDirs and resolveOnPath already give
 *  `home` and `env`. Windows-only behavior that cannot be driven from a test is behavior
 *  no non-Windows runner can defend, and this fold is exactly that: the bug it prevents
 *  (an inherited `Path` stacked beside a repaired `PATH`) is invisible on macOS and Linux. */
export function mergeEnvFolding(
  foldCase: boolean,
  base: NodeJS.ProcessEnv,
  ...overlays: (Record<string, string | undefined> | undefined)[]
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base }
  const insensitive = foldCase
  for (const overlay of overlays) {
    if (!overlay) continue
    for (const [key, value] of Object.entries(overlay)) {
      if (insensitive) {
        const wanted = key.toLocaleUpperCase('en-US')
        for (const existing of Object.keys(out)) {
          if (existing !== key && existing.toLocaleUpperCase('en-US') === wanted) delete out[existing]
        }
      }
      out[key] = value
    }
  }
  return out
}

/**
 * Where `bin` resolves on the CURRENT process PATH, or null. The absolute answer — not a
 * boolean — because a setup flow has to be able to say "npm is at C:\Program Files\nodejs\npm.cmd"
 * and because a caller that spawns the resolved path cannot be defeated by a later PATH edit.
 *
 * Deliberately a filesystem scan, not `where`/`which`: no subprocess, no shell, and it answers
 * the same question `execFile` will ask a moment later.
 */
export function resolveOnPath(bin: string, env: NodeJS.ProcessEnv = process.env): string | null {
  // PATHEXT FIRST on Windows, the bare name last. npm ships BOTH `npm` (a bash script, which
  // CreateProcess cannot run) and `npm.cmd` (which it can) in the same directory — and so does
  // every npm-installed CLI, `claude` included. Answering with the extensionless twin produces
  // a path that exists, passes every check, and fails at spawn with a spectacularly unhelpful
  // "%1 is not a valid Win32 application".
  const exts =
    process.platform === 'win32' ? [...(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean), ''] : ['']
  for (const dir of pathEntries(env.PATH)) {
    for (const ext of exts) {
      const candidate = join(dir, bin + ext)
      try {
        if (!statSync(candidate).isFile()) continue
        return candidate
      } catch {
        /* missing or unreadable — keep looking */
      }
    }
  }
  return null
}

// ── Persisting to the user's own environment ─────────────────────────────────────────

export interface PersistPathResult {
  ok: boolean
  /** Entries that were actually written (absent ones only — this never rewrites the rest). */
  added: string[]
  /** Where they were written, for the "we changed this" line in the UI. */
  target?: string
  error?: string
}

/** `reg add /d` takes the value on a command line: a trailing backslash would escape the
 *  closing quote Node adds, and an embedded quote cannot be represented at all. */
function safeForRegAdd(value: string): string | null {
  if (value.includes('"')) return null
  return value.replace(/\\+$/, '')
}

/** Broadcast WM_SETTINGCHANGE so already-running apps (Explorer, and therefore every app
 *  launched from it afterwards) pick the new PATH up without a sign-out. Best effort by
 *  design — the value is already persisted whether or not anyone is listening. */
async function broadcastEnvironmentChange(): Promise<void> {
  const script = [
    "Add-Type -Namespace MoggingWin32 -Name Env -MemberDefinition '[DllImport(\"user32.dll\", SetLastError=true, CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'",
    '$result = [UIntPtr]::Zero',
    "[void][MoggingWin32.Env]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)"
  ].join('\n')
  await run('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], 10_000)
}

/** Append entries to the USER's persisted PATH (HKCU on Windows, the login shell's rc on
 *  POSIX). Only ever appends what is missing; the existing value is never rewritten or
 *  reordered, and the raw registry type (REG_EXPAND_SZ) is preserved so `%USERPROFILE%`
 *  style entries survive. */
export async function persistUserPathEntries(dirs: readonly string[]): Promise<PersistPathResult> {
  const wanted = dedupe(dirs).filter(isDir)
  if (!wanted.length) return { ok: true, added: [] }
  return process.platform === 'win32' ? persistWindows(wanted) : persistPosix(wanted)
}

/** Read HKCU's `Path`, and when it reads as absent PROVE the absence before anyone acts
 *  on it. `reg query` exits 1 both for "that value is not there" and for refusals we must
 *  never mistake for it, so an absent answer is confirmed by reading the KEY: if the key
 *  itself is readable, the value really is missing; if it is not, we know nothing. */
async function regReadUserPath(): Promise<RegRead> {
  const first = parseRegPath(await run('reg', ['query', ...REG_USER]))
  if (first !== 'absent') return first
  const key = await run('reg', ['query', 'HKCU\\Environment'])
  return key.ok ? 'absent' : 'unknown'
}

/** What persistWindows should do, decided from the two reads alone. Pure, so the one
 *  property that matters — a read we could not perform NEVER becomes a write — is
 *  provable without spawning reg.exe. */
export type WindowsPathPlan =
  | { action: 'refuse'; error: string }
  | { action: 'noop'; added: readonly string[] }
  | { action: 'write'; value: string; kind: string; added: readonly string[] }

export function planWindowsPathWrite(existing: RegRead, machine: RegRead, wanted: readonly string[]): WindowsPathPlan {
  // THE refusal. `reg add ... /f` overwrites, so acting on a read we could not perform
  // would replace the user's whole persisted PATH with just our new dirs — and then
  // broadcast it to every process that starts afterwards. There is no undo. A failed
  // read is not an empty PATH; when we do not know, we do not write.
  if (existing === 'unknown') {
    return {
      action: 'refuse',
      error: 'Windows would not report your current PATH, so it was left untouched. The folder still works inside this app.'
    }
  }
  // A machine entry already covers it — appending a duplicate to the user value would
  // only make every future PATH longer for no gain. (An unreadable MACHINE value is safe
  // to treat as empty: it only ever adds a dir we did not strictly need.)
  const covered = new Set(
    [...pathEntries(expandWindowsVars(regValue(existing))), ...pathEntries(expandWindowsVars(regValue(machine)))].map(fold)
  )
  const added = wanted.filter((dir) => !covered.has(fold(dir)))
  if (!added.length) return { action: 'noop', added: [] }

  const raw = regValue(existing) // '' only when the value is PROVEN absent — a real fresh write
  const value = safeForRegAdd([...(raw ? [raw.replace(/;+$/, '')] : []), ...added].join(';'))
  if (value === null) {
    return {
      action: 'refuse',
      error: 'Your PATH contains a quote character, so it cannot be updated safely. Add the folder by hand in System › Environment Variables.'
    }
  }
  return { action: 'write', value, kind: existing === 'absent' ? 'REG_EXPAND_SZ' : existing.kind, added }
}

async function persistWindows(wanted: readonly string[]): Promise<PersistPathResult> {
  const existing = await regReadUserPath()
  const machine = parseRegPath(await run('reg', ['query', ...REG_MACHINE]))
  const plan = planWindowsPathWrite(existing, machine, wanted)
  if (plan.action === 'refuse') return { ok: false, added: [], error: plan.error }
  if (plan.action === 'noop') return { ok: true, added: [], target: 'HKCU\\Environment\\Path' }

  const wrote = await run('reg', ['add', 'HKCU\\Environment', '/v', 'Path', '/t', plan.kind, '/d', plan.value, '/f'], 10_000)
  if (!wrote.ok) {
    return { ok: false, added: [], error: 'Windows refused the environment update. The folder still works inside this app.' }
  }
  await broadcastEnvironmentChange()
  return { ok: true, added: [...plan.added], target: 'HKCU\\Environment\\Path' }
}

/** The rc file a login shell of this flavour actually reads. */
export function loginRcFile(shell: string | undefined, home = homedir()): { file: string; flavour: 'posix' | 'fish' } {
  const name = (shell ?? '').split('/').pop() ?? ''
  if (name === 'fish') return { file: join(home, '.config', 'fish', 'conf.d', 'mogginglabs.fish'), flavour: 'fish' }
  if (name === 'zsh') return { file: join(home, '.zshrc'), flavour: 'posix' }
  // bash reads .bash_profile for LOGIN shells on macOS and .bashrc on most Linux desktops;
  // .profile is read by both when the shell-specific file is absent, so it is the safe floor.
  if (name === 'bash') return { file: join(home, process.platform === 'darwin' ? '.bash_profile' : '.bashrc'), flavour: 'posix' }
  return { file: join(home, '.profile'), flavour: 'posix' }
}

const BLOCK_OPEN = '# >>> MoggingLabs Workspace PATH >>>'
const BLOCK_CLOSE = '# <<< MoggingLabs Workspace PATH <<<'

/** The managed block, rebuilt whole each time — so this is idempotent no matter how often
 *  a setup runs, and a user who deletes the block gets it back rather than a second copy. */
export function rcBlock(dirs: readonly string[], flavour: 'posix' | 'fish'): string {
  const lines = dirs.map((dir) =>
    flavour === 'fish' ? `fish_add_path -g ${JSON.stringify(dir)}` : `export PATH=${JSON.stringify(dir)}:"$PATH"`
  )
  return [BLOCK_OPEN, '# Added so the CLIs this app installed are on your PATH. Safe to delete.', ...lines, BLOCK_CLOSE].join('\n')
}

async function persistPosix(wanted: readonly string[]): Promise<PersistPathResult> {
  const { file, flavour } = loginRcFile(process.env.SHELL)
  const { mkdirSync, readFileSync, writeFileSync } = await import('node:fs')
  const { dirname } = await import('node:path')
  try {
    mkdirSync(dirname(file), { recursive: true })
    let body = ''
    try {
      body = readFileSync(file, 'utf8')
    } catch {
      /* first write — the file is ours to create */
    }
    const block = rcBlock(wanted, flavour)
    const start = body.indexOf(BLOCK_OPEN)
    const end = body.indexOf(BLOCK_CLOSE)
    const next =
      start >= 0 && end > start
        ? body.slice(0, start) + block + body.slice(end + BLOCK_CLOSE.length)
        : `${body.replace(/\n*$/, '')}\n\n${block}\n`
    if (next !== body) writeFileSync(file, next, 'utf8')
    return { ok: true, added: [...wanted], target: file }
  } catch (err) {
    return { ok: false, added: [], error: err instanceof Error ? err.message : String(err) }
  }
}
