import { parseCdLine, resolvePathAgainst } from './cd-path'

/**
 * Tab-completion math for the wizard's cd line — pure string work, shared with
 * nothing DOM. The UI (cd-line.ts) asks three questions:
 *
 *   completionContext(input, base, home)  →  WHICH folder's children complete the
 *       half-typed argument, and how to rebuild the input around a pick;
 *   filterCompletions(names, prefix)      →  which children actually match;
 *   commonPrefix(names)                   →  how far a first Tab can extend
 *       without choosing (the shell's silent-prefix step).
 *
 * Deliberately case-insensitive on every dialect: this is a navigation aid over
 * folder NAMES the filesystem just listed, and `cd doc<Tab>` reaching `Documents`
 * is the whole point — a POSIX host with `doc` AND `Documents` still offers both.
 */

const WINDOWS_LIKE = /^([A-Za-z]:[\\/]|\\\\)/

export interface CompletionContext {
  /** Absolute folder whose child names complete the partial. */
  dir: string
  /** The half-typed leaf being completed ('' matches every child). */
  prefix: string
  /** Everything before the rebuilt argument — verb, flags, one space. */
  head: string
  /** The argument's directory part, verbatim as typed (ends with a separator, or ''). */
  argDir: string
  /** The separator new segments use — follows the one the user already typed. */
  sep: string
  /** Completions stay quoted because the argument already was. */
  quote: boolean
  /** Dotfolders are hidden from listings unless the leaf asks for them. */
  wantHidden: boolean
}

/** Where completion should look, given the current line. Null when the line is
 *  not a cd command or there is nothing to resolve against. */
export function completionContext(input: string, base: string, home: string): CompletionContext | null {
  const parsed = parseCdLine(input)
  if (parsed.kind !== 'cd') return null

  let head = input.slice(0, parsed.argStart)
  if (!/\s$/.test(head)) head += ' ' // `cd` and `cd..` rebuild as `cd <arg>`
  let arg = input.slice(parsed.argStart)

  // cmd's drive-switch flag rides in the head so a pick does not erase it.
  const flag = /^\/d\s+/i.exec(arg)
  if (flag) {
    head += flag[0]
    arg = arg.slice(flag[0].length)
  }

  const quoteChar = arg[0] === '"' || arg[0] === "'" ? arg[0] : ''
  let inner = quoteChar ? arg.slice(1) : arg
  if (quoteChar && inner.endsWith(quoteChar)) inner = inner.slice(0, -1)

  // `cd ..<Tab>` means "into there", not "a sibling starting with ..".
  const lastOfInner = inner.split(/[\\/]/).pop() ?? ''
  const stepped = lastOfInner === '.' || lastOfInner === '..' || lastOfInner === '~'
  const cut = stepped ? inner.length : Math.max(inner.lastIndexOf('/'), inner.lastIndexOf('\\')) + 1
  const argDirRaw = inner.slice(0, cut)
  const prefix = stepped ? '' : inner.slice(cut)

  const dir = resolvePathAgainst(argDirRaw || '.', base, home)
  if (!dir) return null

  const typedSep = /\\/.test(inner) ? '\\' : /\//.test(inner) ? '/' : ''
  const sep = typedSep || (WINDOWS_LIKE.test(dir) ? '\\' : '/')
  const argDir = stepped && argDirRaw && !/[\\/]$/.test(argDirRaw) ? argDirRaw + sep : argDirRaw
  return { dir, prefix, head, argDir, sep, quote: quoteChar !== '', wantHidden: prefix.startsWith('.') }
}

/** The children that complete the leaf — case-insensitive prefix match, in the
 *  listing's own (already case-folded) order. */
export function filterCompletions(names: readonly string[], prefix: string): string[] {
  const want = prefix.toLowerCase()
  return names.filter((name) => name.toLowerCase().startsWith(want))
}

/** The longest prefix every candidate shares (case-insensitively), spelled the way
 *  the FIRST candidate spells it — what a first Tab may extend to without choosing. */
export function commonPrefix(names: readonly string[]): string {
  if (!names.length) return ''
  const first = names[0]!
  let end = first.length
  for (const name of names) {
    let i = 0
    const cap = Math.min(end, name.length)
    while (i < cap && name[i]!.toLowerCase() === first[i]!.toLowerCase()) i++
    end = i
    if (!end) break
  }
  return first.slice(0, end)
}

/** Rebuild the line around a picked (or prefix-extended) name. `descend` appends
 *  the separator — a chosen folder is somewhere to keep typing into. */
export function applyCompletion(ctx: CompletionContext, name: string, descend: boolean): string {
  const value = ctx.argDir + name + (descend ? ctx.sep : '')
  const needsQuote = ctx.quote || /\s/.test(value)
  return ctx.head + (needsQuote ? `"${value}"` : value)
}
