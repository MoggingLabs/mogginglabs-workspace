import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app, type BrowserWindow } from 'electron'

// Env-gated TYPED-LAUNCH DETECTION smoke (MOGGING_TYPED). The bug it exists for: an agent the
// app did not launch had no identity at all — a pane added after workspace creation, with
// `claude` typed at its own prompt, showed no context gauge, no provider mark, and came back a
// blank shell after a restart. Detection now watches each pane's PTY SUBTREE in the process
// table, so this drives exactly that story and asserts the whole chain:
//
//   1. SPLIT a pane into an existing workspace (the reported scenario: added after creation).
//   2. TYPE an agent into it — raw terminal bytes, never the launcher. Two of them:
//      (a) a REAL npm-shaped claude (`node …/@anthropic-ai/claude-code/cli.js`), the exact
//          process shape an npm-installed Claude Code has, spawned from a temp file so the
//          gate is deterministic and needs nothing installed; and
//      (b) the REAL `claude` binary when this machine has one — the user's literal keystrokes.
//   3. Assert the pane grew a full session identity: agent-session port (detected: true, with
//      the agent's own cwd), the CONTEXT GAUGE visible in its header, and the workspace
//      MANIFEST recording the slot as claude — which is what makes it survive a cold restart.
//   4. Assert the NEGATIVE: a plain `node` process in another pane is not an agent, and never
//      claims one. A detector that fires on anything is worse than none.
//   5. Kill the agent and assert the session and the gauge RETIRE — the pane is a shell again.
//
// Writes out/typed-result.json, then exits (0=pass, 1=fail).

