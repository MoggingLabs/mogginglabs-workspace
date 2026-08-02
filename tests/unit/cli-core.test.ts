import { describe, expect, it } from 'vitest'
import { VERBS, looksLikePath, parseInvocation, splitTrailingFlags, takeLeadingOption, usageStream } from '../../bin/lib/cli-core.mjs'

/** Parse and assert it was a verb, so `args` is reachable. The narrowing is the point: a
 *  payload only exists on the arms that carry one. */
const verb = (argv: string[]): { dev: boolean; verb: string; args: string[] } => {
  const p = parseInvocation(argv)
  if (p.kind !== 'verb') throw new Error(`expected a verb for [${argv.join(' ')}], got ${p.kind}`)
  return p
}

// THE `mogging` GRAMMAR, pinned — bin/ had no unit coverage at all.
//
// Three defects came from having no parser: an if/else chain over argv[0], with a
// whole-argv filter above it.

describe('--dev is a leading flag, not a global filter', () => {
  it('is consumed from the flag region', () => {
    expect(parseInvocation(['--dev', 'list'])).toMatchObject({ dev: true, kind: 'verb', verb: 'list' })
  })

  // THE regression. `argv.filter(a => a !== '--dev')` removed it from ANYWHERE, so this
  // literal could never be typed into a pane by `mogging send`.
  it('stays in the PAYLOAD when it appears after a verb', () => {
    const p = verb(['send', '1', '--dev'])
    expect(p).toMatchObject({ dev: false, kind: 'verb', verb: 'send' })
    expect(p.args).toEqual(['1', '--dev'])
  })

  it('stays in the payload past a bare --', () => {
    const p = verb(['send', '1', '--', '--dev'])
    expect(p.dev).toBe(false)
    expect(p.args).toEqual(['1', '--', '--dev'])
  })

  it('does not reach past a non-flag token', () => {
    const p = verb(['list', '--dev'])
    expect(p.dev).toBe(false)
    expect(p.args).toEqual(['--dev'])
  })
})

describe('an unknown verb is an error, not a directory', () => {
  // THE regression. The chain ended `else runOpen(argv)`, so a typo cold-started the GUI
  // on a folder that does not exist and exited 0 — a script could not tell a mistyped
  // command from a successful one.
  it('reports a bare mistyped word as unknown', () => {
    expect(parseInvocation(['clam'])).toMatchObject({ kind: 'unknown', verb: 'clam' })
    expect(parseInvocation(['sedn', '1', 'hi'])).toMatchObject({ kind: 'unknown', verb: 'sedn' })
  })

  it('still opens something that looks like a path', () => {
    for (const p of ['.', '..', './app', '~/code/app', '/srv/app', 'C:\\code\\app', 'C:/code/app', 'a/b']) {
      expect(parseInvocation([p]), p).toMatchObject({ kind: 'open' })
    }
  })

  it('routes every known verb', () => {
    for (const v of VERBS) expect(parseInvocation([v]), v).toMatchObject({ kind: 'verb', verb: v })
  })

  it('treats a bare invocation as neither', () => {
    expect(parseInvocation([])).toMatchObject({ kind: 'none' })
  })

  it('recognises the help forms', () => {
    for (const h of ['--help', '-h', 'help']) expect(parseInvocation([h]), h).toMatchObject({ kind: 'help' })
  })
})

describe('looksLikePath', () => {
  it('is shape-only — it never touches the filesystem', () => {
    // A nonexistent path still LOOKS like one; `mogging ./nope` should report a missing
    // directory, while `mogging clam` reports an unknown command.
    expect(looksLikePath('./definitely-not-here')).toBe(true)
    expect(looksLikePath('clam')).toBe(false)
    expect(looksLikePath('')).toBe(false)
  })
})

describe('a flag inside free text is text', () => {
  // Same defect as --dev, same file: `args.filter(a => a !== '--no-enter')`.
  it('takes --no-enter only from the trailing region', () => {
    expect(splitTrailingFlags(['1', 'hello', '--no-enter'], ['--no-enter'])).toEqual({
      found: new Set(['--no-enter']),
      rest: ['1', 'hello']
    })
  })

  it('leaves an interior --no-enter in the payload', () => {
    const r = splitTrailingFlags(['1', 'run', '--no-enter', 'now'], ['--no-enter'])
    expect(r.found.size).toBe(0)
    expect(r.rest).toEqual(['1', 'run', '--no-enter', 'now'])
  })

  it('treats everything past a bare -- as literal, and drops the --', () => {
    const r = splitTrailingFlags(['1', '--', '--no-enter'], ['--no-enter'])
    expect(r.found.size).toBe(0)
    expect(r.rest).toEqual(['1', '--no-enter'])
  })

  it('consumes a run of trailing flags', () => {
    const r = splitTrailingFlags(['1', 'hi', '--a', '--b'], ['--a', '--b'])
    expect([...r.found].sort()).toEqual(['--a', '--b'])
    expect(r.rest).toEqual(['1', 'hi'])
  })

  // `mail send` located --to with indexOf over the whole argv, so a body containing "--to"
  // lost that word AND the one after it, and addressed the mail wherever it pointed.
  it('reads --to only at the front', () => {
    expect(takeLeadingOption(['--to', '3', 'ship', 'it'], '--to')).toEqual({ value: '3', rest: ['ship', 'it'] })
  })

  it('leaves an interior --to in the body', () => {
    expect(takeLeadingOption(['tell', 'him', '--to', '3'], '--to')).toEqual({
      value: undefined,
      rest: ['tell', 'him', '--to', '3']
    })
  })
})

describe('usage goes to the right stream', () => {
  // Help that was ASKED for is stdout; only an error is stderr. `--help` wrote to stderr,
  // so `mogging --help | less` showed nothing.
  it('stdout on success, stderr on error', () => {
    expect(usageStream(0)).toBe('stdout')
    expect(usageStream(2)).toBe('stderr')
  })
})
