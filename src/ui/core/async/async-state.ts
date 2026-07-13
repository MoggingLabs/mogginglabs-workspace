import { showToast } from '../../components'

/**
 * The four things every async call in this app owes the user, in one place (finding 39).
 *
 * The audit found each of them broken somewhere different, and all eight features were broken
 * in their OWN way, which is the tell that the policy was missing rather than the code sloppy:
 *
 *   Home        caught the error and rendered an EMPTY state — a failure that looks exactly
 *               like "you have no recent projects". The worst lie in the set: it is calm.
 *   Review      no catch at all; a rejection was an unhandled promise and the UI just sat there.
 *   Board       optimistic mutation, no rollback — the card moved on screen and nowhere else.
 *   Browser     a failed navigation reported nothing.
 *   Settings    a failed fetch rendered blank.
 *   Activity    no request generation: a slow answer for the OLD filter overwrote the new one.
 *   Usage       a cost fetch that never resolved left "Cost…" on screen forever.
 *   Integrations a button disabled on click and never re-enabled on failure — stranded.
 *
 * So: a loading phase, a TERMINAL error carrying a human sentence (never a raw stack), a
 * `finally` that always re-enables the controls, and a generation guard so a stale response can
 * never win. The generation guard is not new — it was already hand-rolled in eight files
 * (browser, integrations, explorer, wizard, agents, act-origins, pane-instance-port, file-tree).
 * This is that idiom, extracted, plus the two nobody wrote: the human message and the timeout.
 */

export type AsyncPhase = 'idle' | 'loading' | 'ready' | 'error'

export interface AsyncState<T> {
  readonly phase: AsyncPhase
  readonly data: T | null
  /** Human and actionable. Never String(err), never a stack. Set only in 'error'. */
  readonly error: string | null
}

export interface AsyncRunOptions<T> {
  /** An infinitive, e.g. "load recent projects" — folded into "Could not {action}." */
  action: string
  onLoading?: () => void
  /** Runs only if this call is still the newest when it resolves. */
  onSuccess?: (data: T) => void
  /** Runs only if still newest. Defaults to a danger toast — override to render inline,
   *  or to roll an optimistic mutation back. */
  onError?: (message: string, error: unknown) => void
  /** ALWAYS runs for the newest call, success or failure — re-enable controls HERE. Never
   *  runs for a call a newer one already superseded. */
  onSettle?: () => void
  /** Stop WAITING after N ms and call it a terminal error. It cannot abort the invoke (there
   *  is no cancel) — it only refuses to leave a spinner up forever. */
  timeoutMs?: number
}

export interface AsyncGuard<T> {
  readonly current: AsyncState<T>
  run(task: () => Promise<T>, options: AsyncRunOptions<T>): Promise<void>
}

/** One guard per logical call site, held beside a feature's other state. Never per call —
 *  a fresh guard per call has no memory, which is precisely what the generation needs. */
export function createAsyncGuard<T>(): AsyncGuard<T> {
  let generation = 0
  let current: AsyncState<T> = { phase: 'idle', data: null, error: null }
  return {
    get current() {
      return current
    },
    async run(task, options) {
      const token = ++generation
      current = { phase: 'loading', data: current.data, error: null }
      options.onLoading?.()
      try {
        const data = await withTimeout(task(), options.action, options.timeoutMs)
        if (token !== generation) return // superseded: a newer call owns the UI now
        current = { phase: 'ready', data, error: null }
        options.onSuccess?.(data)
      } catch (error) {
        if (token !== generation) return
        const message = describeAsyncError(error, options.action)
        current = { phase: 'error', data: current.data, error: message }
        if (options.onError) options.onError(message, error)
        else showToast({ tone: 'danger', title: `Could not ${options.action}`, body: message })
      } finally {
        if (token === generation) options.onSettle?.()
      }
    }
  }
}

function withTimeout<T>(p: Promise<T>, action: string, ms?: number): Promise<T> {
  if (!ms) return p
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out trying to ${action}.`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

/** Electron wraps every rejected IPC in "Error invoking remote handler '…': ". Shown raw, that
 *  string tells the user about our IPC and nothing about their problem. */
const IPC_WRAPPER = /^Error invoking remote (?:handler|method) '[^']*':\s*/i

/**
 * …and unwrapping is not enough, because some rejections have no sentence UNDERNEATH the wrapper:
 * the message IS the transport, talking about itself.
 *
 * The one that shipped this rule: a handler whose promise never settles becomes unreachable — the
 * awaiting frame is only reachable FROM the promise that can never settle — so V8 collects the
 * cycle, and with it the `event._replyChannel` for the invoke still pending in the renderer.
 * Electron's ReplyChannel destructor answers that invoke rather than abandon it, with the literal
 * string "reply was never sent". It is a REAL IPC reply, so it arrives as an ordinary rejection and
 * routinely BEATS this module's own `timeoutMs` — and the user was shown "The cost scan didn’t run
 * — reply was never sent". True, and about our plumbing rather than their cost data.
 *
 * Such a remainder is unreadable by the same standard as an empty message or a paragraph: it names
 * a reply, a handler, a channel, a clone — never the user's problem. Fall back to the generic,
 * which at least says what to do next. Anchored on purpose: a genuine backend sentence that merely
 * CONTAINS one of these words ("Could not clone the repository") must still reach the human.
 */
const IPC_NOISE = [
  /^reply was never sent$/i, // ReplyChannel dtor — the handler never answered and was collected
  /^no handler registered for\b/i, // the channel does not exist in this build
  /^an object could not be cloned\.?$/i, // structured clone failed at the bridge
  /^object has been destroyed$/i, // the native object went away mid-call
  /^render frame was disposed\b/i // the frame went away mid-call
]

export function describeAsyncError(error: unknown, action: string): string {
  const raw = (error instanceof Error ? error.message : typeof error === 'string' ? error : '')
    .replace(IPC_WRAPPER, '')
    .replace(/^Error:\s*/, '')
    .split('\n')[0]
    .trim()
  // Nothing readable survived, or what survived is a paragraph, or what survived is the transport
  // describing itself: say the honest generic thing rather than paste machine noise at someone.
  const unreadable = !raw || raw.length > 140 || IPC_NOISE.some((re) => re.test(raw))
  return unreadable ? `Could not ${action}. Try again.` : raw
}
