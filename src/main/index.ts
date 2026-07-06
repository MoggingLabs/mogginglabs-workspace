import { app, BrowserWindow } from 'electron'
import { getTelemetry, startBackend } from '@backend'
import { createMainWindow } from './window'
import { createElectronContext } from './electron-context'
import { initMainTelemetry } from './telemetry'
import { registerClipboard } from './clipboard'
import { registerDialogs } from './dialogs'
import { registerShellChrome, wireWindowState } from './shell-chrome'
import { flushTelemetry } from './telemetry'
import { registerAppSettings, disposeAppSettings } from './app-settings'
import { registerAgents } from './agents'
import { registerBrowserDock } from './browser-dock'
import { startMcpEndpoint, stopMcpEndpoint } from './mcp-endpoint'
import { registerTemplates } from './templates'
import { registerAttention } from './attention'
import { registerGit } from './git'
import { registerWorktrees } from './worktrees'
import { registerReview } from './review'
import { registerBoard } from './board'
import { registerProfiles } from './profiles'
import { registerUsage } from './usage'
import { registerRemotes } from './remotes'
import { runSmoke } from './smoke'
import { runAgentSmoke } from './agent-smoke'
import { runStateSmoke } from './state-smoke'
import { runReloadSmoke } from './reload-smoke'
import { runShot } from './shot'
import { runMultipaneSmoke } from './multipane-smoke'
import { runWorkspaceSmoke } from './workspace-smoke'
import { runAgentLaunchSmoke } from './agentlaunch-smoke'
import { runTemplateSmoke } from './template-smoke'
import { runProfpersistSmoke } from './profpersist-smoke'
import { runBrowserSmoke } from './browser-smoke'
import { runBrowserCtlSmoke } from './browserctl-smoke'
import { runFirstRunSmoke } from './firstrun-smoke'
import { runProductSmoke } from './product-smoke'
import { runUsageSmoke } from './usage-smoke'
import { runUsageUiSmoke } from './usageui-smoke'
import { runWebUsageSmoke } from './webusage-smoke'
import { runUsageCliSmoke } from './usagecli-smoke'
import { runUsageSetSmoke } from './usageset-smoke'
import { runAttentionSmoke } from './attention-smoke'
import { runBlocksSmoke } from './blocks-smoke'
import { runGitSmoke } from './git-smoke'
import { runNotifySmoke } from './notify-smoke'
import { runMilestoneSmoke } from './milestone-smoke'
import { runFlickerSmoke } from './flicker-smoke'
import { runPaneOpsSmoke } from './paneops-smoke'
import { runControlSmoke } from './control-smoke'
import { runControl2Smoke } from './control2-smoke'
import { runPerceptionSmoke } from './perception-smoke'
import { runWorktreeSmoke } from './worktree-smoke'
import { runReviewSmoke } from './review-smoke'
import { runBoardSmoke } from './board-smoke'
import { runOrchestrationSmoke } from './orchestration-smoke'
import { runSwarmSmoke } from './swarm-smoke'
import { runLedgerSmoke } from './ledger-smoke'
import { runGateSmoke } from './gate-smoke'
import { runProfilesSmoke } from './profiles-smoke'
import { runRemoteSmoke } from './remote-smoke'
import { runSwarmMilestoneSmoke } from './swarmmilestone-smoke'
import { startDaemonBackend } from './daemon-relay'
import { runDaemonSurviveSmoke } from './daemon-survive-smoke'
import { registerDeepLink, initialDeepLinkCwd, initialControlCommand } from './deep-link'
import { ControlChannels } from '@contracts'
import { initAutoUpdate } from './updater'
import { WorkspaceChannels } from '@contracts'

// App-wiring layer: compose the backend over an Electron context and open the
// window. All real logic lives in @backend and @ui; this file only connects them.
//
// PHASE 0: the backend (and its PTYs) ran in this main process. PHASE 1: the PTYs now live
// in a detached daemon (the DEFAULT) that survives a renderer reload AND a main crash / app
// restart, with full terminal + scrollback + agent-state parity (see docs/adr/0006 and
// src/pty-daemon/). MOGGING_INPROC forces the in-proc backend; daemon startup is also wrapped
// so any failure falls back to in-proc, keeping the app functional.

