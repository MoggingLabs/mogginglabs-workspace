import type { HostedCliId } from '@contracts'
import { showToast } from '../../components'
import { openWorkspaceFromTemplate } from '../../core/workspace/open-service'
import { getWorkspaces } from '../../core/workspace/workspace-info-port'
import { whenPaneLive } from '../../core/terminal/liveness-port'
import { terminalClient } from '../terminal/terminal.client'

export interface IntegrationAuthState {
  phase: 'running' | 'succeeded' | 'failed'
  message: string
}

type Listener = (key: string, state: IntegrationAuthState) => void
const states = new Map<string, IntegrationAuthState>()
const listeners = new Set<Listener>()

const keyFor = (cli: HostedCliId, serverId: string): string => `${cli}:${serverId}`

function publish(key: string, state: IntegrationAuthState): void {
  states.set(key, state)
  for (const listener of listeners) listener(key, state)
}

export function integrationAuthState(cli: HostedCliId, serverId: string): IntegrationAuthState | null {
  return states.get(keyFor(cli, serverId)) ?? null
}

export function onIntegrationAuthState(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Run the CLI's trusted, catalog-owned OAuth command in a visible PLAIN shell.
 * A random completion marker reports the real command exit status back to this
 * settings page; the auth CLI remains fully interactive in its terminal.
 */
export async function runIntegrationAuthorization(opts: {
  cli: HostedCliId
  cliLabel: string
  serverId: string
  serverLabel: string
  command: string
}): Promise<{ ok: boolean; reason?: string }> {
  const { cli, cliLabel, serverId, serverLabel } = opts
  const key = keyFor(cli, serverId)
  if (states.get(key)?.phase === 'running') return { ok: false, reason: 'Authorization is already running.' }
  if (!/^[a-z0-9_-]{1,64}$/i.test(serverId) || !opts.command.trim()) {
    return { ok: false, reason: 'The catalog did not provide a valid authorization command.' }
  }

  const workspaces = getWorkspaces()
  const cwd = workspaces.workspaces.find((workspace) => workspace.id === workspaces.activeId)?.cwd ??
    workspaces.workspaces[0]?.cwd ?? ''
  const opened = openWorkspaceFromTemplate({
    name: `Authorize ${serverLabel}`.slice(0, 28),
    cwd,
    paneCount: 1,
    assignments: ['shell']
  })
  if (!opened) return { ok: false, reason: 'The plain terminal could not be opened.' }

  const paneId = opened.ordinal * 100 + 1
  publish(key, { phase: 'running', message: `Authorization is running in plain terminal ${paneId}.` })
  const live = await whenPaneLive(paneId, 15_000)
  if (!live) {
    publish(key, { phase: 'failed', message: 'The authorization terminal did not become ready.' })
    return { ok: false, reason: 'The authorization terminal did not become ready.' }
  }

  const marker = `__MOG_AUTH_${crypto.randomUUID().replace(/-/g, '')}`
  let tail = ''
  let settled = false
  let timeout: ReturnType<typeof setTimeout>
  let offData = (): void => undefined
  let offExit = (): void => undefined
  const finish = (state: IntegrationAuthState): void => {
    if (settled) return
    settled = true
    clearTimeout(timeout)
    offData()
    offExit()
    publish(key, state)
    showToast({
      tone: state.phase === 'succeeded' ? 'success' : 'danger',
      title: state.phase === 'succeeded' ? `${serverLabel} authorized in ${cliLabel}` : `${serverLabel} authorization failed`,
      body: state.message
    })
  }

  offData = terminalClient.onData((event) => {
    if (Number(event.id) !== paneId) return
    // A themed shell can repaint a long prompt immediately after the marker in
    // the same PTY chunk. Keep a bounded terminal-sized window rather than a
    // prompt-sized guess, or a successful command can remain "running" forever.
    tail = (tail + event.data).slice(-8192)
    const match = new RegExp(`${marker}:(\\d+)`).exec(tail)
    if (!match) return
    const exitCode = Number(match[1])
    finish(
      exitCode === 0
        ? { phase: 'succeeded', message: 'The CLI reported a successful authorization command.' }
        : { phase: 'failed', message: `The CLI authorization command exited with code ${exitCode}. Check its terminal output.` }
    )
  })
  offExit = terminalClient.onExit((event) => {
    if (Number(event.id) === paneId) finish({ phase: 'failed', message: 'The authorization terminal closed before completion.' })
  })
  timeout = setTimeout(
    () => finish({ phase: 'failed', message: 'Authorization did not finish within 15 minutes. Check its terminal and retry.' }),
    15 * 60_000
  )

  const command = opts.command.replace('<id>', serverId)
  const windows = navigator.platform.toUpperCase().includes('WIN')
  const wrapped = windows
    ? `cmd.exe /d /v:on /c "${command} & echo ${marker}:!errorlevel!"`
    : `${command}; __mog_auth_status=$?; printf '\\n${marker}:%s\\n' "$__mog_auth_status"`
  terminalClient.write({ id: paneId, data: wrapped + '\r' })
  showToast({
    tone: 'info',
    title: `Authorizing ${serverLabel}`,
    body: `The ${cliLabel} command is running in plain terminal ${paneId}; finish any browser or device prompt there.`,
    timeout: 9000
  })
  return { ok: true }
}
