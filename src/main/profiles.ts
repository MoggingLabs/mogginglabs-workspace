import { ipcMain } from 'electron'
import { getSettingsStore } from './app-settings'
import { scheduleAccountDefaultsApply } from './agent-settings'
import { maybeFault, maybeMutationFault } from './fault-port'
import { auditDelay, wizardAuditFaults } from './wizard-audit-faults'
import { deriveProfileDefaults, sanitizeProfile } from './profile-rules'
import type { SettingsStore } from '@backend/features/workspace'
import { discoverLogins, probeLogin } from '@backend/features/agents'
import {
  ProfileChannels,
  type ProfileActivateResult,
  type ProfileRemoveResult
} from '@contracts'

// App-wiring: provider profiles (Phase-4/04, simplified). The user supplies a NAME
// and the SUBSCRIPTION EMAIL — everything else is derived at save time by the pure
// rules in profile-rules.ts (lifted there so the unit tier can test them without
// Electron): the failover order appends, and the env pointer set comes from the
// HOME_POINTER table (first profile per provider keeps the CLI's default home — the
// account already signed in; later ones get their own config home, where the CLI
// asks to sign in on first launch). THE ADR-0002 BOUNDARY holds in sanitizeProfile:
// a secret-shaped value cannot even be SAVED. The email is a label, never an auth
// input. Profile names/env keys may appear in telemetry as COUNTS only; values
// never leave main except inside a launch command string.

export { deriveProfileDefaults, materializeProfileEnv, sanitizeProfile } from './profile-rules'

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
      // Backfill a missing label — and on a DETECTED row (login-*) also follow a
      // CHANGED login: that row means "whoever is signed in here", not a declared
      // intent. A user-ADDED profile's label IS the intent; when reality drifts
      // from it, the list surfaces the mismatch (login state below) — the label
      // is never silently rewritten. Names are the user's in both cases.
      const stale =
        match?.id.startsWith('login-') && match.email
          ? match.email.toLowerCase() !== login.email?.toLowerCase()
          : !match?.email
      if (match && login.email && stale) {
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
      if (candidate) {
        store.saveProfile(candidate)
        // ADR 0022 step 03: a newly DISCOVERED account adopts the provider's
        // current defaults immediately — same trigger as an explicit save.
        // (Label backfills above schedule nothing: they don't move homes.)
        scheduleAccountDefaultsApply(candidate.provider)
      }
    }
  }
}

export function registerProfiles(): void {
  ipcMain.handle(ProfileChannels.list, async () => {
    await maybeFault(ProfileChannels.list) // finding 39's seam: half of Settings § Profiles' blank-tab defect
    const fault = wizardAuditFaults()
    const injected = fault?.profileListSequence?.shift()
    if (injected) {
      await auditDelay(injected.delayMs)
      return injected.profiles
    }
    const store = getSettingsStore()
    if (!store) return []
    try {
      syncDiscoveredLogins(store)
    } catch {
      /* discovery must never break listing */
    }
    // Read-time decoration: who is ACTUALLY signed in at each profile's home.
    // The email column stays the user's declared label; `login` is the checked
    // reality beside it (mismatch pill, "not signed in yet"). Never persisted.
    return store.listProfiles().map((profile) => {
      const login = probeLogin(profile.provider, profile)
      return login ? { ...profile, login } : profile
    })
  })
  ipcMain.handle(ProfileChannels.save, (_e, raw: unknown) => {
    const store = getSettingsStore()
    const profile = sanitizeProfile(deriveProfileDefaults(raw, store?.listProfiles() ?? []))
    if (!profile) return false
    store?.saveProfile(profile)
    // ADR 0022 step 03: a new or edited account inherits the provider's current
    // defaults on the same signal — no per-account opt-in, debounced downstream.
    scheduleAccountDefaultsApply(profile.provider)
    return true
  })
  ipcMain.handle(ProfileChannels.remove, (_e, id: unknown) => {
    const store = getSettingsStore()
    if (!store || typeof id !== 'string' || !id) return { ok: false, reason: 'error' } satisfies ProfileRemoveResult
    if (!store.listProfiles().some((profile) => profile.id === id)) {
      return { ok: false, reason: 'missing' } satisfies ProfileRemoveResult
    }
    const workspaces = store.load().workspaces
      .filter((workspace) => workspace.profileIds?.includes(id))
      .map((workspace) => workspace.name)
    if (workspaces.length) return { ok: false, reason: 'referenced', workspaces } satisfies ProfileRemoveResult
    store.removeProfile(id)
    // A profile-scoped agent-config intent must not outlive the profile it was granted to.
    store.removeAgentConfigTarget('profile', id)
    return { ok: true } satisfies ProfileRemoveResult
  })
  ipcMain.handle(ProfileChannels.activate, async (_e, raw: { providerId?: string; profileId?: string }) => {
    await maybeMutationFault('profile')
    const providerId = String(raw?.providerId ?? '')
    const profileId = String(raw?.profileId ?? '')
    const target = getSettingsStore()?.activateProfile(providerId, profileId)
    return target
      ? ({ ok: true, name: target.name } satisfies ProfileActivateResult)
      : ({ ok: false, reason: 'Profile is missing or belongs to another provider.' } satisfies ProfileActivateResult)
  })
}
