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
  setRole: 'terminal:setRole' // renderer -> daemon: swarm role manifest (Phase-4/01)
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
  titlebarOverlay: 'shell:titlebarOverlay'
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

export const AllChannels: readonly string[] = [
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
  ...Object.values(BoardChannels),
  ...Object.values(GitChannels)
]
