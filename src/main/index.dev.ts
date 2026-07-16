import type { BrowserWindow } from 'electron'
import { bootMain, prepareRuntime } from './boot'
import { installHarnessPorts } from './harness-install'
import { runSmoke } from './smokes/smoke'
import { runShot } from './smokes/shot'
import { runFsListSmoke } from './smokes/fslist-smoke'
import { runGlobalHooksSmoke } from './smokes/globalhooks-smoke'
import { runAgentSettingsSmoke } from './smokes/agentsettings-smoke'
import { runSetAgentConfigSmoke } from './smokes/setagentcfg-smoke'
import { runCwdSmoke } from './smokes/cwd-smoke'
import { runMcpSmoke } from './smokes/mcp-smoke'
import { runMcpWriteSmoke } from './smokes/mcpwrite-smoke'
import { runAgentWebSmoke } from './smokes/agentweb-smoke'
import { runPerWsSmoke } from './smokes/perws-smoke'
import { runPerWsAgentSmoke } from './smokes/perwsagent-smoke'
import { runVaultKeysSmoke } from './smokes/vaultkeys-smoke'
import { runWsCloseSmoke } from './smokes/wsclose-smoke'
import { runKbShortcutsSmoke } from './smokes/kbshortcuts-smoke'
import { runKbGlobalSmoke } from './smokes/kbglobal-smoke'
import { runVerdictLiveSmoke } from './smokes/verdictlive-smoke'
import { runToolPlanSmoke } from './smokes/toolplan-smoke'
import { runIntegSmoke } from './smokes/integ-smoke'
import { runEvBridgeSmoke } from './smokes/evbridge-smoke'
import { runMcpStatusSmoke } from './smokes/mcpstatus-smoke'
import { runMcpLoopSmoke } from './smokes/mcploop-smoke'
import { runWebTrailSmoke } from './smokes/webtrail-smoke'
import { runMcpMgrSmoke } from './smokes/mcpmgr-smoke'
import { runMcpCatSmoke } from './smokes/mcpcat-smoke'
import { runIntegUxSmoke } from './smokes/integux-smoke'
import { runIntegMilestoneSmoke } from './smokes/integmilestone-smoke'
import { runWizardUxSmoke } from './smokes/wizardux-smoke'
import { runFolderPickSmoke } from './smokes/folderpick-smoke'
import { runFileTreeSmoke } from './smokes/filetree-smoke'
import { runExplorerSmoke } from './smokes/explorer-smoke'
import { runExplorerRaceSmoke } from './smokes/explorerrace-smoke'
import { runTreeLiveSmoke } from './smokes/treelive-smoke'
import { runTreeGitSmoke } from './smokes/treegit-smoke'
import { runFileActSmoke } from './smokes/fileact-smoke'
import { runFilesMilestoneSmoke } from './smokes/filesmilestone-smoke'
import { runSetIntegSmoke } from './smokes/setinteg-smoke'
import { runSetShellSmoke } from './smokes/setshell-smoke'
import { runSetUsageSmoke } from './smokes/setusage-smoke'
import { runHomeUxSmoke } from './smokes/homeux-smoke'
import { runBoardUxSmoke } from './smokes/boardux-smoke'
import { runFeedbackUxSmoke } from './smokes/feedbackux-smoke'
import { runChromeUxSmoke } from './smokes/chromeux-smoke'
import { runDockUxSmoke } from './smokes/dockux-smoke'
import { runResponsiveSmoke } from './smokes/responsive-smoke'
import { runUxMilestoneSmoke } from './smokes/uxmilestone-smoke'
import { runAgentSmoke } from './smokes/agent-smoke'
import { runStateSmoke } from './smokes/state-smoke'
import { runReloadSmoke } from './smokes/reload-smoke'
import { runMultipaneSmoke } from './smokes/multipane-smoke'
import { runWorkspaceSmoke } from './smokes/workspace-smoke'
import { runAgentLaunchSmoke } from './smokes/agentlaunch-smoke'
import { runTypedSmoke } from './smokes/typed-smoke'
import { runTypedCostSmoke } from './smokes/typedcost-smoke'
import { runCtxAccuracySmoke } from './smokes/ctxaccuracy-smoke'
import { runTemplateSmoke } from './smokes/template-smoke'
import { runProfpersistSmoke } from './smokes/profpersist-smoke'
import { runBrowserSmoke } from './smokes/browser-smoke'
import { runBrowserCtlSmoke } from './smokes/browserctl-smoke'
import { runBrowserRaceSmoke } from './smokes/browserrace-smoke'
import { runFirstRunSmoke } from './smokes/firstrun-smoke'
import { runProductSmoke } from './smokes/product-smoke'
import { runUsageSmoke } from './smokes/usage-smoke'
import { runUsageUiSmoke } from './smokes/usageui-smoke'
import { runUsageGlanceSmoke } from './smokes/usageglance-smoke'
import { runWebUsageSmoke } from './smokes/webusage-smoke'
import { runUsageCliSmoke } from './smokes/usagecli-smoke'
import { runUsageSetSmoke } from './smokes/usageset-smoke'
import { runAttentionSmoke } from './smokes/attention-smoke'
import { runBlocksSmoke } from './smokes/blocks-smoke'
import { runClipboardSmoke } from './smokes/clipboard-smoke'
import { runGitSmoke } from './smokes/git-smoke'
import { runNotifySmoke } from './smokes/notify-smoke'
import { runMilestoneSmoke } from './smokes/milestone-smoke'
import { runFlickerSmoke } from './smokes/flicker-smoke'
import { runPaneScrollSmoke } from './smokes/panescroll-smoke'
import { runAppScrollSmoke } from './smokes/appscroll-smoke'
import { runConptySmoke } from './smokes/conpty-smoke'
import { runPaneOpsSmoke } from './smokes/paneops-smoke'
import { runMovePaneSmoke } from './smokes/movepane-smoke'
import { runControlSmoke } from './smokes/control-smoke'
import { runControl2Smoke } from './smokes/control2-smoke'
import { runPerceptionSmoke } from './smokes/perception-smoke'
import { runWorktreeSmoke } from './smokes/worktree-smoke'
import { runReviewSmoke } from './smokes/review-smoke'
import { runReviewSnapSmoke } from './smokes/reviewsnap-smoke'
import { runBoardSmoke } from './smokes/board-smoke'
import { runBoardFailSmoke } from './smokes/boardfail-smoke'
import { runPersistHealthSmoke } from './smokes/persisthealth-smoke'
import { runRoleRaceSmoke } from './smokes/rolerace-smoke'
import { runUpdateFailSmoke } from './smokes/updatefail-smoke'
import { runA11yModalSmoke } from './smokes/a11ymodal-smoke'
import { runBrowserZeroSmoke } from './smokes/browserzero-smoke'
import { runSecretFormsSmoke } from './smokes/secretforms-smoke'
import { runBoardRenderSmoke } from './smokes/boardrender-smoke'
import { runKbApgSmoke } from './smokes/kbapg-smoke'
import { runAsyncStateSmoke } from './smokes/asyncstate-smoke'
import { runAgentRegistrySmoke } from './smokes/agentregistry-smoke'
import { runPlainMenuSmoke } from './smokes/plainmenu-smoke'
import { runWizardFailSmoke } from './smokes/wizardfail-smoke'
import { runWizardIsoSmoke } from './smokes/wizardiso-smoke'
import { runMutationRaceSmoke } from './smokes/mutationrace-smoke'
import { runAuthRunnerSmoke } from './smokes/authrunner-smoke'
import { runOrchestrationSmoke } from './smokes/orchestration-smoke'
import { runSwarmSmoke } from './smokes/swarm-smoke'
import { runLedgerSmoke } from './smokes/ledger-smoke'
import { runGateSmoke } from './smokes/gate-smoke'
import { runProfilesSmoke } from './smokes/profiles-smoke'
import { runRemoteSmoke } from './smokes/remote-smoke'
import { runSwarmMilestoneSmoke } from './smokes/swarmmilestone-smoke'
import { runDaemonSurviveSmoke } from './smokes/daemon-survive-smoke'
import { runMigrateSmoke } from './smokes/migrate-smoke'
import { runNotifyHookSmoke } from './smokes/notifyhook-smoke'
import { runDaemonCustodySmoke } from './smokes/daemoncustody-smoke'
import { runSessionPoolSmoke } from './smokes/sessionpool-smoke'

