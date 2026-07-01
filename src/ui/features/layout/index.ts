import type { UiFeature } from '../../core/registry/feature-registry'
import { GridLayout } from './grid-layout'
import { TEMPLATE_COUNTS } from './templates'

/**
 * The layout feature: a resizable split/grid of terminal slots with template presets
 * (1/2/4/6/8/9/12/16), drag-resize, and focus. It publishes its slots via the ui-core slots
 * port; the `terminal` feature fills them. It does NOT import `terminal` (decoupled).
 */
export const layoutFeature: UiFeature = {
  name: 'layout',
  mount(ctx) {
    const toolbar = document.createElement('div')
    toolbar.id = 'layout-toolbar'
    const label = document.createElement('span')
    label.className = 'layout-toolbar-label'
    label.textContent = 'Panes'
    toolbar.append(label)
    ctx.content.append(toolbar)

    const layout = new GridLayout(ctx.content)

    for (const n of TEMPLATE_COUNTS) {
      const btn = document.createElement('button')
      btn.className = 'layout-btn'
      btn.type = 'button'
      btn.textContent = String(n)
      btn.title = `${n}-pane layout`
      btn.addEventListener('click', () => {
        layout.apply(n)
        for (const b of Array.from(toolbar.querySelectorAll('.layout-btn'))) b.classList.remove('active')
        btn.classList.add('active')
      })
      toolbar.append(btn)
    }
    ;(toolbar.querySelector('.layout-btn') as HTMLElement | null)?.classList.add('active')

    exposeForDev(layout)
  }
}

/** Dev-only handle so the multi-pane smoke can drive layouts. Tree-shaken in production. */
function exposeForDev(layout: GridLayout): void {
  if (!import.meta.env.DEV) return
  const w = window as unknown as { __mogging?: Record<string, unknown> }
  w.__mogging = w.__mogging ?? {}
  w.__mogging.layout = {
    apply: (n: number) => layout.apply(n),
    paneCount: () => layout.paneCount
  }
}
