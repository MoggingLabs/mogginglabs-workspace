import { TerminalChannels } from '@contracts'
import type { StateEvent } from '@contracts'
import type { UiFeature } from '../../core/registry/feature-registry'
import { getBridge } from '../../core/ipc/bridge'

/**
 * Renders a live agent-state chip in the titlebar. It listens to the contract's
 * state event directly — it does NOT import the terminal feature, so the two stay
 * decoupled and can be built/tested in parallel.
 */
export const agentStateFeature: UiFeature = {
  name: 'agent-state',
  mount(ctx) {
    const chip = document.createElement('span')
    chip.className = 'state'
    chip.dataset.state = 'idle'
    chip.textContent = 'idle'
    ctx.titlebarRight.append(chip)

    getBridge().on(TerminalChannels.state, (payload) => {
      const e = payload as StateEvent
      chip.textContent = e.state
      chip.dataset.state = e.state
    })
  }
}
