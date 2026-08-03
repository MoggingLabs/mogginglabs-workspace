import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeTempDir, removeTempDir } from './temp-dir'
import { carryClaudeProjectState, claudeKeysFor } from '@backend/features/agents/claude-project-state'

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

/** Claude's own key form: forward slashes, everything else verbatim. */
const fwd = (p: string): string => p.replace(/\\/g, '/')

/** A TEMP that cannot be resolved, so `claudeKeysFor` contributes no alias leg — the way
 *  to test the realpath leg alone on a machine whose real TEMP happens to be aliased. */
const noTmp = (): string => join(scratch, 'no-such-temp')

/**
 * One directory with TWO real spellings — the situation this whole module exists for,
 * built deterministically instead of hoping the host's TEMP is an 8.3 alias.
 *
 * `symlinkSync(..., 'junction')` is the portable way to get it: Windows creates junctions
 * without the privilege a file symlink demands, and on POSIX the type argument is ignored
 * and this is a plain directory symlink. Either way `alias` and `physical` name the same
 * folder through different strings, exactly as `C:/Users/PVELOS~1/...` and
 * `C:/Users/pveloso01/...` do on the machine where this bug was found.
 */
function aliasedDir(name: string): { alias: string; physical: string } {
  const real = join(scratch, `${name}-real`)
  const alias = join(scratch, `${name}-link`)
  mkdirSync(real, { recursive: true })
  symlinkSync(real, alias, 'junction')
  return { alias, physical: realpathSync.native(alias) }
}

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

// The path-form gap that made the buffer-scraping trust fallback necessary at all.
//
// Claude READS its project entry with an exact string lookup on the cwd its own process
// reports, and node hands a child the cwd verbatim — spawn it at
// `C:\Users\PVELOS~1\AppData\Local\Temp\x` and `process.cwd()` is exactly that; spawn it
// at the long spelling of the same folder and it is the long one. Node never
// canonicalizes. So a carry that wrote ONE spelling was guessing which side of that split
// claude would land on, and a wrong guess made the carry a silent no-op: claude found no
// entry, minted its own, and painted the trust dialog anyway.
//
// This is not hypothetical. In the real `~/.claude.json` on the machine this was found on,
// 42 of 53 project entries are keyed `C:/Users/PVELOS~1/AppData/Local/Temp/...` and 11
// under the long `C:/Users/pveloso01/...` spelling — for directories under the SAME parent.
// The split tracks which code path computed the cwd: `realpathSync.native` gives the long
// form, `os.tmpdir()` on that machine gives the 8.3 short one.
describe('claudeKeysFor — every spelling claude might report', () => {
  it('yields the physical spelling beside the one it was handed', () => {
    const { alias, physical } = aliasedDir('keys-alias')
    expect(alias).not.toBe(physical) // the fixture must really be two spellings
    expect(claudeKeysFor(alias, noTmp())).toEqual([fwd(alias), fwd(physical)])
  })

  it('yields the aliased spelling for a physical cwd under an aliased TEMP', () => {
    // The other direction, and the one that actually bites: the cwd arrives already
    // resolved (long) while claude is launched through `%TEMP%`, which is spelled 8.3.
    const { alias, physical } = aliasedDir('keys-tmp')
    const sub = join(physical, 'ws')
    mkdirSync(sub, { recursive: true })
    expect(claudeKeysFor(sub, alias)).toEqual([fwd(sub), fwd(join(alias, 'ws'))])
  })

  it('collapses to a single key when the path has only one spelling', () => {
    const dir = join(scratch, 'keys-plain')
    mkdirSync(dir, { recursive: true })
    const plain = realpathSync.native(dir) // already the physical spelling
    expect(claudeKeysFor(plain, noTmp())).toEqual([fwd(plain)])
  })

  it('keys with forward slashes whatever separators the cwd arrived with', () => {
    expect(claudeKeysFor('C:\\work\\repo', noTmp())).toEqual(['C:/work/repo'])
  })
})

describe('carryClaudeProjectState — alias spellings', () => {
  it('seeds every spelling, so no launch form can miss the trusted entry', () => {
    const { alias, physical } = aliasedDir('carry-alias')
    const target = stateFile()
    expect(carryClaudeProjectState(alias, target, []).trusted).toBe(true)
    const projects = read(target).projects
    // The spelling we were handed AND the one a resolved launch would report.
    for (const key of [fwd(alias), fwd(physical)]) {
      expect(projects[key], `a claude whose cwd is ${key} must find an entry`).toBeDefined()
      expect(projects[key].hasTrustDialogAccepted, `${key} must be trusted`).toBe(true)
    }
  })

  it('adds the missing spelling beside the entry claude already wrote, grants and all', () => {
    const { alias, physical } = aliasedDir('carry-existing')
    const target = stateFile({ projects: { [fwd(physical)]: { allowedTools: ['A'] } } })
    carryClaudeProjectState(alias, target, [])
    const projects = read(target).projects
    expect(projects[fwd(alias)], 'the alias spelling needs its own key').toBeDefined()
    expect(projects[fwd(alias)].allowedTools).toEqual(['A'])
    expect(projects[fwd(alias)].hasTrustDialogAccepted).toBe(true)
    expect(projects[fwd(physical)].hasTrustDialogAccepted).toBe(true)
  })

  it('never lets two spellings of one folder disagree about trust', () => {
    // The alias entry is one claude minted itself, at a moment the user declined.
    // Leaving it false is a dialog waiting for the next launch through that spelling.
    const { alias, physical } = aliasedDir('carry-disagree')
    const target = stateFile({
      projects: {
        [fwd(physical)]: { hasTrustDialogAccepted: true },
        [fwd(alias)]: { hasTrustDialogAccepted: false }
      }
    })
    carryClaudeProjectState(alias, target, [])
    const projects = read(target).projects
    expect(projects[fwd(physical)].hasTrustDialogAccepted).toBe(true)
    expect(projects[fwd(alias)].hasTrustDialogAccepted).toBe(true)
  })

  it('carries grants a source home recorded under the OTHER spelling', () => {
    const { alias, physical } = aliasedDir('carry-cross')
    const source = stateFile({ projects: { [fwd(physical)]: { allowedTools: ['Bash(npm test)'] } } })
    const target = stateFile()
    expect(carryClaudeProjectState(alias, target, [source])).toEqual({ trusted: true, carried: true })
    const projects = read(target).projects
    expect(projects[fwd(alias)].allowedTools).toEqual(['Bash(npm test)'])
    expect(projects[fwd(physical)].allowedTools).toEqual(['Bash(npm test)'])
  })

  it('writes nothing on the second carry — seeding is not a per-launch rewrite', () => {
    const { alias } = aliasedDir('carry-steady')
    const target = stateFile()
    carryClaudeProjectState(alias, target, [])
    const before = readFileSync(target, 'utf8')
    const beforeMtime = statSync(target).mtimeMs
    expect(carryClaudeProjectState(alias, target, []).trusted).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe(before)
    expect(statSync(target).mtimeMs, 'the file was not rewritten').toBe(beforeMtime)
  })
})
