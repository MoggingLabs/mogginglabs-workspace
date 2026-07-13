import { app, type BrowserWindow } from 'electron'
import * as net from 'node:net'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, normalize } from 'node:path'
import type { DaemonEndpoint, PaneCwdLocality, PaneCwdSource, PaneInfo } from '@contracts'
import { OscParser, PaneCwdState, countSubmittedLines } from '@backend/features/agent-state'
import { buildLaunchCommand } from '@backend/features/agents'
import { SessionStore } from '@backend/features/workspace'
import { DaemonClient, ensureDaemon, runtimeDir } from './daemon-client'

const STEP_MS = 100
const WAIT_MS = 15_000
const PANE_A = '9101'
const PANE_B = '9102'
const PANE_C = '9103'

type WireMessage = Record<string, unknown> & { t?: string; reason?: string }

interface SeenCwd {
  id: string
  cwd: string
  gen: number
  revision: number
  source: PaneCwdSource
  locality: PaneCwdLocality
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function poll<T>(probe: () => T | Promise<T>, accept: (value: T) => boolean, timeoutMs = WAIT_MS): Promise<T> {
  const started = Date.now()
  let last = await probe()
  while (!accept(last) && Date.now() - started < timeoutMs) {
    await sleep(STEP_MS)
    last = await probe()
  }
  if (!accept(last)) throw new Error(`cwd smoke timed out after ${timeoutMs}ms`)
  return last
}

function writeResult(mode: string, value: Record<string, unknown>): void {
  const name = mode === 'INPROC' ? 'cwd-inproc-result.json' : 'cwd-result.json'
  for (const file of [join(app.getAppPath(), 'out', name), join(app.getPath('userData'), name)]) {
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(value, null, 2))
    } catch {
      /* try the other diagnostic location */
    }
  }
}

/** One independent authenticated daemon conversation. Pane capability fields remain only on
 * this local wire; the returned response is safe to summarize without echoing request values. */
function daemonRequest(
  endpoint: DaemonEndpoint,
  request: Record<string, unknown>,
  replies: readonly string[]
): Promise<WireMessage> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint.address)
    socket.setEncoding('utf8')
    let buffer = ''
    let welcomed = false
    let settled = false
    const finish = (value?: WireMessage, error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.destroy()
      } catch {
        /* already closed */
      }
      if (error) reject(error)
      else resolve(value ?? { t: 'error', reason: 'empty' })
    }
    const timer = setTimeout(() => finish(undefined, new Error('daemon request timeout')), 7000)
    socket.on('connect', () => {
      socket.write(JSON.stringify({ t: 'hello', v: endpoint.version, token: endpoint.token }) + '\n')
    })
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        let message: WireMessage
        try {
          message = JSON.parse(line) as WireMessage
        } catch {
          continue
        }
        if (!welcomed) {
          if (message.t === 'welcome') {
            welcomed = true
            socket.write(JSON.stringify(request) + '\n')
          } else if (message.t === 'error') {
            finish(message)
          }
          continue
        }
        if (message.t === 'error' || (message.t && replies.includes(message.t))) finish(message)
      }
    })
    socket.on('error', (error) => finish(undefined, error))
    socket.on('close', () => {
      if (!settled) finish(undefined, new Error('daemon closed before reply'))
    })
  })
}

