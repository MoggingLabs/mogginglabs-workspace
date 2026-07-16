// The MOGGING_USERDATA isolation guard — pure and Electron-free (vitest imports it directly).
//
// THE HAZARD: prepareRuntime (boot.ts) deletes MOGGING_CHANNEL whenever MOGGING_USERDATA is
// set, because smokes are meant to run prod-shaped inside a FULLY isolated runtime tree (the
// harness exports LOCALAPPDATA / XDG_RUNTIME_DIR to a temp dir — scripts/qa-smokes.sh). But
// "prod-shaped" plus a runtime base that was NOT redirected is the worst launch on the whole
// matrix: an unpackaged build lands on the REAL per-user run/v<N> dir, finds the installed
// app's daemon, fails its build-stamp check, and retires it — killing every live pane process
// of the user's real session, and starting a retire war the moment the installed app
// reconnects (observed live 2026-07-15). One forgotten env var must be a loud refusal at
// boot, never a silent massacre.
//
// Scope: UNPACKAGED launches only (boot.ts guards the call). A packaged app with
// MOGGING_USERDATA is the documented state-isolation knob and shares the machine's daemon by
// design — same build, same stamp, no war to start.

/** Trailing separators off, forward slashes unified, lowercased — Windows paths are
 *  case-insensitive and LOCALAPPDATA arrives in whatever casing the launcher used. */
const canonWin = (p: string): string => p.replace(/\//g, '\\').replace(/[\\]+$/, '').toLowerCase()

/**
 * Null when this launch's runtime tree is safely isolated (or needs no isolation);
 * otherwise a human-readable refusal naming the exact env var to set.
 */
export function runtimeIsolationError(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  homedir: string
): string | null {
  if (!env.MOGGING_USERDATA) return null

  const fix =
    'set it to a per-run temp directory alongside MOGGING_USERDATA (scripts/qa-smokes.sh shows the shape), ' +
    'or drop MOGGING_USERDATA to run as a normal dev instance on the dev channel.'

  if (platform === 'win32') {
    const current = env.LOCALAPPDATA ? canonWin(env.LOCALAPPDATA) : ''
    const osDefault = canonWin(homedir + '\\AppData\\Local')
    if (!current || current === osDefault) {
      return (
        'MOGGING_USERDATA is set but LOCALAPPDATA still points at the real per-user runtime tree — ' +
        'this unpackaged launch would run prod-shaped against the INSTALLED daemon and retire it ' +
        '(killing every live pane of the real session). Refusing to boot: ' +
        fix
      )
    }
    return null
  }

  const runtime = env.XDG_RUNTIME_DIR
  if (!runtime) {
    return (
      'MOGGING_USERDATA is set but XDG_RUNTIME_DIR is not — this unpackaged launch would run ' +
      'prod-shaped against the machine’s real daemon runtime dir. Refusing to boot: ' +
      fix
    )
  }
  // systemd's login default — the real tree, not an isolated one.
  if (platform === 'linux' && /^\/run\/user\//.test(runtime)) {
    return (
      'MOGGING_USERDATA is set but XDG_RUNTIME_DIR is the login default (' +
      runtime +
      ') — this unpackaged launch would run prod-shaped against the real daemon runtime dir. ' +
      'Refusing to boot: ' +
      fix
    )
  }
  return null
}
