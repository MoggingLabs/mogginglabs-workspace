import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IntegrationsChannels, planHasServerForCli, type WorkspaceToolPlan, type McpServerEntry } from '@contracts'

/**
 * Env-gated Library smoke (MOGGING_LIBRARYUX — the store/inventory split, 2026-07-18).
 *
 * The split's promises, each asserted where it can actually rot:
 *   (w) WIZARD MOMENT-OF-NEED — the Agent-tools section renders with ZERO servers
 *       and offers the Library; opening it is an OVERLAY (the view class stays
 *       `view-wizard`, the half-configured folder survives). A regression that
 *       turns the Library into a navigation loses the wizard — this goes red.
 *   (l) THE LIBRARY IS THE WHOLE STORE — services grid WITH the Available group,
 *       the per-CLI catalog (≥20 preset cards), and the registry/import corner,
 *       all inside `.library-modal`.
 *   (i) THE INVENTORY DOES NOT BROWSE — Settings § Integrations renders NO
 *       Available group; at zero connections the empty state's one exit opens
 *       the Library. (The 40-idle-cards regression, pinned.)
 *   (d) CHIPS MUTATE PLANS — the workspace card's primary chip writes the plan
 *       for ALL CLIs (read back via planGet, never inferred from the DOM), and
 *       a second click clears it.
 *   (k) KEY SLOTS VAULT IN PLACE — a `${VAR}` slot on the server row takes a
 *       paste, the vault gains the name, the row flips to saved, and the
 *       registry entry STILL carries the reference — the literal lands nowhere
 *       (asserted against the whole serversList payload).
 *   (r) ROUTE BADGES TELL THE TRUTH — built-in reads house, a plain command
 *       reads CLI-owned, a bridge command (mogging-connection) reads app-held.
 */
