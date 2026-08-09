import { describe, expect, it } from 'vitest'
import { ALT_SCREEN_ENTER_MAX_PREFIX, ALT_SCREEN_ENTER_RE } from '../../src/contracts/ipc/terminal.ipc'
import {
  isPaneAgentReadyPending,
  markPaneAgentReady,
  retirePaneLife,
  whenPaneAgentReady
} from '../../src/ui/core/terminal/liveness-port'
import { beginLaunchCover, coversLaunch } from '../../src/ui/features/agents/launch-readiness'
import { bodyWithoutComments, sourceOf } from './source-body'

// The launch overlay's ONE promise: it lifts when the agent is genuinely usable, and it
// never traps a pane. Both halves are load-bearing — a cover that lifts early loses the
// keystrokes it exists to protect, and one that never lifts is worse than no cover at all.

describe('the TUI-takeover marker', () => {
  it('matches what the CLIs actually emit', () => {
    expect(ALT_SCREEN_ENTER_RE.test('\x1b[?1049h')).toBe(true)
    expect(ALT_SCREEN_ENTER_RE.test('\x1b[?1047h')).toBe(true)
    expect(ALT_SCREEN_ENTER_RE.test('\x1b[?47h')).toBe(true)
    expect(ALT_SCREEN_ENTER_RE.test('boot noise\x1b[?1049h\x1b[H')).toBe(true)
  })

  it('does not match LEAVING the alternate screen', () => {
    // `l` resets the mode — the agent exiting, the exact opposite of ready.
    expect(ALT_SCREEN_ENTER_RE.test('\x1b[?1049l')).toBe(false)
  })

  it('keeps enough of a split chunk to complete the match', () => {
    // The renderer retains the last ALT_SCREEN_ENTER_MAX_PREFIX chars across PTY chunks;
    // that has to cover the longest sequence minus its final byte.
    const longest = '\x1b[?1049h'
    expect(ALT_SCREEN_ENTER_MAX_PREFIX).toBeGreaterThanOrEqual(longest.length - 1)
    for (let cut = 1; cut < longest.length; cut++) {
      const carried = longest.slice(0, cut).slice(-ALT_SCREEN_ENTER_MAX_PREFIX)
      expect(ALT_SCREEN_ENTER_RE.test(carried + longest.slice(cut)), `split at ${cut}`).toBe(true)
    }
  })
})

describe('the per-launch readiness waiter', () => {
  it('resolves true on the marker', async () => {
    const ready = whenPaneAgentReady(901, 5_000)
    markPaneAgentReady(901)
    await expect(ready).resolves.toBe(true)
  })

  it('resolves false at the ceiling — an overlay must never trap a pane', async () => {
    await expect(whenPaneAgentReady(902, 10)).resolves.toBe(false)
  })

  it('ignores a marker that arrives before anyone is waiting', async () => {
    // The pane's own vim, or the PREVIOUS agent in this pane. Registration happens right
    // before the launch command is typed, so nothing earlier may satisfy it.
    markPaneAgentReady(903)
    await expect(whenPaneAgentReady(903, 20)).resolves.toBe(false)
  })

  it('hands a superseding launch the signal, and settles the one it replaced', async () => {
    const first = whenPaneAgentReady(904, 5_000)
    const second = whenPaneAgentReady(904, 5_000)
    await expect(first, 'the abandoned launch must not hang').resolves.toBe(false)
    markPaneAgentReady(904)
    await expect(second).resolves.toBe(true)
  })

  it('settles when the pane’s life ends — no waiter outlives its shell', async () => {
    const ready = whenPaneAgentReady(905, 60_000)
    retirePaneLife(905)
    await expect(ready).resolves.toBe(false)
    expect(isPaneAgentReadyPending(905)).toBe(false)
  })

  it('reports pending only while a launch is listening', async () => {
    expect(isPaneAgentReadyPending(906)).toBe(false)
    const ready = whenPaneAgentReady(906, 5_000)
    expect(isPaneAgentReadyPending(906)).toBe(true)
    markPaneAgentReady(906)
    await ready
    expect(isPaneAgentReadyPending(906)).toBe(false)
  })
})

