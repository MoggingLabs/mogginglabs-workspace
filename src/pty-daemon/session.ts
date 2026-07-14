// The daemon's terminal multiplexer: it OWNS the node-pty processes and a per-pane
// scrollback ring buffer, and fans output out to any number of attached clients. This is
// purpose-built for the daemon (multi-client + reconnect + scrollback), which is why it
// does not reuse @backend's single-client PtyService. (ADR 0006.)
//
// It also PERSISTS sessions (cwd + command label + scrollback) to a small store, so the
// daemon self-recovers on a cold start / crash and repaints prior scrollback (Phase-1/03).
import * as os from 'node:os'
import * as fs from 'node:fs'
import * as crypto from 'node:crypto'
import { spawnPty, type IPty } from '@backend/platform/pty-host'
import { paneShellLaunch } from '@backend/platform/shell'
import { aiderLogPath } from '@backend/features/context'
import type { Approval, SpawnSpec, PaneInfo, AgentState } from '@contracts'
import { PANE_CWD_MAX, normalizeRemoteConnection, notifyEventToState } from '@contracts'
import {
  ActivityTracker,
  AgentProcessDetector,
  GitContextObserver,
  OscParser,
  PaneCwdState,
  countSubmittedLines,
  fileUriToPath,
  isSubmittedInput,
  isTerminalReply,
  normalizePaneCwd,
  normalizeRemotePaneCwd,
  type CwdReportResult,
  type DetectedAgentProc,
  type DetectedProcessContext,
  type PaneCwdSnapshot
} from '@backend/features/agent-state'
import { SessionStore, resumeCommandFor } from '@backend/features/workspace'
import { Mailbox } from './mailbox'
import { Ledger } from './ledger'
import type { PersistedPane, PersistedWorkspace, WorkspaceLayout } from '@contracts'

const SCROLLBACK_BYTES = 200_000

const posixQuote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`

/** Command executed by ssh only after authentication succeeds. It emits a
 *  private OSC readiness marker, enters the requested target cwd, then becomes
 *  the configured interactive shell. No pane input is sent to an auth prompt. */
/**
 * THE remote command. ssh takes exactly one, and the merge briefly gave it two — the POSIX
 * bootstrap inside `sshArgs` AND a second appended after it. Under the test shim only the first
 * ever ran, so no gate could see it; a real `ssh` would have received both, concatenated.
 *
 * The two halves are not duplicates, they are different features:
 *   - the POSIX bootstrap (remoteBootstrapCommand) stands up the helper dir, the rc files and the
 *     prompt hook that REPORTS the remote cwd back — the whole cwd-tracking feature;
 *   - this dispatcher owns the readiness signal and the WINDOWS dialect (audit finding 9): the
 *     ready OSC is what says "the remote shell is up, past the password/MFA/host-key prompt", and
 *     an agent launch waits on it UNBOUNDED. A bootstrap that never emits it does not fail — it
 *     hangs, forever, which is the worse outcome and the one no gate would have reported.
 * So: one command. Windows keeps its PowerShell script; POSIX defers to the richer bootstrap.
 */
function remoteBootstrap(remote: NonNullable<SpawnSpec['remote']>): string {
  const platform = remote.platform ?? 'posix'
  if (platform === 'windows') {
    const cwd = remote.cwd
      ? `Set-Location -LiteralPath '${remote.cwd.replace(/'/g, "''")}' -ErrorAction Stop; `
      : ''
    const shell = remote.shell === 'cmd' ? '& cmd.exe /K' : '& powershell.exe -NoLogo -NoExit'
    const script = `[Console]::Write([char]27 + ']777;mogging-remote-ready' + [char]7); ${cwd}${shell}`
    return `powershell.exe -NoLogo -NoProfile -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`
  }
  return remoteBootstrapCommand(remote.cwd)
}

/** How far past a fresh cap cut we'll look for a clean line start. */
const TEAR_SCAN = 400

/** A blind `.slice(-SCROLLBACK_BYTES)` can land mid escape sequence or between surrogate
 *  halves, and the reattach repaint then feeds xterm a sequence's tail as literal text (or
 *  a lone surrogate). Drop a split surrogate's low half, then cut forward to the next
 *  newline: at most one partial line of scrollback lost, cheap next to a garbled repaint.
 *  No newline nearby (one giant TUI frame) keeps the tear — same cap semantics either way.
 *  Mirrors trimTornStart in @backend/features/terminal/pty.service.ts. */
function trimTornStart(s: string): string {
  const c0 = s.charCodeAt(0)
  if (c0 >= 0xdc00 && c0 <= 0xdfff) s = s.slice(1)
  const nl = s.indexOf('\n')
  return nl !== -1 && nl < TEAR_SCAN ? s.slice(nl + 1) : s
}

/** The directory a pane's shell starts in: the requested one when it is a real directory,
 *  the home directory otherwise. `''` (no cwd asked for) and a path that has since been
 *  removed both land on home rather than on the daemon's own directory or a spawn error. */
function pickCwd(requested?: string): string {
  if (requested) {
    try {
      if (fs.statSync(requested).isDirectory()) return requested
    } catch {
      /* gone, or not readable — fall through to home */
    }
  }
  return os.homedir()
}

const REMOTE_CWD_SHIM = `#!/bin/sh
if [ "\${1-}" != "cwd" ]; then
  echo "mogging: this remote pane helper supports only: mogging cwd [path]" >&2
  exit 2
fi
shift
if [ "\${1-}" = "--" ]; then shift; fi
if [ "$#" -gt 1 ]; then
  echo "usage: mogging cwd [path]" >&2
  exit 2
fi
p=\${1:-"$PWD"}
raw_clean=$(printf '%s' "$p" | LC_ALL=C tr -d '\\000-\\037\\177')
if [ "$raw_clean" != "$p" ]; then
  echo "mogging cwd: control characters are not supported" >&2
  exit 2
fi
case "$p" in /*) ;; *) p="$PWD/$p" ;; esac
candidate_clean=$(printf '%s' "$p" | LC_ALL=C tr -d '\\000-\\037\\177')
if [ "$candidate_clean" != "$p" ]; then
  echo "mogging cwd: control characters are not supported" >&2
  exit 2
fi
p=$(CDPATH= cd "$p" 2>/dev/null && pwd -L) || {
  echo "mogging cwd: directory does not exist or is not accessible" >&2
  exit 2
}
clean=$(printf '%s' "$p" | LC_ALL=C tr -d '\\000-\\037\\177')
if [ "$clean" != "$p" ]; then
  echo "mogging cwd: control characters are not supported" >&2
  exit 2
fi
if [ "\${#p}" -gt ${PANE_CWD_MAX} ]; then
  echo "mogging cwd: path is too long" >&2
  exit 2
fi
if [ "\${MOGGING_PTY-}" != "1" ] || [ ! -w /dev/tty ]; then
  echo "mogging cwd: not inside a MoggingLabs remote pane" >&2
  exit 3
fi
printf '\\033]633;P;MoggingCwdRaw=%s\\033\\\\' "$p" > /dev/tty || exit 3
echo "mogging: cwd declared via terminal fallback"
`

const posixLiteral = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

/** Embed a literal file/captured value in the POSIX bootstrap without requiring a remote
 * decoder. Quoted here-documents suppress every expansion; the one outer `posixLiteral`
 * below then preserves this complete script through the user's login shell. */