const shellQuote = (value: string): string =>
  process.platform === 'win32' ? `"${value.replace(/"/g, '""')}"` : `'${value.replace(/'/g, `'\\''`)}'`

/** Extract a pane capability into a test-only 0600-ish temp file without printing it. The file
 * is deleted before the leak scan; command text contains only the environment variable NAME. */
function tokenWriterCommand(file: string): string {
  const source = `require('node:fs').writeFileSync(${JSON.stringify(file)},process.env.MOGGING_PANE_TOKEN||'')`
  const encoded = Buffer.from(source, 'utf8').toString('base64')
  return `node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`
}

const holdCommand = (): string => 'node -e "setInterval(function(){},1000)"'

function initGitRepo(cwd: string): void {
  execFileSync('git', ['init', '-q'], { cwd, windowsHide: true })
}

function opaqueCwdHoldingCommand(cwd: string): string {
  if (process.platform === 'win32') {
    const source = `process.chdir(${JSON.stringify(cwd)});setInterval(function(){},1000)`
    const encoded = Buffer.from(source, 'utf8').toString('base64')
    return `node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`
  }
  // The child shell changes its own cwd and execs an unrecognized long-running process; the
  // interactive pane shell stays put, so a prompt-only implementation cannot pass this proof.
  const child = `cd ${shellQuote(cwd)} && exec sleep 30`
  return `sh -c ${shellQuote(child)}`
}

function gitTargetHoldingCommand(cwd: string): string {
  if (process.platform === 'win32') {
    return `git -C ${shellQuote(cwd)} status --short >nul && ${holdCommand()}`
  }
  return `git -C ${shellQuote(cwd)} status --short >/dev/null 2>&1; sleep 30`
}

function parserFallbackProof(cwd: string): boolean {
  const events: Array<{ kind: string; code: number; payload?: string }> = []
  const parser = new OscParser(
    () => {},
    (event) => events.push(event)
  )
  const frame = `\x1b]633;P;MoggingCwd=${encodeURIComponent(cwd)}\x1b\\`
  // Split both the introducer and ST terminator: the fallback rides arbitrary PTY chunks.
  for (const part of [frame.slice(0, 1), frame.slice(1, 9), frame.slice(9, -1), frame.slice(-1)]) parser.push(part)
  parser.push('\x1b]633;P;MoggingCwd=%2Fbad%0Apath\x1b\\')
  return events.length === 1 && events[0].kind === 'agent-cwd' && events[0].code === 633 && events[0].payload === cwd
}

function remoteFallbackProof(): boolean {
  const cwd = "/srv/work trees/O'Reilly"
  const events: Array<{ kind: string; payload?: string }> = []
  const parser = new OscParser(
    () => {},
    (event) => events.push(event)
  )
  parser.push(`\x1b]633;P;MoggingCwdRaw=${cwd}\x1b\\`)
  const command = buildLaunchCommand('claude', cwd, false, undefined, [], 'posix')
  return (
    events.length === 1 &&
    events[0].kind === 'agent-cwd' &&
    events[0].payload === cwd &&
    command === "cd '/srv/work trees/O'\\''Reilly' && claude"
  )
}

function remoteProcessParserProof(): boolean {
  const events: Array<{ kind: string; pid?: number; payload?: string }> = []
  const parser = new OscParser(
    () => {},
    (event) => events.push(event)
  )
  parser.push('\x1b]633;P;MoggingProcessCwdRaw=4242;/srv/work;semi\x1b\\')
  parser.push('\x1b]633;P;MoggingProcessCwdRaw=not-a-pid;/srv/wrong\x1b\\')
  parser.push('\x1b]633;P;MoggingProcessCwdRaw=1e3;/srv/wrong\x1b\\')
  parser.push('\x1b]633;P;MoggingProcessCwdRaw=999999999999999999999;/srv/wrong\x1b\\')
  parser.push('\x1b]633;P;MoggingProcessCwdRaw=7;/srv/bad\npath\x1b\\')
  parser.push('\x1b]633;P;MoggingGitCwdRaw=/srv/git-worktree\x1b\\')
  parser.push('\x1b]633;P;MoggingGitCwdRaw=/srv/bad\nrepo\x1b\\')
  return events.length === 2 && events[0].kind === 'process-cwd' &&
    events[0].pid === 4242 && events[0].payload === '/srv/work;semi' &&
    events[1].kind === 'git-cwd' && events[1].payload === '/srv/git-worktree'
}

function shellPromptParserProof(): boolean {
  const events: Array<{ kind: string; payload?: string }> = []
  const parser = new OscParser(
    () => {},
    (event) => events.push(event)
  )
  parser.push('\x1b]633;P;MoggingPromptCwdRaw=/work tree\x1b\\')
  parser.push('\x1b]633;P;MoggingPrompt\x1b\\')
  parser.push('\x1b]633;P;MoggingPromptCwdRaw=/bad\npath\x1b\\')
  return (
    events.length === 2 &&
    events[0].kind === 'shell-prompt' &&
    events[0].payload === '/work tree' &&
    events[1].kind === 'shell-prompt' &&
    events[1].payload === undefined
  )
}

/** Pure precedence/order proof shared by both backend smoke modes. */
function cwdStateMachineProof(): boolean {
  const state = new PaneCwdState('/spawn', 'local')
  const shell = state.acceptShell('/shell', false, 1)
  const detected = state.acceptDetected({ pid: 10, cwd: '/process' }, 2)
  const declared = state.acceptReport('/agent', 3, 3)
  const lowerLaneMove = state.acceptShell('/shell-next', false, 4)
  const lowerLaneHeld = state.current()
  const prompt = state.acceptPrompt(5)
  const stale = state.acceptReport('/stale', 4, 5)
  const redetected = state.acceptDetected({ pid: 11, cwd: '/process-next' }, 6)
  const replacementReport = state.acceptReport('/agent-next', 7, 7)
  const replaced = state.acceptDetected({ pid: 12, cwd: '/replacement' }, 8)
  const replacementHeld = state.current()
  const replacementSessionCwd = state.passiveCwd()
  const fallback = new PaneCwdState('/fallback', 'local')
  fallback.acceptCommandStart()
  fallback.acceptWorktree('/git-before-exit')
  const processExit = fallback.acceptDetected(null, 10)
  const lateAfterExit = fallback.acceptReport('/late-after-exit', 9, 10)
  fallback.acceptDetected({ pid: 20, cwd: '/process-reopened' }, 11)
  const worktreeAfterDetection = fallback.acceptWorktree('/git-reopened')
  const sessionIdentityCwd = fallback.passiveCwd()
  const queued = new PaneCwdState('/queued-spawn', 'local')
  queued.acceptCommandStart()
  queued.acceptCommandStart()
  queued.acceptPrompt(20, 'osc133')
  const queuedAfterFirstPrompt = queued.commandInFlight()
  queued.acceptPrompt(20, 'mogging')
  const queuedAfterDuplicatePrompt = queued.commandInFlight()
  const queuedWorktree = queued.acceptWorktree('/queued-worktree')
  queued.acceptPrompt(30, 'osc133')
  const queuedAfterSecondPrompt = queued.commandInFlight()
  const queuedLateWorktree = queued.acceptWorktree('/queued-late')
  return (
    shell?.source === 'shell' &&
    detected?.source === 'process' &&
    declared.ok && declared.changed?.source === 'agent' &&
    lowerLaneMove === null && lowerLaneHeld.cwd === '/agent' &&
    prompt?.source === 'shell' && prompt.cwd === '/shell-next' &&
    !stale.ok && stale.reason === 'stalecwd' &&
    redetected?.source === 'process' &&
    replacementReport.ok && replacementReport.changed?.source === 'agent' &&
    replaced === null && replacementHeld.source === 'agent' && replacementHeld.cwd === '/agent-next' &&
    replacementSessionCwd === '/replacement' &&
    processExit?.cwd === '/fallback' && processExit.source === 'spawn' &&
    !lateAfterExit.ok && lateAfterExit.reason === 'stalecwd' &&
    worktreeAfterDetection?.cwd === '/git-reopened' && worktreeAfterDetection.source === 'process' &&
    sessionIdentityCwd === '/process-reopened' &&
    queuedAfterFirstPrompt && queuedAfterDuplicatePrompt &&
    queuedWorktree?.cwd === '/queued-worktree' &&
    !queuedAfterSecondPrompt && queuedLateWorktree === null &&
    countSubmittedLines('one\r\ntwo\nthree\r') === 3
  )
}

const reasonIs = (message: WireMessage, reason: string): boolean => message.t === 'error' && message.reason === reason

async function capturePane(endpoint: DaemonEndpoint, id: string): Promise<string> {
  const response = await daemonRequest(endpoint, { t: 'capture', id, lastLines: 10_000 }, ['captured'])
  return response.t === 'captured' && typeof response.data === 'string' ? response.data : ''
}

function filesContainAny(files: readonly string[], secrets: readonly string[]): boolean {
  for (const file of files) {
    if (!existsSync(file)) continue
    const bytes = readFileSync(file)
    for (const secret of secrets) {
      if (secret && bytes.includes(Buffer.from(secret))) return true
    }
  }
  return false
}

async function runDaemonMode(): Promise<Record<string, unknown>> {
  const fixture = mkdtempSync(join(tmpdir(), 'mogging-cwd-smoke-'))
  const seedA = join(fixture, 'seed-a')
  const seedB = join(fixture, 'seed-b')
  const declared = join(fixture, 'primary worktree')
  const missing = join(fixture, 'missing-worktree')
  const tokenAFile = join(fixture, 'pane-a.token')
  const tokenBFile = join(fixture, 'pane-b.token')
  const tokenNewFile = join(fixture, 'pane-a-new.token')
  const profileHome = join(fixture, 'profile-home')
  for (const dir of [seedA, seedB, declared, profileHome]) mkdirSync(dir, { recursive: true })
  initGitRepo(declared)
  if (process.platform !== 'win32') {
    writeFileSync(join(profileHome, '.bash_profile'), 'export PATH=/usr/bin:/bin\nexport PS1="cwd-smoke$ "\n')
  }

  const eventsA: SeenCwd[] = []
  const generationsA = new Map<string, number>()
  const eventsB: SeenCwd[] = []
  const generationsB = new Map<string, number>()
  let clientA: DaemonClient | null = null
  let clientB: DaemonClient | null = null
  try {
    const endpoint = await ensureDaemon(join(__dirname, 'daemon.js'))
    clientA = new DaemonClient(endpoint, {
      onGen: (id, gen) => generationsA.set(id, gen),
      onCwd: (id, cwd, gen, revision, source, locality) =>
        eventsA.push({ id, cwd, gen, revision, source, locality })
    })
    const welcomeA = await clientA.connect()
    for (const id of [PANE_A, PANE_B, PANE_C]) if (welcomeA.some((pane) => pane.id === id)) clientA.kill(id)
    await sleep(250)
    await clientA.spawn(PANE_A, { cwd: seedA, cols: 100, rows: 30 })
    await clientA.spawn(PANE_B, { cwd: seedB, cols: 100, rows: 30 })
    await clientA.spawn(PANE_C, {
      cwd: seedB,
      cols: 100,
      rows: 30,
      ...(process.platform === 'win32'
        ? {}
        : { shell: '/bin/bash', env: { HOME: profileHome, PATH: '/profile-reset' } })
    })
    const firstGeneration = generationsA.get(PANE_A)
    if (firstGeneration === undefined) throw new Error('pane A generation was not learned')
    await sleep(800)

    // This command is deliberately not a known provider process. Its explicit declaration
    // must win while it runs, then the shell's next prompt must return the pane to shell cwd.
    // On POSIX, .bash_profile first destroys PATH; finding `mogging` proves the post-profile
    // runtime prepend is active rather than merely inherited from the daemon parent.
    const retireStart = eventsA.length
    clientA.input(PANE_C, `mogging cwd ${shellQuote(declared)}\r`)
    const transientDeclaration = await poll(
      () => eventsA.slice(retireStart).find((event) => event.id === PANE_C && event.source === 'agent'),
      (event) => !!event
    )
    const retiredDeclaration = await poll(
      () => eventsA.slice(retireStart).find(
        (event) =>
          event.id === PANE_C &&
          event.source === 'shell' &&
          event.cwd === normalize(seedB) &&
          event.revision > (transientDeclaration?.revision ?? 0)
      ),
      (event) => !!event
    )
    const unknownCliRetired =
      transientDeclaration?.cwd === normalize(declared) && !!retiredDeclaration
    const profilePathResetOk = process.platform === 'win32' || unknownCliRetired

    // No adapter, MCP server, or `mogging cwd`: the generic foreground-process lane must still
    // discover the actual worktree. The child changes its own cwd while the interactive shell
    // remains in seedB, so shell-prompt-only tracking cannot pass this proof.
    const opaqueStart = eventsA.length
    const opaqueCommand = `${opaqueCwdHoldingCommand(declared)}\r`
    clientA.input(PANE_C, opaqueCommand)
    const opaqueContext = await poll(
      () => eventsA.slice(opaqueStart).find(
        (event) => event.id === PANE_C && event.source === 'process' && event.cwd === normalize(declared)
      ),
      (event) => !!event
    )
    clientA.input(PANE_C, '\x03')
    const opaqueRetired = await poll(
      () => eventsA.slice(opaqueStart).find(
        (event) => event.id === PANE_C && event.source === 'shell' &&
          event.cwd === normalize(seedB) && event.revision > (opaqueContext?.revision ?? 0)
      ),
      (event) => !!event
    )
    const arbitraryCliContextOk = !!opaqueContext && !!opaqueRetired

    const gitContextStart = eventsA.length
    clientA.input(PANE_C, `${gitTargetHoldingCommand(declared)}\r`)
    const gitTargetContext = await poll(
      () => eventsA.slice(gitContextStart).find(
        (event) => event.id === PANE_C && event.source === 'process' && event.cwd === normalize(declared)
      ),
      (event) => !!event
    )
    // Let the generic foreground snapshot arrive after Git. Its process cwd is still seedB and
    // must not roll the exact Git worktree lane back.
    await sleep(3_000)
    const gitTargetHeld = eventsA.slice(gitContextStart).at(-1)?.cwd === normalize(declared)
    clientA.input(PANE_C, '\x03')
    const gitTargetRetired = await poll(
      () => eventsA.slice(gitContextStart).find(
        (event) => event.id === PANE_C && event.source === 'shell' &&
          event.cwd === normalize(seedB) && event.revision > (gitTargetContext?.revision ?? 0)
      ),
      (event) => !!event
    )
    const arbitraryGitTargetContextOk = !!gitTargetContext && gitTargetHeld && !!gitTargetRetired

    const reportCommand =
      `${tokenWriterCommand(tokenAFile)} && mogging cwd ${shellQuote(declared)} && ${holdCommand()}\r`
    const paneBCommand = `${tokenWriterCommand(tokenBFile)} && ${holdCommand()}\r`
    clientA.input(PANE_A, reportCommand)
    clientA.input(PANE_B, paneBCommand)

    await poll(
      () => ({ a: existsSync(tokenAFile), b: existsSync(tokenBFile) }),
      (value) => value.a && value.b
    )
    const validEvent = await poll(
      () => eventsA.find((event) => event.id === PANE_A && event.cwd === normalize(declared) && event.source === 'agent'),
      (event) => !!event
    )
    if (!validEvent) throw new Error('valid cwd event missing')
    const ackTail = await poll(
      () => capturePane(endpoint, PANE_A),
      (tail) => tail.includes('mogging: cwd declared')
    )

    const tokenA = readFileSync(tokenAFile, 'utf8').trim()
    const tokenB = readFileSync(tokenBFile, 'utf8').trim()
    const paneTokensDistinct = tokenA.length >= 16 && tokenB.length >= 16 && tokenA !== tokenB

    const beforeDuplicateEvents = eventsA.filter(
      (event) => event.id === PANE_A && event.cwd === normalize(declared) && event.source === 'agent'
    ).length
    const duplicate = await daemonRequest(
      endpoint,
      { t: 'cwd-report', id: PANE_A, token: tokenA, cwd: declared, observedAt: Date.now() },
      ['cwd-reported']
    )
    await sleep(300)
    const afterDuplicateEvents = eventsA.filter(
      (event) => event.id === PANE_A && event.cwd === normalize(declared) && event.source === 'agent'
    ).length
    const duplicateStable =
      duplicate.t === 'cwd-reported' &&
      duplicate.rev === validEvent.revision &&
      beforeDuplicateEvents === afterDuplicateEvents
    await sleep(500)
    const persistedReader = new SessionStore(join(runtimeDir(), 'sessions.db'))
    const persistedPane = persistedReader.loadPanes().find((pane) => pane.id === PANE_A)
    persistedReader.close()
    const persistenceOk =
      persistedPane?.reportedCwd === normalize(declared) &&
      typeof persistedPane.reportedCwdAt === 'number'

    const missingPath = await daemonRequest(
      endpoint,
      { t: 'cwd-report', id: PANE_A, token: tokenA, observedAt: Date.now() },
      ['cwd-reported']
    )
    const invalidPath = await daemonRequest(
      endpoint,
      { t: 'cwd-report', id: PANE_A, token: tokenA, cwd: missing, observedAt: Date.now() },
      ['cwd-reported']
    )
    const staleReport = await daemonRequest(
      endpoint,
      { t: 'cwd-report', id: PANE_A, token: tokenA, cwd: declared, observedAt: Date.now() - 120_000 },
      ['cwd-reported']
    )
    const badTimeReport = await daemonRequest(
      endpoint,
      { t: 'cwd-report', id: PANE_A, token: tokenA, cwd: declared, observedAt: Date.now() - 10 * 60_000 },
      ['cwd-reported']
    )
    const missingToken = await daemonRequest(
      endpoint,
      { t: 'cwd-report', id: PANE_A, cwd: declared, observedAt: Date.now() },
      ['cwd-reported']
    )
    const wrongToken = await daemonRequest(
      endpoint,
      { t: 'cwd-report', id: PANE_A, token: 'definitely-wrong', cwd: declared, observedAt: Date.now() },
      ['cwd-reported']
    )
    const crossPaneToken = await daemonRequest(
      endpoint,
      { t: 'cwd-report', id: PANE_A, token: tokenB, cwd: declared, observedAt: Date.now() },
      ['cwd-reported']
    )

    clientB = new DaemonClient(endpoint, {
      onGen: (id, gen) => generationsB.set(id, gen),
      onCwd: (id, cwd, gen, revision, source, locality) =>
        eventsB.push({ id, cwd, gen, revision, source, locality })
    })
    const welcomeB = await clientB.connect()
    const replayInfo = welcomeB.find((pane) => pane.id === PANE_A)
    clientB.attach(PANE_A)
    const attachReplay = await poll(
      () => eventsB.find((event) => event.id === PANE_A && event.cwd === normalize(declared)),
      (event) => !!event
    )
    const replayOk =
      !!attachReplay &&
      replayInfo?.cwd === normalize(declared) &&
      replayInfo.cwdRevision === validEvent.revision &&
      replayInfo.cwdSource === 'agent' &&
      replayInfo.cwdLocality === 'local' &&
      attachReplay.revision === validEvent.revision &&
      attachReplay.source === 'agent' &&
      attachReplay.locality === 'local' &&
      generationsB.get(PANE_A) === firstGeneration

    const oldCapture = await capturePane(endpoint, PANE_A)
    const paneBCapture = await capturePane(endpoint, PANE_B)
    clientA.kill(PANE_A)
    await clientA.spawn(PANE_A, { cwd: seedA, cols: 100, rows: 30 })
    const secondGeneration = generationsA.get(PANE_A)
    if (secondGeneration === undefined || secondGeneration === firstGeneration) {
      throw new Error('pane id reuse did not mint a new generation')
    }
    await sleep(500)
    clientA.input(PANE_A, `${tokenWriterCommand(tokenNewFile)} && ${holdCommand()}\r`)
    await poll(() => existsSync(tokenNewFile), Boolean)
    const tokenNew = readFileSync(tokenNewFile, 'utf8').trim()
    const staleToken = await daemonRequest(
      endpoint,
      { t: 'cwd-report', id: PANE_A, token: tokenA, cwd: declared, observedAt: Date.now() },
      ['cwd-reported']
    )
    const newCapture = await capturePane(endpoint, PANE_A)

    rmSync(tokenAFile, { force: true })
    rmSync(tokenBFile, { force: true })
    rmSync(tokenNewFile, { force: true })
    await sleep(500)
    const secrets = [tokenA, tokenB, tokenNew, endpoint.token]
    const tokenNonLeak =
      ![ackTail, oldCapture, paneBCapture, newCapture].some((surface) => secrets.some((secret) => surface.includes(secret))) &&
      !filesContainAny(
        [
          join(runtimeDir(), 'daemon.log'),
          join(runtimeDir(), 'sessions.db'),
          join(runtimeDir(), 'sessions.db-wal')
        ],
        secrets
      )

    const validMetadata =
      validEvent.gen === firstGeneration &&
      validEvent.revision > 0 &&
      validEvent.source === 'agent' &&
      validEvent.locality === 'local'
    const authRefusals =
      reasonIs(missingToken, 'badpaneauth') &&
      reasonIs(wrongToken, 'badpaneauth') &&
      reasonIs(crossPaneToken, 'badpaneauth')
    const pathRefusals = reasonIs(missingPath, 'badcwd') && reasonIs(invalidPath, 'badcwd')
    const staleTokenRefused = tokenNew !== tokenA && reasonIs(staleToken, 'badpaneauth')
    const shim = process.env.MOGGING_CLI
    const cliShimOk = !!shim && existsSync(shim)
    const fallbackParserOk = parserFallbackProof(declared)
    const remoteFallbackOk = remoteFallbackProof()
    const remoteProcessParserOk = remoteProcessParserProof()
    const stateMachineOk = cwdStateMachineProof()
    const shellPromptParserOk = shellPromptParserProof()
    const orderingRefusals = reasonIs(staleReport, 'stalecwd') && reasonIs(badTimeReport, 'badtime')
    const pass =
      cliShimOk &&
      ackTail.includes('mogging: cwd declared') &&
      validMetadata &&
      duplicateStable &&
      persistenceOk &&
      pathRefusals &&
      authRefusals &&
      paneTokensDistinct &&
      staleTokenRefused &&
      replayOk &&
      tokenNonLeak &&
      fallbackParserOk &&
      remoteFallbackOk &&
      remoteProcessParserOk &&
      stateMachineOk &&
      shellPromptParserOk &&
      unknownCliRetired &&
      arbitraryCliContextOk &&
      arbitraryGitTargetContextOk &&
      profilePathResetOk &&
      orderingRefusals

    return {
      pass,
      mode: 'daemon',
      cliShimOk,
      validMetadata,
      firstRevision: validEvent.revision,
      duplicateStable,
      persistenceOk,
      duplicateEventCount: afterDuplicateEvents,
      pathRefusals,
      authRefusals,
      paneTokensDistinct,
      staleTokenRefused,
      generationChangedOnReuse: secondGeneration !== firstGeneration,
      replayOk,
      tokenNonLeak,
      fallbackParserOk,
      remoteFallbackOk,
      remoteProcessParserOk,
      stateMachineOk,
      shellPromptParserOk,
      unknownCliRetired,
      arbitraryCliContextOk,
      arbitraryGitTargetContextOk,
      profilePathResetOk,
      orderingRefusals
    }
  } finally {
    try {
      clientA?.kill(PANE_A)
      clientA?.kill(PANE_B)
      clientA?.kill(PANE_C)
      await sleep(100)
    } catch {
      /* isolated daemon is reaped by the harness */
    }
    clientB?.dispose()
    clientA?.dispose()
    try {
      rmSync(fixture, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 })
    } catch {
      // The gate harness reaps its isolated daemon immediately after this result. On Windows a
      // ConPTY child can retain its cwd until that reap even though the pane is already gone;
      // test-fixture cleanup is not a product verdict.
    }
  }
}

async function runInProcMode(win: BrowserWindow): Promise<Record<string, unknown>> {
  const fixture = mkdtempSync(join(tmpdir(), 'mogging-cwd-inproc-'))
  const seed = join(fixture, 'seed')
  const declared = join(fixture, 'primary worktree')
  const missing = join(fixture, 'missing-worktree')
  const tokenFile = join(fixture, 'pane.token')
  for (const dir of [seed, declared]) mkdirSync(dir, { recursive: true })
  initGitRepo(declared)
  const execute = <T = unknown>(script: string): Promise<T> => win.webContents.executeJavaScript(script, true) as Promise<T>
  let paneId: number | undefined

  try {
    const opened = await execute<{ ordinal: number }>(
      `(()=>{const ws=window.__mogging.workspace.openForCwd(${JSON.stringify(seed)});return {ordinal:ws.ordinal};})()`
    )
    paneId = opened.ordinal * 100 + 1
    await execute(
      `window.__cwdSmokeEvents=[];window.bridge.on('terminal:cwd',function(e){` +
        `if(e&&e.id===${paneId})window.__cwdSmokeEvents.push(e);});1`
    )
    await poll(
      () => execute<boolean>(`(window.__mogging.panes||[]).some(function(p){return p.id===${paneId}})`),
      Boolean
    )
    await sleep(900)

    const tokenCommand = `${tokenWriterCommand(tokenFile)}\r`
    await execute(`window.bridge.send('terminal:write',{id:${paneId},data:${JSON.stringify(tokenCommand)}})`)
    await poll(() => existsSync(tokenFile), Boolean)
    const paneToken = readFileSync(tokenFile, 'utf8').trim()
    await execute(`window.__cwdSmokeEvents=[]`)

    const cwdCommand = `mogging cwd ${shellQuote(declared)}\r`
    await execute(`window.bridge.send('terminal:write',{id:${paneId},data:${JSON.stringify(cwdCommand)}})`)
    const declaredEvent = await poll(
      () =>
        execute<Array<{ cwd: string; generation: string; revision: number; source: string; locality: string }>>(
          `window.__cwdSmokeEvents.slice()`
        ).then((events) => events.find((event) => event.cwd === normalize(declared) && event.source === 'agent')),
      (event) => !!event
    )
    if (!declaredEvent) throw new Error('in-process OSC cwd event missing')
    const retiredEvent = await poll(
      () =>
        execute<Array<{ cwd: string; generation: string; revision: number; source: string; locality: string }>>(
          `window.__cwdSmokeEvents.slice()`
        ).then((events) => events.find(
          (event) => event.source === 'shell' && event.revision > declaredEvent.revision
        )),
      (event) => !!event
    )
    const unknownCliRetired = !!retiredEvent && retiredEvent.cwd === normalize(seed)

    await execute(`window.__cwdSmokeEvents=[]`)
    const opaqueCommand = `${opaqueCwdHoldingCommand(declared)}\r`
    await execute(`window.bridge.send('terminal:write',{id:${paneId},data:${JSON.stringify(opaqueCommand)}})`)
    const opaqueContext = await poll(
      () => execute<Array<{ cwd: string; revision: number; source: string }>>(
        'window.__cwdSmokeEvents.slice()'
      ).then((events) => events.find(
        (event) => event.cwd === normalize(declared) && event.source === 'process'
      )),
      (event) => !!event
    )
    await execute(`window.bridge.send('terminal:write',{id:${paneId},data:'\\x03'})`)
    const opaqueRetired = await poll(
      () => execute<Array<{ cwd: string; revision: number; source: string }>>(
        'window.__cwdSmokeEvents.slice()'
      ).then((events) => events.find(
        (event) => event.cwd === normalize(seed) && event.source === 'shell' &&
          event.revision > (opaqueContext?.revision ?? 0)
      )),
      (event) => !!event
    )
    const arbitraryCliContextOk = !!opaqueContext && !!opaqueRetired

    await execute(`window.__cwdSmokeEvents=[]`)
    await execute(`window.bridge.send('terminal:write',{id:${paneId},data:${JSON.stringify(`${gitTargetHoldingCommand(declared)}\r`)}})`)
    const gitTargetContext = await poll(
      () => execute<Array<{ cwd: string; revision: number; source: string }>>(
        'window.__cwdSmokeEvents.slice()'
      ).then((events) => events.find(
        (event) => event.cwd === normalize(declared) && event.source === 'process'
      )),
      (event) => !!event
    )
    await sleep(3_000)
    const gitTargetHeld = await execute<Array<{ cwd: string }>>('window.__cwdSmokeEvents.slice()')
      .then((events) => events.at(-1)?.cwd === normalize(declared))
    await execute(`window.bridge.send('terminal:write',{id:${paneId},data:'\\x03'})`)
    const gitTargetRetired = await poll(
      () => execute<Array<{ cwd: string; revision: number; source: string }>>(
        'window.__cwdSmokeEvents.slice()'
      ).then((events) => events.find(
        (event) => event.cwd === normalize(seed) && event.source === 'shell' &&
          event.revision > (gitTargetContext?.revision ?? 0)
      )),
      (event) => !!event
    )
    const arbitraryGitTargetContextOk = !!gitTargetContext && gitTargetHeld && !!gitTargetRetired
    const fallbackTail = await poll(
      () =>
        execute<string>(
          `(()=>{const p=(window.__mogging.panes||[]).find(function(x){return x.id===${paneId}});return p?p.text():'';})()`
        ),
      (text) => text.includes('mogging: cwd declared via terminal fallback')
    )

    const invalidCommand = `mogging cwd ${shellQuote(missing)}\r`
    await execute(`window.bridge.send('terminal:write',{id:${paneId},data:${JSON.stringify(invalidCommand)}})`)
    const invalidTail = await poll(
      () =>
        execute<string>(
          `(()=>{const p=(window.__mogging.panes||[]).find(function(x){return x.id===${paneId}});return p?p.text():'';})()`
        ),
      (text) => text.includes('directory does not exist or is not accessible')
    )

    rmSync(tokenFile, { force: true })
    const eventsJson = await execute<string>(`JSON.stringify(window.__cwdSmokeEvents)`)
    const tokenNonLeak =
      paneToken.length >= 16 &&
      !fallbackTail.includes(paneToken) &&
      !invalidTail.includes(paneToken) &&
      !eventsJson.includes(paneToken)
    const metadataOk =
      declaredEvent.cwd === normalize(declared) &&
      typeof declaredEvent.generation === 'string' &&
      declaredEvent.generation.includes(':inproc:') &&
      declaredEvent.revision > 0 &&
      declaredEvent.source === 'agent' &&
      declaredEvent.locality === 'local'
    const shim = process.env.MOGGING_CLI
    const cliShimOk = !!shim && existsSync(shim)
    const fallbackParserOk = parserFallbackProof(declared)
    const remoteFallbackOk = remoteFallbackProof()
    const remoteProcessParserOk = remoteProcessParserProof()
    const stateMachineOk = cwdStateMachineProof()
    const shellPromptParserOk = shellPromptParserProof()
    const pass =
      cliShimOk &&
      metadataOk &&
      fallbackTail.includes('mogging: cwd declared via terminal fallback') &&
      invalidTail.includes('directory does not exist or is not accessible') &&
      tokenNonLeak &&
      fallbackParserOk &&
      remoteFallbackOk &&
      remoteProcessParserOk &&
      stateMachineOk &&
      shellPromptParserOk &&
      unknownCliRetired &&
      arbitraryCliContextOk &&
      arbitraryGitTargetContextOk
    return {
      pass,
      mode: 'inproc',
      cliShimOk,
      metadataOk,
      revision: declaredEvent.revision,
      fallbackReachedRenderer: fallbackTail.includes('mogging: cwd declared via terminal fallback'),
      invalidPathRefused: invalidTail.includes('directory does not exist or is not accessible'),
      tokenNonLeak,
      fallbackParserOk,
      remoteFallbackOk,
      remoteProcessParserOk,
      stateMachineOk,
      shellPromptParserOk,
      unknownCliRetired,
      arbitraryCliContextOk,
      arbitraryGitTargetContextOk
    }
  } finally {
    if (paneId !== undefined) {
      try {
        await execute(`window.bridge.send('terminal:kill',{id:${paneId}})`)
        await sleep(500)
      } catch {
        /* app is already shutting down */
      }
    }
    try {
      rmSync(fixture, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    } catch {
      /* Windows can retain a just-killed PTY cwd briefly; the OS temp tree is disposable. */
    }
  }
}

export function runCwdSmoke(win: BrowserWindow, rawMode: string): void {
  const mode = rawMode.toUpperCase() === 'INPROC' ? 'INPROC' : 'DAEMON'
  let finished = false
  const safety = setTimeout(() => {
    if (finished) return
    writeResult(mode, { pass: false, mode: mode.toLowerCase(), error: 'cwd smoke timeout' })
    app.exit(1)
  }, mode === 'INPROC' ? 90_000 : 120_000)

  const run = async (): Promise<void> => {
    let result: Record<string, unknown>
    try {
      result = mode === 'INPROC' ? await runInProcMode(win) : await runDaemonMode()
    } catch (error) {
      result = { pass: false, mode: mode.toLowerCase(), error: String(error) }
    }
    finished = true
    clearTimeout(safety)
    writeResult(mode, result)
    app.exit(result.pass === true ? 0 : 1)
  }

  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => setTimeout(run, 2500))
  else setTimeout(run, 2500)
}
