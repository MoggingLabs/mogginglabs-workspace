import {
  AgentChannels,
  IntegrationsChannels,
  type HostedCliId,
  type McpAuthKind,
  type McpPreset,
  type McpServerEntry
} from '@contracts'
import { createAsyncGuard } from '../../core/async/async-state'
import { getBridge } from '../../core/ipc/bridge'
import { Button, IconButton, clear, createCollapsibleCard, createModal, el, loadingRow, openContextMenu, providerLogo, showToast, type ModalHandle } from '../../components'
import { integrationAuthState, onIntegrationAuthState, runIntegrationAuthorization } from './auth-runner'
import { createConnectionsBlock } from './connections'
import { CLI_LABEL, CLI_PROVIDER, HOSTED } from './cli-meta'

/**
 * The Library — the ONE browse surface for everything an agent can use.
 *
 * The store/inventory split (2026-07-18): Settings § Integrations is what you HAVE
 * (connected accounts, servers on your CLIs, workspace scoping); the Library is what
 * you can GET. It merges what used to be three sibling folds on the settings page —
 * the account-connection grid's "Available" group, the per-CLI preset catalog, and
 * the registry search / preset import — into one page-scale overlay, reachable from
 * the places a user actually discovers the need: the wizard's Agent-tools step, the
 * settings overview band, the servers empty state, and the palette.
 *
 * An OVERLAY, deliberately not an AppView: the wizard must be able to open it
 * mid-configuration without losing a half-built workspace, and a modal returns you
 * to exactly where you were. Connecting from here uses the same two routes as ever
 * (ADR 0014 Route A account connections; the per-CLI Route B under the advanced
 * fold) — the Library adds no write paths, it re-homes the existing ones.
 */

interface SyncedBlock {
  block: HTMLElement
  sync: () => void
}

