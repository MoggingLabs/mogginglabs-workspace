import type { UiFeature } from '../../core/registry/feature-registry'
import { activeView, goBack, onViewChange, setActiveView } from '../../core/shell/view-port'
import { onWorkspacesChange } from '../../core/workspace/workspace-info-port'
import { setCommands } from '../../core/commands/command-port'
import { shortcutsBlocked } from '../../core/commands/context'
import { isModKey } from '../../core/commands/shortcuts'
import { explorerRevealLog } from '../../core/shell/explorer-reveal-port'
import { getTelemetry } from '../../core/telemetry'
import { showToast } from '../../components'
import { onBrainChanged, onSemFailure } from './client'
import { createBrainView } from './view'

/**
 * The Brain feature (ADR 0018/10): mounts the full-app Brain view on the
 * board/settings precedent. Entry points are the palette verb and
 * Ctrl+Shift+M — deliberately NO titlebar button (8.5 restraint: the bar
 * carries the everyday doors; the Brain is a tool you summon). Esc goes back,
 * matching the documented "Back" law. Opening never steals focus: the view
 * autofocuses nothing — a busy pane keeps its caret until you click or Tab.
 */

export const brainFeature: UiFeature = {
  name: 'brain',
  mount(ctx) {
    const view = createBrainView()
    ctx.content.append(view.root)

    const toggle = (): void => setActiveView(activeView() === 'brain' ? 'grid' : 'brain')

    onViewChange((v) => {
      const on = v === 'brain'
      view.setActive(on)
      if (on) {
        view.refresh()
        getTelemetry().captureEvent({ name: 'brain.opened' })
      }
    })

    onWorkspacesChange(() => {
      if (activeView() === 'brain') view.refresh()
    })

    onBrainChanged((event) => view.onChangedPush(event.projectKey))

    // Revision A: the semantic lens's ONE failure surface — main latches it to
    // a single fire per workspace, so this can stay a plain toast. The detail
    // is an endpoint/status sentence, never memory text or a key (ADR 0005).
    onSemFailure((event) =>
      showToast({
        tone: 'danger',
        title: 'Semantic memory recall is failing',
        body: `${event.detail} — exact search still works. Check the endpoint in Settings › Privacy › Semantic memory recall.`
      })
    )

    setCommands('brain', [
      {
        id: 'brain:open',
        title: 'Brain',
        hint: 'Workspace',
        kbd: 'Ctrl+Shift+M',
        run: toggle
      }
    ])

    window.addEventListener('keydown', (e) => {
      if (shortcutsBlocked(e.target)) return
      if (isModKey(e) && e.shiftKey && !e.altKey && e.code === 'KeyM') {
        e.preventDefault()
        toggle()
      } else if (e.key === 'Escape' && activeView() === 'brain') {
        // Back — unless an overlay above the view owns the keystroke (those
        // handle Escape in capture and never let it reach here).
        e.preventDefault()
        goBack()
      }
    })

    if (import.meta.env.DEV) {
      const g = globalThis as Record<string, unknown>
      const dev = (g.__mogging ?? (g.__mogging = {})) as Record<string, unknown>
      dev.brain = Object.assign({}, view.dev, {
        open: () => {
          setActiveView('brain')
          return activeView() === 'brain'
        },
        close: () => {
          if (activeView() === 'brain') goBack()
          return activeView()
        },
        isOpen: () => activeView() === 'brain',
        revealLog: () => explorerRevealLog()
      })
    }
  }
}
