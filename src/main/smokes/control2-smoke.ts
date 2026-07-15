import { app, type BrowserWindow } from 'electron'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ControlChannels } from '@contracts'
import { sanitizeControl } from '../deep-link'

// Env-gated layout-control smoke (MOGGING_CONTROL2, Phase-3/02): drive the SAME
// validate-then-forward path the mogging:// relay uses — every command goes through
// sanitizeControl (main's closed-union gate) before it reaches the renderer — and
// assert real outcomes on the grid:
//   open  -> a workspace at that cwd with the requested pane count
//   expand-> the covered sibling actually hides; toggling restores it
//   focus -> the .layout-slot.focused ring moves
//   close -> the pane's terminal disposes and 3 panes reflow
// Plus the gate itself: hostile/invalid payloads sanitize to null and are dropped.
export function runControl2Smoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 90000) // safety net
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  const send = (raw: unknown): boolean => {
    const cmd = sanitizeControl(raw) // the exact main-side gate the relay uses
    if (!cmd) return false
    wc.send(ControlChannels.command, cmd)
    return true
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      const dir = mkdtempSync(join(tmpdir(), 'mogging-ctl2-'))
      await sleep(1200) // launcher-first boot settles (no workspace yet)

      // 1) open <dir> --panes 4 -> a 4-pane workspace at that cwd.
      send({ verb: 'open', cwd: dir, panes: 4 })
      let base = -1
      for (let i = 0; i < 50; i++) {
        const active = (await ES('window.__mogging.workspace.active()')) as {
          cwd: string
          ordinal: number
          paneCount: number
        } | null
        if (active && active.cwd === dir && active.paneCount === 4) {
          base = active.ordinal * 100
          break
        }
        await sleep(300)
      }
      const openOk = base >= 0 && Number(await ES('window.__mogging.layout.paneCount()')) === 4
      await sleep(2000) // panes spawn

      const visible = (id: number): Promise<boolean> =>
        ES<boolean>(
          `(()=>{const el=document.querySelector('.layout-slot[data-pane-id="${id}"]');` +
            `return !!el && getComputedStyle(el).display !== 'none';})()`
        )

      // 2) expand col on pane base+1 -> base+3 (below it) hides; toggle restores.
      send({ verb: 'expand', paneId: base + 1, mode: 'col' })
      await sleep(400)
      const expandHid = !(await visible(base + 3)) && (await visible(base + 2))
      send({ verb: 'expand', paneId: base + 1, mode: 'col' })
      await sleep(400)
      const expandRestored = await visible(base + 3)

      // 3) focus base+2 -> the orange ring moves.
      send({ verb: 'focus', paneId: base + 2 })
      await sleep(300)
      const focused = String(
        await ES(
          `(()=>{const el=document.querySelector('.layout-slot.focused');return el?el.getAttribute('data-pane-id'):''})()`
        )
      )
      const focusOk = focused === String(base + 2)

      // 4) close-pane base+2 -> 3 panes remain, its slot is gone.
      send({ verb: 'close-pane', paneId: base + 2 })
      await sleep(900)
      const paneCount = Number(await ES('window.__mogging.layout.paneCount()'))
      const ids = (await ES('window.__mogging.layout.paneIds()')) as number[]
      const closeOk =
        paneCount === 3 && Array.isArray(ids) && !ids.includes(base + 2) && !(await visible(base + 2))

      // 5) the gate: garbage never leaves main.
      const gateOk =
        !send({ verb: 'nuke-it-all' }) &&
        !send({ verb: 'layout', panes: 99 }) &&
        !send({ verb: 'expand', paneId: base + 1, mode: '<script>' }) &&
        !send({ verb: 'open' }) && // open without cwd
        !send('not-an-object')

      const pass = openOk && expandHid && expandRestored && focusOk && closeOk && gateOk
      result = { pass, openOk, expandHid, expandRestored, focusOk, closeOk, gateOk, base, paneCount, ids }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'control2-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(run, 2500))
  else setTimeout(run, 2500)
}
