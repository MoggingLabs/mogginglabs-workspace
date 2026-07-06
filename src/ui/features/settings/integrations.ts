import { IntegrationsChannels, type TrailEntry, type TrailSource } from '@contracts'
import { getBridge } from '../../core/ipc/bridge'
import { el } from '../../components'
import { getWorkspaces } from '../../core/workspace/workspace-info-port'
import { fmtAge } from '../usage'

/**
 * Settings § Integrations (Phase-8/05 lands the ACTIVITY block; 8/06 builds
 * the section out with server management — one-home rule, this module absorbs
 * it). The Activity trail is FINDINGS §4.5's audit surface: what did agents do
 * as me, where, and was it allowed — reviewable here, retained locally,
 * NEVER telemetry. Entries arrive as refs (origins / pane refs / labels);
 * this view renders them verbatim and adds nothing.
 */
export function createIntegrationsSection(): HTMLElement {
  const bridge = getBridge()

  // ── Filters: workspace + source ───────────────────────────────────────────
  const wsSelect = el('select', { class: 'trail-select trail-ws' }) as HTMLSelectElement
  wsSelect.setAttribute('aria-label', 'Filter by workspace')
  const srcSelect = el('select', { class: 'trail-select trail-src' }) as HTMLSelectElement
  srcSelect.setAttribute('aria-label', 'Filter by source')
  for (const [v, label] of [
    ['', 'All sources'],
    ['web', 'Web acts'],
    ['mcp', 'MCP writes'],
    ['bridge', 'Webhook deliveries']
  ]) {
    srcSelect.append(el('option', { value: v, text: label }))
  }

  const refreshBtn = el('button', { class: 'trail-btn', type: 'button', text: 'Refresh' }) as HTMLButtonElement
  const exportBtn = el('button', { class: 'trail-btn', type: 'button', text: 'Export JSON…' }) as HTMLButtonElement
  // Clear is a two-click confirm (house pattern — no native dialogs).
  const clearBtn = el('button', { class: 'trail-btn trail-clear', type: 'button', text: 'Clear this workspace’s trail' }) as HTMLButtonElement
  let clearArmed = false
  const disarmClear = (): void => {
    clearArmed = false
    clearBtn.textContent = 'Clear this workspace’s trail'
    clearBtn.classList.remove('is-armed')
  }

  const list = el('div', { class: 'trail-list' })
  const emptyNote = el('div', { class: 'settings-row-caption trail-empty', text: 'No agent activity recorded yet.' })

  const wsName = (id: string): string => getWorkspaces().workspaces.find((w) => w.id === id)?.name ?? id.slice(0, 8)

  function renderRows(entries: TrailEntry[]): void {
    list.innerHTML = ''
    const rows = [...entries].reverse().slice(0, 500) // newest first, bounded DOM
    emptyNote.hidden = rows.length > 0
    const now = Date.now()
    for (const t of rows) {
      const badge = el('span', { class: `trail-badge is-${t.outcome}`, text: t.outcome })
      const verb = el('span', { class: 'trail-verb', text: t.verb })
      const target = el('span', { class: 'trail-target', text: t.target })
      const meta = el('span', {
        class: 'trail-meta',
        text: `${t.source} · ${wsName(t.workspaceId)}${t.pane ? ` · pane ${t.pane}` : ''} · ${fmtAge(t.ts, now)}`
      })
      const row = el('div', { class: 'trail-row' }, [badge, verb, target, meta])
      if (t.reason) row.title = t.reason
      list.append(row)
    }
  }

  async function refresh(): Promise<void> {
    disarmClear()
    const wsId = wsSelect.value
    clearBtn.disabled = !wsId
    const entries = (await bridge.invoke(IntegrationsChannels.trailList, wsId)) as TrailEntry[]
    const src = srcSelect.value as TrailSource | ''
    renderRows(src ? entries.filter((e) => e.source === src) : entries)
  }

  function refreshWorkspaceOptions(): void {
    const current = wsSelect.value
    wsSelect.innerHTML = ''
    wsSelect.append(el('option', { value: '', text: 'All workspaces' }))
    for (const w of getWorkspaces().workspaces) wsSelect.append(el('option', { value: w.id, text: w.name }))
    wsSelect.value = current
  }

  wsSelect.onchange = (): void => void refresh()
  srcSelect.onchange = (): void => void refresh()
  refreshBtn.onclick = (): void => {
    refreshWorkspaceOptions()
    void refresh()
  }
  exportBtn.onclick = async (): Promise<void> => {
    await bridge.invoke(IntegrationsChannels.trailExport, wsSelect.value)
  }
  clearBtn.onclick = async (): Promise<void> => {
    if (!wsSelect.value) return
    if (!clearArmed) {
      clearArmed = true
      clearBtn.textContent = 'Really clear? This cannot be undone'
      clearBtn.classList.add('is-armed')
      return
    }
    await bridge.invoke(IntegrationsChannels.trailClear, wsSelect.value)
    disarmClear()
    void refresh()
  }

  // Retention honesty + the FINDINGS threat model, in user words.
  const honesty = el('div', { class: 'settings-row-caption trail-honesty' }, [
    el('span', {
      text:
        'An agent on your live sessions can be manipulated into acting as you — this page is how you check what it did. ' +
        'The trail is kept on this machine only, capped (oldest entries roll off), cleared by you, and never sent anywhere. ' +
        'Entries carry verbs, origins, and refs — never page content, typed text, or cookies.'
    })
  ])

  const absorption = el('div', { class: 'settings-row-caption trail-absorb', text: 'Server registration and the integrations catalog land here next (8/06+).' })

  const controls = el('div', { class: 'trail-controls' }, [wsSelect, srcSelect, refreshBtn, exportBtn, clearBtn])
  const block = el('div', { class: 'trail-block' }, [
    el('div', { class: 'settings-row-label', text: 'Agent activity' }),
    honesty,
    controls,
    emptyNote,
    list,
    absorption
  ])

  // First paint: populate lazily so a fresh settings open shows live data.
  setTimeout(() => {
    refreshWorkspaceOptions()
    void refresh()
  }, 0)

  return block
}
