import { app, type BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { saveServer, type GrantKv } from '@backend/features/integrations'
import { driftStatsForSmoke } from '../connections'
import { mgrApply, mgrBackups, scanCliDrift } from '../mcp-manager'
import { refreshStatus } from '../mcp-status'
import { getSettingsStore } from '../app-settings'

// Env-gated LIVE reconciler smoke (MOGGING_TOOLFIX, phase-tools/06). The gate-isolation
// laws are BINDING here: index.dev.ts sandboxes the WHOLE CLI home into the isolated
// userData (MOGGING_SMOKE_CLI_HOME, honored only alongside MOGGING_USERDATA), because
// this gate hand-edits and rewrites CLI configs — never the real user's files.
//
//   (a) HAND-EDIT  — the marked block edited out-of-band: the accelerated heartbeat
//       classifies it, the card reads Needs attention, the detail shows the
//       user-words sentence + the diff preview, Fix re-applies BYTE-IDENTICALLY,
//       and a backup lands first.
//   (b) DELETE     — the block removed: Fix restores it.
//   (c) KEEP MY EDIT — adopts: config bytes untouched, status healthy.
//   (d) NO UNCLICKED WRITE — with drift present across two beats, the config mtime
//       never moves until Fix is clicked (the surgical-writes-on-your-click law).
//   (e) CODEX      — a codex-config drift raises NOTHING: detected backend-side,
//       surfaced nowhere the user cannot act (Claude Code only this phase).
//
// MUTATION-RED ×2, proven LIVE on every pass:
//   · MOGGING_FIX_BREAK_CLASSIFIER — a blinded classifier never raises (a)'s alarm;
//   · MOGGING_FIX_BREAK_CLICKGUARD — an auto-applying reconciler moves the mtime
//     with no click, exactly what (d)'s assert catches.

export function runToolFixSmoke(win: BrowserWindow): void {
  const safety = setTimeout(() => app.exit(1), 220000)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const waitFor = async (test: () => boolean, tries = 24, gap = 400): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      if (test()) return true
      await sleep(gap)
    }
    return test()
  }
  const waitTrue = async (js: string, tries = 24, gap = 350): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      if (await ES<boolean>(js).catch(() => false)) return true
      await sleep(gap)
    }
    return false
  }

  let result: Record<string, unknown> = { pass: false }

  const run = async (): Promise<void> => {
    try {
      const sandbox = process.env.MOGGING_SMOKE_CLI_HOME
      if (!sandbox) throw new Error('MOGGING_SMOKE_CLI_HOME not set — the isolation law would be violated')
      mkdirSync(sandbox, { recursive: true })
      const claudeCfg = join(sandbox, '.claude.json')
      const store = getSettingsStore()
      if (!store) throw new Error('settings store not ready')
      const kv: GrantKv = { get: (k) => store.getSetting(k), set: (k, v) => store.setSetting(k, v) }

      // ── Setup: one tool set up on Claude Code, one on Codex — sandbox only ──
      for (const id of ['fix-tool', 'codex-tool']) {
        const saved = saveServer(kv, { id, label: id, transport: 'http', url: `https://example.invalid/${id}` })
        if (!saved.ok) throw new Error(`saveServer ${id} refused: ${saved.reason}`)
      }
      const applied = mgrApply('fix-tool', 'claude-code')
      if (!applied.ok) throw new Error(`mgrApply refused: ${applied.reason}`)
      const appliedCodex = mgrApply('codex-tool', 'codex')
      if (!appliedCodex.ok) throw new Error(`mgrApply codex refused: ${appliedCodex.reason}`)
      const healthyBytes = readFileSync(claudeCfg, 'utf8')
      const sandboxOnlyOk = claudeCfg.includes(sandbox) && existsSync(join(sandbox, '.codex', 'config.toml'))

      // ── (a)+(d) hand-edit → classified by the heartbeat, no write until Fix ──
      // SURGICAL edit (a value swap in place): Fix's write is surgical too — it
      // touches only the marked entry — so byte-identity is a fair claim only when
      // the rest of the file kept its own bytes.
      writeFileSync(claudeCfg, healthyBytes.replace('https://example.invalid/fix-tool', 'https://example.invalid/EDITED'))
      const mtimePlanted = statSync(claudeCfg).mtimeMs
      const raisedOk = await waitFor(() => driftStatsForSmoke().includes('fix-tool'))
      await sleep(2600) // two more accelerated beats with drift present…
      const noUnclickedWriteOk = statSync(claudeCfg).mtimeMs === mtimePlanted
      // …then onto the real page.
      refreshStatus()
      await sleep(2500)
      await ES(`(document.querySelector('.titlebar-right .icon-btn[aria-label="Settings"]')?.click(), 1)`)
      await sleep(500)
      await ES(`(document.querySelector('.settings-nav-item[data-target="integrations"]')?.click(), 1)`)
      await sleep(1200)
      const cardAttentionOk = await waitTrue(
        `(document.querySelector('.conn-card[data-connection="fix-tool"] .conn-chip')?.textContent ?? '') === 'Needs attention'`
      )
      const sentenceEditedOk = await waitTrue(
        `(document.querySelector('.conn-card[data-connection="fix-tool"] .conn-fix-sentence')?.textContent ?? '') === 'Claude Code’s config for this tool was edited by hand.'`
      )
      await ES(`(document.querySelector('.conn-card[data-connection="fix-tool"] .conn-fix-open')?.click(), 1)`)
      const previewOk = await waitTrue(`(() => {
        const card = document.querySelector('.conn-card[data-connection="fix-tool"]')
        const title = card?.querySelector('.conn-fix-preview-title')?.textContent
        const block = card?.querySelector('.conn-fix-preview')?.textContent ?? ''
        return title === 'What Fix will change' && block.includes('fix-tool')
      })()`)
      const backupsBefore = mgrBackups('claude-code').length
      await ES(`(document.querySelector('.conn-card[data-connection="fix-tool"] .conn-fix-now')?.click(), 1)`)
      const fixedOk = await waitFor(() => existsSync(claudeCfg) && readFileSync(claudeCfg, 'utf8') === healthyBytes)
      const backupOk = mgrBackups('claude-code').length > backupsBefore
      const clearedOk = await waitFor(() => !driftStatsForSmoke().includes('fix-tool'))

      // ── (b) delete the block → Fix restores it ───────────────────────────────
      const gutted = JSON.parse(healthyBytes) as { mcpServers: Record<string, unknown> }
      delete gutted.mcpServers['fix-tool']
      writeFileSync(claudeCfg, JSON.stringify(gutted, null, 2))
      const missingRaised = await waitFor(() => driftStatsForSmoke().includes('fix-tool'))
      refreshStatus()
      await sleep(2500)
      const sentenceMissingOk = await waitTrue(
        `(document.querySelector('.conn-card[data-connection="fix-tool"] .conn-fix-sentence')?.textContent ?? '') === 'Claude Code’s config for this tool was removed outside the app.'`
      )
      await ES(`(document.querySelector('.conn-card[data-connection="fix-tool"] .conn-fix-open')?.click(), 1)`)
      await sleep(700)
      await ES(`(document.querySelector('.conn-card[data-connection="fix-tool"] .conn-fix-now')?.click(), 1)`)
      // The delete plant re-serialized the file, so whole-file byte identity is not
      // the fair claim here — ENTRY identity is: the restored marked entry must equal
      // the healthy one exactly, and the classifier must read it healthy again.
      const healthyEntry = JSON.stringify((JSON.parse(healthyBytes) as { mcpServers: Record<string, unknown> }).mcpServers['fix-tool'])
      const restoredOk = await waitFor(() => {
        try {
          const now = JSON.parse(readFileSync(claudeCfg, 'utf8')) as { mcpServers?: Record<string, unknown> }
          return JSON.stringify(now.mcpServers?.['fix-tool']) === healthyEntry && scanCliDrift().every((d) => d.id !== 'fix-tool')
        } catch {
          return false
        }
      })

      // ── (c) keep my edit: adopt — config bytes untouched, status healthy ─────
      const edited2 = JSON.parse(healthyBytes) as { mcpServers: Record<string, { url?: string }> }
      edited2.mcpServers['fix-tool'].url = 'https://example.invalid/KEPT'
      const keptBytes = JSON.stringify(edited2, null, 2)
      writeFileSync(claudeCfg, keptBytes)
      await waitFor(() => driftStatsForSmoke().includes('fix-tool'))
      refreshStatus()
      await sleep(2500)
      const secondaryOk = await waitTrue(
        `(document.querySelector('.conn-card[data-connection="fix-tool"] .conn-fix-sentence')?.textContent ?? '').includes('edited by hand')`
      )
      await ES(`(document.querySelector('.conn-card[data-connection="fix-tool"] .conn-fix-open')?.click(), 1)`)
      const keepBtnOk = await waitTrue(
        `(document.querySelector('.conn-card[data-connection="fix-tool"] .conn-fix-secondary')?.textContent ?? '') === 'Keep my edit'`
      )
      await ES(`(document.querySelector('.conn-card[data-connection="fix-tool"] .conn-fix-secondary')?.click(), 1)`)
      const adoptedHealthy = await waitFor(() => !driftStatsForSmoke().includes('fix-tool') && scanCliDrift().every((d) => d.id !== 'fix-tool'))
      const adoptedUntouched = readFileSync(claudeCfg, 'utf8') === keptBytes

      // ── (e) codex drift raises NOTHING ───────────────────────────────────────
      const codexCfgPath = join(sandbox, '.codex', 'config.toml')
      const codexCfg = readFileSync(codexCfgPath, 'utf8')
      writeFileSync(codexCfgPath, codexCfg.replace('https://example.invalid/codex-tool', 'https://example.invalid/EDITED'))
      await sleep(3000) // two beats with the codex drift present
      const codexQuietOk = !driftStatsForSmoke().includes('codex-tool')

      // ── MUTATION-RED 1: a blinded classifier never raises (a)'s alarm ────────
      const edited3 = JSON.parse(keptBytes) as { mcpServers: Record<string, { url?: string }> }
      edited3.mcpServers['fix-tool'].url = 'https://example.invalid/EDITED-AGAIN'
      process.env.MOGGING_FIX_BREAK_CLASSIFIER = '1'
      writeFileSync(claudeCfg, JSON.stringify(edited3, null, 2))
      await sleep(3000)
      const mutationClassifierRed = !driftStatsForSmoke().includes('fix-tool')
      delete process.env.MOGGING_FIX_BREAK_CLASSIFIER
      const raisesAgain = await waitFor(() => driftStatsForSmoke().includes('fix-tool'))

      // ── MUTATION-RED 2: an auto-applying reconciler moves the mtime unclicked ─
      const mtimeBefore = statSync(claudeCfg).mtimeMs
      process.env.MOGGING_FIX_BREAK_CLICKGUARD = '1'
      const mutationClickguardRed = await waitFor(() => statSync(claudeCfg).mtimeMs !== mtimeBefore)
      delete process.env.MOGGING_FIX_BREAK_CLICKGUARD

      result = {
        pass:
          sandboxOnlyOk &&
          raisedOk &&
          noUnclickedWriteOk &&
          cardAttentionOk &&
          sentenceEditedOk &&
          previewOk &&
          fixedOk &&
          backupOk &&
          clearedOk &&
          missingRaised &&
          sentenceMissingOk &&
          restoredOk &&
          secondaryOk &&
          keepBtnOk &&
          adoptedHealthy &&
          adoptedUntouched &&
          codexQuietOk &&
          mutationClassifierRed &&
          raisesAgain &&
          mutationClickguardRed,
        sandboxOnlyOk,
        raisedOk,
        noUnclickedWriteOk,
        cardAttentionOk,
        sentenceEditedOk,
        previewOk,
        fixedOk,
        backupOk,
        clearedOk,
        missingRaised,
        sentenceMissingOk,
        restoredOk,
        secondaryOk,
        keepBtnOk,
        adoptedHealthy,
        adoptedUntouched,
        codexQuietOk,
        mutationClassifierRed,
        raisesAgain,
        mutationClickguardRed
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'toolfix-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    clearTimeout(safety)
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}
