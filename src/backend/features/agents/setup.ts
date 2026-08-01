import { spawn } from 'node:child_process'
import { accessSync, constants, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentCliId,
  AgentSetupState,
  AgentSetupStart,
  AgentSetupStep,
  AgentSetupStepId
} from '@contracts'
import { addToProcessPath, applyLivePathToProcess, persistUserPathEntries, resolveOnPath } from '../../platform/env-path'
import { spawnTool } from '../../platform/spawn-tool'
import { getTelemetry } from '../../core/telemetry'
import { findAgentCliDefinition, type AgentInstallStep } from '../../core/agent-clis'
import { isOnPath } from './detect'

/**
 * ONE-CLICK SETUP — the guided install that survives a machine that is not ready.
 *
 * This exists because the honest one-liner ("run `npm install -g …` in a terminal") is not
 * one step, it is four, and each of them fails in a way that reads as a bug in this app:
 *
 *   1. npm is missing            -> "'npm' is not recognized" and the user is stuck.
 *   2. Node's installer edits PATH -> the RUNNING app cannot see it, so the CLI it just
 *                                   installed still reads as missing. (env-path.ts.)
 *   3. `npm i -g` wants a prefix the user cannot write -> EACCES, and every answer on the
 *                                   internet says `sudo`, which is the wrong answer.
 *   4. Installed and on PATH — but the app's own PATH snapshot predates it, so detection
 *                                   still says no and the wizard still shows "not on PATH".
 *
 * Each becomes a STEP with a verdict and, on failure, a remedy in the user's own terms.
 *
 * Design choices worth stating:
 *   · argv arrays, never a shell string. No quoting surface, real exit codes, and the
 *     runtime is resolved to an absolute path before it is spawned (`npm.cmd`, not `npm`).
 *     `installHint` remains the prose a human copies; `installSpec` is what runs.
 *   · Every command's output is captured into one transcript. It stays LOCAL (ADR 0005) —
 *     telemetry gets a boolean and a duration, never a line of it.
 *   · The verdict is a RE-DETECT, not an exit code. `installed` has exactly one meaning in
 *     this app — resolvable on PATH — so the tab, the wizard and this service can never
 *     disagree about what happened.
 *   · It installs and stops. Signing in needs a terminal the user can see, which does not
 *     exist yet (ADR 0002).
 */

/** Enough transcript to diagnose a failed install; bounded so a chatty installer cannot
 *  turn progress pushes into a firehose. */
const TAIL_MAX = 24_000
/** A package manager pulling a toolchain over a bad connection is slow, not stuck. */
const STEP_TIMEOUT_MS = 15 * 60_000
/** Trailing throttle on progress pushes. */
const PUSH_EVERY_MS = 150

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]/g

interface RunResult {
  ok: boolean
  code: number | null
  /** True when nothing could be spawned at all — the binary was not there. */
  missing: boolean
  timedOut: boolean
}

/** The plan, in the order it runs. Labels are the user-facing names of these steps. */
const STEP_LABELS: Record<AgentSetupStepId, string> = {
  probe: 'Check what’s already installed',
  runtime: 'Install the runtime it needs',
  permissions: 'Set up a folder you can write to',
  path: 'Make it visible to this app',
  install: 'Install the agent',
  verify: 'Verify it runs'
}

export class SetupService {
  private readonly live = new Set<AgentCliId>()
  private readonly states = new Map<AgentCliId, AgentSetupState>()
  private readonly cancelled = new Set<AgentCliId>()
  private pushTimers = new Map<AgentCliId, ReturnType<typeof setTimeout>>()
  private children = new Map<AgentCliId, ReturnType<typeof spawn>>()

  constructor(private readonly push: (state: AgentSetupState) => void) {}

  snapshot(): AgentSetupState[] {
    return [...this.states.values()].map((state) => ({ ...state, steps: state.steps.map((s) => ({ ...s })) }))
  }