// THE DEV / TEST ENTRY: the production boot (boot.ts — the SAME one src/main/index.ts runs) plus
// the env-gated smoke + gallery harness hooked into it.
//
// electron-vite picks the entry by command (electron.vite.config.ts): `serve` — which is what
// `npm run dev` runs, and every gate in scripts/qa-smokes.sh runs `npm run dev` — takes THIS file;
// `build` takes src/main/index.ts. Both emit out/main/index.js. So the harness is fully present
// in dev and fully absent from the shipped artifact, with no code-splitting, no runtime flag, and
// no second copy of the boot sequence (audit finding 41; scripts/check-prod-artifact.mjs enforces
// the absence, scripts/check-gates.mjs enforces that this file knows every gate the sweep runs).
//
// The harness only ever runs from here, so this file is allowed to be a 100-import wall. What it
// is NOT allowed to do is re-implement boot: it passes BootHooks and boot.ts calls back at the two
// points the gates need (windowless-before-the-store, and windowed-after-the-window).

// Remote-pane smoke support (4/05): point the daemon at a FAKE ssh (a node script the
// smoke writes later) BEFORE the daemon spawns, so no smoke ever needs a network.
function installSshShim(): void {
  if ((process.env.MOGGING_REMOTE || process.env.MOGGING_SHOT === 'all') && !process.env.MOGGING_SSH_SHIM) {
    process.env.MOGGING_SSH_SHIM = require('node:path').join(
      require('node:os').tmpdir(),
      `mogging-ssh-shim-${process.pid}.` + (process.platform === 'win32' ? 'ps1' : 'sh')
    )
  }
}

