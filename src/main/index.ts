import { app, BrowserWindow, type WebContents } from 'electron'
import { getTelemetry, startBackend } from '@backend'
import { createMainWindow } from './window'
import { createElectronContext } from './electron-context'
import { initMainTelemetry } from './telemetry'
import { registerClipboard } from './clipboard'
import { registerAppMenu } from './menu'
import { registerDialogs } from './dialogs'
import { registerShellChrome, wireWindowState } from './shell-chrome'
import { flushTelemetry } from './telemetry'
import { registerAppSettings, disposeAppSettings } from './app-settings'
import { registerAgents, disposeAgentInstalls } from './agents'
import { registerAgentSettings, disposeAgentSettings } from './agent-settings'
import { registerBrowserDock } from './browser-dock'
import { startMcpEndpoint, stopMcpEndpoint } from './mcp-endpoint'
import { registerTemplates } from './templates'
import { registerAttention } from './attention'
import { registerGit } from './git'
import { registerContext } from './context'
import { registerWorktrees } from './worktrees'
import { registerFsBrowse } from './fs-browse'
import { registerExplorer } from './explorer'
import { runFsListSmoke } from './fslist-smoke'
import { runAgentSettingsSmoke } from './agentsettings-smoke'
import { registerReview } from './review'
import { registerBoard } from './board'
import { registerProfiles } from './profiles'
import { registerUsage } from './usage'
import { registerRemotes } from './remotes'
import { runSmoke } from './smoke'
import { runMcpSmoke } from './mcp-smoke'
import { runMcpWriteSmoke } from './mcpwrite-smoke'
import { runAgentWebSmoke } from './agentweb-smoke'
import { runPerWsSmoke } from './perws-smoke'
import { runPerWsAgentSmoke } from './perwsagent-smoke'
import { runVaultKeysSmoke } from './vaultkeys-smoke'
import { runWsCloseSmoke } from './wsclose-smoke'
import { runKbShortcutsSmoke } from './kbshortcuts-smoke'
import { runToolPlanSmoke } from './toolplan-smoke'
import { runIntegSmoke } from './integ-smoke'
import { runEvBridgeSmoke } from './evbridge-smoke'
import { runMcpStatusSmoke } from './mcpstatus-smoke'
import { runWebTrailSmoke } from './webtrail-smoke'
import { runMcpMgrSmoke } from './mcpmgr-smoke'
import { runMcpCatSmoke } from './mcpcat-smoke'
import { runIntegUxSmoke } from './integux-smoke'
import { runIntegMilestoneSmoke } from './integmilestone-smoke'
import { runWizardUxSmoke } from './wizardux-smoke'
import { runFolderPickSmoke } from './folderpick-smoke'
import { runFileTreeSmoke } from './filetree-smoke'
import { runExplorerSmoke } from './explorer-smoke'
import { runTreeLiveSmoke } from './treelive-smoke'
import { runTreeGitSmoke } from './treegit-smoke'
import { runFileActSmoke } from './fileact-smoke'
import { runFilesMilestoneSmoke } from './filesmilestone-smoke'
import { runSetIntegSmoke } from './setinteg-smoke'
import { runSetShellSmoke } from './setshell-smoke'
import { runSetAgentConfigSmoke } from './setagentcfg-smoke'
import { runSetUsageSmoke } from './setusage-smoke'
import { runHomeUxSmoke } from './homeux-smoke'
import { runBoardUxSmoke } from './boardux-smoke'
import { runFeedbackUxSmoke } from './feedbackux-smoke'
import { runChromeUxSmoke } from './chromeux-smoke'
import { runDockUxSmoke } from './dockux-smoke'
import { runUxMilestoneSmoke } from './uxmilestone-smoke'
import { registerIntegrations } from './integrations'
import { registerEventBridge } from './event-bridge'
import { registerTrail } from './trail'
import { registerMcpManager } from './mcp-manager'
import { registerMcpStatus } from './mcp-status'
import { registerServices } from './services'
import { runAgentSmoke } from './agent-smoke'
import { runStateSmoke } from './state-smoke'
import { runReloadSmoke } from './reload-smoke'
import { runShot } from './shot'
import { runMultipaneSmoke } from './multipane-smoke'
import { runWorkspaceSmoke } from './workspace-smoke'
import { runAgentLaunchSmoke } from './agentlaunch-smoke'
import { runTypedSmoke } from './typed-smoke'
import { runTypedCostSmoke } from './typedcost-smoke'
import { runCtxAccuracySmoke } from './ctxaccuracy-smoke'
import { runTemplateSmoke } from './template-smoke'
import { runProfpersistSmoke } from './profpersist-smoke'
import { runBrowserSmoke } from './browser-smoke'
import { runBrowserCtlSmoke } from './browserctl-smoke'
import { runFirstRunSmoke } from './firstrun-smoke'
import { runProductSmoke } from './product-smoke'
import { runUsageSmoke } from './usage-smoke'
import { runUsageUiSmoke } from './usageui-smoke'
import { runUsageGlanceSmoke } from './usageglance-smoke'
import { runWebUsageSmoke } from './webusage-smoke'
import { runUsageCliSmoke } from './usagecli-smoke'
import { runUsageSetSmoke } from './usageset-smoke'
import { runAttentionSmoke } from './attention-smoke'
import { runBlocksSmoke } from './blocks-smoke'
import { runClipboardSmoke } from './clipboard-smoke'
import { runGitSmoke } from './git-smoke'
import { runNotifySmoke } from './notify-smoke'
import { runMilestoneSmoke } from './milestone-smoke'
import { runFlickerSmoke } from './flicker-smoke'
import { runPaneScrollSmoke } from './panescroll-smoke'
import { runAppScrollSmoke } from './appscroll-smoke'
import { runConptySmoke } from './conpty-smoke'
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
import { runMigrateSmoke } from './migrate-smoke'
import { runNotifyHookSmoke } from './notifyhook-smoke'
import { installDeepLinkListeners, registerDeepLink, initialDeepLinkCwd, initialControlCommand } from './deep-link'
import { ControlChannels } from '@contracts'
import { initAutoUpdate } from './updater'
import { fatal, installFatalHandlers } from './fatal'
import { scrubInheritedPaneEnv } from './pane-env'
import { assertNativeModules } from './native-preflight'
import { assertPtyHostSupported } from '@backend/platform/pty-host'
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
// Dev must not share state with the installed app. The packaged package.json carries the SAME
// `name` (and no productName), so both resolve %APPDATA%/mogginglabs-workspace: one Chromium
// profile (the "Unable to move the cache: Access is denied" spam when both run), one
// app-settings.db under two writers (each app's exit clobbers the other's workspace state), and
// one single-instance lock (Electron keys it on userData). `-dev` splits all three at once.
else if (!app.isPackaged) app.setPath('userData', app.getPath('userData') + '-dev')

