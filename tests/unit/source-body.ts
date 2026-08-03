import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Read a source file from the repo, for tests that must assert over code they cannot import.
 *
 * `src/main/**` imports electron, `src/ui/features/**` touches the DOM at call time, and
 * `src/pty-daemon/**` pulls a native module at module scope. Where the logic under audit cannot
 * be extracted into a pure module, the honest fallback is to assert its SHAPE — but only with
 * anchors that fail loudly when they stop matching, or the assertion quietly stops meaning
 * anything.
 *
 * Shared because four test files had grown their own copy of `bodyOf`, and two of those copies
 * had the same bug.
 */
export function sourceOf(repoRelative: string): string {
  return readFileSync(resolve(import.meta.dirname, '../..', repoRelative), 'utf8')
}

/**
 * The body of a function or method, brace-matched from its signature.
 *
 * The opening brace is found as `{\n` rather than the first `{`. That matters: a plain
 * `indexOf('{')` latches onto braces in the SIGNATURE — `ctx?: { pane?: string }`, or a union
 * return type like `{ gated: false } | …` — and then brace-matches an entirely wrong span, so
 * the assertion checks a fragment of a type annotation and passes for no reason. That happened
 * twice before this helper existed.
 *
 * Throws when the signature is absent, so a renamed function is a loud failure rather than a
 * silently empty haystack that every `not.toContain` assertion trivially satisfies.
 */
export function bodyOf(src: string, signature: string): string {
  const start = src.indexOf(signature)
  if (start === -1) throw new Error(`bodyOf: signature not found — ${signature}`)
  let i = src.indexOf('{\n', start)
  if (i === -1) throw new Error(`bodyOf: no body brace after — ${signature}`)
  const from = i
  let depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(from, i + 1)
  }
  throw new Error(`bodyOf: unbalanced braces after — ${signature}`)
}

/** `bodyOf` with `//` line comments removed. A test whose own explanation can satisfy it —
 *  or fail it — proves nothing, and the code under audit is usually commented with the very
 *  words being asserted. */
export function bodyWithoutComments(src: string, signature: string): string {
  return bodyOf(src, signature).replace(/^\s*\/\/.*$/gm, '')
}
