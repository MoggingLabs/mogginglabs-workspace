import type { KeySlot } from '@contracts'
import { redactSecrets } from '@backend/features/review'
import { getSettingsStore } from './app-settings'
import { isVaultAvailable, setVaultProbeForSmoke, vaultAvailable, vaultClearKey, vaultHas, vaultLoad, vaultStore } from './vault'

// The key store (Phase-7/05, ADR 0007.a) — now CONSUMER ONE of the extracted
// `vault.ts` (8/08), behavior unchanged. Paste-once → vault ciphertext → ONLY
// ciphertext in the settings KV. WRITE-ONLY is structural: this module exports
// set / clear / slot(presence) / resolve — `resolve` is consumed ONLY by the
// usage fetch path; no IPC handler or channel can carry a plaintext to a
// renderer. Vault unavailable -> REFUSED with the env-ref hint (never a
// silent plaintext downgrade).

const KV_CIPHER = (id: string): string => `usage.keycipher.${id}`
const KV_ENVREF = (id: string): string => `usage.keyenv.${id}`
const ENV_NAME = /^[A-Z][A-Z0-9_]{2,40}$/

/** Vault availability (re-exported from the shared primitive so existing
 *  importers — the agent-web persistence probe, the usage smokes — keep their
 *  API). One probe governs every consumer. */
export const isKeyVaultAvailable = isVaultAvailable
export const setKeyAvailabilityProbeForSmoke = setVaultProbeForSmoke

export function keySlot(providerId: string): KeySlot {
  const envRef = getSettingsStore()?.getSetting(KV_ENVREF(providerId))
  if (envRef) return { kind: 'env-ref', envRef }
  if (vaultHas(KV_CIPHER(providerId))) return { kind: 'keychain' }
  return { kind: 'none' }
}

/** Paste path: encrypt immediately; the plaintext argument is never stored,
 *  logged, or echoed — the return carries ok/reason only. */
export function keySetPlaintext(providerId: string, plaintext: string): { ok: boolean; reason?: string } {
  if (typeof plaintext !== 'string' || !plaintext.trim() || plaintext.length > 4096) {
    return { ok: false, reason: 'paste a non-empty key (max 4096 chars)' }
  }
  if (!vaultAvailable()) {
    return {
      ok: false,
      reason: 'OS keychain encryption is unavailable on this system — use an env-ref instead (e.g. ${OPENROUTER_KEY})'
    }
  }
  // A dropped write must not read as a save: vaultStore returns false when the settings store
  // is absent, and reporting ok there loses the user's pasted key silently (see service-keys).
  if (!vaultStore(KV_CIPHER(providerId), plaintext.trim())) {
    return { ok: false, reason: 'the settings store is not available right now — the key was not saved; try again' }
  }
  getSettingsStore()?.setSetting(KV_ENVREF(providerId), '') // keychain replaces any env-ref
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
  vaultClearKey(KV_CIPHER(providerId))
  getSettingsStore()?.setSetting(KV_ENVREF(providerId), '')
}

/** The usage-fetch path ONLY (adapters, in memory, per request). Never exposed
 *  over any channel. Returns null when no usable key exists. */
export function resolveKey(providerId: string): string | null {
  const slot = keySlot(providerId)
  if (slot.kind === 'env-ref') return process.env[slot.envRef] ?? null
  if (slot.kind === 'keychain') return vaultLoad(KV_CIPHER(providerId)) // null if the vault changed (re-paste)
  return null
}
