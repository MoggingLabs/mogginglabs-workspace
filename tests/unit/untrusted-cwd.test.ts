import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { normalizePaneCwd, normalizeUntrustedCwd } from '@backend/features/agent-state'

// THE DEEP-LINK CWD, pinned.
//
// `mogging://` is a URL. The OS hands it to us on behalf of whoever got a link clicked, so
// its `cwd` is the least trusted string the app accepts. It was checked like the most
// trusted: cwdFromUrl did `return cwd ? cwd : null` — non-empty — and sanitizeControl
// added only `length > 1024`. Meanwhile NINE other call sites in this codebase already ran
// normalizePaneCwd on paths that came from the machine's own shell.
//
// So a relative path, a NUL byte, a 40k-character string and `\\attacker\share` all reached
// a workspace-opening verb. The UNC case is the sharp one: normalizePaneCwd's existence
// probe would itself make the network request, before any caller had decided the path was
// acceptable — and on Windows that connection can carry credentials.

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
const realDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'cwd-'))
  dirs.push(d)
  return d
}

describe('normalizeUntrustedCwd', () => {
  it('accepts a real absolute directory', () => {
    const d = realDir()
    expect(normalizeUntrustedCwd(d)).toBe(d)
  })

  it('refuses a UNC path WITHOUT probing it', () => {
    // The refusal has to come before the statSync, or the probe is the attack.
    expect(normalizeUntrustedCwd('\\\\attacker\\share')).toBeNull()
    expect(normalizeUntrustedCwd('\\\\attacker\\share\\sub')).toBeNull()
    expect(normalizeUntrustedCwd('//attacker/share')).toBeNull()
  })

  it('refuses the shapes the old non-empty check let through', () => {
    for (const bad of [
      'relative/path',
      '.',
      '..',
      '',
      null,
      undefined,
      42,
      '/tmp/\x00evil',
      '/tmp/a\x1bb',
      '/x'.repeat(40_000)
    ]) {
      expect(normalizeUntrustedCwd(bad as unknown), String(bad).slice(0, 24)).toBeNull()
    }
  })

  it('refuses an absolute path that does not exist', () => {
    expect(normalizeUntrustedCwd(join(tmpdir(), 'mogging-no-such-dir-' + Date.now()))).toBeNull()
  })

  it('refuses a path that exists but is a FILE', () => {
    expect(normalizeUntrustedCwd(process.execPath)).toBeNull()
  })
})

describe('normalizePaneCwd rejectUnc', () => {
  // UNC stays legal for the machine's own reports — a user really can run a shell on a
  // network share, and those nine call sites must keep working. Only untrusted input opts in.
  it('is opt-in: a UNC path is still accepted without the flag', () => {
    // `\\host\share\` IS the root for a UNC path, so the trailing separator is kept —
    // the canonical trim only applies past the root.
    expect(normalizePaneCwd('\\\\host\\share', { mustExist: false, platform: 'win32' })).toBe('\\\\host\\share\\')
  })

  it('refuses UNC when asked, on either path flavour', () => {
    expect(normalizePaneCwd('\\\\host\\share', { mustExist: false, platform: 'win32', rejectUnc: true })).toBeNull()
    expect(normalizePaneCwd('//host/share', { mustExist: false, platform: 'linux', rejectUnc: true })).toBeNull()
  })

  it('leaves ordinary absolute paths untouched by the flag', () => {
    expect(normalizePaneCwd('/home/me/p', { mustExist: false, platform: 'linux', rejectUnc: true })).toBe('/home/me/p')
    expect(normalizePaneCwd('C:\\p', { mustExist: false, platform: 'win32', rejectUnc: true })).toBe('C:\\p')
  })
})
