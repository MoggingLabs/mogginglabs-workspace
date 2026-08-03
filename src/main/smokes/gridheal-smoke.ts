// Env-gated grid-heal smoke (MOGGING_GRIDHEAL=1) — the grid self-reconciles.
//
// Gates the two heal moments the drift incident proved missing (a pane rendered at
// ~15 columns while its PTY held 80–203, permanently — nothing ever asked again):
//
//   A. REVEAL HEAL   expand covers siblings via `visibility: hidden` — their boxes never
//      change, so neither ResizeObserver nor IntersectionObserver fires (grid-layout.ts
//      documents this; FLICKER's dwell phase pins it). A pane whose xterm grid drifted
//      while covered must snap back to fit truth ON RESTORE (the reveal port), because
//      no box change is ever coming to do it.
//   B. RECONNECT HEAL   flap the daemon connection under a drifted pane; when the relay
//      heals (health 'reconnecting' → 'connected'), the pane must re-assert: xterm back
//      to fit truth AND the daemon's session at the same dims (the unconditional resize
//      — a resize lost to a dead socket must not outlive the flap that ate it).
//
//      The flap is a SAME-PID socket drop, not a daemon kill, and that choice is the
//      gate's teeth. A killed daemon takes seconds to replace, and those seconds show
//      the runtime-health banner — an in-flow row ABOVE the workspace host, so its
//      appearance reflows every pane, ResizeObserver ticks, and the ordinary refit
//      heals the drift INCIDENTALLY (this smoke's first draft proved it: a kill-based
//      phase passed with no fix in the tree). A fast flap is the live incident's shape
//      (pid 24100 → pid 24100 in 42ms): both health events land in one renderer task,
//      the banner never reaches layout, no box ever changes — nothing but a deliberate
//      reconnect re-assert can heal it.
//
// Drift is injected renderer-only (`term.resize(15,10)` via the dev handle): nothing
// forwards xterm's onResize to the PTY, so this reproduces exactly the incident state —
// renderer and PTY disagreeing, with no future trigger. Both phases hold the drift for
// a beat and assert it PERSISTS before healing — a gate that cannot bite proves nothing.
import { app, type BrowserWindow } from 'electron'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DaemonClient } from '../daemon-client'
import { getDaemonClient } from '../daemon-relay'
import { getDaemonHealth } from '../runtime-health'
import type { DaemonEndpoint } from '@contracts'

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Same run-dir/endpoint readers as daemonheal-smoke: the gate runs isolated, so the
// version segment under LOCALAPPDATA/MoggingLabs/run is OUR daemon and nobody else's.
function isolatedRunDir(): string {
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
      : process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), 'Library', 'Application Support')
  const runRoot = path.join(base, 'MoggingLabs', 'run')
  const seg = fs
    .readdirSync(runRoot)
    .find((n) => /^(dev-)?v\d+$/.test(n) && fs.statSync(path.join(runRoot, n)).isDirectory())
  return path.join(runRoot, String(seg))
}

const readEndpoint = (): DaemonEndpoint | null => {
  try {
    return JSON.parse(fs.readFileSync(path.join(isolatedRunDir(), 'endpoint.json'), 'utf8')) as DaemonEndpoint
  } catch {
    return null
  }
}

const readClientLog = (): string => {
  try {
    return fs.readFileSync(path.join(isolatedRunDir(), 'client.log'), 'utf8')
  } catch {
    return ''
  }
}

/** Poll until the relay journals a fresh reconnect PAST `logOffset` and health says
 *  connected again — the same-pid flap's heal signal (the endpoint never changes). */
async function waitFlapHealed(logOffset: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (readClientLog().slice(logOffset).includes('daemon-reconnected') && getDaemonHealth().state === 'connected')
      return true
    await delay(100)
  }
  return false
}

// Shared renderer helpers, interpolated into every phase script. fitTruth is the same
// derivation PANEFIT gates (pane-fit.ts's math, measured against the ACTIVE renderer's
// cell) — this smoke asserts convergence back TO it, never a hardcoded grid.
const HELPERS = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const m = window.__mogging
  const cellOf = (p) => p.term._core._renderService.dimensions.css.cell
  const fitTruth = (p) => {
    const body = p.el().querySelector('.pane-body')
    const cs = getComputedStyle(body)
    const xs = getComputedStyle(p.term.element)
    const availW = parseFloat(cs.width) - parseFloat(xs.paddingLeft) - parseFloat(xs.paddingRight)
    const availH = parseFloat(cs.height) - parseFloat(xs.paddingTop) - parseFloat(xs.paddingBottom)
    const cell = cellOf(p)
    const wantCols = Math.max(2, Math.floor(availW / cell.width))
    const wantRows = Math.max(1, Math.floor(availH / cell.height))
    return {
      cols: p.cols(), wantCols, rows: p.rows(), wantRows,
      ok: p.cols() === wantCols && p.rows() === wantRows
    }
  }
  const hidden = (p) => getComputedStyle(p.el()).visibility === 'hidden'
  // The evidence trail: covered-sibling boxes are supposed to hold still through
  // expand/restore, and a box that MOVED explains a heal this gate must not credit.
  const rect = (p) => {
    const r = p.el().querySelector('.pane-body').getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  }
