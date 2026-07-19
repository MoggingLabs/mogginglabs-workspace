// Channel-name constants, namespaced per feature. The preload builds its security
// allowlist from AllChannels — so adding a feature = add its channel map here and
// spread it into AllChannels. That aggregate is the single intentional shared touch
// point; everything else about a feature lives in its own folder.

export const TerminalChannels = {
  spawn: 'terminal:spawn',
  write: 'terminal:write',
  resize: 'terminal:resize',
  kill: 'terminal:kill',
  data: 'terminal:data',
  exit: 'terminal:exit',
  state: 'terminal:state',
  stateSync: 'terminal:stateSync', // renderer -> backend: a mounting pane PULLS its current state (StateSyncRequest -> AgentState | null)
  cwd: 'terminal:cwd', // backend -> renderer: a pane reported its cwd (OSC 7)
  setRole: 'terminal:setRole', // renderer -> daemon: swarm role manifest (Phase-4/01)
  limit: 'terminal:limit', // daemon -> renderer: a pane's agent hit a usage limit (Phase-4/04)
  agent: 'terminal:agent' // backend -> renderer: an agent CLI process appeared in / left a pane's PTY subtree
} as const

export const ContextChannels = {
  watch: 'context:watch', // renderer -> main: track a pane's agent session (paneId, provider, cwd)
  unwatch: 'context:unwatch', // renderer -> main: stop tracking a pane
  change: 'context:change' // main -> renderer: a pane's context usage changed (null = no bar)
} as const

export const ClipboardChannels = {
  write: 'clipboard:write', // (WriteClipboard) -> void   plain text, the legacy path
  read: 'clipboard:read', // -> string                    plain text, the legacy path
  writeEntry: 'clipboard:writeEntry', // (WriteClipboardEntry) -> void  text | image
  recordDrop: 'clipboard:recordDrop', // (RecordDroppedPaths) -> void  history ONLY, never the system clipboard
  readRich: 'clipboard:readRich', // -> RichClipboard      text + image + file list
  history: 'clipboard:history', // -> ClipboardEntry[]     newest first
  historyChanged: 'clipboard:historyChanged', // main -> renderer: ClipboardHistoryEvent
  restore: 'clipboard:restore', // (ClipboardEntryRef) -> void  put an entry back on the system clipboard
  remove: 'clipboard:remove', // (ClipboardEntryRef) -> void
  clear: 'clipboard:clear', // -> void
  historySet: 'clipboard:historySet', // ({ enabled }) -> void  stop/start RECORDING, main-side
  env: 'clipboard:env' // -> ClipboardEnv  (shell quoting flavor for dropped paths)
} as const

export const WorkspaceChannels = {
  loadState: 'workspace:loadState',
  saveState: 'workspace:saveState',
  exportState: 'workspace:exportState', // explicit save dialog for current metadata when persistence is paused
  openCwd: 'workspace:openCwd', // main -> renderer: open/focus a workspace for a directory
  attention: 'workspace:attention', // renderer -> main: any workspace needs attention (dock/taskbar badge)
  browseDir: 'workspace:browseDir', // -> native directory picker; resolves to a path or null
  lastSession: 'workspace:lastSession', // -> LastSessionInfo | null (Home's restore card; session-log paths never leave main)
  restoreSession: 'workspace:restoreSession' // -> LastSessionInfo | null — same payload, and ARMS main-side exact-session resume intents
} as const

export const RuntimeHealthChannels = {
  get: 'runtime-health:get',
  changed: 'runtime-health:changed',
  retryDaemon: 'runtime-health:retryDaemon'
} as const

export const AgentChannels = {
  detect: 'agents:detect', // -> AgentInfo[] (which CLIs are installed)
  command: 'agents:command', // (AgentCommandRequest) -> AgentCommandResult
  // Settings § Providers: install a missing CLI in an EPHEMERAL background pty —
  // the provider's own one-liner is injected into the user's shell, never parsed
  // or elevated. Explicit user click only; no credentials involved (ADR 0002).
  install: 'agents:install', // (agentId) -> AgentInstallStart ({ ok, reason? })
  installStates: 'agents:installStates', // -> AgentInstallState[] (snapshot, so a late-mounted tab catches up)
  installChanged: 'agents:installChanged' // main -> renderer: AgentInstallState (progress + verdict pushes)
} as const

export const AgentConfigChannels = {
  providers: 'agentConfig:providers',
  catalog: 'agentConfig:catalog',
  snapshot: 'agentConfig:snapshot',
  set: 'agentConfig:set',
  release: 'agentConfig:release',
  refresh: 'agentConfig:refresh',
  changed: 'agentConfig:changed'
} as const

