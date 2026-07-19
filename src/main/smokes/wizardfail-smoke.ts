import { app, type BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentChannels, type AgentInstallState, type AgentProfile } from '@contracts'
import { listWorktrees } from '@backend/features/worktrees'
import { setAgentDetectOverrideForSmoke } from '../agents'
import { getSettingsStore } from '../app-settings'
import { setWizardAuditFaults, wizardAuditFaults, type WizardAuditFaultState } from '../wizard-audit-faults'

// Adversarial gate for P1/12 + P1/21. Every assertion drives the real wizard
// page and real IPC handlers; main-side injection changes only timing/verdicts.
export function runWizardFailSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 150000)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  const workspaceCount = (): Promise<number> => ES(`window.__mogging.workspace.count()`)
  const status = (): Promise<string> =>
    ES(`document.querySelector('#view-wizard .path-input-status')?.textContent ?? ''`)
  const open = async (prefill: object): Promise<void> => {
    await ES(`window.__mogging.templates.openWizard(${JSON.stringify(prefill)})`)
    await sleep(850)
  }
  const clickLaunch = (): Promise<void> =>
    ES(`document.querySelector('#view-wizard .wizard-footer .btn--primary')?.click()`)
  const snapshotFault = (): Partial<WizardAuditFaultState> => {
    const fault = wizardAuditFaults()
    return fault
      ? {
          resolveCalls: fault.resolveCalls,
          worktreeCreateCalls: fault.worktreeCreateCalls,
          worktreeRemoveCalls: fault.worktreeRemoveCalls,
          planSetCalls: fault.planSetCalls
        }
      : {}
  }

  const makeRepo = (): string => {
    const repo = mkdtempSync(join(tmpdir(), 'mog-wizard-fail-'))
    execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true })
    execFileSync('git', ['config', 'user.email', 'smoke@mogging.test'], { cwd: repo, windowsHide: true })
    execFileSync('git', ['config', 'user.name', 'Wizard Smoke'], { cwd: repo, windowsHide: true })
    writeFileSync(join(repo, 'README.md'), 'wizard transaction\n')
    execFileSync('git', ['add', '-A'], { cwd: repo, windowsHide: true })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, windowsHide: true })
    return repo
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    const repo = makeRepo()
    const slowDir = join(repo, 'slow')
    const fastDir = join(repo, 'fast')
    mkdirSync(slowDir)
    mkdirSync(fastDir)
    try {
      setAgentDetectOverrideForSmoke([
        { id: 'codex', name: 'Audit Codex', installed: true, installHint: 'npm install -g @openai/codex' }
      ])
      const installState: AgentInstallState = {
        agentId: 'codex',
        phase: 'succeeded',
        tail: '',
        exitCode: 0,
        startedAt: Date.now() - 1,
        endedAt: Date.now()
      }
      wc.send(AgentChannels.installChanged, installState)
      await sleep(1400)

      // Counts normalize when the layout shrinks; clearing a custom command
      // immediately zeroes and disables its count instead of dropping it later.
      // (The painter's real gestures are WIZARDUX's job — this drives the model.)
      await open({ cwd: repo, paneCount: 6, mix: [{ provider: 'custom:echo audit', count: 6 }] })
      await ES(`window.__mogging.wizardLayout.setGrid(1, 2)`)
      await sleep(150)
      const shrink = await ES<{ count: string; meter: string }>(`(() => ({
        count: document.querySelector('#view-wizard .wizard-custom-row .stepper-value')?.textContent ?? '',
        meter: document.querySelector('#view-wizard .wizard-fill-label')?.textContent ?? ''
      }))()`)
      await ES(`(() => {
        const input = document.querySelector('#view-wizard .wizard-custom-input')
        if (input instanceof HTMLInputElement) {
          input.value = '   '
          input.dispatchEvent(new Event('input', { bubbles: true }))
        }
      })()`)
      const blank = await ES<{ count: string; disabled: boolean; meter: string }>(`(() => {
        const row = document.querySelector('#view-wizard .wizard-custom-row')
        return {
          count: row?.querySelector('.stepper-value')?.textContent ?? '',
          disabled: [...(row?.querySelectorAll('button') || [])].every((button) => button.disabled),
          meter: document.querySelector('#view-wizard .wizard-fill-label')?.textContent ?? ''
        }
      })()`)
      const normalizedCounts = shrink.count === '2' && /2 \/ 2/.test(shrink.meter)
      const blankCustomNormalized = blank.count === '0' && blank.disabled && /0 \/ 2/.test(blank.meter)

      // A slow reply owned by a previous open cannot overwrite the new wizard.
      setWizardAuditFaults({ fsDelayMsByPath: { [slowDir]: 700 } })
      await ES(`window.__mogging.templates.openWizard({ cwd: ${JSON.stringify(slowDir)} })`)
      await sleep(60)
      await ES(`window.__mogging.templates.openWizard({ cwd: ${JSON.stringify(fastDir)} })`)
      await sleep(1100)
      const pathRace = await ES<{ cwd: string; bar: string; refusal: string | null }>(`window.__mogging.wizardPath()`)
      const stalePathCanceled = pathRace.cwd === fastDir && pathRace.bar === fastDir && !pathRace.refusal

      // Transport failure is a typed unavailable refusal and cannot launch.
      setWizardAuditFaults({ fsRejectPaths: [fastDir] })
      const beforeUnavailable = await workspaceCount()
      await open({ cwd: fastDir })
      const unavailableBeforeLaunch = await status()
      await clickLaunch()
      await sleep(350)
      const unavailableAfterLaunch = await status()
      const transportFailureRefused =
        /could not verify/i.test(unavailableBeforeLaunch) &&
        /could not verify/i.test(unavailableAfterLaunch) &&
        (await workspaceCount()) === beforeUnavailable

      // Profile loads from an abandoned open are generation-gated.
      const oldProfiles: AgentProfile[] = [
        { id: 'old-a', name: 'Old A', provider: 'codex', env: {}, order: 0 },
        { id: 'old-b', name: 'Old B', provider: 'codex', env: {}, order: 1 }
      ]
      const newProfiles: AgentProfile[] = [
        { id: 'new-a', name: 'New A', provider: 'codex', env: {}, order: 0 },
        { id: 'new-b', name: 'New B', provider: 'codex', env: {}, order: 1 }
      ]
      setWizardAuditFaults({
        profileListSequence: [
          { delayMs: 750, profiles: oldProfiles },
          { profiles: newProfiles }
        ]
      })
      await ES(`window.__mogging.templates.openWizard({ cwd: ${JSON.stringify(repo)} })`)
      await sleep(60)
      await ES(`window.__mogging.templates.openWizard({ cwd: ${JSON.stringify(repo)} })`)
      await sleep(1100)
      const profileOptions = await ES<string[]>(
        `[...document.querySelectorAll('#view-wizard .wizard-profile-select option')].map((option) => option.textContent || '')`
      )
      const staleProfilesCanceled =
        profileOptions.includes('New A') && profileOptions.includes('New B') && !profileOptions.some((name) => name.startsWith('Old'))

      // A selected profile is revalidated at submit and cannot silently fall
      // through to another account after deletion.
      setWizardAuditFaults(null)
      const store = getSettingsStore()
      store?.saveProfile({ id: 'safe-profile', name: 'Safe', provider: 'codex', env: {}, order: 0 })
      store?.saveProfile({ id: 'doomed-profile', name: 'Doomed', provider: 'codex', env: {}, order: 1 })
      await open({ cwd: repo, paneCount: 1, mix: [{ provider: 'codex', count: 1 }] })
      await ES(`(() => {
        const select = document.querySelector('#view-wizard .wizard-profile-select')
        if (select instanceof HTMLSelectElement) {
          select.value = 'doomed-profile'
          select.dispatchEvent(new Event('change', { bubbles: true }))
        }
      })()`)
      store?.removeProfile('doomed-profile')
      const beforeDeletedProfile = await workspaceCount()
      await clickLaunch()
      await sleep(500)
      const deletedProfileRefused =
        /profile no longer exists/i.test(await status()) && (await workspaceCount()) === beforeDeletedProfile

      // Double-submit while resolution is deliberately slow creates one workspace,
      // with both footer actions disabled for the whole in-flight operation.
      setWizardAuditFaults({ resolveDelayMs: 700 })
      await open({ cwd: repo, paneCount: 1 })
      const beforeDouble = await workspaceCount()
      await ES(`(() => {
        const button = document.querySelector('#view-wizard .wizard-footer .btn--primary')
        button?.click(); button?.click()
      })()`)
      await sleep(100)
      const submitBusy = await ES<boolean>(`(() => {
        const footer = document.querySelector('#view-wizard .wizard-footer')
        return footer?.getAttribute('aria-busy') === 'true' && [...(footer?.querySelectorAll('button') || [])].every((b) => b.disabled)
      })()`)
      await sleep(1100)
      const doubleFault = snapshotFault()
      const submitSingleFire =
        submitBusy && doubleFault.resolveCalls === 1 && (await workspaceCount()) === beforeDouble + 1

      // Resolution rejection is honest and opens nothing.
      setWizardAuditFaults({ resolveReject: true })
      await open({ cwd: repo, paneCount: 1 })
      const beforeResolveFailure = await workspaceCount()
      await clickLaunch()
      await sleep(500)
      const resolveFault = snapshotFault()
      const resolveFailureRefused =
        resolveFault.resolveCalls === 1 &&
        /could not resolve|no workspace or agent was started/i.test(await status()) &&
        (await workspaceCount()) === beforeResolveFailure

      // Second worktree failure rolls back the first and never shares the repo.
      setWizardAuditFaults({ worktreeFailAt: 2 })
      await open({ cwd: repo, paneCount: 2, mix: [{ provider: 'codex', count: 2 }] })
      await ES(`(() => {
        document.querySelectorAll('#view-wizard .wizard-adv').forEach((details) => (details.open = true))
        const label = [...document.querySelectorAll('#view-wizard label')]
          .find((item) => item.textContent?.includes('Isolate each agent'))
        const box = label?.querySelector('input')
        if (box instanceof HTMLInputElement && !box.checked) box.click()
      })()`)
      const beforePartial = await workspaceCount()
      await clickLaunch()
      await sleep(1700)
      const partialFault = snapshotFault()
      const liveIsolatedAfterPartial = (await listWorktrees(repo)).filter((item) => /[\\/]\.mogging[\\/]worktrees[\\/]/.test(item.path))
      const partialIsolationRolledBack =
        partialFault.worktreeCreateCalls === 2 &&
        partialFault.worktreeRemoveCalls === 1 &&
        liveIsolatedAfterPartial.length === 0 &&
        /could not isolate every agent|no workspace was opened/i.test(await status()) &&
        (await workspaceCount()) === beforePartial

      // A scoped plan save rejection happens after worktree precreation but before
      // workspace/agent creation, and rolls the worktree back atomically.
      const serverSaved = await ES<{ ok: boolean }>(`window.bridge.invoke('integrations:servers:save', {
        id: 'audit-wizard-tool', label: 'Audit wizard tool', transport: 'stdio', command: 'node', args: ['audit-server.mjs']
      })`)
      setWizardAuditFaults({ planSetReject: true })
      await open({ cwd: repo, paneCount: 1, mix: [{ provider: 'codex', count: 1 }] })
      await ES(`(() => {
        document.querySelectorAll('#view-wizard .wizard-adv').forEach((details) => (details.open = true))
        const label = [...document.querySelectorAll('#view-wizard label')]
          .find((item) => item.textContent?.includes('Isolate each agent'))
        const box = label?.querySelector('input')
        if (box instanceof HTMLInputElement && !box.checked) box.click()
      })()`)
      const beforePlan = await workspaceCount()
      await clickLaunch()
      await sleep(1700)
      const planFault = snapshotFault()
      const liveIsolatedAfterPlan = (await listWorktrees(repo)).filter((item) => /[\\/]\.mogging[\\/]worktrees[\\/]/.test(item.path))
      const planRejectedAtomically =
        serverSaved.ok &&
        planFault.worktreeCreateCalls === 1 &&
        planFault.worktreeRemoveCalls === 1 &&
        planFault.planSetCalls === 1 &&
        liveIsolatedAfterPlan.length === 0 &&
        /tool plan could not be saved|no workspace or agent was started/i.test(await status()) &&
        (await workspaceCount()) === beforePlan
      await ES(`window.bridge.invoke('integrations:servers:remove', 'audit-wizard-tool')`)

      // The launch transaction acts on ONE moment. The page stays interactive while
      // the launch awaits (only the footer disables), so a keystroke or recent-click
      // mid-flight used to retarget the transaction: worktrees under repo A, the
      // workspace opened at half-typed B, the rollback asking B to remove A's trees.
      const retargetDir = mkdtempSync(join(tmpdir(), 'mog-wizard-retarget-'))
      const swapPathTo = (dir: string): Promise<void> =>
        ES(`(() => {
          const input = document.querySelector('#view-wizard .path-input-field')
          if (input instanceof HTMLInputElement) {
            input.value = ${JSON.stringify(dir)}
            input.dispatchEvent(new Event('input', { bubbles: true }))
          }
        })()`)

      // (a) A retarget while resolve() is in flight: the workspace still opens at the
      // folder Launch was CLICKED on, never at the mid-flight edit.
      setWizardAuditFaults({ resolveDelayMs: 700 })
      await open({ cwd: repo, paneCount: 1 })
      const beforeRetarget = await workspaceCount()
      await clickLaunch()
      await sleep(150)
      await swapPathTo(retargetDir)
      await sleep(1500)
      const retargetCwd = await ES<string>(`window.__mogging.workspace.active()?.cwd ?? ''`)
      const launchIgnoresMidflightRetarget =
        (await workspaceCount()) === beforeRetarget + 1 && retargetCwd === repo

      // (b) A retarget while the worktree creates are IN FLIGHT (they run in parallel
      // now — there is no "between"): the failed transaction's rollback still targets
      // the repo the worktrees were created in — nothing orphaned, no "manual cleanup"
      // shrug, and the retarget dir untouched. The 1500ms stretch keeps the status
      // assertion deterministic: the retarget's own path probe (350ms debounce + a
      // local fs stat) settles well before the creates do, so the isolation refusal
      // is the LAST status writer.
      setWizardAuditFaults({ worktreeFailAt: 2, worktreeDelayMs: 1500 })
      await open({ cwd: repo, paneCount: 2, mix: [{ provider: 'codex', count: 2 }] })
      await ES(`(() => {
        document.querySelectorAll('#view-wizard .wizard-adv').forEach((details) => (details.open = true))
        const label = [...document.querySelectorAll('#view-wizard label')]
          .find((item) => item.textContent?.includes('Isolate each agent'))
        const box = label?.querySelector('input')
        if (box instanceof HTMLInputElement && !box.checked) box.click()
      })()`)
      const beforeRollbackSwap = await workspaceCount()
      await clickLaunch()
      await sleep(250) // both creates are inside their injected delay — the swap lands mid-transaction
      await swapPathTo(retargetDir)
      await sleep(3200)
      const swapFault = snapshotFault()
      const swapStatus = await status()
      const liveIsolatedAfterSwap = (await listWorktrees(repo)).filter((item) => /[\\/]\.mogging[\\/]worktrees[\\/]/.test(item.path))
      const rollbackTargetsSnapshotRepo =
        swapFault.worktreeCreateCalls === 2 &&
        swapFault.worktreeRemoveCalls === 1 &&
        liveIsolatedAfterSwap.length === 0 &&
        /could not isolate every agent/i.test(swapStatus) &&
        !/manual cleanup/i.test(swapStatus) &&
        (await workspaceCount()) === beforeRollbackSwap

      // A preset outlives its CLIs: applying one that names a since-uninstalled
      // provider must not produce a stepper-less phantom assignment — the meter
      // counts only what can launch, and the launch types no dead command.
      setWizardAuditFaults(null)
      setAgentDetectOverrideForSmoke([
        { id: 'codex', name: 'Audit Codex', installed: true, installHint: 'npm install -g @openai/codex' },
        { id: 'gemini', name: 'Audit Gemini', installed: false, installHint: 'npm install -g @google/gemini-cli' }
      ])
      await ES(`window.bridge.invoke('templates:save', ${JSON.stringify({
        id: 'stale-preset-audit',
        name: 'Stale preset audit',
        mix: [
          { provider: 'codex', count: 1 },
          { provider: 'gemini', count: 2 }
        ]
      })})`)
      await open({ cwd: repo, paneCount: 4 })
      await ES(`(() => {
        const chip = [...document.querySelectorAll('#view-wizard .wizard-preset-apply')]
          .find((item) => item.querySelector('.wizard-preset-name')?.textContent === 'Stale preset audit')
        chip?.click()
      })()`)
      await sleep(250)
      const staleMeter = await ES<string>(
        `document.querySelector('#view-wizard .wizard-fill-label')?.textContent ?? ''`
      )
      const beforeStalePreset = await workspaceCount()
      await clickLaunch()
      await sleep(900)
      const stalePresetAssignments = await ES<string[]>(
        `window.__mogging.workspace.active()?.assignments ?? []`
      )
      const stalePresetPruned =
        /^1 \//.test(staleMeter) &&
        (await workspaceCount()) === beforeStalePreset + 1 &&
        stalePresetAssignments.includes('codex') &&
        !stalePresetAssignments.includes('gemini')
      await ES(`window.bridge.invoke('templates:remove', 'stale-preset-audit')`)

      // A profile picked for a provider whose count is ZERO is not part of the
      // launch: deleting it in Settings must not refuse a workspace that never
      // referenced it (the mirror of deletedProfileRefused above).
      store?.saveProfile({ id: 'unused-a', name: 'Unused A', provider: 'codex', env: {}, order: 0 })
      store?.saveProfile({ id: 'unused-doomed', name: 'Unused Doomed', provider: 'codex', env: {}, order: 1 })
      await open({ cwd: repo, paneCount: 1 })
      await ES(`(() => {
        const select = document.querySelector('#view-wizard .wizard-profile-select')
        if (select instanceof HTMLSelectElement) {
          select.value = 'unused-doomed'
          select.dispatchEvent(new Event('change', { bubbles: true }))
        }
      })()`)
      store?.removeProfile('unused-doomed')
      const beforeUnusedProfile = await workspaceCount()
      await clickLaunch()
      await sleep(900)
      const unusedProfileNeverBlocks = (await workspaceCount()) === beforeUnusedProfile + 1

      const pass =
        normalizedCounts &&
        blankCustomNormalized &&
        stalePathCanceled &&
        transportFailureRefused &&
        staleProfilesCanceled &&
        deletedProfileRefused &&
        submitSingleFire &&
        resolveFailureRefused &&
        partialIsolationRolledBack &&
        planRejectedAtomically &&
        launchIgnoresMidflightRetarget &&
        rollbackTargetsSnapshotRepo &&
        stalePresetPruned &&
        unusedProfileNeverBlocks
      result = {
        pass,
        normalizedCounts,
        blankCustomNormalized,
        stalePathCanceled,
        pathRace,
        transportFailureRefused,
        unavailableBeforeLaunch,
        unavailableAfterLaunch,
        staleProfilesCanceled,
        profileOptions,
        deletedProfileRefused,
        submitSingleFire,
        submitBusy,
        doubleFault,
        resolveFailureRefused,
        resolveFault,
        partialIsolationRolledBack,
        partialFault,
        planRejectedAtomically,
        planFault,
        launchIgnoresMidflightRetarget,
        retargetCwd,
        rollbackTargetsSnapshotRepo,
        swapFault,
        swapStatus,
        stalePresetPruned,
        staleMeter,
        stalePresetAssignments,
        unusedProfileNeverBlocks
      }
    } catch (error) {
      result = { pass: false, error: String(error), fault: snapshotFault() }
    } finally {
      setWizardAuditFaults(null)
      setAgentDetectOverrideForSmoke(null)
      getSettingsStore()?.removeProfile('safe-profile')
      getSettingsStore()?.removeProfile('doomed-profile')
      getSettingsStore()?.removeProfile('unused-a')
      getSettingsStore()?.removeProfile('unused-doomed')
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'wizardfail-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(run, 1200))
  else setTimeout(run, 1200)
}
