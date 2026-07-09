import { ipcMain } from 'electron'
import { getSettingsStore } from './app-settings'
import type { SettingsStore } from '@backend/features/workspace'
import { discoverLogins } from '@backend/features/agents'
import { redactSecrets } from '@backend/features/review'
import { HOME_POINTER } from '@backend/features/usage/homes'
import { ProfileChannels, type AgentProfile } from '@contracts'

// App-wiring: provider profiles (Phase-4/04, simplified). The user supplies a NAME
// and the SUBSCRIPTION EMAIL — everything else is derived HERE at save time: the
// failover order appends, and the env pointer set comes from the HOME_POINTER
// table (first profile per provider keeps the CLI's default home — the account
// already signed in; later ones get their own config home, where the CLI asks to
// sign in on first launch). THE ADR-0002 BOUNDARY still holds: env names on a
// strict allowlist shape, values deny-listed against the SAME secret patterns the
// review redactor uses — a secret-shaped value cannot even be SAVED. The email is
// a label, never an auth input. Profile names/env keys may appear in telemetry as
// COUNTS only; values never leave main except inside a launch command string.

const ENV_NAME = /^[A-Z][A-Z0-9_]{2,40}$/
const ID_SHAPE = /^[\w.-]{1,64}$/
const EMAIL_SHAPE = /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/

const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'profile'

/** Fill in what the simplified form no longer asks for. An EDIT keeps the stored
 *  env/order (a profile's config home is an identity — it must never move under a
 *  rename); a NEW profile appends to the failover order and derives its pointer.
 *  Explicit env/order in the payload (failover switch, smokes) are honored as-is. */
export function deriveProfileDefaults(raw: unknown, existing: AgentProfile[]): unknown {
  const p = raw as Record<string, unknown> | null
  if (!p || typeof p !== 'object') return raw
  const out: Record<string, unknown> = { ...p }
  const prior = existing.find((x) => x.id === p.id)
  if (out.email === undefined && prior?.email) out.email = prior.email
  if (out.order === undefined) {
    const siblings = existing.filter((x) => x.provider === p.provider && x.id !== p.id)
    out.order = prior?.order ?? (siblings.length ? Math.max(...siblings.map((s) => s.order)) + 1 : 0)
  }
  if (out.env === undefined) {
    if (prior) {
      out.env = prior.env
    } else {
      const provider = typeof p.provider === 'string' ? p.provider : ''
      const pointer = HOME_POINTER[provider]
      const siblings = existing.filter((x) => x.provider === provider)
      if (!pointer || !siblings.length) {
        out.env = {} // first profile = the CLI's default home (the login you already have)
      } else {
        const taken = new Set(siblings.map((s) => s.env[pointer]).filter(Boolean))
        const base = `~/.${provider}-${slugify(String(p.name ?? ''))}`
        let home = base
        for (let n = 2; taken.has(home); n++) home = `${base}-${n}`
        out.env = { [pointer]: home }
      }
    }
  }
  return out
}

export function sanitizeProfile(raw: unknown): AgentProfile | null {
  const p = raw as Record<string, unknown> | null
  if (!p || typeof p !== 'object') return null
  if (typeof p.id !== 'string' || !ID_SHAPE.test(p.id)) return null
  if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 60) return null
  if (typeof p.provider !== 'string' || !ID_SHAPE.test(p.provider)) return null
  let email: string | undefined
  if (p.email !== undefined) {
    if (typeof p.email !== 'string') return null
    email = p.email.trim()
    if (email && (email.length > 254 || !EMAIL_SHAPE.test(email))) return null
    if (!email) email = undefined
  }
  const order = Number(p.order)
  if (!Number.isInteger(order) || order < 0 || order > 99) return null
  const env: Record<string, string> = {}
  const rawEnv = p.env
  if (!rawEnv || typeof rawEnv !== 'object') return null
  const entries = Object.entries(rawEnv as Record<string, unknown>)
  if (entries.length > 10) return null
  for (const [k, v] of entries) {
    if (!ENV_NAME.test(k)) return null
    if (typeof v !== 'string' || !v || v.length > 512) return null
    if (/["`\r\n$]/.test(v)) return null // keeps shell quoting trivial + injection-free
    if (redactSecrets(v).redactions > 0) return null // THE deny-list: secret-shaped -> refused
    env[k] = v
  }
  return { id: p.id, name: p.name.trim(), provider: p.provider, email, env, order }
}

/** ALL logins must appear in profiles — a signed-in account the list doesn't
 *  show is an account the user can't launch under. Reconcile on every list:
 *  a discovered login with no profile becomes one (id `login-<provider>` —
 *  stable, so deletes reconcile back while the login exists); a login whose
 *  profile lacks an email label gets it backfilled. The user picks the default
 *  (order 0, the existing active-switch); the rest are the failover lanes. */
function syncDiscoveredLogins(store: SettingsStore): void {
  const profiles = store.listProfiles()
  for (const login of discoverLogins(profiles)) {
    if (login.profileId) {
      const match = profiles.find((p) => p.id === login.profileId)
      if (match && !match.email && login.email) {
        const updated = sanitizeProfile({ ...match, email: login.email })
        if (updated) store.saveProfile(updated)
      }
    } else {
      // Unmatched logins are always at the provider's DEFAULT home (discovery
      // probes known homes only), so the derived profile carries no pointer.
      const siblings = profiles.filter((p) => p.provider === login.provider)
      const draft = {
        id: `login-${login.provider}`,
        name: login.email?.split('@')[0] ?? 'Default',
        provider: login.provider,
        email: login.email,
        env: {},
        order: siblings.length ? Math.max(...siblings.map((s) => s.order)) + 1 : 0
      }
      // An odd email label must not hide the login itself — retry unlabeled.
      const candidate = sanitizeProfile(draft) ?? sanitizeProfile({ ...draft, name: 'Default', email: undefined })
      if (candidate) store.saveProfile(candidate)
    }
  }
}

export function registerProfiles(): void {
  ipcMain.handle(ProfileChannels.list, () => {
    const store = getSettingsStore()
    if (!store) return []
    try {
      syncDiscoveredLogins(store)
    } catch {
      /* discovery must never break listing */
    }
    return store.listProfiles()
  })
  ipcMain.handle(ProfileChannels.save, (_e, raw: unknown) => {
    const store = getSettingsStore()
    const profile = sanitizeProfile(deriveProfileDefaults(raw, store?.listProfiles() ?? []))
    if (!profile) return false
    store?.saveProfile(profile)
    return true
  })
  ipcMain.handle(ProfileChannels.remove, (_e, id: unknown) => {
    if (typeof id === 'string' && id) getSettingsStore()?.removeProfile(id)
  })
}
