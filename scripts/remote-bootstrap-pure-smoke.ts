import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { remoteBootstrapCommand } from '../src/pty-daemon/session'

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message)
}

function posixShell(): string {
  const candidates =
    process.platform === 'win32'
      ? [
          process.env.MOGGING_TEST_POSIX_SHELL,
          join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
          join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', 'bash.exe'),
          'C:\\Program Files\\Git\\usr\\bin\\bash.exe'
        ]
      : [process.env.MOGGING_TEST_POSIX_SHELL, '/bin/bash', '/usr/bin/bash', '/bin/sh']
  const shell = candidates.find((candidate): candidate is string => !!candidate && existsSync(candidate))
  if (!shell) throw new Error('no POSIX shell is available for the remote-bootstrap gate')
  return shell
}

function run(
  shell: string,
  args: string[],
  opts: Partial<SpawnSyncOptionsWithStringEncoding> = {}
): ReturnType<typeof spawnSync> {
  return spawnSync(shell, args, {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    ...opts
  })
}

function requireSuccess(label: string, result: ReturnType<typeof spawnSync>): void {
  if (!result.error && result.status === 0) return
  const detail = String(result.error?.message ?? result.stderr ?? result.stdout ?? '').trim()
  throw new Error(`${label} failed${detail ? `: ${detail}` : ''}`)
}

function withoutInheritedGitTrace(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env }
  for (const key of Object.keys(clean)) {
    if (key.toLocaleUpperCase('en-US') === 'GIT_TRACE_SETUP') delete clean[key]
  }
  return clean
}

function main(): void {
  const shell = posixShell()
  const suffix = `${process.pid}-${Date.now()}`
  const home = process.platform === 'win32'
    ? `/tmp/mogging-remote-bootstrap-pure-${suffix}`
    : join(tmpdir(), `mogging-remote-bootstrap-pure-${suffix}`)
  assert(basename(home).startsWith('mogging-remote-bootstrap-pure-'), 'unsafe bootstrap test HOME')
  const requested = `${home}/work trees/O'Reilly`
  const remoteShell = process.platform === 'win32' || /bash(?:\.exe)?$/i.test(shell) ? '/bin/bash' : shell
  const env = withoutInheritedGitTrace({
    ...process.env,
    HOME: home,
    SHELL: remoteShell,
    ENV: `${home}/user-env`
  })
  const cwdMarker = 'printf \'%s\\n\' "$PWD" > "$HOME/bootstrap-cwd.txt"\n'

  try {
    requireSuccess('fixture mkdir', run(shell, ['-c', 'mkdir -p -- "$1" "$2"', '_', home, requested], { env }))
    requireSuccess(
      'bash rc fixture',
      run(shell, ['-c', 'cat > "$1"', '_', `${home}/.bashrc`], { env, input: cwdMarker })
    )
    requireSuccess(
      'sh ENV fixture',
      run(shell, ['-c', 'cat > "$1"', '_', `${home}/user-env`], { env, input: cwdMarker })
    )

    const bootstrap = remoteBootstrapCommand(requested)
    assert(bootstrap.length < 30_000, `remote bootstrap exceeds command budget: ${bootstrap.length}`)
    assert(
      bootstrap.includes('MOGGING_CONTEXT_MONITOR_EOF') && bootstrap.includes('cat >'),
      'monitor is not transported as a literal here-document'
    )
    assert(!bootstrap.includes('decode64'), 'remote bootstrap regained a decoder dependency')
    requireSuccess('bootstrap syntax', run(shell, ['-n'], { env, input: bootstrap }))
    requireSuccess('bootstrap execution', run(shell, ['-c', 'eval "$(cat)"'], { env, input: bootstrap }))

    const verify = [
      'set -eu',
      'test -x "$HOME/.cache/mogginglabs/pty/bin/mogging"',
      'test -x "$HOME/.cache/mogginglabs/pty/bin/.context-monitor"',
      'test -r "$HOME/.cache/mogginglabs/pty/bin/bashrc"',
      'test -r "$HOME/.cache/mogginglabs/pty/bin/zdot/.zshrc"',
      'test -r "$HOME/.cache/mogginglabs/pty/bin/envrc"',
      'grep -q MoggingCwdRaw "$HOME/.cache/mogginglabs/pty/bin/mogging"',
      'grep -q MoggingProcessCwdRaw "$HOME/.cache/mogginglabs/pty/bin/.context-monitor"',
      'grep -q MoggingGitCwdRaw "$HOME/.cache/mogginglabs/pty/bin/.context-monitor"',
      'test "$(cat "$HOME/bootstrap-cwd.txt")" = "$1"'
    ].join('\n')
    requireSuccess('installed bootstrap verification', run(shell, ['-c', verify, '_', requested], { env }))
    process.stdout.write(JSON.stringify({ pass: true, commandBytes: bootstrap.length, shell }) + '\n')
  } finally {
    run(shell, ['-c', 'rm -rf -- "$1"', '_', home], { env })
  }
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
}
