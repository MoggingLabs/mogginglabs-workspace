import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto'
import { openDeviceKey, type DeviceKeyBackend } from './device-key'

// DPoP proof keys (RFC 9449), sender-constraining our account tokens to a key pair.
//
// Since step 06 the key of record is the HARDWARE device key (./device-key): a
// non-exportable ECDSA P-256 key in the TPM (Windows) or Secure Enclave (macOS). The
// private half never exists in this process — every proof is signed by asking the chip
// — so the tokens the AS binds to it (`cnf.jkt`) are sender-constrained to THIS
// physical machine. A copied install carries the vault, maybe even plaintext-extracted
// tokens, but not the chip: its refresh proofs sign with a DIFFERENT key and the AS
// refuses them. That is what makes a copied install worthless.
//
// The SOFTWARE key below is the honest fallback for machines with no usable key store
// (Linux today — see docs/18-accounts.md): an in-process EC P-256 key persisted as
// vault ciphertext by account.ts. It is exportable by nature — `custody` says
// 'software' so nothing upstream can mistake it for hardware (the vault's own
// `basic_text` precedent: degrade out loud, refuse to overclaim).

export interface DpopPublicJwk {
  kty: 'EC'
  crv: 'P-256'
  x: string
  y: string
}

/** Where the private key actually lives — carried on every key so consumers (and the
 *  DEVICEKEY smoke) state the truth instead of assuming hardware. */
export interface DpopKeyCustody {
  backend: Exclude<DeviceKeyBackend, 'none'> | 'software'
  hardwareBacked: boolean
}

export interface DpopProofOptions {
  /** The HTTP method of the request the proof accompanies (RFC 9449 `htm`). */
  htm: string
  /** The request URI, no query/fragment (RFC 9449 `htu`). */
  htu: string
  /** The AS-supplied nonce, when one is in play (RFC 9449 §8). */
  nonce?: string
  /** Present only on resource-server calls: binds the proof to a specific access
   *  token via its hash (RFC 9449 `ath`). Omitted on token-endpoint requests. */
  accessToken?: string
}

export interface DpopKey {
  /** The public half, as it rides in every proof's JWT header. */
  readonly publicJwk: DpopPublicJwk
  /** RFC 7638 JWK thumbprint — the `cnf.jkt` the AS binds the tokens to. */
  readonly jkt: string
  /** Honest custody: 'tpm' | 'cng' | 'secure-enclave' (device key) or 'software'. */
  readonly custody: DpopKeyCustody
  /** A signed DPoP proof JWT for one request. Fresh `jti`/`iat` every call. Async
   *  because the hardware key signs on the chip (I7: key ops never block). */
  createProof(o: DpopProofOptions): Promise<string>
  /** PKCS8 PEM, for vault-ciphertext persistence. SOFTWARE keys only — a hardware
   *  key has no exportable private half, so the method is ABSENT by construction. */
  exportPrivateKeyPem?: () => string
}

const b64url = (buf: Buffer | string): string =>
  (typeof buf === 'string' ? Buffer.from(buf) : buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

/** RFC 7638: the required EC members, lexicographically ordered, no whitespace. */
export function jktOfPublicJwk(jwk: DpopPublicJwk): string {
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`
  return b64url(createHash('sha256').update(canonical).digest())
}

/** One proof builder for both custodies — only the signer differs. */
async function buildProof(publicJwk: DpopPublicJwk, o: DpopProofOptions, signInput: (input: Buffer) => Promise<Buffer>): Promise<string> {
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: publicJwk }
  const payload: Record<string, unknown> = { jti: randomUUID(), htm: o.htm, htu: o.htu, iat: Math.floor(Date.now() / 1000) }
  if (o.nonce) payload.nonce = o.nonce
  if (o.accessToken) payload.ath = b64url(createHash('sha256').update(o.accessToken).digest())
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
  const signature = await signInput(Buffer.from(signingInput))
  return `${signingInput}.${b64url(signature)}`
}

function toDpopKey(privateKey: KeyObject): DpopKey {
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' }) as { kty?: string; crv?: string; x?: string; y?: string }
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) {
    throw new Error('DPoP key must be EC P-256')
  }
  const publicJwk: DpopPublicJwk = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }

  return {
    publicJwk,
    jkt: jktOfPublicJwk(publicJwk),
    custody: { backend: 'software', hardwareBacked: false },
    createProof: (o) =>
      // ieee-p1363 = the raw r‖s JOSE signature ES256 wants (Node defaults to DER).
      buildProof(publicJwk, o, async (input) => sign('sha256', input, { key: privateKey, dsaEncoding: 'ieee-p1363' })),
    exportPrivateKeyPem(): string {
      return privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    }
  }
}

// ── The device key as a DpopKey (the step-06 swap) ───────────────────────────────────

/** The production key name. A VERSIONED constant: bumping it re-keys every install
 *  (every entitlement re-binds), so it moves only with a migration story. */
const DEVICE_KEY_NAME = 'MoggingLabsWorkspace.device.v1'

// Smoke seams (production leaves both untouched): a private key name so gates never
// touch the REAL machine identity, and a hardware bypass so the honest software
// fallback is exercisable on machines that do have a chip.
let deviceKeyName = DEVICE_KEY_NAME
let forceSoftware = false
export function setDeviceKeyNameForSmoke(name: string | null): void {
  deviceKeyName = name ?? DEVICE_KEY_NAME
}
export function setDeviceKeyForceSoftwareForSmoke(on: boolean): void {
  forceSoftware = on
}

/** 65-byte uncompressed P-256 point -> the JWK that rides in proof headers. */
export function devicePointToJwk(point: Buffer): DpopPublicJwk {
  return {
    kty: 'EC',
    crv: 'P-256',
    x: b64url(point.subarray(1, 33)),
    y: b64url(point.subarray(33, 65))
  }
}

/** The machine's device key, as a DpopKey. Opens (creating on first use) the
 *  non-exportable platform key; every createProof signs ON the chip. Null exactly
 *  when this machine has no hardware key store — the caller falls back to the
 *  software key and the 'software' custody says so. */
export async function openDeviceDpopKey(): Promise<DpopKey | null> {
  if (forceSoftware) return null
  const handle = await openDeviceKey(deviceKeyName)
  if (!handle) return null
  const publicJwk = devicePointToJwk(handle.publicKey)
  return {
    publicJwk,
    jkt: jktOfPublicJwk(publicJwk),
    custody: { backend: handle.backend, hardwareBacked: handle.hardwareBacked },
    createProof: (o) => buildProof(publicJwk, o, (input) => handle.sign(createHash('sha256').update(input).digest()))
    // no exportPrivateKeyPem: there is nothing to export, by construction
  }
}

/** A fresh SOFTWARE DPoP key — the fallback custody (and fixture keys in smokes). */
export function generateDpopKey(): DpopKey {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return toDpopKey(privateKey)
}

/** Rehydrate a persisted software key (the PKCS8 PEM account.ts vaulted). */
export function loadDpopKey(pkcs8Pem: string): DpopKey {
  return toDpopKey(createPrivateKey(pkcs8Pem))
}