// Global agent alert wiring (the hand-typed-launch gap): the same bell config the launch
// carries session-scoped, written into each CLI's own global config on an EXPLICIT action —
// the generated notify script (and the OpenCode plugin wrapping it) no-op outside a pane,
// which is what makes global wiring safe everywhere else.
export const AgentHookChannels = {
  status: 'agentHooks:status', // -> GlobalHooksStatus (one row per provider: state + files + reason)
  apply: 'agentHooks:apply', // ({ provider }) -> GlobalHooksMutationResult (backup + atomic write, refuses concurrent edits and conflicts)
  remove: 'agentHooks:remove' // ({ provider }) -> GlobalHooksMutationResult (strips OUR entries only; memo-restored booleans)
} as const

export const TemplateChannels = {
  list: 'templates:list', // -> ProviderMixTemplate[] (presets + custom)
  resolve: 'templates:resolve', // (ProviderCount[]) -> ResolvedLayout
  save: 'templates:save', // (ProviderMixTemplate) -> void
  remove: 'templates:remove' // (id) -> void
} as const

export const TelemetryChannels = {
  getConfig: 'telemetry:getConfig', // -> TelemetryRendererConfig (consent + env; no install id)
  setConsent: 'telemetry:setConsent', // (TelemetryConsent) -> persist + re-init adapters live
  event: 'telemetry:event', // renderer -> main: forward a curated product event (send)
  configChanged: 'telemetry:configChanged' // main -> renderer: consent changed, re-init
} as const

export const ControlChannels = {
  /** main -> renderer: a VALIDATED layout control command (Phase-3/02). */
  command: 'control:command'
} as const

export const ShellChannels = {
  /** Renderer -> main: retint the native window-control overlay to match the theme
   *  ({ color, symbolColor }). No-op on platforms without an overlay (macOS). */
  titlebarOverlay: 'shell:titlebarOverlay',
  /** main -> renderer: WindowStateEvent on fullscreen/maximize changes (events only —
   *  never polled). The renderer mirrors it as #app chrome classes. */
  windowState: 'shell:windowState'
} as const

export const WorktreeChannels = {
  create: 'worktrees:create', // (CreateWorktreeRequest) -> CreateWorktreeResult
  list: 'worktrees:list', // (repo) -> WorktreeInfo[] (managed worktrees only)
  remove: 'worktrees:remove' // (RemoveWorktreeRequest) -> RemoveWorktreeResult (dirty-safe)
} as const

export const BoardChannels = {
  // Board v2: main is the ONE writer (revision CAS, field patches); card text is
  // user content — local db only (ADR 0005).
  forWorkspace: 'board:forWorkspace', // (workspaceId) -> Board (find-or-create by the workspace's project key)
  boards: 'board:boards', // -> BoardListing[] (every board + live card count — the switcher's source)
  boardPatch: 'board:boardPatch', // (id, BoardMetaPatch) -> Board | null (name / repoRef / config knobs)
  list: 'board:list', // (boardId) -> BoardCard[] (non-archived, position order)
  archived: 'board:archived', // (boardId) -> BoardCard[] (archived, newest first)
  create: 'board:create', // (BoardCreateRequest) -> BoardCard | null (server assigns id/position/revision)
  patch: 'board:patch', // (BoardPatchRequest) -> BoardPatchResult (CAS: stale revision refused with the fresh card)
  remove: 'board:remove', // (id) -> void (human-only delete; agents archive instead)
  activity: 'board:activity', // (cardId) -> BoardActivity[] (the card's local audit trail)
  changed: 'board:changed', // main -> renderer: { boardId } — any accepted write, any writer (UI, agent, rule, queue)
  // GitHub two-way (ADR 0015): reads ride the user's own gh; WRITES additionally
  // demand the per-board writeBack grant (default OFF, risk-confirmed in the UI).
  ghDetect: 'board:gh:detect', // (boardId) -> BoardGhResult ("owner/repo" from the project's origin remote; persisted)
  ghImport: 'board:gh:import', // ({ boardId, limit? }) -> BoardGhResult (open issues -> linked backlog cards; read-only)
  ghFindPr: 'board:gh:findPr', // (cardId) -> BoardGhResult (PR whose head is the card's branch -> linked; read-only)
  ghPush: 'board:gh:push', // (cardId) -> BoardGhResult (create a GitHub issue from the card — writeBack-gated)
  ghClose: 'board:gh:close' // (cardId) -> BoardGhResult (close the linked issue — writeBack-gated)
} as const

export const RemoteChannels = {
  list: 'remotes:list', // -> RemoteHost[] (connection pointers, never secrets)
  save: 'remotes:save', // (RemoteHost) -> boolean
  remove: 'remotes:remove' // (id) -> void
} as const

