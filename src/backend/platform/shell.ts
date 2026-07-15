import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'

/** The user's login shell, so their profile + PATH load (agent CLIs need it).
 *  Windows resolves COMSPEC first — `cmd.exe` on a stock install, which is the story
 *  shell-quote.ts documents and quotes for. The fallback (COMSPEC unset is a broken
 *  environment, not a real one) matches that story rather than telling a second one. */
export function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC || 'cmd.exe'
  return process.env.SHELL || '/bin/zsh'
}

/** Normal login-shell arguments for non-pane background terminals such as installers. */
export function shellArgs(): string[] {
  return process.platform === 'win32' ? [] : ['-l']
}

export interface PaneShellLaunch {
  args: string[]
  env: Record<string, string>
  /** Private path-only Git setup trace owned by this pane, when not reserved by the user. */
  gitTraceFile?: string
}

const shq = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`
const psq = (value: string): string => `'${value.replace(/'/g, "''")}'`
const fishq = (value: string): string => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

function shellName(shell: string): string {
  return basename(shell.trim()).replace(/\.exe$/i, '').toLowerCase()
}

function hasInheritedEnv(inherited: NodeJS.ProcessEnv, name: string): boolean {
  if (process.platform !== 'win32') return Object.prototype.hasOwnProperty.call(inherited, name)
  const folded = name.toLocaleUpperCase('en-US')
  return Object.keys(inherited).some((key) => key.toLocaleUpperCase('en-US') === folded)
}

function writePrivate(file: string, contents: string): void {
  writeFileSync(file, contents, { encoding: 'utf8', mode: 0o600 })
  if (process.platform !== 'win32') chmodSync(file, 0o600)
}

