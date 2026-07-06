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
  bounds: 'browser:bounds', // renderer -> main: BrowserDockBounds (rAF-throttled view rect)
  state: 'browser:state', // main -> renderer: BrowserDockState (header truth)
  lastUrl: 'browser:lastUrl', // (workspaceId) -> string | null ("open this workspace's preview" chip)
  openExternal: 'browser:openExternal', // ({ url }) -> void (http(s) only, system browser)
  // ── Agent control (6/05b) ──────────────────────────────────────────────
  consentGet: 'browser:consentGet', // (workspaceId) -> boolean (stored per-workspace grant; default OFF)
  consentSet: 'browser:consentSet', // ({ workspaceId, allowed }) -> void (Settings/wizard toggle writes it)
  consent: 'browser:consent', // renderer -> main: { allowed } (make the ACTIVE workspace's grant live)
  agentAct: 'browser:agentAct', // (BrowserAgentVerb) -> BrowserAgentResult (an agent verb; consent-gated)
  activity: 'browser:activity', // main -> renderer: BrowserAgentActivity (possession state + verb trail; NO page content)
  agentStop: 'browser:agentStop' // renderer -> main: void (the human revokes the grant instantly)
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
  keyClear: 'usage:keyClear' // (providerId) -> void
} as const

export const AllChannels: readonly string[] = [
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
