// Session persistence store (ADR 0006 belt-and-suspenders + Phase-1/03). A small, atomic
// JSON file in the per-user runtime dir — no native dependency (better-sqlite3 needs a C++
// toolchain we don't have; the workload is a handful of panes). Swappable for SQLite later.
//
// SECURITY: this stores ONLY layout/cwd/command-label/scrollback — the user's own local
// terminal state. It NEVER stores provider credentials; the app doesn't handle those at all
// (ADR 0002 — agent CLIs self-authenticate). `command` is a launch label like "claude", not
// a token.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { runtimeDir } from './lifecycle'

export interface PersistedPane {
  id: string
  cwd: string
  command?: string // launch label (e.g. "claude") — NEVER a credential
  scrollback: string // raw PTY output for repaint (local terminal content)
  updatedAt: number
}

interface StoreShape {
  version: number
  updatedAt: number
  panes: PersistedPane[]
}

const STORE_VERSION = 1
const MAX_SCROLLBACK = 100_000

const storePath = (): string => path.join(runtimeDir(), 'sessions.json')

export function loadPanes(): PersistedPane[] {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), 'utf8')) as StoreShape
    if (raw && raw.version === STORE_VERSION && Array.isArray(raw.panes)) return raw.panes
  } catch {
    /* no / invalid store */
  }
  return []
}

/** Atomic write (tmp + rename) so a crash mid-write can never corrupt the store. */
export function writeNow(panes: PersistedPane[]): void {
  const data: StoreShape = {
    version: STORE_VERSION,
    updatedAt: Date.now(),
    panes: panes.map((p) => ({ ...p, scrollback: p.scrollback.slice(-MAX_SCROLLBACK) }))
  }
  try {
    const tmp = storePath() + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
    fs.renameSync(tmp, storePath())
  } catch {
    /* best effort */
  }
}