  start(rawId: string): AgentSetupStart {
    const agentId = rawId as AgentCliId
    const definition = findAgentCliDefinition(agentId)
    if (!definition) return { ok: false, reason: `Unknown provider “${rawId}”.` }
    if (!definition.installSpec) return { ok: false, reason: `${definition.name} has no automatic install.` }
    if (this.live.has(agentId)) return { ok: false, reason: `${definition.name} is already being set up.` }
    if (isOnPath(definition.bin)) return { ok: false, reason: `${definition.name} is already installed.` }

    this.live.add(agentId)
    this.cancelled.delete(agentId)
    const state: AgentSetupState = {
      agentId,
      phase: 'running',
      steps: (Object.keys(STEP_LABELS) as AgentSetupStepId[]).map((id) => ({ id, label: STEP_LABELS[id], phase: 'pending' })),
      tail: '',
      startedAt: Date.now()
    }
    this.states.set(agentId, state)
    this.push({ ...state })
    void this.run(agentId, state)
    return { ok: true }
  }

  /** App quitting, or the user backing out: nothing this service started may outlive it. */
  cancel(rawId?: string): void {
    const ids = rawId ? [rawId as AgentCliId] : [...this.live]
    for (const id of ids) {
      this.cancelled.add(id)
      this.children.get(id)?.kill()
    }
  }

  dispose(): void {
    this.cancel()
    for (const timer of this.pushTimers.values()) clearTimeout(timer)
    this.pushTimers.clear()
    this.children.clear()
    this.live.clear()
  }

  // ── The plan ───────────────────────────────────────────────────────────────

  private async run(agentId: AgentCliId, state: AgentSetupState): Promise<void> {
    const definition = findAgentCliDefinition(agentId)!
    const spec = definition.installSpec!
    try {
      // ① PROBE. Repair PATH first, because the commonest "nothing is installed" is really
      //    "this process cannot see what is installed" — and finding that out here can end
      //    the whole run in a second with nothing downloaded.
      this.begin(state, 'probe')
      const repaired = await applyLivePathToProcess()
      if (repaired.length) this.appendTail(state, `[path] the app's launch environment was stale; added ${repaired.join(', ')}\n`)
      if (isOnPath(definition.bin)) {
        this.finishStep(state, 'probe', 'done', `${definition.name} was already here — this app just could not see it.`)
        for (const id of ['runtime', 'permissions', 'path', 'install'] as AgentSetupStepId[]) {
          this.finishStep(state, id, 'skipped', 'Not needed.')
        }
        return this.verify(agentId, state, definition.bin, definition.name)
      }
      const runtimeBin = spec.requires === 'node' ? 'npm' : 'python'
      const runtimePresent = !!this.resolveRuntime(spec.requires)
      this.finishStep(
        state,
        'probe',
        'done',
        runtimePresent ? `${runtimeBin} is available — ready to install.` : `${runtimeBin} is missing; it will be installed first.`
      )

      // ② RUNTIME. The OS package manager first (a real, updatable, system-wide install);
      //    if it is not there, say so in words the user can act on rather than failing mute.
      if (runtimePresent) {
        this.finishStep(state, 'runtime', 'skipped', `Already installed.`)
      } else if (!(await this.installRuntime(agentId, state, spec.requires))) {
        return this.fail(state, agentId)
      }

      // ③ PERMISSIONS. `npm i -g` into a directory the user cannot write is THE classic
      //    first-install wall, and the popular fix (sudo) leaves root-owned files that break
      //    every later install. Point the global prefix at the user's own home instead.
      if (spec.requires === 'node') {
        if (!(await this.ensureWritableNpmPrefix(agentId, state))) return this.fail(state, agentId)
      } else {
        this.finishStep(state, 'permissions', 'skipped', 'pip installs into your user site by default.')
      }

      // ④ PATH. Whatever ②/③ created has to be visible — to this process (so the install
      //    below can run and detection can see the result) AND persisted, so the user's own
      //    terminals agree with the app instead of contradicting it.
      await this.repairPath(state)

      // ⑤ INSTALL — the provider's own command, as argv.
      this.begin(state, 'install')
      for (const step of spec.steps) {
        const file = this.resolveStepFile(step)
        if (!file) {
          this.finishStep(
            state,
            'install',
            'failed',
            `Could not find “${step.file}”.`,
            `${step.file} should have been installed a moment ago. Close and reopen the app so it picks up the new install, then try again.`
          )
          return this.fail(state, agentId)
        }
        const result = await this.exec(agentId, state, file, [...step.args])
        if (this.cancelled.has(agentId)) return this.fail(state, agentId, 'Cancelled.')
        if (!result.ok) {
          this.finishStep(state, 'install', 'failed', this.describeExit(step, result), this.installRemedy(result))
          return this.fail(state, agentId)
        }
      }
      this.finishStep(state, 'install', 'done', definition.installHint ?? 'Installed.')

      await this.verify(agentId, state, definition.bin, definition.name)
    } catch (err) {
      this.appendTail(state, `\n[error] ${err instanceof Error ? err.message : String(err)}\n`)
      this.fail(state, agentId)
    } finally {
      this.live.delete(agentId)
      this.children.delete(agentId)
    }
  }

