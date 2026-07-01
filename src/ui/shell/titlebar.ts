/** Builds the titlebar and exposes its right-hand slot for feature indicators. */
export function createTitlebar(): { el: HTMLElement; right: HTMLElement } {
  const el = document.createElement('header')
  el.id = 'titlebar'

  const brand = document.createElement('div')
  brand.className = 'brand'

  const logo = document.createElement('img')
  logo.className = 'brand-logo'
  logo.src = './logo.png'
  logo.alt = 'MoggingLabs Workspace'

  const name = document.createElement('span')
  name.className = 'brand-name'
  name.textContent = 'MoggingLabs Workspace'

  brand.append(logo, name)

  const phase = document.createElement('span')
  phase.className = 'phase'
  phase.textContent = 'Phase 1 · MVP core'

  const right = document.createElement('div')
  right.className = 'titlebar-right'

  el.append(brand, phase, right)
  return { el, right }
}