export const ProfileChannels = {
  list: 'profiles:list', // -> AgentProfile[] (pointer sets, never secrets)
  save: 'profiles:save', // (AgentProfile) -> boolean (false = refused by the deny-list)
  remove: 'profiles:remove', // (id) -> typed refusal while a workspace references it
  activate: 'profiles:activate' // atomic order swap for one provider
} as const

export const LedgerChannels = {
  owners: 'ledger:owners' // main -> renderer: the live claim set (pushed on change)
} as const

export const GateChannels = {
  approvals: 'gate:approvals' // main -> renderer: live reviewer sign-offs (pushed on change)
} as const

export const ReviewChannels = {
  diff: 'review:diff', // (ReviewDiffRequest) -> ReviewDiff (REDACTED before transport)
  merge: 'review:merge' // (ReviewMergeRequest) -> ReviewMergeResult (clean-repo gated)
} as const

export const FsChannels = {
  listDir: 'fs:listDir', // (ListDirRequest) -> DirResult  — one level, dirs only, read-only
  home: 'fs:home' // -> string  (where the folder browser opens before a cwd exists)
} as const

export const SystemChannels = {
  machine: 'system:machine' // -> MachineSpec (cpu count + total RAM; the pane budget's raw inputs)
} as const

export const ExplorerChannels = {
  // The file explorer's read surface (ADR 0010: a window, not a manager). READ-ONLY
  // BY CONSTRUCTION: no write verb exists here to typecheck against.
  list: 'explorer:list', // (ExplorerListRequest) -> ExplorerResult — one level, files + dirs, typed refusals
  // Liveness (ADR 0010.d) — defined in 11/01, IMPLEMENTED in 11/04:
  watch: 'explorer:watch', // (ExplorerWatchRequest) -> void — the CURRENT expanded set, whole and idempotent
  unwatch: 'explorer:unwatch', // renderer -> main: drop every watcher (explorer closed / workspace switched)
  changed: 'explorer:changed', // main -> renderer: ExplorerChangedEvent (stale dirs, coalesced)
  stats: 'explorer:stats', // -> ExplorerWatchStats (live handle + poll counts; COUNTS only, never a path)
  // Dock CHROME state (11/03), persisted in the app's own KV — the `browser.width`
  // precedent. NOT a write verb in ADR 0010's sense: these reach the settings store,
  // never a mutating fs API on the user's files. The read-only custody stance holds.
  init: 'explorer:init', // -> ExplorerDockInit (open + width + showHidden, read before first paint)
  setOpen: 'explorer:setOpen', // renderer -> main: { open } (persists explorer.open)
  setWidth: 'explorer:setWidth', // renderer -> main: { width } (persists explorer.width; renderer debounces)
  setShowHidden: 'explorer:setShowHidden', // renderer -> main: { showHidden } (persists explorer.showHidden)
  // Phase-11/06 — DELEGATION, not execution. These hand a path to the OS and step back;
  // there is STILL no verb here that writes, renames, moves, deletes, or runs anything.
  root: 'explorer:root', // renderer -> main: (path) the folder on screen — the ACTION GUARD's boundary
  open: 'explorer:open', // (path) -> ExplorerActionResult — shell.openPath: the user's own default app
  reveal: 'explorer:reveal' // (path) -> ExplorerActionResult — shell.showItemInFolder: their own file manager
} as const

export const GitChannels = {
  query: 'git:query', // (cwd) -> GitStatus | null (one-shot, read-only)
  watch: 'git:watch', // (GitWatchRequest) -> track a pane's cwd; change events follow
  unwatch: 'git:unwatch', // (GitUnwatchRequest) -> stop tracking a pane
  change: 'git:change', // backend -> renderer: GitStatusEvent (status resolved/changed)
  // Phase-11/05 — file-level status for the explorer's decorations. These ride the
  // monitor's EXISTING 2.5s tick and its existing per-root spawn: the porcelain lines
  // were already being read and discarded. No new cadence; no per-file poller.
  filesQuery: 'git:filesQuery', // (cwd) -> GitFiles | null (one-shot; null = not a repo, and NO git spawn)
  filesWatch: 'git:filesWatch', // (cwd) -> register a repo root for file-level status (emits at once, then on change)
  filesUnwatch: 'git:filesUnwatch', // (cwd) -> stop; the last root out stops the tick, as before
  filesChange: 'git:filesChange', // backend -> renderer: GitFilesEvent (change-only — an idle repo is silent)
  checkIgnore: 'git:checkIgnore' // (GitCheckIgnoreRequest) -> string[] ignored subset (ONE spawn; the caller caches)
} as const