// Test-support: smokes isolate their persisted state by pointing MOGGING_USERDATA at a
// temp dir. Electron resolves userData through the OS known-folders API, so overriding
// the APPDATA env var alone does NOT isolate it — this explicit hook does.
if (process.env.MOGGING_USERDATA) app.setPath('userData', process.env.MOGGING_USERDATA)

// Remote-pane smoke support (4/05): point the daemon at a FAKE ssh (a node script the
// smoke writes later) BEFORE the daemon spawns, so no smoke ever needs a network.
if ((process.env.MOGGING_REMOTE || process.env.MOGGING_SHOT === 'all') && !process.env.MOGGING_SSH_SHIM) {
  process.env.MOGGING_SSH_SHIM = require('node:path').join(
    require('node:os').tmpdir(),
    `mogging-ssh-shim-${process.pid}.` + (process.platform === 'win32' ? 'cmd' : 'sh')
  )
}

let win: BrowserWindow | null = null
let disposeBackend: (() => void) | null = null
let disposeGit: (() => void) | null = null

// Single-instance + mogging:// deep link so `mogging .` focuses a running app. Skipped under
// smokes (some launch a second instance); normal dev/production runs hold the lock.
const isSmoke = Object.keys(process.env).some((k) => k.startsWith('MOGGING_'))
const primaryInstance = isSmoke || app.requestSingleInstanceLock()
if (!primaryInstance) app.quit()

function openWindow(): void {
  win = createMainWindow()
  wireWindowState(win) // fullscreen/maximize -> renderer chrome classes (5/04)
  win.on('closed', () => {
    win = null
  })
}