describe('which launches get covered', () => {
  it('covers local claude and nothing else', () => {
    expect(coversLaunch('claude', false)).toBe(true)
    for (const other of ['codex', 'gemini', 'opencode', 'aider', 'custom:foo', 'shell']) {
      expect(coversLaunch(other, false), `${other} has no readiness signal to end a cover with`).toBe(false)
    }
  })

  it('does not cover a remote launch', () => {
    expect(coversLaunch('claude', true)).toBe(false)
  })

  it('lifts the cover on "usable", never on the stricter prompt gate', () => {
    // isTrustSettled only becomes true after a NINE SECOND dialog-free window when a
    // folder's trust was not pre-carried. Holding the cover on that would blur a pane for
    // nine seconds after claude was measurably usable at two and a half — a hardcoded wait
    // dressed as readiness, which is the whole thing this feature replaces.
    const body = bodyWithoutComments(
      sourceOf('src/ui/features/agents/launch-readiness.ts'),
      'export function beginLaunchCover('
    )
    expect(body, 'the lift must ride the human-usable answer').toMatch(/void capped\(usable\)\.then\(drop\)/)
    // The overlay's ceiling runs from the WRITE. Running it from the raise let the
    // pre-write waits (liveness, the build) spend it, so the cover could lift at the very
    // moment the command went out — or burn 15s on a pane whose spawn had failed.
    expect(body, 'the overlay is bounded from the write, not the raise').toMatch(/bounded = capped\(promptable\)/)
    expect(body, 'only an auto-submitted prompt waits for the trust gate').toMatch(/return bounded \?\? promptable/)
  })

  it('derives both answers from ONE readiness waiter', () => {
    // A second whenPaneAgentReady for the same pane supersedes the first (resolving it
    // false), so awaiting the two questions independently would strand one of them.
    const body = bodyWithoutComments(
      sourceOf('src/ui/features/agents/launch-readiness.ts'),
      'export function paneReadiness('
    )
    expect(body.match(/whenPaneAgentReady\(/g)?.length).toBe(1)
    expect(body, 'promptable is strictly later than usable').toMatch(/promptable = usable\.then/)
  })

  it('hands an uncovered provider an inert handle, not a cover that can only time out', () => {
    const cover = beginLaunchCover(910, 'codex', false, 'Codex')
    expect(cover.ready, 'nothing truthful to await for a CLI with no signal').toBeNull()
    expect(() => {
      cover.settle()
      cover.cancel()
    }, 'call sites must read identically whether or not a cover exists').not.toThrow()
  })
})

describe('EVERY surface that injects an agent raises the cover', () => {
  // The defect this suite exists for: the cover shipped wired into ONE of the two
  // delivery paths, so creating a workspace from the wizard — the spawn-run path, where
  // the DAEMON types the command as the shell's first act — played the whole boot in the
  // open, injected command line included.
  const src = sourceOf('src/ui/features/agents/index.ts')

  /** launchInPane's signature spans lines, so its `{` is not the one on the declaration
   *  line — slice to the declaration first, then close on the real body brace. */
  const launchInPaneBody = (): string => {
    const at = src.indexOf('async function launchInPane(')
    expect(at, 'launchInPane was renamed — re-anchor this file rather than deleting it').toBeGreaterThan(-1)
    return bodyWithoutComments(src.slice(at), '): Promise<void> {')
  }

  it('spawn-run delivery covers BEFORE arming, since the daemon types at spawn', () => {
    const body = bodyWithoutComments(src, 'function spawnDeliver(req: AgentLaunchRequest)')
    const raise = body.indexOf('beginLaunchCover(')
    const arm = body.indexOf('armSpawnRun(')
    expect(raise, 'spawnDeliver must raise a cover — this is the path that shipped without one').toBeGreaterThan(-1)
    expect(arm).toBeGreaterThan(-1)
    expect(raise, 'raising after the arm loses the window the daemon types in').toBeLessThan(arm)
  })

  it('spawn-run settles on the delivered arm AND the typed fallback', () => {
    const body = bodyWithoutComments(src, 'function spawnDeliver(req: AgentLaunchRequest)')
    expect(body).toMatch(/cover\.settle\(\)/)
    // Both non-typing exits give the pane straight back.
    expect(body.match(/cover\.cancel\(\)/g)?.length, 'custom branch, refused build, and the catch').toBe(3)
    // A cover is removed only by settle/cancel, so a throw anywhere in this async body
    // would strand a pane blurred and input-refusing with no button to escape it.
    expect(body, 'a throw must give the pane back').toMatch(/\}\)\(\)\.catch\(\(\) => cover\.cancel\(\)\)/)
  })

  it('typed delivery covers at the COMMITMENT, not at the write', () => {
    const body = launchInPaneBody()
    const raise = body.indexOf('if (!resume) raiseCover()')
    const live = body.indexOf('whenPaneLive(paneId, 15000)')
    // Prefix, not the whole call — the write also carries the build's launch intent.
    const write = body.indexOf('agentsClient.launchInto(paneId, result.command')
    expect(raise, 'a fresh launch must be covered before it waits for the pane').toBeGreaterThan(-1)
    expect(write, 'the CLI write must still be here to order against').toBeGreaterThan(-1)
    expect(raise).toBeLessThan(live)
    expect(raise, 'covering at the write leaves the prompt and the command visible').toBeLessThan(write)
  })

  it('a resume waits for the adopt verdict before covering a possibly-LIVING agent', () => {
    const body = launchInPaneBody()
    const adopt = body.indexOf('wasPaneReattached(paneId)')
    const raise = body.indexOf('if (resume) raiseCover()')
    expect(adopt).toBeGreaterThan(-1)
    expect(raise, 'a reattached pane holds a live conversation — never block its input').toBeGreaterThan(adopt)
  })

  it('every path in launchInPane that types nothing gives the pane back', () => {
    const body = launchInPaneBody()
    // remote-readiness failure · adopt · custom · non-AgentCliId · build refused
    expect(body.match(/cover\.cancel\(\)/g)?.length, 'a forgotten cancel strands a pane blurred to the ceiling').toBe(6)
    // A pane id is a slot number, not an identity: closed mid-launch and re-minted by the
    // next split, it would take a full `cd … && claude …` line meant for someone else.
    expect(body, 'a recycled pane id must never be typed into').toMatch(/if \(!samePane\(\)\) \{/)
    expect(body).toMatch(/cover\.settle\(\)/)
  })
})

