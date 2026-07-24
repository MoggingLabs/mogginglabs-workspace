import { app } from 'electron'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import * as net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NOTIFY_HOOK_SOURCE } from '@backend/features/agents'
import { sleep } from './kit'

// NOTIFYPARITY (MOGGING_NOTIFYPARITY): the two SHIPPED notify artifacts speak one dialect.
//
// `bin/mogging.mjs notify` (the CLI hooks/README wires by hand) and the generated
// `notify-hook/notify.mjs` (the session overlay + global wiring run it) are twins by contract —
// the generated script calls itself "a standalone re-cut of `mogging notify`" — and they DRIFTED:
// the 2026-07-15 red-latch fix (unknown notification types are a GUESS and must ride the bell's
// held-for-contradiction path as `notice`, never latch red as `needs-input`) landed in the
// generated script only. Every README-wired user kept the pre-fix defaults, so the day Claude or
// Codex ships a new notification type, their working panes latch red — the exact bug class the
// fix closed, alive on the manual path. Two copies of a mapping, and nothing made them agree.
//
// This gate makes them agree the only way that lasts: it black-box runs BOTH artifacts — real
// `node`, real stdin, a real socket handshake against a fixture daemon endpoint — across the
// whole event corpus (every whitelisted Claude notification_type, the idle prompt, unknown
// types, Codex blobs well-formed/unknown/malformed, argv-only events, the no-payload path) and
// asserts byte-identical wire events, against a canonical expectation. A codegen/shared-module
// seam for the standalone CLI was considered and declined: the CLI must stay a dependency-free
// single file, and a gate over the shipped bytes catches what a build seam only promises.
//
// Event labels only — no PTY content, no credentials (ADR 0002). No app window is driven; the
// fixture endpoint speaks just enough of the daemon protocol (hello -> welcome, notify ->
// notified) for the scripts' own handshake to complete.

interface CorpusCase {
  name: string
  /** Args AFTER the event verb (the CLI gets `notify` prefixed; the generated script none). */
  argv: string[]
  /** Piped to stdin then closed; undefined = stdin closed immediately (no payload). */
  stdin?: string
  /** The one wire event both artifacts must send — null = both must stay SILENT. */
  expected: string | null
}

const claude = (notification_type: string): string =>
  JSON.stringify({ hook_event_name: 'Notification', notification_type, message: 'never read' })

const CORPUS: CorpusCase[] = [
  // Plain argv events — the hook wiring's bread and butter.
  { name: 'argv-done', argv: ['--event', 'done'], expected: 'done' },
  { name: 'argv-turn-start', argv: ['--event', 'turn-start'], expected: 'turn-start' },
  { name: 'argv-subagent-start', argv: ['--event', 'subagent-start'], expected: 'subagent-start' },
  { name: 'argv-subagent-stop', argv: ['--event', 'subagent-stop'], expected: 'subagent-stop' },
  // The audit-G1/G2 events (PostToolBatch/AfterTool/PostToolUse -> busy; StopFailure/
  // session.error -> turn-failed) must ride BOTH artifacts untouched.
  { name: 'argv-busy', argv: ['--event', 'busy'], expected: 'busy' },
  { name: 'argv-turn-failed', argv: ['--event', 'turn-failed'], expected: 'turn-failed' },
  { name: 'argv-needs-input-no-payload', argv: ['--event', 'needs-input'], expected: 'needs-input' },
  // Claude's multiplexed Notification hook — the stdin discriminator.
  { name: 'claude-permission', argv: ['--event', 'needs-input'], stdin: claude('permission_prompt'), expected: 'needs-input' },
  { name: 'claude-elicitation', argv: ['--event', 'needs-input'], stdin: claude('elicitation_dialog'), expected: 'needs-input' },
  { name: 'claude-idle-prompt', argv: ['--event', 'needs-input'], stdin: claude('idle_prompt'), expected: 'idle-prompt' },
  { name: 'claude-completed-silent', argv: ['--event', 'needs-input'], stdin: claude('agent_completed'), expected: null },
  { name: 'claude-auth-silent', argv: ['--event', 'needs-input'], stdin: claude('auth_success'), expected: null },
  // THE DRIFT (2026-07-15 class): an unknown type is a guess -> `notice`, never a red latch.
  { name: 'claude-unknown-type', argv: ['--event', 'needs-input'], stdin: claude('goal_achieved'), expected: 'notice' },
  { name: 'claude-type-fallback', argv: ['--event', 'needs-input'], stdin: JSON.stringify({ type: 'permission_prompt' }), expected: 'needs-input' },
  // Codex hands its event as a JSON blob.
  { name: 'codex-turn-complete', argv: ['--event', '{"type":"agent-turn-complete","turn-id":"t1"}'], expected: 'done' },
  { name: 'codex-approval', argv: ['--event', '{"type":"approval-requested"}'], expected: 'needs-input' },
  // THE DRIFT again: an unknown Codex type, and an unreadable blob, are guesses too.
  { name: 'codex-unknown-type', argv: ['--event', '{"type":"model-context-window-exceeded"}'], expected: 'notice' },
  { name: 'codex-malformed-blob', argv: ['--event', '{not json'], expected: 'notice' }
]

