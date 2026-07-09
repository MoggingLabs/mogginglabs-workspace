import type { UiFeature } from '../../core/registry/feature-registry'
import { UpdateChannels, type UpdateState } from '@contracts'
import { getBridge } from '../../core/ipc/bridge'
import { showToast, el } from '../../components'
import { getTelemetry } from '../../core/telemetry'

/**
 * Auto-update UX (Phase-6/06): a quiet titlebar dot while a new build downloads,
 * and ONE toast when it's ready — "Restart now / Later". Later is a first-class
 * choice: nothing re-toasts for that version this session. Driven by main's
 * UpdateChannels.state (the real feed in packaged builds; MOGGING_FAKE_UPDATE
 * in dev/smoke). No update metadata in telemetry (ADR 0005) — booleans only.
 */
export const updatesFeature: UiFeature = {
  name: 'updates',
  mount(ctx) {
    const bridge = getBridge()

    // A quiet indicator in the titlebar right cluster — visible only mid-download.
    const dot = el('div', { class: 'update-dot', hidden: true })
    dot.title = 'Downloading an update…'
    ctx.titlebarRight.append(dot)

    // Toast at most once per ready version per session.
    let toastedVersion: string | null = null

    bridge.on(UpdateChannels.state, (payload) => {
      const s = payload as UpdateState
      const downloading = s.phase === 'checking' || s.phase === 'available' || s.phase === 'downloading'
      dot.hidden = !downloading
      if (s.phase === 'downloading' && typeof s.percent === 'number') {
        // REMOVE #15: `--pct` was computed and handed to the dot, but nothing read it —
        // progress lived only in the title. The dot is a quiet pulse; the % is the tooltip.
        dot.title = `Downloading an update… ${s.percent}%`
      }
      if (s.phase === 'ready' && s.version && toastedVersion !== s.version) {
        toastedVersion = s.version
        getTelemetry().captureEvent({ name: 'update.ready' }) // boolean — never the version string to telemetry
        showToast({
          tone: 'info',
          title: `v${s.version} is ready`,
          body: 'Restart to finish updating — or keep working and it installs next launch.',
          timeout: 0, // sticky: the user chooses, we never auto-dismiss an update
          icon: 'sparkles',
          action: {
            label: 'Restart now',
            onClick: () => {
              getTelemetry().captureEvent({ name: 'update.restart' })
              void bridge.invoke(UpdateChannels.restart, undefined)
            }
          },
          secondaryAction: {
            label: 'Later',
            // A first-class choice — nothing re-toasts this version this session;
            // it installs on next quit (autoInstallOnAppQuit). No snooze-nag.
            onClick: () => getTelemetry().captureEvent({ name: 'update.later' })
          }
        })
      }
    })
  }
}
