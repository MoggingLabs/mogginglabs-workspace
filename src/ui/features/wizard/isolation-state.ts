import type { WorktreePreflight } from '@contracts'

/**
 * What the wizard knows about whether THIS folder can be isolated into per-agent worktrees.
 *
 * The state used to be `WorktreePreflight | null`, and `null` carried four different meanings:
 * not asked yet, asked and waiting, cache cleared, and *no probe will ever run* (a remote host
 * owns the cwd, so the preflight returns early without sending IPC at all). All four rendered
 * as the optimistic "Checking…" — so a remote target sat permanently pending with nothing in
 * flight, which is the unknown taking the permissive branch, applied to a state that cannot
 * resolve.
 *
 * Naming the four makes the impossible one impossible to render as the hopeful one.
 */
export type IsolationProbe =
  /** A remote host owns the cwd. Isolation is local-only, so no probe will ever run. */
  | { kind: 'not-applicable' }
  /** No folder chosen yet — there is nothing to ask about. */
  | { kind: 'no-folder' }
  /** A probe is genuinely in flight. The ONLY state that may say "Checking…". */
  | { kind: 'pending' }
  | { kind: 'answered'; preflight: WorktreePreflight }

/** What the toggle, its hint and its fix button should show. */
export interface IsolationView {
  /** May the checkbox be operated at all? */
  enabled: boolean
  /** Is it drawn ticked right now? */
  checked: boolean
  /**
   * The user's INTENT, carried through untouched.
   *
   * `syncIsolate` used to do `if (!usable) isolate = false` — writing a transient unknown into
   * durable state. Every folder change nulls the verdict, so switching folders silently
   * un-ticked the box, and coming back to a folder that CAN isolate left it unchecked. What
   * the user asked for is not evidence about the filesystem and must not be overwritten by it.
   */
  want: boolean
  hint: string
  /**
   * The button to offer beside the refusal, if any.
   *   'path'    — re-read the live PATH and ask again (git installed after the app started).
   *   'recheck' — just ask again. The answer is cached per folder and five of the six refusal
   *               reasons had no way to re-ask at all, so a repository that became valid
   *               (first commit made, permissions fixed) stayed refused for the session.
   */
  fix: 'path' | 'recheck' | null
}

export function isolationView(input: { probe: IsolationProbe; want: boolean }): IsolationView {
  const { probe, want } = input
  const off = (hint: string, fix: IsolationView['fix'] = null): IsolationView => ({
    enabled: false,
    checked: false,
    want, // never cleared — see the field doc
    hint,
    fix
  })

  switch (probe.kind) {
    case 'not-applicable':
      // A scope statement, not a refusal: nothing is broken and there is nothing to fix.
      return off('Isolation runs on this machine only.')

    case 'no-folder':
      return off('Needs a git repository.')

    case 'pending':
      return off('Checking…')

    case 'answered': {
      const { preflight } = probe
      if (preflight.ok) return { enabled: true, checked: want, want, hint: 'Own branch and folder per agent.', fix: null }
      switch (preflight.reason) {
        case 'no-git':
          // THE case this preflight was written for. Not "install git" — git is usually
          // already installed and simply arrived after this app started, so the honest fix is
          // one button, not a download.
          return off('Git is unreachable — if you installed it recently, it just needs picking up.', 'path')
        case 'no-commits':
          return off('No commits yet — make one first.', 'recheck')
        case 'not-writable':
          return off('Folder is read-only.', 'recheck')
        case 'unsupported':
          return off(
            preflight.detail ? `Git refused: ${preflight.detail}` : 'Git couldn’t prepare this repository.',
            'recheck'
          )
        default:
          return off('Not a git repository — run `git init` to enable.', 'recheck')
      }
    }
  }
}
