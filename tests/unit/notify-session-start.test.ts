import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NOTIFY_HOOK_SOURCE } from '@backend/features/agents'
import { DAEMON_PROTOCOL_VERSION } from '@contracts'

// The notify hook's IDENTITY branch, run as the exact shipped script under node — the
// channel that gives a HAND-TYPED claude (including a typed resume) the same exact
// context-gauge identity as an app launch. Three contracts under test: the sink lands
// at the statusline relay's rendezvous with the transcript_path claude named; the
// branch is silent BOTH ways (never a daemon frame — an unknown event would ring the
// pane red — and never a byte on stdout, which SessionStart feeds to the model); and
// clobbering a numbers-bearing relay sink is the intended behavior, because those
// numbers belong to the previous identity.

const PAYLOAD = JSON.stringify({
  hook_event_name: 'SessionStart',
  source: 'resume',
  session_id: 'abcd-1234',
  transcript_path: '/fake/projects/p/abcd-1234.jsonl',
  cwd: '/fake/repo'
})

interface HookRun {
  root: string
  script: string
  fakeTmp: string
}

function makeFixture(): HookRun {
  const root = mkdtempSync(join(tmpdir(), 'mog-sessionstart-unit-'))
  const script = join(root, 'notify.mjs')
  writeFileSync(script, NOTIFY_HOOK_SOURCE)
  const fakeTmp = join(root, 'tmp')
  mkdirSync(fakeTmp)
  return { root, script, fakeTmp }
}

/** Run the shipped hook with a controlled tmpdir; resolves exit code + captured stdout. */
function runHook(
  f: HookRun,
  opts: { paneId?: string; endpoint?: string; stdin?: string } = {}
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, TMP: f.fakeTmp, TEMP: f.fakeTmp, TMPDIR: f.fakeTmp }
    delete env.MOGGING_CHANNEL // deterministic sink segment ('v<N>', never 'dev-v<N>')
    if (opts.paneId === undefined) env.MOGGING_PANE_ID = 'ss-unit'
    else if (opts.paneId) env.MOGGING_PANE_ID = opts.paneId
    else delete env.MOGGING_PANE_ID
    // No live daemon in this tier: the endpoint stays unset unless a case injects one —
    // identity is a file, not a wire, so the branch must not care either way.
    if (opts.endpoint) env.MOGGING_DAEMON_ENDPOINT = opts.endpoint
    else delete env.MOGGING_DAEMON_ENDPOINT
    const child = spawn(process.execPath, [f.script, '--event', 'session-start'], {
      cwd: f.root,
      env,
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true
    })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (c: string) => {
      stdout += c
    })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('hook did not exit'))
    }, 15000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout })
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.stdin.write(opts.stdin ?? PAYLOAD)
    child.stdin.end()
  })
}

const sinkFile = (f: HookRun, paneId = 'ss-unit'): string =>
  join(f.fakeTmp, `mogging-ctx-${userInfo().username}-v${DAEMON_PROTOCOL_VERSION}`, `${paneId}.json`)

describe('notify hook session-start branch (the exact shipped script)', () => {
  it('writes the pane sink with the named transcript, nothing on stdout, exit 0', async () => {
    const f = makeFixture()
    const { code, stdout } = await runHook(f)
    expect(code).toBe(0)
    expect(stdout).toBe('') // SessionStart stdout is added to the model's context — must be empty
    const sink = JSON.parse(readFileSync(sinkFile(f), 'utf8')) as Record<string, unknown>
    expect(sink.transcriptPath).toBe('/fake/projects/p/abcd-1234.jsonl')
    expect(sink.usedPct).toBeNull() // identity only — never invented numbers
    expect(typeof sink.at).toBe('number')
  })

  it('needs no daemon endpoint — identity is a file, not a wire', async () => {
    const f = makeFixture()
    // (runHook already strips the endpoint; this case just names the contract.)
    const { code } = await runHook(f)
    expect(code).toBe(0)
    expect(existsSync(sinkFile(f))).toBe(true)
  })

  it('outside a pane (no MOGGING_PANE_ID) writes nothing and still exits 0', async () => {
    const f = makeFixture()
    const { code, stdout } = await runHook(f, { paneId: '' })
    expect(code).toBe(0)
    expect(stdout).toBe('')
    expect(existsSync(join(f.fakeTmp, `mogging-ctx-${userInfo().username}-v${DAEMON_PROTOCOL_VERSION}`))).toBe(false)
  })

  it('junk stdin writes nothing and still exits 0 — a hook must never fail its agent', async () => {
    const f = makeFixture()
    const { code, stdout } = await runHook(f, { stdin: 'not json at all' })
    expect(code).toBe(0)
    expect(stdout).toBe('')
    expect(existsSync(sinkFile(f))).toBe(false)
  })

  it('overwrites a numbers-bearing relay sink: those numbers were the PREVIOUS identity', async () => {
    const f = makeFixture()
    const dir = join(f.fakeTmp, `mogging-ctx-${userInfo().username}-v${DAEMON_PROTOCOL_VERSION}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'ss-unit.json'),
      JSON.stringify({ at: 1, usedPct: 82, windowTokens: 200000, usedTokens: 165000, model: 'old', transcriptPath: '/old/session.jsonl' })
    )
    const { code } = await runHook(f)
    expect(code).toBe(0)
    const sink = JSON.parse(readFileSync(sinkFile(f), 'utf8')) as Record<string, unknown>
    expect(sink.transcriptPath).toBe('/fake/projects/p/abcd-1234.jsonl')
    expect(sink.usedPct).toBeNull()
  })
})