// The RUNTIME side of the same split (contracts/daemon/protocol.ts, ReleaseChannel): daemon dir,
// control endpoint, and deep-link scheme all key off MOGGING_CHANNEL. Set it here — before any
// module derives a path — and it propagates by inheritance: daemon at spawn, panes from the
// daemon, CLIs from the pane env. Packaged apps CLEAR it (an installed app launched from inside a
// dev pane would otherwise inherit 'dev' and squat the dev channel): derived, never trusted up.
// Smokes stay prod-shaped — they already isolate the whole runtime tree via LOCALAPPDATA.
if (app.isPackaged || process.env.MOGGING_USERDATA) delete process.env.MOGGING_CHANNEL
else process.env.MOGGING_CHANNEL = 'dev'

// The SAME rule, for the same reason, applied to the pane identity the daemon injects: an app
// launched from inside a MoggingLabs pane inherits WHICH pane it came from and WHERE that
// pane's daemon is, then hands both to every child it spawns. `mogging` prefers the inherited
// endpoint over the runtime dir (inside a real pane that is the right answer), so the app's own
// CLI children — every gate's `mogging` call — talked to the HOST's daemon instead of ours, and
// a colliding pane id would have let them mutate the user's live session. Not a pane; do not
// wear a pane's name. (pane-env.ts has the full account; the daemon re-injects the true values
// into each pane it spawns, which is the only place they mean anything.)
const inheritedPaneEnv = scrubInheritedPaneEnv(process.env)
if (inheritedPaneEnv.length) {
  console.warn(`[env] launched from inside a pane — dropped inherited ${inheritedPaneEnv.join(', ')}`)
}

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
let disposeContext: (() => void) | null = null