function remoteHereDoc(target: string, delimiter: string, contents: string): string {
  if (contents.split('\n').includes(delimiter)) throw new Error(`Remote here-doc collision: ${delimiter}`)
  return `cat > ${target} <<'${delimiter}'\n${contents}${contents.endsWith('\n') ? '' : '\n'}${delimiter}`
}

function remoteCaptureHereDoc(name: string, delimiter: string, contents: string): string {
  if (contents.split('\n').includes(delimiter)) throw new Error(`Remote here-doc collision: ${delimiter}`)
  return `${name}=$(cat <<'${delimiter}'\n${contents}${contents.endsWith('\n') ? '' : '\n'}${delimiter}\n)`
}

const LOCAL_PANE_CAPABILITIES = new Set([
  'MOGGING_DAEMON_ENDPOINT',
  'MOGGING_BROWSER_ENDPOINT',
  'MOGGING_PANE_ID',
  'MOGGING_PANE_TOKEN'
])

/** Environment keys are case-insensitive on Windows. Delete by normalized name so an
 * inherited or client-supplied casing variant cannot survive into an ssh process. */
function stripLocalPaneCapabilities(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) {
    if (LOCAL_PANE_CAPABILITIES.has(key.toUpperCase())) delete env[key]
  }
}

const REMOTE_PROMPT_FUNCTION = [
  '__mogging_prompt_cwd() {',
  '  __mogging_p=$PWD',
  "  __mogging_clean=$(printf '%s' \"$__mogging_p\" | LC_ALL=C tr -d '\\000-\\037\\177')",
  `  if [ "$__mogging_clean" = "$__mogging_p" ] && [ "\${#__mogging_p}" -le ${PANE_CWD_MAX} ]; then`,
  "    printf '\\033]633;P;MoggingPromptCwdRaw=%s\\033\\\\' \"$__mogging_p\" > /dev/tty 2>/dev/null || :",
  '  else',
  "    printf '\\033]633;P;MoggingPrompt\\033\\\\' > /dev/tty 2>/dev/null || :",
  '  fi',
  '  unset __mogging_p __mogging_clean',
  '}'
].join('\n')

/** Remote panes are POSIX-only, so the far side can provide the same provider-neutral process
 * and Git-worktree evidence as a local POSIX pane. The monitor starts before the interactive
 * shell is exec'd (no visible job-control notification), follows that tty's foreground process
 * group, and emits only pid/path observations. Command lines never cross SSH. */
const REMOTE_CONTEXT_MONITOR = [
  '#!/bin/sh',
  '__mogging_shell_pid=$1',
  '__mogging_last=',
  'trap \'rm -f "${MOGGING_CONTEXT_TRACE-}" 2>/dev/null\' EXIT HUP INT TERM',
  'while kill -0 "$__mogging_shell_pid" 2>/dev/null && [ -w /dev/tty ]; do',
  '  __mogging_git_cwd=',
  '  if [ -n "${MOGGING_CONTEXT_TRACE-}" ] && [ -s "$MOGGING_CONTEXT_TRACE" ]; then',
  "    __mogging_git_cwd=$(awk 'index($0,\"setup: worktree: \"){v=$0;sub(/^.*setup: worktree: /,\"\",v)} END{if(v!=\"(null)\")print v}' \"$MOGGING_CONTEXT_TRACE\" 2>/dev/null)",
  '    : > "$MOGGING_CONTEXT_TRACE" 2>/dev/null || :',
  '  fi',
  '  if [ -n "$__mogging_git_cwd" ]; then',
  "    __mogging_git_clean=$(printf '%s' \"$__mogging_git_cwd\" | LC_ALL=C tr -d '\\000-\\037\\177')",
  `    if [ "$__mogging_git_clean" = "$__mogging_git_cwd" ] && [ "\${#__mogging_git_cwd}" -le ${PANE_CWD_MAX} ]; then`,
  "      printf '\\033]633;P;MoggingGitCwdRaw=%s\\033\\\\' \"$__mogging_git_cwd\" > /dev/tty 2>/dev/null || break",
  '    fi',
  '  fi',
  '  __mogging_groups=$(ps -o pgid=,tpgid= -p "$__mogging_shell_pid" 2>/dev/null)',
  '  set -- $__mogging_groups',
  '  __mogging_shell_pgid=${1-}; __mogging_fg_pgid=${2-}',
  '  case "$__mogging_fg_pgid" in ""|*[!0-9-]*) __mogging_fg_pgid= ;; esac',
  '  __mogging_cwd=; __mogging_pid=',
  '  if [ -n "$__mogging_fg_pgid" ] && [ "$__mogging_fg_pgid" -gt 0 ] 2>/dev/null && [ "$__mogging_fg_pgid" != "$__mogging_shell_pgid" ]; then',
  "    __mogging_pid=$(ps -eo pid=,pgid= 2>/dev/null | awk -v g=\"$__mogging_fg_pgid\" '$2 == g { print $1; exit }')",
  '    case "$__mogging_pid" in ""|*[!0-9]*) __mogging_pid= ;; esac',
  '    if [ -n "$__mogging_pid" ] && [ -e "/proc/$__mogging_pid/cwd" ] && command -v readlink >/dev/null 2>&1; then',
  '      __mogging_cwd=$(readlink "/proc/$__mogging_pid/cwd" 2>/dev/null)',
  '    elif [ -n "$__mogging_pid" ] && command -v lsof >/dev/null 2>&1; then',
  "      __mogging_cwd=$(lsof -a -p \"$__mogging_pid\" -d cwd -Fn 2>/dev/null | awk 'substr($0,1,1) == \"n\" { print substr($0,2); exit }')",
  '    fi',
  '  fi',
  '  if [ -n "$__mogging_pid" ] && [ -n "$__mogging_cwd" ]; then',
  "    __mogging_clean=$(printf '%s' \"$__mogging_cwd\" | LC_ALL=C tr -d '\\000-\\037\\177')",
  `    if [ "$__mogging_clean" = "$__mogging_cwd" ] && [ "\${#__mogging_cwd}" -le ${PANE_CWD_MAX} ]; then`,
  '      __mogging_key="$__mogging_pid:$__mogging_cwd"',
  '      if [ "$__mogging_key" != "$__mogging_last" ]; then',
  "        printf '\\033]633;P;MoggingProcessCwdRaw=%s;%s\\033\\\\' \"$__mogging_pid\" \"$__mogging_cwd\" > /dev/tty 2>/dev/null || break",
  '        __mogging_last=$__mogging_key',
  '      fi',
  '    fi',
  '  else',
  '    __mogging_last=',
  '  fi',
  '  sleep 5',
  'done',
  ''
].join('\n')

const REMOTE_CONTEXT_MONITOR_START = '"$MOGGING_HELPER_DIR/.context-monitor" "$$" </dev/null >/dev/null 2>&1 &\n'

/** Install a capability-free cwd reporter under an owner-only HOME path, then run login
 * initialization before prepending it. The marker and PATH therefore survive profile scripts. */
/** The readiness signal as a POSIX printf — the same OSC `REMOTE_READY_OSC` names in @contracts,
 *  spelled for a remote /bin/sh. See remoteBootstrap for why it is not optional. */
const READY_OSC_PRINTF = `printf '\\033]777;mogging-remote-ready\\007'`

