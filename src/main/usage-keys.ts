import { safeStorage } from 'electron'
import type { KeySlot } from '@contracts'
import { redactSecrets } from '@backend/features/review'
import { getSettingsStore } from './app-settings'

// The key store (Phase-7/05, ADR 0007.a). Paste-once → safeStorage encrypt →
// ONLY ciphertext in the settings KV. WRITE-ONLY is structural: this module
// exports set / clear / slot(presence) / resolve — and `resolve` is consumed
// ONLY by the usage fetch path in main/backends; no IPC handler calls it and
// no channel exists that could carry a plaintext to a renderer.
//
// Never plaintext at rest: encryption unavailable (Linux without a keyring)
// -> storage REFUSED with the env-ref hint, not a silent downgrade.

const KV_CIPHER = (id: string): string => `usage.keycipher.${id}`
const KV_ENVREF = (id: string): string => `usage.keyenv.${id}`
const ENV_NAME = /^[A-Z][A-Z0-9_]{2,40}$/

/** REAL vault availability. Linux's `basic_text` backend is obfuscation, not
 *  encryption — the ADR treats it as UNAVAILABLE (refuse, offer env-ref)
 *  rather than silently storing weakly-protected bytes. */
export function isKeyVaultAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  if (process.platform === 'linux') {
    try {
      return safeStorage.getSelectedStorageBackend() !== 'basic_text'
    } catch {
      return false
    }
  }
  return true
}

// Smoke hook: lets the USAGE gate exercise the encryption-unavailable refusal
// on a machine where the OS vault IS available. Production never touches it.
let availabilityProbe: () => boolean = isKeyVaultAvailable
export function setKeyAvailabilityProbeForSmoke(probe: (() => boolean) | null): void {
  availabilityProbe = probe ?? isKeyVaultAvailable
}

export function keySlot(providerId: string): KeySlot {
  const kv = getSettingsStore()
  const envRef = kv?.getSetting(KV_ENVREF(providerId))
  if (envRef) return { kind: 'env-ref', envRef }
  if (kv?.getSetting(KV_CIPHER(providerId))) return { kind: 'keychain' }
  return { kind: 'none' }
}

/** Paste path: encrypt immediately; the plaintext argument is never stored,
 *  logged, or echoed — the return carries ok/reason only. */
export function keySetPlaintext(providerId: string, plaintext: string): { ok: boolean; reason?: string } {
  if (typeof plaintext !== 'string' || !plaintext.trim() || plaintext.length > 4096) {
    return { ok: false, reason: 'paste a non-empty key (max 4096 chars)' }
  }
  if (!availabilityProbe()) {
    return {
      ok: false,
      reason: 'OS keychain encryption is unavailable on this system — use an env-ref instead (e.g. ${OPENROUTER_KEY})'
    }
  }
  const cipher = safeStorage.encryptString(plaintext.trim()).toString('base64')
  const kv = getSettingsStore()
  kv?.setSetting(KV_CIPHER(providerId), cipher)
  kv?.setSetting(KV_ENVREF(providerId), '') // keychain replaces any env-ref
  return { ok: true }
}

/** Env-ref path: the NAME persists, never a value; a secret-shaped literal is
 *  refused with the same deny-list heuristic profiles use (ADR 0002). */
export function keySetEnvRef(providerId: string, envRefRaw: string): { ok: boolean; reason?: string } {
  const envRef = String(envRefRaw ?? '')
    .trim()
    .replace(/^\$\{?/, '')
    .replace(/\}$/, '')
  if (!ENV_NAME.test(envRef)) return { ok: false, reason: 'env-ref must be a VARIABLE NAME like ${OPENROUTER_KEY}' }
  if (redactSecrets(envRef).redactions > 0) return { ok: false, reason: 'that looks like a key VALUE — paste it in the key field, or give a variable NAME' }
  const kv = getSettingsStore()
  kv?.setSetting(KV_ENVREF(providerId), envRef)
  kv?.setSetting(KV_CIPHER(providerId), '')
  return { ok: true }
}

export function keyClear(providerId: string): void {
  const kv = getSettingsStore()
  kv?.setSetting(KV_CIPHER(providerId), '')
  kv?.setSetting(KV_ENVREF(providerId), '')
}

/** The usage-fetch path ONLY (adapters, in memory, per request). Never exposed
 *  over any channel. Returns null when no usable key exists. */
export function resolveKey(providerId: string): string | null {
  const slot = keySlot(providerId)
  if (slot.kind === 'env-ref') return process.env[slot.envRef] ?? null
  if (slot.kind === 'keychain') {
    const cipher = getSettingsStore()?.getSetting(KV_CIPHER(providerId))
    if (!cipher) return null
    try {
      return safeStorage.decryptString(Buffer.from(cipher, 'base64'))
    } catch {
      return null // vault changed (new machine/OS) — the user re-pastes
    }
  }
  return null
}