export function runLibraryUxSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 200000) // safety net
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const waitTrue = async (js: string, tries = 24, gap = 250): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      if (await ES<boolean>(js).catch(() => false)) return true
      await sleep(gap)
    }
    return false
  }
  const invoke = <T>(channel: string, payload?: unknown): Promise<T> =>
    ES<T>(`window.bridge.invoke(${JSON.stringify(channel)}, ${payload === undefined ? 'undefined' : JSON.stringify(payload)})`)

  const openSettings = async (tab = 'integrations'): Promise<void> => {
    await ES(`(document.querySelector('.titlebar-right .icon-btn[aria-label="Settings"]')?.click(), 1)`)
    await sleep(400)
    await ES(`(document.querySelector('.settings-nav-item[data-target="${tab}"]')?.click(), 1)`)
    await sleep(400)
  }
  // serversSave does not push a repaint; a tab round-trip re-runs every sync.
  const resyncIntegrations = async (): Promise<void> => {
    await ES(`(document.querySelector('.settings-nav-item[data-target="profiles"]')?.click(), 1)`)
    await sleep(300)
    await ES(`(document.querySelector('.settings-nav-item[data-target="integrations"]')?.click(), 1)`)
    await sleep(700)
  }
  const closeLibrary = async (): Promise<void> => {
    await ES(`(document.querySelector('.library-modal .modal-close')?.click(), 1)`)
    await sleep(400)
  }

  let result: Record<string, unknown> = { pass: false }

  const run = async (): Promise<void> => {
    try {
      await sleep(1500)

      // ── (w) the wizard's moment of need, with ZERO servers registered ───────
      await ES(`window.__mogging.templates.openWizard()`)
      const wizardUp = await waitTrue(`!!document.querySelector('#view-wizard .wizard-tools')`)
      const wizardEmptyOffer = await waitTrue(`(() => {
        const host = document.querySelector('#view-wizard .wizard-tools')
        if (!host) return false
        return !!host.querySelector('.wizard-tools-empty') &&
          [...host.querySelectorAll('button')].some((b) => /Browse the Library/.test(b.textContent || ''))
      })()`)
      // Overlay, not navigation: the view class must stay wizard while the
      // Library is open, and the folder bar must hold its value across the trip.
      const pathBefore = await ES<string>(`document.querySelector('#view-wizard .path-input-field')?.value || ''`)
      await ES(`(() => {
        const host = document.querySelector('#view-wizard .wizard-tools')
        const b = [...(host?.querySelectorAll('button') ?? [])].find((x) => /Browse the Library/.test(x.textContent || ''))
        b?.click()
      })()`)
      const libraryOverWizard = await waitTrue(`!!document.querySelector('.library-modal .conn-grid')`)
      const stillWizardView = await ES<boolean>(`document.querySelector('#app')?.classList.contains('view-wizard') === true`)

      // ── (l) the Library is the whole store ──────────────────────────────────
      const availableGroup = await waitTrue(
        `[...document.querySelectorAll('.library-modal .conn-group-label')].some((e) => (e.textContent || '').startsWith('Available'))`
      )
      const catalogCards = await waitTrue(`document.querySelectorAll('.library-modal .cat-grid .cat-card').length >= 20`, 40, 250)
      const registryCorner = await ES<boolean>(`!!document.querySelector('.library-modal .cat-registry')`)
      await closeLibrary()
      const pathAfter = await ES<string>(`document.querySelector('#view-wizard .path-input-field')?.value || ''`)
      const wizardSurvived = pathBefore !== '' && pathBefore === pathAfter

      // A real workspace for the scoping stages (leaves the wizard behind).
      await ES(`window.__mogging.workspace.create({ name: "Alpha" })`)
      await sleep(1000)
      const wsId = (await ES<{ id: string }>(`window.__mogging.workspace.active()`)).id

      // ── (i) the inventory does not browse ───────────────────────────────────
      await openSettings()
      const bandCta = await waitTrue(`!!document.querySelector('.integux-intro .integux-library-cta')`)
      const noAvailableInSettings = await ES<boolean>(
        `![...document.querySelectorAll('#view-settings .integrations-section .conn-group-label')].some((e) => (e.textContent || '').startsWith('Available'))`
      )
      const inventoryEmpty = await waitTrue(`!!document.querySelector('#view-settings .conn-inventory-empty')`)
      await ES(`(() => {
        const host = document.querySelector('#view-settings .conn-inventory-empty')
        const b = [...(host?.querySelectorAll('button') ?? [])].find((x) => /Browse the Library/.test(x.textContent || ''))
        b?.click()
      })()`)
      const emptyStateOpensLibrary = await waitTrue(`!!document.querySelector('.library-modal .conn-grid')`)
      await closeLibrary()

      // ── (d) chips mutate plans, atomically across CLIs ──────────────────────
      const savedTool = await invoke<{ ok: boolean; reason?: string }>(IntegrationsChannels.serversSave, {
        id: 'libx-tool',
        label: 'LibX Tool',
        transport: 'stdio',
        command: 'node',
        args: ['libx.mjs']
      })
      await resyncIntegrations()
      const chipShown = await waitTrue(
        `[...document.querySelectorAll('#view-settings .wstool-chips .wstool-chip')].some((c) => (c.textContent || '').includes('LibX Tool'))`
      )
      await ES(`(() => {
        const c = [...document.querySelectorAll('#view-settings .wstool-chips .wstool-chip')].find((x) => (x.textContent || '').includes('LibX Tool'))
        c?.click()
      })()`)
      let planOn = false
      for (let i = 0; i < 20 && !planOn; i++) {
        const plan = await invoke<WorkspaceToolPlan>(IntegrationsChannels.planGet, wsId)
        planOn =
          planHasServerForCli(plan, 'libx-tool', 'claude-code') &&
          planHasServerForCli(plan, 'libx-tool', 'codex') &&
          planHasServerForCli(plan, 'libx-tool', 'gemini')
        if (!planOn) await sleep(250)
      }
      // Second click clears every CLI — the chip repainted as is-on by now.
      await waitTrue(
        `[...document.querySelectorAll('#view-settings .wstool-chips .wstool-chip')].some((c) => (c.textContent || '').includes('LibX Tool') && c.classList.contains('is-on'))`
      )
      await ES(`(() => {
        const c = [...document.querySelectorAll('#view-settings .wstool-chips .wstool-chip')].find((x) => (x.textContent || '').includes('LibX Tool'))
        c?.click()
      })()`)
      let planOff = false
      for (let i = 0; i < 20 && !planOff; i++) {
        const plan = await invoke<WorkspaceToolPlan>(IntegrationsChannels.planGet, wsId)
        planOff =
          !planHasServerForCli(plan, 'libx-tool', 'claude-code') &&
          !planHasServerForCli(plan, 'libx-tool', 'codex') &&
          !planHasServerForCli(plan, 'libx-tool', 'gemini')
        if (!planOff) await sleep(250)
      }

      // ── (k) key slots vault in place; the literal lands nowhere ─────────────
      const savedKeyed = await invoke<{ ok: boolean; reason?: string }>(IntegrationsChannels.serversSave, {
        id: 'libx-keyed',
        label: 'LibX Keyed',
        transport: 'stdio',
        command: 'node',
        args: ['k.mjs'],
        env: { LIBX_KEY: '${LIBX_KEY}' }
      })
      await resyncIntegrations()
      const slotMissing = await waitTrue(
        `[...document.querySelectorAll('#view-settings .mgr-keyslot.is-missing')].some((c) => (c.textContent || '').includes('LIBX_KEY'))`
      )
      await ES(`(() => {
        const c = [...document.querySelectorAll('#view-settings .mgr-keyslot.is-missing')].find((x) => (x.textContent || '').includes('LIBX_KEY'))
        c?.click()
      })()`)
      const slotFormUp = await waitTrue(`!!document.querySelector('#view-settings .mgr-keyslot-form-host input')`)
      await ES(`(() => {
        const i = document.querySelector('#view-settings .mgr-keyslot-form-host input')
        if (i) i.value = 'libx-secret-9f3'
        const save = [...document.querySelectorAll('#view-settings .mgr-keyslot-form-host button')].find((b) => /Save to vault/.test(b.textContent || ''))
        save?.click()
      })()`)
      let vaulted = false
      for (let i = 0; i < 24 && !vaulted; i++) {
        const names = (await invoke<string[]>(IntegrationsChannels.serviceKeyList)) ?? []
        vaulted = names.includes('LIBX_KEY')
        if (!vaulted) await sleep(250)
      }
      const slotSaved = await waitTrue(
        `[...document.querySelectorAll('#view-settings .mgr-keyslot.is-saved')].some((c) => (c.textContent || '').includes('LIBX_KEY'))`
      )
      const servers = (await invoke<McpServerEntry[]>(IntegrationsChannels.serversList)) ?? []
      const keyedEntry = servers.find((s) => s.id === 'libx-keyed')
      const custodyKept =
        keyedEntry?.env?.LIBX_KEY === '${LIBX_KEY}' && !JSON.stringify(servers).includes('libx-secret-9f3')

      // ── (r) route badges tell the truth ─────────────────────────────────────
      const savedBridge = await invoke<{ ok: boolean; reason?: string }>(IntegrationsChannels.serversSave, {
        id: 'libx-bridge',
        label: 'LibX Bridge',
        transport: 'stdio',
        command: 'C:/fixture/bin/mogging-connection.mjs',
        args: ['--connection', 'libx']
      })
      await resyncIntegrations()
      const badgeFor = (label: string): Promise<string> =>
        ES<string>(`(() => {
          const row = [...document.querySelectorAll('#view-settings .mgr-row')].find((r) => r.querySelector('.mgr-label')?.textContent?.includes(${JSON.stringify(label)}))
          return row?.querySelector('.mgr-route')?.className || ''
        })()`)
      const cliBadgeOk = await waitTrue(
        `(() => {
          const row = [...document.querySelectorAll('#view-settings .mgr-row')].find((r) => r.querySelector('.mgr-label')?.textContent?.includes('LibX Tool'))
          return !!row?.querySelector('.mgr-route.is-cli')
        })()`
      )
      const appBadgeOk = await waitTrue(
        `(() => {
          const row = [...document.querySelectorAll('#view-settings .mgr-row')].find((r) => r.querySelector('.mgr-label')?.textContent?.includes('LibX Bridge'))
          return !!row?.querySelector('.mgr-route.is-app')
        })()`
      )
      const houseBadgeOk = await ES<boolean>(`!!document.querySelector('#view-settings .mgr-route.is-house')`)
      const badges = { cli: await badgeFor('LibX Tool'), app: await badgeFor('LibX Bridge') }

      const pass =
        wizardUp && wizardEmptyOffer && libraryOverWizard && stillWizardView && wizardSurvived &&
        availableGroup && catalogCards && registryCorner &&
        bandCta && noAvailableInSettings && inventoryEmpty && emptyStateOpensLibrary &&
        savedTool.ok && chipShown && planOn && planOff &&
        savedKeyed.ok && slotMissing && slotFormUp && vaulted && slotSaved && custodyKept &&
        savedBridge.ok && cliBadgeOk && appBadgeOk && houseBadgeOk

      result = {
        pass,
        wizardUp, wizardEmptyOffer, libraryOverWizard, stillWizardView, wizardSurvived, pathBefore,
        availableGroup, catalogCards, registryCorner,
        bandCta, noAvailableInSettings, inventoryEmpty, emptyStateOpensLibrary,
        savedTool, chipShown, planOn, planOff,
        savedKeyed, slotMissing, slotFormUp, vaulted, slotSaved, custodyKept,
        savedBridge, cliBadgeOk, appBadgeOk, houseBadgeOk, badges
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'libraryux-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}
