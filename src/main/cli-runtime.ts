import { app } from 'electron'
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { channelFromEnv } from '@contracts'
import { runtimeDir } from './daemon-client'

const SATELLITES = [
  'mogging.mjs',
  'mcp-catalog.json',
  join('lib', 'endpoint-client.mjs'),
  // The connection bridge (ADR 0014): a CLI spawns this to reach a service the APP
  // is connected to. Same helper, same socket, no catalog of its own.
  'mogging-connection.mjs',
  // Install the MCP entry after its data and imported helper. The stable launcher is switched
  // only after this final replacement and the package metadata have all landed.
  'mogging-mcp.mjs'
] as const

export interface CliRuntime {
  readonly binDir: string
  readonly shim: string
  readonly executable: string
  readonly cliEntry: string
  /** Protocol-neutral launcher used by persistent, CLI-owned MCP config files. */
  readonly mcpEntry: string
  /** Protocol-versioned implementation selected atomically by `mcpEntry`. */
  readonly mcpTarget: string
  /** The connection bridge a CLI spawns to reach an APP-held connection (ADR 0014).
   *  Written into CLI configs the same way `mcpEntry` is — and, like it, carrying no
   *  secret whatsoever: the token stays in the app, on the far side of the socket. */
  readonly connectionEntry: string
  /**
   * The SHIM a connection's CLI-config entry actually names.
   *
   * Not a cosmetic wrapper. A stored server entry is validated (registry.ts), and that
   * validator refuses any env value that is not a `${VAR}` reference — deliberately, so
   * no credential literal can ever be written into a CLI config. `ELECTRON_RUN_AS_NODE=1`
   * is not a credential, but it IS a literal, so an entry carrying it is refused. The
   * house server never hit this because it is `builtIn` and never stored.
   *
   * Rather than punch a hole in that validator, the shim absorbs the variable: it sets
   * ELECTRON_RUN_AS_NODE itself, so the config entry is a bare command with NO env at all.
   * The safer rule stays intact, and the config line gets shorter.
   */
  readonly connectionShim: string
  /** Minimal package metadata consumed by the copied MCP implementation. */
  readonly packageMeta: string
}

let installedRuntime: CliRuntime | null = null

/** Quote one literal for the generated POSIX shim. */
const shQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

/** Batch files expand `%NAME%` even inside quotes; `%%` is a literal percent in a batch file. */
const cmdLiteral = (value: string): string => value.replace(/%/g, '%%')

export function cliShimSource(platform: NodeJS.Platform, executable: string, cli: string): string {
  if (platform === 'win32') {
    return (
      '@echo off\r\n' +
      'setlocal DisableDelayedExpansion\r\n' +
      'set "ELECTRON_RUN_AS_NODE=1"\r\n' +
      `"${cmdLiteral(executable)}" "${cmdLiteral(cli)}" %*\r\n`
    )
  }
  return `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shQuote(executable)} ${shQuote(cli)} "$@"\n`
}

const samePathEntry = (left: string, right: string): boolean =>
  process.platform === 'win32' ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US') : left === right

const pathContains = (root: string, candidate: string): boolean => {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Pick an executable that remains launchable after this process exits.
 *
 * An AppImage's `process.execPath` lives below its temporary APPDIR mount. APPIMAGE names the
 * original file, but those variables can also be inherited by an unrelated child process, so
 * use it only when this Electron executable is actually inside the advertised mount.
 */
export function stableRuntimeExecutable(
  platform: NodeJS.Platform = process.platform,
  executable: string = process.execPath,
  env: NodeJS.ProcessEnv = process.env,
  packaged: boolean = app.isPackaged
): string {
  if (!packaged || platform !== 'linux' || !env.APPIMAGE || !env.APPDIR) return executable
  if (!isAbsolute(env.APPIMAGE) || !isAbsolute(env.APPDIR) || !pathContains(env.APPDIR, executable)) return executable
  // APPIMAGE/APPDIR are ordinary inherited variables. Requiring a packaged app plus actual
  // executable containment prevents a dev/deb child from accepting an inherited parent
  // AppImage, while still supporting non-default mountpoints and extract-and-run mode.
  try {
    return statSync(env.APPIMAGE).isFile() && statSync(env.APPDIR).isDirectory() ? env.APPIMAGE : executable
  } catch {
    return executable
  }
}

const renamePause = new Int32Array(new SharedArrayBuffer(4))

/** Atomic same-directory replacement, with a short Windows sharing-violation retry. */
function replaceAtomic(tmp: string, target: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, target)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      const retryable = process.platform === 'win32' && ['EACCES', 'EBUSY', 'EEXIST', 'EPERM'].includes(code ?? '')
      if (!retryable || attempt >= 7) throw err
      Atomics.wait(renamePause, 0, 0, 25)
    }
  }
}

/** Replace one runtime file atomically where the host filesystem supports it. */
function installSatellite(source: string, target: string): void {
  if (!existsSync(source)) throw new Error(`bundled CLI runtime file is missing: ${source}`)
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now().toString(36)}.tmp`)
  try {
    copyFileSync(source, tmp)
    if (process.platform !== 'win32') chmodSync(tmp, 0o600)
    replaceAtomic(tmp, target)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      /* already renamed or never created */
    }
    throw err
  }
}

function writePrivateFileAtomic(target: string, content: string, mode = 0o600): void {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now().toString(36)}.tmp`)
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', mode })
    if (process.platform !== 'win32') chmodSync(tmp, mode)
    replaceAtomic(tmp, target)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      /* already renamed or never created */
    }
    throw err
  }
}