app.whenReady().then(async () => {
  if (!primaryInstance) return // a second instance; the primary handles the deep link + quits us

  // Env-gated app-level survival smoke: two separate launches (A then B) prove an agent
  // in the detached daemon outlives an app quit/relaunch (ADR 0006).
  if (process.env.MOGGING_SURVIVE) {
    await runDaemonSurviveSmoke(process.env.MOGGING_SURVIVE)
    return
  }

  registerAppSettings() // app-level state store first — telemetry reads persisted consent from it
  initMainTelemetry(() => win) // observability next, so early errors are captured (opt-in, ADR 0005)

  // The detached PTY daemon (ADR 0006) is now the DEFAULT — full parity with in-proc plus
  // survival across a main crash / app restart. MOGGING_INPROC forces the in-proc backend.
  const startInProc = (): void => {
    const ctx = createElectronContext(() => win?.webContents ?? null)
    disposeBackend = startBackend(ctx)
  }
  if (process.env.MOGGING_INPROC) {
    startInProc()
  } else {
    try {
      disposeBackend = await startDaemonBackend(() => win?.webContents ?? null)
    } catch (err) {
      getTelemetry().captureError(err, { feature: 'daemon', op: 'start', platform: process.platform })
      startInProc() // daemon unavailable -> in-proc so the app still works
    }
  }
  registerClipboard() // system clipboard IPC (app-layer, Electron-only)
  registerDialogs(() => win) // native directory picker for the new-workspace wizard
  registerShellChrome(() => win) // theme-tinted window-control overlay (organic chrome)
  registerBrowserDock(() => win) // right browser dock: MAIN owns the WebContentsView (6/05)
  startMcpEndpoint() // agent-control transport: the MCP server reaches the dock here (6/05b)
  registerAgents() // agent launcher: detect installed CLIs + build launch commands (Phase-1/06)
  registerTemplates() // provider-mix templates: presets + resolveLayout + custom template store (06b)
  registerAttention(() => win) // dock/taskbar badge when a background workspace needs attention (Phase-2/01)
  disposeGit = registerGit(() => win?.webContents ?? null) // read-only per-pane git branch + dirty (Phase-2/03)
  registerWorktrees() // worktree-per-agent isolation: add/list/remove only (Phase-3/03)
  registerReview() // pre-ship diff review: redacted diff + guarded merge (Phase-3/04)
  registerBoard() // local Kanban board: cards that launch agents (Phase-3/05)
  registerProfiles() // provider profiles: pointer sets, deny-listed at save (Phase-4/04)
  registerRemotes() // remote (SSH) hosts: connection pointers only (Phase-4/05)
  registerUsage(() => win) // usage meters: adapters ride CLI-owned sessions (Phase-7/01, ADR 0007)

  openWindow()

  if (!isSmoke) {
    registerDeepLink(() => win) // mogging:// -> open/focus a workspace for a directory
    const initialCwd = initialDeepLinkCwd()
    if (initialCwd && win) {
      const w = win
      const send = (): void => w.webContents.send(WorkspaceChannels.openCwd, initialCwd)
      if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send)
      else send()
    }
    // Cold-start layout verb (mogging://control in argv, already validated).
    const initialControl = initialControlCommand()
    if (initialControl && win) {
      const w = win
      const send = (): void => {
        // Give restore a beat so `open` lands after existing workspaces re-attach.
        setTimeout(() => w.webContents.send(ControlChannels.command, initialControl), 800)
      }
      if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send)
      else send()
    }
    initAutoUpdate(() => win) // auto-update feed -> renderer update UX (packaged; MOGGING_FAKE_UPDATE drives dev/smoke)
  } else if (process.env.MOGGING_FAKE_UPDATE && win) {
    // The FIRSTRUN smoke drives the update UX with a fake version; the real
    // updater stays out of smokes, but this network-free replay must run.
    initAutoUpdate(() => win)
  }

  if (process.env.MOGGING_AGENT && win) {
    runAgentSmoke(win, process.env.MOGGING_AGENT) // env-gated agent-CLI TUI smoke
  } else if (process.env.MOGGING_STATE && win) {
    runStateSmoke(win) // env-gated OSC agent-state smoke
  } else if (process.env.MOGGING_RELOAD && win) {
    runReloadSmoke(win) // env-gated renderer-reload survival smoke
  } else if (process.env.MOGGING_SMOKE && win) {
    runSmoke(win) // env-gated runtime smoke test
  } else if (process.env.MOGGING_SHOT && win) {
    runShot(win) // env-gated visual smoke: capture the window to out/shot.png
  } else if (process.env.MOGGING_MULTIPANE && win) {
    runMultipaneSmoke(win) // env-gated multi-pane isolation smoke
  } else if (process.env.MOGGING_WORKSPACE && win) {
    runWorkspaceSmoke(win, process.env.MOGGING_WORKSPACE) // env-gated workspace persist/restore smoke
  } else if (process.env.MOGGING_AGENTLAUNCH && win) {
    runAgentLaunchSmoke(win) // env-gated agent-launcher smoke (picker -> TUI)
  } else if (process.env.MOGGING_TEMPLATE && win) {
    runTemplateSmoke(win, process.env.MOGGING_TEMPLATE) // env-gated provider-mix template smoke
  } else if (process.env.MOGGING_PROFPERSIST && win) {
    runProfpersistSmoke(win, process.env.MOGGING_PROFPERSIST) // env-gated profile-persistence smoke (6/04)
  } else if (process.env.MOGGING_BROWSER && win) {
    runBrowserSmoke(win) // env-gated browser-dock smoke (6/05)
  } else if (process.env.MOGGING_BROWSERCTL && win) {
    runBrowserCtlSmoke(win) // env-gated agent-browser-control smoke (6/05b)
  } else if (process.env.MOGGING_FIRSTRUN && win) {
    runFirstRunSmoke(win) // env-gated first-run + update-UX smoke (6/06)
  } else if (process.env.MOGGING_PRODUCT && win) {
    runProductSmoke(win) // env-gated product milestone: installer -> swarm + browser (6/07)
  } else if (process.env.MOGGING_USAGEUI && win) {
    runUsageUiSmoke(win) // env-gated usage-UI smoke: gauge + popover on fixtures (Phase-7/03)
  } else if (process.env.MOGGING_WEBUSAGE && win) {
    runWebUsageSmoke(win) // env-gated web-session smoke: paste/store-read consent (7/06)
  } else if (process.env.MOGGING_USAGECLI && win) {
    runUsageCliSmoke(win) // env-gated usage-CLI smoke: mogging usage verbs over the app endpoint (7/11)
  } else if (process.env.MOGGING_USAGESET && win) {
    runUsageSetSmoke(win) // env-gated Usage-tab smoke: the full Settings § Usage (7/12)
  } else if (process.env.MOGGING_USAGE && win) {
    runUsageSmoke(win) // env-gated usage-seam smoke: FAKE adapter only (Phase-7/01)
  } else if (process.env.MOGGING_ATTENTION && win) {
    runAttentionSmoke(win) // env-gated tab-attention aggregation smoke (Phase-2/01)
  } else if (process.env.MOGGING_BLOCKS && win) {
    runBlocksSmoke(win) // env-gated command-blocks smoke (Phase-2/02)
  } else if (process.env.MOGGING_GIT && win) {
    runGitSmoke(win) // env-gated per-pane git smoke (Phase-2/03)
  } else if (process.env.MOGGING_NOTIFY && win) {
    runNotifySmoke(win) // env-gated `mogging notify` smoke (Phase-2/04)
  } else if (process.env.MOGGING_MILESTONE && win) {
    runMilestoneSmoke(win) // env-gated 16-agent perf milestone smoke (Phase-2/05)
  } else if (process.env.MOGGING_FLICKER && win) {
    runFlickerSmoke(win) // env-gated terminal-artifact smoke: churn without flicker
  } else if (process.env.MOGGING_PANEOPS && win) {
    runPaneOpsSmoke(win) // env-gated pane-operations smoke: expand modes + close
  } else if (process.env.MOGGING_CONTROL && win) {
    runControlSmoke(win) // env-gated control-API smoke: list/send/send-key/capture (Phase-3/01)
  } else if (process.env.MOGGING_CONTROL2 && win) {
    runControl2Smoke(win) // env-gated layout-control smoke: open/layout/focus/expand/close (Phase-3/02)
  } else if (process.env.MOGGING_PERCEPTION && win) {
    runPerceptionSmoke(win) // env-gated perception-budget smoke (docs/07): humans must not notice
  } else if (process.env.MOGGING_WORKTREE && win) {
    runWorktreeSmoke(win) // env-gated worktree-isolation smoke (Phase-3/03)
  } else if (process.env.MOGGING_REVIEW && win) {
    runReviewSmoke(win) // env-gated pre-ship review smoke (Phase-3/04)
  } else if (process.env.MOGGING_BOARD && win) {
    runBoardSmoke(win) // env-gated Kanban-board smoke (Phase-3/05)
  } else if (process.env.MOGGING_ORCHESTRATION && win) {
    runOrchestrationSmoke(win) // env-gated Phase-3 orchestration milestone (Phase-3/06)
  } else if (process.env.MOGGING_SWARM && win) {
    runSwarmSmoke(win) // env-gated swarm mailbox + roles smoke (Phase-4/01)
  } else if (process.env.MOGGING_LEDGER && win) {
    runLedgerSmoke(win) // env-gated ownership-ledger smoke (Phase-4/02)
  } else if (process.env.MOGGING_GATE && win) {
    runGateSmoke(win) // env-gated reviewer-gate smoke (Phase-4/03)
  } else if (process.env.MOGGING_PROFILES && win) {
    runProfilesSmoke(win) // env-gated profiles + usage-limit failover smoke (Phase-4/04)
  } else if (process.env.MOGGING_REMOTE && win) {
    runRemoteSmoke(win) // env-gated remote (SSH) pane smoke (Phase-4/05)
  } else if (process.env.MOGGING_SWARMMILESTONE && win) {
    runSwarmMilestoneSmoke(win) // env-gated Phase-4 swarm milestone (Phase-4/06)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void flushTelemetry() // best-effort vendor flush (no-op unless the user opted in)
  stopMcpEndpoint() // tear down the agent-control socket + endpoint file (6/05b)
  disposeAppSettings()
  disposeGit?.()
  disposeGit = null
  disposeBackend?.()
  disposeBackend = null
  void getTelemetry().flush(2000)
})