export function remoteBootstrapCommand(cwd?: string): string {
  const bashRc = [
    'if [ -r "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi',
    'PATH="$MOGGING_FINAL_PATH"; MOGGING_PTY=1; export PATH MOGGING_PTY',
    REMOTE_PROMPT_FUNCTION,
    'case "$(declare -p PROMPT_COMMAND 2>/dev/null)" in',
    '  "declare -a"*) PROMPT_COMMAND=(__mogging_prompt_cwd "${PROMPT_COMMAND[@]}") ;;',
    '  *) PROMPT_COMMAND="__mogging_prompt_cwd${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;',
    'esac',
    'unset MOGGING_FINAL_PATH MOGGING_HELPER_DIR',
    ''
  ].join('\n')
  const zshRc = [
    'if [ -r "$MOGGING_ORIG_ZDOTDIR/.zshrc" ]; then . "$MOGGING_ORIG_ZDOTDIR/.zshrc"; fi',
    'PATH="$MOGGING_FINAL_PATH"; MOGGING_PTY=1; export PATH MOGGING_PTY',
    REMOTE_PROMPT_FUNCTION,
    'autoload -Uz add-zsh-hook 2>/dev/null',
    'if (( $+functions[add-zsh-hook] )); then add-zsh-hook precmd __mogging_prompt_cwd',
    'else precmd_functions=(__mogging_prompt_cwd ${precmd_functions:#__mogging_prompt_cwd}); fi',
    'ZDOTDIR="$MOGGING_ORIG_ZDOTDIR"; export ZDOTDIR',
    'unset MOGGING_FINAL_PATH MOGGING_HELPER_DIR MOGGING_ORIG_ZDOTDIR',
    ''
  ].join('\n')
  const shRc = [
    'if [ -n "${MOGGING_ORIG_ENV-}" ] && [ -r "$MOGGING_ORIG_ENV" ]; then . "$MOGGING_ORIG_ENV"; fi',
    'PATH="$MOGGING_FINAL_PATH"; MOGGING_PTY=1; export PATH MOGGING_PTY',
    REMOTE_PROMPT_FUNCTION,
    'PS1=\'$(__mogging_prompt_cwd)\'"${PS1-\\$ }"',
    'unset MOGGING_FINAL_PATH MOGGING_HELPER_DIR MOGGING_ORIG_ENV',
    ''
  ].join('\n')
  const fishInit = [
    'set -gx PATH "$HOME/.cache/mogginglabs/pty/bin" $PATH',
    'set -gx MOGGING_PTY 1',
    'function __mogging_prompt_cwd --on-event fish_prompt',
    '  set -l p $PWD',
    `  if test (string length -- "$p") -le ${PANE_CWD_MAX}; and not string match -qr '[[:cntrl:]]' -- "$p"`,
    "    printf '\\033]633;P;MoggingPromptCwdRaw=%s\\007' \"$p\" > /dev/tty 2>/dev/null",
    '  else',
    "    printf '\\033]633;P;MoggingPrompt\\007' > /dev/tty 2>/dev/null",
    '  end',
    'end'
  ].join('; ')
  const interactive = (
    REMOTE_CONTEXT_MONITOR_START +
      'export MOGGING_PTY=1; ' +
      'PATH="$MOGGING_HELPER_DIR:$PATH"; export PATH; ' +
      'requested=${MOGGING_REQUESTED_CWD-}; unset MOGGING_REQUESTED_CWD; ' +
      'case "$requested" in "~") requested="$HOME" ;; "~/"*) requested="$HOME/${requested#~/}" ;; esac; ' +
      'if [ -n "$requested" ]; then CDPATH= cd "$requested" || { echo "mogging: remote working directory is unavailable" >&2; exit 72; }; fi; ' +
      'shell="${SHELL:-/bin/sh}"; MOGGING_FINAL_PATH="$PATH"; export MOGGING_FINAL_PATH; ' +
      'case "${shell##*/}" in ' +
      'bash) exec "$shell" --noprofile --rcfile "$MOGGING_HELPER_DIR/bashrc" -i ;; ' +
      'zsh) orig="${ZDOTDIR:-$HOME}"; export MOGGING_ORIG_ZDOTDIR="$orig" ZDOTDIR="$MOGGING_HELPER_DIR/zdot"; exec "$shell" -i ;; ' +
      '*) old_env="${ENV-}"; export MOGGING_ORIG_ENV="$old_env"; ENV="$MOGGING_HELPER_DIR/envrc"; export ENV; exec "$shell" -i ;; esac'
  )
  const bootstrap = [
    'umask 077',
    'case "${HOME-}" in /*) ;; *) echo "mogging: remote HOME is unavailable" >&2; exit 72 ;; esac',
    'shell="${SHELL:-/bin/sh}"',
    'case "${shell##*/}" in sh|bash|dash|ksh|zsh|fish) ;; *) echo "mogging: remote shell is not supported" >&2; exit 72 ;; esac',
    'secure_dir() { if [ -e "$1" ]; then [ -d "$1" ] && [ ! -L "$1" ] && [ -O "$1" ] || return 1; else mkdir "$1" || return 1; fi; chmod 700 "$1"; }',
    'cache="$HOME/.cache"; root="$cache/mogginglabs"; pty="$root/pty"; d="$pty/bin"; zd="$d/zdot"',
    'secure_dir "$cache" && secure_dir "$root" && secure_dir "$pty" && secure_dir "$d" && secure_dir "$zd" || { echo "mogging: remote helper directory is not owner-controlled" >&2; exit 72; }',
    'trace="$pty/context.$$"; : > "$trace" && chmod 600 "$trace" || exit 72',
    'export MOGGING_CONTEXT_TRACE="$trace"',
    'if [ -z "${GIT_TRACE_SETUP+x}" ]; then export GIT_TRACE_SETUP="$trace"; fi',
    'tmp="$d/.mogging.$$"',
    remoteHereDoc('"$tmp"', 'MOGGING_CWD_SHIM_EOF', REMOTE_CWD_SHIM),
    '[ "$?" -eq 0 ] && chmod 700 "$tmp" && mv -f "$tmp" "$d/mogging" || { rm -f "$tmp"; exit 72; }',
    'mtmp="$d/.context-monitor.$$"',
    remoteHereDoc('"$mtmp"', 'MOGGING_CONTEXT_MONITOR_EOF', REMOTE_CONTEXT_MONITOR),
    '[ "$?" -eq 0 ] && chmod 700 "$mtmp" && mv -f "$mtmp" "$d/.context-monitor" || { rm -f "$mtmp"; exit 72; }',
    remoteHereDoc('"$d/bashrc"', 'MOGGING_BASH_RC_EOF', bashRc),
    '[ "$?" -eq 0 ] && chmod 600 "$d/bashrc" || exit 72',
    remoteHereDoc('"$zd/.zshrc"', 'MOGGING_ZSH_RC_EOF', zshRc),
    '[ "$?" -eq 0 ] && chmod 600 "$zd/.zshrc" || exit 72',
    remoteHereDoc('"$d/envrc"', 'MOGGING_SH_RC_EOF', shRc),
    '[ "$?" -eq 0 ] && chmod 600 "$d/envrc" || exit 72',
    remoteCaptureHereDoc('requested', 'MOGGING_REQUESTED_CWD_EOF', cwd ?? ''),
    'export MOGGING_REQUESTED_CWD="$requested" MOGGING_HELPER_DIR="$d" MOGGING_PTY=1',
    'if [ "${shell##*/}" = fish ]; then',
    '  case "$requested" in "~") requested="$HOME" ;; "~/"*) requested="$HOME/${requested#~/}" ;; esac',
    '  if [ -n "$requested" ]; then CDPATH= cd "$requested" || { echo "mogging: remote working directory is unavailable" >&2; exit 72; }; fi',
    remoteCaptureHereDoc('fish_init', 'MOGGING_FISH_INIT_EOF', fishInit),
    REMOTE_CONTEXT_MONITOR_START.trimEnd(),
    `  ${READY_OSC_PRINTF}`, // fish takes its own exec path — it owes the same signal
    '  exec "$shell" --login --init-command "$fish_init"',
    'fi',
    remoteCaptureHereDoc('interactive', 'MOGGING_INTERACTIVE_EOF', interactive),
    'export MOGGING_REQUESTED_CWD',
    // The readiness signal, emitted once every check above has passed and immediately before the
    // user's shell takes over: "you are past the password/MFA/host-key prompt, this is a shell."
    // An agent launch waits on this UNBOUNDED (whenPaneRemoteReady), and typing an agent command
    // before it is exactly how a prompt eats your credentials (audit finding 9). Emitted here
    // rather than at the top so a bootstrap that exits 72 never claims to be ready.
    READY_OSC_PRINTF,
    'exec "$shell" -lc "$interactive"'
  ].join('\n')
  // sshd may initially hand the command to fish/csh. Keep the outer command simple
  // enough for those shells, then parse the actual bootstrap with a known POSIX shell.
  return `exec /bin/sh -c ${posixLiteral(bootstrap)}`
}

