// Deep-link PARSING — Electron-free on purpose, so the validation can be unit-tested.
//
// These functions decide what an untrusted URL is allowed to mean, and they had zero test
// coverage: everything around them lived in a module importing electron, so nothing could
// reach them without booting an app. That is why "is the cwd non-empty" survived as the
// whole check on a string the OS accepts from anyone.
import {
  CONTROL_EXPAND_MODES,
  CONTROL_VERBS,
  channelFromEnv,
  deepLinkScheme,
  type ControlCommand
} from '@contracts'
import { normalizeUntrustedCwd } from '@backend/features/agent-state'

/** This process's scheme: `mogging` (release) or `mogging-dev` (repo checkout). */
export const scheme = (): string => deepLinkScheme(channelFromEnv())

export function cwdFromUrl(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== scheme() + ':') return null
    // The SAME normalizer nine other call sites already use, plus the UNC refusal: this
    // string arrived from outside the machine, so "it is non-empty" was never a check.
    return normalizeUntrustedCwd(u.searchParams.get('cwd'))
  } catch {
    return null
  }
}

/**
 * Validate an untrusted control payload into a CLEAN ControlCommand (or null).
 * Closed verb/mode unions, bounded numbers, bounded path length — nothing else
 * survives; unknown fields are dropped by construction.
 */
export function sanitizeControl(raw: unknown): ControlCommand | null {
  const p = raw as Record<string, unknown> | null
  if (!p || typeof p !== 'object') return null
  const verb = p.verb
  if (typeof verb !== 'string' || !(CONTROL_VERBS as readonly string[]).includes(verb)) return null
  const cmd: ControlCommand = { verb: verb as ControlCommand['verb'] }

  if (p.cwd !== undefined) {
    // A length bound is not validation. This payload reaches workspace-opening verbs, so
    // it gets the real normalizer: absolute, control-char-free, existing, and never a UNC
    // share (whose existence probe would itself be the network request an attacker wanted).
    const cwd = normalizeUntrustedCwd(p.cwd)
    if (!cwd) return null
    cmd.cwd = cwd
  }
  if (p.panes !== undefined) {
    const n = Number(p.panes)
    if (!Number.isInteger(n) || n < 1 || n > 16) return null
    cmd.panes = n
  }
  if (p.paneId !== undefined) {
    const n = Number(p.paneId)
    if (!Number.isInteger(n) || n < 1 || n > 99999) return null
    cmd.paneId = n
  }
  if (p.mode !== undefined) {
    if (
      typeof p.mode !== 'string' ||
      !(CONTROL_EXPAND_MODES as readonly string[]).includes(p.mode)
    ) {
      return null
    }
    cmd.mode = p.mode as ControlCommand['mode']
  }

  // Per-verb required fields — a verb without its target is dropped, not guessed.
  if (cmd.verb === 'open' && !cmd.cwd) return null
  if (cmd.verb === 'layout' && cmd.panes === undefined) return null
  if ((cmd.verb === 'focus' || cmd.verb === 'expand' || cmd.verb === 'close-pane') && cmd.paneId === undefined) {
    return null
  }
  return cmd
}

/** Parse + validate a <scheme>://control URL. Null for anything else/invalid. */
export function controlFromUrl(url: string): ControlCommand | null {
  try {
    const u = new URL(url)
    if (u.protocol !== scheme() + ':' || u.hostname !== 'control') return null
    const raw = u.searchParams.get('c')
    if (!raw) return null
    return sanitizeControl(JSON.parse(raw))
  } catch {
    return null
  }
}
