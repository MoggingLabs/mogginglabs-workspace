import { IntegrationsChannels, type WorkspaceIntegrationsGrant } from '@contracts'
import { getBridge } from '../../core/ipc/bridge'
import { Card, SectionHeader, el, showToast } from '../../components'
import { getWorkspaces } from '../../core/workspace/workspace-info-port'
import { onViewChange } from '../../core/shell/view-port'
import { normalizeBrowserOrigin } from '../../core/browser-origin'

/**
 * Settings § Browser — act origins (8/04), split OUT of the Integrations
 * "Grants" card: which signed-in origins agents may ACT on is a BROWSER
 * boundary, and it reads alongside the browser-control consent, not the MCP
 * pipeline. Same store, different tab: this card patches only `web` +
 * `actOrigins` on the one WorkspaceIntegrationsGrant; the write-tools knob
 * stays in Integrations and patches only `writeTools`. The dock's sites menu
 * keeps its minimal editor; this is the full home.
 */
export function createActOriginsCard(): HTMLElement {
  const bridge = getBridge()
  const wsSelect = el('select', { class: 'trail-select' }) as HTMLSelectElement
  wsSelect.setAttribute('aria-label', 'Workspace')
  const body = el('div', { class: 'mgr-grant-body' })
  let renderGeneration = 0

  async function render(): Promise<void> {
    const generation = ++renderGeneration
    const wsId = wsSelect.value
    body.innerHTML = ''
    if (!wsId) return
    const grant = (await bridge.invoke(IntegrationsChannels.grantGet, wsId)) as WorkspaceIntegrationsGrant
    if (generation !== renderGeneration || wsSelect.value !== wsId) return
    body.append(el('div', { class: 'settings-row-caption', text: `Origins agents may ACT on (web tier: ${grant.web})` }))
    for (const origin of grant.actOrigins) {
      const drop = el('button', { class: 'browser-sites-forget', type: 'button', text: 'Revoke' }) as HTMLButtonElement
      drop.onclick = async (): Promise<void> => {
        drop.disabled = true
        try {
          await bridge.invoke(IntegrationsChannels.grantMutate, {
            workspaceId: wsId,
            field: 'origin',
            op: 'remove',
            origin
          })
          if (wsSelect.value === wsId) await render()
        } catch (error) {
          showToast({ tone: 'danger', title: 'Origin was not revoked', body: String(error) })
        } finally {
          if (drop.isConnected) drop.disabled = false
        }
      }
      body.append(el('div', { class: 'browser-sites-row' }, [el('span', { class: 'browser-sites-host', text: origin }), drop]))
    }
    if (!grant.actOrigins.length) {
      body.append(el('div', { class: 'menu-note', text: 'None granted — reads always work; acts refuse.' }))
    }
    const addInput = el('input', { class: 'browser-sites-input' }) as HTMLInputElement
    addInput.placeholder = 'github.com'
    addInput.setAttribute('aria-label', 'Origin to grant')
    addInput.spellcheck = false
    addInput.addEventListener('keydown', (e) => e.stopPropagation())
    const refusedNote = el('div', { class: 'menu-note browser-sites-refused', hidden: true })
    const addBtn = el('button', { class: 'browser-sites-add', type: 'button', text: 'Grant origin' }) as HTMLButtonElement
    addBtn.onclick = async (): Promise<void> => {
      const raw = addInput.value.trim()
      if (!raw) return
      addBtn.disabled = true
      try {
        const saved = (await bridge.invoke(IntegrationsChannels.grantMutate, {
          workspaceId: wsId,
          field: 'origin',
          op: 'add',
          origin: raw
        })) as WorkspaceIntegrationsGrant | null
        if (wsSelect.value !== wsId) return
        const normalized = normalizeBrowserOrigin(raw)
        if (!saved || !normalized || !saved.actOrigins.includes(normalized)) {
          refusedNote.textContent = `“${raw}” was refused — sensitive or invalid origins never accept act grants.`
          refusedNote.hidden = false
          return
        }
        await render()
      } catch (error) {
        showToast({ tone: 'danger', title: 'Origin was not granted', body: String(error) })
      } finally {
        if (addBtn.isConnected) addBtn.disabled = false
      }
    }
    body.append(el('div', { class: 'browser-sites-addrow' }, [addInput, addBtn]), refusedNote)
  }

  function refreshWorkspaces(): void {
    const current = wsSelect.value
    wsSelect.innerHTML = ''
    for (const w of getWorkspaces().workspaces) wsSelect.append(el('option', { value: w.id, text: w.name }))
    wsSelect.value = current || (getWorkspaces().activeId ?? '')
    if (!wsSelect.value && wsSelect.options.length) wsSelect.selectedIndex = 0
  }
  wsSelect.onchange = (): void => void render()

  const block = el('div', { class: 'trail-block browser-origins-block' }, [
    el('div', { class: 'settings-row-caption', text: 'Per workspace, default none: agents can always READ pages in the dock; ACTING on a signed-in origin needs that origin granted here, plus the one-click banner confirm per possession. Sensitive origins (banking, mail, gov) refuse at both ends. Every act lands in the trail (Trust › Activity).' }),
    el('div', { class: 'trail-controls' }, [wsSelect]),
    body
  ])

  // The SyncedBlock lesson (8.5/05): the workspace select reads `getWorkspaces()`
  // and grants change from the dock's own editor between visits — every entry
  // into Settings re-reads both, deferred a macrotask so the view switch paints.
  let entryQueued = false
  const sync = (): void => {
    if (entryQueued) return
    entryQueued = true
    setTimeout(() => {
      entryQueued = false
      refreshWorkspaces()
      void render()
    }, 0)
  }
  onViewChange((v) => {
    if (v === 'settings') sync()
  })
  sync()

  return Card(
    {
      header: SectionHeader({
        title: 'Act origins',
        caption: 'Which signed-in origins agents may act on, per workspace. Default none — reads never need a grant.'
      })
    },
    [block]
  )
}