  /** The last word: does the bin RUN? PATH presence is the app's definition of installed,
   *  so it is checked the same way detection checks it — and then actually executed, because
   *  a file on PATH that cannot start is not an install anyone can use. */
  private async verify(agentId: AgentCliId, state: AgentSetupState, bin: string, name: string): Promise<void> {
    this.begin(state, 'verify')
    await applyLivePathToProcess()
    const resolved = resolveOnPath(bin)
    if (!resolved) {
      this.finishStep(
        state,
        'verify',
        'failed',
        `The install finished, but “${bin}” still isn’t on your PATH.`,
        'Restart the app — a fresh launch picks up PATH changes some installers only apply at sign-in.'
      )
      return this.fail(state, agentId)
    }
    const ran = await this.exec(agentId, state, resolved, ['--version'], 60_000)
    if (!ran.ok && ran.missing) {
      this.finishStep(state, 'verify', 'failed', `${name} is installed but could not be started.`, 'Restart the app and try launching it again.')
      return this.fail(state, agentId)
    }
    // A non-zero `--version` is not a failed install: some CLIs exit non-zero when they
    // have no config yet. It resolved and it started; that is the claim being made.
    this.finishStep(state, 'verify', 'done', `${name} is ready. Sign in from its terminal when it opens.`)
    this.settle(state, agentId, 'succeeded')
  }

  // ── Steps ──────────────────────────────────────────────────────────────────

  /**
   * Windows ships an "App Execution Alias" for python: a ZERO-BYTE reparse point in
   * `WindowsApps` that exists, resolves on PATH, and does nothing but open the Microsoft
   * Store. Treating it as an install is worse than finding nothing — the runtime step would
   * be skipped as satisfied, and the install step would then fail with a Store popup and an
   * exit code nobody can act on. A real interpreter is not zero bytes.
   */
  private usableRuntime(path: string | null): string | null {
    if (!path || process.platform !== 'win32') return path
    try {
      return statSync(path).size > 0 ? path : null
    } catch {
      return null
    }
  }

  private resolvePython(): string | null {
    return this.usableRuntime(resolveOnPath('python3')) ?? this.usableRuntime(resolveOnPath('python'))
  }

  private resolveRuntime(requires: 'node' | 'python'): string | null {
    return requires === 'node' ? resolveOnPath('npm') : this.resolvePython()
  }

  private resolveStepFile(step: AgentInstallStep): string | null {
    if (step.file === 'npm') return resolveOnPath('npm')
    if (step.file === 'python') return this.resolvePython()
    return resolveOnPath(step.file)
  }

