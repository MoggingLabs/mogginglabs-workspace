import { app } from 'electron'
import { copyFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { runtimeDir } from './daemon-client'

// THE STANDALONE NODE HELPER (ADR 0016). One resolver for the pinned Node runtime that
// hosts everything that used to ride Electron-as-Node: the detached PTY daemon, the
// house MCP server, and every `mogging` / `mogging-connection` shim. It is what earned
// flipping the RunAsNode fuse off — the signed Electron binary is no longer a Node
// interpreter, and the three call sites point HERE instead of at process.execPath.
//
//   packaged   <resources>/node-helper/            (electron-builder extraResources)
//   dev        <repo>/build/node-helper/<platform>-<arch>/   (scripts/build-node-helper.mjs,
//              run by postinstall — every gate in the sweep drives the same helper the
//              shipped app drives, which is the whole point of extending SURVIVE/CONTROL)
//
// There is deliberately NO fallback to Electron-as-Node: with the fuse off the variable
// is ignored and spawn(process.execPath, [script]) boots a second full app instance —
// a window blizzard, not a daemon. A missing helper is a build error and says so.

const HELPER_EXE = process.platform === 'win32' ? 'mogging-node.exe' : 'mogging-node'

// The helper's deps ship under this name, NOT `node_modules` — electron-builder strips
// any `node_modules` segment from an extraResources copy (build-node-helper.mjs
// HELPER_DEPS_DIR is the source of truth; the two must match).
const HELPER_DEPS_DIR = 'node_deps'

export interface HelperRuntime {
  /** The helper binary — the `command` for the daemon spawn, the house MCP entry and the shims. */
  readonly executable: string
  /** The helper's OWN deps dir (natives built for ITS ABI, not Electron's) — handed to
   *  the daemon via MOGGING_HELPER_NATIVES + NODE_PATH (see @backend/platform/native-require). */
  readonly nativesDir: string
}

const pathContains = (root: string, candidate: string): boolean => {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Does the bundled helper need to be copied into the persistent runtime dir to remain
 * launchable after this process exits? Only on a Linux AppImage: resources live below the
 * temporary APPDIR mount, which unmounts with the app — but the daemon respawn path, the
 * CLI-config MCP entries and the pane shims must all outlive us (the same reasoning that
 * used to send the shims at $APPIMAGE via stableRuntimeExecutable, which the helper
 * replaces). APPIMAGE/APPDIR are ordinary inherited variables, so require a packaged app
 * whose resources actually sit inside the advertised mount before believing them.
 */
export function helperNeedsRuntimeCopy(
  platform: NodeJS.Platform = process.platform,
  resourcesDir: string = process.resourcesPath,
  env: NodeJS.ProcessEnv = process.env,
  packaged: boolean = app.isPackaged
): boolean {
  if (!packaged || platform !== 'linux' || !env.APPIMAGE || !env.APPDIR) return false
  return isAbsolute(env.APPIMAGE) && isAbsolute(env.APPDIR) && pathContains(env.APPDIR, resourcesDir)
}

function bundledHelperDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'node-helper')
    : join(app.getAppPath(), 'build', 'node-helper', `${process.platform}-${process.arch}`)
}

/** Atomic-enough single-file copy: tmp + rename, so a crash never leaves a half binary
 *  and a RUNNING old helper (Linux ETXTBSY) is never written through — rename replaces
 *  the directory entry while the live inode survives. */
function copyFileAtomic(src: string, dst: string, mode: number): void {
  mkdirSync(dirname(dst), { recursive: true })
  const tmp = join(dirname(dst), `.${basename(dst)}.${process.pid}.tmp`)
  copyFileSync(src, tmp)
  chmodSync(tmp, mode)
  renameSync(tmp, dst)
}

function copyTreeAtomic(srcDir: string, dstDir: string): void {
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const src = join(srcDir, entry.name)
    const dst = join(dstDir, entry.name)
    if (entry.isDirectory()) copyTreeAtomic(src, dst)
    else if (entry.isFile()) copyFileAtomic(src, dst, statSync(src).mode & 0o777 || 0o644)
  }
}

/** Copy the bundled helper into the persistent per-version runtime dir (AppImage only).
 *  Keyed by the content stamp of the helper binary, so one copy per build and a new
 *  build never writes through a copy an old live daemon is executing; the versioned
 *  runtime dir is swept with everything else when its protocol version dies. */
function runtimeHelperCopy(bundled: string): string {
  const stamp = createHash('sha256').update(readFileSync(join(bundled, HELPER_EXE))).digest('hex').slice(0, 16)
  const target = join(runtimeDir(), 'helper', stamp)
  const marker = join(target, '.complete')
  if (!existsSync(marker)) {
    copyTreeAtomic(bundled, target)
    writeFileSync(marker, stamp, { mode: 0o600 }) // LAST: its existence asserts a whole copy
  }
  return target
}

let resolved: HelperRuntime | null = null

/** Resolve (once) the helper runtime every host-switch call site uses. Throws with the
 *  rebuild command when the helper was never built — a boot invariant, like the CLI
 *  runtime install it feeds. */
export function helperRuntime(): HelperRuntime {
  if (resolved) return resolved
  let dir = bundledHelperDir()
  if (!existsSync(join(dir, HELPER_EXE))) {
    throw new Error(
      `standalone Node helper missing at ${join(dir, HELPER_EXE)} — run \`npm run build:node-helper\` ` +
        '(postinstall builds it; ADR 0016). There is no Electron-as-Node fallback: the RunAsNode fuse is off.'
    )
  }
  if (helperNeedsRuntimeCopy()) dir = runtimeHelperCopy(dir)
  resolved = Object.freeze({ executable: join(dir, HELPER_EXE), nativesDir: join(dir, HELPER_DEPS_DIR) })
  return resolved
}

/**
 * The daemon entry the helper executes. In a packaged app out/main/daemon.js is
 * asar-UNPACKED (electron-builder.yml) because plain node has no asar support — hand the
 * helper the real on-disk path. Same file, same bytes, so the build stamp the daemon
 * takes of itself still matches the one daemon-client computes.
 */
export function daemonEntryPath(): string {
  const inAsar = join(__dirname, 'daemon.js')
  return inAsar.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`)
}