// ── The per-CLI preset catalog (8/07) — moved here from integrations.ts ──────
// Route B's browse surface: adding a preset writes the server into each selected
// CLI's own config, and that CLI holds its own auth. The DOM contract (`.cat-*`
// classes, the connect/preview panel, the registry strip) is unchanged — the
// smokes that drive it now open the Library first.
export function createCatalogBlock(): SyncedBlock {
  const bridge = getBridge()
  type Capability = { cli: HostedCliId; remoteHttp: boolean; oauth: boolean; floor: string; authorizeCommand: string | null }
  const grid = el('div', { class: 'cat-grid' })
  const panel = el('div', { class: 'mgr-panel cat-panel', hidden: true })

  let caps: Capability[] = []
  let installed = new Set<string>()

  function authTradeCopy(kind: McpAuthKind): string {
    return kind === 'oauth'
      ? 'OAuth per CLI — vendor-preferred; each CLI holds its own token, revoke per CLI'
      : 'One token, all agents — an env/vault reference; one paste, shared blast radius'
  }

  async function openConnect(preset: McpPreset, groupRows: McpPreset[]): Promise<void> {
    panel.hidden = false
    clear(panel)
    panel.append(
      el('div', { class: 'mgr-panel-summary' }, [providerLogo(preset.id, 18), el('span', { text: `Connect ${preset.label}` })])
    )
    // The panel lives AFTER the card grid, so opening it from a card near the top
    // rendered it far below the fold with nothing scrolling — the click "did
    // absolutely nothing". Un-hiding a control the user cannot see is not showing
    // it to them.
    setTimeout(() => panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 0)
    panel.append(el('div', { class: 'settings-row-caption', text: preset.grantCopy }))
    // CLI checkboxes, capability/installed dimming.
    const checks = new Map<HostedCliId, HTMLInputElement>()
    const cliRow = el('div', { class: 'trail-controls' })
    for (const cli of HOSTED) {
      const cap = caps.find((c) => c.cli === cli)
      const blocked = !cap?.remoteHttp && preset.transport === 'http' ? `no remote HTTP (floor ${cap?.floor})` : ''
      const isInstalled = installed.has(CLI_PROVIDER[cli])
      const box = el('input', { class: 'cat-cli-check' }) as HTMLInputElement
      box.type = 'checkbox'
      box.checked = isInstalled && !blocked
      box.disabled = !!blocked
      checks.set(cli, box)
      const lab = el('label', { class: `cat-cli-label${!isInstalled || blocked ? ' is-dim' : ''}` }, [
        box,
        el('span', { text: `${CLI_LABEL[cli]}${blocked ? ` · ${blocked}` : isInstalled ? '' : ' · not installed'}` })
      ])
      cliRow.append(lab)
    }
    panel.append(cliRow)
    // Base-URL override (self-hosted).
    let baseInput: HTMLInputElement | null = null
    if (groupRows.some((r) => r.baseUrlOverride)) {
      baseInput = el('input', { class: 'browser-sites-input mgr-input' }) as HTMLInputElement
      baseInput.placeholder = preset.urlOrCommand.includes('YOUR-') ? preset.urlOrCommand : 'https://your-instance… (optional override)'
      baseInput.setAttribute('aria-label', 'Base URL override')
      baseInput.spellcheck = false
      baseInput.addEventListener('keydown', (e) => e.stopPropagation())
      panel.append(el('div', { class: 'settings-row-caption', text: 'Self-hosted? Paste your instance’s MCP URL:' }), baseInput)
    }
    // Auth-kind choice (dual-auth vendors state the trade).
    let authPick: McpAuthKind = preset.authKinds[0] ?? 'none'
    if (preset.authKinds.length > 1) {
      const authRow = el('div', { class: 'mgr-grant-body' })
      for (const kind of preset.authKinds) {
        const radio = el('input', { class: 'cat-auth-radio' }) as HTMLInputElement
        radio.type = 'radio'
        radio.name = `auth-${preset.id}`
        radio.checked = kind === authPick
        radio.onchange = (): void => {
          if (radio.checked) authPick = kind
        }
        authRow.append(el('label', { class: 'cat-cli-label' }, [radio, el('span', { text: authTradeCopy(kind) })]))
      }
      panel.append(authRow)
    }
    if (preset.envRefSlots.length) {
      panel.append(
        el('div', {
          class: 'settings-row-caption',
          text: `Key slots (env references, never literals): ${preset.envRefSlots.map((s) => `\${${s}}`).join(', ')} — set the variable yourself, or save it under Settings › Integrations › Service keys.`
        })
      )
    }
    panel.append(
      el('div', {
        class: 'settings-row-caption',
        text: 'Scope stays per workspace: adding here makes the server available to a CLI; which WORKSPACES see it is decided under Settings › Integrations › Workspace tools. (Browser act-origins live under Trust › Browser.)'
      })
    )
    const previewPre = el('pre', { class: 'mgr-panel-block cat-preview-out', hidden: true })
    const note = el('div', { class: 'menu-note trail-empty cat-note', hidden: true })

    // Finding 39 (upheld here): both buttons re-enable inside the guard's onSettle —
    // a rejected prepare/connect must never strand the button disabled, because the
    // re-enabled button IS the retry. catConnect is idempotent (save + apply by
    // server id), so retrying after a timeout cannot double-write.
    type PrepareResult = { ok: boolean; entries?: McpServerEntry[]; reason?: string }
    type ConnectResult = { ok: boolean; reason?: string; results?: { cli: HostedCliId; ok: boolean; reason?: string }[] }
    const previewGuard = createAsyncGuard<PrepareResult>()
    const connectGuard = createAsyncGuard<ConnectResult>()

    const previewBtn = el('button', { class: 'trail-btn cat-preview', type: 'button', text: 'Preview' }) as HTMLButtonElement
    previewBtn.onclick = (): void => {
      void previewGuard.run(
        () =>
          bridge.invoke(IntegrationsChannels.catPrepare, {
            presetId: preset.id,
            baseUrl: baseInput?.value.trim() || undefined,
            authKind: authPick
          }) as Promise<PrepareResult>,
        {
          action: 'preview this server’s config',
          onLoading: () => {
            previewBtn.disabled = true
          },
          onSuccess: (prep) => {
            previewPre.hidden = false
            previewPre.textContent = prep.ok
              ? prep.entries!.map((en) => JSON.stringify(en, null, 2)).join('\n')
              : `refused: ${prep.reason}`
          },
          // Inline, in the block the preview would have filled: this is not news arriving from
          // elsewhere, it is the answer to the click the user is still looking at.
          onError: (message) => {
            previewPre.hidden = false
            previewPre.textContent = message
          },
          onSettle: () => {
            if (previewBtn.isConnected) previewBtn.disabled = false
          },
          timeoutMs: 15_000
        }
      )
    }
    const connectBtn = el('button', { class: 'trail-btn cat-connect', type: 'button', text: 'Connect' }) as HTMLButtonElement
    connectBtn.onclick = (): void => {
      const clis = HOSTED.filter((c) => checks.get(c)?.checked)
      const selectedAuth = authPick
      void connectGuard.run(
        () =>
          bridge.invoke(IntegrationsChannels.catConnect, {
            presetId: preset.id,
            clis,
            baseUrl: baseInput?.value.trim() || undefined,
            authKind: selectedAuth
          }) as Promise<ConnectResult>,
        {
          action: 'connect this server to your CLIs',
          onLoading: () => {
            connectBtn.disabled = true
            note.hidden = false
            note.textContent = ''
            note.append(loadingRow('Connecting…'))
          },
          onSuccess: (r) => {
            note.textContent = r.ok
              ? `Connected: ${r.results?.map((x) => `${CLI_LABEL[x.cli]} ${x.ok ? '✓' : `✗ (${x.reason})`}`).join(' · ')}`
              : `refused: ${r.reason}`
            if (r.ok) renderAuthorizeRow(preset, clis, selectedAuth)
          },
          // The note is where "Connecting…" was standing: the failure replaces the promise it
          // broke, in place. No authorize row — nothing was written to authorize against.
          onError: (message) => {
            note.hidden = false
            note.textContent = message
          },
          onSettle: () => {
            if (connectBtn.isConnected) connectBtn.disabled = false
          },
          timeoutMs: 15_000
        }
      )
    }
    panel.append(el('div', { class: 'trail-controls' }, [previewBtn, connectBtn]), previewPre, note)

    function renderAuthorizeRow(p: McpPreset, clis: HostedCliId[], authKind: McpAuthKind): void {
      const row = el('div', { class: 'trail-controls' })
      if (authKind === 'token') {
        row.append(
          el('span', {
            class: 'menu-note',
            text: 'Token auth selected: save the named env value under Settings › Integrations › Service keys, or provide it in your own shell. No OAuth command will run.'
          })
        )
      }
      for (const cli of clis) {
        const cap = caps.find((c) => c.cli === cli)
        const authorizeCommand = cap?.authorizeCommand
        if (authKind === 'oauth' && authorizeCommand) {
          const prior = integrationAuthState(cli, p.id)
          const btn = el('button', {
            class: 'trail-btn',
            type: 'button',
            text:
              prior?.phase === 'running'
                ? `Authorizing in ${CLI_LABEL[cli]}…`
                : prior?.phase === 'succeeded'
                  ? `Authorized in ${CLI_LABEL[cli]}`
                  : prior?.phase === 'failed'
                    ? `Retry authorization in ${CLI_LABEL[cli]}`
                    : `Authorize in ${CLI_LABEL[cli]}`
          }) as HTMLButtonElement
          btn.disabled = prior?.phase === 'running'
          if (prior?.phase === 'running') btn.setAttribute('aria-busy', 'true')
          btn.onclick = async (): Promise<void> => {
            btn.disabled = true
            btn.setAttribute('aria-busy', 'true')
            btn.textContent = `Starting ${CLI_LABEL[cli]}…`
            const stateKey = `${cli}:${p.id}`
            const off = onIntegrationAuthState((changedKey, state) => {
              if (changedKey !== stateKey) return
              btn.disabled = state.phase === 'running'
              if (state.phase === 'running') {
                btn.setAttribute('aria-busy', 'true')
                btn.textContent = `Authorizing in ${CLI_LABEL[cli]}…`
                return
              }
              btn.removeAttribute('aria-busy')
              btn.textContent = state.phase === 'succeeded'
                ? `Authorized in ${CLI_LABEL[cli]}`
                : `Retry authorization in ${CLI_LABEL[cli]}`
              btn.title = state.message
              off()
            })
            const started = await runIntegrationAuthorization({
              cli,
              cliLabel: CLI_LABEL[cli],
              serverId: p.id,
              serverLabel: p.label,
              command: authorizeCommand
            })
            if (!started.ok) {
              off()
              btn.disabled = false
              btn.removeAttribute('aria-busy')
              btn.textContent = `Authorize in ${CLI_LABEL[cli]}`
              showToast({ tone: 'danger', title: 'Authorization did not start', body: started.reason })
            }
          }
          row.append(btn)
        }
        const statusBtn = el('button', { class: 'trail-btn', type: 'button', text: `Status (${CLI_LABEL[cli]})` }) as HTMLButtonElement
        statusBtn.onclick = async (): Promise<void> => {
          statusBtn.textContent = `Status (${CLI_LABEL[cli]}): …`
          const s = (await bridge.invoke(IntegrationsChannels.catAuthStatus, { serverId: p.id, cli })) as string
          statusBtn.textContent = `Status (${CLI_LABEL[cli]}): ${s}`
        }
        row.append(statusBtn)
      }
      panel.append(row)
    }
  }

  async function refresh(): Promise<void> {
    const { presets, custom } = (await bridge.invoke(IntegrationsChannels.catList, undefined)) as {
      presets: McpPreset[]
      custom: McpPreset[]
    }
    caps = (await bridge.invoke(IntegrationsChannels.catCapabilities, undefined)) as Capability[]
    // Coverage for the "in N of M workspaces" badge (8/09 step 4).
    const coverage = ((await bridge.invoke(IntegrationsChannels.planCoverage)) as { counts: Record<string, number>; total: number }) ?? { counts: {}, total: 0 }
    try {
      const agents = (await bridge.invoke(AgentChannels.detect, undefined)) as { id: string; installed: boolean }[]
      installed = new Set(agents.filter((a) => a.installed).map((a) => a.id))
    } catch {
      installed = new Set()
    }
    clear(grid)
    const seenGroups = new Set<string>()
    for (const preset of [...presets, ...custom]) {
      if (preset.group) {
        if (seenGroups.has(preset.group)) continue
        seenGroups.add(preset.group)
      }
      const rows = preset.group ? presets.filter((p) => p.group === preset.group) : [preset]
      const label = preset.group ? 'Google Workspace' : preset.label
      const badge = preset.verifiedAt
        ? el('span', { class: 'cat-badge is-verified', text: `verified ${preset.verifiedAt}` })
        : el('span', { class: 'cat-badge is-draft', text: 'community — not house-vetted' })
      // "in N of M workspaces" — how many scoped workspaces plan this server.
      const planned = rows.reduce((n, r) => n + (coverage.counts[r.id] ?? 0), 0)
      const coverageBadge =
        planned > 0 && coverage.total > 0
          ? el('span', { class: 'cat-badge is-planned', text: `in ${planned} of ${coverage.total} workspace${coverage.total === 1 ? '' : 's'}` })
          : null
      // F-22: 'Connect' is reserved for ACCOUNT connections — this route writes a
      // server into a CLI's config, so its verb says that. Check feed / Export are
      // maintainer verbs: they stay behind a ⋯ menu instead of sharing the primary row.
      const connect = el('button', { class: 'trail-btn', type: 'button', text: 'Add to CLI…' }) as HTMLButtonElement
      connect.onclick = (): void => void openConnect(preset, rows)
      const feedNote = el('div', { class: 'menu-note trail-empty', hidden: true })
      const checkFeed = async (): Promise<void> => {
        const r = (await bridge.invoke(IntegrationsChannels.catRefresh, preset.id)) as { ok: boolean; diff?: string; reason?: string }
        feedNote.hidden = false
        feedNote.textContent = r.ok ? r.diff ?? '' : r.reason ?? 'registry unavailable'
      }
      const more = IconButton({
        icon: 'more',
        label: `More actions for ${label}`,
        class: 'cat-more',
        onClick: (e) => {
          const at = (e.currentTarget as HTMLElement).getBoundingClientRect()
          openContextMenu({
            items: [
              { label: 'Check feed', icon: 'rotate-cw', onSelect: () => void checkFeed() },
              { label: 'Export preset', icon: 'copy', onSelect: () => void bridge.invoke(IntegrationsChannels.catExport, preset.id) }
            ],
            x: at.right,
            y: at.bottom + 4,
            returnFocus: e.currentTarget as HTMLElement,
            ariaLabel: `${label} actions`
          })
        }
      })
      const card = el('div', { class: 'cat-card' }, [
        el('div', { class: 'cat-card-head' }, [
          providerLogo(preset.group ? 'google' : preset.id, 16),
          el('span', { class: 'mgr-label', text: label }),
          badge,
          coverageBadge
        ]),
        el('div', { class: 'cat-card-copy', text: preset.group ? `${rows.map((r) => r.label).join(' · ')} — one card, ${rows.length} endpoints.` : preset.grantCopy }),
        el('div', { class: 'trail-controls' }, [connect, more]),
        feedNote
      ])
      grid.append(card)
    }
  }

  // The open end: registry search + preset import — the SAME pipeline.
  const searchInput = el('input', { class: 'browser-sites-input mgr-input' }) as HTMLInputElement
  searchInput.placeholder = 'Search the official MCP registry…'
  searchInput.setAttribute('aria-label', 'Registry search')
  searchInput.spellcheck = false
  searchInput.addEventListener('keydown', (e) => e.stopPropagation())
  const searchBtn = el('button', { class: 'trail-btn', type: 'button', text: 'Search registry' }) as HTMLButtonElement
  const searchResults = el('div', { class: 'mgr-list' })
  searchBtn.onclick = async (): Promise<void> => {
    clear(searchResults)
    searchResults.append(loadingRow('Searching the registry…'))
    const r = (await bridge.invoke(IntegrationsChannels.catRegistry, searchInput.value.trim())) as {
      ok: boolean
      drafts?: { name: string; description: string; entry: McpServerEntry }[]
      reason?: string
    }
    clear(searchResults)
    if (!r.ok) {
      searchResults.append(el('div', { class: 'menu-note', text: r.reason ?? 'registry unavailable' }))
      return
    }
    for (const d of r.drafts ?? []) {
      const save = el('button', { class: 'trail-btn cat-mini', type: 'button', text: 'Save as server' }) as HTMLButtonElement
      save.onclick = async (): Promise<void> => {
        const res = (await bridge.invoke(IntegrationsChannels.serversSave, d.entry)) as { ok: boolean; reason?: string }
        save.textContent = res.ok ? 'Saved — set it up under Settings › Integrations' : `refused: ${res.reason}`
      }
      searchResults.append(
        el('div', { class: 'mgr-row' }, [
          el('span', { class: 'mgr-label', text: d.name }),
          el('span', { class: 'cat-badge is-draft', text: 'community — not house-vetted' }),
          el('span', { class: 'mgr-id cat-desc', text: d.description }),
          save
        ])
      )
    }
    if (!r.drafts?.length) searchResults.append(el('div', { class: 'menu-note', text: 'No matches.' }))
  }
  const importInput = el('input', { class: 'browser-sites-input mgr-input' }) as HTMLInputElement
  importInput.placeholder = 'Paste a preset JSON to import…'
  importInput.setAttribute('aria-label', 'Import preset JSON')
  importInput.spellcheck = false
  importInput.addEventListener('keydown', (e) => e.stopPropagation())
  const importBtn = el('button', { class: 'trail-btn', type: 'button', text: 'Import' }) as HTMLButtonElement
  const importNote = el('div', { class: 'menu-note trail-empty', hidden: true })
  importBtn.onclick = async (): Promise<void> => {
    const r = (await bridge.invoke(IntegrationsChannels.catImport, importInput.value)) as { ok: boolean; reason?: string }
    importNote.hidden = false
    importNote.textContent = r.ok ? 'Imported as a community preset.' : `refused: ${r.reason}`
    if (r.ok) void refresh()
  }

  const block = el('div', { class: 'trail-block cat-block' }, [
    el('div', {
      class: 'settings-row-caption',
      text:
        'The per-CLI route: adding here writes the server into each CLI’s own config, and THAT CLI holds its own auth — the app brokers nothing on this path, and keys stay ${VAR} references. Use it when you want a CLI to own its credential, or for a server that must run on your machine. For an account this app holds for every agent at once, connect it from the services grid above.'
    }),
    grid,
    panel,
    // F-26: the registry search and the JSON import used to float after the grid as
    // two unlabeled strips — one clear expert corner now, labeled for what it is.
    el('div', { class: 'cat-registry' }, [
      el('div', { class: 'section-label', text: 'Registry & custom' }),
      el('div', { class: 'settings-row-caption', text: 'Search the official MCP registry, or import a preset JSON — either lands in this catalog as a community preset.' }),
      el('div', { class: 'trail-controls' }, [searchInput, searchBtn]),
      searchResults,
      el('div', { class: 'trail-controls' }, [importInput, importBtn]),
      importNote
    ])
  ])
  const sync = (): void => void refresh()
  setTimeout(sync, 0)
  return { block, sync }
}

