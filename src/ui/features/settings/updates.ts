import {
  UpdateChannels,
  UPDATE_PREFS_DEFAULT,
  type UpdatePrefs,
  type UpdateState
} from '@contracts'
import { Button, Card, SectionHeader, createToggleRow, el } from '../../components'
import { getBridge } from '../../core/ipc/bridge'

/**
 * Settings § Updates — the honest status of the updater, and the two choices worth giving away.
 *
 * The status row is the point, and it is not decoration. Auto-update was broken for NINE
 * releases (every download 404'd on an artifact-name mismatch) and nobody could tell, because
 * a feed that never works and a feed with nothing to report look *identical* from the outside:
 * both are silence. Only "Last checked: …" distinguishes them. So this row always answers:
 * what am I running, when did the updater last actually complete a check, and what did it say.
 *
 * What is deliberately NOT here: an "enable auto-updates" switch. An app that lets you opt out
 * of security fixes becomes an app full of people who did, once, years ago, and forgot. The
 * two toggles below constrain WHEN and WHICH — never WHETHER.
 */

const RELATIVE = [
  { limit: 60_000, div: 1000, unit: 'second' },
  { limit: 3_600_000, div: 60_000, unit: 'minute' },
  { limit: 86_400_000, div: 3_600_000, unit: 'hour' },
  { limit: Infinity, div: 86_400_000, unit: 'day' }
] as const

/** "3 minutes ago" — the only format in which a timestamp answers "is this thing running?". */
function ago(at: number): string {
  const delta = Math.max(0, Date.now() - at)
  if (delta < 45_000) return 'just now'
  const step = RELATIVE.find((s) => delta < s.limit) ?? RELATIVE[RELATIVE.length - 1]
  const n = Math.round(delta / step.div)
  return `${n} ${step.unit}${n === 1 ? '' : 's'} ago`
}

function statusLine(s: UpdateState): string {
  if (!s.supported) return 'Updates are delivered to installed builds only — this one is running from source.'
  switch (s.phase) {
    case 'checking':
      return 'Checking for updates…'
    case 'available':
      return s.version ? `Version ${s.version} is available — downloading it now.` : 'An update is available.'
    case 'downloading':
      return `Downloading${typeof s.percent === 'number' ? ` — ${s.percent}%` : '…'}`
    case 'ready':
      return s.version
        ? `Version ${s.version} is ready. Restart to finish — your terminals are restored.`
        : 'An update is ready. Restart to finish.'
    case 'error':
      return `The last check failed${s.error ? ` — ${s.error}` : ''}.`
    default:
      // Not an error state: nobody asked and nothing is broken — but never claim "up to
      // date" on a machine whose last check could not reach the feed at all.
      return s.offline
        ? 'Could not check for updates — this machine looks offline. It retries on its own.'
        : 'You are up to date.'
  }
}

export function createUpdatesSection(): HTMLElement {
  const bridge = getBridge()

  const version = el('span', { class: 'update-version', text: '—' })
  const status = el('p', { class: 'card-caption update-status', text: 'Checking…' })
  const checked = el('p', { class: 'settings-scope update-checked', text: '' })

  const checkBtn = Button({
    label: 'Check for updates',
    variant: 'outline',
    size: 'sm',
    onClick: () => {
      status.textContent = 'Checking for updates…'
      void bridge.invoke(UpdateChannels.check, undefined)
    }
  })

  const restartBtn = Button({
    label: 'Restart to update',
    variant: 'primary',
    size: 'sm',
    onClick: () => void bridge.invoke(UpdateChannels.restart, undefined)
  })
  restartBtn.hidden = true

  let prefs: UpdatePrefs = UPDATE_PREFS_DEFAULT
  const save = (patch: Partial<UpdatePrefs>): void => {
    prefs = { ...prefs, ...patch }
    void bridge.invoke(UpdateChannels.prefsSet, prefs)
  }

  const prerelease = createToggleRow({
    label: 'Receive pre-release builds',
    hint: 'Get beta tags (like v1.0.0-beta.1) as soon as they ship. Turning this back off returns you to the latest stable build, even if that means stepping back down from a beta.',
    onChange: (on) => save({ allowPrerelease: on })
  })

  const installOnQuit = createToggleRow({
    label: 'Install updates when the app quits',
    hint: 'On: a downloaded update applies quietly the next time you close the app, so you never wait for one. Off: it installs only when you press Restart — nothing is ever swapped out from under you.',
    onChange: (on) => save({ installOnQuit: on })
  })

  function render(s: UpdateState): void {
    version.textContent = s.currentVersion ? `v${s.currentVersion}` : '—'
    status.textContent = statusLine(s)
    checked.textContent =
      !s.supported ? ''
      : s.lastCheckedAt ? `Last checked ${ago(s.lastCheckedAt)}.`
      // No completed check yet — say so rather than implying a clean bill of health.
      : 'Has not completed a check yet.'
    restartBtn.hidden = s.phase !== 'ready'
    checkBtn.disabled = !s.supported || s.phase === 'checking' || s.phase === 'downloading'
  }

  bridge.on(UpdateChannels.state, (p) => render(p as UpdateState))
  void bridge.invoke(UpdateChannels.stateGet, undefined).then((s) => render(s as UpdateState))
  void bridge.invoke(UpdateChannels.prefsGet, undefined).then((p) => {
    prefs = p as UpdatePrefs
    prerelease.setChecked(prefs.allowPrerelease)
    installOnQuit.setChecked(prefs.installOnQuit)
  })

  return Card(
    {
      header: SectionHeader({
        title: 'Updates',
        caption: 'New builds download in the background and install when you say so. There is no way to turn updates off — only to choose when they land, and which ones.'
      })
    },
    [
      el('div', { class: 'update-status-row' }, [
        el('div', { class: 'update-status-main' }, [version, status, checked]),
        el('div', { class: 'update-status-actions' }, [restartBtn, checkBtn])
      ]),
      prerelease.el,
      installOnQuit.el
    ]
  )
}