export interface PaneSubscriber {
  send(data: string): void
  exit(code: number): void
  state(state: AgentState): void
  cwd(location: PaneCwdSnapshot): void
  /** Usage-limit signal (Phase-4/04): distinct from state so failover can act. */
  limit?(): void
  /** Typed-launch detection: an agent CLI process appeared in / vanished from the
   *  pane's PTY subtree (process-table truth, not output heuristics). */
  agent?(agentId: string | null, cwd?: string, sinceMs?: number): void
}

interface PaneHooks {
  onExit: () => void
  onChange: () => void
  onCwdChange: () => void
  /** A LINE was submitted into this pane — something may be starting. */
  onCommandSubmitted: () => void
  /** The pane's shell is back at its PROMPT — whatever was submitted has finished. */
  onPrompt: (marker: 'osc133' | 'mogging' | 'osc9') => void
}

class PaneSession {
  readonly id: string
  /** Session generation (v5): minted by the SessionManager, monotonic per daemon lifetime.
   *  Pane IDS are reused; (id, gen) is what actually names ONE session on the wire. */
  readonly gen: number
  readonly cwd: string
  /** The cwd that was ASKED for, verbatim — persisted instead of `cwd` so a directory
   *  that is merely unavailable right now (network share not yet mounted at login, a
   *  transiently locked folder) is not permanently rewritten to the home-dir fallback.
   *  Once the directory is back, the next cold start restores into the real path. */
  private readonly requestedCwd?: string
  /** True when `requestedCwd` existed but was not a usable directory at spawn time. */
  private readonly cwdFellBack: boolean
  readonly command?: string
  remoteName?: string
  private remote?: SpawnSpec['remote']
  /** A live remote shell has reported its cwd after SSH authentication/login. */
  private remoteCwdLive = false
  /** Remote process observations are accepted only between a submitted line and the next real
   * shell prompt. This rejects a delayed monitor frame from a completed/background command. */
  private remoteContextArmed = false
  /** This session's pane-binding secret (Phase-4/03 reviewer gate). Injected into the pane's
   *  own process env as MOGGING_PANE_TOKEN and disclosed NOWHERE else — not in PaneInfo, not
   *  in `spawned`, not in the session store. A pane id is public (`mogging list` prints it),
   *  so `from: <reviewer-id>` alone proved nothing: every pane can read the 0600 endpoint file
   *  and authenticate, which is exactly the population the reviewer gate referees. Holding
   *  this token is what proves a sender is running INSIDE the pane it claims to be. */
  readonly paneToken: string
  cols: number
  rows: number
  private proc: IPty
  private buffer = ''
  private lastState: AgentState = 'idle'
  private readonly tracker: ActivityTracker
  private readonly cwdState: PaneCwdState
  private gitContext?: GitContextObserver
  /** The agent process the detector last saw in this pane's subtree (typed-launch
   *  detection) — replayed to (re)attaching clients so an app restart re-learns a
   *  hand-typed session it never launched. */
  private lastAgent: { agentId: string; cwd: string; sinceMs: number } | null = null
  private subs = new Set<PaneSubscriber>()
  private readonly hooks: PaneHooks
  /** True while this session is an UNTOUCHED cold-start restore: a fresh shell repainting
   *  persisted scrollback, with no live agent in it and nothing typed since. The app reads
   *  it (via `spawned.restored`) to decide that resume must TYPE — the opposite of a true
   *  reattach. Cleared by the first client input, and never set when the daemon itself
   *  typed a resume command (that pane is already handling its own continuity). */
  private pristineRestore: boolean

