import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RELAY_SOURCE } from '@backend/features/context'
import { DAEMON_PROTOCOL_VERSION } from '@contracts'

// The statusline relay is GENERATED to disk and run by Claude Code itself, so this
// tier runs the exact shipped script under node: the sink write (the context bar's
// data source) and the PASSTHROUGH — the user's own statusline must still render,
// read back with the CLI's own file precedence (local > project > user), because our
// overlay arrived via --settings and out-ranks every file for the session.

/** A claude statusline payload with the fields the relay forwards. */
const PAYLOAD = JSON.stringify({
  context_window: { used_percentage: 42.5, context_window_size: 200000, total_input_tokens: 85000 },
  model: { id: 'claude-test-model' }
})

interface RelayRun {
  root: string
  relay: string
  fakeTmp: string
  home: string
  project: string
  ran: string
  mark: string
}

function makeFixture(): RelayRun {
  const root = mkdtempSync(join(tmpdir(), 'mog-relay-unit-'))
  const relay = join(root, 'context-relay.mjs')
  writeFileSync(relay, RELAY_SOURCE)
  const fakeTmp = join(root, 'tmp')
  mkdirSync(fakeTmp)
  const home = join(root, 'home', '.claude')
  mkdirSync(home, { recursive: true })
  const project = join(root, 'project')
  mkdirSync(join(project, '.claude'), { recursive: true })
  // The marker the fixture statuslines run: appends its tag so the test can see
  // WHICH scope's command actually rendered.
  const ran = join(root, 'ran.txt')
  const mark = join(root, 'mark.mjs')
  writeFileSync(mark, `import { appendFileSync } from 'node:fs'\nappendFileSync(process.argv[2], process.argv[3] + '\\n')\n`)
  return { root, relay, fakeTmp, home, project, ran, mark }
}

const statusLine = (f: RelayRun, tag: string): string =>
  JSON.stringify({ statusLine: { type: 'command', command: `node ${f.mark} ${f.ran} ${tag}` } })

/** Run the shipped relay with a controlled tmpdir/home/cwd; resolves its exit code. */
function runRelay(f: RelayRun, opts: { paneId?: string } = {}): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TMP: f.fakeTmp,
      TEMP: f.fakeTmp,
      TMPDIR: f.fakeTmp,
      CLAUDE_CONFIG_DIR: f.home
    }
    delete env.MOGGING_CHANNEL // deterministic sink segment ('v<N>', never 'dev-v<N>')
    if (opts.paneId === undefined) env.MOGGING_PANE_ID = 'relay-unit'
    else if (opts.paneId) env.MOGGING_PANE_ID = opts.paneId
    else delete env.MOGGING_PANE_ID
    const child = spawn(process.execPath, [f.relay], {
      cwd: f.project,
      env,
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true
    })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('relay did not exit'))
    }, 15000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.stdin.write(PAYLOAD)
    child.stdin.end()
  })
}

const sinkFile = (f: RelayRun, paneId = 'relay-unit'): string =>
  join(f.fakeTmp, `mogging-ctx-${userInfo().username}-v${DAEMON_PROTOCOL_VERSION}`, `${paneId}.json`)

const ranTags = (f: RelayRun): string[] =>
  existsSync(f.ran) ? readFileSync(f.ran, 'utf8').trim().split(/\r?\n/) : []

describe('context relay (the exact shipped script)', () => {
  it('forwards claude’s own numbers to the per-pane sink and exits 0', async () => {
    const f = makeFixture()
    expect(await runRelay(f)).toBe(0)
    const sink = JSON.parse(readFileSync(sinkFile(f), 'utf8')) as Record<string, unknown>
    expect(sink.usedPct).toBe(42.5)
    expect(sink.windowTokens).toBe(200000)
    expect(sink.usedTokens).toBe(85000)
    expect(sink.model).toBe('claude-test-model')
  })

  it('outside a pane (no MOGGING_PANE_ID) writes nothing and still exits 0', async () => {
    const f = makeFixture()
    expect(await runRelay(f, { paneId: '' })).toBe(0)
    expect(existsSync(sinkFile(f))).toBe(false)
  })

  it('passthrough picks the user statusline by the CLI’s own precedence: local > project > user', async () => {
    const f = makeFixture()
    writeFileSync(join(f.home, 'settings.json'), statusLine(f, 'user'))
    writeFileSync(join(f.project, '.claude', 'settings.json'), statusLine(f, 'project'))
    writeFileSync(join(f.project, '.claude', 'settings.local.json'), statusLine(f, 'local'))
    expect(await runRelay(f)).toBe(0)
    expect(ranTags(f)).toEqual(['local'])
  })

  it('passthrough falls back to lower scopes when the higher ones are absent', async () => {
    const f = makeFixture()
    writeFileSync(join(f.home, 'settings.json'), statusLine(f, 'user'))
    writeFileSync(join(f.project, '.claude', 'settings.json'), statusLine(f, 'project'))
    expect(await runRelay(f)).toBe(0)
    expect(ranTags(f)).toEqual(['project'])
  })

  it('a scope pointing back at the relay itself is skipped, not recursed — the next scope still renders', async () => {
    const f = makeFixture()
    writeFileSync(
      join(f.project, '.claude', 'settings.local.json'),
      JSON.stringify({ statusLine: { type: 'command', command: `node "${f.relay}"` } })
    )
    writeFileSync(join(f.home, 'settings.json'), statusLine(f, 'user'))
    expect(await runRelay(f)).toBe(0)
    expect(ranTags(f)).toEqual(['user'])
  })

  it('with no user statusline anywhere it exits 0 quietly (the sink still lands)', async () => {
    const f = makeFixture()
    expect(await runRelay(f)).toBe(0)
    expect(ranTags(f)).toEqual([])
    expect(existsSync(sinkFile(f))).toBe(true)
  })
})
