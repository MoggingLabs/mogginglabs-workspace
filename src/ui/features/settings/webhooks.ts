import { BRIDGE_EVENTS, IntegrationsChannels, type BridgeEventName } from '@contracts'
import { getBridge } from '../../core/ipc/bridge'
import {
  Button,
  Card,
  EmptyState,
  FieldGroup,
  Pill,
  SectionHeader,
  clear,
  confirmDialog,
  createCheckbox,
  el,
  showToast,
  submitWithRetain
} from '../../components'
import { getWorkspaces } from '../../core/workspace/workspace-info-port'
import { onViewChange } from '../../core/shell/view-port'

/**
 * Settings § Webhooks — the event bridge (8/10), promoted OUT of Integrations
 * into its own tab: it wires HOUSE events to YOUR automations, and has nothing
 * to do with MCP servers, plans, or grants. Same rule as before the move — one
 * module, one home; no webhook knob renders anywhere else. On a page of its
 * own there is no fold to bury a failing hook under: health reads per row.
 *
 * Rebuilt on the house kit (F-34): the form used to be three placeholder-only
 * inputs, raw event ids as checkbox labels, and a submit shaped exactly like
 * the fields above it. Labels are visible now (placeholder-as-label vanishes
 * the moment you type — WCAG 3.3.2), events read as sentences with the wire id
 * as a code chip, and the payload spec waits behind a disclosure instead of
 * opening the page (F-35). The `data-wh-*` hooks and the `.mgr-note` error are
 * SECRETFORMS' compatibility surface — the retain-on-refusal contract is
 * asserted through them.
 */
interface WebhookView {
  id: string
  label: string
  events: BridgeEventName[]
  workspaceId?: string
  urlMask: string
  health: 'ok' | 'failing' | 'off'
}

/** The wire ids are the API; people pick events by what happened (F-34). */
const EVENT_LABEL: Record<BridgeEventName, string> = {
  'needs-you': 'A pane needs you',
  notify: 'Any notification an agent sends',
  'card-moved': 'A board card moved',
  'review-changed': 'A review changed'
}

