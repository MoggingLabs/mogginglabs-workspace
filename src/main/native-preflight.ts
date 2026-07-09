import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fatal } from './fatal'

// node-pty and better-sqlite3 are compiled against Electron's exact ABI. When they are stale or
// absent the app must not open a window: a MoggingLabs Workspace that cannot spawn a PTY is not a
// degraded app, it is a broken one.
//
// Both prior failure modes were silent. A stale better-sqlite3 threw inside the unguarded
// whenReady chain (windowless, exit 0). A missing node-pty killed the daemon on load, whereupon
// the daemon-start catch fell back to the in-proc backend and the window opened anyway — the PTY
// only failed later, per pane, with nothing on stderr. Fail here, once, with the fix.
//
// `require` (not import) on purpose: a static import of a broken .node throws during module
// evaluation, before installFatalHandlers() can run, and Electron reports it as a bare
// "App threw an error during load". Deferring the load to here keeps the diagnostic ours.

// BOTH modules dlopen lazily — require() alone proves nothing. better-sqlite3 loads its addon on
// `new Database()` (which is why the v0.6.0 ABI mismatch surfaced inside registerAppSettings, not
// at import), and node-pty loads pty.node on first spawn. So name the addons and dlopen them here.
// better-sqlite3's build/Release also holds test_extension.node — an sqlite loadable extension,
// not a node addon — which is why this is an allowlist rather than a directory sweep. node-pty's
// addon set is platform-dependent (pty.node everywhere; conpty*.node on Windows), so it takes the
// whole directory.
const NATIVE: readonly { mod: string; addons: readonly string[] | 'all' }[] = [
  { mod: 'better-sqlite3', addons: ['better_sqlite3.node'] },
  { mod: 'node-pty', addons: 'all' }
]

/** Absolute paths of the addons to dlopen. Throws when the native build never ran. */
function addonsOf(mod: string, addons: readonly string[] | 'all'): string[] {
  const release = join(dirname(require.resolve(`${mod}/package.json`)), 'build', 'Release')
  if (!existsSync(release)) throw new Error(`${mod}: no build/Release — the native build never ran (${release})`)
  if (addons === 'all') {
    const found = readdirSync(release).filter((f) => f.endsWith('.node'))
    if (!found.length) throw new Error(`${mod}: build/Release holds no compiled .node (${release})`)
    return found.map((f) => join(release, f))
  }
  return addons.map((f) => {
    const p = join(release, f)
    if (!existsSync(p)) throw new Error(`${mod}: missing compiled addon ${f} (${p})`)
    return p
  })
}

/** Load every native addon up front. Calls fatal() (exit 1) on the first that will not load. */
export function assertNativeModules(): void {
  for (const { mod, addons } of NATIVE) {
    try {
      require(mod) // the JS wrapper: catches a missing/corrupt package before we touch its addons
      for (const addon of addonsOf(mod, addons)) require(addon) // the real ABI check
    } catch (err) {
      fatal(err, `native:${mod}`)
      return // fatal() exits; the return keeps the loop honest if it is ever made recoverable
    }
  }
}