export const BrowserChannels = {
  init: 'browser:init', // -> BrowserDockInit (persisted open/width, applied at mount)
  activate: 'browser:activate', // ({ workspaceId }) -> void; switches state source without navigating
  toggle: 'browser:toggle', // ({ open, workspaceId? }) -> void (open restores the workspace's last url)
  navigate: 'browser:navigate', // ({ url, workspaceId }) -> void (http(s) only; persists lastUrl per workspace)
  nav: 'browser:nav', // ({ action }) -> void (back | forward | reload)
  // 8/07 <webview> migration: the guest page is an in-DOM <webview>, so there
  // is NO main-owned view to position — resize is pure DOM (lockstep, zero
  // artifacts). The renderer registers each guest's webContents id so main can
  // still drive it (agent control, screenshots, cookies) via webContents.fromId.
  guest: 'browser:guest', // renderer -> main: { profile, id } — a guest webview became ready (its webContents id)
  guestGone: 'browser:guestGone', // renderer -> main: { profile } — a guest webview was destroyed (recreate/agent-web reset)
  recreateGuest: 'browser:recreateGuest', // main -> renderer: { workspaceId, profile } — tear down + recreate that guest (smoke persistence arm)
  materialize: 'browser:materialize', // main -> renderer: { workspaceId } — create a workspace's guests on demand (an agent drives a workspace the human never opened, 8/07c)
  possession: 'browser:possession', // main -> renderer: { attached: string[], driving: string[] } — workspaces an agent is attached to / driving (pin from eviction + tab indicator)
  persistWidth: 'browser:persistWidth', // renderer -> main: { dockWidth } — persist the dock width (debounced by the renderer)
  state: 'browser:state', // main -> renderer: BrowserDockState (header truth)
  lastUrl: 'browser:lastUrl', // (workspaceId) -> string | null ("open this workspace's preview" chip)
  openExternal: 'browser:openExternal', // ({ url }) -> void (http(s) only, system browser)
  contextMenu: 'browser:contextMenu', // main -> renderer: BrowserContextMenuParams (right-click in the guest → the house menu)
  guestChord: 'browser:guestChord', // main -> renderer: BrowserGuestChord (an app shortcut pressed while the guest holds focus, F12)
  devtools: 'browser:devtools', // renderer -> main: { x?, y? } — open DevTools on the active guest (F8)
  permissionBlocked: 'browser:permissionBlocked', // main -> renderer: { permission } — a guest permission was denied (honest chip, F16)
  // ── Tabs (F4) ──────────────────────────────────────────────────────────
  tabActivate: 'browser:tabActivate', // renderer -> main: { workspaceId, profile, tabId } — the active tab per (workspace, profile), so the driver resolves it
  tabsState: 'browser:tabsState', // renderer -> main: BrowserTabsState — the tab list + active id (main caches it for browser_tab_list)
  tabOpen: 'browser:tabOpen', // main -> renderer: { workspaceId, profile, url? } — open a new tab (window.open / browser_tab_new)
  tabSelect: 'browser:tabSelect', // main -> renderer: { workspaceId, profile, tabId } — activate a tab (browser_tab_select)
  // ── Agent control (6/05b) ──────────────────────────────────────────────
  consentGet: 'browser:consentGet', // (workspaceId) -> boolean (stored per-workspace grant; default OFF)
  consentSet: 'browser:consentSet', // ({ workspaceId, allowed }) -> void (Settings/wizard toggle writes it)
  consent: 'browser:consent', // renderer -> main: { allowed } (make the ACTIVE workspace's grant live)
  agentAct: 'browser:agentAct', // (BrowserAgentVerb) -> BrowserAgentResult (an agent verb; consent-gated)
  activity: 'browser:activity', // main -> renderer: BrowserAgentActivity (possession state + verb trail; NO page content)
  agentStop: 'browser:agentStop', // renderer -> main: void (the human revokes the grant instantly)
  // ── Agent web profile (8/04, ADR 0008.e). Cookie/session verbs exist ONLY
  //    for OUR agent-web partition — the system browser is never touched. ──
  profileGet: 'browser:profileGet', // (workspaceId) -> BrowserProfile (persisted per workspace; default preview)
  profileSet: 'browser:profileSet', // ({ workspaceId, profile }) -> void (attach-swaps the dock's view)
  confirmOrigin: 'browser:confirmOrigin', // renderer -> main: { origin } (the banner's session-scoped allow)
  originAlert: 'browser:originAlert', // main -> renderer: { from, to } (agent-web crossed origins)
  signedInSites: 'browser:signedInSites', // -> BrowserSignedInSite[] (agent-web partition only)
  forgetSite: 'browser:forgetSite', // (host) -> void (cookies.remove + clearStorageData for that site)
  clearAgentLogins: 'browser:clearAgentLogins' // -> void (clear the WHOLE agent-web partition)
} as const