  /**
   * Install Node (or Python) through the OS package manager.
   *
   * winget/brew are chosen deliberately over downloading an installer ourselves: the result
   * is a normal, updatable, system-wide install the user already knows how to manage, and
   * nothing about it is this app's private business. It costs a UAC prompt on Windows, which
   * is the honest price of writing to Program Files and is the user's to accept or decline.
   */
  private async installRuntime(agentId: AgentCliId, state: AgentSetupState, requires: 'node' | 'python'): Promise<boolean> {
    this.begin(state, 'runtime')
    const manual =
      requires === 'node'
        ? 'Install Node.js from nodejs.org (the LTS build), then click Retry.'
        : 'Install Python 3 from python.org, then click Retry.'

    if (process.platform === 'win32') {
      const winget = resolveOnPath('winget')
      if (!winget) {
        this.finishStep(state, 'runtime', 'failed', 'Windows Package Manager (winget) isn’t available on this PC.', manual)
        return false
      }
      const id = requires === 'node' ? 'OpenJS.NodeJS.LTS' : 'Python.Python.3.12'
      this.appendTail(state, `\n[runtime] winget install ${id} — Windows will ask for permission.\n`)
      const result = await this.exec(agentId, state, winget, [
        'install',
        '--id',
        id,
        '-e',
        '--accept-source-agreements',
        '--accept-package-agreements',
        '--disable-interactivity'
      ])
      if (!result.ok) {
        this.finishStep(
          state,
          'runtime',
          'failed',
          result.code === 1602 ? 'The permission prompt was dismissed.' : `winget could not install ${id}.`,
          result.code === 1602 ? 'Click Retry and choose Yes when Windows asks for permission.' : manual
        )
        return false
      }
    } else if (process.platform === 'darwin') {
      const brew = resolveOnPath('brew')
      if (!brew) {
        this.finishStep(
          state,
          'runtime',
          'failed',
          'Homebrew isn’t installed.',
          requires === 'node'
            ? 'Install Node.js from nodejs.org (the LTS build), then click Retry.'
            : 'macOS ships Python 3 with the Xcode Command Line Tools — run `xcode-select --install`, then click Retry.'
        )
        return false
      }
      const result = await this.exec(agentId, state, brew, ['install', requires === 'node' ? 'node' : 'python'])
      if (!result.ok) {
        this.finishStep(state, 'runtime', 'failed', 'Homebrew could not install it.', manual)
        return false
      }
    } else {
      // Linux package managers need sudo, and this app will not ask for a password or run
      // an elevated command it cannot show you. Naming the exact one-liner is more useful
      // and more honest than half-attempting it.
      this.finishStep(
        state,
        'runtime',
        'failed',
        'This needs your package manager, which requires sudo.',
        requires === 'node'
          ? 'Run `sudo apt install nodejs npm` (or your distro’s equivalent), then click Retry.'
          : 'Run `sudo apt install python3 python3-pip` (or your distro’s equivalent), then click Retry.'
      )
      return false
    }

    // A fresh install put its bin dir on the SYSTEM PATH, which this process still cannot
    // see — the exact rot this whole feature exists to fix. Re-read before believing it.
    await applyLivePathToProcess()
    if (!this.resolveRuntime(requires)) {
      this.finishStep(
        state,
        'runtime',
        'failed',
        'It installed, but this app still can’t reach it.',
        'Restart the app — a fresh launch always picks up a new install.'
      )
      return false
    }
    this.finishStep(state, 'runtime', 'done', requires === 'node' ? 'Node.js is installed.' : 'Python is installed.')
    return true
  }

  /**
   * Make sure `npm install -g` lands somewhere the user owns.
   *
   * Windows already defaults to `%APPDATA%\npm`, which needs no admin — so on Windows this
   * almost always confirms and moves on. macOS and Linux default to `/usr/local`, which a
   * normal account cannot write; that is the EACCES every first-time installer meets, and
   * `sudo npm i -g` "fixes" it by leaving root-owned files that break the NEXT install too.
   * Repointing the prefix at the home directory fixes it once, without privileges.
   */
  private async ensureWritableNpmPrefix(agentId: AgentCliId, state: AgentSetupState): Promise<boolean> {
    this.begin(state, 'permissions')
    const npm = resolveOnPath('npm')
    if (!npm) {
      this.finishStep(state, 'permissions', 'failed', 'npm could not be found.', 'Restart the app and try again.')
      return false
    }
    const probe = await this.capture(npm, ['prefix', '-g'])
    if (!probe.ok || !probe.out.trim()) {
      // We could not READ npm's configuration. Rewriting it from that position would be a
      // guess dressed as a fix — and this is exactly where one shipped: the probe failed,
      // answered '', and this step concluded the global folder was unwritable and moved
      // it. Leave npm's own default alone; if it genuinely cannot be written, the install
      // below fails with npm's real message, which is worth more than our guess.
      this.finishStep(state, 'permissions', 'skipped', 'Left npm’s own settings alone.')
      return true
    }
    const prefix = probe.out.trim()
    const binDir = process.platform === 'win32' ? prefix : join(prefix, 'bin')
    if (this.writable(binDir)) {
      this.finishStep(state, 'permissions', 'skipped', `Global installs already go somewhere you own (${binDir}).`)
      this.rememberBinDir(state, binDir)
      return true
    }

    const owned = join(homedir(), '.npm-global')
    try {
      mkdirSync(join(owned, 'bin'), { recursive: true })
    } catch (err) {
      this.finishStep(
        state,
        'permissions',
        'failed',
        `Could not create ${owned}.`,
        'Check that your home folder is writable, then click Retry.'
      )
      this.appendTail(state, `[permissions] ${err instanceof Error ? err.message : String(err)}\n`)
      return false
    }
    const set = await this.exec(agentId, state, npm, ['config', 'set', 'prefix', owned])
    if (!set.ok) {
      this.finishStep(
        state,
        'permissions',
        'failed',
        'npm refused to change where global packages go.',
        `Run \`npm config set prefix "${owned}"\` in a terminal, then click Retry.`
      )
      return false
    }
    this.finishStep(state, 'permissions', 'done', `Global installs now go to ${owned} — no administrator password needed.`)
    this.rememberBinDir(state, process.platform === 'win32' ? owned : join(owned, 'bin'))
    return true
  }

