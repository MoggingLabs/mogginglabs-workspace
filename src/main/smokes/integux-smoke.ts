import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { McpConnStatus } from '@contracts'
import { detectAuthNags } from '@backend/features/integrations'
import { mgrPreview } from '../mcp-manager'

// Env-gated integrations-UX smoke (MOGGING_INTEGUX, Phase-8/13). Drives the
// real UI + checks the pure logic: the guided flow (walk/skip/resume/end), the
// needs-auth single-fire, palette verbs, empty states + privacy block, and the
// plain diff summary naming the writer's actual target. Zero network.

export function runIntegUxSmoke(win: BrowserWindow): void {
  // 180s (not 90s): CI cold-boot (electron-vite dev compile + launch) can eat
  // most of a tight net before run() even completes — the old 90s tripped
  // app.exit(1) MID-run on every CI OS while passing on fast local machines.
  // qa-smokes still watches at 240s.
  setTimeout(() => app.exit(1), 180000)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const waitTrue = async (js: string, tries = 20, gapMs = 250): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      if (await ES<boolean>(js).catch(() => false)) return true
      await sleep(gapMs)
    }
    return false
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      // ── (b) needs-auth single-fire logic (the 7/09 transition discipline) ──
      const S = (state: McpConnStatus['state']): McpConnStatus[] => [{ serverId: 'sentry', cli: 'claude-code', state, checkedAt: 0 }]
      const nag = detectAuthNags(S('connected'), S('needs-auth'))
      const stay = detectAuthNags(S('needs-auth'), S('needs-auth'))
      const repair = detectAuthNags(S('needs-auth'), S('connected'))
      const nagOk = nag.nags.length === 1 && nag.repairs.length === 0 && stay.nags.length === 0 && repair.repairs.length === 1 && repair.nags.length === 0

      // ── (e) the plain diff summary names the CLI + scope (writer data) ──────
      const prev = mgrPreview('mogging', 'claude-code', 'apply')
      const summaryOk = prev?.summary === 'Adds MoggingLabs to Claude Code — all workspaces'

      await sleep(1500)
      await ES('window.__mogging.workspace.create({ name: "Alpha" })')
      await sleep(1200)
      // Open Settings › Integrations.
      await ES(`(document.querySelector('.titlebar-right .icon-btn[aria-label="Settings"]')?.click(), 1)`)
      await sleep(500)
      await ES(`(document.querySelector('.settings-nav-item[data-target="integrations"]')?.click(), 1)`)
      await sleep(400)

      // ── (d)(f) empty states + intro CTA + privacy block render ─────────────
      const introOk = await waitTrue(`!!document.querySelector('.integux-intro .integux-setup-cta')`)
      const privacyOk = await waitTrue(`!!document.querySelector('.integux-privacy')`)
      // The registry list renders async — poll (Linux caught it mid-render once).
      const serversEmptyOk = await waitTrue(`!!document.querySelector('.integux-empty')`)
      // `matrixEmptyOk` was computed, reported, and then left OUT of `pass` — it has
      // been false every run, because the tool-plan matrix never rendered: its block
      // read the workspace list once, at boot, before any workspace existed (8.5/05
      // fixed this; see SyncedBlock in integrations.ts). Now that it renders, assert it.
      const matrixEmptyOk = await waitTrue(`!!document.querySelector('.toolplan-empty')`)
      const emptyOk = serversEmptyOk && matrixEmptyOk

      // ── (c) palette verbs are reachable ────────────────────────────────────
      await ES(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true,cancelable:true}))`)
      await sleep(300)
      await ES(`(()=>{const i=document.querySelector('.palette-overlay input,.palette input');if(i){i.value='integrations';i.dispatchEvent(new Event('input',{bubbles:true}))}})()`)
      // Bug #13: `.palette-result` is emitted NOWHERE in src/ui — the palette renders
      // `.palette-item` only. Half of this selector was dead, and REMOVE #2/#3's safety
      // argument ("≥2 matches survive") rested on it. Four `integrations:*` verbs remain,
      // each carrying the hint 'Integrations', so the real assertion still has headroom.
      const paletteOk = await waitTrue(`[...document.querySelectorAll('.palette-item')].filter(e=>/integrations/i.test(e.textContent||'')).length >= 2`)
      await ES(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`)
      await sleep(200)

      // ── (a) the guided flow — TWO honest environments ──────────────────────
      // The flow only walks tools when a coding-agent CLI is installed; on a
      // CLI-less machine (fresh installs, CI runners) it correctly shows the
      // "install a CLI first" prompt (integrations.ts openGuidedFlow). Detect
      // which environment we're in and assert the RIGHT branch — the flow is
      // detection-honest (the 6/01 lesson), and so is its smoke.
      const hasCli = await ES<boolean>(
        `(async()=>{const a=await window.bridge.invoke('agents:detect');return (a||[]).some(x=>x.installed)})()`
      ).catch(() => false)
      await ES(`localStorage.removeItem('mogging.integux.done')`)
      await ES(`(document.querySelector('.integux-intro .integux-setup-cta')?.click(), 1)`)
      let walkOk = false
      let endOk = false
      let firstPreset = ''
      let secondPreset = ''
      let progressLen = 0
      if (hasCli) {
        const flowShown = await waitTrue(`!!document.querySelector('.modal-overlay .integux-flow .integux-flow-tool')`)
        const curPreset = (): Promise<string> => ES<string>(`document.querySelector('.integux-flow-tool')?.getAttribute('data-preset') || ''`)
        const clickSkip = (): Promise<unknown> =>
          ES(`[...document.querySelectorAll('.modal-overlay .btn')].find(b=>/^Skip$/.test(b.textContent?.trim()||''))?.click()`)
        firstPreset = await curPreset()
        // Skip the current tool -> advances + records progress. The re-render is
        // async; POLL until the tool actually changes (CI is slower than local).
        await clickSkip()
        secondPreset = firstPreset
        for (let i = 0; i < 24 && secondPreset === firstPreset; i++) {
          await sleep(250)
          secondPreset = await curPreset()
        }
        await clickSkip()
        for (let i = 0; i < 24 && progressLen < 2; i++) {
          await sleep(250)
          progressLen = await ES<number>(`(JSON.parse(localStorage.getItem('mogging.integux.done')||'[]')).length`)
        }
        walkOk = flowShown && !!firstPreset && !!secondPreset && firstPreset !== secondPreset && progressLen === 2

        // Resume + end screen: mark every preset done, reopen -> plan reminder.
        await ES(`(async()=>{const {presets}=await window.bridge.invoke('integrations:cat:list');localStorage.setItem('mogging.integux.done',JSON.stringify(presets.map(p=>p.id)))})()`)
        await sleep(300)
        await ES(`document.querySelector('.modal-overlay .modal-close')?.click()`)
        await sleep(200)
        await ES(`(document.querySelector('.integux-intro .integux-setup-cta')?.click(), 1)`)
        endOk = await waitTrue(`!!document.querySelector('.modal-overlay .integux-flow-done')`)
      } else {
        // No CLI: the flow honestly says install one first — that IS the
        // correct guided-flow terminal for this machine. Both walk + end assert
        // that one true state (no tool card renders without a CLI to wire to).
        const installPrompt = await waitTrue(
          `/install a coding-agent cli/i.test(document.querySelector('.modal-overlay .integux-flow')?.textContent||'')`
        )
        const noToolCard = await ES<boolean>(`!document.querySelector('.modal-overlay .integux-flow .integux-flow-tool')`)
        walkOk = installPrompt && noToolCard
        endOk = installPrompt
      }

      const pass = nagOk && summaryOk && introOk && privacyOk && emptyOk && paletteOk && walkOk && endOk
      result = { pass, nagOk, summaryOk, introOk, privacyOk, emptyOk, serversEmptyOk, matrixEmptyOk, paletteOk, walkOk, endOk, firstPreset, secondPreset, progressLen }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'integux-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 2500))
  else setTimeout(() => void run(), 2500)
}
