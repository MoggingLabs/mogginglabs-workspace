/** Builds the titlebar and exposes its right-hand slot for feature indicators. */
export function createTitlebar(): { el: HTMLElement; right: HTMLElement } {
  const el = document.createElement('header')
  el.id = 'titlebar'

  const brand = document.createElement('span')
  brand.className = 'brand'
  brand.textContent = 'MoggingLabs Workspace'

  const phase = document.createElement('span')
  phase.className = 'phase'
  phase.textContent = 'Phase 0 · single-pane parity spike'

  const right = document.createElement('div')
  right.className = 'titlebar-right'

  el.append(brand, phase, right)
  return { el, right }
}