function integrationDir(env: NodeJS.ProcessEnv): { root: string; bin: string } | null {
  const cli = env.MOGGING_CLI
  if (!cli || !isAbsolute(cli)) return null
  const bin = dirname(cli)
  const root = join(bin, '.shell-integration', String(process.pid))
  mkdirSync(root, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') chmodSync(root, 0o700)
  return { root, bin }
}

/**
 * A prompt hook must never put a control byte from a legal POSIX filename inside an OSC.
 * Invalid/oversized paths still emit the prompt-only frame, which retires an agent declaration.
 */
function posixPromptFunction(): string {
  return [
    '__mogging_prompt_cwd() {',
    '  __mogging_p=$PWD',
    "  __mogging_clean=$(printf '%s' \"$__mogging_p\" | LC_ALL=C tr -d '\\000-\\037\\177')",
    '  if [ "$__mogging_clean" = "$__mogging_p" ] && [ "${#__mogging_p}" -le 4096 ]; then',
    "    printf '\\033]633;P;MoggingPromptCwdRaw=%s\\033\\\\' \"$__mogging_p\" > /dev/tty 2>/dev/null || :",
    '  else',
    "    printf '\\033]633;P;MoggingPrompt\\033\\\\' > /dev/tty 2>/dev/null || :",
    '  fi',
    '  unset __mogging_p __mogging_clean',
    '}'
  ].join('\n')
}

function bashLaunch(root: string, bin: string): PaneShellLaunch {
  const rc = join(root, 'bashrc')
  writePrivate(
    rc,
    [
      '# MoggingLabs pane startup: reproduce an interactive login before installing the hook.',
      '[ -r /etc/profile ] && . /etc/profile',
      'if [ -r "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile"',
      'elif [ -r "$HOME/.bash_login" ]; then . "$HOME/.bash_login"',
      'elif [ -r "$HOME/.profile" ]; then . "$HOME/.profile"; fi',
      `PATH=${shq(bin)}:\${PATH-}`,
      'MOGGING_PTY=1; export PATH MOGGING_PTY',
      posixPromptFunction(),
      'case "$(declare -p PROMPT_COMMAND 2>/dev/null)" in',
      '  "declare -a"*) PROMPT_COMMAND=(__mogging_prompt_cwd "${PROMPT_COMMAND[@]}") ;;',
      '  *) PROMPT_COMMAND="__mogging_prompt_cwd${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;',
      'esac',
      ''
    ].join('\n')
  )
  return { args: ['--noprofile', '--rcfile', rc, '-i'], env: { MOGGING_PTY: '1' } }
}

function shLaunch(root: string, bin: string, inherited: NodeJS.ProcessEnv): PaneShellLaunch {
  const rc = join(root, 'shrc')
  const originalEnv = inherited.ENV && inherited.ENV !== rc ? inherited.ENV : ''
  writePrivate(
    rc,
    [
      '# MoggingLabs pane startup: POSIX login files, then the normal interactive ENV file.',
      '[ -r /etc/profile ] && . /etc/profile',
      '[ -r "$HOME/.profile" ] && . "$HOME/.profile"',
      originalEnv ? `[ -r ${shq(originalEnv)} ] && . ${shq(originalEnv)}` : ':',
      `PATH=${shq(bin)}:\${PATH-}`,
      'MOGGING_PTY=1; export PATH MOGGING_PTY',
      posixPromptFunction(),
      "PS1='$(__mogging_prompt_cwd)'\"${PS1-\\$ }\"",
      ''
    ].join('\n')
  )
  return { args: ['-i'], env: { ENV: rc, MOGGING_PTY: '1' } }
}

function zshLaunch(root: string, bin: string, inherited: NodeJS.ProcessEnv): PaneShellLaunch {
  const zdot = join(root, 'zdot')
  mkdirSync(zdot, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') chmodSync(zdot, 0o700)
  const original = inherited.ZDOTDIR || inherited.HOME || homedir()
  const common = [
    `typeset -g MOGGING_INTEGRATION_ZDOTDIR=${shq(zdot)}`,
    `[[ -n \${MOGGING_USER_ZDOTDIR-} ]] || typeset -g MOGGING_USER_ZDOTDIR=${shq(original)}`
  ].join('\n')
  const capture = [
    'if [[ -n ${ZDOTDIR-} && "$ZDOTDIR" != "$MOGGING_INTEGRATION_ZDOTDIR" ]]; then',
    '  MOGGING_USER_ZDOTDIR="$ZDOTDIR"',
    'fi',
    'ZDOTDIR="$MOGGING_INTEGRATION_ZDOTDIR"',
    'export ZDOTDIR'
  ].join('\n')
  for (const name of ['.zshenv', '.zprofile', '.zshrc']) {
    writePrivate(
      join(zdot, name),
      [common, `[[ -r "$MOGGING_USER_ZDOTDIR/${name}" ]] && source "$MOGGING_USER_ZDOTDIR/${name}"`, capture, ''].join('\n')
    )
  }
  writePrivate(
    join(zdot, '.zlogin'),
    [
      common,
      '[[ -r "$MOGGING_USER_ZDOTDIR/.zlogin" ]] && source "$MOGGING_USER_ZDOTDIR/.zlogin"',
      capture,
      `PATH=${shq(bin)}:\${PATH-}`,
      'MOGGING_PTY=1; export PATH MOGGING_PTY',
      posixPromptFunction(),
      'autoload -Uz add-zsh-hook 2>/dev/null',
      'if (( $+functions[add-zsh-hook] )); then',
      '  add-zsh-hook precmd __mogging_prompt_cwd',
      'else',
      '  precmd_functions=(__mogging_prompt_cwd ${precmd_functions:#__mogging_prompt_cwd})',
      'fi',
      'ZDOTDIR="$MOGGING_USER_ZDOTDIR"',
      'export ZDOTDIR',
      'unset MOGGING_INTEGRATION_ZDOTDIR MOGGING_USER_ZDOTDIR',
      ''
    ].join('\n')
  )
  return { args: ['-l'], env: { ZDOTDIR: zdot, MOGGING_PTY: '1' } }
}

function powershellLaunch(bin: string): PaneShellLaunch {
  const command = [
    '$global:__MoggingOriginalPrompt=(Get-Item Function:prompt).ScriptBlock',
    `$env:PATH=${psq(bin + ';')}+$env:PATH`,
    '$env:MOGGING_PTY="1"',
    'function global:prompt {',
    '  try {',
    '    $p=$executionContext.SessionState.Path.CurrentLocation.ProviderPath',
    '    $e=[char]27',
    '    if ($p -and $p.Length -le 4096 -and $p -notmatch "[\\x00-\\x1f\\x7f]") {',
    '      [Console]::Out.Write("$e]633;P;MoggingPromptCwdRaw=$p$e\\")',
    '    } else { [Console]::Out.Write("$e]633;P;MoggingPrompt$e\\") }',
    '  } catch {}',
    '  & $global:__MoggingOriginalPrompt',
    '}'
  ].join(';')
  return { args: ['-NoExit', '-Command', command], env: { MOGGING_PTY: '1' } }
}

function fishLaunch(bin: string): PaneShellLaunch {
  const command = [
    `set -gx PATH ${fishq(bin)} $PATH`,
    'set -gx MOGGING_PTY 1',
    'function __mogging_prompt_cwd --on-event fish_prompt',
    '  set -l p $PWD',
    '  if test (string length -- "$p") -le 4096; and not string match -qr \'[[:cntrl:]]\' -- "$p"',
    "    printf '\\033]633;P;MoggingPromptCwdRaw=%s\\007' \"$p\" > /dev/tty 2>/dev/null",
    '  else',
    "    printf '\\033]633;P;MoggingPrompt\\007' > /dev/tty 2>/dev/null",
    '  end',
    'end'
  ].join('; ')
  // fish's init command runs after its normal login + interactive configuration.
  return { args: ['--login', '--init-command', command], env: { MOGGING_PTY: '1' } }
}

/**
 * Prepare a pane shell after the CLI runtime exists. Shell startup files run normally, then the
 * private runtime bin is re-prepended and an invisible prompt+CWD frame is installed. This is
 * provider-neutral: any foreground CLI can declare a cwd, and its next shell prompt retires it.
 */
export function paneShellLaunch(
  shell: string = defaultShell(),
  inherited: NodeJS.ProcessEnv = process.env,
  paneInstance?: string
): PaneShellLaunch {
  const base = shellName(shell)
  const runtime = integrationDir(inherited)
  let launch: PaneShellLaunch
  if (process.platform === 'win32') {
    if (base === 'cmd') launch = { args: [], env: shellIntegrationEnv(shell, inherited) }
    else if ((base === 'powershell' || base === 'pwsh') && runtime) launch = powershellLaunch(runtime.bin)
    else launch = { args: [], env: {} }
  } else if (!runtime) {
    launch = { args: ['-l'], env: {} }
  } else if (base === 'bash') {
    launch = bashLaunch(runtime.root, runtime.bin)
  } else if (base === 'zsh') {
    launch = zshLaunch(runtime.root, runtime.bin, inherited)
  } else if (base === 'fish') {
    launch = fishLaunch(runtime.bin)
  } else if (base === 'sh' || base === 'dash' || base === 'ksh' || base === 'mksh') {
    launch = shLaunch(runtime.root, runtime.bin, inherited)
  } else {
    launch = { args: ['-l'], env: {} }
  }

  if (
    runtime &&
    paneInstance &&
    !hasInheritedEnv(inherited, 'GIT_TRACE_SETUP')
  ) {
    const safe = paneInstance.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 160)
    if (safe) {
      const gitTraceFile = join(runtime.root, `git-${safe}.trace`)
      try {
        writePrivate(gitTraceFile, '')
        return {
          ...launch,
          env: { ...launch.env, GIT_TRACE_SETUP: gitTraceFile },
          gitTraceFile
        }
      } catch {
        // CWD inference remains available from shell/process evidence.
      }
    }
  }
  return launch
}

/** cmd.exe exposes its only prompt hook through %PROMPT%; preserve the user's visible prompt. */
export function shellIntegrationEnv(
  shell: string = defaultShell(),
  inherited: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  if (process.platform !== 'win32' || shellName(shell) !== 'cmd') return {}
  const base = inherited.PROMPT || '$P$G'
  return { PROMPT: '$e]9;9;$p$e\\$e]7;file:///$p$e\\' + base, MOGGING_PTY: '1' }
}
