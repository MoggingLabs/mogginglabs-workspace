// App-wide command registry: every feature publishes its actions here; the command
// palette lists them and anything can run one by id (the rail's Home/Settings buttons,
// keyboard shortcuts, …). Sources re-publish their own list when it changes (e.g. the
// workspace feature republishes "switch to <name>" entries as workspaces come and go).

import { showToast } from '../../components'
import { getCommandContext, type CommandAvailability, type CommandContext } from './context'

export type { CommandAvailability, CommandContext } from './context'

export interface Command {
  id: string
  title: string
  /** Optional grouping hint shown dimmed in the palette (e.g. "Workspace"). */
  hint?: string
  /** Accelerator label (display only — bindings live with the owning feature). */
  kbd?: string
  run: () => void
  /**
   * When may this run? Omit and it always may — every existing command keeps working
   * unchanged. Returning a refusal makes the palette dim the row and PRINT the reason,
   * rather than the old habit of running anyway and toasting an apology afterwards.
   */
  enabled?: (ctx: CommandContext) => CommandAvailability
}

/** Available, or the reason it is not — resolved against the live context. */
export function availability(cmd: Command): CommandAvailability {
  return cmd.enabled ? cmd.enabled(getCommandContext()) : true
}

type Listener = () => void

const bySource = new Map<string, Command[]>()
const listeners = new Set<Listener>()

export function setCommands(source: string, commands: Command[]): void {
  bySource.set(source, commands)
  for (const cb of listeners) cb()
}

export function allCommands(): Command[] {
  return Array.from(bySource.values()).flat()
}

/**
 * Run a command by id (no-op if nothing registered it yet). Returns whether it ran.
 * A command that refuses says why — out loud, once — instead of failing silently.
 */
export function runCommand(id: string): boolean {
  for (const commands of bySource.values()) {
    const cmd = commands.find((c) => c.id === id)
    if (cmd) {
      const avail = availability(cmd)
      if (avail !== true) {
        showToast({ tone: 'attention', title: avail.reason })
        return false
      }
      cmd.run()
      return true
    }
  }
  return false
}

export function onCommandsChange(cb: Listener): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