describe('the pane scans for takeover AND paint', () => {
  const body = bodyWithoutComments(sourceOf('src/ui/features/terminal/terminal-pane.ts'), 'terminalClient.onData((e)')

  it('needs a painted frame after the screen is taken, not just the takeover', () => {
    // Alt-screen entry lands a beat before claude's first frame; lifting there shows a
    // blank terminal, which is the intermediate step the cover exists to hide.
    expect(body).toMatch(/ALT_SCREEN_ENTER_RE/)
    expect(body).toMatch(/SGR_RE\.test/)
  })

  it('scans only while a launch is waiting, and re-arms per launch', () => {
    expect(body, 'a steady pane must not pay for this').toMatch(/isPaneAgentReadyPending\(this\.id\)/)
    expect(body, 'the next launch in this pane must wait afresh').toMatch(/this\.altSeen = false/)
  })
})

describe('a covered pane refuses input', () => {
  const src = sourceOf('src/ui/features/terminal/terminal-pane.ts')

  it('drops keystrokes instead of forwarding them into a booting CLI', () => {
    // Bytes typed at a CLI that has not mounted its TUI are silently discarded by the
    // CLI itself — forwarding them only makes the loss look like delivery.
    expect(bodyWithoutComments(src, 'this.term.onData((data)')).toMatch(
      /if \(!this\.dead && !this\.covered\)/
    )
  })

  it('takes the pane out of the focus path as well, so the keys are never read', () => {
    const body = bodyWithoutComments(src, 'private setCovered(covered: boolean)')
    expect(body).toMatch(/xterm-helper-textarea/)
    expect(body).toMatch(/helper\.disabled = covered/)
  })

  it('does not let the header wear the injected command either', () => {
    // cmd.exe titles its window after the command it runs, so a launching pane showed
    // "cmd.exe - claude --session-id … --settings …" in its header while the body was
    // correctly blurred. The cover owns the pane's presentation, title included.
    expect(bodyWithoutComments(src, 'this.term.onTitleChange((t)')).toMatch(/if \(!this\.covered\) applyTitle\(\)/)
    expect(bodyWithoutComments(src, 'private setCovered(covered: boolean)'), 'held titles must land on uncover').toMatch(
      /if \(!covered\) this\.reapplyTitle\?\.\(\)/
    )
  })

  it('clears the cover when the pane dies or restarts — the port replays on subscribe', () => {
    // Left standing, an offer repaints itself over whichever pane next takes this id,
    // wired to callbacks closing over a pane that no longer exists.
    for (const anchor of ['dispose(): void {', 'private restart(): void {']) {
      expect(bodyWithoutComments(src, anchor), anchor).toMatch(/setPaneFailoverOffer\(this\.id[^)]*, null\)/)
    }
  })
})

describe('nothing on the launch path waits on a clock', () => {
  const src = sourceOf('src/ui/features/agents/index.ts')
  const at = src.indexOf('async function switchPaneProfile(')
  expect(at, 'switchPaneProfile was renamed — re-anchor this file rather than deleting it').toBeGreaterThan(-1)
  const body = bodyWithoutComments(src.slice(at), '): Promise<void> {')

  it('the profile switch holds its blur on the readiness observation, not a floor', () => {
    expect(body, 'the switch must await the same signal every launch uses').toMatch(/await \(readyWait as Promise<boolean>\)/)
    expect(body, 'the hand-tuned splash floor is retired').not.toMatch(/typedAt \+ 5000/)
    expect(body, 'no elapsed-time readiness guess may return').not.toMatch(/Math\.max\(1000/)
  })

  it('still only continues a conversation it OBSERVED come up', () => {
    // Typed into an unknown TUI state the continuation prompt is simply eaten.
    expect(body).toMatch(/if \(provider === 'claude' && ready\)/)
  })
})