  constructor(
    id: string,
    gen: number,
    spec: SpawnSpec,
    hooks: PaneHooks,
    restore?: {
      scrollback: string
      resumeCommand?: string | null
      requestedCwd?: string
      reported?: { cwd: string; observedAt: number }
    },
    extraEnv: Record<string, string> = {}
  ) {
    this.id = id
    this.gen = gen
    this.hooks = hooks
    this.cols = spec.cols ?? 80
    this.rows = spec.rows ?? 24
    // `||`, not `??`: an EMPTY string is not a cwd. `??` let '' through to node-pty, which
    // then inherits the daemon's own working directory — the app's install folder, since
    // the daemon is spawned from the packaged binary. A plain terminal therefore opened in
    // `…\Programs\MoggingLabs Workspace` no matter which folder the wizard picked.
    //
    // The existsSync is the other half. Now that a REAL path arrives here (it used to be
    // '' always), a stale one — a worktree pruned between sessions, a folder the user moved
    // — would make pty.spawn throw and the pane would never open at all. A terminal in the
    // wrong directory is a bug; a terminal that does not exist is worse.
    this.paneToken = crypto.randomBytes(16).toString('hex')
    const launchRequestedCwd = spec.cwd || undefined
    this.cwd = pickCwd(launchRequestedCwd)
    this.requestedCwd = restore?.requestedCwd || launchRequestedCwd
    this.cwdFellBack = !!launchRequestedCwd && this.cwd !== launchRequestedCwd
    this.command = spec.run
    this.remoteName = spec.remote?.name
    this.remote = spec.remote ? { ...spec.remote } : undefined
    this.cwdState = new PaneCwdState(spec.remote?.cwd ?? this.cwd, this.remoteName ? 'remote' : 'local', restore?.reported)
    if (restore?.scrollback) this.buffer = restore.scrollback // seed prior output for repaint
    // Pristine only when the daemon is NOT typing the resume itself (see field doc) —
    // and never when the cwd fell back to home: `restored: true` cues the app to TYPE
    // the resume command, which must not happen in the wrong directory (an agent
    // resumed in `~` picks up the wrong project's sessions).
    this.pristineRestore = !!restore && !restore.resumeCommand && !this.cwdFellBack

    const isWin = process.platform === 'win32'
    let shell = spec.shell ?? (isWin ? process.env.COMSPEC || 'cmd.exe' : process.env.SHELL || '/bin/bash')
    let args = spec.args ?? (isWin ? [] : ['-l'])
    // Remote pane (4/05): the pane process IS `ssh -tt [-p port] [user@]host` — arg
    // ARRAY, no shell interpolation; the user's ssh stack does all auth (ADR 0002).
    // Exit of ssh = pane exit (existing semantics). MOGGING_SSH_SHIM is a test-only
    // stand-in (a node script) so smokes never need a network.
    if (spec.remote) {
      const r = spec.remote
      const sshArgs = [
        '-tt',
        ...(r.port ? ['-p', String(r.port)] : []),
        (r.user ? r.user + '@' : '') + r.host,
        remoteBootstrap(r)
      ]
      const shim = process.env.MOGGING_SSH_SHIM
      if (shim) {
        // Test shim: a PowerShell/shell script — run via the PLATFORM shell (running it
        // through process.execPath would boot Electron's GUI, not a script).
        //
        // NOT `cmd.exe /c`: the one remote command is now the full POSIX bootstrap (~10 KB),
        // and cmd's command line caps at 8191 characters — the shim died with "The command
        // line is too long" before it ever reached a shell, which is a limit of the TEST
        // transport alone. Real ssh.exe is spawned directly (CreateProcess, 32 KB), so it
        // never had this ceiling; PowerShell -File gives the shim the same headroom.
        if (isWin) {
          shell = 'powershell.exe'
          args = ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', shim, ...sshArgs]
        } else {
          shell = 'sh'
          args = [shim, ...sshArgs]
        }
      } else if (isWin) {
        // sshArgs ALREADY ends with the one remote command (remoteBootstrap). Appending a second
        // here gave real ssh two concatenated commands — invisible under the shim.
        shell = 'ssh.exe'
        args = sshArgs
      } else {
        shell = 'ssh'
        args = sshArgs
      }
    }
    // Remote SSH needs the user's ordinary process environment for PATH, HOME and
    // SSH_AUTH_SOCK, but none of the per-pane local env (service keys, profile pointers,
    // local analytics paths, or daemon routing). Direct daemon clients cannot bypass this.
    const inheritedEnv: NodeJS.ProcessEnv = spec.remote
      ? { ...process.env }
      : {
          ...process.env,
          AIDER_ANALYTICS_LOG: aiderLogPath(this.id),
          ...extraEnv,
          ...(spec.env ?? {})
        }
    const shellLaunch = spec.remote
      ? { args, env: {} }
      : paneShellLaunch(shell, inheritedEnv, `${process.pid}-${this.id}-${this.gen}`)
    if (!spec.remote && spec.args === undefined) args = shellLaunch.args
    // Inject this pane's identity + how to reach the daemon so a command inside the pane can
    // target ITSELF via `mogging notify` (Phase-2/04). Only the pane id + the endpoint FILE path
    // go in the env — never the auth token (that stays in the 0600 endpoint file), so the token
    // can't leak through env dumps / agent context (ADR 0002).
    const procEnv: Record<string, string | undefined> = {
      ...inheritedEnv,
      ...shellLaunch.env,
      MOGGING_PANE_ID: this.id,
      MOGGING_PANE_TOKEN: this.paneToken
    }
    if (spec.remote) {
      // SSH needs none of the local pane capabilities. A user's broad SendEnv/AcceptEnv
      // configuration must not be able to forward them to the remote host.
      stripLocalPaneCapabilities(procEnv)
    }
    this.proc = spawnPty(shell, args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      // spec.env (Phase-8/08): per-pane env the APP resolved (vault service
      // keys) — merged into the process env only, NEVER typed into the pane, so
      // a secret never lands in scrollback/sessions.db. Source-agnostic: the
      // daemon knows nothing of the vault. MOGGING_PANE_ID wins (identity).
      // Shell integration reports prompt boundaries and the conservative cwd lane immediately;
      // foreground-process and Git observations can refine it while a command owns the pane.
      //
      // MOGGING_PANE_ID and MOGGING_PANE_TOKEN are stamped LAST, and that order is load-bearing:
      // the token is the pane's identity PROOF (the reviewer gate rests on it — see transport's
      // `approve`), so a client-supplied `spec.env` must not be able to choose its own. Everything
      // above may be overridden by the app; identity may not.
      // Aider has no statusline and no percentage: the only exact source is the analytics log
      // it writes when pointed at one, and every aider flag has an AIDER_* env twin. Pointing
      // the PANE at a log means a HAND-TYPED aider reports exactly like a launched one — the
      // thing claude's `--settings` relay cannot do (context/providers.ts).
      env: procEnv as Record<string, string>
    }).proc
    if ('gitTraceFile' in shellLaunch && shellLaunch.gitTraceFile) {
      this.gitContext = new GitContextObserver(shellLaunch.gitTraceFile, (raw) => {
        const cwd = this.normalizeObservedCwd(raw, true)
        if (cwd) this.publishCwd(this.cwdState.acceptWorktree(cwd))
      })
    }
    // Pane state = the ActivityTracker's verdict (the dot in the pane header). The
    // OSC parser feeds it explicit signals (133 C/D, 9/99/777, the bell) but no
    // longer drives the wire directly — on real setups those signals barely exist
    // (cmd.exe and Claude Code both emit no OSC 133), which left the dot frozen on
    // 'idle' forever. The tracker fuses them with OUTPUT ACTIVITY (streaming =
    // working, quiet = idle) and latches attention until the user answers
    // (tracker semantics + precedence: agent-state/activity.ts).
    this.tracker = new ActivityTracker((state) => {
      this.lastState = state
      for (const s of this.subs) s.state(state)
    })
    const osc = new OscParser(
      // An OSC 9/99/777 notification is the same GUESS a raw BEL is — CLIs fire it on
      // completion as much as on a block — so it takes the bell's confirmation path, not
      // the explicit-verdict one. Only 133;C/D (real shell integration) is a verdict here.
      (state) => (state === 'attention' ? this.tracker.bell() : this.tracker.notify(state)),
      (ev) => {
        if (ev.kind === 'bell') this.tracker.bell()
        if (ev.kind === 'prompt') {
          this.gitContext?.resetAtPrompt()
          hooks.onPrompt('osc133')
          const changed = this.cwdState.acceptPrompt(Date.now(), 'osc133')
          this.remoteContextArmed = this.isRemote && this.remoteCwdLive && this.cwdState.commandInFlight()
          this.publishCwd(changed)
        }
        if (ev.kind === 'shell-prompt') {
          this.gitContext?.resetAtPrompt()
          hooks.onPrompt('mogging')
          const cwd = ev.payload ? this.normalizeObservedCwd(ev.payload, false) : null
          if (!cwd) {
            const changed = this.cwdState.acceptPrompt(Date.now(), 'mogging')
            this.remoteContextArmed = this.isRemote && this.remoteCwdLive && this.cwdState.commandInFlight()
            this.publishCwd(changed)
          } else {
            const firstLiveRemoteCwd = this.isRemote && !this.remoteCwdLive
            if (this.isRemote) this.remoteCwdLive = true
            const changed = this.cwdState.acceptShell(cwd, true, Date.now(), 'mogging')
            this.remoteContextArmed = this.isRemote && this.cwdState.commandInFlight()
            this.publishCwd(changed ?? (firstLiveRemoteCwd ? this.cwdState.current() : null))
          }
        }
        if (ev.kind === 'cwd' && ev.payload) {
          // OSC 9;9 is the SHELL's prompt marker (we inject it — platform/shell.ts), so it says
          // more than a path: the foreground command has ended. The agent detector spends — and
          // above all SAVES — its process listings on that (agent-state/agent-proc.ts). OSC 7 is
          // not treated the same way: a TUI could emit one, and a wrong "the shell is idle"
          // would cancel the very probe that was about to find the agent.
          const prompt = ev.code === 9
          if (prompt) {
            this.gitContext?.resetAtPrompt()
            hooks.onPrompt('osc9')
          }
          // De-duped on VALUE: a cmd.exe pane reports its cwd twice per prompt (9;9 then 7 —
          // whichever survives ConPTY), and an unchanged cwd is not news.
          const raw = ev.code === 633 ? ev.payload : fileUriToPath(ev.payload)
          const cwd = raw ? this.normalizeObservedCwd(raw, false) : null
          if (cwd) {
            const firstLiveRemoteCwd = this.isRemote && !this.remoteCwdLive
            if (this.isRemote) this.remoteCwdLive = true
            const changed = this.cwdState.acceptShell(
              cwd,
              prompt,
              Date.now(),
              prompt ? 'osc9' : 'generic'
            )
            if (prompt) {
              this.remoteContextArmed = this.isRemote && this.remoteCwdLive && this.cwdState.commandInFlight()
            }
            // A restored declaration can keep the same effective value/revision. Emit one
            // live snapshot anyway so the renderer knows SSH authentication completed.
            this.publishCwd(changed ?? (firstLiveRemoteCwd ? this.cwdState.current() : null))
          } else if (prompt) {
            const changed = this.cwdState.acceptPrompt(Date.now(), 'osc9')
            this.remoteContextArmed = this.isRemote && this.remoteCwdLive && this.cwdState.commandInFlight()
            this.publishCwd(changed)
          }
        }
        if (ev.kind === 'agent-cwd' && ev.payload) {
          // PTY binding scopes this fallback to the current pane; no pane token is persisted
          // in scrollback. Local paths still pass the daemon report's directory validation.
          const cwd = this.normalizeObservedCwd(ev.payload, true)
          if (cwd) {
            const result = this.cwdState.acceptReport(cwd, Date.now())
            this.publishCwd(result.changed)
          }
        }
        if (
          ev.kind === 'process-cwd' &&
          ev.payload &&
          ev.pid &&
          this.isRemote &&
          this.remoteCwdLive &&
          this.remoteContextArmed
        ) {
          const cwd = this.normalizeObservedCwd(ev.payload, false)
          if (cwd) this.publishCwd(this.cwdState.acceptDetected({ pid: ev.pid, cwd }))
        }
        if (
          ev.kind === 'git-cwd' &&
          ev.payload &&
          this.isRemote &&
          this.remoteCwdLive &&
          this.remoteContextArmed
        ) {
          const cwd = this.normalizeObservedCwd(ev.payload, false)
          if (cwd) this.publishCwd(this.cwdState.acceptWorktree(cwd))
        }
      }
    )
    this.proc.onData((d) => {
      const grown = this.buffer + d
      this.buffer = grown.length > SCROLLBACK_BYTES ? trimTornStart(grown.slice(-SCROLLBACK_BYTES)) : grown
      osc.push(d)
      this.gitContext?.drain()
      for (const s of this.subs) s.send(d)
      hooks.onChange()
    })
    this.proc.onExit(({ exitCode }) => {
      this.tracker.dispose()
      this.gitContext?.dispose()
      for (const s of this.subs) s.exit(exitCode)
      this.subs.clear()
      hooks.onExit()
    })
    // Fresh panes run their launch command. RESTORED panes repaint prior scrollback in a fresh
    // shell at the same cwd, and relaunch a known agent via its own resume (step 4) — never a
    // frozen process; a pane with no resumable agent just restores its shell.
    if (spec.run && !restore) {
      this.cwdState.acceptCommandStart()
      this.proc.write(spec.run + '\r')
    }
    // A restore whose cwd fell back to home must NOT resume: `claude --resume` typed in
    // the home directory resumes the wrong project's sessions. The shell restores with
    // its scrollback; the real cwd stays persisted (requestedCwd) for the next start.
    else if (restore?.resumeCommand && !this.cwdFellBack) {
      this.cwdState.acceptCommandStart()
      this.proc.write(restore.resumeCommand + '\r')
    }
  }

  get scrollback(): string {
    return this.buffer
  }
  /** The pane shell's pid — the root the agent-process detector walks from. */
  get pid(): number {
    return this.proc.pid
  }
  /** Remote panes run ssh locally — nothing in their local subtree is the agent. */
  get isRemote(): boolean {
    return !!this.remoteName
  }
  matchesRemote(remote: SpawnSpec['remote']): boolean {
    if (!this.remote && !remote) return true
    if (!this.remote || !remote) return false
    return (
      this.remote.host === remote.host &&
      this.remote.user === remote.user &&
      this.remote.port === remote.port &&
      (this.remote.platform ?? 'posix') === (remote.platform ?? 'posix')
    )
  }
  updateRemoteDisplayName(remote: SpawnSpec['remote']): boolean {
    if (!this.remote || !remote || this.remote.name === remote.name) return false
    this.remoteName = remote.name
    this.remote = { ...this.remote, name: remote.name }
    return true
  }
  private normalizeObservedCwd(raw: unknown, mustExist: boolean): string | null {
    return this.isRemote ? normalizeRemotePaneCwd(raw) : normalizePaneCwd(raw, { mustExist })
  }
  private publishCwd(changed?: PaneCwdSnapshot | null): void {
    if (!changed) return
    for (const s of this.subs) s.cwd(changed)
    this.hooks.onCwdChange()
  }
  /** Authenticated active-context declaration from the universal CLI/MCP protocol. */
  applyCwdReport(raw: unknown, observedAt: number): CwdReportResult {
    const cwd = this.normalizeObservedCwd(raw, true)
    if (!cwd) return { ok: false, reason: 'badcwd', current: this.cwdState.current() }
    const result = this.cwdState.acceptReport(cwd, observedAt)
    this.publishCwd(result.changed)
    return result
  }
  /** Strict adapter identity changed: remember it for reattach and pair it with the current
   * passive cwd. Process/Git observation remains a separate lane so an arbitrary executable is
   * never granted provider branding, usage, or resume capabilities. */
  applyAgentProc(det: DetectedAgentProc | null): void {
    const detectedCwd = det?.cwd ? this.normalizeObservedCwd(det.cwd, false) ?? undefined : undefined
    this.lastAgent = det
      ? { agentId: det.agentId, cwd: detectedCwd ?? this.cwdState.passiveCwd(), sinceMs: det.sinceMs }
      : null
    for (const s of this.subs) s.agent?.(this.lastAgent?.agentId ?? null, this.lastAgent?.cwd, this.lastAgent?.sinceMs)
  }
  /** Foreground process context is independent of provider recognition. This is what lets an
   * arbitrary CLI move the pane's active cwd without being mislabeled as a supported agent. */
  applyProcessContext(context: DetectedProcessContext | null): void {
    const cwd = context?.cwd ? this.normalizeObservedCwd(context.cwd, false) ?? undefined : undefined
    this.publishCwd(this.cwdState.acceptDetected(context ? { pid: context.pid, cwd } : null))
  }
  /** Still an untouched cold-start restore? (See `pristineRestore` — the app's cue that
   *  resume must type here.) */
  get restoredPristine(): boolean {
    return this.pristineRestore
  }
  info(): PaneInfo {
    const location = this.cwdState.current()
    const hasRemoteLocation = !this.isRemote || this.remoteCwdLive
    return {
      id: this.id,
      gen: this.gen,
      cols: this.cols,
      rows: this.rows,
      title: this.command, // launch label only (e.g. "claude") — never a command line
      ...(hasRemoteLocation
        ? {
            cwd: location.cwd,
            cwdRevision: location.revision,
            cwdSource: location.source,
            cwdLocality: location.locality
          }
        : {}),
      state: this.lastState,
      remoteName: this.remoteName
    }
  }
  /** Control API (Phase-3/01): the retained scrollback tail, capped at 10000 lines.
   *  Returned to the requesting client ONLY — never persisted beyond the session
   *  store's existing scrollback, never logged, never telemetry. */
  captureTail(lastLines?: number): string {
    const cap = Math.min(Math.max(1, Math.floor(lastLines ?? 1000)), 10000)
    const lines = this.buffer.split('\n')
    return lines.slice(-cap).join('\n')
  }
  snapshot(): PersistedPane {
    const reported = this.cwdState.declaredForPersistence()
    return {
      id: this.id,
      workspaceId: 'default',
      // The REQUESTED cwd, not the effective one — a home-dir fallback for a
      // temporarily missing directory must not become permanent (see requestedCwd).
      // A remote pane's local ssh process cwd is not remote session state.
      cwd: this.isRemote ? (this.requestedCwd ?? '') : (this.requestedCwd ?? this.cwd),
      reportedCwd: reported?.cwd,
      reportedCwdAt: reported?.observedAt,
      remote: this.remote ? { ...this.remote } : undefined,
      command: this.command,
      scrollback: this.buffer,
      updatedAt: Date.now()
    }
  }
  subscribe(s: PaneSubscriber): void {
    this.subs.add(s)
    s.state(this.lastState) // replay current agent-state to a (re)attaching client
    const location = this.cwdState.current()
    // A remote pane's local ssh process starts in a local directory. It is not the remote
    // shell's cwd, so publish nothing until that shell actually reports a path.
    if (!this.isRemote || this.remoteCwdLive) s.cwd(location)
    // ...and the agent DETECTED in this pane: an app restart reattaches to a session the
    // daemon kept alive, and this replay is how the new app learns what runs in it — the
    // one path by which a hand-typed agent survives a restart with its identity intact.
    if (this.lastAgent) s.agent?.(this.lastAgent.agentId, this.lastAgent.cwd, this.lastAgent.sinceMs)
  }
  unsubscribe(s: PaneSubscriber): void {
    this.subs.delete(s)
  }
  /** `mogging notify` (Phase-2/04): map an explicit agent/hook event to a pane state and fan it
   *  out just like an OSC state change, so it flows through the same state -> attention pipeline
   *  (badge chip + workspace-tab ring). Replayed to (re)attaching clients via lastState. */
  applyNotify(event: string): void {
    // Routed through the tracker so notify keeps its latch/clear semantics (an
    // explicit busy/idle releases an attention latch; attention latches). The
    // subagent lifecycle + idle-prompt events are STATEFUL — the tracker's pending
    // counter decides what they mean — so they bypass the stateless event->state map.
    if (event === 'subagent-start') this.tracker.subagentStart()
    else if (event === 'subagent-stop') this.tracker.subagentStop()
    else if (event === 'idle-prompt') this.tracker.idlePrompt()
    else if (event === 'turn-start') this.tracker.turnStart()
    else this.tracker.notify(notifyEventToState(event))
    // Usage-limit (4/04): a DISTINCT signal alongside the attention state, so the
    // app can offer profile failover. Event label only — never content.
    if (event === 'usage-limit') for (const s of this.subs) s.limit?.()
  }
  write(data: string): void {
    // xterm's auto-replies (CPR/DA/focus/color reports — re-emitted for every query
    // in a reattach's scrollback replay) ride this same channel but are NOT a human
    // touching the pane: they must not clear the attention latch (a red pane went
    // yellow across every renderer reload) nor mark a pristine restore as touched.
    if (isTerminalReply(data)) {
      this.proc.write(data)
      return
    }
    this.pristineRestore = false // touched: from here on it's a live shell, not a restore
    // Only a SUBMIT answers a blocked agent. Clearing the latch on any keystroke claimed the
    // pane was "working" when an arrow key or a ^C landed in it — while the agent sat there
    // still blocked, with nothing left to correct the lie (see isSubmittedInput).
    this.tracker.input(isSubmittedInput(data))
    // A submitted LINE is the only moment a shell can start something — the detector arms one
    // probe on it, and the prompt coming back cancels that probe, so ordinary commands cost
    // nothing. Enter pressed while any foreground program owns the pane is program input; a
    // prompt proves that a background process no longer blocks detection of the next command.
    const submissions = countSubmittedLines(data)
    for (let i = 0; i < submissions; i++) {
      this.publishCwd(this.cwdState.acceptCommandStart())
      if (this.isRemote && this.remoteCwdLive) this.remoteContextArmed = true
      this.hooks.onCommandSubmitted()
    }
    this.proc.write(data)
  }
  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    try {
      this.proc.resize(cols, rows)
    } catch {
      /* pane may be exiting */
    }
  }
  kill(): void {
    this.tracker.dispose()
    this.gitContext?.dispose()
    try {
      this.proc.kill()
    } catch {
      /* already gone */
    }
  }
}

