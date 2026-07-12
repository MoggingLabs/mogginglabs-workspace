import { safeStorage } from 'electron'
import { getSettingsStore } from './app-settings'

// The OS-vault ciphertext primitive (Phase-8/08, extracted from the 7/05 key
// store — ADR 0007.a / 0008.h). Encrypt IN, decrypt only at the point of use;
// the vault-unavailable path REFUSES (never plaintext at rest, never a silent
// downgrade). No getter is exposed over any channel — every consumer keeps
// that discipline; this primitive just makes plaintext-at-rest impossible.
// Consumers: usage keys (7/05, one), service keys (8/08, two), webhook URLs
// (8/10, three).

/** REAL vault availability. Linux's `basic_text` backend is obfuscation, not
 *  encryption — the ADR treats it as UNAVAILABLE (refuse, offer env-ref). */
export function isVaultAvailable(): boolean {
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

// ONE smoke hook for all vault consumers: exercise the encryption-unavailable
// refusal on a machine where the OS vault IS available. Production never sets it.
let probe: () => boolean = isVaultAvailable
export function setVaultProbeForSmoke(p: (() => boolean) | null): void {
  probe = p ?? isVaultAvailable
}
export function vaultAvailable(): boolean {
  return probe()
}

/** Encrypt to base64 ciphertext, or null when the vault is unavailable
 *  (the caller REFUSES rather than store plaintext). */
export function vaultEncrypt(plaintext: string): string | null {
  if (!vaultAvailable()) return null
  return safeStorage.encryptString(plaintext).toString('base64')
}

/** Decrypt at the point of use; null if the ciphertext no longer decrypts
 *  (new machine/OS — the user re-pastes). */
export function vaultDecrypt(cipher: string): string | null {
  try {
    return safeStorage.decryptString(Buffer.from(cipher, 'base64'))
  } catch {
    return null
  }
}

// ── KV-slot helpers: ciphertext at a settings-KV key ────────────────────────
// Presence-only reads for the UI (vaultHas); the plaintext is materialized ONLY
// via vaultLoad at the point of use and never returned to a renderer.
export function vaultStore(kvKey: string, plaintext: string): boolean {
  const cipher = vaultEncrypt(plaintext)
  if (cipher === null) return false
  // No store (before registerAppSettings / after disposeAppSettings) means the ciphertext is
  // DROPPED. `?.` swallowed that and returned true — the caller told the user "key saved".
  const store = getSettingsStore()
  if (!store) return false
  store.setSetting(kvKey, cipher)
  return true
}
export function vaultHas(kvKey: string): boolean {
  return !!getSettingsStore()?.getSetting(kvKey)
}
export function vaultLoad(kvKey: string): string | null {
  const cipher = getSettingsStore()?.getSetting(kvKey)
  return cipher ? vaultDecrypt(cipher) : null
}
export function vaultClearKey(kvKey: string): void {
  getSettingsStore()?.setSetting(kvKey, '')
}
