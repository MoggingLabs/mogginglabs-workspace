import { PANE_CWD_MAX, type DirListing, type DirRefusal, type DirResult, type GitStatus } from '@contracts'

/**
 * THE working-folder selection (Phase-8.5/03). One value, one resolver, one place
 * that decides what is true — the path bar, the folder browser, the current-folder
 * line, the git chip, the name placeholder, and the worktree toggle are all just
 * views of it.
 *
 * WHY THIS EXISTS. The bar and the browser each used to own a copy of the path and
 * push it at the other, guarded by "silent" setters. That works right up until two
 * updates overlap, and then it ping-pongs: the browser writes the bar, the bar's
 * handler writes the browser, and a slow `listDir` lands after a fast one and drags
 * the user backwards. The fix is structural, not defensive:
 *
 *   1. Every change names its ORIGIN. A view is never written back to by the change
 *      it caused, so there is no cycle to break — one does not form.
 *   2. Exactly one resolver runs per change, and its result is discarded unless it
 *      is still the newest (a monotonic token). A stale reply cannot win.
 *   3. Typing is debounced HERE, not in the bar: `cwd` moves on the first keystroke
 *      (so Launch validates against what you see), while the filesystem is asked
 *      once, 350ms later.
 *   4. The browser's own navigation already holds a listing, so we do not fetch it
 *      again — a `browser` origin costs one `git:query` and nothing else.
 */

/**
 * `reveal` is the odd one out: it moves what the BROWSER is looking at without
 * choosing anything. Opening a fresh wizard at the user's home directory must not
 * silently make `$HOME` the workspace root — looking is not choosing.
 */
export type PathOrigin = 'prefill' | 'bar' | 'browser' | 'recent' | 'native' | 'remote' | 'reveal'

export interface PathState {
  /** The chosen working folder. Canonical once the filesystem has confirmed it. */
  cwd: string
  git: GitStatus | null
  isRepo: boolean
  /** Set when the last resolve refused: a typed path that is not a folder. */
  refusal: DirRefusal | null
  /** A resolve is in flight for the current `cwd`. */
  probing: boolean
  /** A remote host owns the cwd — this machine's filesystem is not the subject. */
  remote: boolean
}

/** The listing that came back with the change, when one did. */
export type PathListener = (state: Readonly<PathState>, origin: PathOrigin, listing?: DirListing) => void

export interface PathSelectionHandle {
  state(): Readonly<PathState>
  /** Move the selection. Views update synchronously; the filesystem answers later. */
  set(next: string, origin: PathOrigin): void
  /** Point the browser at a folder WITHOUT choosing it. Leaves `cwd` untouched. */
  reveal(dir: string): void
  /** Choosing an SSH host: stop asking this disk about a path on another machine. */
  setRemote(remote: boolean): void
  /** Fresh wizard. Cancels anything in flight. */
  reset(cwd: string): void
  subscribe(fn: PathListener): () => void
  /** Resolves once nothing is in flight — so Enter never races the debounce. */
  settle(): Promise<void>
  /** True when the selection is a folder we have not been refused. */
  isUsable(): boolean
}

export interface PathSelectionDeps {
  listDir: (path: string) => Promise<DirResult>
  gitQuery: (cwd: string) => Promise<GitStatus | null>
  /** Debounce for typed input. Injected so the smoke can drive it fast. */
  typeDelayMs?: number
}

export function createPathSelection(deps: PathSelectionDeps): PathSelectionHandle {
  const typeDelay = deps.typeDelayMs ?? 350
  const listeners = new Set<PathListener>()
  const st: PathState = { cwd: '', git: null, isRepo: false, refusal: null, probing: false, remote: false }

  let seq = 0 // monotonic: only the newest resolve may write
  let timer: ReturnType<typeof setTimeout> | undefined
  let settlers: (() => void)[] = []

  const emit = (origin: PathOrigin, listing?: DirListing): void => {
    for (const fn of [...listeners]) fn(st, origin, listing)
    if (!st.probing) {
      const waiting = settlers
      settlers = []
      for (const done of waiting) done()
    }
  }

  function cancel(): void {
    seq++ // invalidate anything in flight
    if (timer) clearTimeout(timer)
    timer = undefined
  }

  /** One round trip per change. `browser` already has its listing; never re-fetch it. */
  function resolve(target: string, origin: PathOrigin): void {
    const token = ++seq
    const wantListing = origin !== 'browser'
    const jobs: [Promise<DirResult | null>, Promise<GitStatus | null>] = [
      wantListing ? deps.listDir(target).catch(() => null) : Promise.resolve(null),
      deps.gitQuery(target).catch(() => null)
    ]
    void Promise.all(jobs).then(([dir, git]) => {
      if (token !== seq || st.cwd !== target) return // superseded: a newer change owns the state
      st.probing = false
      st.git = git
      st.isRepo = !!git
      st.refusal = dir && dir.ok === false ? dir : null
      emit(origin, dir && dir.ok ? dir : undefined)
    })
  }

  function set(next: string, origin: PathOrigin): void {
    cancel()
    st.cwd = next
    st.refusal = null
    st.git = null
    st.isRepo = false
    st.probing = !!next.trim() && !st.remote
    emit(origin) // synchronous: every view is correct before any IPC happens
    if (!st.probing) return
    if (origin === 'bar') timer = setTimeout(() => resolve(next, origin), typeDelay)
    else resolve(next, origin)
  }

  return {
    state: () => st,
    set,
    // Fetch a listing and hand it out; `cwd` never moves, so nothing gets chosen.
    // A failure here is silent: we were only offering somewhere to start looking.
    //
    // It CAPTURES the token rather than bumping it. Bumping would cancel a resolve
    // already in flight, leaving `probing` stuck true and `settle()` never keeping
    // its promise. And it bails once a real selection exists, so a slow home-listing
    // can never land on top of a folder the user already chose.
    reveal: (dir) => {
      const token = seq
      void deps
        .listDir(dir)
        .then((res) => {
          if (token !== seq || !res.ok || st.cwd.trim()) return
          emit('reveal', res)
        })
        .catch(() => undefined)
    },
    setRemote: (remote) => {
      cancel()
      st.remote = remote
      st.probing = false
      st.refusal = null
      if (remote) {
        st.git = null
        st.isRepo = false
      }
      emit('remote')
      if (!remote && st.cwd.trim()) set(st.cwd, 'prefill')
    },
    reset: (cwd) => {
      cancel()
      st.remote = false
      st.git = null
      st.isRepo = false
      st.refusal = null
      st.cwd = cwd
      st.probing = false
      if (cwd.trim()) set(cwd, 'prefill')
      else emit('prefill')
    },
    subscribe: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    // Enter in the path bar fires ~0ms after the last keystroke, while the resolve is
    // still 350ms out. Wait for it rather than launching into an unchecked path.
    settle: () =>
      st.probing ? new Promise<void>((done) => settlers.push(done)) : Promise.resolve(),
    // Empty remote cwd intentionally means HOME. A named remote cwd must be an absolute
    // POSIX path; the trusted main boundary repeats this check before constructing SSH argv.
    isUsable: () =>
      st.remote
        ? !st.cwd.trim() ||
          (st.cwd.startsWith('/') && st.cwd.length <= PANE_CWD_MAX && !/[\x00-\x1f\x7f]/.test(st.cwd))
        : !!st.cwd.trim() && !st.refusal
  }
}
