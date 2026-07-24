import {
  ConnectionsChannels,
  IntegrationsChannels,
  clientFormHelp,
  connectionIdentityRow,
  connectionScopes,
  connectionSummary,
  planHasServerForCli,
  ACCOUNT_NOTE_MAX,
  type Connection,
  type ConnectionState,
  type WorkspaceToolPlan
} from '@contracts'
import { getBridge } from '../../core/ipc/bridge'
import { getWorkspaces } from '../../core/workspace/workspace-info-port'
import { EmptyState, Button, clear, el, icon, loadingRow, providerLogo, showToast, submitWithRetain } from '../../components'
import { HOSTED } from './cli-meta'

/**
 * Settings § Connections (ADR 0014) — the page's new first citizen.
 *
 * A card here is a CONNECTION TO AN ACCOUNT, and nothing else. It is deliberately
 * not a CLI knob: there is no "which CLIs?" checkbox, no config preview, no apply
 * button. You connect your Sentry account to the APP, once, and the card tells you
 * the truth about it — who you are, how many tools the server actually served, and
 * when the grant renews. Which CLIs then RECEIVE the connection is a tool-plan
 * question, and it lives where every other scoping question lives, below.
 *
 * Everything on a card was answered by the server. Nothing is inferred from the
 * presence of a config block, and nothing is scraped out of a CLI's stdout.
 */

const STATE_LABEL: Record<ConnectionState, string> = {
  connected: 'connected',
  connecting: 'connecting…',
  disconnected: 'not connected',
  expired: 'expired',
  error: 'error'
}

export interface ConnectionsBlock {
  block: HTMLElement
  sync: () => void
}

export interface ConnectionsBlockOpts {
  /** true (the Library): every service renders, including the never-touched
   *  "Available" group — this is the browse surface. false (Settings): the
   *  INVENTORY — only what is connected or needs attention; browsing lives in
   *  the Library, and the empty state points there. */
  browse?: boolean
  /** Inventory mode's empty-state CTA — opens the Library. */
  onBrowse?: () => void
  /** Offer "Use in workspaces…" on connected cards: scoping in the same flow as
   *  connecting, so the store→settings hand-off never loses the user. */
  workspaceScoping?: boolean
  onChange?: (cs: Connection[]) => void
}

