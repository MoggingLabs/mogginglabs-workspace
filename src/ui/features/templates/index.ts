import type { UiFeature } from '../../core/registry/feature-registry'
import type { AgentInfo, ProviderCount } from '@contracts'
import { getFocusedPane } from '../../core/layout/focus'
import { openWorkspaceFromTemplate } from '../../core/workspace/open-service'
import { templatesClient } from './templates.client'

interface ProviderOption {
  id: string
  name: string
  installed: boolean
}

/**
 * Provider-mix templates (06b): open a whole workspace from a named mix of providers. A dialog
 * lists presets + a custom builder (a count stepper per provider, live-previewing the grid);
 * opening resolves the mix and hands a spec to the workspace-open service, which creates the
 * workspace (05) and launches each slot's CLI (06). Composes 05 + 06 via ports — never their
 * internals. Metadata only — providers + counts, never credentials (ADR 0002).
 */
export const templatesFeature: UiFeature = {
  name: 'templates',
  mount(ctx) {
    const btn = document.createElement('button')
    btn.className = 'template-open-btn'
    btn.type = 'button'
    btn.textContent = 'Templates'
    ctx.titlebarRight.prepend(btn)

    const overlay = document.createElement('div')
    overlay.id = 'template-dialog'
    overlay.hidden = true
    const panel = document.createElement('div')
    panel.className = 'template-panel'
    overlay.append(panel)
    document.body.append(overlay)

    const mix = new Map<string, number>()
    let providers: ProviderOption[] = [{ id: 'shell', name: 'Shell', installed: true }]

    btn.addEventListener('click', () => void openDialog())
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.hidden = true
    })

    async function openDialog(): Promise<void> {
      try {
        const agents = ((await templatesClient.detect()) ?? []) as AgentInfo[]
        providers = [...agents.map((a) => ({ id: a.id, name: a.name, installed: a.installed })), { id: 'shell', name: 'Shell', installed: true }]
      } catch {
        /* keep prior list */
      }
      render()
      overlay.hidden = false
    }

    function currentMix(): ProviderCount[] {
      return providers.map((p) => ({ provider: p.id, count: mix.get(p.id) ?? 0 })).filter((m) => m.count > 0)
    }

    function render(): void {
      panel.innerHTML = ''
      const title = document.createElement('h3')
      title.textContent = 'Open a workspace from a template'
      panel.append(title)

      const presetsWrap = document.createElement('div')
      presetsWrap.className = 'template-presets'
      void templatesClient.list().then((templates) => {
        for (const t of templates) {
          const p = document.createElement('button')
          p.className = 'template-preset'
          p.type = 'button'
          p.textContent = t.name
          p.addEventListener('click', () => {
            mix.clear()
            for (const m of t.mix) mix.set(m.provider, m.count)
            render()
          })
          presetsWrap.append(p)
        }
      })
      panel.append(presetsWrap)

      const sub = document.createElement('div')
      sub.className = 'template-subtitle'
      sub.textContent = 'Custom mix'
      panel.append(sub)

      const builder = document.createElement('div')
      builder.className = 'template-builder'
      for (const p of providers) {
        const row = document.createElement('div')
        row.className = 'template-row'
        if (!p.installed) row.classList.add('disabled')
        const label = document.createElement('span')
        label.className = 'template-provider'
        label.textContent = p.installed ? p.name : `${p.name} (not installed)`
        const dec = document.createElement('button')
        dec.type = 'button'
        dec.className = 'template-step'
        dec.textContent = '−'
        const count = document.createElement('span')
        count.className = 'template-count'
        count.textContent = String(mix.get(p.id) ?? 0)
        const inc = document.createElement('button')
        inc.type = 'button'
        inc.className = 'template-step'
        inc.textContent = '+'
        dec.disabled = !p.installed
        inc.disabled = !p.installed
        dec.addEventListener('click', () => {
          mix.set(p.id, Math.max(0, (mix.get(p.id) ?? 0) - 1))
          count.textContent = String(mix.get(p.id))
          void updatePreview()
        })
        inc.addEventListener('click', () => {
          mix.set(p.id, (mix.get(p.id) ?? 0) + 1)
          count.textContent = String(mix.get(p.id))
          void updatePreview()
        })
        row.append(label, dec, count, inc)
        builder.append(row)
      }
      panel.append(builder)

      const preview = document.createElement('div')
      preview.className = 'template-preview'
      panel.append(preview)

      const actions = document.createElement('div')
      actions.className = 'template-actions'
      const openBtn = document.createElement('button')
      openBtn.type = 'button'
      openBtn.className = 'template-open'
      openBtn.textContent = 'Open workspace'
      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.className = 'template-cancel'
      cancel.textContent = 'Cancel'
      openBtn.addEventListener('click', () => void openWorkspace())
      cancel.addEventListener('click', () => (overlay.hidden = true))
      actions.append(openBtn, cancel)
      panel.append(actions)

      void updatePreview()
    }

    async function updatePreview(): Promise<void> {
      const preview = panel.querySelector('.template-preview') as HTMLElement | null
      if (!preview) return
      const cm = currentMix()
      const total = cm.reduce((s, m) => s + m.count, 0)
      if (!total) {
        preview.textContent = 'Add at least one pane.'
        return
      }
      try {
        const r = await templatesClient.resolve(cm)
        preview.textContent = `${total} panes → ${r.paneCount}-pane grid: ${r.assignments.join(', ')}`
      } catch {
        preview.textContent = `${total} panes`
      }
    }

    async function openWorkspace(): Promise<void> {
      const cm = currentMix()
      if (!cm.length) return
      const r = await templatesClient.resolve(cm)
      const cwd = getFocusedPane()?.cwd ?? ''
      const name = cm.map((m) => `${m.count}${m.provider[0].toUpperCase()}`).join('+')
      openWorkspaceFromTemplate({ name: name || 'Template', cwd, paneCount: r.paneCount, assignments: r.assignments })
      overlay.hidden = true
    }

    exposeForDev()
    function exposeForDev(): void {
      if (!import.meta.env.DEV) return
      const w = window as unknown as { __mogging?: Record<string, unknown> }
      w.__mogging = w.__mogging ?? {}
      w.__mogging.templates = {
        resolve: (m: ProviderCount[]) => templatesClient.resolve(m),
        list: () => templatesClient.list(),
        open: async (m: ProviderCount[]) => {
          const r = await templatesClient.resolve(m)
          const cwd = getFocusedPane()?.cwd ?? ''
          openWorkspaceFromTemplate({ name: 'Smoke', cwd, paneCount: r.paneCount, assignments: r.assignments })
          return r
        }
      }
    }
  }
}
