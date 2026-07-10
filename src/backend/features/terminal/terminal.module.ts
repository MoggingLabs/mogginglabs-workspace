import { TerminalChannels } from '@contracts'
import type { BackendContext, FeatureModule } from '../../core/ipc/registry'
import { PtyService } from './pty.service'

/** The terminal feature: hosts PTYs and bridges them to the UI over IPC. */
export function createTerminalModule(): FeatureModule {
  let service: PtyService | null = null

  return {
    name: 'terminal',
    register(ctx: BackendContext) {
      service = new PtyService({
        data: (e) => ctx.emit(TerminalChannels.data, e),
        exit: (e) => ctx.emit(TerminalChannels.exit, e),
        state: (e) => ctx.emit(TerminalChannels.state, e),
        cwd: (e) => ctx.emit(TerminalChannels.cwd, e)
      })
      ctx.handle(TerminalChannels.spawn, (p) => service!.spawn(p))
      // The dot's reliability contract: a mounting pane PULLS its current state —
      // events fire on change only, and a reloaded renderer heard none of them.
      ctx.handle(TerminalChannels.stateSync, (p) => service!.stateOf((p as { id: number }).id))
      ctx.on(TerminalChannels.write, (p) => service!.write(p))
      ctx.on(TerminalChannels.resize, (p) => service!.resize(p))
      ctx.on(TerminalChannels.kill, (p) => service!.kill(p))
    },
    dispose() {
      service?.disposeAll()
    }
  }
}
