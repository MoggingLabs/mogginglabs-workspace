import { describe, expect, it } from 'vitest'
import { bodyWithoutComments, sourceOf } from './source-body'

/**
 * THE DIMS INVARIANT, pinned across the four layers that have to agree on it.
 *
 * A pane's grid is a reconciled invariant, not a one-way assertion:
 *
 *   1. Nothing is PUBLISHED before its inputs are final (the faces are active).
 *   2. Every fit ASSERTS to the pty, rather than only when xterm's own grid changed.
 *   2b. Nothing is published that xterm does not itself hold — ONE operation, BOTH sides.
 *   3. The session REPORTS the grid it holds, and the renderer heals a divergence.
 *   4. The daemon's belief FOLLOWS its pty, and never leads it.
 *   5. No drop is silent.
 *
 * Each of these lives in renderer code that touches the DOM at call time, or in daemon code
 * that pulls a native module at module scope, so none can be imported here. Asserted by
 * shape instead — with anchors that throw when they stop matching (source-body.ts), because
 * the failure mode of a stale source assertion is a test that passes for no reason.
 */

const TERMINAL_PANE = 'src/ui/features/terminal/terminal-pane.ts'

describe('1. a grid is published only when its inputs are final', () => {
  it('proposeGrid refuses before the terminal faces are active, as its FIRST act', () => {
    const src = sourceOf('src/ui/features/terminal/pane-fit.ts')
    const body = bodyWithoutComments(src, 'export function proposeGrid')
    const guard = body.indexOf('terminalFontsReady()')
    expect(guard).toBeGreaterThan(-1)
    // Before every measurement, not merely somewhere among them: a cell read against a
    // fallback face is not a measurement, and the ordering is what makes that structural.
    expect(guard).toBeLessThan(body.indexOf('getComputedStyle'))
    expect(guard).toBeLessThan(body.indexOf('deviceCell('))
  })

  it('the published cell is renderer-independent, from the DEVICE cell', () => {
    const src = sourceOf('src/ui/features/terminal/pane-fit.ts')
    expect(bodyWithoutComments(src, 'export function proposeGrid')).toContain('publishableCell(')
    // css.cell carries the DOM renderer's round(·cols)/cols residue; device.cell does not.
    expect(bodyWithoutComments(src, 'function deviceCell')).toContain('device?.cell')
  })
})