/**
 * A managed MCP config may outlive the protocol release that wrote it. Keep its argument stable
 * and atomically switch this tiny launcher only after the complete versioned bundle is installed.
 * Existing MCP processes keep their imported target; new ones select the current target.
 */
export function stableMcpLauncherSource(target: string): string {
  return (
    '#!/usr/bin/env node\n' +
    "import { existsSync } from 'node:fs'\n" +
    "import { dirname, join, relative } from 'node:path'\n" +
    "import { pathToFileURL } from 'node:url'\n" +
    `const current = ${JSON.stringify(target)}\n` +
    'let selected = current\n' +
    'const endpoint = process.env.MOGGING_DAEMON_ENDPOINT\n' +
    'if (endpoint) {\n' +
    '  const runRoot = dirname(dirname(dirname(current)))\n' +
    '  const segment = relative(runRoot, dirname(endpoint))\n' +
    "  if (/^(?:dev-)?v[1-9]\\d*$/.test(segment)) {\n" +
    "    const paneTarget = join(runRoot, segment, 'bin', 'mogging-mcp.mjs')\n" +
    '    if (existsSync(paneTarget)) selected = paneTarget\n' +
    '  }\n' +
    '}\n' +
    'await import(pathToFileURL(selected).href)\n'
  )
}

/**
 * Install the app-owned `mogging` command for pane descendants.
 *
 * The package's npm `bin` metadata does not put a desktop installation on PATH. Main copies the
 * self-contained CLI/MCP files to the private, protocol-versioned runtime before the daemon
 * starts, then prepends a generated shim to the environment inherited by both PTY backends.
 * Keeping both the script and executable outside an AppImage mount lets pane commands and CLI
 * MCP configs outlive the app process. Electron-as-Node means no agent needs a system Node.
 */
export function installCliRuntime(): CliRuntime {
  const root = runtimeDir()
  const dir = join(root, 'bin')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') {
    chmodSync(root, 0o700)
    chmodSync(dir, 0o700)
  }

  const bundledBin = join(app.getAppPath(), 'bin')
  const packageMeta = join(root, 'package.json')
  // The copied MCP reads ../package.json during module initialization. Land the new metadata
  // before replacing the entry module, and keep it intentionally minimal.
  writePrivateFileAtomic(packageMeta, JSON.stringify({ version: app.getVersion() }) + '\n')
  for (const rel of SATELLITES) installSatellite(join(bundledBin, rel), join(dir, rel))
  if (process.platform !== 'win32') chmodSync(join(dir, 'lib'), 0o700)

  const shim = join(dir, process.platform === 'win32' ? 'mogging.cmd' : 'mogging')
  const cliEntry = join(dir, 'mogging.mjs')
  const mcpTarget = join(dir, 'mogging-mcp.mjs')
  const stableMcpDir = join(dirname(root), channelFromEnv() === 'dev' ? 'dev-mcp' : 'mcp')
  const mcpEntry = join(stableMcpDir, 'mogging-mcp.mjs')
  writePrivateFileAtomic(mcpEntry, stableMcpLauncherSource(mcpTarget))
  // The bridge gets the SAME protocol-neutral launcher treatment as the house server:
  // a connection's CLI config entry may outlive the release that wrote it.
  const connectionEntry = join(stableMcpDir, 'mogging-connection.mjs')
  writePrivateFileAtomic(connectionEntry, stableMcpLauncherSource(join(dir, 'mogging-connection.mjs')))
  if (process.platform !== 'win32') chmodSync(stableMcpDir, 0o700)
  const executable = stableRuntimeExecutable()
  writePrivateFileAtomic(shim, cliShimSource(process.platform, executable, cliEntry), process.platform === 'win32' ? 0o600 : 0o700)
  // The bridge's own shim — same generator, same ELECTRON_RUN_AS_NODE trick, so a
  // connection's CLI-config entry is a bare command with no env map to validate.
  const connectionShim = join(dir, process.platform === 'win32' ? 'mogging-connection.cmd' : 'mogging-connection')
  writePrivateFileAtomic(
    connectionShim,
    cliShimSource(process.platform, executable, connectionEntry),
    process.platform === 'win32' ? 0o600 : 0o700
  )

  const prior = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  process.env.PATH = [dir, ...prior.filter((entry) => !samePathEntry(entry, dir))].join(delimiter)
  process.env.MOGGING_CLI = shim
  if (process.platform === 'win32') {
    const ext = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    if (!ext.some((entry) => entry.toUpperCase() === '.CMD')) ext.push('.CMD')
    process.env.PATHEXT = ext.join(';')
  }

  installedRuntime = Object.freeze({
    binDir: dir,
    shim,
    executable,
    cliEntry,
    mcpEntry,
    mcpTarget,
    connectionEntry,
    connectionShim,
    packageMeta
  })
  return installedRuntime
}

/** The installed runtime is a boot invariant; config writers must never fall back to app.asar. */
export function getCliRuntime(): CliRuntime {
  if (!installedRuntime) throw new Error('CLI runtime has not been installed')
  return installedRuntime
}