interface Fixture {
  endpointFile: string
  events: string[]
  close(): void
}

/** Just enough daemon: hello -> welcome, notify -> notified (captured), line-framed JSON. */
function startFixtureEndpoint(dir: string): Promise<Fixture> {
  const address =
    process.platform === 'win32' ? `\\\\.\\pipe\\mogging-notifyparity-${process.pid}` : join(dir, 'parity.sock')
  const events: string[] = []
  const server = net.createServer((sock) => {
    sock.setEncoding('utf8')
    let buf = ''
    sock.on('data', (chunk: string) => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (!line) continue
        let m: { t?: string; event?: unknown }
        try {
          m = JSON.parse(line) as { t?: string; event?: unknown }
        } catch {
          continue
        }
        if (m.t === 'hello') sock.write(JSON.stringify({ t: 'welcome' }) + '\n')
        else if (m.t === 'notify') {
          events.push(String(m.event))
          sock.write(JSON.stringify({ t: 'notified', ok: true }) + '\n')
        }
      }
    })
    sock.on('error', () => {})
  })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(address, () => {
      const endpointFile = join(dir, 'endpoint.json')
      writeFileSync(endpointFile, JSON.stringify({ address, version: 1, token: 'parity-token' }))
      resolve({ endpointFile, events, close: () => server.close() })
    })
  })
}

/** Run one artifact for one case; resolve to the wire event it produced (null = silent). */
function runArtifact(scriptArgs: string[], c: CorpusCase, endpointFile: string, events: string[]): Promise<string | null> {
  const before = events.length
  return new Promise((resolve, reject) => {
    const p = spawn('node', [...scriptArgs, ...c.argv], {
      env: { ...process.env, MOGGING_PANE_ID: '7', MOGGING_DAEMON_ENDPOINT: endpointFile },
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true
    })
    // Both scripts carry their own 4s never-hang timers; this is the smoke's backstop.
    const guard = setTimeout(() => {
      try {
        p.kill()
      } catch {
        /* already gone */
      }
      reject(new Error(`${c.name}: artifact did not exit`))
    }, 8000)
    p.on('error', (e) => {
      clearTimeout(guard)
      reject(e)
    })
    p.on('exit', () => {
      clearTimeout(guard)
      // The scripts exit only after the `notified` reply (or without connecting at all), so
      // the capture is already in `events`; one beat for the last socket flush.
      void sleep(50).then(() => resolve(events.length > before ? (events[events.length - 1] ?? null) : null))
    })
    if (c.stdin !== undefined) p.stdin.write(c.stdin)
    p.stdin.end()
  })
}

export function runNotifyParitySmoke(): void {
  setTimeout(() => app.exit(1), 110000) // safety net: 2 artifacts x 16 serial process spawns
  const run = async (): Promise<void> => {
    interface Row {
      name: string
      expected: string | null
      cli: string | null
      generated: string | null
      ok: boolean
    }
    let result: { pass: boolean; rows?: Row[]; error?: string } = { pass: false }
    let fixture: Fixture | null = null
    try {
      const dir = join(tmpdir(), `mogging-notifyparity-${process.pid}`)
      mkdirSync(dir, { recursive: true })
      // The GENERATED artifact, from the same export main writes to userData on every start.
      const generatedScript = join(dir, 'notify.mjs')
      writeFileSync(generatedScript, NOTIFY_HOOK_SOURCE)
      const cliScript = join(process.cwd(), 'bin', 'mogging.mjs')
      fixture = await startFixtureEndpoint(dir)

      const rows: Row[] = []
      for (const c of CORPUS) {
        // Serial on purpose: one shared capture list, unambiguous attribution per run.
        const cli = await runArtifact([cliScript, 'notify'], c, fixture.endpointFile, fixture.events)
        const generated = await runArtifact([generatedScript], c, fixture.endpointFile, fixture.events)
        rows.push({ name: c.name, expected: c.expected, cli, generated, ok: cli === c.expected && generated === c.expected })
      }
      result = { pass: rows.every((r) => r.ok), rows }
    } catch (e) {
      result = { pass: false, error: String(e) }
    } finally {
      fixture?.close()
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'notifyparity-result.json'), JSON.stringify(result, null, 1))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }
  void run()
}
