import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeTempDir, removeTempDir } from './temp-dir'
import { carryClaudeProjectState } from '@backend/features/agents/claude-project-state'

// Project state follows profiles (the ADR-0013 extension): the carry must move a
// project's GRANTS between config homes, force trust for the launch cwd, match
// claude's own key forms (forward slashes; 8.3 short paths when launched that way),
// and never touch account-level state. A wrong merge here silently hands one
// account's approvals to nobody — or clobbers a home's own decisions.

const scratch = makeTempDir('claude-state-')
afterAll(() => removeTempDir(scratch))

let n = 0
const stateFile = (content?: unknown): string => {
  const file = join(scratch, `state-${n++}.json`)
  if (content !== undefined) writeFileSync(file, JSON.stringify(content))
  return file
}

type AnyState = { projects: Record<string, Record<string, unknown>> } & Record<string, unknown>
const read = (file: string): AnyState => JSON.parse(readFileSync(file, 'utf8')) as AnyState

describe('carryClaudeProjectState', () => {
  const cwd = 'C:\\work\\repo'

  it('creates a trusted entry (claude key form) when nothing exists anywhere', () => {
    const target = stateFile()
    const out = carryClaudeProjectState(cwd, target, [])
    expect(out).toEqual({ trusted: true, carried: false })
    expect(read(target).projects['C:/work/repo'].hasTrustDialogAccepted).toBe(true)
  })

  it('carries the closed grant set from a source home and forces trust', () => {
    const source = stateFile({
      projects: {
        'C:/work/repo': {
          allowedTools: ['Bash(npm test)'],
          mcpServers: { linear: { approved: true } },
          enabledMcpjsonServers: ['github'],
          hasClaudeMdExternalIncludesApproved: true,
          hasTrustDialogAccepted: false,
          lastCost: 1.23,
          lastSessionId: 'not-carried'
        }
      },
      oauthAccount: { email: 'a@b.co' }
    })
    const target = stateFile()
    const out = carryClaudeProjectState(cwd, target, [source])
    expect(out).toEqual({ trusted: true, carried: true })
    const entry = read(target).projects['C:/work/repo']
    expect(entry.allowedTools).toEqual(['Bash(npm test)'])
    expect(entry.mcpServers).toEqual({ linear: { approved: true } })
    expect(entry.enabledMcpjsonServers).toEqual(['github'])
    expect(entry.hasClaudeMdExternalIncludesApproved).toBe(true)
    expect(entry.hasTrustDialogAccepted).toBe(true) // forced, source said false
    expect(entry.lastCost).toBeUndefined() // stats never ride
    expect(entry.lastSessionId).toBeUndefined()
    expect(read(target).oauthAccount).toBeUndefined() // account-level state never rides
  })

  it('matches existing entries canonically (slashes + case), not by string equality', () => {
    const target = stateFile({ projects: { 'c:/WORK/repo': { allowedTools: ['A'] } } })
    carryClaudeProjectState(cwd, target, [])
    const projects = read(target).projects
    expect(Object.keys(projects)).toEqual(['c:/WORK/repo']) // no duplicate entry minted
    expect(projects['c:/WORK/repo'].hasTrustDialogAccepted).toBe(true)
  })

  it('unions arrays and keeps the target-home decisions on collision', () => {
    const source = stateFile({
      projects: {
        'C:/work/repo': {
          allowedTools: ['A', 'B'],
          mcpServers: { linear: { approved: false }, github: { approved: true } },
          hasClaudeMdExternalIncludesApproved: false
        }
      }
    })
    const target = stateFile({
      projects: {
        'C:/work/repo': {
          allowedTools: ['B', 'C'],
          mcpServers: { linear: { approved: true } },
          hasClaudeMdExternalIncludesApproved: true
        }
      }
    })
    carryClaudeProjectState(cwd, target, [source])
    const entry = read(target).projects['C:/work/repo']
    expect(entry.allowedTools).toEqual(['B', 'C', 'A'])
    expect(entry.mcpServers).toEqual({ linear: { approved: true }, github: { approved: true } })
    expect(entry.hasClaudeMdExternalIncludesApproved).toBe(true) // target's own decision wins
  })

  it('skips the target itself in the source list and survives junk files', () => {
    const junk = stateFile()
    writeFileSync(junk, 'not json')
    const target = stateFile()
    const out = carryClaudeProjectState(cwd, target, [target, junk])
    expect(out).toEqual({ trusted: true, carried: false })
    expect(read(target).projects['C:/work/repo'].hasTrustDialogAccepted).toBe(true)
  })

  // The steady state is every launch after the first: same workspace, same grants,
  // trust already declared. Rewriting the user's whole ~/.claude.json there was pure
  // cost on the launch path — and, unatomically, a truncation risk on their CLI state.
  it('writes nothing when the carry would change nothing', () => {
    const source = stateFile({ projects: { 'C:/work/repo': { allowedTools: ['A'] } } })
    const target = stateFile()
    carryClaudeProjectState(cwd, target, [source]) // first call establishes the entry
    const before = readFileSync(target, 'utf8')
    const beforeMtime = statSync(target).mtimeMs
    const out = carryClaudeProjectState(cwd, target, [source])
    expect(out.trusted, 'a skipped write still reports the folder trusted').toBe(true)
    expect(readFileSync(target, 'utf8')).toBe(before)
    expect(statSync(target).mtimeMs, 'the file was not rewritten').toBe(beforeMtime)
  })

  it('still writes when a source contributes something new', () => {
    const source = stateFile({ projects: { 'C:/work/repo': { allowedTools: ['A'] } } })
    const target = stateFile()
    carryClaudeProjectState(cwd, target, [source])
    const richer = stateFile({ projects: { 'C:/work/repo': { allowedTools: ['A', 'B'] } } })
    carryClaudeProjectState(cwd, target, [source, richer])
    expect(read(target).projects['C:/work/repo'].allowedTools).toEqual(['A', 'B'])
  })

  it('still writes when trust was previously false', () => {
    const target = stateFile({ projects: { 'C:/work/repo': { hasTrustDialogAccepted: false } } })
    carryClaudeProjectState(cwd, target, [])
    expect(read(target).projects['C:/work/repo'].hasTrustDialogAccepted).toBe(true)
  })

  it('leaves no partial file behind — the write is atomic', () => {
    // write-file-atomic writes a temp sibling then renames, so a reader never sees a
    // half-written state file. Assert the temp file did not survive the call.
    const target = stateFile()
    carryClaudeProjectState(cwd, target, [])
    const strays = readdirSync(scratch).filter((n) => n.startsWith(basename(target)) && n !== basename(target))
    expect(strays).toEqual([])
    expect(() => read(target)).not.toThrow()
  })

  it('reports untrusted (and writes nothing) when the target is unwritable', () => {
    const dir = join(scratch, 'as-dir')
    mkdirSync(dir, { recursive: true })
    const out = carryClaudeProjectState(cwd, dir, [])
    expect(out.trusted).toBe(false)
    expect(existsSync(join(dir, 'projects'))).toBe(false)
  })
})
