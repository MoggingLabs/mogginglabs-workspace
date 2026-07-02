import { ipcMain } from 'electron'
import { getSettingsStore } from './app-settings'
import { redactSecrets } from '@backend/features/review'
import { ProfileChannels, type AgentProfile } from '@contracts'

// App-wiring: provider profiles (Phase-4/04). THE ADR-0002 BOUNDARY: a profile is a
// pointer set — env names on a strict allowlist shape, values deny-listed against the
// SAME secret patterns the review redactor uses. A secret-shaped value cannot even be
// SAVED; the mistake is impossible at persistence, not just discouraged. Profile
// names/env keys may appear in telemetry as COUNTS only; values never leave main
// except inside a launch command string.

const ENV_NAME = /^[A-Z][A-Z0-9_]{2,40}$/
const ID_SHAPE = /^[\w.-]{1,64}$/

export function sanitizeProfile(raw: unknown): AgentProfile | null {
  const p = raw as Record<string, unknown> | null
  if (!p || typeof p !== 'object') return null
  if (typeof p.id !== 'string' || !ID_SHAPE.test(p.id)) return null
  if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 60) return null
  if (typeof p.provider !== 'string' || !ID_SHAPE.test(p.provider)) return null
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
  return { id: p.id, name: p.name.trim(), provider: p.provider, env, order }
}

export function registerProfiles(): void {
  ipcMain.handle(ProfileChannels.list, () => getSettingsStore()?.listProfiles() ?? [])
  ipcMain.handle(ProfileChannels.save, (_e, raw: unknown) => {
    const profile = sanitizeProfile(raw)
    if (!profile) return false
    getSettingsStore()?.saveProfile(profile)
    return true
  })
  ipcMain.handle(ProfileChannels.remove, (_e, id: unknown) => {
    if (typeof id === 'string' && id) getSettingsStore()?.removeProfile(id)
  })
}