export const UpdateChannels = {
  state: 'update:state', // main -> renderer: UpdateState (checking/available/downloading/ready/error)
  restart: 'update:restart', // renderer -> main: quitAndInstall (the "Restart now" action)
  check: 'update:check', // renderer -> main: re-check now (the rail row's retry; the "Check now" button)
  stateGet: 'update:stateGet', // -> UpdateState (a PULL: settings mounts long after the last push)
  prefsGet: 'update:prefsGet', // -> UpdatePrefs
  prefsSet: 'update:prefsSet' // (UpdatePrefs) -> void (applied immediately, persisted)
} as const

export const UsageChannels = {
  list: 'usage:list', // -> PlanUsageView[] (cached snapshot — instant, never fetches)
  refresh: 'usage:refresh', // renderer -> main: poke the poller (results arrive via the push)
  changed: 'usage:changed', // main -> renderer: PlanUsageView[] (pushed on snapshot change)
  configGet: 'usage:configGet', // -> UsageConfig (per-provider enable + cadence + key PRESENCE — never a key)
  configSet: 'usage:configSet', // (UsageConfigPatch) -> void (persists + reschedules the poller live)
  // Keys are WRITE-ONLY (ADR 0007.a): set encrypts immediately, clear removes.
  // There is deliberately NO usage:keyGet — absence of the channel is the guarantee.
  keySet: 'usage:keySet', // ({ providerId, plaintext } | { providerId, envRef }) -> { ok, reason? }
  keyClear: 'usage:keyClear', // (providerId) -> void
  // web-session (ADR 0007.b): a pasted cookie rides the SAME write-only key
  // store (keySet); this toggles the per-provider browser store-read opt-in.
  webReadSet: 'usage:webReadSet', // ({ providerId, enabled }) -> void (default OFF)
  // 7/07 cost + history. The cost scan reads LOCAL logs ON DEMAND (it touches
  // disk — never on the poll cadence, zero network); history returns OUR own
  // sampled percentages from the KV ring (counts, not content — ADR 0005).
  cost: 'usage:cost', // (providerId) -> CostScan (local JSONL scan; empty+reason when absent)
  history: 'usage:history', // ({ providerId, window }) -> number[] (bounded sparkline series)
  // 7/08 status feed: PUBLIC endpoints, ENABLED providers only, one shared
  // jittered cadence. Enum + note text for rendering; nothing here can carry
  // a credential, and only the enum/booleans may reach telemetry (ADR 0005).
  status: 'usage:status', // -> ProviderStatus[] (cached snapshot)
  statusChanged: 'usage:statusChanged', // main -> renderer: ProviderStatus[] (pushed on state change)
  // 7/09 threshold alerts: copy composed main-side (ONE wording source, the
  // verdict line rides verbatim); single-fire state persisted app-side.
  // Delivery is GUARANTEED (phase-11 rebuild): every alert rides a KV outbox
  // until the renderer acks it — the boot race and a hidden window turn a
  // toast into a replay, never a loss.
  alert: 'usage:alert', // main -> renderer: UsageAlert & { alertId } (house toast; never OS spam)
  alertDrain: 'usage:alertDrain', // renderer -> main on mount: -> (UsageAlert & { alertId })[] still un-acked
  alertAck: 'usage:alertAck', // (alertId) -> void (the toast RENDERED; drop it from the outbox)
  alertCfgGet: 'usage:alertCfgGet', // -> UsageAlertConfig (quiet/warn pcts + confetti + credits floors)
  alertCfgSet: 'usage:alertCfgSet', // (partial UsageAlertConfig) -> void
  // 7/10 display options: which plan the gauge mirrors, what the icon shows,
  // how resets render. Paint-only on the renderer; persisted in the KV.
  displayGet: 'usage:displayGet', // -> UsageDisplayConfig
  displaySet: 'usage:displaySet', // (partial UsageDisplayConfig) -> void (persists + re-pushes views)
  displayChanged: 'usage:displayChanged' // main -> renderer: UsageDisplayConfig (pushed on change)
  // (The 7/12 pace-baseline channels are gone with the feature: pace is pure
  // burn-rate arithmetic now — usage consumed vs time elapsed vs time left.)
} as const

