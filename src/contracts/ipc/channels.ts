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
  state: 'terminal:state'
} as const

export const ClipboardChannels = {
  write: 'clipboard:write',
  read: 'clipboard:read'
} as const

export const WorkspaceChannels = {
  loadState: 'workspace:loadState',
  saveState: 'workspace:saveState',
  openCwd: 'workspace:openCwd' // main -> renderer: open/focus a workspace for a directory
} as const

export const AgentChannels = {
  detect: 'agents:detect', // -> AgentInfo[] (which CLIs are installed)
  command: 'agents:command' // (AgentCommandRequest) -> launch command string | null
} as const

export const AllChannels: readonly string[] = [
  ...Object.values(TerminalChannels),
  ...Object.values(ClipboardChannels),
  ...Object.values(WorkspaceChannels),
  ...Object.values(AgentChannels)
]
