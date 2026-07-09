import { app, dialog } from 'electron'
import { getTelemetry } from '@backend'

// A main-process failure must END the process, loudly. v0.6.0 shipped a better-sqlite3 built
// against the previous Electron ABI: `registerAppSettings()` threw inside the unguarded
// `app.whenReady().then(async ...)` chain, Node printed an UnhandledPromiseRejectionWarning,
// boot aborted before openWindow() — and Electron stayed alive with no window and exit code 0.
// Nothing failed a gate, so it survived a commit. Every unhandled error now lands here.

let dying = false
let headless = false

/** The native modules (node-pty, better-sqlite3) are compiled against Electron's exact ABI by
 * the postinstall. A stale `build/` from an older Electron loads as a NODE_MODULE_VERSION
 * mismatch; a build that never ran is a missing .node. Neither is recoverable at runtime. */
function nativeModuleHint(err: unknown, op: string): string | null {
  const m = err instanceof Error ? err.message : String(err)
  if (m.includes('NODE_MODULE_VERSION') || m.includes('compiled against a different Node.js version'))
    return 'A native module was compiled for a different Electron ABI (its build/ is stale).'
  // The preflight's own diagnostics (op `native:<mod>`) are already precise; anything else that
  // reaches here naming a module's addon path is a load failure too.
  if (op.startsWith('native:') || /Cannot find module .*[\\/]build[\\/]Release[\\/].*\.node/.test(m))
    return 'A native module could not be loaded.'
  return null
}

function describe(err: unknown, op: string): string {
  const base = err instanceof Error && err.stack ? err.stack : String(err)
  const hint = nativeModuleHint(err, op)
  if (!hint) return base
  return `${base}\n\n${hint}\nRebuild both against the installed Electron:\n\n    npm run rebuild:native\n`
}

/**
 * Report and exit non-zero. Never returns. Idempotent: the first error wins, so a cascade
 * during teardown cannot mask the cause.
 */
export function fatal(err: unknown, op: string): void {
  if (dying) return
  dying = true
  const text = describe(err, op)
  console.error(`\n[fatal:${op}] ${text}\n`)
  try {
    getTelemetry().captureError(err, { feature: 'boot', op, platform: process.platform })
  } catch {
    /* telemetry must never mask the real error */
  }
  // Smokes and CI run headless: a modal would hang the runner instead of failing it.
  if (!headless && app.isReady()) {
    try {
      dialog.showErrorBox('MoggingLabs Workspace failed to start', text)
    } catch {
      /* no display -> stderr above is the report */
    }
  }
  app.exit(1)
}

/** Install before `app.whenReady()` so a failure during early wiring is still caught. */
export function installFatalHandlers(isSmoke: boolean): void {
  headless = isSmoke
  process.on('uncaughtException', (e) => fatal(e, 'uncaughtException'))
  process.on('unhandledRejection', (e) => fatal(e, 'unhandledRejection'))
}
