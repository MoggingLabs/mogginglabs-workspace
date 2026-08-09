import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { redactSecrets } from '@backend/features/review'
import { HOME_POINTER, launchHomePointer } from '@backend/features/usage/homes'
import type { AgentProfile } from '@contracts'

// The pure profile rules (Phase-4/04), lifted out of profiles.ts's registerProfiles
// wiring so the unit tier can exercise them without Electron — same move as
// usage-prices.ts next door. profiles.ts re-exports everything here; the IPC layer
// and the import sites (agents.ts) are unchanged. THE ADR-0002 BOUNDARY lives in
// sanitizeProfile: env names on a strict allowlist shape, values deny-listed against
// the SAME secret patterns the review redactor uses — a secret-shaped value cannot
// even be SAVED.

const ENV_NAME = /^[A-Z][A-Z0-9_]{2,40}$/
const ID_SHAPE = /^[\w.-]{1,64}$/
const EMAIL_SHAPE = /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/

const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'profile'

function absoluteProfileHome(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return isAbsolute(value) ? value : resolve(homedir(), value)
}

/** Normalize legacy tilde pointers and ensure provider homes exist before a CLI
 * launch. Only the provider's canonical home pointer is touched.
 *
 * Every launch STATES its config home — it never merely fails to override one. The
 * built command's env prefix persists in the pane's shell for the pane's life
 * (launch.ts's envPrefix), so a profile carrying no pointer — `deriveProfileDefaults`
 * gives the FIRST profile `env: {}`, meaning "the CLI's default home" — used to emit
 * nothing and inherit the previously-launched profile's home. Switching back to that
 * profile then reported success and ran the OTHER account (found live 2026-08-04: the
 * app named the new profile, /status kept showing the old email). Asymmetric, so it
 * looked intermittent: A->B set a pointer and worked, B->A set nothing and did not.
 * `launchHomePointer` supplies the value, resolved by the SAME precedence the reading
 * side uses, so a launch's home and the home the app reads for it always agree. */
export function materializeProfileEnv(provider: string, env: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = { ...(env ?? {}) }
  const pin = launchHomePointer(provider, env)
  if (pin) out[pin.name] = pin.value
  const pointer = HOME_POINTER[provider]
  if (!pointer || !out[pointer]) return out
  const home = absoluteProfileHome(out[pointer])
  mkdirSync(home, { recursive: true })
  return { ...out, [pointer]: home }
}

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
        const taken = new Set(siblings.map((s) => s.env[pointer]).filter(Boolean).map(absoluteProfileHome))
        const base = join(homedir(), `.${provider}-${slugify(String(p.name ?? ''))}`)
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
    // THE deny-list: secret-shaped -> refused. Scanned as the PAIR, not the value alone.
    // Half the scrub's power is in the key: `ANTHROPIC_API_KEY=<40 ordinary chars>` matches
    // no token shape on its own, so scanning `v` by itself let exactly the credentials this
    // is here to stop walk into plaintext SQLite. settings-store.ts:52 already feeds the
    // pair for the same reason.
    if (redactSecrets(`${k}=${v}`).redactions > 0) return null
    env[k] = v
  }
  return { id: p.id, name: p.name.trim(), provider: p.provider, email, env, order }
}
