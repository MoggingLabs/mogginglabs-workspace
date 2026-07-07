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
  cwd: 'terminal:cwd', // backend -> renderer: a pane reported its cwd (OSC 7)
  setRole: 'terminal:setRole', // renderer -> daemon: swarm role manifest (Phase-4/01)
  limit: 'terminal:limit' // daemon -> renderer: a pane's agent hit a usage limit (Phase-4/04)
} as const

export const ClipboardChannels = {
  write: 'clipboard:write',
  read: 'clipboard:read'
} as const

export const WorkspaceChannels = {
  loadState: 'workspace:loadState',
  saveState: 'workspace:saveState',
  openCwd: 'workspace:openCwd', // main -> renderer: open/focus a workspace for a directory
  attention: 'workspace:attention', // renderer -> main: any workspace needs attention (dock/taskbar badge)
  browseDir: 'workspace:browseDir' // -> native directory picker; resolves to a path or null
} as const

export const AgentChannels = {
  detect: 'agents:detect', // -> AgentInfo[] (which CLIs are installed)
  command: 'agents:command' // (AgentCommandRequest) -> launch command string | null
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
  list: 'board:list', // -> BoardCard[] (local db only — card text is user content)
  save: 'board:save', // (BoardCard) -> upsert
  remove: 'board:remove' // (id) -> void
} as const

export const RemoteChannels = {
  list: 'remotes:list', // -> RemoteHost[] (connection pointers, never secrets)
  save: 'remotes:save', // (RemoteHost) -> boolean
  remove: 'remotes:remove' // (id) -> void
} as const

export const ProfileChannels = {
  list: 'profiles:list', // -> AgentProfile[] (pointer sets, never secrets)
  save: 'profiles:save', // (AgentProfile) -> boolean (false = refused by the deny-list)
  remove: 'profiles:remove' // (id) -> void
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

export const GitChannels = {
  query: 'git:query', // (cwd) -> GitStatus | null (one-shot, read-only)
  watch: 'git:watch', // (GitWatchRequest) -> track a pane's cwd; change events follow
  unwatch: 'git:unwatch', // (GitUnwatchRequest) -> stop tracking a pane
  change: 'git:change' // backend -> renderer: GitStatusEvent (status resolved/changed)
} as const

export const BrowserChannels = {
  init: 'browser:init', // -> BrowserDockInit (persisted open/width, applied at mount)
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
  restart: 'update:restart' // renderer -> main: quitAndInstall (the "Restart now" action)
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
  alert: 'usage:alert', // main -> renderer: UsageAlert (house toast; never OS spam)
  alertCfgGet: 'usage:alertCfgGet', // -> UsageAlertConfig (quiet/warn pcts + confetti opt-in)
  alertCfgSet: 'usage:alertCfgSet', // (partial UsageAlertConfig) -> void
  // 7/10 display options: which plan the gauge mirrors, what the icon shows,
  // how resets render. Paint-only on the renderer; persisted in the KV.
  displayGet: 'usage:displayGet', // -> UsageDisplayConfig
  displaySet: 'usage:displaySet', // (partial UsageDisplayConfig) -> void (persists + re-pushes views)
  displayChanged: 'usage:displayChanged', // main -> renderer: UsageDisplayConfig (pushed on change)
  // 7/12 pace baseline: the work-day window the 02 engine integrates over.
  paceCfgGet: 'usage:paceCfgGet', // -> UsagePaceConfig (workDays + workHours, or nulls = off)
  paceCfgSet: 'usage:paceCfgSet' // (partial UsagePaceConfig) -> void (re-pushes views)
} as const

export const IntegrationsChannels = {
  // Phase-8/03: the per-workspace integrations grant (shape: @contracts/integrations).
  // Grants are tool names + origins — never credentials. Editing UI lands in 06.
  grantGet: 'integrations:grant:get', // (workspaceId) -> WorkspaceIntegrationsGrant (defaults when absent)
  grantSet: 'integrations:grant:set', // (WorkspaceIntegrationsGrant) -> sanitized grant | null (refused shape)
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
  planChanged: 'integrations:plan:changed' // main -> renderer: WorkspaceToolPlan (a plan edit; 11's restart-needed composes)
} as const

export const AllChannels: readonly string[] = [
  ...Object.values(IntegrationsChannels),
  ...Object.values(UsageChannels),
  ...Object.values(UpdateChannels),
  ...Object.values(BrowserChannels),
  ...Object.values(TerminalChannels),
  ...Object.values(ClipboardChannels),
  ...Object.values(WorkspaceChannels),
  ...Object.values(TelemetryChannels),
  ...Object.values(ControlChannels),
  ...Object.values(ShellChannels),
  ...Object.values(AgentChannels),
  ...Object.values(TemplateChannels),
  ...Object.values(WorktreeChannels),
  ...Object.values(ReviewChannels),
  ...Object.values(LedgerChannels),
  ...Object.values(GateChannels),
  ...Object.values(ProfileChannels),
  ...Object.values(RemoteChannels),
  ...Object.values(BoardChannels),
  ...Object.values(GitChannels)
]
