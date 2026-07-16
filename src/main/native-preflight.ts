import { app, type BrowserWindow } from 'electron'
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getTelemetry } from '@backend'
import { setDeviceKeyAddonPath } from '@backend/platform/device-key'
import { setBuildTampered } from './entitlements'
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

// The THIRD native module is ours: the device-key addon (phase-accounts/06), the
// TPM / Secure-Enclave key store behind the account's DPoP key. It lives in the repo
// (src/backend/platform/device-key), not node_modules, so it takes its own path: the
// dev tree's build output under `npm run dev`, the packaged app's extraResources copy
// otherwise (electron-builder.yml). Pure Node-API — ABI-stable across Electron bumps —
// built by scripts/build-device-key.mjs (postinstall + the rebuild:native set).
function deviceKeyAddonPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'device-key', 'device_key.node')
    : join(app.getAppPath(), 'src', 'backend', 'platform', 'device-key', 'build', 'Release', 'device_key.node')
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
  try {
    const p = deviceKeyAddonPath()
    if (!existsSync(p)) throw new Error(`device-key: missing compiled addon (${p}) — run: npm run rebuild:native`)
    require(p) // the same dlopen proof the other two get
    setDeviceKeyAddonPath(p) // the backend binding loads from the path proven here
  } catch (err) {
    fatal(err, 'native:device-key')
  }
}

// ── The runtime tamper self-check (ADR 0016 §hardening, phase-accounts/07) ────────────
//
// A modified build should not silently keep its PAID grants. Post-paint (NEVER the boot
// critical path — invariant I7), the app verifies its own integrity signal and the
// UNPACKED bin/ shims (the honest asarUnpack gap — outside app.asar, not covered by the
// integrity fuse, docs/18) against a SIGNED manifest. A mismatch sets the entitlements
// `tampered` flag, which withholds PAID features while the FREE app runs fully
// (invariant I2 — never a brick). It is EVIDENCE + a revocation trigger, not prevention:
// a patched fork can strip this very check, and docs/18 says so.
//
// The manifest + verify key are the OPERATOR's wiring (like the entitlement issuer):
// production ships them, tests inject FIXTURES as parameters (never the environment;
// ORIGINPIN). Until wired, `tamperConfig` is null and the check is a no-op — zero boot
// cost, no false positives.

/** A signed integrity manifest: expected sha256 (hex) per unpacked file, plus a version
 *  tag. The detached Ed25519 signature covers its CANONICAL JSON. */
export interface TamperManifest {
  v: number
  files: Record<string, string>
}
export interface TamperCheckConfig {
  /** The `{ manifest, sig }` document (sig = b64url Ed25519 over canonical(manifest)). */
  manifestPath: string
  /** The operator's Ed25519 verify key (SPKI PEM). Fixture-injected under the gate. */
  verifyKeyPem: string
  /** The root the manifest's relative paths resolve against (the unpacked bin/ dir). */
  baseDir: string
}
export interface TamperResult {
  /** Did a manifest exist to check? False in production until the operator wires one. */
  ran: boolean
  /** The verdict: a bad signature or ANY file mismatch. */
  tampered: boolean
  /** Did the manifest's own signature verify? */
  signatureOk: boolean
  /** Relative paths that hashed differently (or were missing). */
  mismatches: string[]
}

let tamperConfig: TamperCheckConfig | null = null
/** Test seam: point the self-check at a fixture manifest + key + bin dir. Production
 *  leaves this null (no manifest wired yet) — the check is inert. */
export function configureTamperCheckForSmoke(cfg: TamperCheckConfig | null): void {
  tamperConfig = cfg
}

/** Canonical JSON: keys sorted so the signer and the verifier hash identical bytes. */
function canonicalManifest(m: TamperManifest): string {
  const files: Record<string, string> = {}
  for (const k of Object.keys(m.files).sort()) files[k] = m.files[k]
  return JSON.stringify({ v: m.v, files })
}
/** The exact bytes the verifier signs over — exported so the WATERMARK smoke's fixture
 *  signer and this verifier share ONE canonicalization (no drift). */
export function canonicalTamperManifestForSmoke(m: TamperManifest): string {
  return canonicalManifest(m)
}

const b64urlToBuf = (s: string): Buffer => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

/** Verify the app's integrity signal + the unpacked bin/ shims against the signed
 *  manifest. Total and non-throwing: any read/parse failure resolves to a verdict, never
 *  an exception (a self-check must not itself brick the app). */
function verifyBuildIntegrity(): TamperResult {
  const cfg = tamperConfig
  if (!cfg) return { ran: false, tampered: false, signatureOk: true, mismatches: [] }
  try {
    const doc = JSON.parse(readFileSync(cfg.manifestPath, 'utf8')) as { manifest?: TamperManifest; sig?: string }
    if (!doc.manifest || typeof doc.sig !== 'string' || !doc.manifest.files) {
      return { ran: true, tampered: true, signatureOk: false, mismatches: ['<manifest malformed>'] }
    }
    let signatureOk = false
    try {
      const key = createPublicKey(cfg.verifyKeyPem)
      // Ed25519 in node: algorithm null; the key decides.
      signatureOk = verifySignature(null, Buffer.from(canonicalManifest(doc.manifest)), key, b64urlToBuf(doc.sig))
    } catch {
      signatureOk = false
    }
    const mismatches: string[] = []
    for (const [rel, expected] of Object.entries(doc.manifest.files)) {
      try {
        const actual = createHash('sha256').update(readFileSync(join(cfg.baseDir, rel))).digest('hex')
        if (actual !== expected) mismatches.push(rel)
      } catch {
        mismatches.push(rel) // a missing/unreadable declared file is a mismatch
      }
    }
    // An unverifiable manifest is treated as tampered: we cannot trust an integrity
    // signal we cannot authenticate. Free is unaffected either way.
    return { ran: true, tampered: !signatureOk || mismatches.length > 0, signatureOk, mismatches }
  } catch {
    return { ran: true, tampered: true, signatureOk: false, mismatches: ['<manifest unreadable>'] }
  }
}

/** Run the self-check and APPLY its verdict: on a modified build, withhold PAID
 *  (entitlements `tampered`) and emit the BOOLEAN piracy signal `build.modified`
 *  (consent-gated by the Telemetry port, ADR 0005 — no path, no filename, no id). */
export function runTamperSelfCheck(): TamperResult {
  const result = verifyBuildIntegrity()
  if (!result.ran) return result
  setBuildTampered(result.tampered)
  // Boolean only — the RATE of modification, never which file or where.
  getTelemetry().captureEvent({ name: 'build.modified', props: { modified: result.tampered } })
  return result
}

/** Wire the self-check to run POST-PAINT (I7). Inert in production today (no manifest
 *  wired → tamperConfig null → immediate return, zero cost); it comes alive the day the
 *  operator ships a signed manifest + pinned key. */
export function scheduleTamperSelfCheck(getWin: () => BrowserWindow | null): void {
  if (!tamperConfig) return
  const kick = (): void => void setTimeout(() => runTamperSelfCheck(), 0)
  const win = getWin()
  if (win && !win.isDestroyed() && win.webContents.isLoading()) win.webContents.once('did-finish-load', kick)
  else kick()
}
