// Types for bin/lib/cli-core.mjs.
//
// bin/ is plain Node ESM with no build step — the satellites are copied verbatim into the
// user's runtime directory (src/main/cli-runtime.ts), so they cannot be TypeScript. This
// declaration exists so tests/unit/cli-core.test.ts can typecheck against the parser.
//
// It is a SECOND statement of the shape, so it can drift. What holds it: the unit test calls
// every export at runtime against the real .mjs, and scripts/check-cli-grammar.mjs drives the
// real binary — neither would survive a shape that does not exist.

/** Every verb `mogging` dispatches. Anything else is an exit-2 usage error. */
export declare const VERBS: readonly string[]

export type Invocation =
  | { dev: boolean; kind: 'none' }
  | { dev: boolean; kind: 'help' }
  | { dev: boolean; kind: 'verb'; verb: string; args: string[] }
  | { dev: boolean; kind: 'open'; args: string[] }
  | { dev: boolean; kind: 'unknown'; verb: string }

/**
 * Split a raw argv (already sliced past node + script) into what the CLI should do.
 * `--dev` is consumed ONLY from the leading flag region and never past a bare `--`;
 * everywhere else it is payload.
 */
export declare function parseInvocation(rawArgv: readonly string[]): Invocation

/** Shape-only: does this token look like a directory the user meant to open? Never touches
 *  the filesystem, so a typo'd verb reports as unknown rather than as a missing directory. */
export declare function looksLikePath(token: string): boolean

/** Where the usage banner belongs: help that was asked for is stdout, an error is stderr. */
export declare function usageStream(code: number): 'stdout' | 'stderr'

/** Pull recognised flags off the END of a free-text payload. A bare `--` ends the scan and is
 *  removed, so everything after it is literal text. */
export declare function splitTrailingFlags(
  args: readonly string[],
  flagNames: readonly string[]
): { found: Set<string>; rest: string[] }

/** Read `--name <value>` from the LEADING flag region only, so the same token inside a message
 *  body stays body. */
export declare function takeLeadingOption(
  args: readonly string[],
  name: string
): { value: string | undefined; rest: string[] }