`

const SETUP_SCRIPT = `(async () => {
  ${HELPERS}
  if (!m || !m.workspace || !m.layout) return { pass: false, error: 'no dev handles' }
  if (m.workspace.count() === 0) m.workspace.create({ name: 'GridHeal' })
  await sleep(600)
  m.layout.apply(4)
  for (let i = 0; i < 100 && (m.panes || []).length < 4; i++) await sleep(200)
  const panes = (m.panes || []).slice(0, 4)
  if (panes.length < 4) return { pass: false, error: 'panes never mounted' }
  // Trace every xterm grid change from here on — the verdicts below cite WHO resized
  // and WHEN, so a heal credited to the fix can never be a straggler layout tick.
  window.__gridhealTrace = []
  for (const p of panes) p.term.onResize((e) => window.__gridhealTrace.push({ id: p.id, cols: e.cols, rows: e.rows, t: Date.now() }))
  // Settle to fit truth (renderer swap + the 120ms refit coalescer + the resize round trip).
  let fits = []
  for (let i = 0; i < 80; i++) {
    await sleep(100)
    fits = panes.map(fitTruth)
    if (fits.every((f) => f.ok)) break
  }
  return { pass: fits.every((f) => f.ok), fits, paneIds: panes.map((p) => p.id) }
})()`

// A. expand pane[0] full (siblings covered, boxes untouched), drift a covered sibling,
// prove the drift HOLDS (no observer fires for visibility covering), restore, converge.
const PHASE_A_SCRIPT = `(async () => {
  ${HELPERS}
  const panes = (m.panes || []).slice(0, 4)
  const target = panes[0]
  const rectAtStart = panes.map(rect)
  m.layout.expand(target.id, 'full')
  await sleep(500)
  const sib = panes.slice(1).find(hidden)
  if (!sib) { m.layout.expand(target.id, 'full'); return { pass: false, error: 'no covered sibling after expand' } }
  const rectCovered = rect(sib)
  const before = { cols: sib.cols(), rows: sib.rows() }
  sib.term.resize(15, 10)
  await sleep(1000)
  const drifted = sib.cols() === 15 && sib.rows() === 10
  const rectAtInject = rect(sib)
  m.layout.expand(target.id, 'full') // same mode toggled again -> plain grid restored
  let healed = null
  for (let i = 0; i < 80; i++) {
    await sleep(100)
    const f = fitTruth(sib)
    if (f.ok) { healed = f; break }
  }
  return {
    pass: drifted && !!healed,
    drifted, before, after: healed || fitTruth(sib), sibId: sib.id, sibVisibleAgain: !hidden(sib),
    rects: { start: rectAtStart[panes.indexOf(sib)], covered: rectCovered, atInject: rectAtInject, final: rect(sib) },
    trace: (window.__gridhealTrace || []).slice(-24)
  }
})()`

// B1. drift a VISIBLE pane — nothing in the renderer will ever heal this on its own
// (no box change is coming); only the reconnect edge may.
//
// The health banner is PINNED OUT OF LAYOUT first (restored in B2). Instrumented runs
// caught it healing the drift incidentally: even a same-pid flap flashed the banner for
// one frame, shrinking the workspace host — every pane refit to rows-1 and back, and
// the drifted pane rode along (trace: 15×10 → 81×17 → 81×18, all four panes in step).
// That reflow is a TIMING ACCIDENT — the live incident's stalled renderer never laid
// the banner out (42ms flap, no heal, the permanent 15-column pane) — and this phase's
// claim is exactly the accident-free case: reconnect must heal a pane NO layout motion
// ever will. Same seam-pinning spirit as FLICKER's __moggingGlBudget = 0.
const PHASE_B_INJECT_SCRIPT = `(async () => {
  ${HELPERS}
  const host = document.querySelector('.runtime-health-host')
  if (!host) return { pass: false, error: 'runtime-health-host missing (moved?)' }
  host.style.display = 'none'
  const panes = (m.panes || []).slice(0, 4)
  const p = panes.find((x) => !hidden(x)) || panes[0]
  // Let phase A's restore SETTLE first: its trailing coalescer refit (REFIT_SETTLE_MS)
  // lands up to ~120ms after the last box change and would wipe a drift injected under
  // it — this run's trace caught exactly that, 18ms after injection. Quiet trace first.
  for (let i = 0; i < 50; i++) {
    const tr = window.__gridhealTrace || []
    const last = tr.length ? tr[tr.length - 1].t : 0
    if (Date.now() - last > 600) break
    await sleep(100)
  }
  p.term.resize(15, 10)
  await sleep(400)
  return { id: p.id, drifted: p.cols() === 15 && p.rows() === 10 }
})()`

// B2. after the relay healed: the pane must be back AT fit truth (poll past the
// reconnect re-assert and its one delayed repeat).
const PHASE_B_VERIFY_SCRIPT = (paneId: number): string => `(async () => {
  ${HELPERS}
  const p = (m.panes || []).find((x) => x.id === ${paneId})
  if (!p) return { pass: false, error: 'drifted pane vanished' }
  let healed = null
  for (let i = 0; i < 150; i++) {
    await sleep(100)
    const f = fitTruth(p)
    if (f.ok) { healed = f; break }
  }
  const host = document.querySelector('.runtime-health-host')
  if (host) host.style.display = '' // the pin was B's alone — hand the banner back
  return {
    pass: !!healed, after: healed || fitTruth(p), cols: p.cols(), rows: p.rows(),
    rect: rect(p), trace: (window.__gridhealTrace || []).slice(-24)
  }
})()`

export function runGridHealSmoke(win: BrowserWindow): void {
  const wc = win.webContents
  const errors: string[] = []
  wc.on('console-message', (_e, level, message) => {
    if (level >= 3) errors.push(message)
  })
  const write = (o: object): void => {
    try {
      const out = path.join(process.cwd(), 'out')
      fs.mkdirSync(out, { recursive: true })
      fs.writeFileSync(path.join(out, 'gridheal-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }
  setTimeout(() => {
    write({ pass: false, error: 'TIMEOUT: grid-heal smoke did not complete' })
    app.exit(1)
  }, 220_000)

  const run = async (): Promise<void> => {
    const checks: Record<string, unknown> = {}
    try {
      // A fixed, generous window: the workspace canvas must never overflow into a
      // scrollbar, whose appearance/disappearance widens every pane box mid-phase —
      // a ResizeObserver tick that heals drift for reasons this gate is not testing.
      win.setSize(1600, 1000)
      const js = (script: string): Promise<Record<string, unknown>> =>
        wc.executeJavaScript(script, true) as Promise<Record<string, unknown>>

      const setup = await js(SETUP_SCRIPT)
      checks.setup = setup
      if (setup.pass !== true) throw new Error('setup failed: panes never reached fit truth')

      // ── A. reveal heal ───────────────────────────────────────────────────────────────
      checks.revealHeal = await js(PHASE_A_SCRIPT)

      // ── B. reconnect heal (same-pid flap — see the header) ───────────────────────────
      const inject = await js(PHASE_B_INJECT_SCRIPT)
      checks.reconnectDrifted = { pass: inject.drifted === true, ...inject }
      const ep1 = readEndpoint()
      if (!ep1) throw new Error('no daemon endpoint before the flap')
      // Drop the relay's live socket. `sock` is DaemonClient's private field — a
      // compile-time-only privacy, reached deliberately: there is no outside-in way to
      // sever ONE client's pipe while the daemon lives, and killing the daemon is the
      // wrong flap (banner reflow heals — header). If the field moves, this fails LOUD.
      const live = getDaemonClient() as unknown as { sock?: { destroy(): void } } | null
      if (!live?.sock) throw new Error('daemon client socket unreachable (private field moved?) — cannot flap')
      const logOffset = readClientLog().length
      live.sock.destroy()
      const healed = await waitFlapHealed(logOffset, 20_000)
      const ep2 = readEndpoint()
      checks.relayHealed = {
        pass: healed && ep2?.pid === ep1.pid,
        samePid: ep2?.pid === ep1.pid, pid: ep1.pid, journaled: healed
      }
      if (!healed) throw new Error('relay did not heal after the socket flap')
      checks.reconnectHeal = await js(PHASE_B_VERIFY_SCRIPT(Number(inject.id)))

      // Daemon-side half: the healed session must hold the SAME grid the renderer shows —
      // the welcome of a fresh probe client is daemon truth, no new protocol needed.
      const probe = new DaemonClient(ep1, {})
      const welcome = await probe.connect()
      probe.dispose()
      const info = welcome.find((p) => p.id === String(inject.id))
      const rCols = (checks.reconnectHeal as Record<string, unknown>).cols
      const rRows = (checks.reconnectHeal as Record<string, unknown>).rows
      checks.daemonDimsMatch = {
        pass: !!info && info.cols === rCols && info.rows === rRows,
        daemon: info ? { cols: info.cols, rows: info.rows } : null,
        renderer: { cols: rCols, rows: rRows }
      }
    } catch (err) {
      checks.error = String(err)
    }
    const result: Record<string, unknown> = { ...checks }
    result.rendererErrors = errors
    const phases = ['setup', 'revealHeal', 'reconnectDrifted', 'relayHealed', 'reconnectHeal', 'daemonDimsMatch']
    result.pass =
      !('error' in checks) &&
      errors.length === 0 &&
      phases.every((k) => (checks[k] as Record<string, unknown> | undefined)?.pass === true)
    write(result)
    app.exit(result.pass === true ? 0 : 1)
  }
  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(run, 2500))
  else setTimeout(run, 2500)
}