export const IntegrationsChannels = {
  // Phase-8/03: the per-workspace integrations grant (shape: @contracts/integrations).
  // Grants are tool names + origins — never credentials. Editing UI lands in 06.
  grantGet: 'integrations:grant:get', // (workspaceId) -> WorkspaceIntegrationsGrant (defaults when absent)
  grantSet: 'integrations:grant:set', // (WorkspaceIntegrationsGrant) -> sanitized grant | null (refused shape)
  grantMutate: 'integrations:grant:mutate', // operation against the latest stored grant
  grantChanged: 'integrations:grant:changed', // main -> renderer: WorkspaceIntegrationsGrant (pushed on any change)
  // Phase-8/05: the agent activity trail — LOCAL forever. These three ARE the
  // viewer's whole surface; entries are refs only and never reach telemetry.
  trailList: 'integrations:trail:list', // (workspaceId | '') -> TrailEntry[] (oldest first; '' = all workspaces)
  trailClear: 'integrations:trail:clear', // (workspaceId) -> void (exactly that workspace's file)
  trailExport: 'integrations:trail:export', // (workspaceId | '') -> boolean (LOCAL save dialog; true = saved)
  // Phase-8/06: the MCP manager — register once, fan out per CLI dialect.
  // Registration is CONFIG in files the CLIs own; the app never runs,
  // proxies, or authenticates a server (ADR 0008.b). Env values are ${VAR}
  // references only; writes are surgical, backed up, and user-initiated.
  serversList: 'integrations:servers:list', // -> McpServerEntry[] (the built-in house row first)
  serversSave: 'integrations:servers:save', // (McpServerEntry) -> { ok, reason? } (secret-shaped literals refused)
  serversRemove: 'integrations:servers:remove', // (id) -> { ok, reason? } (refused while applied anywhere)
  mgrStatus: 'integrations:mgr:status', // (serverId) -> McpCliStatus[] (read-only; drift detected, never healed)
  mgrPreview: 'integrations:mgr:preview', // ({ serverId, cli, action }) -> { file, block, summary }
  mgrApply: 'integrations:mgr:apply', // ({ serverId, cli }) -> { ok, reason?, backup? } (same-session backup first)
  mgrRemoveFrom: 'integrations:mgr:removeFrom', // ({ serverId, cli }) -> { ok, reason? } (clean extraction of OUR entry)
  mgrAdopt: 'integrations:mgr:adopt', // ({ serverId, cli }) -> void (accept the hand-edited block as ours)
  mgrBackups: 'integrations:mgr:backups', // (cli) -> string[] (this target's .bak files, newest first)
  // Phase-8/07: the Integrations Catalog — presets as data, three open
  // on-ramps (registry search / custom / import), ONE pipeline into the 06
  // writers. We never run, proxy, or authenticate a server (ADR 0008.b).
  catList: 'integrations:cat:list', // -> { presets: McpPreset[], custom: McpPreset[] } (roster-ordered; custom = community)
  catCapabilities: 'integrations:cat:capabilities', // -> CliCapability[] (remote/OAuth floors; gaps dim chips)
  catPrepare: 'integrations:cat:prepare', // ({ presetId, baseUrl?, authKind? }) -> { ok, entries?, reason? }
  catConnect: 'integrations:cat:connect', // ({ presetId, baseUrl?, authKind?, clis }) -> per-CLI apply results (save + write pipeline)
  catRegistry: 'integrations:cat:registry', // (search) -> { ok, drafts?, reason? } (DRAFT-badged, never trusted)
  catImport: 'integrations:cat:import', // (json string) -> { ok, reason? } (same refusals as every on-ramp)
  catExport: 'integrations:cat:export', // (presetId) -> boolean (LOCAL save dialog)
  catRefresh: 'integrations:cat:refresh', // (presetId) -> { ok, diff?, reason? } (update FEED: preview only, never applied)
  catAuthStatus: 'integrations:cat:authStatus', // ({ serverId, cli }) -> CliServerState (the CLI's own list output, presence only)
  // Phase-8/08: vault SERVICE KEYS — paste once, materialized into pane
  // environments at launch. WRITE-ONLY: set / clear / list-presence only.
  // There is deliberately NO serviceKey:get — the value materializes only into
  // the spawn env map, in main; no channel can carry it to a renderer.
  serviceKeySet: 'integrations:serviceKey:set', // ({ name, value }) -> { ok, reason? } (secret VALUE -> vault ciphertext)
  serviceKeyClear: 'integrations:serviceKey:clear', // (name) -> void
  serviceKeyList: 'integrations:serviceKey:list', // -> string[] (env NAMEs with a stored key; presence only, never values)
  // Phase-8/09: the per-workspace TOOL PLAN — which servers reach a workspace's
  // panes, per CLI. Materialized at pane launch; scoping is context hygiene.
  planGet: 'integrations:plan:get', // (workspaceId) -> WorkspaceToolPlan
  planSet: 'integrations:plan:set', // (WorkspaceToolPlan) -> WorkspaceToolPlan (sanitized)
  planMutate: 'integrations:plan:mutate', // cell/inherit operation against the latest plan
  planChanged: 'integrations:plan:changed', // main -> renderer: WorkspaceToolPlan (a plan edit; 11's restart-needed composes)
  planCoverage: 'integrations:plan:coverage', // -> { counts: {serverId: n}, total } for the catalog "in N of M workspaces" badge
  // Phase-8/10: the outbound event bridge — house events -> user webhooks.
  webhookList: 'integrations:webhook:list', // -> WebhookView[] (masked url + health; never the URL literal)
  webhookSave: 'integrations:webhook:save', // ({ id?, label, url?, envRef?, events, workspaceId?, insecureAck }) -> { ok, reason? }
  webhookRemove: 'integrations:webhook:remove', // (id) -> void
  webhookTest: 'integrations:webhook:test', // (id) -> void (fires a fixture 'notify' event at that webhook)
  webhookHealthChanged: 'integrations:webhook:health', // main -> renderer: WebhookView[] (health chip updates)
  // Phase-8/11: MCP connection status — a pushed per-(server×cli) grid.
  statusGet: 'integrations:status:get', // -> McpStatusSnapshot (last snapshot, no fetch)
  statusRefresh: 'integrations:status:refresh', // () -> void (poll now — Settings-open / after apply / on demand)
  statusChanged: 'integrations:status:changed', // main -> renderer: McpStatusSnapshot (poller push)
  authNag: 'integrations:status:authNag', // main -> renderer: { serverId, cli, serverLabel, cliLabel } — ONE per epoch, Re-authorize toast (8/13)
  // Phase-8/12: service links (a board card <-> a GitHub PR/issue).
  linkGet: 'integrations:link:get', // (cardId) -> ServiceLink | null
  linkSet: 'integrations:link:set', // ({ cardId, input, cadence?, kind? }) -> { ok, reason?, link? }
  linkRemove: 'integrations:link:remove', // (linkId) -> void
  linkStatusGet: 'integrations:link:statusGet', // -> { statuses: LinkStatus[], at }
  linkRefresh: 'integrations:link:refresh', // (linkId) -> void
  linkStatusChanged: 'integrations:link:statusChanged' // main -> renderer: { statuses, at }
} as const

