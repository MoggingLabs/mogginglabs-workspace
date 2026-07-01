import type { UiFeature } from '../../core/registry/feature-registry'
import { TerminalPane } from './terminal-pane'

export { TerminalPane } from './terminal-pane'
export { terminalClient } from './terminal.client'

/** Phase 0: mounts a single terminal pane. Phase 1 delegates pane placement to a
 *  dedicated `layout` feature. */
export const terminalFeature: UiFeature = {
  name: 'terminal',
  mount(ctx) {
    const host = document.createElement('div')
    host.className = 'pane'
    ctx.content.append(host)
    // eslint-disable-next-line no-new
    new TerminalPane(1, host)
  }
}
