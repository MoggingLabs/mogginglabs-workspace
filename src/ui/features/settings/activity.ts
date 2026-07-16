import { IntegrationsChannels, type TrailEntry, type TrailSource } from '@contracts'
import { createAsyncGuard } from '../../core/async/async-state'
import { getBridge } from '../../core/ipc/bridge'
import { Button, Card, EmptyState, clear, confirmDialog, el } from '../../components'
import { getWorkspaces } from '../../core/workspace/workspace-info-port'
import { onViewChange } from '../../core/shell/view-port'
import { fmtAge } from '../usage'

/**
 * Settings § Activity — the agent audit trail (8/05), promoted OUT of
 * Integrations into the Trust group: it is not an integrations knob, it is how
 * you CHECK what agents did — web acts, MCP writes, webhook deliveries — and it
 * reads alongside Privacy and Browser, which decide what agents may do. One
 * module, one home; the trail renders nowhere else.
 *
 * Toolbar on the house kit (F-40): one control grammar instead of three, and
 * Clear confirms through the same dialog every destructive verb uses — the
 * two-click arming pattern was this tab's private invention.
 *
 * `.trail-activity` stays on the card root and the honesty copy stays ABOVE the
 * list: WEBTRAIL reads 'never sent anywhere' out of that subtree's first 4000
 * characters, and 500 rows would push it past the window.
 */
export function createActivitySection(): HTMLElement {
  const bridge = getBridge()

  const wsSelect = el('select', { class: 'input input-sm trail-ws' }) as HTMLSelectElement
  wsSelect.setAttribute('aria-label', 'Filter by workspace')
  const srcSelect = el('select', { class: 'input input-sm trail-src' }) as HTMLSelectElement
  srcSelect.setAttribute('aria-label', 'Filter by source')
  for (const [v, label] of [
    ['', 'All sources'],
    ['web', 'Web acts'],
    ['mcp', 'MCP writes'],
    ['bridge', 'Webhook deliveries']
  ]) {
    srcSelect.append(el('option', { value: v, text: label }))
  }

  // Default (30px) size, not sm: SETINTEG measures a 28px hit floor on this toolbar.
  const refreshBtn = Button({ label: 'Refresh', variant: 'outline', icon: 'rotate-cw' })
  const exportBtn = Button({ label: 'Export JSON…', variant: 'ghost' })
  const clearBtn = Button({ label: 'Clear this workspace’s trail', variant: 'danger' })

  const list = el('div', { class: 'trail-list' })
  const emptyNote = el('div', { class: 'trail-empty' }, [
    EmptyState({
      icon: 'activity',
      title: 'No agent activity yet',
      body: 'Web acts, MCP writes, and webhook deliveries will appear here as agents work.'
    })
  ])

  const wsName = (id: string): string => getWorkspaces().workspaces.find((w) => w.id === id)?.name ?? id.slice(0, 8)

  function renderRows(entries: TrailEntry[]): void {
    clear(list)
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

  // Finding 39: FOUR things fire refresh() — both selects, the Refresh button, and the view-entry
  // sync — and the workspace id was baked into the REQUEST while renderRows painted whatever came
  // back. Any two firing close together let a slow answer for the OLD filter land after, and over,
  // the fast answer for the new one. The generation guard is the whole fix: a superseded call
  // never renders.
  const trailGuard = createAsyncGuard<TrailEntry[]>()

  async function refresh(): Promise<void> {
    const wsId = wsSelect.value
    clearBtn.disabled = !wsId
    await trailGuard.run(() => bridge.invoke(IntegrationsChannels.trailList, wsId) as Promise<TrailEntry[]>, {
      action: 'load the activity trail',
      // "No agent activity yet" is a claim about a read that SUCCEEDED and came back
      // empty. Never leave it standing over one that is still in flight — or that failed.
      onLoading: () => {
        emptyNote.hidden = true
      },
      onSuccess: (entries) => {
        const src = srcSelect.value as TrailSource | ''
        renderRows(src ? entries.filter((e) => e.source === src) : entries)
      },
      // onError stays the default danger toast — Refresh is one button away, right above the list.
      timeoutMs: 15_000
    })
  }

  function refreshWorkspaceOptions(): void {
    const current = wsSelect.value
    clear(wsSelect)
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
    // F-40: the same destructive grammar as everywhere else — one dialog, side stated.
    const ok = await confirmDialog({
      title: `Clear ${wsName(wsSelect.value)}’s trail?`,
      message: 'Every recorded web act, MCP write, and webhook delivery for this workspace is erased. This cannot be undone.',
      confirmLabel: 'Clear trail',
      danger: true
    })
    if (!ok) return
    await bridge.invoke(IntegrationsChannels.trailClear, wsSelect.value)
    void refresh()
  }

  // Retention honesty + the FINDINGS threat model, in user words. Above the
  // controls: the promise reads before the data it is a promise about.
  const honesty = el('div', { class: 'settings-row-caption trail-honesty' }, [
    el('span', {
      text:
        'An agent on your live sessions can be manipulated into acting as you — this page is how you check what it did. ' +
        'The trail is kept on this machine only, capped (oldest entries roll off), cleared by you, and never sent anywhere. ' +
        'Entries carry verbs, origins, and refs — never page content, typed text, or cookies.'
    })
  ])

  const controls = el('div', { class: 'trail-controls' }, [wsSelect, srcSelect, refreshBtn, exportBtn, clearBtn])
  const block = el('div', { class: 'trail-block' }, [controls, emptyNote, list])

  // The SyncedBlock lesson (8.5/05): the workspace filter reads `getWorkspaces()`
  // and the rows go stale between visits — every entry into Settings re-reads
  // both, deferred a macrotask so the view switch paints first.
  let entryQueued = false
  const sync = (): void => {
    if (entryQueued) return
    entryQueued = true
    setTimeout(() => {
      entryQueued = false
      refreshWorkspaceOptions()
      void refresh()
    }, 0)
  }
  onViewChange((v) => {
    if (v === 'settings') sync()
  })
  sync()

  return Card({ class: 'trail-activity' }, [honesty, block])
}
