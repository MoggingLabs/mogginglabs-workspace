import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AgentChannels, type AgentInfo, type AgentInstallState } from '@contracts'
import { setAgentDetectOverrideForSmoke } from '../agents'

// PLAINMENU gate: the pane ⋯ menu's agent-launch entries are PLAIN-TERMINAL-ONLY. A launch
// is a WRITE into the pane's PTY — typed into a pane whose agent is already up it lands in
// that agent's PROMPT, and into a dead pane it goes nowhere — so the entries must appear
// exactly when the pane is a live shell with no agent session, through the WHOLE lifecycle:
//
//   plain  → entries offered            (a shell, nothing in it)
//   agent  → entries gone, facts stay   (detection replay — the real typed-launch seam)
//   live   → the OPEN menu tells the whole truth and follows it (see below)
//   gone   → entries return             (the agent's process-table exit verdict)
//   dead   → entries gone, menu lives   (`exit` kills the shell; Rename must survive)
//
// The `live` stage bites two regressions found 2026-07-18 (panes showed different fact
// sets depending on HOW their agent was started):
//   1. FULL FACT SET: a DETECTED agent pane — the app never launched it — must show every
//      expected row (Status, Profile, Agent context, Branch), with an explicit "none"
//      fallback where the pane genuinely lacks the fact. 'Profile: none' on a hand-typed
//      agent is the exact row that used to be silently absent.
//   2. LIVE FACTS: a fact changing under the OPEN menu (context reading, profile note)
//      must update the menu IN PLACE — the menu neither closes (the old behavior) nor
//      keeps showing the stale value.
//
// A last stage generalizes the same law to the OTHER conditional row: "Copy working
// directory" is offered exactly when the pane HAS a directory to copy. A remote pane with
// no path must not offer it (pre-fix it did, and the click was a silent no-op); a remote
// pane that knows its far-side path must.
//
// Hermetic: the installed CLI is a registry override (setAgentDetectOverrideForSmoke), the
// agent session is a replayed detection event (__mogging.agents.detected) — no real CLI, no
// network. Writes out/plainmenu-result.json, then exits (0=pass, 1=fail).
export function runPlainMenuSmoke(win: BrowserWindow): void {
  const resultFile = join(process.cwd(), 'out', 'plainmenu-result.json')
  let done = false
  const writeResult = (o: object): void => {
    try {
      writeFileSync(resultFile, JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }
  // Where the run currently is, so the net below NAMES the stall. A gate that burns its
  // outer timeout (150s) writes no result file at all and reports MISSING — strictly worse
  // to diagnose than a FAIL, because there is nothing to read.
  let stage = 'boot'
  setTimeout(() => {
    if (done) return
    done = true
    writeResult({ pass: false, error: 'TIMEOUT: plainmenu smoke did not complete', stage })
    app.exit(1)
  }, 90000)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  // One fixture CLI, installed — published through the same push a real install uses,
  // exactly as the AGENTREGISTRY gate does (that gate owns the multi-surface question;
  // this one owns the pane-menu LIFECYCLE question).
  const publishInstalled = async (): Promise<void> => {
    setAgentDetectOverrideForSmoke([
      { id: 'codex', name: 'Plain Codex', installed: true, installHint: 'npm install -g @openai/codex' } as AgentInfo
    ])
    const state: AgentInstallState = {
      agentId: 'codex',
      phase: 'succeeded',
      tail: '',
      exitCode: 0,
      startedAt: Date.now() - 10,
      endedAt: Date.now()
    }
    wc.send(AgentChannels.installChanged, state)
    await sleep(700)
  }

  /** Open the pane's ⋯ menu, read it, close it — one synchronous renderer pass, so the
   *  live facts refresh (which rebuilds the open menu in place) can never race the read. */
  interface MenuRead {
    opened: boolean
    launch: number
    rename: boolean
    agentNote: boolean
    /** "Copy working directory" — offered ONLY when this pane HAS a directory to copy. */
    copyCwd: boolean
    /** A known sibling action: an absence reading is worthless without it (an empty or
     *  failed menu would otherwise "prove" every row is correctly gone). */
    clear: boolean
    /** The pane's own "Remote: <host>" fact row — the remote stage's identity witness. */
    remoteFact: boolean
  }
  const readMenu = (paneId: number): Promise<MenuRead> =>
    ES<MenuRead>(`(() => {
      const blank = { opened: false, launch: -1, rename: false, agentNote: false, copyCwd: false, clear: false, remoteFact: false }
      const button = document.querySelector('.layout-slot[data-pane-id="${paneId}"] [aria-label="Pane menu"]')
      if (!(button instanceof HTMLButtonElement)) return blank
      button.click()
      const menu = document.getElementById('pane-menu-${paneId}')
      const opened = !!menu && !menu.hidden
      const items = menu ? [...menu.querySelectorAll('.menu-item')].map(el => (el.textContent || '').trim()) : []
      const launch = items.filter(text => /^Launch .+ here$/.test(text)).length
      const rename = items.includes('Rename')
      const copyCwd = items.includes('Copy working directory')
      const clear = items.includes('Clear terminal')
      const agentNote = !!menu && (menu.textContent || '').includes('Agent CLI:')
      const remoteFact = !!menu && (menu.textContent || '').includes('Remote: ')
      button.click()
      return { opened, launch, rename, agentNote, copyCwd, clear, remoteFact }
    })()`)

  /** Poll the menu until `want` holds (the agents feature repopulates commands and
   *  retires sessions asynchronously — a fixed sleep would be a guess). */
  const untilMenu = async (paneId: number, want: (m: MenuRead) => boolean, tries = 40): Promise<MenuRead> => {
    let last: MenuRead = {
      opened: false, launch: -1, rename: false, agentNote: false,
      copyCwd: false, clear: false, remoteFact: false
    }
    for (let i = 0; i < tries; i++) {
      last = await readMenu(paneId)
      if (want(last)) return last
      await sleep(250)
    }
    return last
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      await sleep(1500)
      await ES(`window.__mogging.workspace.create({ name: 'PlainMenu', cwd: ${JSON.stringify(process.cwd())} })`)
      await sleep(900)
      const active = (await ES(`window.__mogging.workspace.active()`)) as { ordinal: number }
      const paneId = active.ordinal * 100 + 1
      await publishInstalled()

      // ── plain: a live shell, no session — the entries are offered ──────────────────
      stage = 'plain'
      const plain = await untilMenu(paneId, (m) => m.opened && m.launch >= 1)

      // ── agent: replay the backend's detection verdict — the entries retire, the
      //    Agent CLI fact appears (the menu still tells the truth about the pane) ─────
      stage = 'agent'
      await ES(`window.__mogging.agents.detected({ id: ${paneId}, agentId: 'codex', cwd: '', sinceMs: 5000 })`)
      const agent = await untilMenu(paneId, (m) => m.opened && m.launch === 0 && m.agentNote)

      // ── live: the open menu shows the FULL fact set for a detected agent, and follows
      //    fact changes in place (neither closing nor going stale) ─────────────────────
      stage = 'live'
      const live0 = await ES<Record<string, boolean>>(`(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms))
        const button = document.querySelector('.layout-slot[data-pane-id="${paneId}"] [aria-label="Pane menu"]')
        if (!(button instanceof HTMLButtonElement)) return { failed: true }
        button.click()
        const menu = document.getElementById('pane-menu-${paneId}')
        const openedBefore = !!menu && !menu.hidden
        const text0 = (menu && menu.textContent) || ''
        // 1. FULL FACT SET on a DETECTED pane: every row exists, absence says "none".
        const fullFacts = {
          statusRow: text0.includes('Status:'),
          profileFallback: text0.includes('Profile: none'),
          contextRow: text0.includes('Agent context:'),
          branchRow: text0.includes('Branch:')
        }
        // 2. LIVE FACTS: drive two fact ports UNDER the open menu — one the header
        // renders (context), one it does not (the profile note) — and require the menu
        // to stay open and read the new truth.
        window.__mogging.context.set(${paneId}, 62)
        await sleep(200)
        const openAfterContext = !!menu && !menu.hidden
        const contextLive = !!menu && (menu.textContent || '').includes('Agent context: 62% used')
        window.__mogging.agents.profileNote(${paneId}, 'Live Profile')
        await sleep(200)
        const openAfterProfile = !!menu && !menu.hidden
        const profileLive = !!menu && (menu.textContent || '').includes('Profile: Live Profile')
        button.click() // close
        window.__mogging.agents.profileNote(${paneId}) // clear the fixture note
        const closed = !!menu && menu.hidden
        return { openedBefore, ...fullFacts, openAfterContext, contextLive, openAfterProfile, profileLive, closed }
      })()`)
      const live = {
        ok:
          live0.openedBefore === true && live0.statusRow === true && live0.profileFallback === true &&
          live0.contextRow === true && live0.branchRow === true && live0.openAfterContext === true &&
          live0.contextLive === true && live0.openAfterProfile === true && live0.profileLive === true &&
          live0.closed === true,
        ...live0
      }

      // ── gone: the agent's exit verdict clears the session — the entries return ─────
      stage = 'gone'
      await ES(`window.__mogging.agents.detected({ id: ${paneId}, agentId: null })`)
      const gone = await untilMenu(paneId, (m) => m.opened && m.launch >= 1 && !m.agentNote)

      // ── dead: kill the shell itself; entries go, the menu (Rename) survives ────────
      // The write must land in a LIVE PTY (a still-spawning one drops it silently).
      stage = 'dead'
      let paneWasLive = false
      for (let i = 0; i < 60 && !paneWasLive; i++) {
        paneWasLive = Boolean(await ES(`window.__mogging.agents.paneLive(${paneId})`))
        if (!paneWasLive) await sleep(500)
      }
      await ES(`window.bridge.send('terminal:write', { id: ${paneId}, data: 'exit\\r' })`)
      // Process truth first: the pane prints its epitaph when the exit event arrives.
      let exited = false
      for (let i = 0; i < 60 && !exited; i++) {
        exited = Boolean(
          await ES(
            `(() => { const p = (window.__mogging.panes || []).find(p => p.id === ${paneId}); return !!p && p.text().includes('process exited') })()`
          )
        )
        if (!exited) await sleep(500)
      }
      const dead = await untilMenu(paneId, (m) => m.opened && m.launch === 0 && m.rename)

      // The registry still holds the fixture — proves the dead pane's empty launch
      // section is the pane's gate, not a command that quietly unpublished itself.
      const stillInstalled = (await ES<string[]>(`window.__mogging.agents.items()`)).includes('codex')

      // ── remote: THE MENU NEVER OFFERS WHAT IT CANNOT DO ───────────────────────────
      // "Copy working directory" is the same law as "Move to another workspace…" (offered
      // only when there IS somewhere to move to). A REMOTE pane has no local cwd — the
      // controller's publishPaneCwds SKIPS remote slots and the spawn sends cwd:'' — so the
      // row sat there permanently dead: its handler is gated on the cwd, so clicking it
      // copied nothing, said nothing, and left the user pasting whatever was on the
      // clipboard before, while the menu's own law says a fact the pane lacks must SAY so.
      //
      // Both halves live in ONE workspace, so the two readings differ in exactly one input
      // — whether the pane knows a directory — and in nothing else:
      //   slot 2: remote, no path at all                     -> the row must be GONE
      //   slot 3: remote WITH its far-side path (paneCwds -> the remote manifest, which is
      //           what getPaneRemote(id).cwd reads)          -> the row must be BACK
      // Slot 1 is left alone on purpose (GridLayout's constructor builds it first), and the
      // LOCAL control is free: the first workspace's pane carries the workspace cwd, and it
      // showed the row back in `plain` — asserted below.
      //
      // The hosts are unknown to the settings store, so the ssh spawn is refused in the
      // main process (daemon-relay) — no session, no cwd event, which is exactly the pane
      // under test. The same fixture CHROMEUX builds its remote pane with.
      stage = 'copyCwd'
      const remoteBase = await ES<number>(`(() => {
        window.__mogging.workspace.create({
          name: 'RemoteMenu',
          paneCount: 3,
          remotes: [null, { hostId: 'plainmenu-host-a', name: 'devbox-77' }, { hostId: 'plainmenu-host-b', name: 'devbox-78' }],
          paneCwds: [null, null, '/srv/plainmenu']
        })
        return window.__mogging.workspace.active().ordinal * 100
      })()`)
      // Settle-then-confirm rather than a guessed mount time: wait for the LAST of the three
      // slots to exist, which is the only thing the old fixed sleep was standing in for.
      let remoteMounted = false
      for (let i = 0; i < 40 && !remoteMounted; i++) {
        remoteMounted = await ES<boolean>(
          `!!document.querySelector('.layout-slot[data-pane-id="${remoteBase + 3}"]')`
        )
        if (!remoteMounted) await sleep(150)
      }
      // The menu is rebuilt on every open, so one read is normally the whole story — these
      // polls only cover a JUST-created 3-pane workspace still coming up. Same cap as every
      // other menu poll in this file: the old 8 (~2s) saved a pre-fix build ~8s of a 150s
      // budget and paid for it with the mount-latency margin a correct build needs.
      const remoteNoCwd = await untilMenu(remoteBase + 2, (m) => m.opened && m.rename && !m.copyCwd)
      const remoteWithCwd = await untilMenu(remoteBase + 3, (m) => m.opened && m.rename && m.copyCwd)
      const copyCwd = {
        // The absence is only meaningful on a menu that provably BUILT (Rename + Clear
        // terminal) for the provably REMOTE pane (its own "Remote: …" fact row).
        ok:
          plain.copyCwd &&
          remoteNoCwd.opened && remoteNoCwd.rename && remoteNoCwd.clear && remoteNoCwd.remoteFact &&
          !remoteNoCwd.copyCwd &&
          remoteWithCwd.opened && remoteWithCwd.rename && remoteWithCwd.clear &&
          remoteWithCwd.remoteFact && remoteWithCwd.copyCwd,
        local: plain.copyCwd,
        remoteMounted, // diagnostics: the grid really built before either menu was read
        noCwd: remoteNoCwd,
        withCwd: remoteWithCwd
      }

      const pass =
        plain.opened && plain.launch >= 1 && plain.rename && !plain.agentNote &&
        agent.opened && agent.launch === 0 && agent.agentNote && agent.rename &&
        live.ok &&
        gone.opened && gone.launch >= 1 && !gone.agentNote &&
        paneWasLive && exited &&
        dead.opened && dead.launch === 0 && dead.rename &&
        stillInstalled &&
        copyCwd.ok
      stage = 'done'
      result = { pass, plain, agent, live, gone, dead, paneWasLive, exited, stillInstalled, copyCwd }
    } catch (error) {
      result = { pass: false, error: String(error), stage }
    } finally {
      setAgentDetectOverrideForSmoke(null)
    }
    if (done) return // the net already wrote its verdict and is on its way out
    done = true
    writeResult(result)
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(run, 1200))
  else setTimeout(run, 1200)
}