export function runTypedSmoke(win: BrowserWindow): void {
  const wc = win.webContents
  const errors: string[] = []
  let done = false

  wc.on('render-process-gone', (_e, d) => errors.push('render-process-gone: ' + JSON.stringify(d)))

  const ES = (js: string): Promise<unknown> => wc.executeJavaScript(js)
  const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const emit = (result: object): void => {
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'typed-result.json'), JSON.stringify(result))
    } catch {
      /* best effort */
    }
  }

  /** The pane's live session identity, as the renderer holds it. */
  const session = (paneId: number): Promise<{ provider?: string; cwd?: string; detected?: boolean; since?: number } | null> =>
    ES(`(function(){var s=window.__mogging.agents.session(${paneId});return s?JSON.parse(JSON.stringify(s)):null;})()`) as Promise<{
      provider?: string
      cwd?: string
      detected?: boolean
      since?: number
    } | null>

  /** The context gauge as RENDERED in that pane's header (the thing the user reported missing). */
  const gauge = (paneId: number): Promise<{ present: boolean; shown: boolean; pct: string }> =>
    ES(
      `(function(){var slot=document.querySelector('[data-pane-id="${paneId}"]');` +
        `var el=slot&&slot.querySelector('.pane-context');` +
        `return {present:!!el,shown:!!el&&!el.hidden,pct:el?(el.querySelector('.ctx-pct')||{}).textContent||'':''};})()`
    ) as Promise<{ present: boolean; shown: boolean; pct: string }>

  const type = async (paneId: number, line: string): Promise<void> => {
    await ES(`window.bridge.send("terminal:write",{id:${paneId},data:${JSON.stringify(line + '\r')}});`)
  }

  /** Poll until `check` passes or the budget runs out. Detection is deliberately edge-driven
   *  (a snapshot costs a process listing), so it lands in seconds, not milliseconds. */
  const until = async <T>(get: () => Promise<T>, check: (v: T) => boolean, budgetMs: number): Promise<T> => {
    const deadline = Date.now() + budgetMs
    let last = await get()
    while (!check(last) && Date.now() < deadline) {
      await delay(1000)
      last = await get()
    }
    return last
  }

  const run = async (): Promise<void> => {
    if (done) return
    done = true
    try {
      // A fake agent with a REAL agent's process shape: an npm-installed Claude Code runs as
      // `node <prefix>/node_modules/@anthropic-ai/claude-code/cli.js`, and the detector matches
      // on that package SEGMENT — never on the word "claude" in a command line. So this proves
      // the production matcher, with a process that just sits there.
      const fakeDir = join(tmpdir(), 'mogging-typed', 'node_modules', '@anthropic-ai', 'claude-code')
      mkdirSync(fakeDir, { recursive: true })
      const fakeCli = join(fakeDir, 'cli.js')
      writeFileSync(fakeCli, 'setInterval(function(){}, 1000)\n')

      // Workspace 1 exists (pane 1). Then SPLIT — the pane the user says has no gauge.
      await ES(
        '(function(){var m=window.__mogging;' +
          'if(m&&m.workspace&&m.workspace.count()===0)m.workspace.create({name:"Workspace 1"});return 1;})()'
      )
      await delay(2500)
      const splitOk = Boolean(
        await ES('(function(){window.__mogging.layout.split();return window.__mogging.layout.paneCount()>1;})()')
      )
      await delay(2500)
      const paneIds = (await ES('window.__mogging.layout.paneIds()')) as number[]
      const added = Math.max(...paneIds) // the pane that did not exist when the workspace did

      // Before: a plain shell. This is the state the bug never left.
      const before = { session: await session(added), gauge: await gauge(added) }

      // ── SHELL INTEGRATION: cmd.exe now reports its cwd (it never did) ────────────────────
      // This is what makes a typed agent's directory knowable at all on Windows, where a
      // process's cwd cannot be read: the pane's shell announces it on every prompt. Prove it
      // by cd-ing somewhere the pane was NOT seeded to, and watching the report arrive.
      await ES("window.__cwds=[];window.bridge.on('terminal:cwd',function(e){window.__cwds.push(e);});1")
      await delay(300)
      await type(added, 'cd /d C:\\Windows')
      await until(
        () => ES(`window.__cwds.filter(function(e){return e.id===${added};}).length`) as Promise<number>,
        (n) => n > 0,
        12000
      )
      const cwdEvents = (await ES(
        `window.__cwds.filter(function(e){return e.id===${added};}).map(function(e){return e.cwd;})`
      )) as string[]
      const cwdReported = cwdEvents.some((c) => /^c:[\\/]windows$/i.test(String(c).replace(/[\\/]+$/, '')))

      // ── TYPE the agent (raw bytes into the shell — the path that had no identity) ────────
      await type(added, `node "${fakeCli}"`)
      const s1 = await until(() => session(added), (s) => s?.provider === 'claude', 30000)
      const g1 = await until(() => gauge(added), (g) => g.shown, 15000)

      const detectedTyped = s1?.provider === 'claude' && s1?.detected === true
      // The agent's cwd is what NAMES its session log, so it must be where the agent actually
      // runs — the directory the shell was cd'd into, never the directory the pane was seeded
      // with. Getting this wrong is a gauge that never finds a session and sits blank forever.
      const cwdIsLive = /^c:[\\/]windows$/i.test(String(s1?.cwd ?? '').replace(/[\\/]+$/, ''))
      const cwdKnown = !!s1?.cwd && s1.cwd.length > 0
      const sinceKnown = typeof s1?.since === 'number' && s1.since > 0
      const gaugeShown = g1.present && g1.shown

      // ── The MANIFEST: what makes a typed agent survive a cold restart ────────────────────
      // Read back what was PERSISTED (not an in-memory field): on a cold daemon start this
      // file is the only thing that knows an agent belongs in that slot. Persist is debounced,
      // so give it a beat.
      await delay(1200)
      const manifest = (await ES(
        '(async function(){var s=await window.bridge.invoke("workspace:loadState");' +
          'var w=s&&s.workspaces&&s.workspaces[0];return (w&&w.assignments)||[];})()'
      )) as string[]
      const manifestRecorded = Array.isArray(manifest) && manifest.includes('claude')

      // ── NEGATIVE control: a plain node process is NOT an agent ───────────────────────────
      await type(1, 'node -e "setInterval(function(){},1000)"')
      await delay(9000) // two full snapshot windows — if it were going to fire, it would have
      const plainSession = await session(1)
      const noFalsePositive = !plainSession

      // ── RETIRE: kill the agent; the session and the gauge must go with it ────────────────
      await ES(`window.bridge.send("terminal:write",{id:${added},data:"\\u0003"});`) // ^C
      const s2 = await until(() => session(added), (s) => !s, 20000)
      const g2 = await until(() => gauge(added), (g) => !g.shown, 10000)
      const retired = !s2 && !g2.shown

      // ── The REAL binary, when this machine has one: the user's literal keystrokes ────────
      const installed = (await ES(
        '(async()=>{try{return (await window.__mogging.agents.detect()).filter(a=>a.installed).map(a=>a.id);}catch(e){return [];}})()'
      )) as string[]
      let realTyped: string | null = null
      if (Array.isArray(installed) && installed.includes('claude')) {
        // Claude Code refuses to nest inside another Claude session — clear the markers the
        // app may have inherited, exactly as the launcher gate does.
        await type(added, 'set "CLAUDECODE=" & set "CLAUDE_CODE_ENTRYPOINT="')
        await delay(700)
        await type(added, 'claude')
        const s3 = await until(() => session(added), (s) => s?.provider === 'claude', 40000)
        realTyped = s3?.provider === 'claude' && s3?.detected === true ? 'detected' : 'missed'
      } else {
        realTyped = 'claude-not-installed'
      }

      const pass =
        splitOk &&
        !before.session &&
        !before.gauge.shown &&
        cwdReported &&
        detectedTyped &&
        cwdIsLive &&
        cwdKnown &&
        sinceKnown &&
        gaugeShown &&
        manifestRecorded &&
        noFalsePositive &&
        retired &&
        realTyped !== 'missed' &&
        errors.length === 0

      emit({
        pass,
        addedPane: added,
        splitOk,
        before,
        cwdReported,
        cwdEvents,
        detectedTyped,
        session: s1,
        cwdIsLive,
        cwdKnown,
        sinceKnown,
        gaugeShown,
        gauge: g1,
        manifest,
        manifestRecorded,
        noFalsePositive,
        plainSession,
        retired,
        afterKill: { session: s2, gauge: g2 },
        installed,
        realTyped,
        errors
      })
      app.exit(pass ? 0 : 1)
    } catch (e) {
      emit({ pass: false, errors: [...errors, 'exception: ' + String(e)] })
      app.exit(1)
    }
  }

  wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  setTimeout(() => {
    if (done) return
    done = true
    emit({ pass: false, errors: [...errors, 'TIMEOUT'] })
    app.exit(1)
  }, 180000)
}