  /** Bin directories this run created, to be put on PATH by the `path` step. */
  private readonly createdBinDirs = new Map<AgentCliId, string[]>()

  private rememberBinDir(state: AgentSetupState, dir: string): void {
    const list = this.createdBinDirs.get(state.agentId) ?? []
    if (!list.includes(dir)) list.push(dir)
    this.createdBinDirs.set(state.agentId, list)
  }

  /**
   * PATH, in both places it has to be true.
   *
   * In THIS process, immediately — otherwise the install step below cannot run what the
   * steps above just installed, and detection afterwards would report a lie. And in the
   * user's own persisted environment, so their terminals agree with the app: a CLI that
   * works inside this window and nowhere else is a worse outcome than not installing it.
   */
  private async repairPath(state: AgentSetupState): Promise<void> {
    this.begin(state, 'path')
    const created = this.createdBinDirs.get(state.agentId) ?? []
    for (const dir of created) addToProcessPath(dir)
    const repaired = await applyLivePathToProcess()
    const persisted = await persistUserPathEntries(created)
    const changed = [...new Set([...created, ...repaired])]
    if (!changed.length) {
      this.finishStep(state, 'path', 'skipped', 'Everything was already visible.')
      return
    }
    this.appendTail(state, `[path] now on PATH: ${changed.join(', ')}\n`)
    this.finishStep(
      state,
      'path',
      'done',
      persisted.ok && persisted.added.length
        ? `Added to your PATH (${persisted.target}) — your own terminals will see it too.`
        : 'Visible to this app.'
    )
  }

  // ── Process plumbing ───────────────────────────────────────────────────────