// ── Connections (ADR 0014) — the app IS the OAuth client ────────────────────
// The app holds ONE grant per service as vault ciphertext and proxies the CLIs
// to the server, so no token reaches a CLI config or store. Read the whole
// stance in contracts/integrations/connections.ts.
//
// There is deliberately NO `connection:token:get`, and there never will be: the
// access token materializes only inside main, at the moment it is attached to an
// outbound request. No channel here can carry it to a renderer — the same
// structural write-only discipline as the 8/08 service keys.
export const ConnectionsChannels = {
  list: 'connections:list', // -> Connection[] (secret-free; the card grid's whole source)
  connect: 'connections:connect', // ({ serviceId, baseUrl? }) -> { ok, reason? } — opens CONSENT IN THE USER'S BROWSER; resolves when the flow STARTS, not when it lands
  submitKey: 'connections:submitKey', // ({ serviceId, value, baseUrl? }) -> { ok, reason? } — key-auth on-ramp: VERIFIED against the live server, then vaulted
  setClient: 'connections:setClient', // ({ serviceId, clientId, clientSecret?, baseUrl? }) -> { ok, reason? } — pre-registered OAuth client for no-DCR providers (Google/GitHub/Slack); WRITE-ONLY (no getter, the 8/08 discipline), then straight into consent
  clearClient: 'connections:clearClient', // (serviceId) -> { ok, reason? } — forget a pasted client id (and its vaulted secret) for this service's sign-in server
  cancel: 'connections:cancel', // (serviceId) -> void — abandon a pending browser consent (closes the loopback port; the card returns to disconnected)
  disconnect: 'connections:disconnect', // (serviceId) -> void (drops the token vault slot + the metadata; a user-pasted client id/secret stays for one-click reconnects until clearClient — and the vendor-side revoke is theirs)
  verify: 'connections:verify', // (serviceId) -> Connection (initialize + tools/list, right now — proof, not a poll)
  changed: 'connections:changed' // main -> renderer: Connection[] (pushed on every state change; the browser lands here)
} as const

export const AccountChannels = {
  // CLAIMS-ONLY status — { state, email?, plan? }. By construction NEVER a token
  // (ADR 0016): the write-only custody discipline means no channel here has a getter.
  status: 'account:status', // -> AccountStatus (identity + plan claims; no token, ever)
  login: 'account:login', // -> { ok, reason? } — opens consent IN THE USER'S BROWSER; resolves when the flow STARTS, not when it lands
  logout: 'account:logout', // -> void — clears the vaulted refresh token + DPoP key + in-memory access token
  changed: 'account:changed' // main -> renderer: AccountStatus (pushed on every state change; still claims only)
} as const

