// The `mogging` invocation parser. PURE — no fs, no env, no process; everything is passed in.
//
// Three defects came from having no parser at all, only an if/else chain over argv[0] and a
// whole-argv filter above it:
//
//   1. `argv.filter(a => a !== '--dev')` removed the flag from ANYWHERE in the command line.
//      `mogging send 1 --dev` could therefore never type the literal `--dev` into a pane, and
//      `mogging send 1 -- --dev` could not either. A global flag ate a payload token.
//
//   2. The chain ended `else runOpen(argv)` — so ANY unknown verb was a directory to open.
//      A typo (`mogging clam`, `mogging sedn 1 hi`) silently COLD-STARTED the GUI on a
//      folder that does not exist and exited 0. A script could not tell a mistyped command
//      from a successful one.
//
//   3. `--help` wrote the banner to stderr and `mogging` with no args did the same. Help
//        that was ASKED for belongs on stdout; only an error belongs on stderr.
//
// Kept free of side effects so the whole grammar can be asserted under node — bin/ had no
// unit coverage at all.

/** Every verb the CLI dispatches. A verb missing here is an exit-2 usage error, so this
 *  list and the dispatch must move together — they live in the same module for that reason. */
export const VERBS = Object.freeze([
  'usage',
  'map',
  'recall',
  'notify',
  'cwd',
  'list',
  'send',
  'send-key',
  'capture',
  'mail',
  'role',
  'claim',
  'release',
  'owners',
  'approve',
  'approvals',
  'open',
  'layout',
  'focus',
  'expand',
  'close-pane'
])

const HELP = Object.freeze(['--help', '-h', 'help'])

/**
 * Split a raw argv (already sliced past node + script) into what the CLI should do.
 *
 * `--dev` is consumed ONLY from the leading flag region — the run of `--`-prefixed tokens
 * before the first payload token — and never past a bare `--`. Everywhere else it is data,
 * because everywhere else it belongs to whoever the payload belongs to.
 *
 * Returns:
 *   { dev, kind: 'help'   }                  — asked for the banner
 *   { dev, kind: 'verb', verb, args }        — a known verb
 *   { dev, kind: 'open', args }              — `mogging <dir>` / `mogging .`
 *   { dev, kind: 'none' }                    — bare `mogging`
 *   { dev, kind: 'unknown', verb }           — a token that is neither
 */
export function parseInvocation(rawArgv) {
  const argv = [...rawArgv]
  let dev = false

  // The leading flag region only.
  while (argv.length && argv[0].startsWith('--') && argv[0] !== '--') {
    if (argv[0] === '--dev') {
      dev = true
      argv.shift()
      continue
    }
    break
  }

  if (!argv.length) return { dev, kind: 'none' }
  const head = argv[0]
  if (HELP.includes(head)) return { dev, kind: 'help' }
  if (VERBS.includes(head)) return { dev, kind: 'verb', verb: head, args: argv.slice(1) }

  // Not a verb. `mogging .` and `mogging ~/code/app` open a directory — but only something
  // that LOOKS like a path may. A bare word is a typo, and answering a typo by launching
  // the app on a nonexistent folder is how `mogging sedn 1 hi` exited 0.
  if (looksLikePath(head)) return { dev, kind: 'open', args: argv }
  return { dev, kind: 'unknown', verb: head }
}

/**
 * Could this token be a directory the user meant to open?
 *
 * Deliberately shape-only — the caller still stats it. This decides "did they mean a path
 * or mistype a verb", and answering it by touching the filesystem would make `mogging clam`
 * report a missing directory rather than an unknown command.
 */
export function looksLikePath(token) {
  if (!token) return false
  if (token === '.' || token === '..') return true
  if (token.startsWith('.' ) || token.startsWith('~')) return true
  if (token.startsWith('/') || token.startsWith('\\')) return true
  if (/^[A-Za-z]:[\\/]/.test(token)) return true // C:\… or C:/…
  return token.includes('/') || token.includes('\\')
}

/** Where the usage banner belongs: help that was ASKED for is stdout, an error is stderr. */
export function usageStream(code) {
  return code === 0 ? 'stdout' : 'stderr'
}

/**
 * Pull recognised flags off the END of a free-text payload.
 *
 * `mogging send <pane> <text…> [--no-enter]` used `args.filter(a => a !== '--no-enter')` —
 * the same defect as `--dev`, in the same file. A flag matched ANYWHERE, so
 * `mogging send 1 run with --no-enter set` typed "run with set" and dropped the Enter, and
 * the literal `--no-enter` could not be typed into a pane at all.
 *
 * A flag is a flag only in the trailing run of flag tokens; the first token that is not one
 * ends the scan. A bare `--` ends it too and is removed, so everything after `--` is literal
 * text no matter what it looks like.
 */
export function splitTrailingFlags(args, flagNames) {
  const rest = [...args]
  const found = new Set()
  const sep = rest.indexOf('--')
  if (sep !== -1) {
    // A bare `--` says "everything after this is literal". Since the free text runs to the end
    // of the command, that leaves no trailing flag region at all — consume nothing, and drop
    // the separator itself so it is not typed.
    rest.splice(sep, 1)
    return { found, rest }
  }
  const names = new Set(flagNames)
  while (rest.length && names.has(rest[rest.length - 1])) found.add(rest.pop())
  return { found, rest }
}

/**
 * Read `--name <value>` from the LEADING flag region only.
 *
 * `mogging mail send --to 3 <text…>` located `--to` with `indexOf` over the whole argv, so a
 * message whose BODY contained "--to" lost that word and the one after it to the option — and
 * addressed the mail wherever that word pointed.
 */
export function takeLeadingOption(args, name) {
  if (args[0] !== name) return { value: undefined, rest: [...args] }
  return { value: args[1], rest: args.slice(2) }
}
