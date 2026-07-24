import {
  BrowserChannels,
  CHOOSER_LABELS,
  ConnectionsChannels,
  CUSTODY_SUBTITLES,
  IntegrationsChannels,
  backupsLine,
  chooserMethods,
  clientFormHelp,
  connectionIdentityRow,
  FIX_PREVIEW_TITLE,
  FIX_SENTENCES,
  type CliFixFlavor,
  connectionScopes,
  connectionSummary,
  groupTag,
  groupToolCards,
  humanizeScopes,
  mergeToolCards,
  planHasServerForCli,
  toolCardTag,
  type ToolCardGroup,
  ACCOUNT_NOTE_MAX,
  type Connection,
  type McpServerEntry,
  type McpStatusSnapshot,
  type ProviderEntry,
  type ToolCardRow,
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

// The status tag is the CONTRACT's (toolCardTag / connectionStatusTag, ADR 0020):
// exactly four sentences, and "Connected" carries the continuous-verification stamp.

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

  /** The OTHER route's facts (phase-tools/05): registry rows, the CLI's own status
   *  read, and the provider catalog the chooser/scopes/setup links render from.
   *  Best-effort — the grid still paints from connections alone if any read fails. */
  let servers: McpServerEntry[] = []
  let snapshot: McpStatusSnapshot | null = null
  let providers = new Map<string, ProviderEntry>()

  async function refresh(): Promise<void> {
    connections = ((await bridge.invoke(ConnectionsChannels.list)) as Connection[]) ?? []
    try {
      servers = ((await bridge.invoke(IntegrationsChannels.serversList)) as McpServerEntry[]) ?? []
      snapshot = ((await bridge.invoke(IntegrationsChannels.statusGet)) as McpStatusSnapshot | null) ?? null
      const cat = (await bridge.invoke(IntegrationsChannels.catList)) as { providers?: ProviderEntry[] } | null
      providers = new Map((cat?.providers ?? []).map((e) => [e.id, e]))
    } catch {
      /* the app-held route is the primary truth; the rest enriches */
    }
    paint()
  }

  function paint(): void {
    clear(grid)
    if (!connections.length) {
      grid.append(EmptyState({ icon: 'plug', title: 'No services to connect', body: 'The catalog is empty.' }))
      return
    }
    // ONE tool = one card, whichever route holds its credential (phase-tools/05):
    // the app-held connections and the CLI-owned registry rows merge by service id —
    // and then families fold into ONE product card (2026-07-24): thirteen Cloudflare
    // capabilities are one tool in the user's head, so they are one card in the grid.
    const rows = mergeToolCards(connections, servers, snapshot)
    const q = searchInput.value.trim().toLowerCase()
    const families = groupToolCards(rows, (id) => providers.get(id)?.group)
    const familyMatches = (g: ToolCardGroup): boolean =>
      !q || g.label.toLowerCase().includes(q) || g.members.some((m) => m.label.toLowerCase().includes(q) || m.id.includes(q))
    const visible = families.filter(familyMatches)
    // "Known" gates the inventory's Not-connected group: a tool the user has TOUCHED
    // (a CLI-owned row, a pasted client, a note, a past grant) keeps its card; the
    // never-touched catalog stays in the Library, where browsing lives.
    const knownRow = (r: ToolCardRow): boolean =>
      !!r.server || !!(r.connection && (r.connection.userClient || r.connection.accountNote || r.connection.connectedAt || r.connection.lastError))
    const known = (g: ToolCardGroup): boolean => g.members.some(knownRow)
    const groups: { label: string; test: (g: ToolCardGroup) => boolean }[] = [
      { label: 'Connected', test: (g) => ['connected', 'connecting'].includes(groupTag(g.members).kind) },
      { label: 'Needs attention', test: (g) => groupTag(g.members).kind === 'attention' },
      browse
        ? { label: 'Available', test: (g) => groupTag(g.members).kind === 'off' }
        : { label: 'Not connected', test: (g) => groupTag(g.members).kind === 'off' && known(g) }
    ]
    let any = false
    for (const g of groups) {
      const mine = visible.filter(g.test).sort((a, b) => a.label.localeCompare(b.label))
      if (!mine.length) continue
      any = true
      grid.append(el('div', { class: 'section-label conn-group-label', text: `${g.label} · ${mine.length}` }))
      const groupGrid = el('div', { class: 'conn-group-grid' })
      for (const fam of mine) {
        if (fam.members.length === 1) {
          const r = fam.members[0]
          groupGrid.append(r.connection ? card(r.connection, r) : cliCard(r))
        } else {
          groupGrid.append(familyCard(fam))
        }
      }
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
  function scopePanel(c: { id: string; label: string }): HTMLElement {
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

  // ── Key slots, in the DETAIL (phase-tools/05) ──────────────────────────────
  // Every ${VAR} this tool's CLI-owned route references, with its vault state —
  // pasted right here, vault semantics unchanged (serviceKeySet; the Service-keys
  // card below stays the audit view). The key lives with the tool that needs it.
  function keySlots(server: McpServerEntry): HTMLElement | null {
    const needed = [
      ...new Set(
        [...Object.values(server.env ?? {}), ...Object.values(server.headers ?? {})].flatMap((v) =>
          [...String(v).matchAll(/\$\{([A-Z0-9_]+)\}/g)].map((m) => m[1])
        )
      )
    ]
    if (!needed.length) return null
    const host = el('div', { class: 'conn-keyslots' })
    void (async () => {
      let saved = new Set<string>()
      try {
        saved = new Set(((await bridge.invoke(IntegrationsChannels.serviceKeyList)) as string[]) ?? [])
      } catch {
        /* vault unavailable — slots render as paste fields */
      }
      for (const name of needed) {
        if (saved.has(name)) {
          host.append(el('span', { class: 'conn-keyslot is-saved', text: `\${${name}} · saved`, title: 'Encrypted by your OS keychain; reaches agents as this env var at launch.' }))
          continue
        }
        const input = el('input', { class: 'browser-sites-input conn-key-input', placeholder: `paste the ${name} value…` }) as HTMLInputElement
        input.type = 'password'
        input.setAttribute('aria-label', `${name} key value`)
        input.addEventListener('keydown', (e) => e.stopPropagation())
        const save = el('button', { class: 'trail-btn conn-mini', type: 'button', text: 'Save to vault' }) as HTMLButtonElement
        const slotNote = el('div', { class: 'conn-summary is-error', role: 'alert', hidden: true })
        save.onclick = (): void => {
          if (!input.value) return
          void submitWithRetain({
            trigger: save,
            retainFields: [input],
            errorEl: slotNote,
            submit: () =>
              bridge.invoke(IntegrationsChannels.serviceKeySet, { name, value: input.value }) as Promise<{ ok: boolean; reason?: string }>,
            onSuccess: () => refresh()
          })
        }
        host.append(el('div', { class: 'conn-keyslot-form' }, [el('span', { class: 'conn-keyslot is-missing', text: `\${${name}}` }), input, save, slotNote]))
      }
    })()
    return host
  }

  // ── The silent reconciler (phase-tools/06): drift becomes "Needs attention → Fix"
  // The mgr engine (surgical writes, backups, marked-entries-only) is untouched
  // underneath — every verb here rides an EXISTING channel, and nothing ever writes
  // without the click. Claude Code only this phase; the sentence, the preview title
  // and the backups line are the contract's, so no surface words them twice.
  const fixOpen = new Set<string>()
  function reconcileBlock(id: string, label: string): HTMLElement {
    const host = el('div', { class: 'conn-fix' })
    void (async () => {
      let flavor: CliFixFlavor | null = null
      try {
        const statuses = (await bridge.invoke(IntegrationsChannels.mgrStatus, id)) as { cli: string; state: string }[]
        const st = statuses.find((s) => s.cli === 'claude-code')?.state
        flavor = st === 'drift-edited' ? 'edited' : st === 'drift-missing' ? 'missing' : null
      } catch {
        /* status unavailable — the tag already says Needs attention */
      }
      if (!flavor) return
      const words = FIX_SENTENCES[flavor]
      host.append(el('div', { class: 'conn-summary is-error conn-fix-sentence', text: words.sentence }))
      if (!fixOpen.has(id)) {
        const open = el('button', { class: 'trail-btn is-armed conn-fix-open', type: 'button', text: 'Fix…' }) as HTMLButtonElement
        open.onclick = (): void => {
          fixOpen.add(id)
          paint()
        }
        host.append(open)
        return
      }
      // Expanded: the diff preview keeps its trust-artifact role, plainly titled;
      // the backups line says what safety net exists; then the one primary verb.
      const preview = (await bridge.invoke(IntegrationsChannels.mgrPreview, {
        serverId: id,
        cli: 'claude-code',
        action: 'apply'
      })) as { file: string; block: string; summary: string } | null
      if (preview?.block) {
        host.append(el('div', { class: 'settings-row-caption conn-fix-preview-title', text: FIX_PREVIEW_TITLE }))
        const pre = el('pre', { class: 'mgr-panel-block conn-fix-preview' })
        pre.textContent = preview.block
        host.append(pre)
      }
      try {
        const backups = ((await bridge.invoke(IntegrationsChannels.mgrBackups, 'claude-code')) as string[]) ?? []
        if (backups.length) host.append(el('div', { class: 'settings-row-caption conn-fix-backups', text: backupsLine(backups[0]) }))
      } catch {
        /* no backups yet — the first Fix creates one */
      }
      const afterWrite = async (): Promise<void> => {
        fixOpen.delete(id)
        try {
          await bridge.invoke(IntegrationsChannels.statusRefresh)
        } catch {
          /* the next heartbeat re-reads either way */
        }
        await refresh()
      }
      const fix = el('button', { class: 'trail-btn is-armed conn-fix-now', type: 'button', text: 'Fix' }) as HTMLButtonElement
      fix.onclick = (): void => {
        void (async () => {
          fix.disabled = true
          fix.setAttribute('aria-busy', 'true')
          const r = (await bridge.invoke(IntegrationsChannels.mgrApply, { serverId: id, cli: 'claude-code' })) as { ok: boolean; reason?: string }
          if (!r.ok) showToast({ tone: 'danger', title: `${label} was not fixed`, body: r.reason ?? 'The attempt was refused.' })
          await afterWrite()
        })()
      }
      const secondary = el('button', { class: 'trail-btn conn-mini conn-fix-secondary', type: 'button', text: words.secondary }) as HTMLButtonElement
      secondary.onclick = (): void => {
        void (async () => {
          secondary.disabled = true
          await bridge.invoke(IntegrationsChannels.mgrAdopt, { serverId: id, cli: 'claude-code', forget: flavor === 'missing' })
          await afterWrite()
        })()
      }
      const close = el('button', { class: 'trail-btn conn-mini', type: 'button', text: 'Close' }) as HTMLButtonElement
      close.onclick = (): void => {
        fixOpen.delete(id)
        paint()
      }
      host.append(el('div', { class: 'conn-actions' }, [fix, secondary, close]))
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

  function card(c: Connection, cardRow?: ToolCardRow): HTMLElement {
    // The FOUR tags (ADR 0020): ✓ Connected · verified {n}m ago / Needs attention /
    // Not connected / Connecting… — worded by the contract, stamped by the status
    // engine. `is-<state>` stays for the tone CSS; `data-status` carries the kind.
    const tag = toolCardTag(cardRow ?? { id: c.id, label: c.label, connection: c })
    const chip = el('span', {
      class: `conn-chip is-${c.state} is-tag-${tag.kind}`,
      text: tag.text,
      attrs: { 'data-status': tag.kind }
    })
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
          attrs: row.kind === 'probed' && row.source === 'tool' ? { title: 'Reported by the tool itself.' } : {}
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

    // What the grant can DO — HUMANIZED (phase-tools/05): the catalog's scope titles
    // render, the raw scope string rides each span's title attribute, and a
    // granted-but-uncataloged scope falls back to its raw string, never hidden.
    // Being signed in as the right person with the wrong powers is still the wrong
    // connection, and this is the only place a user can see which.
    const grantScopes = connectionScopes(c)
    const scopeLine = grantScopes.length
      ? el('div', { class: 'conn-scopes' }, [
          el('span', { text: 'Can: ' }),
          ...humanizeScopes(providers.get(c.id), grantScopes).flatMap((h, i) => [
            ...(i ? [el('span', { text: ' · ' })] : []),
            el('span', {
              class: `conn-scope${h.fallback ? ' is-raw' : ''}`,
              text: h.title,
              attrs: { title: h.scope }
            })
          ])
        ])
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
      // THE GUIDED PANEL (ADR 0021, phase-restbridge/04): a bridge-backed row
      // turns the bare paste field into three steps — create the token at the
      // provider's PRE-FILLED page (permissions, name, expiry already selected),
      // see exactly which permissions the curated tools need (least privilege
      // as data), then paste. The over-scope line is the honest fine print: a
      // global key connects too; we just say a scoped one is safer.
      const entry = providers.get(c.id)
      const guided: HTMLElement[] = []
      if (entry?.restTools?.length) {
        if (entry.setupTokenUrl) {
          const setup = el('button', { class: 'trail-btn conn-mini conn-token-setup', type: 'button', text: 'Create your token ↗' }) as HTMLButtonElement
          setup.onclick = (): void => void bridge.invoke(BrowserChannels.openExternal, { url: entry.setupTokenUrl })
          guided.push(setup)
        }
        if (entry.requiredPermissions?.length) {
          guided.push(el('div', { class: 'settings-row-caption conn-required-perms', text: `This needs: ${entry.requiredPermissions.join(', ')} — nothing more.` }))
        }
      }
      const guidedFinePrint: HTMLElement[] = entry?.restTools?.length
        ? [
            el('div', { class: 'settings-row-caption conn-overscope-note', text: 'A broader token (a global key) connects too — a scoped one is safer.' }),
            el('div', { class: 'settings-row-caption conn-bridge-note', text: 'Runs on this machine against the provider’s own API.' })
          ]
        : []
      let urlInput: HTMLInputElement | null = null
      // Self-hosted (n8n, Make): the key means nothing without the instance URL, and
      // this field used to not exist — the submit refused with "paste your instance's
      // MCP URL first" while offering no pixel to paste it into.
      if (c.needsBaseUrl) {
        urlInput = el('input', {
          class: 'browser-sites-input conn-key-input',
          placeholder: 'https://your-instance… (the address it serves tools at)'
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
      return el('div', { class: 'conn-key-form' }, [...guided, ...(urlInput ? [urlInput] : []), input, save, close, note, ...guidedFinePrint])
    }

    // ── The client-id on-ramp (no-DCR providers). The provider will not let apps
    // register themselves, so the user creates an OAuth client ONCE in the
    // provider's own console and pastes it here; consent then runs exactly like
    // every other connection. One pasted client covers every service that signs
    // in at the same place — all of Google Workspace is one client.
    const clientForm = (): HTMLElement => {
      const draft = clientDraftFor(c.id)
      // ONE sentence, written by the contract — so the form and the backend's
      // redirect-mismatch advice can never name two different consoles. The catalog's
      // setup guide renders as a REAL door (phase-tools/05): "create your client here".
      const help = el('div', { class: 'conn-summary', text: clientFormHelp(c.authServer) })
      const setupUrl = providers.get(c.id)?.setupGuideUrl
      const setupLink = setupUrl
        ? (() => {
            const a = el('button', { class: 'trail-btn conn-mini conn-setup-link', type: 'button', text: 'Create your client here ↗' }) as HTMLButtonElement
            a.onclick = (): void => void bridge.invoke(BrowserChannels.openExternal, { url: setupUrl })
            return a
          })()
        : null
      let urlInput: HTMLInputElement | null = null
      if (c.needsBaseUrl) {
        urlInput = el('input', {
          class: 'browser-sites-input conn-key-input',
          placeholder: 'https://your-instance… (the address it serves tools at)'
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
      return el('div', { class: 'conn-key-form' }, [help, ...(setupLink ? [setupLink] : []), ...(urlInput ? [urlInput] : []), idInput, secretInput, save, close, note])
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

    // ── THE CHOOSER (ADR 0020): the catalog's methods, ranked, outcome-worded ──
    // Every row is a door the catalog declared; the custody subtitle is the fine
    // print where mechanism words are legal. Claude Code first: the advanced route
    // names only Claude Code; Codex and Gemini render greyed "coming soon" with
    // ZERO handlers — disabled by construction, not by convention.
    const chooserBlock = (conn: Connection, entry: ProviderEntry, cardRow?: ToolCardRow): HTMLElement => {
      const host = el('div', { class: 'conn-chooser' })
      for (const m of chooserMethods(entry)) {
        if (m.kind === 'cliOwned') {
          const fold = el('details', { class: 'conn-advanced' }, [
            el('summary', { class: 'conn-advanced-summary', text: m.label })
          ]) as HTMLDetailsElement
          fold.append(el('div', { class: 'conn-method-sub', text: m.subtitle }))
          const setUp = el('button', {
            class: 'trail-btn conn-mini conn-cliowned-setup',
            type: 'button',
            text: cardRow?.server ? 'Authorize in Claude Code' : 'Set up on Claude Code'
          }) as HTMLButtonElement
          setUp.onclick = (): void => {
            void (async () => {
              busy(setUp, true, 'Working…')
              const r = (await bridge.invoke(IntegrationsChannels.catConnect, { presetId: conn.id, clis: ['claude-code'] })) as { ok: boolean; reason?: string }
              if (!r.ok) showToast({ tone: 'danger', title: `${conn.label} was not set up`, body: r.reason ?? 'The attempt was refused.' })
              busy(setUp, false, cardRow?.server ? 'Authorize in Claude Code' : 'Set up on Claude Code')
              await refresh()
            })()
          }
          fold.append(setUp)
          for (const soon of ['Codex', 'Gemini']) {
            const dead = el('button', {
              class: 'conn-method is-coming-soon',
              type: 'button',
              text: `${soon} — coming soon`
            }) as HTMLButtonElement
            dead.disabled = true // zero handlers, zero interactive pixels
            fold.append(dead)
          }
          host.append(fold)
          continue
        }
        const btn = el(
          'button',
          {
            class: 'conn-method',
            type: 'button',
            attrs: { 'data-method-kind': m.kind, 'data-method-key': m.key }
          },
          [el('span', { class: 'conn-method-label', text: m.label }), el('span', { class: 'conn-method-sub', text: m.subtitle })]
        ) as HTMLButtonElement
        if (m.kind === 'apiKey') {
          btn.onclick = (): void => {
            keyFormOpen.add(conn.id)
            paint()
          }
        } else {
          // `oauth` and `none` both connect through the same engine; the handler
          // words the wait honestly for each.
          btn.onclick = (): void => beginConnect(btn)
        }
        host.append(btn)
      }
      return host
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
        // THE CHOOSER (ADR 0020, phase-tools/05): a not-yet-connected tool with a
        // catalog row offers its connect METHODS, ranked, in outcome wording — each
        // with its one-line custody subtitle in fine print. Repair states keep their
        // repair verbs below: a chooser is for choosing, not for fixing.
        const entry = providers.get(c.id)
        if (c.state === 'disconnected' && entry) {
          body.append(chooserBlock(c, entry, cardRow))
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

    // The OTHER route's fact, on the SAME card (one tool = one card): when Claude
    // Code also carries this tool itself, say so — and offer its ${VAR} slots here.
    const routeLine =
      cardRow?.server != null
        ? el('div', {
            class: 'conn-summary conn-route-cli',
            text:
              cardRow?.cliState === 'connected'
                ? 'Claude Code also signs in itself for this tool — its own check says it works.'
                : cardRow?.cliState === 'needs-auth'
                  ? 'Claude Code also carries this tool itself, and needs to finish signing in there.'
                  : 'Claude Code also carries this tool itself (it holds its own credential on that route).'
          })
        : null
    const slots = cardRow?.server ? keySlots(cardRow.server) : null
    const fixBlock = cardRow?.cliState === 'drift' ? reconcileBlock(c.id, c.label) : null

    return el('div', { class: `conn-card is-${c.state}`, dataset: { connection: c.id } }, [
      head,
      ...(identity ? [identity] : []),
      ...(summary ? [summary] : []),
      ...(scopeLine ? [scopeLine] : []),
      ...(routeLine ? [routeLine] : []),
      ...(fixBlock ? [fixBlock] : []),
      ...(slots ? [slots] : []),
      ...(toolsBlock ? [toolsBlock] : []),
      body,
      ...(actions.childNodes.length ? [actions] : [])
    ])
  }

  // ── The FAMILY card: one product, its capabilities in the fold ──────────────
  // Cloudflare is one tool with thirteen capabilities, not thirteen tools. The
  // header carries the family's one aggregate tag (worst wins) and the capability
  // count; expanding renders each member's FULL card — chooser, identity, Fix,
  // scoping, notes — so nothing a capability could do is lost to the fold. Sign-in
  // stays per capability underneath (each grant is its own resource), but the
  // client registration is issuer-shared, so the first consent covers the family.
  const familyOpen = new Set<string>()
  /** The FAMILY key method (ADR 0021): rendered ONCE at family level when the
   *  key-ready members (restTools + an apiKey method) all share one restAuth —
   *  one paste lights the whole family. Same repaint-survival rules as every
   *  secret form; the wording is the chooser's, verbatim (ADR 0020). */
  const familyKeyOpen = new Set<string>()
  const familyKeyDrafts = new Map<string, string>()
  function familyKeyReady(fam: ToolCardGroup): { entries: ProviderEntry[]; pending: number } | null {
    const entries = fam.members
      .map((m) => providers.get(m.id))
      .filter((e): e is ProviderEntry => !!e?.restTools?.length && !!e.methods.some((x) => x.kind === 'apiKey'))
    if (entries.length < 2) return null
    const auth = JSON.stringify(entries[0].restAuth ?? null)
    if (!entries.every((e) => JSON.stringify(e.restAuth ?? null) === auth)) return null
    const ids = new Set(entries.map((e) => e.id))
    const pending = fam.members.filter((m) => ids.has(m.id) && toolCardTag(m).kind !== 'connected').length
    return { entries, pending }
  }
  function familyKeyPanel(fam: ToolCardGroup, entries: ProviderEntry[]): HTMLElement {
    const first = entries[0]
    const parts: HTMLElement[] = []
    if (first.setupTokenUrl) {
      const setup = el('button', { class: 'trail-btn conn-mini conn-token-setup', type: 'button', text: 'Create your token ↗' }) as HTMLButtonElement
      setup.onclick = (): void => void bridge.invoke(BrowserChannels.openExternal, { url: first.setupTokenUrl })
      parts.push(setup)
    }
    const perms = [...new Set(entries.flatMap((e) => e.requiredPermissions ?? []))]
    if (perms.length) parts.push(el('div', { class: 'settings-row-caption conn-required-perms', text: `This needs: ${perms.join(', ')} — nothing more.` }))
    const input = el('input', { class: 'browser-sites-input conn-key-input conn-family-key-input', placeholder: 'paste your API key…' }) as HTMLInputElement
    input.type = 'password'
    input.value = familyKeyDrafts.get(fam.key) ?? ''
    input.setAttribute('aria-label', `${fam.label} API key`)
    input.addEventListener('keydown', (e) => e.stopPropagation())
    input.addEventListener('input', () => familyKeyDrafts.set(fam.key, input.value))
    const save = el('button', { class: 'trail-btn is-armed', type: 'button', text: 'Connect' }) as HTMLButtonElement
    const close = el('button', { class: 'trail-btn conn-mini', type: 'button', text: 'Close' }) as HTMLButtonElement
    close.onclick = (): void => {
      familyKeyDrafts.delete(fam.key)
      familyKeyOpen.delete(fam.key)
      paint()
    }
    const note = el('div', { class: 'conn-summary is-error', hidden: true, role: 'alert' })
    save.onclick = (): void => {
      if (!input.value.trim()) return
      void submitWithRetain({
        trigger: save,
        retainFields: [input],
        errorEl: note,
        submit: () =>
          bridge.invoke(ConnectionsChannels.submitFamilyKey, { group: fam.key, value: input.value }) as Promise<{ ok: boolean; reason?: string }>,
        onSuccess: () => {
          familyKeyDrafts.delete(fam.key) // verified and vaulted — the plaintext leaves the DOM and the draft
          familyKeyOpen.delete(fam.key)
          showToast({ tone: 'success', title: `${fam.label} connected`, body: 'One key, every capability — encrypted by your OS keychain.' })
        }
      })
    }
    return el('div', { class: 'conn-key-form conn-family-key-form' }, [
      ...parts,
      input,
      save,
      close,
      note,
      el('div', { class: 'settings-row-caption conn-overscope-note', text: 'A broader token (a global key) connects too — a scoped one is safer.' }),
      el('div', { class: 'settings-row-caption conn-bridge-note', text: 'Runs on this machine against the provider’s own API.' })
    ])
  }
  function familyCard(fam: ToolCardGroup): HTMLElement {
    const tag = groupTag(fam.members)
    const chip = el('span', { class: `conn-chip is-family is-tag-${tag.kind}`, text: tag.text, attrs: { 'data-status': tag.kind } })
    const connectedN = fam.members.filter((m) => toolCardTag(m).kind === 'connected').length
    const open = familyOpen.has(fam.key)
    const toggle = el('button', {
      class: 'conn-tools-toggle conn-family-toggle',
      type: 'button',
      text: `${open ? '▾' : '▸'} ${connectedN ? `${connectedN} of ${fam.members.length}` : `${fam.members.length}`} capabilities`,
      attrs: { 'aria-expanded': String(open) }
    }) as HTMLButtonElement
    toggle.onclick = (): void => {
      if (familyOpen.has(fam.key)) familyOpen.delete(fam.key)
      else familyOpen.add(fam.key)
      paint()
    }
    const head = el('div', { class: 'conn-card-head' }, [
      providerLogo(fam.members[0].id, 16),
      el('span', { class: 'conn-label', text: fam.label }),
      chip
    ])
    const host = el('div', { class: 'conn-card conn-family-card', dataset: { group: fam.key } }, [head, toggle])
    // The family key method: one door, chooser-worded, only while a key-ready
    // member is still unconnected (a fully-lit family needs no paste button).
    const ready = familyKeyReady(fam)
    if (ready && ready.pending > 0) {
      if (familyKeyOpen.has(fam.key)) {
        host.append(familyKeyPanel(fam, ready.entries))
      } else {
        const method = el(
          'button',
          { class: 'conn-method conn-family-key-method', type: 'button', attrs: { 'data-method-kind': 'apiKey' } },
          [el('span', { class: 'conn-method-label', text: CHOOSER_LABELS.apiKey }), el('span', { class: 'conn-method-sub', text: CUSTODY_SUBTITLES.apiKey })]
        ) as HTMLButtonElement
        method.onclick = (): void => {
          familyKeyOpen.add(fam.key)
          paint()
        }
        host.append(method)
      }
    }
    if (open) {
      const list = el('div', { class: 'conn-family-members' })
      for (const m of fam.members.sort((a, b) => a.label.localeCompare(b.label))) {
        list.append(m.connection ? card(m.connection, m) : cliCard(m))
      }
      host.append(list)
    }
    return host
  }

  // ── The CLI-owned-only card: a tool with no app-held connection at all ──────
  // Same grid, same merge key, same four tags — the detail carries the route line,
  // the ${VAR} slots, workspace scoping, and the chooser's advanced fold.
  function cliCard(r: ToolCardRow): HTMLElement {
    const tag = toolCardTag(r)
    const chip = el('span', { class: `conn-chip is-cli is-tag-${tag.kind}`, text: tag.text, attrs: { 'data-status': tag.kind } })
    const head = el('div', { class: 'conn-card-head' }, [providerLogo(r.id, 16), el('span', { class: 'conn-label', text: r.label }), chip])
    const route = el('div', {
      class: 'conn-summary conn-route-cli',
      text:
        r.cliState === 'connected'
          ? 'Claude Code signs in itself for this tool — its own check says it works.'
          : r.cliState === 'needs-auth'
            ? 'Claude Code needs to finish signing in for this tool.'
            : 'Claude Code carries this tool itself — it holds its own credential; the app brokers nothing on this route.'
    })
    const slots = r.server ? keySlots(r.server) : null
    const fixBlock = r.cliState === 'drift' ? reconcileBlock(r.id, r.label) : null
    const body = el('div', { class: 'conn-card-body' })
    if (opts.workspaceScoping) {
      const open = scopeOpen.has(r.id)
      const scope = el('button', {
        class: 'trail-btn conn-mini conn-scope-toggle',
        type: 'button',
        text: open ? 'Hide workspaces' : 'Use in workspaces…',
        attrs: { 'aria-expanded': String(open) }
      }) as HTMLButtonElement
      scope.onclick = (): void => {
        if (scopeOpen.has(r.id)) scopeOpen.delete(r.id)
        else scopeOpen.add(r.id)
        paint()
      }
      body.append(scope)
      if (open) body.append(scopePanel({ id: r.id, label: r.label }))
    }
    return el('div', { class: 'conn-card is-cli-route', dataset: { connection: r.id } }, [
      head,
      route,
      ...(fixBlock ? [fixBlock] : []),
      ...(slots ? [slots] : []),
      body
    ])
  }

  const block = el('div', { class: 'trail-block conn-block' }, [
    el('div', {
      class: 'settings-row-caption',
      text: browse
        ? 'Connect a tool to MoggingLabs Workspace once, and every agent you launch can use it — no CLI to configure, no key to copy around. Sign-in runs entirely on this machine: the browser consent, the local hand-back, the keychain ciphertext — no vendor cloud of ours ever sees a token. The credential is encrypted by your OS keychain and stays in this app; your CLIs reach the tool through us, so no token is ever written into a CLI’s config file.'
        : 'Your tools — who you are on each, what each one actually offers your agents, and which workspaces carry it. Sign-in runs entirely on this machine; no vendor cloud of ours ever sees a token. Each credential is encrypted by your OS keychain; Disconnect deletes it from this machine. To connect more, browse the Library.'
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
  // The CLI route's facts ride the status snapshot (phase-tools/06): a card whose
  // Claude Code config needs fixing must say so the moment the push lands — repaint
  // only, never another poll (the request→push→request loop lesson).
  bridge.on(IntegrationsChannels.statusChanged, (payload) => {
    snapshot = (payload as McpStatusSnapshot | null) ?? snapshot
    paint()
  })

  const sync = (): void => void refresh()
  setTimeout(sync, 0)
  return { block, sync }
}

/** The overview band's one-glance number. */
export const connectedCount = (cs: Connection[]): number => cs.filter((c) => c.state === 'connected').length