// CI ONLY (Linux headless): force the libsecret safeStorage backend so the vault
// gates run against a REAL keychain (the CI job stands up an unlocked
// gnome-keyring on the session bus). Production auto-detects the desktop's own
// backend — this switch is set only when MOGGING_CI_KEYRING is exported, never
// in a real install. Must run before app is ready (before any safeStorage use).
if (process.env.MOGGING_CI_KEYRING && process.platform === 'linux') {
  app.commandLine.appendSwitch('password-store', 'gnome-libsecret')
}

// Single-instance + mogging:// deep link so `mogging .` focuses a running app. Skipped under
// smokes (some launch a second instance); normal dev/production runs hold the lock.
//
// "Smoke" means a MOGGING_* GATE is set — not any MOGGING_* var. This was a DENYLIST (any
// MOGGING_* var outside four pane-runtime names counted as a smoke) and it failed OPEN: every
// var it did not know — MOGGING_INPROC (the documented daemon-failure workaround below),
// MOGGING_DEVLOG, MOGGING_DAEMON_IDLE_MS — silently dropped the instance lock, the deep link,
// and auto-update from a REAL run, letting a second full instance share one userData: exactly
// the clobbering the -dev split above exists to prevent. An ALLOWLIST fails CLOSED — an unknown
// var is a normal run. It cannot rot in the sweep either: every gate (scripts/qa-smokes.sh, and
// the single-gate recipe) also sets MOGGING_USERDATA, so a NEW gate is still recognized even if
// its name never lands here — and an isolated userData must not register the OS-global
// deep-link scheme in any case. Dev needs no bypass: it holds its OWN lock via the -dev userData
// (Electron keys the lock on userData), so a dev build runs alongside the installed release.
const SMOKE_ENV: readonly string[] = [
  'MOGGING_USERDATA', 'MOGGING_GATES', 'MOGGING_GALLERY', // isolation + sweep markers, set by every gate
  'MOGGING_SURVIVE', 'MOGGING_MIGRATE', 'MOGGING_NOTIFYHOOK', 'MOGGING_INTEG', 'MOGGING_TOOLPLAN',
  'MOGGING_EVBRIDGE', 'MOGGING_MCPSTATUS', 'MOGGING_AGENT', 'MOGGING_STATE', 'MOGGING_RELOAD',
  'MOGGING_SMOKE', 'MOGGING_SHOT', 'MOGGING_MULTIPANE', 'MOGGING_WORKSPACE', 'MOGGING_AGENTLAUNCH',
  'MOGGING_TEMPLATE', 'MOGGING_PROFPERSIST', 'MOGGING_BROWSER', 'MOGGING_BROWSERCTL', 'MOGGING_FIRSTRUN',
  'MOGGING_PRODUCT', 'MOGGING_USAGEGLANCE', 'MOGGING_USAGEUI', 'MOGGING_WEBUSAGE', 'MOGGING_USAGECLI',
  'MOGGING_USAGESET', 'MOGGING_MCP', 'MOGGING_MCPWRITE', 'MOGGING_AGENTWEB', 'MOGGING_PERWS',
  'MOGGING_PERWSAGENT', 'MOGGING_VAULTKEYS', 'MOGGING_WSCLOSE', 'MOGGING_KBSHORTCUTS', 'MOGGING_WEBTRAIL',
  'MOGGING_MCPMGR', 'MOGGING_MCPCAT', 'MOGGING_INTEGUX', 'MOGGING_INTEGMILESTONE', 'MOGGING_WIZARDUX',
  'MOGGING_FOLDERPICK', 'MOGGING_SETSHELL', 'MOGGING_SETAGENTCFG', 'MOGGING_SETINTEG', 'MOGGING_SETUSAGE', 'MOGGING_HOMEUX',
  'MOGGING_BOARDUX', 'MOGGING_FEEDBACKUX', 'MOGGING_CHROMEUX', 'MOGGING_DOCKUX', 'MOGGING_UXMILESTONE',
  'MOGGING_USAGE', 'MOGGING_ATTENTION', 'MOGGING_CLIPBOARD', 'MOGGING_BLOCKS', 'MOGGING_GIT',
  'MOGGING_NOTIFY', 'MOGGING_MILESTONE', 'MOGGING_FLICKER', 'MOGGING_CONPTY', 'MOGGING_PANEOPS',
  'MOGGING_PANESCROLL', 'MOGGING_APPSCROLL',
  'MOGGING_CONTROL', 'MOGGING_CONTROL2', 'MOGGING_PERCEPTION', 'MOGGING_WORKTREE', 'MOGGING_REVIEW',
  'MOGGING_BOARD', 'MOGGING_ORCHESTRATION', 'MOGGING_SWARM', 'MOGGING_LEDGER', 'MOGGING_GATE',
  'MOGGING_PROFILES', 'MOGGING_REMOTE', 'MOGGING_SWARMMILESTONE',
  // Typed-launch detection + the context gauge (the v6 pack).
  'MOGGING_TYPED', 'MOGGING_TYPEDCOST', 'MOGGING_CTXACCURACY',
  // Phase 11 — Files: the explorer's seven.
  'MOGGING_FSLIST', 'MOGGING_FILETREE', 'MOGGING_EXPLORER', 'MOGGING_TREELIVE', 'MOGGING_TREEGIT',
  'MOGGING_FILEACT', 'MOGGING_FILESMILESTONE', 'MOGGING_AGENTCFG'
]
const isSmoke = SMOKE_ENV.some((k) => !!process.env[k])
const primaryInstance = isSmoke || app.requestSingleInstanceLock()
if (!primaryInstance) app.quit()
// The lock is held from HERE, but registerDeepLink is ~25 s of boot away (daemon migrate +
// start + feature registration). A `mogging .` fired into that gap reached an app with no
// 'second-instance' listener: the second instance exited 0 and the command vanished. Listen
// now — deliveries queue until the window exists.
else if (!isSmoke) installDeepLinkListeners()

