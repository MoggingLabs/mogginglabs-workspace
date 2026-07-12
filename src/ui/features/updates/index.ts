import type { UiFeature } from '../../core/registry/feature-registry'
import { UpdateChannels, type UpdateState } from '@contracts'
import { getBridge } from '../../core/ipc/bridge'
import { showToast, el, icon } from '../../components'
import { getTelemetry } from '../../core/telemetry'

/**
 * Auto-update UX. The primary affordance is a button pinned to the BOTTOM of the
 * workspaces rail: it stays invisible until there is genuinely something to say,
 * then walks one row through the lifecycle —
 *
 *   available   → "Update is available"      (the download is already running)
 *   downloading → "Downloading… 42%"          (the same row, filling a progress track)
 *   ready       → "Restart to update"         (click = quitAndInstall)
 *   error       → "Update failed — retry"     (click = re-check)
 *
 * Restarting is safe: terminal sessions live in the daemon, which survives the swap
 * and hands panes back on relaunch — so "Restart to update" costs the user nothing.
 * Declining costs nothing either; autoInstallOnAppQuit lands it on the next quit.
 *
 * The titlebar dot and the one-shot ready toast remain for users whose rail is
 * collapsed or scrolled away. No update metadata reaches telemetry (ADR 0005).
 */
export const updatesFeature: UiFeature = {
  name: 'updates',
  mount(ctx) {
    const bridge = getBridge()

    // A quiet indicator in the titlebar right cluster — visible only mid-download.
    const dot = el('div', { class: 'update-dot', hidden: true })
    dot.title = 'Downloading an update…'
    ctx.titlebarRight.append(dot)

    // The rail footer. `#rail` is a flex column whose tab list is `flex: 1 1 auto`,
    // so appending here pins the row to the bottom with no extra layout.
    const glyph = icon('sparkles', 14)
    const label = el('span', { class: 'rail-update-label', text: 'Update is available' })
    const btn = el('button', { class: 'rail-update-btn', type: 'button' }, [
      glyph,
      label
    ]) as HTMLButtonElement
    const footer = el('div', { class: 'rail-footer' }, [btn])
    footer.hidden = true
    ctx.rail.append(footer)

    let phase: UpdateState['phase'] = 'idle'
    let version: string | null = null

    btn.addEventListener('click', () => {
      if (phase === 'ready') {
        getTelemetry().captureEvent({ name: 'update.restart' })
        void bridge.invoke(UpdateChannels.restart, undefined)
      } else if (phase === 'error') {
        void bridge.invoke(UpdateChannels.check, undefined)
      }
      // 'available'/'downloading': the download is already in flight — the row is a
      // status, not a trigger. Clicking it does nothing rather than lying.
    })

    // Toast at most once per ready version per session.
    let toastedVersion: string | null = null

    bridge.on(UpdateChannels.state, (payload) => {
      const s = payload as UpdateState
      phase = s.phase
      if (s.version) version = s.version

      const downloading = s.phase === 'checking' || s.phase === 'available' || s.phase === 'downloading'
      dot.hidden = !downloading
      if (s.phase === 'downloading' && typeof s.percent === 'number') {
        // REMOVE #15: `--pct` was computed and handed to the dot, but nothing read it —
        // progress lived only in the title. The dot is a quiet pulse; the % is the tooltip.
        dot.title = `Downloading an update… ${s.percent}%`
      }

      // The rail row. 'checking' and 'idle' say nothing — silence is the correct UI
      // for "we looked and there was nothing".
      renderRow(s)

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

    function renderRow(s: UpdateState): void {
      const v = s.version ?? version
      footer.hidden = s.phase === 'idle' || s.phase === 'checking'
      btn.classList.toggle('is-ready', s.phase === 'ready')
      btn.classList.toggle('is-error', s.phase === 'error')
      // Only 'ready' and 'error' do anything on click; the rest is status.
      btn.classList.toggle('is-status', s.phase === 'available' || s.phase === 'downloading')

      if (s.phase === 'downloading') {
        const pct = typeof s.percent === 'number' ? s.percent : 0
        label.textContent = `Downloading… ${pct}%`
        btn.style.setProperty('--pct', `${pct}%`)
        btn.title = v ? `Downloading v${v}` : 'Downloading an update'
      } else {
        btn.style.removeProperty('--pct')
      }

      if (s.phase === 'available') {
        label.textContent = 'Update is available'
        btn.title = v ? `Version ${v} is available and downloading now` : 'An update is available'
      } else if (s.phase === 'ready') {
        label.textContent = 'Restart to update'
        btn.title = v
          ? `v${v} is downloaded — restart to finish. Your terminals are restored.`
          : 'Restart to finish updating'
      } else if (s.phase === 'error') {
        label.textContent = 'Update failed — retry'
        btn.title = s.error ?? 'The update check failed'
      }
    }
  }
}
