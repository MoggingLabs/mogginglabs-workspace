import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'

// Two-phase provider-mix template smoke (MOGGING_TEMPLATE = A | B):
//   A: open a "2x shell + 1x claude" template -> assert the resolved grid (4 panes, 1 claude),
//      a new workspace opens, and the claude slot's pane becomes a self-authed TUI. Persist, quit.
//   B: relaunch -> assert the template workspace restored (2 workspaces, its assignments) and its
//      claude pane re-launched. Dev-only (uses the __mogging handle).
//
// The template workspace is the 2nd created -> ordinal 1 -> base pane id 100; the claude slot is
// assignments index 2 -> pane id 103.
const CLAUDE_PANE = 103

export function runTemplateSmoke(win: BrowserWindow, phase: string): void {
  setTimeout(() => app.exit(1), 70000) // safety net
  const wc = win.webContents
  const isA = phase.toUpperCase() === 'A'
  let done = false

  const ES = (js: string): Promise<unknown> => wc.executeJavaScript(js)
  const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const emit = (o: object): void => {
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'template-result.json'), JSON.stringify(o))
    } catch {
      /* best effort */
    }
  }
  const paneAlt = (id: number): Promise<boolean> =>
    ES(
      `(function(){var ps=(window.__mogging&&window.__mogging.panes)||[];var p=ps.find(function(x){return x.id===${id}});return !!(p&&p.term&&p.term.buffer.active.type==='alternate');})()`
    ) as Promise<boolean>

  const runA = async (): Promise<void> => {
    if (done) return
    done = true
    try {
      await delay(500)
      // Launcher-first boot: create the base workspace so the template workspace is the
      // 2nd created (ordinal 1 -> base pane id 100, keeping CLAUDE_PANE = 103).
      await ES(
        '(function(){var m=window.__mogging;' +
          'if(m&&m.workspace&&m.workspace.count()===0)m.workspace.create({name:"Workspace 1"});return 1;})()'
      )
      await delay(600)
      const resolved = (await ES(
        "window.__mogging.templates.open([{provider:'shell',count:2},{provider:'claude',count:1}])"
      )) as { paneCount: number; assignments: string[] }
      await delay(1200)
      const count = Number(await ES('window.__mogging.workspace.count()'))
      await delay(11000) // launchLineup delay (900ms) + claude render
      const claudeAlt = await paneAlt(CLAUDE_PANE)
      const oneClaude = Array.isArray(resolved?.assignments)
        ? resolved.assignments.filter((a) => a === 'claude').length === 1
        : false
      const pass = resolved?.paneCount === 4 && oneClaude && count === 2 && claudeAlt
      emit({ phase: 'A', pass, resolved, count, claudeAlt })
      app.exit(pass ? 0 : 1)
    } catch (e) {
      emit({ phase: 'A', pass: false, error: String(e) })
      app.exit(1)
    }
  }

  const runB = async (): Promise<void> => {
    if (done) return
    done = true
    try {
      for (let i = 0; i < 50 && Number(await ES('window.__mogging.workspace.count()')) < 2; i++) await delay(200)
      const count = Number(await ES('window.__mogging.workspace.count()'))
      const list = (await ES('window.__mogging.workspace.list()')) as Array<{
        assignments?: string[]
        paneCount: number
      }>
      const template = Array.isArray(list) ? list.find((w) => w.assignments && w.assignments.includes('claude')) : undefined
      await delay(11000) // wait for the resumed claude to render
      const claudeAlt = await paneAlt(CLAUDE_PANE)
      const pass = count === 2 && !!template && template.paneCount === 4 && claudeAlt
      emit({ phase: 'B', pass, count, restoredAssignments: template?.assignments, claudeAlt })
      app.exit(pass ? 0 : 1)
    } catch (e) {
      emit({ phase: 'B', pass: false, error: String(e) })
      app.exit(1)
    }
  }

  wc.once('did-finish-load', () => setTimeout(() => void (isA ? runA() : runB()), 3000))
}