export const EntitlementsChannels = {
  // CLAIMS cross IPC; secrets do not (ADR 0016). The snapshot is plan + features +
  // effective limits + graceState — the entitlement JWT itself never rides a channel,
  // and there is no verb here that could fetch, replace, or export it.
  snapshot: 'entitlements:snapshot', // -> EntitlementsSnapshot (instant, from the local engine — never a network wait)
  changed: 'entitlements:changed' // main -> renderer: EntitlementsSnapshot (pushed when a refresh/degrade changes the answer)
} as const

export const BrainChannels = {
  // The workspace brain (ADR 0018): READS are free to every pane; this step is
  // lifecycle only — identity, status, typed refusals. Disk MUTATION over MCP rides
  // the per-workspace grant when the tools land (ADR 0018.e); nothing here writes
  // a user file, and no path or symbol from these payloads may reach telemetry.
  status: 'brain:status', // (BrainRootRequest) -> BrainStatus | BrainRefusal (never throws)
  rebuild: 'brain:rebuild', // (BrainRootRequest) -> BrainStatus | BrainRefusal (bumps generation; 03 adds the re-index)
  map: 'brain:map', // ({ root, budget? }) -> the serve layer's brain.map reply (06: the repomap door for the launch seam)
  orientGet: 'brain:orientGet', // (workspaceId) -> boolean (default TRUE — new agents start oriented unless opted out)
  orientSet: 'brain:orientSet', // ({ workspaceId, on }) -> { ok } (persisted main-side with the other per-workspace knobs)
  libFetchGet: 'brain:libFetchGet', // (workspaceId) -> boolean (default FALSE — registry doc fetches are opt-in, per workspace; ADR 0018/08)
  libFetchSet: 'brain:libFetchSet', // ({ workspaceId, on }) -> { ok } (the orient knob's discipline, consent semantics)
  semGet: 'brain:semGet', // (workspaceId) -> boolean (default FALSE — semantic memory recall is opt-in, per workspace; ADR 0018 revision A)
  semSet: 'brain:semSet', // ({ workspaceId, on }) -> { ok } (consent semantics; ON nudges the embed pass so the lens does not wait for the next edit)
  semCfgGet: 'brain:semCfgGet', // (workspaceId) -> BrainSemConfig (endpoint, model, key PRESENCE — a key byte never rides any channel, ADR 0007.a)
  semCfgSet: 'brain:semCfgSet', // ({ workspaceId, endpoint, model }) -> { ok, reason? } (BYO only — no default endpoint exists to fall back to)
  semKeySet: 'brain:semKeySet', // ({ workspaceId, plaintext } | { workspaceId, envRef }) -> { ok, reason? } (write-only: vault ciphertext or an env-ref NAME at rest)
  semKeyClear: 'brain:semKeyClear', // (workspaceId) -> { ok }
  semFailure: 'brain:semFailure', // main -> renderer: { workspaceId, detail } — the embed pass failed; fired ONCE per latch (the single-fire toast)
  read: 'brain:read', // (BrainReadRequest) -> the serve layer's reply for one READ verb (the Brain view's door — same caps, same refusals as the agent wire)
  overview: 'brain:overview', // (BrainRootRequest) -> BrainOverviewAnswer (status-card extras the store already holds: memory/dangling counts, ecosystems)
  changed: 'brain:changed' // main -> renderer: BrainChangedEvent ({ projectKey, generation, dirty })
} as const

export const AllChannels: readonly string[] = [
  ...Object.values(AgentHookChannels),
  ...Object.values(IntegrationsChannels),
  ...Object.values(ConnectionsChannels),
  ...Object.values(AccountChannels),
  ...Object.values(EntitlementsChannels),
  ...Object.values(UsageChannels),
  ...Object.values(UpdateChannels),
  ...Object.values(BrowserChannels),
  ...Object.values(TerminalChannels),
  ...Object.values(ContextChannels),
  ...Object.values(ClipboardChannels),
  ...Object.values(WorkspaceChannels),
  ...Object.values(RuntimeHealthChannels),
  ...Object.values(TelemetryChannels),
  ...Object.values(ControlChannels),
  ...Object.values(ShellChannels),
  ...Object.values(AgentChannels),
  ...Object.values(AgentConfigChannels),
  ...Object.values(TemplateChannels),
  ...Object.values(WorktreeChannels),
  ...Object.values(ReviewChannels),
  ...Object.values(LedgerChannels),
  ...Object.values(GateChannels),
  ...Object.values(ProfileChannels),
  ...Object.values(RemoteChannels),
  ...Object.values(BoardChannels),
  ...Object.values(BrainChannels),
  ...Object.values(GitChannels),
  ...Object.values(FsChannels),
  ...Object.values(SystemChannels),
  ...Object.values(ExplorerChannels)
]