export function createConnectionsBlock(opts: ConnectionsBlockOpts = {}): ConnectionsBlock {
  const browse = opts.browse !== false
  const bridge = getBridge()
  const grid = el('div', { class: 'conn-grid' })
  // F-20: forty equal cards in catalog order made finding Slack a scan job. A filter
  // field (the Usage tab's exact pattern) + state groups: what's live reads first,
  // what needs you second, the directory third — alphabetical inside each.
  const searchInput = el('input', { class: 'input input-sm conn-search', ariaLabel: 'Filter services' }) as HTMLInputElement
  searchInput.type = 'search'
  searchInput.placeholder = 'Filter services…'
  searchInput.addEventListener('keydown', (e) => e.stopPropagation())
  searchInput.addEventListener('input', () => paint())
  let connections: Connection[] = []
  /** Which cards have their key form open — a repaint must not close a form the
   *  user is mid-paste in. Keyed by service, not by node: the node is rebuilt. */
  const keyFormOpen = new Set<string>()
  /** What the user has TYPED into an open form, keyed by service. The grid repaints
   *  wholesale on every push — any connection changing state rebuilds every card's
   *  DOM — and an input rebuilt empty is a pasted key eaten mid-thought. The draft
   *  survives the rebuild; it dies on success or an explicit close, never sooner. */
  const drafts = new Map<string, { key: string; url: string }>()
  const draftFor = (id: string): { key: string; url: string } => {
    const d = drafts.get(id) ?? { key: '', url: '' }
    drafts.set(id, d)
    return d
  }
  /** Which cards have their tool list expanded — same repaint-survival rule. */
  const toolsOpen = new Set<string>()
  /** Which cards have their workspace-scoping panel expanded — same rule. */
  const scopeOpen = new Set<string>()
  /** The account-note editor (phase-tools/04) — same repaint-survival rules: the
   *  open-state and the typed draft outlive the wholesale grid repaint. */
  const noteFormOpen = new Set<string>()
  const noteDrafts = new Map<string, string>()
  /** The client-id form (no-DCR providers: Google, GitHub, Slack) — same
   *  repaint-survival rules as the key form: open-state and typed drafts are keyed
   *  by service, because the grid repaints wholesale and a rebuilt input is a
   *  pasted secret eaten mid-thought. */
  const clientFormOpen = new Set<string>()
  const clientDrafts = new Map<string, { id: string; secret: string; url: string }>()
  const clientDraftFor = (id: string): { id: string; secret: string; url: string } => {
    const d = clientDrafts.get(id) ?? { id: '', secret: '', url: '' }
    clientDrafts.set(id, d)
    return d
  }

  async function refresh(): Promise<void> {
    connections = ((await bridge.invoke(ConnectionsChannels.list)) as Connection[]) ?? []
    paint()
  }

  function paint(): void {
    clear(grid)
    if (!connections.length) {
      grid.append(EmptyState({ icon: 'plug', title: 'No services to connect', body: 'The catalog is empty.' }))
      return
    }
    const q = searchInput.value.trim().toLowerCase()
    const visible = connections.filter((c) => !q || c.label.toLowerCase().includes(q) || c.id.includes(q))
    const groups: { label: string; test: (c: Connection) => boolean }[] = [
      { label: 'Connected', test: (c) => c.state === 'connected' || c.state === 'connecting' },
      { label: 'Needs attention', test: (c) => c.state === 'expired' || c.state === 'error' },
      // The Available group is the BROWSE surface — Library only. The settings
      // inventory shows what you have; what you could get lives in the Library.
      ...(browse ? [{ label: 'Available', test: (c: Connection) => c.state === 'disconnected' }] : [])
    ]
    let any = false
    for (const g of groups) {
      const mine = visible.filter(g.test).sort((a, b) => a.label.localeCompare(b.label))
      if (!mine.length) continue
      any = true
      grid.append(el('div', { class: 'section-label conn-group-label', text: `${g.label} · ${mine.length}` }))
      const groupGrid = el('div', { class: 'conn-group-grid' })
      for (const c of mine) groupGrid.append(card(c))
      grid.append(groupGrid)
    }
    if (!any && q) grid.append(el('div', { class: 'menu-note', text: 'No service matches that filter.' }))
    if (!any && !q && !browse) {
      // Inventory-mode empty state: nothing connected yet is a NORMAL state, and
      // its one useful exit is the Library.
      grid.append(
        el('div', { class: 'conn-inventory-empty' }, [
          EmptyState({
            icon: 'plug',
            title: 'Nothing connected yet',
            body: 'Browse the Library to connect your first service — sign in once, and every agent you launch can use it.'
          }),
          ...(opts.onBrowse
            ? [el('div', { class: 'trail-controls' }, [Button({ label: 'Browse the Library', icon: 'plug', variant: 'primary', onClick: opts.onBrowse })])]
            : [])
        ])
      )
    }
    // The filter field is browse furniture: hide it when the inventory is empty.
    searchInput.hidden = !browse && connections.every((c) => c.state === 'disconnected')
    opts.onChange?.(connections)
  }

  // ── "Use in workspaces…" (scoping in the same flow as connecting) ──────────
  // A connected service is only USABLE where a workspace's tool plan carries it.
  // This panel is that decision, made on the card — one checkbox per workspace,
  // each toggle writing the plan for every CLI at once. The per-CLI matrix in
  // Settings › Integrations › Workspace tools stays the precision instrument.
  function scopePanel(c: Connection): HTMLElement {
    const host = el('div', { class: 'conn-scope-panel' })
    const workspaces = getWorkspaces().workspaces
    if (!workspaces.length) {
      host.append(el('div', { class: 'menu-note', text: 'No workspace open — create one, and its wizard offers this tool as a chip.' }))
      return host
    }
    host.append(loadingRow('Reading workspace plans…'))
    void (async () => {
      const rows: HTMLElement[] = []
      for (const w of workspaces) {
        let plan: WorkspaceToolPlan | null = null
        try {
          plan = (await bridge.invoke(IntegrationsChannels.planGet, w.id)) as WorkspaceToolPlan
        } catch {
          /* plan unavailable — the row below says so */
        }
        if (!plan) {
          rows.push(el('div', { class: 'menu-note', text: `${w.name}: plan unavailable` }))
          continue
        }
        const on = HOSTED.some((cli) => planHasServerForCli(plan!, c.id, cli))
        const box = el('input', { class: 'conn-scope-check' }) as HTMLInputElement
        box.type = 'checkbox'
        box.checked = on
        box.onchange = (): void => {
          const enabled = box.checked
          box.disabled = true
          box.setAttribute('aria-busy', 'true')
          void (async () => {
            try {
              for (const cli of HOSTED) {
                await bridge.invoke(IntegrationsChannels.planMutate, { workspaceId: w.id, kind: 'cell', serverId: c.id, cli, enabled })
              }
            } catch (error) {
              box.checked = !enabled // put the box back where the truth is
              showToast({ tone: 'danger', title: `${c.label} was not ${enabled ? 'added to' : 'removed from'} ${w.name}`, body: String(error) })
            } finally {
              if (box.isConnected) {
                box.disabled = false
                box.removeAttribute('aria-busy')
              }
            }
          })()
        }
        rows.push(el('label', { class: 'conn-scope-row' }, [box, el('span', { text: w.name })]))
      }
      clear(host)
      host.append(...rows)
    })()
    return host
  }

  // The note editor: a label, not a secret — but it is the user's words, so the
  // draft survives repaints and dies only on save or an explicit close. Saving an
  // empty field deletes the note (the only hand that ever does).
  function noteForm(c: Connection): HTMLElement {
    const input = el('input', { class: 'input input-sm conn-note-input', ariaLabel: `Account note for ${c.label}` }) as HTMLInputElement
    input.maxLength = ACCOUNT_NOTE_MAX
    input.placeholder = 'e.g. work account — pedro@company.com'
    input.value = noteDrafts.get(c.id) ?? c.accountNote ?? ''
    input.addEventListener('keydown', (e) => e.stopPropagation())
    input.addEventListener('input', () => noteDrafts.set(c.id, input.value))
    const save = el('button', { class: 'trail-btn conn-mini', type: 'button', text: 'Save' }) as HTMLButtonElement
    save.onclick = (): void => {
      void (async () => {
        save.disabled = true
        save.setAttribute('aria-busy', 'true')
        save.textContent = 'Saving…'
        await bridge.invoke(ConnectionsChannels.setNote, { serviceId: c.id, note: input.value })
        noteDrafts.delete(c.id)
        noteFormOpen.delete(c.id)
        // The push from main repaints with the new truth; nothing else to do here.
      })()
    }
    const cancel = el('button', { class: 'trail-btn conn-mini', type: 'button', text: 'Cancel' }) as HTMLButtonElement
    cancel.onclick = (): void => {
      noteDrafts.delete(c.id)
      noteFormOpen.delete(c.id)
      paint()
    }
    const form = el('div', { class: 'conn-note-form' }, [input, save, cancel])
    setTimeout(() => input.focus(), 0)
    return form
  }

  function card(c: Connection): HTMLElement {
    const chip = el('span', { class: `conn-chip is-${c.state}`, text: STATE_LABEL[c.state] })
    const head = el('div', { class: 'conn-card-head' }, [
      providerLogo(c.id, 16),
      el('span', { class: 'conn-label', text: c.label }),
      chip
    ])
    // WHOSE account — the line the user is actually here to read. It gets its own row,
    // above everything else, because "am I connected as the right account?" is the
    // question a connection card exists to answer. The wording is the CONTRACT's
    // (connectionIdentityRow, phase-tools/04): probed beats noted, a note is never
    // presented as proof ("noted by you", always), and when the provider never told
    // us the blank is EXPLAINED rather than left silent — never filled with a guess.
    // No identity row for a `local` connection: an open server has no account, so
    // "signed in as nobody" would be a false sentence where no sentence is due.
    const row = connectionIdentityRow(c)
    let identity: HTMLElement | null = null
    if (c.state === 'connected' && c.authKind !== 'local' && row) {
      identity = el(
        'div',
        {
          class: `conn-account conn-identity is-${row.kind}${row.kind === 'none' ? ' is-unknown' : ''}`,
          // `tool`-derived identity is captioned softer: the server reported it about
          // itself, where oidc/rest came through the provider's own identity door.
          attrs: row.kind === 'probed' && row.source === 'tool' ? { title: 'Reported by the server itself.' } : {}
        },
        [
          icon(row.kind === 'probed' ? 'user' : 'info', 13),
          el('span', { class: 'conn-identity-text', text: row.text })
        ]
      )
      if (row.kind === 'probed' && row.secondaryNote) {
        // The "wrong account" catch: the user's own label disagrees with the provider's
        // answer — both truths render, the provider's first, the note visibly secondary.
        identity.append(el('span', { class: 'conn-note-secondary', text: row.secondaryNote }))
      }
      const noteBtn = el('button', {
        class: 'trail-btn conn-mini conn-note-edit',
        type: 'button',
        text: c.accountNote ? 'Edit note' : 'Add a note…'
      }) as HTMLButtonElement
      noteBtn.onclick = (): void => {
        noteFormOpen.add(c.id)
        paint()
      }
      identity.append(noteBtn)
      if (noteFormOpen.has(c.id)) identity.append(noteForm(c))
    }

    // ONE sentence, written by the contract — so "connected" can never be worded
    // two different ways by two different pens. F-21: an idle card's summary is the
    // literal chip text again ("Not connected." under a not-connected pill) ×40 cards —
    // the line earns its row only when it adds facts (who, what failed, when it renews).
    const summaryText = connectionSummary(c)
    const summary =
      c.state === 'disconnected' && c.authKind !== 'local'
        ? null
        : el('div', { class: `conn-summary${c.state === 'error' ? ' is-error' : ''}`, text: summaryText })

    // What the grant can DO. Being signed in as the right person with the wrong powers
    // is still the wrong connection, and this is the only place a user can see which.
    const grantScopes = connectionScopes(c)
    const scopeLine = grantScopes.length
      ? el('div', {
          class: 'conn-scopes',
          text: `Can: ${grantScopes.join(' · ')}`,
          attrs: { title: grantScopes.join('\n') }
        })
      : null

    // Full observability: the actual TOOL NAMES this connection serves — what an
    // agent can really do through it, listed by the server itself, not a bare count.
    let toolsBlock: HTMLElement | null = null
    if (c.state === 'connected' && c.tools?.length) {
      const open = toolsOpen.has(c.id)
      const toggle = el('button', {
        class: 'conn-tools-toggle',
        type: 'button',
        text: `${open ? '▾' : '▸'} ${c.tools.length}${(c.toolCount ?? 0) > c.tools.length ? ` of ${c.toolCount}` : ''} tools`,
        attrs: { 'aria-expanded': String(open) }
      }) as HTMLButtonElement
      toggle.onclick = (): void => {
        if (toolsOpen.has(c.id)) toolsOpen.delete(c.id)
        else toolsOpen.add(c.id)
        paint()
      }
      toolsBlock = el('div', { class: 'conn-tools' }, [
        toggle,
        ...(open
          ? [el('div', { class: 'conn-tools-list' }, c.tools.map((t) => el('span', { class: 'conn-tool', text: t })))]
          : [])
      ])
    }

    const actions = el('div', { class: 'conn-actions' })
    const body = el('div', { class: 'conn-card-body' })

    const busy = (btn: HTMLButtonElement, on: boolean, text?: string): void => {
      btn.disabled = on
      if (on) btn.setAttribute('aria-busy', 'true')
      else btn.removeAttribute('aria-busy')
      if (text) btn.textContent = text
    }

    // ── The connect on-ramp. Two shapes of truth: an OAuth service opens the
    // user's browser and finishes LATER (the push repaints); a no-account service
    // has no consent to wait on — connect() returns the final verdict directly.
    const beginConnect = (btn: HTMLButtonElement): void => {
      const local = c.authKind === 'local'
      void (async () => {
        busy(btn, true, local ? 'Connecting…' : 'Opening your browser…')
        try {
          const r = (await bridge.invoke(ConnectionsChannels.connect, { serviceId: c.id })) as {
            ok: boolean
            reason?: string
          }
          if (!r.ok) {
            showToast({ tone: 'danger', title: `${c.label} was not connected`, body: r.reason ?? 'The attempt was refused.' })
            busy(btn, false, 'Connect')
            return
          }
          if (local) return // done for real — the push has already repainted this card
          // Deliberately NOT re-enabled here. The flow is not finished — the user is
          // at a consent screen. The `changed` push repaints this card when they land.
          showToast({
            tone: 'info',
            title: `Finish signing in to ${c.label}`,
            body: 'We opened your browser. The card updates the moment you approve.',
            timeout: 8000
          })
        } catch (e) {
          showToast({ tone: 'danger', title: `${c.label} was not connected`, body: String(e) })
          busy(btn, false, 'Connect')
        }
      })()
    }

    // ── The key on-ramp: paste once, and we PROVE it before claiming success ──
    const keyForm = (): HTMLElement => {
      const draft = draftFor(c.id)
      let urlInput: HTMLInputElement | null = null
      // Self-hosted (n8n, Make): the key means nothing without the instance URL, and
      // this field used to not exist — the submit refused with "paste your instance's
      // MCP URL first" while offering no pixel to paste it into.
      if (c.needsBaseUrl) {
        urlInput = el('input', {
          class: 'browser-sites-input conn-key-input',
          placeholder: 'https://your-instance… (its MCP URL)'
        }) as HTMLInputElement
        urlInput.value = draft.url
        urlInput.setAttribute('aria-label', `${c.label} instance URL`)
        urlInput.spellcheck = false
        urlInput.addEventListener('keydown', (e) => e.stopPropagation())
        urlInput.addEventListener('input', () => (draft.url = urlInput!.value))
      }
      const input = el('input', { class: 'browser-sites-input conn-key-input', placeholder: 'paste your API key…' }) as HTMLInputElement
      input.type = 'password'
      input.value = draft.key
      input.addEventListener('keydown', (e) => e.stopPropagation())
      input.addEventListener('input', () => (draft.key = input.value))
      const save = el('button', { class: 'trail-btn is-armed', type: 'button', text: 'Connect' }) as HTMLButtonElement
      // Closing is a CANCEL (the 8/06 form's lesson): the draft dies with it, so a
      // half-typed key never sits in memory waiting to reappear next session.
      const close = el('button', { class: 'trail-btn conn-mini', type: 'button', text: 'Close' }) as HTMLButtonElement
      close.onclick = (): void => {
        drafts.delete(c.id)
        keyFormOpen.delete(c.id)
        paint()
      }
      const note = el('div', { class: 'conn-summary is-error', hidden: true, role: 'alert' })
      save.onclick = (): void => {
        const value = input.value
        if (!value.trim()) return
        void (async () => {
          busy(save, true, 'Checking the key…')
          note.hidden = true
          const r = (await bridge.invoke(ConnectionsChannels.submitKey, {
            serviceId: c.id,
            value,
            baseUrl: urlInput?.value.trim() || undefined
          })) as { ok: boolean; reason?: string }
          if (!r.ok) {
            // The key stays in the field AND in the draft: it was pasted once, and a
            // refusal the user can fix (a typo, a wrong scope) must not eat it —
            // not directly, and not via a state-push repaint (main no longer pushes
            // an intermediate state for exactly this reason).
            note.textContent = r.reason ?? 'The key was refused.'
            note.hidden = false
            busy(save, false, 'Connect')
            return
          }
          drafts.delete(c.id) // verified and vaulted — the plaintext leaves the DOM and the draft
          keyFormOpen.delete(c.id)
          showToast({ tone: 'success', title: `${c.label} connected`, body: 'The key is encrypted by your OS keychain.' })
        })()
      }
      return el('div', { class: 'conn-key-form' }, [...(urlInput ? [urlInput] : []), input, save, close, note])
    }

    // ── The client-id on-ramp (no-DCR providers). The provider will not let apps
    // register themselves, so the user creates an OAuth client ONCE in the
    // provider's own console and pastes it here; consent then runs exactly like
    // every other connection. One pasted client covers every service that signs
    // in at the same place — all of Google Workspace is one client.
    const clientForm = (): HTMLElement => {
      const draft = clientDraftFor(c.id)
      // ONE sentence, written by the contract — so the form and the backend's
      // redirect-mismatch advice can never name two different consoles.
      const help = el('div', { class: 'conn-summary', text: clientFormHelp(c.authServer) })
      let urlInput: HTMLInputElement | null = null
      if (c.needsBaseUrl) {
        urlInput = el('input', {
          class: 'browser-sites-input conn-key-input',
          placeholder: 'https://your-instance… (its MCP URL)'
        }) as HTMLInputElement
        urlInput.value = draft.url
        urlInput.setAttribute('aria-label', `${c.label} instance URL`)
        urlInput.spellcheck = false
        urlInput.addEventListener('keydown', (e) => e.stopPropagation())
        urlInput.addEventListener('input', () => (draft.url = urlInput!.value))
      }
      const idInput = el('input', { class: 'browser-sites-input conn-key-input', placeholder: 'client ID…' }) as HTMLInputElement
      idInput.value = draft.id
      idInput.spellcheck = false
      idInput.setAttribute('aria-label', `${c.label} OAuth client ID`)
      idInput.addEventListener('keydown', (e) => e.stopPropagation())
      idInput.addEventListener('input', () => (draft.id = idInput.value))
      const secretInput = el('input', {
        class: 'browser-sites-input conn-key-input',
        placeholder: 'client secret (if the provider issued one)…'
      }) as HTMLInputElement
      secretInput.type = 'password'
      secretInput.value = draft.secret
      secretInput.setAttribute('aria-label', `${c.label} OAuth client secret`)
      secretInput.addEventListener('keydown', (e) => e.stopPropagation())
      secretInput.addEventListener('input', () => (draft.secret = secretInput.value))
      const save = el('button', { class: 'trail-btn is-armed', type: 'button', text: 'Save & connect' }) as HTMLButtonElement
      const close = el('button', { class: 'trail-btn conn-mini', type: 'button', text: 'Close' }) as HTMLButtonElement
      close.onclick = (): void => {
        // Closing is a CANCEL: the draft dies with it, half-typed secret and all.
        clientDrafts.delete(c.id)
        clientFormOpen.delete(c.id)
        paint()
      }
      const note = el('div', { class: 'conn-summary is-error', hidden: true, role: 'alert' })
      // submitWithRetain is the ONE submit path for a form that carries a secret
      // (audit finding 35): retain-on-failure, scrub-on-success, a throw treated as
      // a refusal, and the button always coming back alive. The failure TOAST exists
      // because once connect() starts pushing states the grid repaints and this
      // form's own `note` may already be a detached node — the toast survives that.
      save.onclick = (): void => {
        if (!idInput.value.trim()) return
        void submitWithRetain({
          trigger: save,
          retainFields: [idInput, secretInput],
          errorEl: note,
          submit: () =>
            bridge.invoke(ConnectionsChannels.setClient, {
              serviceId: c.id,
              clientId: idInput.value,
              clientSecret: secretInput.value.trim() || undefined,
              baseUrl: urlInput?.value.trim() || undefined
            }) as Promise<{ ok: boolean; reason?: string }>,
          onSuccess: () => {
            clientDrafts.delete(c.id) // vaulted — the plaintext leaves the DOM and the draft
            clientFormOpen.delete(c.id)
            paint() // close the form NOW; the pushes will repaint again with the real state
            showToast({
              tone: 'info',
              title: `Finish signing in to ${c.label}`,
              body: 'The client is saved (encrypted by your OS keychain) and we opened your browser. The card updates the moment you approve.',
              timeout: 8000
            })
          },
          onFailure: (r) => {
            // The draft survives a fixable refusal (a typo, an offline moment) —
            // pasted once means pasted once.
            showToast({
              tone: 'danger',
              title: `${c.label} was not connected`,
              body: ('reason' in r ? r.reason : undefined) ?? 'The client was refused.'
            })
          }
        })
      }
      return el('div', { class: 'conn-key-form' }, [help, ...(urlInput ? [urlInput] : []), idInput, secretInput, save, close, note])
    }

    // "Forget client ID": the delete pixel for a pasted client. It exists wherever
    // the user could otherwise be stuck holding a vaulted secret with no way out —
    // including a disconnected card that keeps the client for one-click reconnects.
    const forgetClientButton = (): HTMLButtonElement => {
      const forget = el('button', { class: 'trail-btn trail-clear conn-mini', type: 'button', text: 'Forget client ID' }) as HTMLButtonElement
      forget.onclick = (): void => {
        void (async () => {
          busy(forget, true, 'Forgetting…')
          const r = (await bridge.invoke(ConnectionsChannels.clearClient, c.id)) as { ok: boolean; reason?: string }
          if (!r.ok) {
            showToast({ tone: 'danger', title: 'Nothing was forgotten', body: r.reason ?? 'The attempt was refused.' })
            busy(forget, false, 'Forget client ID')
            return
          }
          showToast({
            tone: 'info',
            title: `${c.label}: client ID forgotten`,
            body: 'The client ID and its secret were deleted from this machine. It covered every service signing in at the same place, so those cards no longer have it either — already-connected ones keep working until their token expires.'
          })
        })()
      }
      return forget
    }

    switch (c.state) {
      case 'connected': {
        if (opts.workspaceScoping) {
          const open = scopeOpen.has(c.id)
          const scope = el('button', {
            class: 'trail-btn conn-mini conn-scope-toggle',
            type: 'button',
            text: open ? 'Hide workspaces' : 'Use in workspaces…',
            attrs: { 'aria-expanded': String(open) }
          }) as HTMLButtonElement
          scope.onclick = (): void => {
            if (scopeOpen.has(c.id)) scopeOpen.delete(c.id)
            else scopeOpen.add(c.id)
            paint()
          }
          actions.append(scope)
          if (open) body.append(scopePanel(c))
        }
        const check = el('button', { class: 'trail-btn conn-mini', type: 'button', text: 'Check' }) as HTMLButtonElement
        check.onclick = (): void => {
          void (async () => {
            busy(check, true, 'Checking…')
            await bridge.invoke(ConnectionsChannels.verify, c.id)
            busy(check, false, 'Check')
          })()
        }
        const drop = el('button', { class: 'trail-btn trail-clear conn-mini', type: 'button', text: 'Disconnect' }) as HTMLButtonElement
        drop.onclick = (): void => {
          void (async () => {
            busy(drop, true, 'Disconnecting…')
            await bridge.invoke(ConnectionsChannels.disconnect, c.id)
            showToast({
              tone: 'info',
              title: `${c.label} disconnected`,
              // Say exactly what we did and did NOT do. We drop OUR credential; we
              // cannot promise the vendor forgot the grant, so we don't imply it —
              // and a pasted client that stays behind is named, not glossed over.
              body: c.userClient
                ? 'The connection’s token was deleted from this machine. Your pasted client ID and secret stay (encrypted) for one-click reconnects — use “Forget client ID” to delete them too. To revoke the grant at the provider, sign out there.'
                : 'The credential was deleted from this machine. To revoke it at the provider too, sign out there.'
            })
          })()
        }
        actions.append(check, drop)
        if (c.userClient) actions.append(forgetClientButton())
        break
      }
      case 'connecting': {
        actions.append(loadingRow('Waiting for you to finish in the browser…'))
        // Without this, an abandoned consent held the card hostage for the full
        // 5-minute timeout with nothing to click.
        const cancel = el('button', { class: 'trail-btn conn-mini', type: 'button', text: 'Cancel' }) as HTMLButtonElement
        cancel.onclick = (): void => {
          void bridge.invoke(ConnectionsChannels.cancel, c.id)
        }
        actions.append(cancel)
        break
      }
      // disconnected | expired | error — all three offer the same verbs, worded for
      // where the user actually is.
      default: {
        const takesKey = c.authKind === 'key' || c.hasKeyOption
        if (takesKey && keyFormOpen.has(c.id)) {
          body.append(keyForm())
          break
        }
        if (clientFormOpen.has(c.id)) {
          body.append(clientForm())
          break
        }
        // A card that NEEDS a client id must not offer a Reconnect that can only
        // fail the same way — the primary verb becomes the form.
        if (c.needsClientId) {
          const open = el('button', { class: 'trail-btn is-armed', type: 'button', text: 'Add client ID…' }) as HTMLButtonElement
          open.onclick = (): void => {
            clientFormOpen.add(c.id)
            paint()
          }
          actions.append(open)
          // The flag is only ever re-derived by a real attempt (connect clears it and
          // sets it again from THIS attempt's discovery). A card whose flag is stale —
          // a sibling-sweep leftover, a provider that gained registration — must keep
          // a verb that runs that attempt, or the paste form becomes a locked door.
          const retry = el('button', { class: 'trail-btn conn-mini', type: 'button', text: 'Try connect' }) as HTMLButtonElement
          retry.onclick = (): void => beginConnect(retry)
          actions.append(retry)
          if (c.hasKeyOption) {
            const useKey = el('button', { class: 'trail-btn conn-mini', type: 'button', text: 'Use API key…' }) as HTMLButtonElement
            useKey.onclick = (): void => {
              keyFormOpen.add(c.id)
              paint()
            }
            actions.append(useKey)
          }
          if (c.userClient) actions.append(forgetClientButton())
          break
        }
        // S4: only a card that needs REPAIR arms its verb — forty idle Connects in
        // accent were noise, and the accent stopped meaning "look here".
        const label = c.state === 'expired' || c.state === 'error' ? 'Reconnect' : 'Connect'
        const armed = label === 'Reconnect' ? ' is-armed' : ''
        if (c.authKind === 'key') {
          const open = el('button', { class: `trail-btn${armed}`, type: 'button', text: label }) as HTMLButtonElement
          open.onclick = (): void => {
            keyFormOpen.add(c.id)
            paint()
          }
          actions.append(open)
        } else {
          // `oauth` and `local` both connect through the same verb; the handler
          // words the wait honestly for each.
          const btn = el('button', { class: `trail-btn${armed}`, type: 'button', text: label }) as HTMLButtonElement
          btn.onclick = (): void => beginConnect(btn)
          actions.append(btn)
          // A dual-auth service (GitHub's PAT, Sentry's auth token): the key path
          // EXISTED in main but had no pixel — this ghost button is its on-ramp.
          if (c.hasKeyOption) {
            const useKey = el('button', { class: 'trail-btn conn-mini', type: 'button', text: 'Use API key…' }) as HTMLButtonElement
            useKey.onclick = (): void => {
              keyFormOpen.add(c.id)
              paint()
            }
            actions.append(useKey)
          }
          // A disconnected card that still holds a pasted client keeps its way out.
          if (c.authKind === 'oauth' && c.userClient) actions.append(forgetClientButton())
        }
      }
    }

    return el('div', { class: `conn-card is-${c.state}`, dataset: { connection: c.id } }, [
      head,
      ...(identity ? [identity] : []),
      ...(summary ? [summary] : []),
      ...(scopeLine ? [scopeLine] : []),
      ...(toolsBlock ? [toolsBlock] : []),
      body,
      ...(actions.childNodes.length ? [actions] : [])
    ])
  }

  const block = el('div', { class: 'trail-block conn-block' }, [
    el('div', {
      class: 'settings-row-caption',
      text: browse
        ? 'Connect a service to MoggingLabs Workspace once, and every agent you launch can use it — no CLI to configure, no key to copy around. Sign-in happens in your own browser, on the provider’s real page. The credential is encrypted by your OS keychain and stays in this app: your CLIs reach the service through us, so no token is ever written into a CLI’s config file.'
        : 'The accounts this app holds a connection to — who you are on each, what the server actually serves, and which workspaces use it. Each credential is encrypted by your OS keychain; Disconnect deletes it from this machine. To connect more, browse the Library.'
    }),
    searchInput,
    grid
  ])

  // The browser lands back here. This push is what turns "click Connect" into
  // something you can SEE: the card repaints the moment the grant is real.
  bridge.on(ConnectionsChannels.changed, (payload) => {
    connections = (payload as Connection[]) ?? []
    paint()
  })

  const sync = (): void => void refresh()
  setTimeout(sync, 0)
  return { block, sync }
}

/** The overview band's one-glance number. */
export const connectedCount = (cs: Connection[]): number => cs.filter((c) => c.state === 'connected').length