// "Smoke" means a MOGGING_* GATE is set — not any MOGGING_* var. This was a DENYLIST (any
// MOGGING_* var outside four pane-runtime names counted as a smoke) and it failed OPEN: every
// var it did not know — MOGGING_INPROC (the documented daemon-failure workaround), MOGGING_DEVLOG,
// MOGGING_DAEMON_IDLE_MS — silently dropped the instance lock, the deep link, and auto-update from
// a REAL run, letting a second full instance share one userData: exactly the clobbering the -dev
// userData split exists to prevent. An ALLOWLIST fails CLOSED — an unknown var is a normal run.
// It cannot rot in the sweep either: every gate (scripts/qa-smokes.sh, and the single-gate recipe)
// also sets MOGGING_USERDATA, so a NEW gate is still recognized even if its name never lands here
// — and an isolated userData must not register the OS-global deep-link scheme in any case.
const SMOKE_ENV: readonly string[] = [
  'MOGGING_USERDATA', 'MOGGING_GATES', 'MOGGING_GALLERY', // isolation + sweep markers, set by every gate
  'MOGGING_SURVIVE', 'MOGGING_MIGRATE', 'MOGGING_NOTIFYHOOK', 'MOGGING_DAEMONCUSTODY', 'MOGGING_SESSIONPOOL', 'MOGGING_INTEG', 'MOGGING_TOOLPLAN',
  'MOGGING_EVBRIDGE', 'MOGGING_MCPSTATUS', 'MOGGING_MCPLOOP', 'MOGGING_AGENT', 'MOGGING_STATE', 'MOGGING_RELOAD',
  'MOGGING_SMOKE', 'MOGGING_SHOT', 'MOGGING_MULTIPANE', 'MOGGING_WORKSPACE', 'MOGGING_AGENTLAUNCH',
  'MOGGING_TEMPLATE', 'MOGGING_PROFPERSIST', 'MOGGING_BROWSER', 'MOGGING_BROWSERCTL', 'MOGGING_BROWSERRACE', 'MOGGING_BROWSERZERO', 'MOGGING_FIRSTRUN',
  'MOGGING_PRODUCT', 'MOGGING_USAGEGLANCE', 'MOGGING_USAGEUI', 'MOGGING_WEBUSAGE', 'MOGGING_USAGECLI',
  'MOGGING_USAGESET', 'MOGGING_MCP', 'MOGGING_MCPWRITE', 'MOGGING_AGENTWEB', 'MOGGING_PERWS',
  'MOGGING_PERWSAGENT', 'MOGGING_VAULTKEYS', 'MOGGING_SECRETFORMS', 'MOGGING_WSCLOSE', 'MOGGING_KBSHORTCUTS', 'MOGGING_KBGLOBAL', 'MOGGING_VERDICTLIVE', 'MOGGING_WEBTRAIL',
  'MOGGING_MCPMGR', 'MOGGING_MCPCAT', 'MOGGING_INTEGUX', 'MOGGING_INTEGMILESTONE', 'MOGGING_WIZARDUX', 'MOGGING_WIZARDFAIL', 'MOGGING_WIZARDISO', 'MOGGING_MUTATIONRACE', 'MOGGING_AUTHRUNNER',
  'MOGGING_FOLDERPICK', 'MOGGING_SETSHELL', 'MOGGING_SETAGENTCFG', 'MOGGING_SETINTEG', 'MOGGING_SETUSAGE', 'MOGGING_HOMEUX',
  'MOGGING_BOARDUX', 'MOGGING_FEEDBACKUX', 'MOGGING_CHROMEUX', 'MOGGING_DOCKUX', 'MOGGING_RESPONSIVE', 'MOGGING_KBAPG', 'MOGGING_UXMILESTONE',
  'MOGGING_USAGE', 'MOGGING_ATTENTION', 'MOGGING_CLIPBOARD', 'MOGGING_BLOCKS', 'MOGGING_GIT', 'MOGGING_CWD',
  'MOGGING_NOTIFY', 'MOGGING_MILESTONE', 'MOGGING_FLICKER', 'MOGGING_CONPTY', 'MOGGING_PANEOPS', 'MOGGING_MOVEPANE',
  'MOGGING_PANESCROLL', 'MOGGING_APPSCROLL',
  'MOGGING_CONTROL', 'MOGGING_CONTROL2', 'MOGGING_PERCEPTION', 'MOGGING_WORKTREE', 'MOGGING_REVIEW', 'MOGGING_REVIEWSNAP',
  'MOGGING_BOARD', 'MOGGING_BOARDFAIL', 'MOGGING_BOARDRENDER', 'MOGGING_PERSISTHEALTH', 'MOGGING_UPDATEFAIL', 'MOGGING_A11YMODAL', 'MOGGING_ASYNCSTATE', 'MOGGING_ROLERACE', 'MOGGING_AGENTREGISTRY', 'MOGGING_PLAINMENU', 'MOGGING_ORCHESTRATION', 'MOGGING_SWARM', 'MOGGING_LEDGER', 'MOGGING_GATE',
  'MOGGING_PROFILES', 'MOGGING_REMOTE', 'MOGGING_SWARMMILESTONE',
  // Typed-launch detection + the context gauge (the v6 pack).
  'MOGGING_TYPED', 'MOGGING_TYPEDCOST', 'MOGGING_CTXACCURACY',
  // Phase 11 — Files: the explorer's seven.
  'MOGGING_FSLIST', 'MOGGING_FILETREE', 'MOGGING_EXPLORER', 'MOGGING_EXPLORERRACE', 'MOGGING_TREELIVE', 'MOGGING_TREEGIT',
  'MOGGING_FILEACT', 'MOGGING_FILESMILESTONE', 'MOGGING_AGENTCFG', 'MOGGING_GLOBALHOOKS'
]
const isSmoke = SMOKE_ENV.some((k) => !!process.env[k])