export class SessionManager {
  private panes = new Map<string, PaneSession>()
  /** Generation mint (v5): one stamp per PaneSession ever created by THIS daemon.
   *  Uniqueness within the daemon's lifetime is all clients need — a reconnecting
   *  client re-learns current gens from `welcome`/`spawned`, never from memory. */
  private nextGen = 1
  private persistTimer?: NodeJS.Timeout
  private persistDueAt = 0
  /** Swarm substrate (Phase-4/01): the daemon-owned mailbox + role manifest. */
  readonly mailbox = new Mailbox()
  /** Ownership ledger (Phase-4/02): claims die with their pane. */
  readonly ledger = new Ledger()
  /** Reviewer gate (Phase-4/03): branch sign-offs. Memory-only coordination data. */
  readonly approvals = new Map<string, Approval>()
  /** Typed-launch detection: ONE detector across all panes (one process snapshot per
   *  probe, edge-driven by pane output). Verdicts land on the pane and fan to clients. */
  private readonly agentProcs = new AgentProcessDetector(
    (id, det) => this.panes.get(id)?.applyAgentProc(det),
    Date.now,
    {},
    (id, context) => this.panes.get(id)?.applyProcessContext(context)
  )

  // extraEnv is injected into every pane's shell env (e.g. MOGGING_DAEMON_ENDPOINT for notify).
  constructor(
    private readonly store: SessionStore,
    private readonly extraEnv: Record<string, string> = {}
  ) {}