export function createWebhooksSection(): HTMLElement {
  const bridge = getBridge()
  const list = el('div', { class: 'mgr-list' })
  const note = el('div', { class: 'settings-error mgr-note', role: 'alert', hidden: true })

  const labelInput = el('input', { class: 'input', placeholder: 'n8n build alerts', dataset: { whField: 'label' } }) as HTMLInputElement
  const urlInput = el('input', { class: 'input', placeholder: 'https://…', dataset: { whField: 'url' } }) as HTMLInputElement
  urlInput.type = 'password'
  const envInput = el('input', { class: 'input', placeholder: 'N8N_WEBHOOK_URL', dataset: { whField: 'envref' } }) as HTMLInputElement
  for (const i of [labelInput, urlInput, envInput]) i.addEventListener('keydown', (e) => e.stopPropagation())

  const evBoxes = new Map<BridgeEventName, ReturnType<typeof createCheckbox>>()
  const evRow = el('div', { class: 'evbridge-events' }, BRIDGE_EVENTS.map((ev) => {
    const cb = createCheckbox({ label: EVENT_LABEL[ev], checked: ev === 'notify' || ev === 'needs-you' })
    cb.el.classList.add('evbridge-ev')
    cb.el.append(el('code', { class: 'wh-ev-id', text: ev })) // the wire id, as a chip beside its sentence
    evBoxes.set(ev, cb)
    return cb.el
  }))
  const insecureBox = createCheckbox({ label: 'Allow insecure LAN http' })

  const wsSelect = el('select', { class: 'input input-sm', ariaLabel: 'Workspace scope' }) as HTMLSelectElement
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

  const saveBtn = Button({ label: 'Add webhook', variant: 'primary', size: 'sm' })
  saveBtn.dataset.whAction = 'save'

  const HEALTH_PILL: Record<WebhookView['health'], { text: string; tone: 'success' | 'danger' | 'neutral' }> = {
    ok: { text: 'Healthy', tone: 'success' },
    failing: { text: 'Failing', tone: 'danger' },
    off: { text: 'Idle', tone: 'neutral' }
  }
  function row(w: WebhookView): HTMLElement {
    // Default (30px) size, not sm — the 28px hit floor SETINTEG measures on these
    // dense rows holds here too.
    const del = Button({
      label: 'Delete',
      variant: 'ghost',
      onClick: () => {
        void confirmDialog({ title: `Delete webhook “${w.label}”?`, message: 'It stops receiving events. This can’t be undone.', confirmLabel: 'Delete', danger: true }).then(async (ok) => {
          if (ok) {
            await bridge.invoke(IntegrationsChannels.webhookRemove, w.id)
            await refresh()
          }
        })
      }
    })
    const test = Button({
      label: 'Send test',
      variant: 'outline',
      onClick: () => {
        void bridge.invoke(IntegrationsChannels.webhookTest, w.id)
        showToast({ title: 'Test event queued', body: w.label, tone: 'info' })
      }
    })
    return el('div', { class: 'mgr-row' }, [
      el('span', { class: 'mgr-label', text: w.label }),
      Pill(HEALTH_PILL[w.health]),
      el('span', { class: 'mgr-id mono', text: `${w.urlMask} · ${w.events.join(', ')}${w.workspaceId ? ' · scoped' : ''}` }),
      test,
      del
    ])
  }

  // ONE painter. `refresh()` and the pushed health change both land here, so a
  // failing webhook repaints its row whichever path discovered it.
  function paint(hooks: WebhookView[]): void {
    clear(list)
    if (!hooks.length) {
      list.append(
        EmptyState({
          icon: 'bell',
          title: 'No webhooks yet',
          body: 'When a pane needs you, ring your own automation — n8n, Make, or Slack. Add one below.'
        })
      )
    }
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
          events: [...evBoxes.entries()].filter(([, cb]) => cb.checked()).map(([ev]) => ev),
          workspaceId: wsSelect.value || undefined,
          insecureAck: insecureBox.checked()
        }) as Promise<{ ok: boolean; reason?: string }>,
      onSuccess: () => refresh()
    })
  }
  bridge.on(IntegrationsChannels.webhookHealthChanged, (payload) => paint((payload as WebhookView[]) ?? []))

  // The payload spec matters at integration time, not arrival time (F-35) — one
  // sentence leads; the exact wire shape waits behind its disclosure.
  const payloadPre = el('pre', {
    class: 'prov-log wh-payload',
    text: '{ v, event, ts, workspace, pane?, card?, note? }\n— ids and your notify’s note, never scrollback or diffs.'
  })
  payloadPre.hidden = true
  const payloadBtn: HTMLButtonElement = Button({
    label: 'Payload details',
    variant: 'ghost',
    size: 'sm',
    onClick: () => {
      payloadPre.hidden = !payloadPre.hidden
      payloadBtn.textContent = payloadPre.hidden ? 'Payload details' : 'Hide payload'
    }
  })

  const form = el('div', { class: 'wh-form' }, [
    el('div', { class: 'wh-form-grid' }, [
      FieldGroup({ label: 'Name', hint: 'What this webhook is for.' }, labelInput),
      FieldGroup({ label: 'Webhook URL', hint: 'A secret — pasted once, encrypted, shown masked. https, or loopback/LAN http.' }, urlInput),
      FieldGroup({ label: 'Or an env reference', hint: 'Resolved from your environment at delivery — nothing stored.' }, envInput),
      FieldGroup({ label: 'Workspace', hint: 'Deliveries can be scoped to one workspace.' }, wsSelect)
    ]),
    FieldGroup({ label: 'Events' }, evRow),
    el('div', { class: 'wh-form-actions' }, [insecureBox.el, el('span', { class: 'ph-spacer' }), saveBtn])
  ])

  const block = el('div', { class: 'trail-block mgr-block' }, [
    el('div', {
      class: 'settings-row-caption',
      text: 'POSTs a small JSON event to n8n, Make, or Slack. Outbound only — nothing listens. The URL is a secret: pasted once, encrypted, shown masked.'
    }),
    el('div', { class: 'trail-controls' }, [payloadBtn]),
    payloadPre,
    list,
    form,
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

  // Headed now that the card shares a page with the other notification homes (F-08).
  return Card(
    {
      header: SectionHeader({
        title: 'Webhooks',
        caption: 'When a pane needs you — or a card moves, or a review changes — ring your own automations.'
      })
    },
    [block]
  )
}