describe('2. every fit asserts to the pty', () => {
  const body = bodyWithoutComments(sourceOf(TERMINAL_PANE), 'private refit(')

  it('sends the resize unconditionally, not only when xterm changed', () => {
    expect(body).toContain('terminalClient.resize')
    // The gate this replaces made the PTY's correctness a function of XTERM's state, and
    // the two disagree exactly when it matters — a resize lost to a dead socket, or to a
    // session that did not exist yet.
    expect(body).not.toMatch(/if\s*\(\s*applyGrid\(/)
  })

  it('still skips a dead pane — it has no session to assert to', () => {
    expect(body).toMatch(/if\s*\(!this\.dead\)/)
  })

  it('reassertGrid no longer carries its own copy of the send', () => {
    const reassert = bodyWithoutComments(sourceOf(TERMINAL_PANE), 'private reassertGrid()')
    expect(reassert).toContain('this.refit()')
    expect(reassert).not.toContain('terminalClient.resize')
  })
})

describe('2b. a spawn publishes only a grid xterm actually holds', () => {
  // A spawn's dims are not a request. The daemon resizes the LIVE pty to them and only then
  // snapshots the replay (SessionManager.ensure), so this payload sets the pty's grid — while
  // `proposeGrid` says what the grid SHOULD be, which is not what xterm currently holds. Send
  // one without applying the other and a ConPTY session runs at two sizes at once.
  //
  // That is not cosmetic on Windows. ConPTY paints by DIFF, positioning absolutely inside its
  // own viewport and erasing nothing it did not repaint. Grow the pty's rows without growing
  // xterm's and conhost appends blank rows at the BOTTOM while the replay lands in a shorter
  // terminal whose content ends at ITS bottom row (pty-emulation.ts); conhost's answering
  // repaint — the one thing that re-aligns them — is clipped by the rows xterm does not have.
  // Every line printed afterwards lands N rows above the visible end of the pane and
  // overwrites an older row, keeping whatever tail outran it. PROFPERSIST_B read one back:
  // `MARKB1=PROFILE_B_4242echo SHELL_READY_0_…` — the right value with a dead command line
  // still hanging off it.
  const body = bodyWithoutComments(sourceOf(TERMINAL_PANE), 'private spawnPty(')

  it('applies the proposal to xterm BEFORE it goes out as the spawn dims', () => {
    const applied = body.indexOf('applyGrid(this.term, grid)')
    const published = body.indexOf('cols: grid?.cols')
    expect(applied).toBeGreaterThan(-1)
    expect(published).toBeGreaterThan(-1)
    expect(applied).toBeLessThan(published)
  })

  it('publishes exactly what it applied — one measurement, no second proposal between them', () => {
    expect(body.match(/proposeGrid\(this\.term\)/g) ?? []).toHaveLength(1)
    expect(body).toMatch(/applyGrid\(this\.term,\s*grid\)/)
    // An unmeasured pane applies nothing and sends nothing: `null` is the designed state,
    // and inventing a size here is the hazard the whole invariant exists to prevent.
    expect(body).toMatch(/if\s*\(grid\)\s*applyGrid\(/)
  })
})

describe('2c. the replay paints AFTER the grid is reconciled, never before', () => {
  // A reattach's whole screen rides the spawn reply (transport sends `scrollback` with
  // `spawned`), and the daemon puts it on the pane's data channel ahead of the reply. Painted
  // first, it lands at whatever grid xterm happens to hold — and on a dims-less reattach that
  // is the fabricated 80x24 while the pty is on its own. ConPTY paints by diff at absolute
  // rows and erases nothing it did not repaint, so a viewport that disagrees with conhost's
  // screen from the first frame stays wrong for the pane's whole life.
  const src = sourceOf(TERMINAL_PANE)

  it('the pane holds pty bytes from the moment it asks for a session', () => {
    const body = bodyWithoutComments(src, 'private spawnPty(')
    expect(body.indexOf('this.holdReplayPaint()')).toBeGreaterThan(-1)
    expect(body.indexOf('this.holdReplayPaint()')).toBeLessThan(body.indexOf('terminalClient'))
  })

  it('the flush follows reconcileSession — that order IS the fix', () => {
    const body = bodyWithoutComments(src, 'private spawnPty(')
    const reconciled = body.indexOf('this.reconcileSession(res.cols, res.rows)')
    const painted = body.indexOf('this.flushReplayPaint()')
    expect(reconciled).toBeGreaterThan(-1)
    expect(painted).toBeGreaterThan(reconciled)
  })

  it('a spawn that never answers still paints — no reply, no permanently blank pane', () => {
    const body = bodyWithoutComments(src, 'private spawnPty(')
    const failed = body.slice(body.indexOf('.catch((err)'))
    expect(failed).toContain('this.flushReplayPaint()')
    expect(bodyWithoutComments(src, 'private holdReplayPaint()')).toContain('REPLAY_HOLD_MAX_MS')
  })

  it('only the PAINT waits — every port signal still fires on arrival', () => {
    // Deferring the probes too would move liveness, remote-ready and agent-ready behind an
    // IPC round trip; the hold is the last act of the handler, after all of them.
    const handler = src.slice(src.indexOf('terminalClient.onData((e) => {'), src.indexOf('terminalClient.onExit('))
    const held = handler.indexOf('this.replayHold.push(e.data)')
    expect(held).toBeGreaterThan(-1)
    for (const signal of ['markPaneLive', 'markPaneRemoteReady', 'markPaneAgentReady']) {
      expect(handler.indexOf(signal), signal).toBeLessThan(held)
    }
  })

  it('the queue drains in arrival order, and clears before it writes', () => {
    // xterm runs OSC handlers synchronously inside write(); one of them re-entering this
    // pane must find the straight-through state, not a half-drained queue.
    const body = bodyWithoutComments(src, 'private flushReplayPaint()')
    expect(body.indexOf('this.replayHold = null')).toBeLessThan(body.indexOf('this.term.write(chunk)'))
    expect(body).toMatch(/for\s*\(const chunk of held\)/)
  })
})

describe('3. the session reports its grid, and the renderer reconciles', () => {
  it('the spawn reply is consumed for the session dims', () => {
    const src = sourceOf(TERMINAL_PANE)
    const then = src.slice(src.indexOf('.then((res)'), src.indexOf('.catch((err)'))
    expect(then).toContain('this.reconcileSession(res.cols, res.rows)')
  })

  it('reconcile PUBLISHES nothing from an unmeasured pane, and stays silent on agreement', () => {
    const body = bodyWithoutComments(sourceOf(TERMINAL_PANE), 'private reconcileSession(')
    // The session's size is not evidence about this pane's BOX, so it never goes back out
    // as a resize — that would size a live agent to a layout from another app run.
    const noProposal = body.slice(body.indexOf('if (!d)'), body.lastIndexOf('applyGrid'))
    expect(noProposal).not.toContain('terminalClient.resize')
    expect(body).toMatch(/if\s*\(this\.sessionDims\.cols === d\.cols && this\.sessionDims\.rows === d\.rows\)\s*return/)
  })

  it('...but an unmeasured pane still renders the session at the SESSION’s size', () => {
    // xterm's grid with no proposal is the constructor's fabricated 80x24 — nobody's
    // measurement — and it is the size the session's own replay is about to be painted at.
    // Leaving it there is what put a dims-less reattach's every later line N rows above the
    // visible end of the pane on ConPTY (PROFPERSIST_B's residue tail).
    const body = bodyWithoutComments(sourceOf(TERMINAL_PANE), 'private reconcileSession(')
    const noProposal = body.slice(body.indexOf('if (!d)'), body.lastIndexOf('applyGrid'))
    expect(noProposal).toContain('applyGrid(this.term, this.sessionDims)')
  })

  it('the daemon samples the dims AFTER ensure(), so the reply is post-reconciliation truth', () => {
    const src = sourceOf('src/pty-daemon/transport.ts')
    const spawned = src.slice(src.indexOf("t: 'spawned'"), src.indexOf('subscribe(m.id)'))
    expect(spawned).toContain('cols: pane.cols')
    expect(spawned).toContain('rows: pane.rows')
  })
})

describe('4. belief follows the pty, never leads it', () => {
  const body = bodyWithoutComments(sourceOf('src/pty-daemon/session.ts'), 'resize(cols: number, rows: number): void')

  it('applies before it believes', () => {
    const apply = body.indexOf('this.proc.resize(')
    const believe = body.indexOf('this.cols = cols')
    expect(apply).toBeGreaterThan(-1)
    expect(believe).toBeGreaterThan(-1)
    // These fields are what info() reports, what snapshot() persists, and what attachDims
    // compares against. Written first and paired with a swallowed throw, one failed resize
    // left all three describing a size ConPTY never took — and the dedupe made it forever.
    expect(apply).toBeLessThan(believe)
  })

  it('refuses dims node-pty would throw on, before anything believes them', () => {
    expect(body.indexOf('specDimsUsable(')).toBeLessThan(body.indexOf('this.proc.resize('))
  })

  it('does not confirm a size the pty failed to take', () => {
    const failure = body.slice(body.indexOf('catch'), body.indexOf('this.cols = cols'))
    expect(failure).not.toContain('flushPendingLaunch')
    expect(failure).toContain('return')
  })

  it('the in-proc twin keeps the same order', () => {
    const twin = bodyWithoutComments(
      sourceOf('src/backend/features/terminal/pty.service.ts'),
      'resize({ id, cols, rows }: ResizeCommand): void'
    )
    // `sizes` is not local bookkeeping here either — spawn() reads it back as the size that
    // WINS over a fresh request, so a size recorded for a resize that threw outlives the
    // pane that failed it.
    expect(twin.indexOf('proc.resize(cols, rows)')).toBeLessThan(twin.lastIndexOf('this.sizes.set('))
  })
})

describe('4b. an attach realigns the client with conhost’s screen — once, and only there', () => {
  // The ring is a byte log, not a screen model, so a client rebuilt from it derives its own
  // row alignment and can disagree with conhost about which row is which (measured on the
  // Windows runner: replay cursor at row 0 col 45, content to row 21, live output landing
  // mid-buffer over rows nothing ever erased). Only conhost can restate its screen, and only
  // a resize makes it. This is the narrow, named hole in the same-size dedupe.
  const SESSION = 'src/pty-daemon/session.ts'
  const body = bodyWithoutComments(sourceOf(SESSION), 'repaintForAttach(): void')

  it('JIGGLES — a same-size resize is a no-op in conhost and repaints nothing', () => {
    // Measured on the runner: the first cut asked for the size conhost already held and got
    // `burstBytes: 0`. ResizePseudoConsole repaints on a real CHANGE, not on being asked.
    const grow = body.indexOf('this.proc.resize(this.cols, this.rows + 1)')
    const restore = body.lastIndexOf('this.proc.resize(this.cols, this.rows)')
    expect(grow).toBeGreaterThan(-1)
    expect(restore).toBeGreaterThan(grow)
    expect(body.match(/this\.proc\.resize\(/g) ?? []).toHaveLength(2)
  })

  it('moves ROWS, never columns — width is the axis ConPTY loses data on', () => {
    // The OS's v1 discards its re-wrap overflow on a width shrink (CONPTY gate: 18-27 lost
    // markers of 120). A realignment must not corrupt the thing it realigns.
    expect(body).not.toMatch(/this\.proc\.resize\(this\.cols\s*[+-]\s*1/)
  })

  it('GROWS first and restores — a shrink would scroll a real line off a full screen', () => {
    // Conhost grows by appending empty rows at the BOTTOM, so +1 pushes nothing off the top
    // and the restore removes exactly the blank row it added.
    expect(body).not.toMatch(/this\.rows\s*-\s*1/)
    expect(body.indexOf('this.rows + 1')).toBeLessThan(body.lastIndexOf('this.proc.resize(this.cols, this.rows)'))
  })

  it('always puts the size back — a failed restore is reported, never silent', () => {
    // Conhost left one row taller than every belief in this process is the exact divergence
    // this method exists to end.
    const afterGrow = body.slice(body.indexOf('this.proc.resize(this.cols, this.rows + 1)'))
    expect(afterGrow).toContain('this.proc.resize(this.cols, this.rows)')
    expect((afterGrow.match(/log\(/g) ?? []).length).toBeGreaterThanOrEqual(1)
  })

  it('claims nothing: no belief written, no dirty mark, no launch released', () => {
    // Nothing about the session CHANGED — this emits bytes and reports no news. A stray
    // `this.cols =` here would let a repaint rewrite the grid it was only supposed to restate.
    expect(body).not.toMatch(/this\.(cols|rows)\s*=/)
    expect(body).not.toContain('flushPendingLaunch')
    expect(body).not.toContain('onChange')
  })

  it('is ConPTY-only, as its FIRST act — a POSIX pty has no alignment to lose', () => {
    const guard = body.indexOf("ptyEmulation().backend !== 'conpty'")
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(body.indexOf('this.proc.resize('))
  })

  it('the guard string is the one the emulation module actually reports', () => {
    // A guard that tests a string nothing produces is an early return that always fires —
    // the heal would die silently and every gate would still be green. So the literal is
    // asserted against its SOURCE, in both directions: the contract's backend union and the
    // function that mints the value. Rename the backend and this fails here, loudly, instead
    // of on a Windows runner three rounds later.
    const emulation = bodyWithoutComments(sourceOf('src/backend/platform/pty-host.ts'), 'export function ptyEmulation()')
    expect(emulation).toContain("backend: 'conpty'")
    expect(emulation).toContain("backend: 'posix'")
    const union = sourceOf('src/contracts/ipc/terminal.ipc.ts')
    expect(union).toContain("export type PtyEmulation = { backend: 'posix' } | { backend: 'conpty'; buildNumber: number }")
    // ...and no third spelling has appeared that the guard would silently miss.
    const backends = new Set(
      [...sourceOf('src/backend/platform/pty-host.ts').matchAll(/backend: '([a-z-]+)'/g)].map((m) => m[1])
    )
    expect([...backends].sort()).toEqual(['conpty', 'posix'])
  })

  it('fires ONLY on the measured-and-equal attach — never dims-less, never a fresh pane', () => {
    const ensure = bodyWithoutComments(sourceOf(SESSION), 'ensure(id: string, spec: SpawnSpec)')
    // Exactly one call site, and it sits inside the `else if (specDimsUsable(...))` arm: the
    // attach that applies nothing today, which is precisely why it cannot self-heal.
    expect(ensure.match(/repaintForAttach\(\)/g) ?? []).toHaveLength(1)
    const arm = ensure.slice(ensure.indexOf('else if (specDimsUsable(normalizedSpec))'))
    expect(arm.slice(0, arm.indexOf('}'))).toContain('existing.repaintForAttach()')
    // A dims-less attach states no measurement, so there is nothing to align to; a resize
    // that CHANGES the grid already repaints on its own.
    const changed = ensure.slice(ensure.indexOf('const dims = attachDims'), ensure.indexOf('else if (specDimsUsable'))
    expect(changed).not.toContain('repaintForAttach')
  })

  it('the mid-session dedupe it makes an exception to is still there', () => {
    // The exception is narrow BECAUSE the rule is right: a same-size resize mid-session is a
    // spurious repaint spliced over a live agent's frame.
    const resize = bodyWithoutComments(sourceOf(SESSION), 'resize(cols: number, rows: number): void')
    expect(resize).toMatch(/if\s*\(cols === this\.cols && rows === this\.rows\)/)
    expect(resize).not.toContain('repaintForAttach')
  })
})

describe('5. no drop is silent', () => {
  it('the daemon reports input and resize aimed at a pane it has no session for', () => {
    const src = sourceOf('src/pty-daemon/transport.ts')
    // Both cases had the same hole: `if (pane && gen ok) … else if (pane) log(…)` took NO
    // branch at all when there was no session, which is the window a pane refitting ahead
    // of its own spawn lands in.
    expect(bodyWithoutComments(src, "case 'input': {")).toContain("logDropNoSession('input'")
    expect(bodyWithoutComments(src, "case 'resize': {")).toContain("logDropNoSession('resize'")
  })

  it('the client reports a command it could not put on the socket', () => {
    const body = bodyWithoutComments(sourceOf('src/main/daemon-client.ts'), 'private send(m: ClientMessage): void')
    // `this.sock?.write(...)` evaluated to undefined with no socket: no throw, no log, no
    // return value — a whole class of loss swallowed whole.
    expect(body).toContain('clientLog')
    expect(body).not.toMatch(/this\.sock\?\.write/)
  })

  it('the relay reports a resize dropped for a tombstoned pane', () => {
    const src = sourceOf('src/main/daemon-relay.ts')
    const resize = src.slice(src.indexOf('TerminalChannels.resize, (_e, cmd: ResizeCommand)'))
    expect(resize.slice(0, resize.indexOf('client.resize('))).toContain("clientLog('command-tombstoned'")
  })

  it('the relay LOGS a welcome-vs-banked divergence but never adopts it', () => {
    const body = bodyWithoutComments(sourceOf('src/main/daemon-relay.ts'), 'onWelcome: (panes)')
    expect(body).toContain("clientLog('dims-divergent'")
    // Adopting would make the reconnect replay send `spawn {cols, rows}`, which the daemon
    // reads as a CLIENT MEASUREMENT and which releases a deferred launch — typing an agent
    // into a size no client ever measured, through the back door of the invariant built to
    // prevent exactly that.
    expect(body).not.toMatch(/spec\w*\.cols\s*=|Object\.assign\(\s*banked/)
  })
})
