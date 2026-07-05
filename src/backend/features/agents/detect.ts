import * as fs from 'node:fs'
import * as path from 'node:path'
import type { AgentInfo } from '@contracts'
import { AGENT_ADAPTERS } from './adapters'

/**
 * Is `bin` resolvable on PATH? Scans PATH dirs (+ PATHEXT on Windows, where npm-installed
 * CLIs are usually `.cmd`). Pure + Electron-free — no subprocess. NOTE: sees the process PATH,
 * so a CLI added only by a login-shell rc (macOS `.zshrc`) may not be detected here even though
 * the login shell the PTY spawns can still run it.
 */
export function isOnPath(bin: string): boolean {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  const exts =
    process.platform === 'win32' ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')] : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        if (fs.existsSync(path.join(dir, bin + ext))) return true
      } catch {
        /* unreadable dir */
      }
    }
  }
  return false
}

/** Which agent CLIs are installed (on PATH). */
export function detectAgents(): AgentInfo[] {
  return AGENT_ADAPTERS.map((a) => ({ id: a.id, name: a.name, installed: isOnPath(a.bin), installHint: a.installHint }))
}