// ── The Library overlay ───────────────────────────────────────────────────────
// Built ONCE and reopened (the shortcuts-sheet pattern): the connections block
// subscribes to pushed state, and rebuilding per open would stack listeners onto
// detached DOM. Syncs re-run on every open, so nothing goes stale.
let modal: ModalHandle | null = null
let syncs: Array<() => void> = []
let onCloseOnce: (() => void) | null = null

function buildLibrary(): ModalHandle {
  const m = createModal({
    title: 'Library',
    subtitle: 'Everything your agents can use — connect once, then scope it per workspace.',
    variant: 'wizard',
    width: 960,
    onClose: () => {
      const cb = onCloseOnce
      onCloseOnce = null
      cb?.()
    }
  })
  m.el.classList.add('library-modal')

  // Section 1 — the services grid (Route A, ADR 0014): every connectable service,
  // in browse mode. Connecting here holds ONE grant in the app and hands every
  // agent the service through the bridge command.
  const services = createConnectionsBlock({ browse: true, workspaceScoping: true })

  // Section 2 — the per-CLI route (Route B), folded: presets, registry, import.
  const catalog = createCatalogBlock()
  const cliOwned = createCollapsibleCard(
    {
      id: 'cli-owned',
      storagePrefix: 'library',
      title: 'Give a CLI its own copy (advanced)',
      caption: 'Write a server into a CLI’s own config — that CLI holds its own auth. Registry search and preset import live here too.',
      defaultOpen: false
    },
    [catalog.block]
  )

  // No intro paragraph of its own: the modal subtitle carries the promise and
  // the services block opens with the full custody story — a second paragraph
  // saying the same thing was the first thing the evidence shots flagged.
  const body = el('div', { class: 'library-body' }, [services.block, cliOwned.el])
  m.setBody(body)
  m.setFooter(
    el('div', { class: 'confirm-actions' }, [
      Button({
        label: 'Set up my stack…',
        icon: 'sparkles',
        variant: 'ghost',
        onClick: () => {
          // The guided flow is its own modal — close the Library first so the flow
          // is not stacked on (and trapped under) this overlay.
          m.close()
          void import('./integrations').then(({ openGuidedFlow }) => openGuidedFlow())
        }
      }),
      Button({ label: 'Done', variant: 'primary', onClick: () => m.close() })
    ])
  )
  syncs = [services.sync, catalog.sync]
  return m
}

/** Open the Library overlay from anywhere (settings, wizard, palette, empty states). */
export function openLibrary(opts?: { onClose?: () => void }): void {
  modal ??= buildLibrary()
  onCloseOnce = opts?.onClose ?? null
  for (const sync of syncs) sync()
  modal.open()
}
