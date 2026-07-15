import { BRIDGE_EVENTS, IntegrationsChannels, type BridgeEventName } from '@contracts'
import { getBridge } from '../../core/ipc/bridge'
import { Card, clear, confirmDialog, el, showToast, submitWithRetain } from '../../components'
import { getWorkspaces } from '../../core/workspace/workspace-info-port'
import { onViewChange } from '../../core/shell/view-port'

/**
 * Settings § Webhooks — the event bridge (8/10), promoted OUT of Integrations
 * into its own tab: it wires HOUSE events to YOUR automations, and has nothing
 * to do with MCP servers, plans, or grants. Same rule as before the move — one
 * module, one home; no webhook knob renders anywhere else. On a page of its
 * own there is no fold to bury a failing hook under: health reads per row.
 */
interface WebhookView {
  id: string
  label: string
  events: BridgeEventName[]
  workspaceId?: string
  urlMask: string
  health: 'ok' | 'failing' | 'off'
}

export function createWebhooksSection(): HTMLElement {
  const bridge = getBridge()
  const list = el('div', { class: 'mgr-list' })
  const note = el('div', { class: 'settings-error mgr-note', role: 'alert', hidden: true })

  const labelInput = el('input', { class: 'browser-sites-input mgr-input', placeholder: 'Name (e.g. n8n build alerts)', dataset: { whField: 'label' } }) as HTMLInputElement
  const urlInput = el('input', { class: 'browser-sites-input mgr-input', placeholder: 'Webhook URL (https, or loopback/LAN http)', dataset: { whField: 'url' } }) as HTMLInputElement
  urlInput.type = 'password'
  const envInput = el('input', { class: 'browser-sites-input mgr-input', placeholder: 'or env-ref (e.g. N8N_WEBHOOK_URL)', dataset: { whField: 'envref' } }) as HTMLInputElement
  for (const i of [labelInput, urlInput, envInput]) i.addEventListener('keydown', (e) => e.stopPropagation())
  const evBoxes = new Map<BridgeEventName, HTMLInputElement>()
  const evRow = el('div', { class: 'evbridge-events' }, BRIDGE_EVENTS.map((ev) => {
    const cb = el('input', { attrs: { type: 'checkbox' } }) as HTMLInputElement
    if (ev === 'notify' || ev === 'needs-you') cb.checked = true
    evBoxes.set(ev, cb)
    return el('label', { class: 'evbridge-ev' }, [cb, el('span', { text: ev })])
  }))
  const insecureBox = el('input', { attrs: { type: 'checkbox' } }) as HTMLInputElement
  const wsSelect = el('select', { class: 'trail-select' }) as HTMLSelectElement
  // Populated at BUILD only, before boot's first workspace existed — so a webhook could
  // never be scoped to anything. Repopulated on every entry into Settings.
  const refreshWorkspaces = (): void => {
    const current = wsSelect.value
    clear(wsSelect)
    wsSelect.append(el('option', { value: '', text: 'All workspaces' }))
    for (const w of getWorkspaces().workspaces) wsSelect.append(el('option', { value: w.id, text: w.name }))
    wsSelect.value = current
  }
  refreshWorkspaces()
  const saveBtn = el('button', { class: 'trail-btn', type: 'button', text: 'Add webhook', dataset: { whAction: 'save' } }) as HTMLButtonElement

  const HEALTH_TEXT: Record<string, string> = { ok: 'ok', failing: 'failing', off: 'idle' }
  function row(w: WebhookView): HTMLElement {
    const del = el('button', { class: 'browser-sites-forget', type: 'button', text: 'Delete' }) as HTMLButtonElement
    del.onclick = async (): Promise<void> => {
      const ok = await confirmDialog({ title: `Delete webhook “${w.label}”?`, message: 'It stops receiving events. This can’t be undone.', confirmLabel: 'Delete', danger: true })
      if (ok) { await bridge.invoke(IntegrationsChannels.webhookRemove, w.id); await refresh() }
    }
    const test = el('button', { class: 'trail-btn cat-mini', type: 'button', text: 'Send test' }) as HTMLButtonElement
    test.onclick = (): void => { void bridge.invoke(IntegrationsChannels.webhookTest, w.id); showToast({ title: 'Test event queued', body: w.label, tone: 'info' }) }
    return el('div', { class: 'mgr-row' }, [
      el('span', { class: 'mgr-label', text: w.label }),
      el('span', { class: `evbridge-health is-${w.health}`, text: HEALTH_TEXT[w.health] }),
      el('span', { class: 'mgr-id mono', text: `${w.urlMask} · ${w.events.join(', ')}${w.workspaceId ? ' · scoped' : ''}` }),
      test,
      del
    ])
  }

  // ONE painter. `refresh()` and the pushed health change both land here, so a
  // failing webhook repaints its row whichever path discovered it.
  function paint(hooks: WebhookView[]): void {
    clear(list)
    if (!hooks.length) list.append(el('div', { class: 'menu-note', text: 'No webhooks yet. A pane’s notify (needs-you) can ring n8n, Make, or Slack.' }))
    for (const w of hooks) list.append(row(w))
  }

  async function refresh(): Promise<void> {
    paint(((await bridge.invoke(IntegrationsChannels.webhookList)) as WebhookView[]) ?? [])
  }

  saveBtn.onclick = (): void => {
    // The URL is the secret here (for n8n/Make/Slack it IS the bearer token — the caption
    // says so). It used to be wiped BEFORE the await, so every refusal `saveWebhook` can
    // return — no name, no event ticked, a plain-http host without the LAN ack, an
    // unavailable keychain — took the URL with it, and the user had to go dig it out of
    // n8n again to fix a missing NAME. It now survives every refusal.
    void submitWithRetain({
      trigger: saveBtn,
      retainFields: [urlInput],
      clearFields: [labelInput, envInput],
      errorEl: note,
      submit: () =>
        bridge.invoke(IntegrationsChannels.webhookSave, {
          label: labelInput.value,
          url: urlInput.value || undefined,
          envRef: envInput.value || undefined,
          events: [...evBoxes.entries()].filter(([, cb]) => cb.checked).map(([ev]) => ev),
          workspaceId: wsSelect.value || undefined,
          insecureAck: insecureBox.checked
        }) as Promise<{ ok: boolean; reason?: string }>,
      onSuccess: () => refresh()
    })
  }
  bridge.on(IntegrationsChannels.webhookHealthChanged, (payload) => paint((payload as WebhookView[]) ?? []))

  const block = el('div', { class: 'trail-block mgr-block' }, [
    el('div', { class: 'settings-row-caption', text: 'When a pane needs you — or a card moves, or a review changes — POST a small JSON payload to your own webhook (n8n, Make, Slack). Outbound only, nothing listens. The URL is a secret: pasted once, encrypted, shown masked. Payload: { v, event, ts, workspace, pane?, card?, note? } — ids and your notify’s note, never scrollback or diffs.' }),
    list,
    el('div', { class: 'mgr-form' }, [labelInput, urlInput, envInput, evRow, el('label', { class: 'evbridge-ev' }, [insecureBox, el('span', { text: 'allow insecure LAN http' })]), wsSelect, saveBtn]),
    note
  ])

  // The SyncedBlock lesson (8.5/05): the workspace list and the hook list both go
  // stale between visits, so every entry into Settings re-reads them. Deferred a
  // macrotask so the view switch paints before the IPC round-trips run.
  let entryQueued = false
  const sync = (): void => {
    if (entryQueued) return
    entryQueued = true
    setTimeout(() => {
      entryQueued = false
      refreshWorkspaces()
      void refresh()
    }, 0)
  }
  onViewChange((v) => {
    if (v === 'settings') sync()
  })
  sync()

  return Card({}, [block])
}