  has(id: string): boolean {
    return this.panes.has(id)
  }
  count(): number {
    return this.panes.size
  }
  list(): PaneInfo[] {
    return [...this.panes.values()].map((p) => ({ ...p.info(), role: this.mailbox.roleOf(p.id) }))
  }
  get(id: string): PaneSession | undefined {
    return this.panes.get(id)
  }
  snapshotAll(): PersistedPane[] {
    return [...this.panes.values()].map((p) => p.snapshot())
  }

  /** The current single default workspace + its (flat) layout. Steps 04/05 add real
   *  workspaces + a split tree; this persists the pane arrangement that exists today. */
  workspaces(): PersistedWorkspace[] {
    const layout: WorkspaceLayout = { v: 1, panes: [...this.panes.keys()] }
    return [{ id: 'default', name: 'Workspace', layout: JSON.stringify(layout), updatedAt: Date.now() }]
  }

  private persist(): void {
    this.store.savePanes(this.snapshotAll())
    this.store.saveWorkspaces(this.workspaces())
  }

  private hooks(id: string, self: () => PaneSession): PaneHooks {
    return {
      onExit: () => {
        // Identity-guarded: a killed pane's exit event lands ASYNC (the pty dies after
        // remove() already deleted it), and by then a reused id may hold a brand-new
        // session. An unguarded delete orphaned that live session from the map — and
        // wrongly cleared the NEW pane's role and claims.
        if (this.panes.get(id) === self()) {
          this.panes.delete(id)
          this.mailbox.clearRole(id)
          this.ledger.clearPane(id) // exits release territory immediately (4/02)
          this.agentProcs.untrack(id) // no pty, no subtree to watch
        }
        this.schedulePersist(500)
      },
      onChange: () => this.schedulePersist(2000),
      onCwdChange: () => this.schedulePersist(100),
      onCommandSubmitted: () => this.agentProcs.commandSubmitted(id),
      onPrompt: (marker) => this.agentProcs.promptSeen(id, marker)
    }
  }

