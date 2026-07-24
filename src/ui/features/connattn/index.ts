import type { UiFeature } from '../../core/registry/feature-registry'
import { ConnectionsChannels, type ConnectionsAttention } from '@contracts'
import { getBridge } from '../../core/ipc/bridge'
import { el, icon } from '../../components'
import { setActiveView } from '../../core/shell/view-port'
import { requestSettingsTab } from '../../core/shell/settings-tab-port'

/**
 * App-wide attention for connection VERIFICATION failures (phase-tools/03) — the
 * status engine's promise that a broken connection is not a secret Settings keeps.
 * Main pushes `connections:attention` on EDGES only (the ledger raises once per
 * failure and clears once on recovery), so this surface is quiet by construction:
 * a rail badge + a titlebar dot, no toasts, nothing that repeats per heartbeat.
 *
 * The same rail-footer grammar as the update row (updates/index.ts): invisible
 * until there is genuinely something to say; one row, one verb — clicking it lands
 * on Settings › Integrations with the Connected-accounts card in focus, where the
 * card (step 05) and the reconciler's Fix (step 06) carry the repair.
 */
export const connAttentionFeature: UiFeature = {
  name: 'connattn',
  mount(ctx) {
    const bridge = getBridge()

    // The quiet titlebar dot — for users whose rail is collapsed or scrolled away.
    const dot = el('div', { class: 'connattn-dot', hidden: true })
    ctx.titlebarRight.append(dot)

    const label = el('span', { class: 'rail-update-label', text: 'Connection needs attention' })
    const btn = el('button', { class: 'rail-update-btn is-error rail-conn-attn', type: 'button' }, [
      icon('plug', 14),
      label
    ]) as HTMLButtonElement
    const footer = el('div', { class: 'rail-footer rail-conn-attn-footer' }, [btn])
    footer.hidden = true
    ctx.rail.append(footer)

    btn.addEventListener('click', () => {
      // The Connected-accounts card is defaultOpen and its fold chip already reads
      // "N need you" — landing on the tab is the whole navigation.
      requestSettingsTab('integrations')
      setActiveView('settings')
    })

    bridge.on(ConnectionsChannels.attention, (payload) => {
      const failing = (payload as ConnectionsAttention | null)?.failing ?? []
      const n = failing.length
      footer.hidden = n === 0
      dot.hidden = n === 0
      label.textContent = n === 1 ? 'Connection needs attention' : `${n} connections need attention`
      const names = failing.join(', ')
      btn.title = n ? `Verification is failing for: ${names}. Open Integrations to fix it.` : ''
      dot.title = btn.title
    })
  }
}