installFatalHandlers(isSmoke) // before whenReady: early wiring must not fail silently

function openWindow(): void {
  const w = createMainWindow()
  win = w
  wireWindowState(w) // fullscreen/maximize -> renderer chrome classes (5/04)
  // Only the CURRENT window may clear the pointer: a window re-created for a deep link
  // (ensureWindow) must not be nulled by its predecessor's late 'closed'.
  w.on('closed', () => {
    if (win === w) win = null
  })
}

/** The window, recreated if it is gone (macOS keeps the app alive without one). */
function ensureWindow(): BrowserWindow {
  if (!win || win.isDestroyed()) openWindow()
  return win as BrowserWindow
}

/** The renderer target for every backend/daemon event. `win` is nulled on 'closed', but the
 *  webContents dies BEFORE that event: a daemon socket event landing in the gap threw inside
 *  send(), and the uncaughtException handler turns that into app.exit(1) — closing a window
 *  while agents streamed output hard-exited the app. */
function liveWebContents(): WebContents | null {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return null
  return win.webContents
}

app.whenReady().then(async () => {
  if (!primaryInstance) return // a second instance; the primary handles the deep link + quits us

  assertNativeModules() // stale/missing .node -> exit 1 with the rebuild command, never a broken window
  // Windows < 18309 would silently get a winpty, whose resize semantics the UI does not model.
  // Refuse at boot rather than smear a live agent frame ten minutes in.
  try {
    assertPtyHostSupported()
  } catch (err) {
    fatal(err, 'pty-host')
    return
  }

  // Env-gated app-level survival smoke: two separate launches (A then B) prove an agent
  // in the detached daemon outlives an app quit/relaunch (ADR 0006).
  if (process.env.MOGGING_SURVIVE) {
    await runDaemonSurviveSmoke(process.env.MOGGING_SURVIVE)
    return
  }

  // Windowless daemon-migration smoke: MUST run here — before startDaemonBackend
  // creates this version's sessions.db, the migration's own entry condition.
  if (process.env.MOGGING_MIGRATE) {
    await runMigrateSmoke()
    return
  }

  // Windowless notify-hook smoke: the generated bell script + per-CLI builders,
  // proven against a fake daemon socket — no daemon, no window.
  if (process.env.MOGGING_NOTIFYHOOK) {
    await runNotifyHookSmoke()
    return
  }

  // Windowless explorer-list smoke (11/01): the read service through the exact
  // `explorer:list` validation seam, on a fixture tree — no daemon, no window, zero UI.
  if (process.env.MOGGING_FSLIST) {
    await runFsListSmoke()
    return
  }
  if (process.env.MOGGING_AGENTCFG) {
    await runAgentSettingsSmoke()
    return
  }

  // Windowless tool-plan smoke (8/09): pure materialization + a CLI shim + a
  // real git repo — no daemon, no window.
  if (process.env.MOGGING_INTEG) {
    await runIntegSmoke()
    return
  }
  if (process.env.MOGGING_TOOLPLAN) {
    await runToolPlanSmoke()
    return
  }
  // Windowless COST gate for typed-launch detection: the detector on a fake clock over a fake
  // process table, asserting how many process listings each real-life scenario performs. No
  // daemon, no window — the number it protects is invisible in review (typedcost-smoke.ts).
  if (process.env.MOGGING_TYPEDCOST) {
    await runTypedCostSmoke()
    return
  }
  // Windowless CONTEXT-ACCURACY gate: the real monitor over each CLI's real on-disk format,
  // asserting that the gauge's number is the CLI's own number (ctxaccuracy-smoke.ts).
  if (process.env.MOGGING_CTXACCURACY) {
    await runCtxAccuracySmoke()
    return
  }

  registerAppSettings() // app-level state store first — telemetry reads persisted consent from it

  // Windowless event-bridge smoke (8/10): needs the settings store + vault, no
  // daemon or window — an in-process loopback receiver proves outbound delivery.
  if (process.env.MOGGING_EVBRIDGE) {
    await runEvBridgeSmoke()
    return
  }
  if (process.env.MOGGING_MCPSTATUS) {
    await runMcpStatusSmoke()
    return
  }

  initMainTelemetry(() => win) // observability next, so early errors are captured (opt-in, ADR 0005)

  // The detached PTY daemon (ADR 0006) is now the DEFAULT — full parity with in-proc plus
  // survival across a main crash / app restart. MOGGING_INPROC forces the in-proc backend.
  const startInProc = (): void => {
    const ctx = createElectronContext(liveWebContents)
    disposeBackend = startBackend(ctx)
  }
  if (process.env.MOGGING_INPROC) {
    startInProc()
  } else {
    try {
      disposeBackend = await startDaemonBackend(liveWebContents)
    } catch (err) {
      getTelemetry().captureError(err, { feature: 'daemon', op: 'start', platform: process.platform })
      // A real degradation (no pane survival across restarts). Telemetry is opt-in, so stderr is
      // the only channel that always exists — this fallback used to happen with nothing printed.
      const why = err instanceof Error ? err.message : String(err)
      console.warn(`[daemon] start failed, falling back to the in-proc backend: ${why}`)
      startInProc() // daemon unavailable -> in-proc so the app still works
    }
  }
  registerAppMenu() // explicit menu policy: mac keeps Edit roles, win/linux run menuless
  registerClipboard() // system clipboard IPC (app-layer, Electron-only)
  registerDialogs(() => win) // native directory picker for the new-workspace wizard
  registerShellChrome(() => win) // theme-tinted window-control overlay (organic chrome)
  registerBrowserDock(() => win, isSmoke) // right browser dock: MAIN owns the WebContentsView (6/05)
  registerIntegrations(() => win) // per-workspace integrations grant: store + IPC + fan-out (8/03)
  registerEventBridge(() => win) // outbound event bridge: house events -> user webhooks (8/10)
  registerTrail() // the agent activity trail: local store + viewer IPC (8/05)
  registerMcpManager() // MCP manager: registry + per-CLI config writers (8/06)
  registerMcpStatus(() => win) // MCP connection-status poller: pushed per-(server×cli) grid (8/11)
  registerServices(() => win) // service links: board card <-> GitHub PR/issue, live via gh (8/12)
  startMcpEndpoint() // agent-control transport: the MCP server reaches the dock + grant wire here (6/05b, 8/03)
  // The bundled catalog and IPC surface are installed synchronously before the
  // first await inside registerAgentSettings. Cache/version discovery and startup
  // reconciliation can continue behind first paint; each launch still reconciles
  // its exact target and fails closed.
  const agentSettingsStartup = registerAgentSettings(() => win, isSmoke)
  registerAgents(() => win) // agent launcher: detect/install CLIs + build launch commands (Phase-1/06; Agent CLIs tab)
  registerTemplates() // provider-mix templates: presets + resolveLayout + custom template store (06b)
  registerAttention(() => win) // dock/taskbar badge when a background workspace needs attention (Phase-2/01)
  disposeGit = registerGit(liveWebContents) // read-only per-pane git branch + dirty (Phase-2/03)
  disposeContext = registerContext(liveWebContents) // per-pane agent context bar: tails the CLIs' own session logs (counts only)
  registerWorktrees() // worktree-per-agent isolation: add/list/remove only (Phase-3/03)
  registerFsBrowse() // read-only one-level directory listing for the folder browser (Phase-8.5/03)
  registerExplorer(() => win) // the explorer: read-only listing + the liveness law's watcher pool (Phase-11/01, /04)
  registerReview() // pre-ship diff review: redacted diff + guarded merge (Phase-3/04)
  registerBoard() // local Kanban board: cards that launch agents (Phase-3/05)
  registerProfiles() // provider profiles: pointer sets, deny-listed at save (Phase-4/04)
  registerRemotes() // remote (SSH) hosts: connection pointers only (Phase-4/05)
  registerUsage(() => win) // usage meters: adapters ride CLI-owned sessions (Phase-7/01, ADR 0007)

  openWindow()
  void agentSettingsStartup.catch((err) => {
    getTelemetry().captureError(err, { feature: 'agent-settings', op: 'startup' })
    console.warn('[agent-settings] startup initialization failed')
  })

  if (!isSmoke) {
    registerDeepLink(ensureWindow) // mogging:// -> open/focus a workspace for a directory
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
  } else if (win) {
    // Smokes too. The updater's FEED is what must stay out of them, and it already does —
    // `feedLive` is `app.isPackaged && !MOGGING_FAKE_UPDATE`, so an unpackaged smoke run
    // touches no network whatever we do here. What initAutoUpdate ALSO does is register
    // update:stateGet / update:prefsGet, and the renderer's update UX calls both the moment
    // it mounts: skipping it left every gate with two unhandled-IPC console.errors, which is
    // an error the app would never survive in production and which any smoke that fails on
    // console errors (FLICKER, and the two scroll gates) reads as a real fault. It was one:
    // just not the one they were looking for.
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
  } else if (process.env.MOGGING_TYPED && win) {
    runTypedSmoke(win) // env-gated typed-launch DETECTION smoke (a hand-typed agent gets a real identity)
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
  } else if (process.env.MOGGING_USAGEGLANCE && win) {
    runUsageGlanceSmoke(win) // env-gated Usage-GLANCE smoke: the CodexBar-recut popover on fixtures (Phase-8.5/08c)
  } else if (process.env.MOGGING_USAGEUI && win) {
    runUsageUiSmoke(win) // env-gated usage-UI smoke: gauge (re-baselined gauge-only, popover recut → USAGEGLANCE) (Phase-7/03; 8.5/08c)
  } else if (process.env.MOGGING_WEBUSAGE && win) {
    runWebUsageSmoke(win) // env-gated web-session smoke: paste/store-read consent (7/06)
  } else if (process.env.MOGGING_USAGECLI && win) {
    runUsageCliSmoke(win) // env-gated usage-CLI smoke: mogging usage verbs over the app endpoint (7/11)
  } else if (process.env.MOGGING_USAGESET && win) {
    runUsageSetSmoke(win) // env-gated Usage-tab smoke: the full Settings § Usage (7/12)
  } else if (process.env.MOGGING_MCP && win) {
    runMcpSmoke(win) // env-gated house-MCP-server smoke: both upstreams, catalog-as-data (Phase-8/02)
  } else if (process.env.MOGGING_MCPWRITE && win) {
    runMcpWriteSmoke(win, process.env.MOGGING_MCPWRITE) // env-gated write-tools-behind-grant smoke (Phase-8/03; DEV = held world)
  } else if (process.env.MOGGING_AGENTWEB && win) {
    runAgentWebSmoke(win, process.env.MOGGING_AGENTWEB) // env-gated agent-web-profile smoke (Phase-8/04; DEV = held real-site world)
  } else if (process.env.MOGGING_PERWS && win) {
    runPerWsSmoke(win) // env-gated per-workspace-browser smoke: distinct live pages + isolated sessions (Phase-8/07b)
  } else if (process.env.MOGGING_PERWSAGENT && win) {
    runPerWsAgentSmoke(win) // env-gated per-workspace AGENT-browser smoke: agents drive their own workspace's browser (Phase-8/07c)
  } else if (process.env.MOGGING_VAULTKEYS && win) {
    runVaultKeysSmoke(win) // env-gated service-key vault smoke: paste-once -> pane env, plaintext nowhere at rest (Phase-8/08)
  } else if (process.env.MOGGING_WSCLOSE && win) {
    runWsCloseSmoke(win) // env-gated workspace-close smoke: confirm on live work + 5s undo grace (UX audit WS-01)
  } else if (process.env.MOGGING_KBSHORTCUTS && win) {
    runKbShortcutsSmoke(win) // env-gated keyboard-shortcuts smoke: ? overlay + Settings page (UX audit KB-01)
  } else if (process.env.MOGGING_WEBTRAIL && win) {
    runWebTrailSmoke(win) // env-gated agent-activity-trail smoke: store + emitters + viewer (Phase-8/05)
  } else if (process.env.MOGGING_MCPMGR && win) {
    runMcpMgrSmoke(win, process.env.MOGGING_MCPMGR) // env-gated MCP-manager smoke (Phase-8/06; DEV/DEVREMOVE = real-home dev-verify)
  } else if (process.env.MOGGING_MCPCAT && win) {
    runMcpCatSmoke(win, process.env.MOGGING_MCPCAT) // env-gated Integrations-Catalog smoke (Phase-8/07; DEV = real-machine connect)
  } else if (process.env.MOGGING_INTEGUX && win) {
    runIntegUxSmoke(win) // env-gated integrations-onboarding smoke: guided flow, single-fire, palette verbs (Phase-8/13)
  } else if (process.env.MOGGING_INTEGMILESTONE && win) {
    runIntegMilestoneSmoke(win) // env-gated integrations MILESTONE: all five directions compose, one fixture world (Phase-8/14)
  } else if (process.env.MOGGING_WIZARDUX && win) {
    runWizardUxSmoke(win) // env-gated one-page-wizard smoke: three cards, one page, rail beside it (Phase-8.5/02)
  } else if (process.env.MOGGING_FOLDERPICK && win) {
    runFolderPickSmoke(win) // env-gated folder-browser smoke: listing, refusals, keyboard, per-OS roots (Phase-8.5/03)
  } else if (process.env.MOGGING_FILETREE && win) {
    runFileTreeSmoke(win) // env-gated virtualized file-tree smoke: 10k rows, APG keyboard, tree ARIA, refusal row (Phase-11/02)
  } else if (process.env.MOGGING_EXPLORER && win) {
    runExplorerSmoke(win) // env-gated explorer-dock smoke: four doors, re-rooting, per-workspace memory, zero-cost-closed (Phase-11/03)
  } else if (process.env.MOGGING_TREELIVE && win) {
    runTreeLiveSmoke(win) // env-gated liveness smoke: coalesced batches, capped pool + poll tier, suspend rules (Phase-11/04)
  } else if (process.env.MOGGING_TREEGIT && win) {
    runTreeGitSmoke(win) // env-gated git-decoration smoke: badges + propagation + ignore dim + the Changes lens (Phase-11/05)
  } else if (process.env.MOGGING_FILEACT && win) {
    runFileActSmoke(win) // env-gated file-actions smoke: open/reveal via a SPY, copy, send-to-pane, hostile names inert (Phase-11/06)
  } else if (process.env.MOGGING_FILESMILESTONE && win) {
    runFilesMilestoneSmoke(win) // env-gated Phase-11 MILESTONE: the whole files promise composed + budgets on the composed surface (Phase-11/07)
  } else if (process.env.MOGGING_SETSHELL && win) {
    runSetShellSmoke(win) // env-gated settings-shell smoke: grouped nav, cards, measured spacing + AA (Phase-8.5/04)
  } else if (process.env.MOGGING_SETAGENTCFG && win) {
    runSetAgentConfigSmoke(win) // five-provider settings catalog, typed controls, real scope writes, remote honesty
  } else if (process.env.MOGGING_SETINTEG && win) {
    runSetIntegSmoke(win) // env-gated integrations smoke: disclosure, attention-through-fold, hit targets (Phase-8.5/05)
  } else if (process.env.MOGGING_SETUSAGE && win) {
    runSetUsageSmoke(win) // env-gated usage tab + popover smoke: overview/disclosure, bug #4/#5, profiles FieldGroups (Phase-8.5/05b)
  } else if (process.env.MOGGING_HOMEUX && win) {
    runHomeUxSmoke(win) // env-gated Home + first-run smoke: recents cards, checklist bug #1, AA via aa-probe (Phase-8.5/06)
  } else if (process.env.MOGGING_BOARDUX && win) {
    runBoardUxSmoke(win) // env-gated board + palette smoke: aligned chip row, sticky counts, ⋯ un-clip, delete-confirm, palette rank/highlight (Phase-8.5/07)
  } else if (process.env.MOGGING_FEEDBACKUX && win) {
    runFeedbackUxSmoke(win) // env-gated feedback-language smoke: toast family, safe confirm (bug #8), review gate/footer, empty-state actions (Phase-8.5/07b)
  } else if (process.env.MOGGING_CHROMEUX && win) {
    runChromeUxSmoke(win) // env-gated chrome-UX smoke: titlebar cluster, rail scroll-fade, one-line pane header, grid-button scope, AA (Phase-8.5/08)
  } else if (process.env.MOGGING_DOCKUX && win) {
    runDockUxSmoke(win) // env-gated dock possession + shortcuts smoke: § Blockers #1 guard, possession restyle, KB-01 (Phase-8.5/08b)
  } else if (process.env.MOGGING_UXMILESTONE && win) {
    runUxMilestoneSmoke(win) // env-gated UX MILESTONE: the whole revamp composed + budgets unchanged, one fixture world, zero network (Phase-8.5/09)
  } else if (process.env.MOGGING_USAGE && win) {
    runUsageSmoke(win) // env-gated usage-seam smoke: FAKE adapter only (Phase-7/01)
  } else if (process.env.MOGGING_ATTENTION && win) {
    runAttentionSmoke(win) // env-gated tab-attention aggregation smoke (Phase-2/01)
  } else if (process.env.MOGGING_CLIPBOARD && win) {
    runClipboardSmoke(win) // env-gated clipboard smoke: quoting + history ring + drop overlay
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
  } else if (process.env.MOGGING_PANESCROLL && win) {
    runPaneScrollSmoke(win) // env-gated pane scroll-anchor + overlay slide-bar smoke
  } else if (process.env.MOGGING_APPSCROLL && win) {
    runAppScrollSmoke(win) // env-gated app-wide overlay-scrollbar smoke
  } else if (process.env.MOGGING_CONPTY && win) {
    runConptySmoke(win) // env-gated ConPTY-coherence smoke: resize must never smear the buffer
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
  // Boot is async. Unhandled, a throw here left the app running windowless with exit code 0.
  .catch((err) => fatal(err, 'boot'))

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void flushTelemetry() // best-effort vendor flush (no-op unless the user opted in)
  stopMcpEndpoint() // tear down the agent-control socket + endpoint file (6/05b)
  disposeAgentInstalls() // ephemeral install terminals must not outlive the app
  disposeAgentSettings()
  disposeAppSettings()
  disposeGit?.()
  disposeGit = null
  disposeContext?.()
  disposeContext = null
  disposeBackend?.()
  disposeBackend = null
  void getTelemetry().flush(2000)
})
