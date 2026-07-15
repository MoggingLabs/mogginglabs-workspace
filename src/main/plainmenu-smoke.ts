import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AgentChannels, type AgentInfo, type AgentInstallState } from '@contracts'
import { setAgentDetectOverrideForSmoke } from './agents'

// PLAINMENU gate: the pane ⋯ menu's agent-launch entries are PLAIN-TERMINAL-ONLY. A launch
// is a WRITE into the pane's PTY — typed into a pane whose agent is already up it lands in
// that agent's PROMPT, and into a dead pane it goes nowhere — so the entries must appear
// exactly when the pane is a live shell with no agent session, through the WHOLE lifecycle:
//
//   plain  → entries offered            (a shell, nothing in it)
//   agent  → entries gone, facts stay   (detection replay — the real typed-launch seam)
//   gone   → entries return             (the agent's process-table exit verdict)
//   dead   → entries gone, menu lives   (`exit` kills the shell; Rename must survive)
//
// Hermetic: the installed CLI is a registry override (setAgentDetectOverrideForSmoke), the
// agent session is a replayed detection event (__mogging.agents.detected) — no real CLI, no
// network. Writes out/plainmenu-result.json, then exits (0=pass, 1=fail).
export function runPlainMenuSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 90000)
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
   *  facts-changed auto-close can never race the read. */
  interface MenuRead {
    opened: boolean
    launch: number
    rename: boolean
    agentNote: boolean
  }
  const readMenu = (paneId: number): Promise<MenuRead> =>
    ES<MenuRead>(`(() => {
      const button = document.querySelector('.layout-slot[data-pane-id="${paneId}"] [aria-label="Pane menu"]')
      if (!(button instanceof HTMLButtonElement)) return { opened: false, launch: -1, rename: false, agentNote: false }
      button.click()
      const menu = document.getElementById('pane-menu-${paneId}')
      const opened = !!menu && !menu.hidden
      const items = menu ? [...menu.querySelectorAll('.menu-item')].map(el => (el.textContent || '').trim()) : []
      const launch = items.filter(text => /^Launch .+ here$/.test(text)).length
      const rename = items.includes('Rename')
      const agentNote = !!menu && (menu.textContent || '').includes('Agent CLI:')
      button.click()
      return { opened, launch, rename, agentNote }
    })()`)

  /** Poll the menu until `want` holds (the agents feature repopulates commands and
   *  retires sessions asynchronously — a fixed sleep would be a guess). */
  const untilMenu = async (paneId: number, want: (m: MenuRead) => boolean, tries = 40): Promise<MenuRead> => {
    let last: MenuRead = { opened: false, launch: -1, rename: false, agentNote: false }
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
      const plain = await untilMenu(paneId, (m) => m.opened && m.launch >= 1)

      // ── agent: replay the backend's detection verdict — the entries retire, the
      //    Agent CLI fact appears (the menu still tells the truth about the pane) ─────
      await ES(`window.__mogging.agents.detected({ id: ${paneId}, agentId: 'codex', cwd: '', sinceMs: 5000 })`)
      const agent = await untilMenu(paneId, (m) => m.opened && m.launch === 0 && m.agentNote)

      // ── gone: the agent's exit verdict clears the session — the entries return ─────
      await ES(`window.__mogging.agents.detected({ id: ${paneId}, agentId: null })`)
      const gone = await untilMenu(paneId, (m) => m.opened && m.launch >= 1 && !m.agentNote)

      // ── dead: kill the shell itself; entries go, the menu (Rename) survives ────────
      // The write must land in a LIVE PTY (a still-spawning one drops it silently).
      let live = false
      for (let i = 0; i < 60 && !live; i++) {
        live = Boolean(await ES(`window.__mogging.agents.paneLive(${paneId})`))
        if (!live) await sleep(500)
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

      const pass =
        plain.opened && plain.launch >= 1 && plain.rename && !plain.agentNote &&
        agent.opened && agent.launch === 0 && agent.agentNote && agent.rename &&
        gone.opened && gone.launch >= 1 && !gone.agentNote &&
        live && exited &&
        dead.opened && dead.launch === 0 && dead.rename &&
        stillInstalled
      result = { pass, plain, agent, gone, dead, live, exited, stillInstalled }
    } catch (error) {
      result = { pass: false, error: String(error) }
    } finally {
      setAgentDetectOverrideForSmoke(null)
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'plainmenu-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(run, 1200))
  else setTimeout(run, 1200)
}
