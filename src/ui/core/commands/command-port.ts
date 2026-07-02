// App-wide command registry: every feature publishes its actions here; the command
// palette lists them and anything can run one by id (the rail's Home/Settings buttons,
// keyboard shortcuts, …). Sources re-publish their own list when it changes (e.g. the
// workspace feature republishes "switch to <name>" entries as workspaces come and go).

export interface Command {
  id: string
  title: string
  /** Optional grouping hint shown dimmed in the palette (e.g. "Workspace"). */
  hint?: string
  /** Accelerator label (display only — bindings live with the owning feature). */
  kbd?: string
  run: () => void
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

/** Run a command by id (no-op if nothing registered it yet). Returns whether it ran. */
export function runCommand(id: string): boolean {
  for (const commands of bySource.values()) {
    const cmd = commands.find((c) => c.id === id)
    if (cmd) {
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
