import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  IntegrationsChannels,
  ProfileChannels,
  defaultIntegrationsGrant,
  defaultToolPlan,
  planHasServerForCli,
  type AgentProfile,
  type McpServerEntry,
  type WorkspaceIntegrationsGrant,
  type WorkspaceToolPlan
} from '@contracts'
import { mutationAuditCalls, setMutationAuditDelay } from '../mutation-audit-faults'

// Audit regression gate for P1/22. Real renderer IPC requests are deliberately
// held in flight so stale whole-object writers and non-pending controls are
// observable instead of depending on scheduler luck.
export function runMutationRaceSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 90000)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  const invoke = <T>(channel: string, payload: unknown): Promise<T> =>
    ES<T>(`window.bridge.invoke(${JSON.stringify(channel)}, ${JSON.stringify(payload)})`)

  const server: McpServerEntry = {
    id: 'audit-mutation-tool',
    label: 'Audit mutation server',
    transport: 'stdio',
    command: 'node',
    args: ['audit-mutation-server.mjs']
  }
  const profiles: AgentProfile[] = [
    { id: 'audit-profile-a', name: 'Audit Alpha', provider: 'audit-provider', email: 'alpha@audit.test', env: {}, order: 0 },
    { id: 'audit-profile-b', name: 'Audit Beta', provider: 'audit-provider', email: 'beta@audit.test', env: {}, order: 1 },
    { id: 'audit-profile-c', name: 'Audit Gamma', provider: 'audit-provider', email: 'gamma@audit.test', env: {}, order: 2 }
  ]

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      await sleep(1500)
      await ES(`window.__mogging.workspace.create({ name: 'Mutation race', cwd: ${JSON.stringify(process.cwd())} })`)
      await sleep(900)
      const workspace = await ES<{ id: string }>(`window.__mogging.workspace.active()`)
      const workspaceId = workspace.id

      const serverSaved = await invoke<{ ok: boolean }>(IntegrationsChannels.serversSave, server)
      const profilesSaved = await Promise.all(profiles.map((profile) => invoke<boolean>(ProfileChannels.save, profile)))
      setMutationAuditDelay(450)

      // A blocked origin must remain a no-op: it cannot silently raise the web
      // tier while refusing the origin itself.
      await invoke(IntegrationsChannels.grantSet, defaultIntegrationsGrant(workspaceId))
      await invoke(IntegrationsChannels.grantMutate, {
        workspaceId,
        field: 'origin',
        op: 'add',
        origin: 'https://mail.google.com'
      })
      const blockedGrant = await invoke<WorkspaceIntegrationsGrant>(IntegrationsChannels.grantGet, workspaceId)
      const sensitiveClosed = blockedGrant.web === 'off' && blockedGrant.actOrigins.length === 0

      // Different editors land together against the latest grant. No one may
      // clobber a sibling field or the other origin.
      await invoke(IntegrationsChannels.grantSet, defaultIntegrationsGrant(workspaceId))
      await ES(`Promise.all([
        window.bridge.invoke(${JSON.stringify(IntegrationsChannels.grantMutate)}, ${JSON.stringify({ workspaceId, field: 'writeTools', value: 'all' })}),
        window.bridge.invoke(${JSON.stringify(IntegrationsChannels.grantMutate)}, ${JSON.stringify({ workspaceId, field: 'web', value: 'public' })}),
        window.bridge.invoke(${JSON.stringify(IntegrationsChannels.grantMutate)}, ${JSON.stringify({ workspaceId, field: 'origin', op: 'add', origin: 'https://github.com' })}),
        window.bridge.invoke(${JSON.stringify(IntegrationsChannels.grantMutate)}, ${JSON.stringify({ workspaceId, field: 'origin', op: 'add', origin: 'https://linear.app' })})
      ])`)
      const racedGrant = await invoke<WorkspaceIntegrationsGrant>(IntegrationsChannels.grantGet, workspaceId)
      const grantAtomic =
        racedGrant.writeTools === 'all' &&
        racedGrant.web === 'signed-in' &&
        racedGrant.actOrigins.includes('https://github.com') &&
        racedGrant.actOrigins.includes('https://linear.app') &&
        racedGrant.actOrigins.length === 2

      // Rapid matrix clicks and inheritance are operations, not stale captured
      // plans, so every independently toggled cell survives.
      await invoke(IntegrationsChannels.planSet, defaultToolPlan(workspaceId))
      await ES(`Promise.all([
        window.bridge.invoke(${JSON.stringify(IntegrationsChannels.planMutate)}, ${JSON.stringify({ workspaceId, kind: 'cell', serverId: server.id, cli: 'claude-code', enabled: true })}),
        window.bridge.invoke(${JSON.stringify(IntegrationsChannels.planMutate)}, ${JSON.stringify({ workspaceId, kind: 'cell', serverId: server.id, cli: 'codex', enabled: true })}),
        window.bridge.invoke(${JSON.stringify(IntegrationsChannels.planMutate)}, ${JSON.stringify({ workspaceId, kind: 'cell', serverId: server.id, cli: 'gemini', enabled: true })}),
        window.bridge.invoke(${JSON.stringify(IntegrationsChannels.planMutate)}, ${JSON.stringify({ workspaceId, kind: 'inherit', value: true })})
      ])`)
      const racedPlan = await invoke<WorkspaceToolPlan>(IntegrationsChannels.planGet, workspaceId)
      const planAtomic =
        racedPlan.inheritGlobal &&
        planHasServerForCli(racedPlan, server.id, 'claude-code') &&
        planHasServerForCli(racedPlan, server.id, 'codex') &&
        planHasServerForCli(racedPlan, server.id, 'gemini')

      // Exercise the actual settings buttons while their main handlers are
      // delayed. Disabled + aria-busy is the visible single-fire contract.
      await ES(`window.__mogging.view('settings'); window.__mogging.settingsTab('integrations')`)
      await sleep(1200)
      // The write-tools control is a ToggleRow now (F-25) — same single-fire contract,
      // asserted on the switch input: disabled + aria-busy across the round-trip.
      const grantPending = await ES<{ found: boolean; disabled: boolean; busy: boolean }>(`(() => {
        const block = [...document.querySelectorAll('.mgr-grants-block')].find((item) => item.textContent?.includes('which write tools agents get'))
        const input = block?.querySelector('.switch-input')
        if (!(input instanceof HTMLInputElement)) return { found: false, disabled: false, busy: false }
        input.click()
        return { found: true, disabled: input.disabled, busy: input.getAttribute('aria-busy') === 'true' }
      })()`)
      await sleep(100)
      const grantStillPending = await ES<boolean>(`(() => {
        const block = [...document.querySelectorAll('.mgr-grants-block')].find((item) => item.textContent?.includes('which write tools agents get'))
        const input = block?.querySelector('.switch-input')
        return input instanceof HTMLInputElement && input.disabled && input.getAttribute('aria-busy') === 'true'
      })()`)
      await sleep(700)
      const grantAfterUi = await invoke<WorkspaceIntegrationsGrant>(IntegrationsChannels.grantGet, workspaceId)
      const grantUiCommitted = grantAfterUi.writeTools === 'none'

      const planPending = await ES<{ found: boolean; disabled: boolean; busy: boolean }>(`(() => {
        const block = [...document.querySelectorAll('.mgr-grants-block')].find((item) => item.textContent?.includes('Which of your tools reach this workspace'))
        const button = [...(block?.querySelectorAll('.toolplan-cell') ?? [])].find((item) => item.getAttribute('aria-label')?.includes('Audit mutation server on Codex'))
        if (!(button instanceof HTMLButtonElement)) return { found: false, disabled: false, busy: false }
        button.click()
        return { found: true, disabled: button.disabled, busy: button.getAttribute('aria-busy') === 'true' }
      })()`)
      await sleep(100)
      const planStillPending = await ES<boolean>(`(() => {
        const block = [...document.querySelectorAll('.mgr-grants-block')].find((item) => item.textContent?.includes('Which of your tools reach this workspace'))
        const button = [...(block?.querySelectorAll('.toolplan-cell') ?? [])].find((item) => item.getAttribute('aria-label')?.includes('Audit mutation server on Codex'))
        return button instanceof HTMLButtonElement && button.disabled && button.getAttribute('aria-busy') === 'true'
      })()`)
      await sleep(700)
      const planAfterUi = await invoke<WorkspaceToolPlan>(IntegrationsChannels.planGet, workspaceId)
      const planUiCommitted =
        !planHasServerForCli(planAfterUi, server.id, 'codex') &&
        planHasServerForCli(planAfterUi, server.id, 'claude-code') &&
        planHasServerForCli(planAfterUi, server.id, 'gemini') &&
        planAfterUi.inheritGlobal

      // Two profile surfaces can request different defaults together. Their
      // list->activate decisions serialize and each main swap is transactional.
      await ES(`window.__mogging.settingsTab('profiles')`)
      await sleep(900)
      const profilePending = await ES<{ found: boolean; beta: boolean; gamma: boolean; busy: boolean }>(`(() => {
        const rows = [...document.querySelectorAll('.ph-row')]
        const pick = (name) => {
          const row = rows.find((item) => item.textContent?.includes(name))
          return [...(row?.querySelectorAll('button') ?? [])].find((item) => item.textContent?.includes('Make default'))
        }
        const beta = pick('Audit Beta')
        const gamma = pick('Audit Gamma')
        if (!(beta instanceof HTMLButtonElement) || !(gamma instanceof HTMLButtonElement)) {
          return { found: false, beta: false, gamma: false, busy: false }
        }
        beta.click()
        gamma.click()
        return {
          found: true,
          beta: beta.disabled,
          gamma: gamma.disabled,
          busy: beta.getAttribute('aria-busy') === 'true' && gamma.getAttribute('aria-busy') === 'true'
        }
      })()`)
      await sleep(1200)
      const afterProfiles = await invoke<AgentProfile[]>(ProfileChannels.list, undefined)
      const mine = afterProfiles.filter((profile) => profile.provider === 'audit-provider').sort((a, b) => a.order - b.order)
      const profileAtomic =
        mine.length === 3 &&
        mine[0]?.id === 'audit-profile-c' &&
        new Set(mine.map((profile) => profile.order)).size === 3 &&
        JSON.stringify(mine.map((profile) => profile.order)) === JSON.stringify([0, 1, 2])

      const calls = mutationAuditCalls()
      const delayedHandlersUsed = calls.grant >= 6 && calls.plan >= 5 && calls.profile === 2
      const pass =
        serverSaved.ok &&
        profilesSaved.every(Boolean) &&
        sensitiveClosed &&
        grantAtomic &&
        planAtomic &&
        grantPending.found && grantPending.disabled && grantPending.busy && grantStillPending && grantUiCommitted &&
        planPending.found && planPending.disabled && planPending.busy && planStillPending && planUiCommitted &&
        profilePending.found && profilePending.beta && profilePending.gamma && profilePending.busy &&
        profileAtomic && delayedHandlersUsed
      result = {
        pass,
        serverSaved,
        profilesSaved,
        sensitiveClosed,
        blockedGrant,
        grantAtomic,
        racedGrant,
        planAtomic,
        racedPlan,
        grantPending,
        grantStillPending,
        grantUiCommitted,
        planPending,
        planStillPending,
        planUiCommitted,
        profilePending,
        profileAtomic,
        profiles: mine,
        delayedHandlersUsed,
        calls
      }
    } catch (error) {
      result = { pass: false, error: String(error) }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'mutationrace-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(run, 1200))
  else setTimeout(run, 1200)
}
