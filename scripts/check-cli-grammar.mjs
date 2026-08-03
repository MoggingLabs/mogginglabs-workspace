#!/usr/bin/env node
// The `mogging` CLI's OBSERVABLE contract, exercised against the real binary.
//
// tests/unit/cli-core.test.ts pins the grammar as a pure function. This pins that the grammar
// is WIRED, and that the parts a script actually depends on hold: exit codes, which stream
// carries which output, and that a broken runtime file never becomes a stack trace.
//
// bin/ had no coverage of any kind. Four defects lived there:
//
//   - any unknown verb fell through to `runOpen`, cold-starting the GUI on a directory that
//     does not exist and exiting 0. A typo and a success were indistinguishable to a script.
//   - `--dev` was filtered out of the ENTIRE argv, so `mogging send 1 --dev` could never type
//     that literal into a pane, and retargeted the dev daemon instead.
//   - `--help` wrote the banner to stderr, so `mogging --help | less` showed nothing.
//   - a parseable-but-wrong-shaped endpoint.json reached `net.connect(undefined)`, which
//     throws SYNCHRONOUSLY — past every `sock.on('error')` handler — as a raw node:net stack
//     trace, including out of the `mogging notify` hook that must never fail its agent.
//
// Runs the CLI in a sandboxed runtime base so it can never see, or touch, a live daemon.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dirname, '..')
const CLI = join(REPO, 'bin', 'mogging.mjs')

const PV = readFileSync(CLI, 'utf8').match(/const PROTOCOL_VERSION = (\d+)/)?.[1]
if (!PV) {
  console.error('FAIL could not read PROTOCOL_VERSION from bin/mogging.mjs')
  process.exit(1)
}

const sandbox = mkdtempSync(join(tmpdir(), 'cligram-'))
const runDir = (seg) => join(sandbox, 'MoggingLabs', 'run', seg)
mkdirSync(runDir(`v${PV}`), { recursive: true })
mkdirSync(runDir(`dev-v${PV}`), { recursive: true })

// runtime-paths.mjs derives its base from LOCALAPPDATA on win32 and XDG_RUNTIME_DIR elsewhere.
// Set both: the gate must sandbox the CLI on whichever platform it runs.
const BASE_ENV = { LOCALAPPDATA: sandbox, XDG_RUNTIME_DIR: sandbox, HOME: sandbox }

let failed = 0
const fail = (what, detail) => {
  console.error(`FAIL ${what}\n     ${detail}`)
  failed++
}

const run = (args, extraEnv = {}) => {
  const env = { ...process.env, ...BASE_ENV, ...extraEnv }
  // Strip the dev-pane inheritance, or every row runs on the dev channel.
  delete env.MOGGING_CHANNEL
  if (!('MOGGING_DAEMON_ENDPOINT' in extraEnv)) delete env.MOGGING_DAEMON_ENDPOINT
  const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', input: '', timeout: 20000 })
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' }
}

const STACK = /node:net|ERR_MISSING_ARGS|ERR_INVALID_ARG|at Socket\.connect|^\s+at .*\(node:/m

// ---- grammar ------------------------------------------------------------------------------
// A well-SHAPED but unreachable dev endpoint: accepted at the read, fails at connect. That
// makes "reached the dev channel" observable without any daemon, and distinguishable from the
// prod channel's "no daemon endpoint found".
const unreachable = process.platform === 'win32' ? '\\\\.\\pipe\\mogging-gate-absent' : join(sandbox, 'absent.sock')
writeFileSync(join(runDir(`dev-v${PV}`), 'endpoint.json'), JSON.stringify({ address: unreachable, token: 'x' }))

const NO_PROD = /no daemon endpoint found/

{
  const r = run(['clam'])
  if (r.code !== 2) fail('unknown verb must exit 2', `got ${r.code}; a typo must not look like a success`)
  if (!/unknown command/.test(r.err)) fail('unknown verb must name the command on stderr', JSON.stringify(r.err.slice(0, 120)))
  if (r.out !== '') fail('unknown verb must write nothing to stdout', JSON.stringify(r.out.slice(0, 120)))
}
{
  const r = run(['--help'])
  if (r.code !== 0) fail('--help must exit 0', `got ${r.code}`)
  if (r.out.length < 200) fail('--help banner must go to STDOUT', `stdout was ${r.out.length} bytes`)
  if (r.err !== '') fail('--help must leave stderr empty', JSON.stringify(r.err.slice(0, 120)))
}
{
  const r = run([])
  if (r.code !== 2) fail('bare `mogging` must exit 2', `got ${r.code}`)
  if (r.out !== '') fail('bare `mogging` must not put usage on stdout', 'usage on the error path belongs on stderr')
}
{
  const r = run(['--dev', 'list'])
  if (NO_PROD.test(r.err)) fail('leading --dev must reach the dev channel', 'it read the PROD endpoint instead')
}
for (const args of [
  ['list', '--dev'],
  ['list', '--', '--dev'],
  ['send', '1', '--dev']
]) {
  const r = run(args)
  if (!NO_PROD.test(r.err)) {
    fail(`\`mogging ${args.join(' ')}\` must stay on the PROD channel`, '--dev after the flag region is PAYLOAD, not a flag')
  }
}
{
  const r = run([join(sandbox, 'definitely-not-here')])
  if (r.code !== 2) fail('a missing directory must exit 2', `got ${r.code}; it announced a workspace over nothing`)
  if (/opening workspace/.test(r.out)) fail('a missing directory must not claim to open a workspace', r.out.trim())
}
{
  const r = run([join(REPO, 'scripts')])
  if (r.code !== 0) fail('a real directory must still open', `got ${r.code} — the check ate the feature`)
  if (!/opening workspace/.test(r.out)) fail('a real directory must announce the workspace', JSON.stringify(r.out.slice(0, 120)))
}

// ---- malformed endpoints ------------------------------------------------------------------
// Every shape a crashing or older daemon can leave behind that still parses as JSON.
const SHAPES = [
  '{"port":59999,"token":"x"}',
  '{"address":null,"token":"x"}',
  '{"address":"","token":"x"}',
  '{"address":123,"token":"x"}',
  '{"address":"/tmp/p"}',
  '[]',
  'null'
]
for (const shape of SHAPES) {
  const epFile = join(runDir(`v${PV}`), 'endpoint.json')
  writeFileSync(epFile, shape)
  writeFileSync(join(runDir(`v${PV}`), 'browser-control.json'), shape)

  for (const args of [['list'], ['capture', '1'], ['usage']]) {
    const r = run(args)
    if (STACK.test(r.err)) fail(`\`mogging ${args.join(' ')}\` crashed on endpoint ${shape}`, r.err.split('\n')[0])
    else if (r.code === 0) fail(`\`mogging ${args.join(' ')}\` exited 0 on endpoint ${shape}`, 'a broken endpoint is not a success')
  }
  // The hook contract is that it never fails its agent, so exit 0 is CORRECT here — what must
  // not happen is a stack trace on the agent's stderr.
  const n = run(['notify', '--event', 'Stop'], { MOGGING_DAEMON_ENDPOINT: epFile })
  if (STACK.test(n.err)) fail(`\`mogging notify\` crashed on endpoint ${shape}`, n.err.split('\n')[0])
}

rmSync(sandbox, { recursive: true, force: true })

if (failed) {
  console.error(`\n${failed} CLI grammar violation(s)`)
  process.exit(1)
}
console.log(`OK cli grammar: 8 invocation rows, ${SHAPES.length} malformed-endpoint shapes x 4 readers`)
