import type { ShellContext } from '../core/registry/feature-registry'
import { createTitlebar } from './titlebar'

/**
 * Builds the app chrome (titlebar + content host) and returns the ShellContext
 * that features mount into. The shell knows nothing about individual features.
 */
export function createAppShell(root: HTMLElement): ShellContext {
  root.innerHTML = ''

  const app = document.createElement('div')
  app.id = 'app'

  const { el: titlebar, right } = createTitlebar()

  const content = document.createElement('div')
  content.id = 'content'

  app.append(titlebar, content)
  root.append(app)

  return { content, titlebarRight: right }
}
