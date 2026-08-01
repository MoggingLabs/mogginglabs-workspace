import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AgentChannels, type AgentInfo, type AgentInstallState } from '@contracts'
import { setAgentDetectOverrideForSmoke } from '../agents'

// Audit regression gate for P1/20. Availability flips through the same terminal
// install-state push used by a real install/uninstall, then every launch surface
// must reflect the shared registry without a renderer or app restart.
export function runAgentRegistrySmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 90000)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  const agent = (installed: boolean): AgentInfo => ({
    id: 'codex',
    name: 'Audit Codex',
    installed,
    installHint: 'npm install -g @openai/codex'
  })
  const publish = async (installed: boolean): Promise<void> => {
    setAgentDetectOverrideForSmoke([agent(installed)])
    const state: AgentInstallState = {
      agentId: 'codex',
      phase: installed ? 'succeeded' : 'failed',
      tail: '',
      exitCode: installed ? 0 : 1,
      startedAt: Date.now() - 10,
      endedAt: Date.now()
    }
    wc.send(AgentChannels.installChanged, state)
    await sleep(700)
  }

  const inspectSurfaces = async (installed: boolean, cardId: string, paneId: number): Promise<Record<string, boolean>> => {
    await ES(`window.__mogging.view('grid')`)
    await ES(`document.querySelector('.palette-trigger')?.click()`)
    await sleep(80)
    const palette = await ES<boolean>(`(() => {
      const input = document.querySelector('.palette-input')
      if (!(input instanceof HTMLInputElement)) return false
      input.value = 'Audit Codex'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return document.querySelector('.palette-list')?.textContent?.includes('Launch Audit Codex') === ${installed}
    })()`)
    await ES(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)

    const paneMenu = await ES<boolean>(`(() => {
      const button = document.querySelector('.layout-slot[data-pane-id="${paneId}"] [aria-label="Pane menu"]')
      if (!(button instanceof HTMLButtonElement)) return false
      button.click()
      const menu = document.querySelector('#pane-menu-${paneId}')
      const agrees = menu?.textContent?.includes('Launch Audit Codex here') === ${installed}
      button.click()
      return agrees
    })()`)

    await ES(`window.__mogging.view('board')`)
    await sleep(350)
    const board = await ES<boolean>(`(() => {
      const card = document.querySelector('.board-card[data-card-id="${cardId}"]')
      const button = card?.querySelector('.board-card-more')
      if (!(button instanceof HTMLButtonElement)) return false
      button.click()
      // The menu is portaled to <body> by the shared primitive now — it is no longer a
      // descendant of the card, and it closes on an outside pointerdown rather than a second
      // click on the trigger (finding 31).
      const agrees = document.querySelector('.ctx-menu')?.textContent?.includes('Start Audit Codex on this') === ${installed}
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      return agrees
    })()`)

    await ES(`window.__mogging.templates.openWizard()`)
    await sleep(350)
    const wizard = await ES<boolean>(`(() => {
      // Design pass 2 (2026-08-01): ONE palette row for every agent. Installed = a brush
      // chip (armable, data-chip). Missing = a grayed .is-missing chip whose end slot
      // carries the icon-only install. The registry flip must move the provider between
      // those two grades — both asserted, each in both directions.
      const brush = document.querySelector('#view-wizard .wizard-chip[data-chip="codex"]')
      const missing = [...document.querySelectorAll('#view-wizard .wizard-chip-wrap.is-missing')]
        .find((item) => item.textContent?.includes('Audit Codex'))
      const installGlyph = !!missing?.querySelector('.agent-setup-iconbtn')
      return !!brush === ${installed} && !!missing === ${!installed} && (${installed} || installGlyph)
    })()`)

    await ES(`window.__mogging.view('settings'); window.__mogging.settingsTab('providers')`)
    await sleep(350)
    const settings = await ES<boolean>(`(() => {
      // No resting status pill since the redundancy pass (2026-08-01): an installed row
      // states its presence through the version sub-line, a missing one through its
      // Install button — each asserted in BOTH directions so neither can linger.
      const row = document.querySelector('.prov-item[data-provider="codex"]')
      if (!row) return false
      const detected = row.textContent?.includes('Detected on PATH') === true
      const install = !!row.querySelector('.agent-setup-action .btn')
      return detected === ${installed} && install === ${!installed}
    })()`)
    return { palette, paneMenu, board, wizard, settings }
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      await sleep(1500)
      await ES(`window.__mogging.workspace.create({ name: 'Registry', cwd: ${JSON.stringify(process.cwd())} })`)
      await sleep(900)
      const active = (await ES(`window.__mogging.workspace.active()`)) as { ordinal: number }
      const paneId = active.ordinal * 100 + 1
      const cardId = String(await ES(`window.__mogging.board.createCard('Registry card')`))

      await publish(false)
      const missing = await inspectSurfaces(false, cardId, paneId)
      await publish(true)
      const installed = await inspectSurfaces(true, cardId, paneId)
      await publish(false)
      const uninstalled = await inspectSurfaces(false, cardId, paneId)
      const all = (value: Record<string, boolean>): boolean => Object.values(value).every(Boolean)
      const pass = all(missing) && all(installed) && all(uninstalled)
      result = { pass, missing, installed, uninstalled }
    } catch (error) {
      result = { pass: false, error: String(error) }
    } finally {
      setAgentDetectOverrideForSmoke(null)
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'agentregistry-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(run, 1200))
  else setTimeout(run, 1200)
}
