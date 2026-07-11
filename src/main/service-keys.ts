import { getSettingsStore } from './app-settings'
import { vaultAvailable, vaultClearKey, vaultHas, vaultLoad, vaultStore } from './vault'

// Service-key store (Phase-8/08). A service key (e.g. POSTHOG_API_KEY) pasted
// ONCE -> vault ciphertext at a KV slot; the CLI config references ${NAME}, and
// the app materializes the value into pane ENVIRONMENTS at launch — never a
// literal in any config, never plaintext at rest. WRITE-ONLY, structurally:
// set / clear / list-presence only; the value materializes ONLY into the spawn
// env map (in memory, pre-spawn) via resolveServiceKeyEnv, which no IPC handler
// or channel exposes to a renderer. Lives in main because the vault is
// Electron safeStorage (the electron-free @backend can't touch it).

const KV_CIPHER = (name: string): string => `integrations.vaultkey.${name}`
const KV_INDEX = 'integrations.vaultkey.index' // JSON array of stored env NAMEs (presence only)
const ENV_NAME = /^[A-Z][A-Z0-9_]{2,64}$/

function names(): string[] {
  try {
    const raw = getSettingsStore()?.getSetting(KV_INDEX)
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(arr) ? arr.filter((n): n is string => typeof n === 'string') : []
  } catch {
    return []
  }
}
function setNames(ns: string[]): void {
  getSettingsStore()?.setSetting(KV_INDEX, JSON.stringify([...new Set(ns)]))
}

/** The env NAMEs with a stored vault key (presence only — never values). */
export function serviceKeyNames(): string[] {
  return names().filter((n) => vaultHas(KV_CIPHER(n)))
}

export function serviceKeyHas(name: string): boolean {
  return vaultHas(KV_CIPHER(String(name)))
}

/** Paste-once: a secret VALUE under an env NAME -> vault ciphertext. The value
 *  is never stored plaintext, logged, or echoed; the return is ok/reason only.
 *  Vault unavailable -> REFUSED (the caller offers the env-ref instead). */
export function serviceKeySet(nameRaw: string, plaintext: string): { ok: boolean; reason?: string } {
  const name = String(nameRaw ?? '')
    .trim()
    .replace(/^\$\{?/, '')
    .replace(/\}$/, '')
  if (!ENV_NAME.test(name)) return { ok: false, reason: 'the env NAME must look like POSTHOG_API_KEY (A–Z, 0–9, underscore)' }
  if (typeof plaintext !== 'string' || !plaintext.trim() || plaintext.length > 4096) {
    return { ok: false, reason: 'paste a non-empty key (max 4096 chars)' }
  }
  if (!vaultAvailable()) {
    return {
      ok: false,
      reason: `OS keychain encryption is unavailable here — set ${name} as an env var in your own environment and reference it as \${${name}} instead`
    }
  }
  // vaultStore returns false when the settings store is gone (called before registerAppSettings
  // or after dispose — shutdown-ordered IPC). Ignoring it reported "key saved" while the
  // ciphertext was dropped on the floor, and the user's pasted secret was simply gone.
  if (!vaultStore(KV_CIPHER(name), plaintext.trim())) {
    return { ok: false, reason: 'the settings store is not available right now — the key was not saved; try again' }
  }
  setNames([...names(), name])
  return { ok: true }
}

export function serviceKeyClear(nameRaw: string): void {
  const name = String(nameRaw ?? '').trim()
  vaultClearKey(KV_CIPHER(name))
  setNames(names().filter((n) => n !== name))
}

/** Materialize ALL stored service keys into an env map — in memory, at pane
 *  spawn ONLY (main injects it into the spawn message; the daemon merges it
 *  into the PTY env, never typed, never in scrollback). Never returned to a
 *  renderer, never logged. Removal takes effect on the NEXT launch. */
export function resolveServiceKeyEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of names()) {
    const v = vaultLoad(KV_CIPHER(name))
    if (v != null) env[name] = v
  }
  return env
}