  /** Run one command, streaming its output into the transcript. argv only — no shell. */
  private exec(
    agentId: AgentCliId,
    state: AgentSetupState,
    file: string,
    args: string[],
    timeoutMs = STEP_TIMEOUT_MS
  ): Promise<RunResult> {
    return new Promise((resolve) => {
      // The transcript shows the LOGICAL command, not the cmd.exe wrapper spawnTool may
      // put around it — what ran, in the form the user would type.
      this.appendTail(state, `\n$ ${file} ${args.join(' ')}\n`)
      let child: ReturnType<typeof spawn>
      try {
        child = spawnTool(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (err) {
        this.appendTail(state, `${err instanceof Error ? err.message : String(err)}\n`)
        return resolve({ ok: false, code: null, missing: true, timedOut: false })
      }
      this.children.set(agentId, child)
      let timedOut = false
      const watchdog = setTimeout(() => {
        timedOut = true
        this.appendTail(state, `\n[gave up after ${Math.round(timeoutMs / 60_000)} minutes — the command looked stuck]\n`)
        child.kill()
      }, timeoutMs)
      const onData = (chunk: Buffer): void => this.appendTail(state, chunk.toString('utf8').replace(ANSI, ''))
      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)
      child.on('error', (err) => {
        clearTimeout(watchdog)
        this.appendTail(state, `${err.message}\n`)
        resolve({ ok: false, code: null, missing: (err as NodeJS.ErrnoException).code === 'ENOENT', timedOut })
      })
      child.on('close', (code) => {
        clearTimeout(watchdog)
        resolve({ ok: code === 0 && !timedOut, code, missing: false, timedOut })
      })
    })
  }

  /**
   * Run a command purely for its stdout (no transcript noise, short fuse).
   *
   * Returns `ok` SEPARATELY from the text, and the distinction is load-bearing: an empty
   * string from a command that failed means "we don't know", not "the answer is empty".
   * Conflating them is how a probe failure became a config change — `npm prefix -g` died
   * with EINVAL, answered '', and the caller read that as "npm's global folder is not
   * writable" and set about repointing it.
   */
  private capture(file: string, args: string[]): Promise<{ ok: boolean; out: string }> {
    return new Promise((resolve) => {
      let out = ''
      try {
        const child = spawnTool(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
        const timer = setTimeout(() => child.kill(), 20_000)
        child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')))
        child.on('error', () => {
          clearTimeout(timer)
          resolve({ ok: false, out: '' })
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          resolve({ ok: code === 0, out })
        })
      } catch {
        resolve({ ok: false, out: '' })
      }
    })
  }

  /** Can we actually put a binary here? A directory that does not YET exist is not a
   *  refusal — npm creates its global bin dir on first use, and on a machine that has
   *  never installed a global package `%APPDATA%\npm` is simply absent. Testing that with
   *  `access` alone reports "not writable" and repoints a prefix that was fine. Create it
   *  (idempotent, and npm would create the same directory) and then ask. */
  private writable(dir: string): boolean {
    try {
      mkdirSync(dir, { recursive: true })
      accessSync(dir, constants.W_OK)
      return true
    } catch {
      return false
    }
  }

  private describeExit(step: AgentInstallStep, result: RunResult): string {
    if (result.timedOut) return `${step.file} took too long and was stopped.`
    if (result.missing) return `${step.file} could not be started.`
    return `${step.file} exited with code ${result.code}.`
  }

  private installRemedy(result: RunResult): string {
    if (result.timedOut) return 'Check your internet connection and click Retry.'
    return 'Open the details below — the installer’s own message says what went wrong. Most failures here are a network or proxy problem; click Retry once it’s sorted.'
  }

  // ── State ──────────────────────────────────────────────────────────────────

  private step(state: AgentSetupState, id: AgentSetupStepId): AgentSetupStep {
    return state.steps.find((s) => s.id === id)!
  }

  private begin(state: AgentSetupState, id: AgentSetupStepId): void {
    this.step(state, id).phase = 'running'
    this.push({ ...state, steps: state.steps.map((s) => ({ ...s })) })
  }

  private finishStep(
    state: AgentSetupState,
    id: AgentSetupStepId,
    phase: 'done' | 'skipped' | 'failed',
    note?: string,
    remedy?: string
  ): void {
    const step = this.step(state, id)
    step.phase = phase
    step.note = note
    step.remedy = phase === 'failed' ? remedy : undefined
    this.push({ ...state, steps: state.steps.map((s) => ({ ...s })) })
  }

  private fail(state: AgentSetupState, agentId: AgentCliId, note?: string): void {
    // A run that ends early leaves later steps `pending`, which reads as "still going".
    // Say what is true: they never ran.
    for (const step of state.steps) {
      if (step.phase === 'pending' || step.phase === 'running') {
        step.phase = 'skipped'
        step.note ??= note ?? 'Not reached.'
      }
    }
    this.settle(state, agentId, 'failed')
  }

  private settle(state: AgentSetupState, agentId: AgentCliId, phase: 'succeeded' | 'failed'): void {
    state.phase = phase
    state.endedAt = Date.now()
    const timer = this.pushTimers.get(agentId)
    if (timer) {
      clearTimeout(timer)
      this.pushTimers.delete(agentId)
    }
    this.states.set(agentId, state)
    getTelemetry().captureEvent({
      // Structured primitives only — the transcript never leaves this machine (ADR 0005).
      name: 'provider.setup',
      props: {
        provider: agentId,
        ok: phase === 'succeeded',
        ms: (state.endedAt ?? 0) - state.startedAt,
        // WHICH wall was hit is the one number that makes this event worth having — it is a
        // fixed enum of step ids, never a path or a message.
        failed_step: state.steps.find((s) => s.phase === 'failed')?.id ?? 'none'
      }
    })
    this.push({ ...state, steps: state.steps.map((s) => ({ ...s })) })
  }

  private appendTail(state: AgentSetupState, text: string): void {
    state.tail = (state.tail + text).slice(-TAIL_MAX)
    if (this.pushTimers.has(state.agentId)) return
    this.pushTimers.set(
      state.agentId,
      setTimeout(() => {
        this.pushTimers.delete(state.agentId)
        if (state.phase === 'running') this.push({ ...state, steps: state.steps.map((s) => ({ ...s })) })
      }, PUSH_EVERY_MS)
    )
  }
}
