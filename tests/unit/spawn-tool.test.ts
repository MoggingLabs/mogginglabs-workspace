import { mkdtempSync, writeFileSync } from 'node:fs'
import { removeTempDir } from './temp-dir'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { isWindowsBatch, quoteForCmd, spawnPlan, spawnTool } from '@backend/platform/spawn-tool'

/**
 * THE EINVAL BUG, pinned.
 *
 * Node refuses to `spawn` a `.cmd`/`.bat` directly since the CVE-2024-27980 fix — it throws
 * `EINVAL` before the process exists. On Windows `npm` IS `npm.cmd`, and so is every CLI it
 * installs, so one-click setup died on `spawn EINVAL` running
 * `C:\Program Files\nodejs\npm.CMD config set prefix …` — on the very first machine it met.
 *
 * The last test here spawns a REAL batch file. It is the only kind of test that could have
 * caught this: the wrapping is correct-looking either way, and only the OS knows.
 */

const made: string[] = []
afterAll(() => {
  for (const dir of made) {
    try {
      removeTempDir(dir)
    } catch {
      /* temp sweep gets it */
    }
  }
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mogging-spawn-'))
  made.push(dir)
  return dir
}

describe('quoteForCmd', () => {
  it('leaves a plain token alone', () => {
    expect(quoteForCmd('config')).toBe('config')
    expect(quoteForCmd('@anthropic-ai/claude-code')).toBe('@anthropic-ai/claude-code')
  })

  it('quotes whitespace and every cmd.exe metacharacter', () => {
    expect(quoteForCmd('C:\\Program Files\\nodejs\\npm.CMD')).toBe('"C:\\Program Files\\nodejs\\npm.CMD"')
    for (const meta of ['&', '|', '<', '>', '^', '(', ')', '!', '%', ';', ',', '=']) {
      expect(quoteForCmd(`a${meta}b`), meta).toBe(`"a${meta}b"`)
    }
  })

  it('REFUSES a value carrying a double quote rather than mangling it', () => {
    // Under windowsVerbatimArguments there is no escape that both cmd.exe's /s rule and
    // CreateProcess's argv parser agree on. Refusing is the only honest answer.
    expect(() => quoteForCmd('a"b')).toThrow(/double quote/)
  })
})

describe('spawnPlan', () => {
  it('passes a normal executable straight through', () => {
    const plan = spawnPlan('C:\\Windows\\System32\\where.exe', ['git'])
    expect(plan).toEqual({ file: 'C:\\Windows\\System32\\where.exe', args: ['git'], verbatim: false })
  })

  if (process.platform === 'win32') {
    it('routes a .cmd through cmd.exe with /d /s /c and verbatim args (win32)', () => {
      const plan = spawnPlan('C:\\Program Files\\nodejs\\npm.CMD', ['config', 'set', 'prefix', 'C:\\Users\\me\\.npm-global'])
      expect(plan.verbatim).toBe(true)
      expect(plan.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
      // The whole line is wrapped once. Inside it, only the tokens that NEED quoting get
      // it — `C:\Users\me\.npm-global` carries no space and no metacharacter, so quoting
      // it would add nothing but a chance to get the escaping wrong.
      expect(plan.args[3]).toBe('""C:\\Program Files\\nodejs\\npm.CMD" config set prefix C:\\Users\\me\\.npm-global"')
    })

    it('quotes an argument that DOES carry a space', () => {
      const plan = spawnPlan('x.cmd', ['--prefix', 'C:\\Users\\Ana Paula\\.npm-global'])
      expect(plan.args[3]).toBe('"x.cmd --prefix "C:\\Users\\Ana Paula\\.npm-global""')
    })

    it('treats .bat the same as .cmd, case-insensitively', () => {
      expect(isWindowsBatch('x.BAT')).toBe(true)
      expect(isWindowsBatch('x.Cmd')).toBe(true)
      expect(isWindowsBatch('x.exe')).toBe(false)
    })
  } else {
    it('never wraps on posix — there are no batch shims to rescue', () => {
      expect(isWindowsBatch('x.cmd')).toBe(false)
      expect(spawnPlan('x.cmd', []).verbatim).toBe(false)
    })
  }
})

describe.runIf(process.platform === 'win32')('spawnTool against a real batch file', () => {
  const run = (file: string, args: string[]): Promise<{ code: number | null; out: string; error?: string }> =>
    new Promise((resolve) => {
      let out = ''
      const child = spawnTool(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')))
      child.on('error', (err) => resolve({ code: null, out, error: err.message }))
      child.on('close', (code) => resolve({ code, out }))
    })

  it('runs a .cmd that plain spawn would reject with EINVAL', async () => {
    const dir = tempDir()
    const bat = join(dir, 'hello.cmd')
    writeFileSync(bat, '@echo off\r\necho HELLO %1\r\n')
    const result = await run(bat, ['world'])
    expect(result.error).toBeUndefined()
    expect(result.code).toBe(0)
    expect(result.out).toContain('HELLO world')
  })

  it('survives a directory with a space in it — the npm case verbatim', async () => {
    const dir = join(tempDir(), 'Program Files Like')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    const bat = join(dir, 'echo-arg.cmd')
    writeFileSync(bat, '@echo off\r\necho GOT %1\r\n')
    const result = await run(bat, ['C:\\Users\\me\\.npm-global'])
    expect(result.code).toBe(0)
    expect(result.out).toContain('GOT')
    expect(result.out).toContain('.npm-global')
  })

  it('does not let a metacharacter argument run a second command', async () => {
    // The CVE this wrapping has to respect: an argument must stay an argument.
    const dir = tempDir()
    const bat = join(dir, 'safe.cmd')
    writeFileSync(bat, '@echo off\r\necho ARG=%1\r\n')
    const result = await run(bat, ['a&echo INJECTED'])
    expect(result.code).toBe(0)
    expect(result.out).not.toContain('INJECTED\r\n')
    expect(result.out).toContain('ARG=')
  })
})