/**
 * WINDOWLESS, before the app-settings store and the daemon exist. TRUE = this launch is the
 * smoke; boot stops here.
 */
async function beforeAppSettings(): Promise<boolean> {
  // Env-gated app-level survival smoke: two separate launches (A then B) prove an agent
  // in the detached daemon outlives an app quit/relaunch (ADR 0006).
  if (process.env.MOGGING_SURVIVE) {
    await runDaemonSurviveSmoke(process.env.MOGGING_SURVIVE)
    return true
  }

  // Windowless daemon-migration smoke: MUST run here — before startDaemonBackend
  // creates this version's sessions.db, the migration's own entry condition.
  if (process.env.MOGGING_MIGRATE) {
    await runMigrateSmoke()
    return true
  }

  // Windowless notify-hook smoke: the generated bell script + per-CLI builders,
  // proven against a fake daemon socket — no daemon, no window.
  if (process.env.MOGGING_NOTIFYHOOK) {
    await runNotifyHookSmoke()
    return true
  }

  // Windowless daemon-custody smoke: the build stamp, the run-root sweep, and the real
  // spawn -> stale-stamp retire-in-place -> pre-install quiescence lifecycle. MUST run here,
  // before startDaemonBackend — it owns its own daemons (isolated LOCALAPPDATA) start to grave.
  if (process.env.MOGGING_DAEMONCUSTODY) {
    await runDaemonCustodySmoke()
    return true
  }

  // Windowless session-pool smoke: sessions follow profiles (ADR 0013) on fixture homes —
  // newer-wins, memory/secrets stay home, dated codex paths, uuid-only resume ids.
  if (process.env.MOGGING_SESSIONPOOL) {
    await runSessionPoolSmoke()
    return true
  }

  // Windowless explorer-list smoke (11/01): the read service through the exact
  // `explorer:list` validation seam, on a fixture tree — no daemon, no window, zero UI.
  if (process.env.MOGGING_FSLIST) {
    await runFsListSmoke()
    return true
  }

  // Windowless agent-settings smoke: the catalog + codecs + scope writers, no daemon, no window.
  if (process.env.MOGGING_AGENTCFG) {
    await runAgentSettingsSmoke()
    return true
  }

  // Windowless tool-plan smoke (8/09): pure materialization + a CLI shim + a
  // real git repo — no daemon, no window.
  if (process.env.MOGGING_INTEG) {
    await runIntegSmoke()
    return true
  }
  // Windowless COST gate for typed-launch detection: the detector on a fake clock over a fake
  // process table, asserting how many process listings each real-life scenario performs. No
  // daemon, no window — the number it protects is invisible in review (typedcost-smoke.ts).
  if (process.env.MOGGING_TYPEDCOST) {
    await runTypedCostSmoke()
    return true
  }
  // Windowless CONTEXT-ACCURACY gate: the real monitor over each CLI's real on-disk format,
  // asserting that the gauge's number is the CLI's own number (ctxaccuracy-smoke.ts).
  if (process.env.MOGGING_CTXACCURACY) {
    await runCtxAccuracySmoke()
    return true
  }
  if (process.env.MOGGING_REVIEWSNAP) {
    await runReviewSnapSmoke()
    return true
  }

  return false
}

/**
 * WINDOWLESS, but AFTER registerAppSettings() + registerRuntimeHealth(): these read the same
 * stored opt-in/plan production reads. Still no daemon and no window.
 */
async function afterAppSettings(): Promise<boolean> {
  // This windowless gate needs the same stored opt-in plan production reads.
  if (process.env.MOGGING_TOOLPLAN) {
    await runToolPlanSmoke()
    return true
  }

  // Windowless event-bridge smoke (8/10): needs the settings store + vault, no
  // daemon or window — an in-process loopback receiver proves outbound delivery.
  if (process.env.MOGGING_EVBRIDGE) {
    await runEvBridgeSmoke()
    return true
  }
  if (process.env.MOGGING_MCPSTATUS) {
    await runMcpStatusSmoke()
    return true
  }

  return false
}

