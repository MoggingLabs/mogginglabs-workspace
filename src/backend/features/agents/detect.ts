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
      const candidate = path.join(dir, bin + ext)
      try {
        // isFile: a DIRECTORY named like the bin (a `codex/` folder on PATH) is not an
        // install — existsSync said yes and blocked the real installer. On POSIX the
        // file must also be executable, or the shell can't run it either.
        if (!fs.statSync(candidate).isFile()) continue
        if (process.platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK)
        return true
      } catch {
        /* missing, unreadable, or not executable */
      }
    }
  }
  return false
}

/** Which agent CLIs are installed (on PATH). */
export function detectAgents(): AgentInfo[] {
  return AGENT_ADAPTERS.map((a) => ({ id: a.id, name: a.name, installed: isOnPath(a.bin), installHint: a.installHint }))
}
