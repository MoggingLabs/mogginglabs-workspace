// The device key (phase-accounts/06): a persisted ECDSA P-256 key whose private half
// lives in the platform key store and CANNOT leave it — Windows: CNG (TPM's Platform
// Crypto Provider when present, the software KSP otherwise — either way finalized
// non-exportable, DPAPI-protected at rest); macOS: the Secure Enclave. The native addon
// (src/, built by scripts/build-device-key.mjs, dlopen-proven by native-preflight.ts)
// exposes generate/sign/public-key and NOTHING that returns private material — the
// non-exportability is the provider's, not a promise of ours.
//
// This module is the typed seam over that addon. It is Electron-free (@backend law):
// the composition root (src/main/native-preflight.ts) resolves where the .node lives
// (dev tree vs packaged resources) and hands the path in via setDeviceKeyAddonPath.
// Every operation is async end to end (I7): the chip can take hundreds of milliseconds
// and the addon runs each call as napi_async_work off the main thread.
//
// HONESTY: `openDeviceKey` answers null exactly when this machine/process has no
// hardware key store (Linux today; a macOS build without a usable enclave/keychain).
// The caller (dpop-key.ts) then takes the DOCUMENTED software fallback and reports
// `custody.backend: 'software'` — the vault's own `basic_text` precedent: degrade out
// loud, never claim hardware that is not there.

export type DeviceKeyBackend = 'tpm' | 'cng' | 'secure-enclave' | 'none'

export interface DeviceKeyProbe {
  backend: DeviceKeyBackend
  /** True only when the key material is chip-resident (TPM / Secure Enclave). The
   *  Windows software KSP ('cng') is non-exportable by policy but not hardware. */
  hardwareBacked: boolean
}

export interface DeviceKeyHandle {
  readonly backend: Exclude<DeviceKeyBackend, 'none'>
  readonly hardwareBacked: boolean
  /** The public half: 65-byte uncompressed X9.62 point (0x04 || X || Y). */
  readonly publicKey: Buffer
  /** ECDSA-sign a SHA-256 digest with the platform key. Returns the 64-byte r||s
   *  (IEEE P1363) signature ES256 wants — DER from the OS is normalized here. */
  sign(digest: Buffer): Promise<Buffer>
  /** Ask the OS to export the PRIVATE half — the answer must be a refusal. Exists so
   *  the DEVICEKEY smoke proves non-exportability against the real provider instead
   *  of trusting this comment. */
  tryExportPrivate(): Promise<{ attempted: boolean; refused: boolean }>
}

interface NativeAddon {
  probe(): Promise<{ backend: string; hardwareBacked: boolean }>
  open(name: string): Promise<{ backend: string; hardwareBacked: boolean; publicKey: Buffer }>
  sign(name: string, digest: Buffer): Promise<Buffer>
  tryExport(name: string): Promise<{ attempted: boolean; refused: boolean }>
  del(name: string): Promise<boolean>
}

let addonPath: string | null = null
let addon: NativeAddon | null = null

/** Composition-root only (native-preflight.ts): where the compiled addon lives. */
export function setDeviceKeyAddonPath(p: string): void {
  addonPath = p
  addon = null
}

function loadAddon(): NativeAddon {
  if (addon) return addon
  if (!addonPath) {
    throw new Error('device-key: addon path not set — native-preflight.ts sets it at boot')
  }
  // dlopen of a .node by absolute path — the native-preflight pattern.
  addon = require(addonPath) as NativeAddon
  return addon
}

const isNoHardware = (e: unknown): boolean => (e as { code?: string })?.code === 'EDEVICEKEY_NOHW'

/** What key store this machine offers, without creating anything. */
export async function probeDeviceKey(): Promise<DeviceKeyProbe> {
  try {
    const p = await loadAddon().probe()
    return { backend: p.backend as DeviceKeyBackend, hardwareBacked: p.hardwareBacked }
  } catch (e) {
    if (isNoHardware(e)) return { backend: 'none', hardwareBacked: false }
    throw e
  }
}

/** Open the named device key, creating it on first use. Null exactly when this
 *  machine/process has no hardware key store (the honest-fallback signal). */
export async function openDeviceKey(name: string): Promise<DeviceKeyHandle | null> {
  const native = loadAddon()
  let opened: { backend: string; hardwareBacked: boolean; publicKey: Buffer }
  try {
    opened = await native.open(name)
  } catch (e) {
    if (isNoHardware(e)) return null
    throw e
  }
  if (opened.publicKey.length !== 65 || opened.publicKey[0] !== 0x04) {
    throw new Error('device-key: platform returned a malformed public key')
  }
  return {
    backend: opened.backend as Exclude<DeviceKeyBackend, 'none'>,
    hardwareBacked: opened.hardwareBacked,
    publicKey: opened.publicKey,
    async sign(digest: Buffer): Promise<Buffer> {
      const raw = await native.sign(name, digest)
      return raw.length === 64 ? raw : derToP1363(raw)
    },
    tryExportPrivate: () => native.tryExport(name)
  }
}

/** Remove the named key from the platform store (smoke teardown; never production —
 *  the device key IS the machine's licensing identity). */
export function deleteDeviceKey(name: string): Promise<boolean> {
  return loadAddon().del(name)
}

/** DER ECDSA-Sig-Value -> 64-byte r||s. macOS signs DER; ES256 wants P1363. */
function derToP1363(der: Buffer, size = 32): Buffer {
  let o = 0
  if (der[o++] !== 0x30) throw new Error('device-key: bad DER signature (no SEQUENCE)')
  if (der[o] & 0x80) o += 1 + (der[o] & 0x7f)
  else o += 1
  const readInt = (): Buffer => {
    if (der[o++] !== 0x02) throw new Error('device-key: bad DER signature (no INTEGER)')
    const len = der[o++]
    let v = der.subarray(o, o + len)
    o += len
    while (v.length > size && v[0] === 0x00) v = v.subarray(1)
    if (v.length > size) throw new Error('device-key: DER integer wider than the curve')
    return Buffer.concat([Buffer.alloc(size - v.length), v])
  }
  const r = readInt()
  const s = readInt()
  return Buffer.concat([r, s])
}