/**
 * Every WINDOWED gate. First match wins, exactly as when this chain lived at the tail of the
 * single entry's whenReady — `win` is the window boot.ts just opened, so the old `&& win` guard
 * on each arm is now the caller's job (boot.ts only calls this with a live window).
 *
 * scripts/check-gates.mjs reads THIS chain (and SMOKE_ENV above) and reconciles both against the
 * `run_smoke` rows in scripts/qa-smokes.sh — a gate the sweep runs but this file never dispatches
 * fails the registry gate.
 */
function afterWindow(win: BrowserWindow): void {
  if (process.env.MOGGING_AGENT) {
    runAgentSmoke(win, process.env.MOGGING_AGENT) // env-gated agent-CLI TUI smoke
  } else if (process.env.MOGGING_GLOBALHOOKS) {
    runGlobalHooksSmoke(win) // env-gated global Claude alert hooks smoke (the hand-typed-launch gap)
  } else if (process.env.MOGGING_STATE) {
    runStateSmoke(win) // env-gated OSC agent-state smoke
  } else if (process.env.MOGGING_RELOAD) {
    runReloadSmoke(win) // env-gated renderer-reload survival smoke
  } else if (process.env.MOGGING_SMOKE) {
    runSmoke(win) // env-gated runtime smoke test
  } else if (process.env.MOGGING_SHOT) {
    runShot(win) // env-gated visual smoke: capture the window to out/shot.png
  } else if (process.env.MOGGING_MULTIPANE) {
    runMultipaneSmoke(win) // env-gated multi-pane isolation smoke
  } else if (process.env.MOGGING_WORKSPACE) {
    runWorkspaceSmoke(win, process.env.MOGGING_WORKSPACE) // env-gated workspace persist/restore smoke
  } else if (process.env.MOGGING_AGENTLAUNCH) {
    runAgentLaunchSmoke(win) // env-gated agent-launcher smoke (picker -> TUI)
  } else if (process.env.MOGGING_TYPED) {
    runTypedSmoke(win) // env-gated typed-launch DETECTION smoke (a hand-typed agent gets a real identity)
  } else if (process.env.MOGGING_TEMPLATE) {
    runTemplateSmoke(win, process.env.MOGGING_TEMPLATE) // env-gated provider-mix template smoke
  } else if (process.env.MOGGING_PROFPERSIST) {
    runProfpersistSmoke(win, process.env.MOGGING_PROFPERSIST) // env-gated profile-persistence smoke (6/04)
  } else if (process.env.MOGGING_BROWSER) {
    runBrowserSmoke(win) // env-gated browser-dock smoke (6/05)
  } else if (process.env.MOGGING_BROWSERCTL) {
    runBrowserCtlSmoke(win) // env-gated agent-browser-control smoke (6/05b)
  } else if (process.env.MOGGING_BROWSERRACE) {
    runBrowserRaceSmoke(win) // audit regression: delayed A completions never repaint/mutate B
  } else if (process.env.MOGGING_FIRSTRUN) {
    runFirstRunSmoke(win) // env-gated first-run + update-UX smoke (6/06)
  } else if (process.env.MOGGING_PRODUCT) {
    runProductSmoke(win) // env-gated product milestone: installer -> swarm + browser (6/07)
  } else if (process.env.MOGGING_USAGEGLANCE) {
    runUsageGlanceSmoke(win) // env-gated Usage-GLANCE smoke: the CodexBar-recut popover on fixtures (Phase-8.5/08c)
  } else if (process.env.MOGGING_USAGEUI) {
    runUsageUiSmoke(win) // env-gated usage-UI smoke: gauge (re-baselined gauge-only, popover recut → USAGEGLANCE) (Phase-7/03; 8.5/08c)
  } else if (process.env.MOGGING_WEBUSAGE) {
    runWebUsageSmoke(win) // env-gated web-session smoke: paste/store-read consent (7/06)
  } else if (process.env.MOGGING_USAGECLI) {
    runUsageCliSmoke(win) // env-gated usage-CLI smoke: mogging usage verbs over the app endpoint (7/11)
  } else if (process.env.MOGGING_USAGESET) {
    runUsageSetSmoke(win) // env-gated Usage-tab smoke: the full Settings § Usage (7/12)
  } else if (process.env.MOGGING_MCP) {
    runMcpSmoke(win) // env-gated house-MCP-server smoke: both upstreams, catalog-as-data (Phase-8/02)
  } else if (process.env.MOGGING_MCPWRITE) {
    runMcpWriteSmoke(win, process.env.MOGGING_MCPWRITE) // env-gated write-tools-behind-grant smoke (Phase-8/03; DEV = held world)
  } else if (process.env.MOGGING_MCPLOOP) {
    runMcpLoopSmoke(win) // audit regression: status push repaints but never requests another poll
  } else if (process.env.MOGGING_AGENTWEB) {
    runAgentWebSmoke(win, process.env.MOGGING_AGENTWEB) // env-gated agent-web-profile smoke (Phase-8/04; DEV = held real-site world)
  } else if (process.env.MOGGING_PERWS) {
    runPerWsSmoke(win) // env-gated per-workspace-browser smoke: distinct live pages + isolated sessions (Phase-8/07b)
  } else if (process.env.MOGGING_PERWSAGENT) {
    runPerWsAgentSmoke(win) // env-gated per-workspace AGENT-browser smoke: agents drive their own workspace's browser (Phase-8/07c)
  } else if (process.env.MOGGING_VAULTKEYS) {
    runVaultKeysSmoke(win) // env-gated service-key vault smoke: paste-once -> pane env, plaintext nowhere at rest (Phase-8/08)
  } else if (process.env.MOGGING_WSCLOSE) {
    runWsCloseSmoke(win) // env-gated workspace-close smoke: confirm on live work + 5s undo grace (UX audit WS-01)
  } else if (process.env.MOGGING_KBSHORTCUTS) {
    runKbShortcutsSmoke(win) // env-gated keyboard-shortcuts smoke: ? overlay + Settings page (UX audit KB-01)
  } else if (process.env.MOGGING_KBGLOBAL) {
    runKbGlobalSmoke(win) // audit regression: the global chords still reach the app while a TERMINAL holds focus
  } else if (process.env.MOGGING_VERDICTLIVE) {
    runVerdictLiveSmoke(win) // END-TO-END: the REAL hook command, through the REAL daemon, onto the REAL dot
  } else if (process.env.MOGGING_WEBTRAIL) {
    runWebTrailSmoke(win) // env-gated agent-activity-trail smoke: store + emitters + viewer (Phase-8/05)
  } else if (process.env.MOGGING_MCPMGR) {
    runMcpMgrSmoke(win, process.env.MOGGING_MCPMGR) // env-gated MCP-manager smoke (Phase-8/06; DEV/DEVREMOVE = real-home dev-verify)
  } else if (process.env.MOGGING_MCPCAT) {
    runMcpCatSmoke(win, process.env.MOGGING_MCPCAT) // env-gated Integrations-Catalog smoke (Phase-8/07; DEV = real-machine connect)
  } else if (process.env.MOGGING_INTEGUX) {
    runIntegUxSmoke(win) // env-gated integrations-onboarding smoke: guided flow, single-fire, palette verbs (Phase-8/13)
  } else if (process.env.MOGGING_INTEGMILESTONE) {
    runIntegMilestoneSmoke(win) // env-gated integrations MILESTONE: all five directions compose, one fixture world (Phase-8/14)
  } else if (process.env.MOGGING_WIZARDUX) {
    runWizardUxSmoke(win) // env-gated one-page-wizard smoke: three cards, one page, rail beside it (Phase-8.5/02)
  } else if (process.env.MOGGING_WIZARDFAIL) {
    runWizardFailSmoke(win) // audit regression: wizard races/failures roll back and never open a degraded workspace
  } else if (process.env.MOGGING_WIZARDISO) {
    runWizardIsoSmoke(win) // wizard isolation SUCCESS path: real checkbox -> Launch -> shells live in their worktrees
  } else if (process.env.MOGGING_MUTATIONRACE) {
    runMutationRaceSmoke(win) // audit regression: permissions/plans/profile swaps are atomic and visibly pending
  } else if (process.env.MOGGING_AUTHRUNNER) {
    runAuthRunnerSmoke(win) // audit regression: selected auth kinds and plain-shell OAuth completion/error
  } else if (process.env.MOGGING_FOLDERPICK) {
    runFolderPickSmoke(win) // env-gated folder-browser smoke: listing, refusals, keyboard, per-OS roots (Phase-8.5/03)
  } else if (process.env.MOGGING_FILETREE) {
    runFileTreeSmoke(win) // env-gated virtualized file-tree smoke: 10k rows, APG keyboard, tree ARIA, refusal row (Phase-11/02)
  } else if (process.env.MOGGING_EXPLORER) {
    runExplorerSmoke(win) // env-gated explorer-dock smoke: four doors, re-rooting, per-workspace memory, zero-cost-closed (Phase-11/03)
  } else if (process.env.MOGGING_EXPLORERRACE) {
    runExplorerRaceSmoke(win) // audit regression: delayed root loses atomically; sibling prefixes refuse
  } else if (process.env.MOGGING_TREELIVE) {
    runTreeLiveSmoke(win) // env-gated liveness smoke: coalesced batches, capped pool + poll tier, suspend rules (Phase-11/04)
  } else if (process.env.MOGGING_TREEGIT) {
    runTreeGitSmoke(win) // env-gated git-decoration smoke: badges + propagation + ignore dim + the Changes lens (Phase-11/05)
  } else if (process.env.MOGGING_FILEACT) {
    runFileActSmoke(win) // env-gated file-actions smoke: open/reveal via a SPY, copy, send-to-pane, hostile names inert (Phase-11/06)
  } else if (process.env.MOGGING_FILESMILESTONE) {
    runFilesMilestoneSmoke(win) // env-gated Phase-11 MILESTONE: the whole files promise composed + budgets on the composed surface (Phase-11/07)
  } else if (process.env.MOGGING_SETSHELL) {
    runSetShellSmoke(win) // env-gated settings-shell smoke: grouped nav, cards, measured spacing + AA (Phase-8.5/04)
  } else if (process.env.MOGGING_SETAGENTCFG) {
    runSetAgentConfigSmoke(win) // five-provider settings catalog, typed controls, real scope writes, remote honesty
  } else if (process.env.MOGGING_SETINTEG) {
    runSetIntegSmoke(win) // env-gated integrations smoke: disclosure, attention-through-fold, hit targets (Phase-8.5/05)
  } else if (process.env.MOGGING_SETUSAGE) {
    runSetUsageSmoke(win) // env-gated usage tab + popover smoke: overview/disclosure, bug #4/#5, profiles FieldGroups (Phase-8.5/05b)
  } else if (process.env.MOGGING_HOMEUX) {
    runHomeUxSmoke(win) // env-gated Home + first-run smoke: recents cards, checklist bug #1, AA via aa-probe (Phase-8.5/06)
  } else if (process.env.MOGGING_BOARDUX) {
    runBoardUxSmoke(win) // env-gated board + palette smoke: aligned chip row, sticky counts, ⋯ un-clip, delete-confirm, palette rank/highlight (Phase-8.5/07)
  } else if (process.env.MOGGING_FEEDBACKUX) {
    runFeedbackUxSmoke(win) // env-gated feedback-language smoke: toast family, safe confirm (bug #8), review gate/footer, empty-state actions (Phase-8.5/07b)
  } else if (process.env.MOGGING_CHROMEUX) {
    runChromeUxSmoke(win) // env-gated chrome-UX smoke: titlebar cluster, rail scroll-fade, one-line pane header, grid-button scope, AA (Phase-8.5/08)
  } else if (process.env.MOGGING_DOCKUX) {
    runDockUxSmoke(win) // env-gated dock possession + shortcuts smoke: § Blockers #1 guard, possession restyle, KB-01 (Phase-8.5/08b)
  } else if (process.env.MOGGING_RESPONSIVE) {
    runResponsiveSmoke(win) // audit regression: 600/800/1200 rail + both docks + keyboard budget
  } else if (process.env.MOGGING_KBAPG) {
    runKbApgSmoke(win) // audit regression: keyboard + APG for the grid seam, the scrollback, and the stepper
  } else if (process.env.MOGGING_UXMILESTONE) {
    runUxMilestoneSmoke(win) // env-gated UX MILESTONE: the whole revamp composed + budgets unchanged, one fixture world, zero network (Phase-8.5/09)
  } else if (process.env.MOGGING_USAGE) {
    runUsageSmoke(win) // env-gated usage-seam smoke: FAKE adapter only (Phase-7/01)
  } else if (process.env.MOGGING_ATTENTION) {
    runAttentionSmoke(win) // env-gated tab-attention aggregation smoke (Phase-2/01)
  } else if (process.env.MOGGING_CLIPBOARD) {
    runClipboardSmoke(win) // env-gated clipboard smoke: quoting + history ring + drop overlay
  } else if (process.env.MOGGING_BLOCKS) {
    runBlocksSmoke(win) // env-gated command-blocks smoke (Phase-2/02)
  } else if (process.env.MOGGING_CWD) {
    runCwdSmoke(win, process.env.MOGGING_CWD) // universal cwd protocol: daemon auth + in-proc OSC fallback
  } else if (process.env.MOGGING_GIT) {
    runGitSmoke(win) // env-gated per-pane git smoke (Phase-2/03)
  } else if (process.env.MOGGING_NOTIFY) {
    runNotifySmoke(win) // env-gated `mogging notify` smoke (Phase-2/04)
  } else if (process.env.MOGGING_MILESTONE) {
    runMilestoneSmoke(win) // env-gated 16-agent perf milestone smoke (Phase-2/05)
  } else if (process.env.MOGGING_FLICKER) {
    runFlickerSmoke(win) // env-gated terminal-artifact smoke: churn without flicker
  } else if (process.env.MOGGING_PANESCROLL) {
    runPaneScrollSmoke(win) // env-gated pane scroll-anchor + overlay slide-bar smoke
  } else if (process.env.MOGGING_APPSCROLL) {
    runAppScrollSmoke(win) // env-gated app-wide overlay-scrollbar smoke
  } else if (process.env.MOGGING_CONPTY) {
    runConptySmoke(win) // env-gated ConPTY-coherence smoke: resize must never smear the buffer
  } else if (process.env.MOGGING_PANEOPS) {
    runPaneOpsSmoke(win) // env-gated pane-operations smoke: expand modes + close
  } else if (process.env.MOGGING_MOVEPANE) {
    runMovePaneSmoke(win) // env-gated cross-workspace pane MOVE: the PTY must survive it
  } else if (process.env.MOGGING_CONTROL) {
    runControlSmoke(win) // env-gated control-API smoke: list/send/send-key/capture (Phase-3/01)
  } else if (process.env.MOGGING_CONTROL2) {
    runControl2Smoke(win) // env-gated layout-control smoke: open/layout/focus/expand/close (Phase-3/02)
  } else if (process.env.MOGGING_PERCEPTION) {
    runPerceptionSmoke(win) // env-gated perception-budget smoke (docs/07): humans must not notice
  } else if (process.env.MOGGING_WORKTREE) {
    runWorktreeSmoke(win) // env-gated worktree-isolation smoke (Phase-3/03)
  } else if (process.env.MOGGING_REVIEW) {
    runReviewSmoke(win) // env-gated pre-ship review smoke (Phase-3/04)
  } else if (process.env.MOGGING_BOARD) {
    runBoardSmoke(win) // env-gated Kanban-board smoke (Phase-3/05)
  } else if (process.env.MOGGING_BOARDFAIL) {
    runBoardFailSmoke(win) // audit regression: failed agent startup never types card prose into a shell
  } else if (process.env.MOGGING_PERSISTHEALTH) {
    runPersistHealthSmoke(win) // audit regression: degraded persistence/daemon states stay visible and recoverable
  } else if (process.env.MOGGING_ROLERACE) {
    runRoleRaceSmoke(win) // audit regression: roles bind after slow spawn and replay after daemon reconnect
  } else if (process.env.MOGGING_AGENTREGISTRY) {
    runAgentRegistrySmoke(win) // audit regression: live CLI availability reaches every launch surface
  } else if (process.env.MOGGING_PLAINMENU) {
    runPlainMenuSmoke(win) // pane ⋯ launch entries are plain-terminal-only, through the whole lifecycle
  } else if (process.env.MOGGING_UPDATEFAIL) {
    runUpdateFailSmoke(win) // audit regression: a failed update check stays visible and its retry re-checks
  } else if (process.env.MOGGING_A11YMODAL) {
    runA11yModalSmoke(win) // audit regression: modal trap/inert/name, palette combobox, workspace-tab close by keyboard
  } else if (process.env.MOGGING_BROWSERZERO) {
    runBrowserZeroSmoke(win) // audit regression: zero-workspace dock is disabled + explained; consent never lies about saving
  } else if (process.env.MOGGING_SECRETFORMS) {
    runSecretFormsSmoke(win) // audit regression: secrets retained on refusal, scrubbed on success, orphaned vault writes rolled back
  } else if (process.env.MOGGING_BOARDRENDER) {
    runBoardRenderSmoke(win) // audit regression: a push must not steal focus/scroll or leak a listener; ⋯ is a real menu with a keyboard road out of drag-only
  } else if (process.env.MOGGING_ASYNCSTATE) {
    runAsyncStateSmoke(win) // audit regression: every feature shows a real error, re-enables its controls, never fakes an empty state, and a stale response never wins
  } else if (process.env.MOGGING_ORCHESTRATION) {
    runOrchestrationSmoke(win) // env-gated Phase-3 orchestration milestone (Phase-3/06)
  } else if (process.env.MOGGING_SWARM) {
    runSwarmSmoke(win) // env-gated swarm mailbox + roles smoke (Phase-4/01)
  } else if (process.env.MOGGING_LEDGER) {
    runLedgerSmoke(win) // env-gated ownership-ledger smoke (Phase-4/02)
  } else if (process.env.MOGGING_GATE) {
    runGateSmoke(win) // env-gated reviewer-gate smoke (Phase-4/03)
  } else if (process.env.MOGGING_PROFILES) {
    runProfilesSmoke(win) // env-gated profiles + usage-limit failover smoke (Phase-4/04)
  } else if (process.env.MOGGING_REMOTE) {
    runRemoteSmoke(win) // env-gated remote (SSH) pane smoke (Phase-4/05)
  } else if (process.env.MOGGING_SWARMMILESTONE) {
    runSwarmMilestoneSmoke(win) // env-gated Phase-4 swarm milestone (Phase-4/06)
  }
}

prepareRuntime() // userData + channel + inherited-pane scrub, before anything derives a path
installSshShim() // before the daemon spawns (it inherits the env)
// The OTHER half of the entry split (finding 41). boot.ts's hooks let this entry ADD gates; these
// ports let it CHANGE production behaviour where a gate must — the failure injectors behind
// maybeFault(), the FAKE usage adapter, the failing update feed. Production links the same ports
// and installs nothing, so every one of them is a null check and none of their env triggers, or
// their fixture worlds, exist in the shipped bundle (scripts/check-prod-artifact.mjs).
installHarnessPorts() // before bootMain: whenReady registers the handlers that consult the hooks
bootMain({ harness: isSmoke, hooks: { beforeAppSettings, afterAppSettings, afterWindow } })