  /** Start watching a pane's subtree for agent processes. REMOTE panes are skipped: their agent
   *  runs on the far machine and the only thing in our local subtree is `ssh`.
   *
   *  `expectAgent` says whether this pane can produce an agent NOBODY announced: a restore types
   *  its own resume command into a booting shell, so its agent simply appears. A fresh pane
   *  cannot — it starts empty, and every launch into it is typed (and therefore announced). That
   *  distinction is why opening a workspace of plain terminals costs zero process listings. */
  private trackAgentProcs(pane: PaneSession, expectAgent = false): void {
    if (!pane.isRemote) this.agentProcs.track(pane.id, pane.pid, expectAgent)
  }

  /** Spawn or return the existing pane (id-guard across the process boundary — a
   *  reconnecting client re-requesting the same id ATTACHES, never duplicates). */
  ensure(id: string, spec: SpawnSpec): { pane: PaneSession; existed: boolean } {
    const remote = spec.remote ? normalizeRemoteConnection(spec.remote) : null
    const remoteCwd = spec.remote?.cwd === undefined ? undefined : normalizeRemotePaneCwd(spec.remote.cwd)
    if (spec.remote && (!remote || !remoteCwd && spec.remote.cwd !== undefined)) {
      throw new Error('Invalid remote connection')
    }
    const normalizedSpec: SpawnSpec = {
      ...spec,
      remote: remote ? { ...remote, cwd: remoteCwd ?? undefined } : undefined
    }
    const existing = this.panes.get(id)
    if (existing?.matchesRemote(normalizedSpec.remote)) {
      if (existing.updateRemoteDisplayName(normalizedSpec.remote)) this.schedulePersist(100)
      return { pane: existing, existed: true }
    }
    // A legacy/corrupt restore may have lost SSH identity. The app's resolved remote spec is
    // authoritative; keeping the local impostor would both misroute input and enable local Git.
    if (existing) this.remove(id)
    // `pane` is referenced lazily by the hook (onExit fires long after construction).
    const pane: PaneSession = new PaneSession(
      id,
      this.nextGen++,
      normalizedSpec,
      this.hooks(id, () => pane),
      undefined,
      this.extraEnv
    )
    this.panes.set(id, pane)
    // `spec.run` is typed by the SESSION itself, not through write(), so nothing would announce
    // it. Every launch the app performs is a normal write and announces itself; a fresh pane
    // without a run command starts empty, and is therefore never looked at.
    this.trackAgentProcs(pane, !!spec.run)
    this.schedulePersist(500)
    return { pane, existed: false }
  }

  /** Cold-start restore: re-create persisted panes (fresh shell at cwd + seeded scrollback).
   *  Only runs into an empty manager. Returns how many panes were restored. */
  restore(): number {
    if (this.panes.size > 0) return 0
    this.store.loadWorkspaces() // load persisted workspaces (layout consumed by the app in 04/05)
    const persisted = this.store.loadPanes()
    for (const p of persisted) {
      const hasReportedContext = p.reportedCwd !== undefined || p.reportedCwdAt !== undefined
      const reportedCwd =
        p.reportedCwd && Number.isFinite(p.reportedCwdAt)
          ? p.remote
            ? normalizeRemotePaneCwd(p.reportedCwd)
            : normalizePaneCwd(p.reportedCwd, { mustExist: true })
          : null
      const restoredRemoteCwd = p.remote?.cwd ? normalizeRemotePaneCwd(p.remote.cwd) : null
      const spec: SpawnSpec = {
        cwd: p.remote ? p.cwd : (reportedCwd ?? p.cwd),
        run: p.command,
        remote: p.remote
          ? { ...p.remote, platform: 'posix', cwd: reportedCwd ?? restoredRemoteCwd ?? undefined }
          : undefined
      }
      // Relaunch a known agent via its own resume (step 4) — never a frozen process.
      // If a declared worktree vanished, do not resume the agent in the seed project.
      const resumeCommand = p.remote || (hasReportedContext && !reportedCwd) ? null : resumeCommandFor(p.command)
      const pane: PaneSession = new PaneSession(
        p.id,
        this.nextGen++,
        spec,
        this.hooks(p.id, () => pane),
        {
          scrollback: p.scrollback,
          resumeCommand,
          requestedCwd: p.cwd,
          reported:
            !p.remote && reportedCwd && p.reportedCwdAt !== undefined
              ? { cwd: reportedCwd, observedAt: p.reportedCwdAt }
              : undefined
        },
        this.extraEnv
      )
      this.panes.set(p.id, pane)
      // A resumed agent is the one that appears with nobody to announce it (see trackAgentProcs).
      this.trackAgentProcs(pane, !!resumeCommand)
    }
    return persisted.length
  }

  /** Coalesced background write (scrollback churns constantly). */
  schedulePersist(delayMs = 2000): void {
    const dueAt = Date.now() + delayMs
    if (this.persistTimer && this.persistDueAt <= dueAt) return
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistDueAt = dueAt
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined
      this.persistDueAt = 0
      this.persist()
    }, delayMs)
  }

  /** Flush synchronously (e.g. on graceful shutdown). */
  persistNow(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = undefined
      this.persistDueAt = 0
    }
    this.persist()
  }

  remove(id: string): void {
    const p = this.panes.get(id)
    if (p) {
      p.kill()
      this.panes.delete(id)
      this.mailbox.clearRole(id) // pane ids get reused — a role never outlives its pane
      this.ledger.clearPane(id)
      this.agentProcs.untrack(id) // ...nor does an agent verdict
      this.schedulePersist(500)
    }
  }
  killAll(): void {
    for (const p of this.panes.values()) p.kill()
    this.panes.clear()
    this.agentProcs.dispose()
  }
}

export type { PaneSession }
