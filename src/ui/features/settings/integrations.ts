import {
  AgentChannels,
  IntegrationsChannels,
  planHasServerForCli,
  planSignature,
  toolCellState,
  type McpStatusSnapshot,
  type WorkspaceToolPlan,
  type McpAuthKind,
  type HostedCliId,
  type McpCliStatus,
  type McpPreset,
  type McpServerEntry,
  type WorkspaceIntegrationsGrant
} from '@contracts'
import { getBridge } from '../../core/ipc/bridge'
import { Button, EmptyState, createCollapsibleCard, createModal, el, icon, loadingRow, providerLogo, showToast } from '../../components'
import type { CollapsibleCardHandle } from '../../components'
import { getWorkspaces } from '../../core/workspace/workspace-info-port'
import { onToolPlanPanesChange, restartNeededPaneIds } from '../../core/agents/toolplan-panes'
import { openWorkspaceFromTemplate } from '../../core/workspace/open-service'
import { onViewChange } from '../../core/shell/view-port'
import { requestIntegrationsFocus, takeIntegrationsFocus, type IntegrationsFocus } from '../../core/shell/integrations-focus-port'

// ── Attention, reported upward (8.5/05) ──────────────────────────────────────
// Five folded Cards (webhooks and the trail earned their own tabs), and NOT ONE
// of this file's attention states is knowable at build time — every one arrives
// from an async refresh or a pushed channel. So a section that discovers it needs
// you says so, and the shell puts that on the fold's header, where a collapse
// cannot bury it.
type SectionId = 'catalog' | 'servers' | 'keys' | 'matrix' | 'grants'
interface SectionSignal {
  /** Rendered in the collapsed header. Null clears. */
  chip: Node | null
  /** One-glance number for the overview band. */
  stat: string | null
}
type SignalListener = (id: SectionId, sig: SectionSignal) => void
const signalListeners = new Set<SignalListener>()
const lastSignal = new Map<SectionId, SectionSignal>()

function signal(id: SectionId, sig: SectionSignal): void {
  lastSignal.set(id, sig)
  for (const fn of signalListeners) fn(id, sig)
}
function onSignal(fn: SignalListener): void {
  signalListeners.add(fn)
  for (const [id, sig] of lastSignal) fn(id, sig) // replay: blocks hydrate before the shell subscribes
}
/** `state` doubles as the tone class, so the chip reads like the row it stands for. */
const attnChip = (state: string, text: string): HTMLElement => el('span', { class: `cc-chip is-${state}`, text })

/**
 * A block whose content depends on the WORKSPACE LIST, and must therefore be re-read
 * every time this page is shown.
 *
 * Found by 8.5/05's own smoke, not by the audit: each of these read `getWorkspaces()`
 * exactly once, inside the `setTimeout(…, 0)` that follows its build. The Settings page
 * is constructed at boot — before any workspace exists — so `wsSelect.value` stayed `''`,
 * `render()` hit its `if (!wsId) return`, and **"Workspace tools" and "Grants" rendered
 * permanently blank** for the whole session: no matrix, no dropdown, not even the
 * empty-state sentence explaining what a plan is. Only a plan change or a pane launch
 * ever repainted them. `integux-smoke.ts` has been computing `matrixEmptyOk` — and
 * dropping it out of its `pass` — for four phases.
 */
interface SyncedBlock {
  block: HTMLElement
  /** Re-read the workspace list and repaint. Called on every entry into Settings. */
  sync: () => void
}

/**
 * Settings § Integrations — ONE module, one home (the 7/12 lesson; index.ts
 * stays an assembler): the MCP pipeline end to end — connect (catalog), the
 * server REGISTRY fanned out per CLI dialect (diff preview, surgical writes,
 * drift chips), per-workspace tool PLANS, per-workspace GRANTS (write tools +
 * act origins), and the service-key vault. No integrations knob renders
 * anywhere else, ever. The event bridge (webhooks.ts) and the activity trail
 * (activity.ts) each moved to their OWN tab — they were never MCP knobs.
 */

const CLI_LABEL: Record<HostedCliId, string> = { 'claude-code': 'Claude Code', codex: 'Codex', gemini: 'Gemini' }
const CLI_PROVIDER: Record<HostedCliId, string> = { 'claude-code': 'claude', codex: 'codex', gemini: 'gemini' }
const HOSTED: readonly HostedCliId[] = ['claude-code', 'codex', 'gemini']

// ── The Integrations Catalog (8/07): presets as data, one pipeline ───────────
function createCatalogBlock(): SyncedBlock {
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
    panel.innerHTML = ''
    panel.append(
      el('div', { class: 'mgr-panel-summary' }, [providerLogo(preset.id, 18), el('span', { text: `Connect ${preset.label}` })])
    )
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
          text: `Key slots (env references, never literals): ${preset.envRefSlots.map((s) => `\${${s}}`).join(', ')} — set the variable yourself, or save it under Service keys.`
        })
      )
    }
    panel.append(
      el('div', {
        class: 'settings-row-caption',
        text: 'Scope stays per workspace: registering makes the server available to a CLI; which WORKSPACES see it is a tool plan, and what its agents may WRITE here stays this page’s grants. (Browser act-origins live under Trust › Browser.)'
      })
    )
    const previewPre = el('pre', { class: 'mgr-panel-block', hidden: true })
    const note = el('div', { class: 'menu-note trail-empty', hidden: true })
    const previewBtn = el('button', { class: 'trail-btn', type: 'button', text: 'Preview' }) as HTMLButtonElement
    previewBtn.onclick = async (): Promise<void> => {
      previewBtn.disabled = true
      const prep = (await bridge.invoke(IntegrationsChannels.catPrepare, {
        presetId: preset.id,
        baseUrl: baseInput?.value.trim() || undefined,
        authKind: authPick
      })) as { ok: boolean; entries?: McpServerEntry[]; reason?: string }
      previewBtn.disabled = false
      previewPre.hidden = false
      previewPre.textContent = prep.ok
        ? prep.entries!.map((en) => JSON.stringify(en, null, 2)).join('\n')
        : `refused: ${prep.reason}`
    }
    const connectBtn = el('button', { class: 'trail-btn', type: 'button', text: 'Connect' }) as HTMLButtonElement
    connectBtn.onclick = async (): Promise<void> => {
      const clis = HOSTED.filter((c) => checks.get(c)?.checked)
      connectBtn.disabled = true
      note.hidden = false
      note.textContent = ''
      note.append(loadingRow('Connecting…'))
      const r = (await bridge.invoke(IntegrationsChannels.catConnect, {
        presetId: preset.id,
        clis,
        baseUrl: baseInput?.value.trim() || undefined,
        authKind: authPick
      })) as { ok: boolean; reason?: string; results?: { cli: HostedCliId; ok: boolean; reason?: string }[] }
      connectBtn.disabled = false
      note.textContent = r.ok
        ? `Connected: ${r.results?.map((x) => `${CLI_LABEL[x.cli]} ${x.ok ? '✓' : `✗ (${x.reason})`}`).join(' · ')}`
        : `refused: ${r.reason}`
      if (r.ok) renderAuthorizeRow(preset, clis)
    }
    panel.append(el('div', { class: 'trail-controls' }, [previewBtn, connectBtn]), previewPre, note)

    function renderAuthorizeRow(p: McpPreset, clis: HostedCliId[]): void {
      const row = el('div', { class: 'trail-controls' })
      for (const cli of clis) {
        const cap = caps.find((c) => c.cli === cli)
        const authorizeCommand = cap?.authorizeCommand
        if (p.authKinds[0] === 'oauth' && authorizeCommand) {
          const btn = el('button', { class: 'trail-btn', type: 'button', text: `Authorize in ${CLI_LABEL[cli]}` }) as HTMLButtonElement
          btn.onclick = (): void => {
            // The CLI's OWN OAuth, in a managed pane — the vendor authenticates,
            // the CLI stores the token, we observe status only (ADR 0008.d).
            const snap = getWorkspaces()
            const cwd = snap.workspaces.find((w) => w.id === snap.activeId)?.cwd ?? snap.workspaces[0]?.cwd ?? ''
            if (!cwd) {
              showToast({ tone: 'info', title: 'Open a workspace first', body: 'Authorize runs the CLI in a pane.' })
              return
            }
            const opened = openWorkspaceFromTemplate({
              name: `Authorize ${p.label}`.slice(0, 28),
              cwd,
              paneCount: 1,
              assignments: [CLI_PROVIDER[cli]]
            })
            if (opened) {
              showToast({
                tone: 'info',
                title: `Finish in the pane`,
                body: `Run ${authorizeCommand.replace('<id>', p.id)} — the browser consent is the vendor's; the token stays in ${CLI_LABEL[cli]}.`
              })
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
    grid.innerHTML = ''
    let drafts = 0
    const seenGroups = new Set<string>()
    for (const preset of [...presets, ...custom]) {
      if (preset.group) {
        if (seenGroups.has(preset.group)) continue
        seenGroups.add(preset.group)
      }
      const rows = preset.group ? presets.filter((p) => p.group === preset.group) : [preset]
      const label = preset.group ? 'Google Workspace' : preset.label
      if (!preset.verifiedAt) drafts++
      const badge = preset.verifiedAt
        ? el('span', { class: 'cat-badge is-verified', text: `verified ${preset.verifiedAt}` })
        : el('span', { class: 'cat-badge is-draft', text: 'community — not house-vetted' })
      // "in N of M workspaces" — how many scoped workspaces plan this server.
      const planned = rows.reduce((n, r) => n + (coverage.counts[r.id] ?? 0), 0)
      const coverageBadge =
        planned > 0 && coverage.total > 0
          ? el('span', { class: 'cat-badge is-planned', text: `in ${planned} of ${coverage.total} workspace${coverage.total === 1 ? '' : 's'}` })
          : null
      const connect = el('button', { class: 'trail-btn', type: 'button', text: 'Connect…' }) as HTMLButtonElement
      connect.onclick = (): void => void openConnect(preset, rows)
      const exportBtn = el('button', { class: 'trail-btn cat-mini', type: 'button', text: 'Export' }) as HTMLButtonElement
      exportBtn.onclick = (): void => void bridge.invoke(IntegrationsChannels.catExport, preset.id)
      const feedBtn = el('button', { class: 'trail-btn cat-mini', type: 'button', text: 'Check feed' }) as HTMLButtonElement
      const feedNote = el('div', { class: 'menu-note trail-empty', hidden: true })
      feedBtn.onclick = async (): Promise<void> => {
        const r = (await bridge.invoke(IntegrationsChannels.catRefresh, preset.id)) as { ok: boolean; diff?: string; reason?: string }
        feedNote.hidden = false
        feedNote.textContent = r.ok ? r.diff ?? '' : r.reason ?? 'registry unavailable'
      }
      const card = el('div', { class: 'cat-card' }, [
        el('div', { class: 'cat-card-head' }, [
          providerLogo(preset.group ? 'google' : preset.id, 16),
          el('span', { class: 'mgr-label', text: label }),
          badge,
          coverageBadge
        ]),
        el('div', { class: 'cat-card-copy', text: preset.group ? `${rows.map((r) => r.label).join(' · ')} — one card, ${rows.length} endpoints.` : preset.grantCopy }),
        el('div', { class: 'trail-controls' }, [connect, feedBtn, exportBtn]),
        feedNote
      ])
      grid.append(card)
    }
    // `.cat-badge.is-draft` means "community — not house-vetted". It must reach the
    // fold's header: a user who has collapsed Connect should still see that some of
    // what they connected was never vetted. Informational, so it surfaces without
    // forcing the section open (see `attentionOpens`).
    signal('catalog', {
      chip: drafts ? attnChip('draft', `${drafts} unvetted`) : null,
      stat: null
    })
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
    searchResults.innerHTML = ''
    searchResults.append(loadingRow('Searching the registry…'))
    const r = (await bridge.invoke(IntegrationsChannels.catRegistry, searchInput.value.trim())) as {
      ok: boolean
      drafts?: { name: string; description: string; entry: McpServerEntry }[]
      reason?: string
    }
    searchResults.innerHTML = ''
    if (!r.ok) {
      searchResults.append(el('div', { class: 'menu-note', text: r.reason ?? 'registry unavailable' }))
      return
    }
    for (const d of r.drafts ?? []) {
      const save = el('button', { class: 'trail-btn cat-mini', type: 'button', text: 'Save as server' }) as HTMLButtonElement
      save.onclick = async (): Promise<void> => {
        const res = (await bridge.invoke(IntegrationsChannels.serversSave, d.entry)) as { ok: boolean; reason?: string }
        save.textContent = res.ok ? 'Saved — apply below' : `refused: ${res.reason}`
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
    el('div', { class: 'settings-row-caption', text: 'Official servers, verified with dates — Connect writes each CLI’s own config through the manager below. The app never runs, proxies, or authenticates a server; OAuth belongs to each CLI, keys are env references.' }),
    grid,
    panel,
    el('div', { class: 'trail-controls' }, [searchInput, searchBtn]),
    searchResults,
    el('div', { class: 'trail-controls' }, [importInput, importBtn]),
    importNote
  ])
  // Also workspace-dependent, by the same test as the matrix: every card renders
  // "in N of M workspaces" from `planCoverage`, and `custom` presets live in main's
  // KV, which the guided-flow modal writes to. Both go stale the moment you edit a
  // plan or connect from the modal, and nothing repainted them.
  const sync = (): void => void refresh()
  setTimeout(sync, 0)
  return { block, sync }
}

// ── Servers: the registry + per-CLI apply surface (8/06) ─────────────────────
function createServersBlock(): HTMLElement {
  const bridge = getBridge()
  const list = el('div', { class: 'mgr-list' })
  const panel = el('div', { class: 'mgr-panel', hidden: true })
  const saveNote = el('div', { class: 'menu-note trail-empty mgr-save-note', role: 'status', attrs: { 'aria-live': 'polite' }, hidden: true })

  async function openPanel(server: McpServerEntry, status: McpCliStatus): Promise<void> {
    panel.hidden = false
    panel.innerHTML = ''
    panel.append(loadingRow('Reading the CLI config…'))
    const action = status.state === 'applied' ? 'remove' : 'apply'
    const preview = (await bridge.invoke(IntegrationsChannels.mgrPreview, {
      serverId: server.id,
      cli: status.cli,
      action
    })) as { file: string; block: string; summary: string } | null
    panel.innerHTML = ''
    if (!preview) {
      panel.hidden = true
      return
    }
    panel.append(el('div', { class: 'mgr-panel-summary', text: preview.summary }))
    if (action === 'apply' && preview.block) {
      const pre = el('pre', { class: 'mgr-panel-block' })
      pre.textContent = preview.block
      panel.append(pre)
    }
    const actions = el('div', { class: 'trail-controls' })
    const doThen = (fn: () => Promise<unknown>) => async (): Promise<void> => {
      panel.innerHTML = ''
      panel.append(loadingRow('Writing the CLI config…'))
      await fn()
      panel.hidden = true
      await refresh()
    }
    if (status.state !== 'applied') {
      const apply = el('button', { class: 'trail-btn', type: 'button', text: status.state === 'not-applied' ? 'Apply' : 'Re-apply' }) as HTMLButtonElement
      apply.onclick = doThen(() => bridge.invoke(IntegrationsChannels.mgrApply, { serverId: server.id, cli: status.cli }))
      actions.append(apply)
    }
    if (status.state !== 'not-applied' && status.state !== 'drift-missing') {
      const remove = el('button', { class: 'trail-btn trail-clear', type: 'button', text: 'Remove from this CLI' }) as HTMLButtonElement
      remove.onclick = doThen(() => bridge.invoke(IntegrationsChannels.mgrRemoveFrom, { serverId: server.id, cli: status.cli }))
      actions.append(remove)
    }
    if (status.state === 'drift-edited') {
      const adopt = el('button', { class: 'trail-btn', type: 'button', text: 'Adopt the edit' }) as HTMLButtonElement
      adopt.onclick = doThen(() => bridge.invoke(IntegrationsChannels.mgrAdopt, { serverId: server.id, cli: status.cli }))
      actions.append(adopt)
    }
    if (status.state === 'drift-missing') {
      const forget = el('button', { class: 'trail-btn', type: 'button', text: 'Forget' }) as HTMLButtonElement
      forget.onclick = doThen(() => bridge.invoke(IntegrationsChannels.mgrAdopt, { serverId: server.id, cli: status.cli, forget: true }))
      actions.append(forget)
    }
    panel.append(actions)
    const backups = (await bridge.invoke(IntegrationsChannels.mgrBackups, status.cli)) as string[]
    if (backups.length) {
      panel.append(el('div', { class: 'settings-row-caption', text: `Backups (${backups.length}) — latest: ${backups[0]}` }))
    }
  }

  const STATE_TEXT: Record<McpCliStatus['state'], string> = {
    'not-applied': 'add',
    applied: '✓ applied',
    'drift-edited': 'drift',
    'drift-missing': 'missing'
  }

  const CONN_TEXT: Record<string, string> = { connected: 'connected', 'needs-auth': 'needs auth', error: 'error', drift: 'drift', registered: 'registered', off: 'not installed' }
  // Re-authorize (11): the CLI's OWN auth, in a managed pane — never an
  // auto-spawned browser (the consent is the user's to give).
  function runReauthorize(cli: HostedCliId, serverId: string, cmd: string | null): void {
    const snap = getWorkspaces()
    const cwd = snap.workspaces.find((w) => w.id === snap.activeId)?.cwd ?? snap.workspaces[0]?.cwd ?? ''
    if (!cwd) return void showToast({ tone: 'info', title: 'Open a workspace first', body: 'Re-authorize runs the CLI in a pane.' })
    const opened = openWorkspaceFromTemplate({ name: `Authorize ${serverId}`.slice(0, 28), cwd, paneCount: 1, assignments: [CLI_PROVIDER[cli]] })
    if (opened && cmd) showToast({ tone: 'info', title: 'Finish in the pane', body: `Run ${cmd.replace('<id>', serverId)} — the browser consent is the vendor's; the token stays in ${CLI_LABEL[cli]}.` })
  }

  async function refresh(): Promise<void> {
    let needsAuth = 0
    let drifted = 0
    let connected = 0
    const servers = (await bridge.invoke(IntegrationsChannels.serversList, undefined)) as McpServerEntry[]
    const snap = ((await bridge.invoke(IntegrationsChannels.statusGet)) as McpStatusSnapshot | null) ?? { statuses: [], at: 0 }
    const conn = new Map(snap.statuses.map((s) => [`${s.serverId}:${s.cli}`, s.state]))
    const caps = ((await bridge.invoke(IntegrationsChannels.catCapabilities)) as { cli: HostedCliId; authorizeCommand: string | null }[]) ?? []
    void bridge.invoke(IntegrationsChannels.statusRefresh) // poll fresh on open (pushed result repaints)
    list.innerHTML = ''
    for (const server of servers) {
      const statuses = (await bridge.invoke(IntegrationsChannels.mgrStatus, server.id)) as McpCliStatus[]
      const chips = statuses.map((s) => {
        // The pushed connection state (11) is the LIVE truth when applied.
        const cs = conn.get(`${server.id}:${s.cli}`)
        const live = cs && cs !== 'registered' && cs !== 'off' ? cs : null
        const cls = live ?? s.state
        if (cls === 'needs-auth') needsAuth++
        else if (cls === 'drift' || cls === 'drift-edited' || cls === 'drift-missing') drifted++
        else if (cls === 'connected' || cls === 'applied') connected++
        const label = s.installed ? (live ? CONN_TEXT[live] : STATE_TEXT[s.state]) : 'not installed'
        const chip = el('button', {
          class: `mgr-chip is-${cls}${s.installed ? '' : ' is-uninstalled'}`,
          type: 'button',
          text: `${CLI_LABEL[s.cli]} · ${label}`
        }) as HTMLButtonElement
        chip.title = s.file
        chip.disabled = !s.installed && s.state === 'not-applied'
        if (live === 'needs-auth') {
          const cmd = caps.find((c) => c.cli === s.cli)?.authorizeCommand ?? null
          chip.onclick = (): void => runReauthorize(s.cli, server.id, cmd)
        } else {
          chip.onclick = (): void => void openPanel(server, s)
        }
        return chip
      })
      const row = el('div', { class: 'mgr-row' }, [
        el('span', { class: 'mgr-label' }, [providerLogo(server.id, 14), el('span', { text: server.label })]),
        el('span', { class: 'mgr-id', text: `${server.id} · ${server.transport}${server.builtIn ? ' · built-in' : ''}` }),
        el('div', { class: 'mgr-chips' }, chips)
      ])
      if (!server.builtIn) {
        const drop = el('button', { class: 'trail-btn trail-clear mgr-drop', type: 'button', text: 'Delete' }) as HTMLButtonElement
        drop.onclick = async (): Promise<void> => {
          const r = (await bridge.invoke(IntegrationsChannels.serversRemove, server.id)) as { ok: boolean; reason?: string }
          if (!r.ok && r.reason) {
            saveNote.textContent = r.reason
            saveNote.hidden = false
          }
          await refresh()
        }
        row.append(drop)
      }
      list.append(row)
    }
    // Empty state (8/13, the 5/05 lesson). REMOVE #6: the primary CTA that lived here
    // was a byte-identical twin of the overview band's — on a fresh install, the ONE
    // state where this note renders, both were on screen at once. The note carries what
    // the band cannot; the button carried nothing.
    if (servers.filter((s) => !s.builtIn).length === 0) {
      list.append(
        // House EmptyState, keeping the `.integux-empty` hook the onboarding smokes assert.
        // No action — REMOVE #6 (05) deleted the CTA that duplicated the overview band's.
        el('div', { class: 'integux-empty' }, [
          EmptyState({
            icon: 'plug',
            title: 'Only the built-in server so far',
            body: 'Connect your first tool from the catalog above — we’ll walk you through it.'
          })
        ])
      )
    }
    signal('servers', {
      chip: needsAuth ? attnChip('needs-auth', `${needsAuth} need auth`) : drifted ? attnChip('drift', `${drifted} drifted`) : null,
      stat: `${connected} connected`
    })
  }

  // Add-server form (env values are ${VAR} references; literals are refused).
  const addToggle = el('button', { class: 'trail-btn', type: 'button', text: 'Add server…' }) as HTMLButtonElement
  const form = el('div', { class: 'mgr-form', hidden: true })
  const field = (label: string, placeholder: string): HTMLInputElement => {
    const input = el('input', { class: 'browser-sites-input mgr-input' }) as HTMLInputElement
    input.placeholder = placeholder
    input.setAttribute('aria-label', label)
    input.spellcheck = false
    input.addEventListener('keydown', (e) => e.stopPropagation())
    return input
  }
  const idInput = field('Server id', 'id (e.g. sentry)')
  const labelInput = field('Label', 'Label')
  const transportSel = el('select', { class: 'trail-select' }) as HTMLSelectElement
  transportSel.append(el('option', { value: 'stdio', text: 'stdio' }), el('option', { value: 'http', text: 'http' }))
  const commandInput = field('Command', 'command (stdio)')
  const argsInput = field('Arguments', 'args (space-separated; quote nothing)')
  const urlInput = field('URL', 'https://… (http transport)')
  const envInput = field('Env references', 'env: KEY=${VAR} (or paste a key value — it’s vaulted), comma-separated')
  const saveBtn = el('button', { class: 'trail-btn', type: 'button', text: 'Save server' }) as HTMLButtonElement
  saveBtn.onclick = async (): Promise<void> => {
    const env: Record<string, string> = {}
    const vaulted: string[] = []
    for (const pair of envInput.value.split(',').map((s) => s.trim()).filter(Boolean)) {
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      const k = pair.slice(0, eq).trim()
      const v = pair.slice(eq + 1).trim()
      if (v.includes('${')) {
        env[k] = v // already an env/vault reference — kept as-is
      } else {
        // 8/08: a literal is OFFERED the vault (not refused outright) — paste
        // once, store as ciphertext, and the config keeps only the ${NAME}.
        const r = (await bridge.invoke(IntegrationsChannels.serviceKeySet, { name: k, value: v })) as { ok: boolean; reason?: string }
        if (!r.ok) {
          saveNote.textContent = r.reason ?? 'refused'
          saveNote.hidden = false
          return
        }
        env[k] = `\${${k}}`
        vaulted.push(k)
      }
    }
    const entry = {
      id: idInput.value.trim(),
      label: labelInput.value.trim(),
      transport: transportSel.value,
      command: commandInput.value.trim() || undefined,
      args: argsInput.value.trim() ? argsInput.value.trim().split(/\s+/) : undefined,
      url: urlInput.value.trim() || undefined,
      env: Object.keys(env).length ? env : undefined
    }
    const r = (await bridge.invoke(IntegrationsChannels.serversSave, entry)) as { ok: boolean; reason?: string }
    saveNote.textContent = r.ok
      ? vaulted.length
        ? `Saved. ${vaulted.join(', ')} stored in the vault — the config references \${${vaulted[0]}}, never the value.`
        : 'Saved.'
      : (r.reason ?? 'refused')
    saveNote.hidden = false
    if (r.ok) {
      form.hidden = true
      await refresh()
    }
  }
  form.append(idInput, labelInput, transportSel, commandInput, argsInput, urlInput, envInput, saveBtn)
  addToggle.onclick = (): void => {
    form.hidden = !form.hidden
  }

  const block = el('div', { class: 'trail-block mgr-block' }, [
    el('div', { class: 'settings-row-caption', text: 'Register a server once and apply it to each CLI in its own config dialect. Writes are surgical (only our marked entries), backed up first, and only ever on your click — the app never runs, proxies, or authenticates a server. Env values are ${VAR} references; paste a key value and it’s vaulted (encrypted, materialized into pane env), never written as a literal.' }),
    list,
    panel,
    el('div', { class: 'trail-controls' }, [addToggle]),
    form,
    saveNote
  ])
  bridge.on(IntegrationsChannels.statusChanged, () => void refresh()) // 11: live status push repaints the grid
  setTimeout(() => void refresh(), 0)
  return block
}

// ── Grants: the per-workspace MCP write boundary (8/03's store) ──────────────
// The store also carries `web` + `actOrigins`, but those are a BROWSER boundary:
// their editor lives on Trust › Browser (act-origins.ts) and this knob patches
// only `writeTools` — two cards, one grant object, no field fought over.
function createGrantsBlock(): SyncedBlock {
  const bridge = getBridge()
  const wsSelect = el('select', { class: 'trail-select' }) as HTMLSelectElement
  wsSelect.setAttribute('aria-label', 'Workspace')
  const body = el('div', { class: 'mgr-grant-body' })

  async function render(): Promise<void> {
    const wsId = wsSelect.value
    body.innerHTML = ''
    if (!wsId) return
    const grant = (await bridge.invoke(IntegrationsChannels.grantGet, wsId)) as WorkspaceIntegrationsGrant
    // Write tools: none (default) / all — the catalog boundary (8/03).
    const writesOn = grant.writeTools === 'all'
    const writeBtn = el('button', {
      class: `trail-btn${writesOn ? ' is-armed' : ''}`,
      type: 'button',
      text: writesOn ? 'Write tools: ALL (agents can send/mail/claim/update here)' : 'Write tools: none (default)'
    }) as HTMLButtonElement
    writeBtn.onclick = async (): Promise<void> => {
      await bridge.invoke(IntegrationsChannels.grantSet, { ...grant, writeTools: writesOn ? 'none' : 'all' })
      await render()
    }
    body.append(el('div', { class: 'trail-controls' }, [writeBtn]))
  }

  function refreshWorkspaces(): void {
    const current = wsSelect.value
    wsSelect.innerHTML = ''
    for (const w of getWorkspaces().workspaces) wsSelect.append(el('option', { value: w.id, text: w.name }))
    wsSelect.value = current || (getWorkspaces().activeId ?? '')
    if (!wsSelect.value && wsSelect.options.length) wsSelect.selectedIndex = 0
  }
  wsSelect.onchange = (): void => void render()

  const block = el('div', { class: 'trail-block mgr-grants-block' }, [
    el('div', { class: 'settings-row-caption', text: 'Per workspace, default closed: which MCP write tools agents get. The reviewer gate stays the boundary — approve is never a tool. Which ORIGINS agents may act on is a browser boundary: Trust › Browser.' }),
    el('div', { class: 'trail-controls' }, [wsSelect]),
    body
  ])
  const sync = (): void => {
    refreshWorkspaces()
    void render()
  }
  setTimeout(sync, 0)
  return { block, sync }
}

// ── Service keys: the paste-once fleet vault (8/08) ──────────────────────────
// A service key pasted ONCE -> OS-vault ciphertext -> materialized into the env
// of every pane the Workspace launches, so api-key MCP servers read it without
// a secret literal in any CLI config. WRITE-ONLY, like the 7/12 usage keys: a
// masked saved chip with Delete/Replace, never a reveal (no getter channel
// exists). The env forms reference these by ${NAME}; the literal is refused.
// A SyncedBlock: the add-server form and the guided flow both vault keys from
// OUTSIDE this block, so the list re-reads on every entry into Settings.
function createServiceKeysBlock(): SyncedBlock {
  const bridge = getBridge()
  const list = el('div', { class: 'mgr-list' })
  const nameInput = el('input', { class: 'browser-sites-input mgr-input', placeholder: 'ENV NAME (e.g. POSTHOG_API_KEY)' }) as HTMLInputElement
  nameInput.spellcheck = false
  nameInput.addEventListener('keydown', (e) => e.stopPropagation())
  const keyInput = el('input', { class: 'browser-sites-input mgr-input', placeholder: 'paste key value…' }) as HTMLInputElement
  keyInput.type = 'password'
  keyInput.addEventListener('keydown', (e) => e.stopPropagation())
  const saveBtn = el('button', { class: 'trail-btn', type: 'button', text: 'Save key to vault' }) as HTMLButtonElement
  const note = el('div', { class: 'settings-error mgr-note', role: 'alert', hidden: true })

  async function refresh(): Promise<void> {
    const names = ((await bridge.invoke(IntegrationsChannels.serviceKeyList)) as string[]) ?? []
    list.innerHTML = ''
    if (!names.length) list.append(el('div', { class: 'menu-note', text: 'No service keys saved. Paste one below; reference it as ${NAME} in a server’s env.' }))
    for (const name of names) {
      const row = el('div', { class: 'mgr-row' }, [
        el('span', { class: 'mono mgr-server-id', text: `\${${name}}` }),
        el('span', { class: 'pill usage-key-saved', text: 'saved ····' })
      ])
      const del = el('button', { class: 'browser-sites-forget', type: 'button', text: 'Delete' }) as HTMLButtonElement
      del.onclick = async (): Promise<void> => {
        await bridge.invoke(IntegrationsChannels.serviceKeyClear, name)
        await refresh()
      }
      row.append(del)
      list.append(row)
    }
    signal('keys', {
      chip: null,
      stat: names.length ? `${names.length} saved` : 'none'
    })
  }

  saveBtn.onclick = async (): Promise<void> => {
    const name = nameInput.value.trim()
    const value = keyInput.value
    if (!name || !value) return
    keyInput.value = '' // the value leaves the DOM before the round trip
    const r = (await bridge.invoke(IntegrationsChannels.serviceKeySet, { name, value })) as { ok: boolean; reason?: string }
    note.hidden = r.ok
    if (r.ok) {
      nameInput.value = ''
      await refresh()
    } else {
      note.textContent = r.reason ?? 'refused'
    }
  }

  const block = el('div', { class: 'trail-block mgr-block' }, [
    el('div', { class: 'settings-row-caption', text: 'Paste an api key once — it’s encrypted by your OS keychain and reaches agents in panes MoggingLabs Workspace launches, as the env var ${NAME}. No secret ever lands in a CLI config, a log, or on disk in plaintext. A CLI you run elsewhere needs the same variable set in your own environment. (Keys for usage polling are separate: Usage › Usage sources.)' }),
    el('div', {
      class: 'settings-row-caption',
      text:
        'Honest boundary: any key an MCP server needs is readable by that agent’s process — the same as any env var. Scope servers per workspace so only the agents you intend can reach a given key.'
    }),
    list,
    el('div', { class: 'mgr-form' }, [nameInput, keyInput, saveBtn]),
    note
  ])
  const sync = (): void => void refresh()
  setTimeout(sync, 0)
  return { block, sync }
}

// ── The tool plan: which servers reach a workspace's panes, per CLI (8/09) ───
function createToolPlanBlock(): SyncedBlock {
  const bridge = getBridge()
  const CLI_ORDER: HostedCliId[] = ['claude-code', 'codex', 'gemini']
  const wsSelect = el('select', { class: 'trail-select' }) as HTMLSelectElement
  wsSelect.setAttribute('aria-label', 'Workspace')
  const body = el('div', { class: 'mgr-grant-body' })

  const cliArrayFor = (plan: WorkspaceToolPlan, serverId: string): HostedCliId[] => {
    const scope = plan.entries[serverId]
    if (!scope) return []
    return scope === 'all-clis' ? [...CLI_ORDER] : [...scope]
  }

  async function render(): Promise<void> {
    const wsId = wsSelect.value
    body.innerHTML = ''
    if (!wsId) return
    const plan = (await bridge.invoke(IntegrationsChannels.planGet, wsId)) as WorkspaceToolPlan
    const servers = ((await bridge.invoke(IntegrationsChannels.serversList)) as McpServerEntry[]) ?? []
    const globalFor = new Map<string, Set<HostedCliId>>()
    for (const s of servers) {
      const statuses = ((await bridge.invoke(IntegrationsChannels.mgrStatus, s.id)) as McpCliStatus[]) ?? []
      globalFor.set(s.id, new Set(statuses.filter((x) => x.state === 'applied').map((x) => x.cli)))
    }
    const setPlan = async (next: WorkspaceToolPlan): Promise<void> => {
      await bridge.invoke(IntegrationsChannels.planSet, next)
      await render()
    }

    const inheritBtn = el('button', {
      class: `trail-btn${plan.inheritGlobal ? ' is-armed' : ''}`,
      type: 'button',
      text: plan.inheritGlobal ? 'Inherit global (“everywhere”) tools: ON' : 'Inherit global tools: OFF — plan only'
    }) as HTMLButtonElement
    inheritBtn.onclick = (): void => void setPlan({ ...plan, inheritGlobal: !plan.inheritGlobal })
    body.append(el('div', { class: 'trail-controls' }, [inheritBtn]))

    const table = el('div', { class: 'toolplan-matrix' })
    table.append(
      el('div', { class: 'toolplan-row toolplan-head' }, [
        el('span', { class: 'toolplan-tool', text: 'Tool' }),
        ...CLI_ORDER.map((c) => el('span', { class: 'toolplan-cell-head', text: CLI_LABEL[c] }))
      ])
    )
    for (const s of servers) {
      const cells = CLI_ORDER.map((cli) => {
        if (s.builtIn) return el('span', { class: 'toolplan-cell is-locked', text: 'always', title: 'The house server is always available' })
        const state = toolCellState(plan, s.id, cli, globalFor.get(s.id)?.has(cli) ?? false)
        const label = state === 'planned' ? 'on' : state === 'global' ? 'global' : 'off'
        const cell = el('button', {
          class: `toolplan-cell is-${state}`,
          type: 'button',
          text: label,
          ariaLabel: `${s.label} on ${CLI_LABEL[cli]}: ${label}`,
          title: state === 'global' ? 'Inherited from the global tier' : state === 'planned' ? 'In this workspace’s plan' : 'Not in this pane'
        }) as HTMLButtonElement
        cell.onclick = (): void => {
          const arr = cliArrayFor(plan, s.id)
          const nextArr = arr.includes(cli) ? arr.filter((c) => c !== cli) : [...arr, cli]
          const entries = { ...plan.entries }
          if (!nextArr.length) delete entries[s.id]
          else entries[s.id] = nextArr.length === CLI_ORDER.length ? 'all-clis' : nextArr
          void setPlan({ ...plan, entries })
        }
        return cell
      })
      table.append(
        el('div', { class: 'toolplan-row' }, [
          el('span', { class: 'toolplan-tool' }, [providerLogo(s.id, 13), el('span', { text: s.label })]),
          ...cells
        ])
      )
    }
    body.append(table)
    // Matrix empty state (8/13): explain plans in one sentence.
    if (servers.filter((s) => !s.builtIn).length === 0) {
      body.append(el('div', { class: 'menu-note toolplan-empty', text: 'A plan decides which servers reach this workspace’s agents, per CLI — minimal by default, so panes carry only what the work needs. Connect a server above, then turn it on here.' }))
    }

    const counts = CLI_ORDER.map((cli) => {
      const n = 1 + servers.filter((s) => !s.builtIn && planHasServerForCli(plan, s.id, cli)).length
      return `${CLI_LABEL[cli]} ${n}`
    })
    const pending = restartNeededPaneIds(wsId, planSignature(plan)).length
    signal('matrix', {
      chip: pending ? attnChip('pending', `${pending} pane${pending === 1 ? '' : 's'} to restart`) : null,
      stat: counts.join(' · ')
    })
    body.append(
      el('div', {
        class: 'settings-row-caption toolplan-truth',
        text:
          `Panes here launch with — ${counts.join(' · ')} — servers (house + plan${plan.inheritGlobal ? ' + global' : ''}).` +
          (pending ? ` ${pending} live pane${pending === 1 ? '' : 's'} pending restart to apply.` : '')
      })
    )
  }

  function refreshWorkspaces(): void {
    const current = wsSelect.value
    wsSelect.innerHTML = ''
    for (const w of getWorkspaces().workspaces) wsSelect.append(el('option', { value: w.id, text: w.name }))
    wsSelect.value = current || (getWorkspaces().activeId ?? '')
    if (!wsSelect.value && wsSelect.options.length) wsSelect.selectedIndex = 0
  }
  wsSelect.onchange = (): void => void render()
  // A plan edit -> re-render + nudge any live panes that now need a restart.
  bridge.on(IntegrationsChannels.planChanged, (payload) => {
    const p = payload as WorkspaceToolPlan
    const stale = restartNeededPaneIds(p.workspaceId, planSignature(p)).length
    if (stale) {
      showToast({ title: 'Tool plan changed', body: `${stale} live pane${stale === 1 ? '' : 's'} need a restart to apply`, tone: 'info', timeout: 6000 })
    }
    void render()
  })
  // A launch/close changes the live-pane set -> refresh the pending count.
  onToolPlanPanesChange(() => void render())

  const block = el('div', { class: 'trail-block mgr-grants-block' }, [
    el('div', { class: 'settings-row-caption', text: 'Which registered servers reach this workspace’s panes, per CLI — so agents carry only the tools the work needs, not everything connected. The house server is always on; “global” tools are inherited only when you turn inheritance on. Scoping is context hygiene, not a permission — grants stay the boundary.' }),
    el('div', { class: 'trail-controls' }, [wsSelect]),
    body
  ])
  const sync = (): void => {
    refreshWorkspaces()
    void render()
  }
  setTimeout(sync, 0)
  return { block, sync }
}

// ── The guided "Connect your stack" flow (8/13) — ORCHESTRATES 06/07/09 ─────
// Walks the catalog in site order, filtered to DETECTED CLIs; per tool
// Connect -> Authorize -> next; skippable, resumable (progress in localStorage,
// survives restart), ends on the workspace-plan reminder. Zero new write paths.
const FLOW_KEY = 'mogging.integux.done'
function flowDone(): string[] {
  try {
    return JSON.parse(localStorage.getItem(FLOW_KEY) ?? '[]') as string[]
  } catch {
    return []
  }
}
function flowMark(id: string): void {
  try {
    localStorage.setItem(FLOW_KEY, JSON.stringify([...new Set([...flowDone(), id])]))
  } catch {
    /* storage off */
  }
}

export function openGuidedFlow(): void {
  const bridge = getBridge()
  const modal = createModal({ title: 'Connect your stack', width: 520 })
  const body = el('div', { class: 'integux-flow' })
  modal.setBody(body)
  modal.open()

  void (async (): Promise<void> => {
    const { presets } = (await bridge.invoke(IntegrationsChannels.catList)) as { presets: McpPreset[] }
    const agents = ((await bridge.invoke(AgentChannels.detect)) as { id: string; installed: boolean }[]) ?? []
    const detected = HOSTED.filter((c) => agents.some((a) => a.installed && a.id === CLI_PROVIDER[c]))
    const step = (): void => {
      body.replaceChildren()
      if (!detected.length) {
        body.append(el('div', { class: 'settings-row-caption', text: 'Install a coding-agent CLI (Claude Code, Codex, or Gemini) first — then come back and we’ll wire your tools to it.' }))
        modal.setFooter(el('div', { class: 'confirm-actions' }, [Button({ label: 'Close', variant: 'ghost', onClick: () => modal.close() })]))
        return
      }
      const done = flowDone()
      const next = presets.find((p) => !done.includes(p.id))
      if (!next) {
        // Ends on the workspace-plan reminder (09).
        body.append(
          el('div', { class: 'integux-flow-done' }, [
            el('h3', { class: 'board-card-title', text: 'You’re set up.' }),
            el('div', { class: 'settings-row-caption', text: 'Last thing: scope tools per workspace — minimal is the default, so agents carry only what the work needs. Open the matrix any time.' })
          ])
        )
        modal.setFooter(
          el('div', { class: 'confirm-actions' }, [
            // Drain the token NOW: the flow opens from this very page, so no view
            // change follows to consume it — undrained, it would sit pending and
            // scroll some FUTURE settings entry somewhere the user never asked for.
            Button({ label: 'Open workspace tools', variant: 'ghost', onClick: () => { requestIntegrationsFocus('matrix'); modal.close(); enterIntegrations() } }),
            Button({ label: 'Done', variant: 'primary', onClick: () => modal.close() })
          ])
        )
        return
      }
      const note = el('div', { class: 'settings-error', role: 'alert', hidden: true })
      body.append(
        el('div', { class: 'integux-flow-tool', attrs: { 'data-preset': next.id } }, [
          el('div', { class: 'settings-row-label', text: `Connect ${next.label}` }),
          el('div', { class: 'settings-row-caption', text: `${next.grantCopy}` }),
          el('div', { class: 'settings-row-caption', text: `Will connect to: ${detected.map((c) => CLI_LABEL[c]).join(', ')}` }),
          note
        ])
      )
      const connectBtn = Button({
        label: `Connect ${next.label}`,
        variant: 'primary',
        onClick: async () => {
          const r = (await bridge.invoke(IntegrationsChannels.catConnect, { presetId: next.id, clis: detected })) as { ok: boolean; reason?: string }
          if (!r.ok) {
            note.textContent = r.reason ?? 'refused'
            note.hidden = false
            return
          }
          flowMark(next.id)
          step()
        }
      })
      modal.setFooter(
        el('div', { class: 'confirm-actions' }, [
          Button({ label: 'Skip', variant: 'ghost', onClick: () => { flowMark(next.id); step() } }),
          connectBtn
        ])
      )
    }
    step()
  })()
}

// The overview band (8.5/05). Not a Card and never folded: it is the one thing on
// this page that answers "is anything wrong?" without opening anything. Its three
// stats are fed by `onSignal` — nothing here is knowable at build time.
function createIntegrationsIntro(): HTMLElement {
  const setup = Button({ label: 'Set up integrations…', icon: 'sparkles', variant: 'primary', onClick: () => openGuidedFlow() })
  setup.classList.add('integux-setup-cta')

  const stat = (label: string): { el: HTMLElement; set: (v: string) => void } => {
    const value = el('span', { class: 'integux-stat-value', text: '—' })
    return {
      el: el('div', { class: 'integux-stat' }, [el('span', { class: 'integux-stat-label', text: label }), value]),
      set: (v) => (value.textContent = v)
    }
  }
  const servers = stat('Servers')
  const keys = stat('Service keys')
  const setters: Partial<Record<SectionId, (v: string) => void>> = {
    servers: servers.set,
    keys: keys.set
  }
  onSignal((id, sig) => {
    if (sig.stat) setters[id]?.(sig.stat)
  })

  return el('div', { class: 'trail-block integux-intro' }, [
    el('div', { class: 'settings-row-label', text: 'Connect your stack' }),
    el('div', { class: 'settings-row-caption', text: 'Wire your tools (Sentry, GitHub, Slack…) to the coding agents you already run — the app never holds a credential; the CLIs own their auth.' }),
    el('div', { class: 'integux-stats' }, [servers.el, keys.el]),
    el('div', { class: 'trail-controls' }, [setup])
  ])
}

// The in-app privacy block (the usage-tab pattern) — the custody rule in user
// words + the docs/14 pointer.
function createIntegrationsPrivacy(): HTMLElement {
  return el('div', { class: 'trail-block integux-privacy' }, [
    el('div', { class: 'settings-row-label', text: 'What the app can and can’t see' }),
    el('div', { class: 'settings-note' }, [
      icon('check-circle', 14),
      el('span', { text: 'Your keys, your CLIs. The agents authenticate with your own accounts; the app never stores an OAuth token. API keys you paste are encrypted by your OS keychain and only ever materialize into a pane’s environment — never a config file, log, or telemetry. Webhook URLs are secrets too. Repo names, tool lists, and titles stay in the app: telemetry is counts and booleans only (docs/14).' })
    ])
  ])
}

// Focus targets and the sync bundle outlive any single build, so `goIntegrations` can
// drive them even when Settings is ALREADY the active view — see enterIntegrations.
let focusTargets: Record<Exclude<IntegrationsFocus, 'flow'>, CollapsibleCardHandle> | null = null
let syncAll: (() => void) | null = null
let entryQueued = false

/**
 * The page was entered: re-read everything that can go stale, then honour any pending
 * focus request.
 *
 * DEFERRED, and coalesced. Five blocks re-reading their data is real work, and running
 * it inside the listener means running it inside the frame that swaps the view — before
 * a single pixel of Settings has painted. A macrotask costs nothing and lets the switch
 * land first. Coalesced because both `onViewChange` and `goIntegrations` call this, and
 * a palette verb fired from Home triggers both.
 */
export function enterIntegrations(): void {
  if (entryQueued) return
  entryQueued = true
  setTimeout(() => {
    entryQueued = false
    syncAll?.()
    applyIntegrationsFocus() // after the syncs: a focus scroll should measure real content
  }, 0)
}

/**
 * Drain a pending focus request: expand the target, THEN scroll to it.
 *
 * Scrolling to a folded card would land the user on a 40px header and reveal nothing —
 * a no-op shaped like a success. The 60ms still buys the blocks' `setTimeout(…, 0)`
 * hydration, so the card has its real height before `scrollIntoView` measures it.
 * The expand is not persisted: you asked to see it once, not to change your layout.
 */
export function applyIntegrationsFocus(): void {
  const t = takeIntegrationsFocus()
  if (!t) return
  if (t === 'flow') return openGuidedFlow()
  const card = focusTargets?.[t]
  if (!card) return
  card.setOpen(true, { persist: false })
  setTimeout(() => card.el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60)
}

export function createIntegrationsSection(): HTMLElement {
  // A second mount would otherwise stack duplicate listeners onto detached DOM.
  signalListeners.clear()
  lastSignal.clear()

  const catalogBlock = createCatalogBlock()
  const toolplan = createToolPlanBlock()
  const grantsBlock = createGrantsBlock()
  const keysBlock = createServiceKeysBlock()
  const card = (
    id: SectionId,
    title: string,
    caption: string | Node,
    body: HTMLElement,
    o: { defaultOpen?: boolean; attentionOpens?: boolean; class?: string } = {}
  ): CollapsibleCardHandle =>
    createCollapsibleCard({ id, title, caption, storagePrefix: 'integrations', ...o }, [body])

  // Task order, not build order: connect a tool, register it, scope it, grant it,
  // then key it. (Webhooks and the activity trail have their own tabs now.)
  // One line each. A fold you must read four lines to skip is not a fold — the full
  // paragraph lives at the top of each body, where it applies. Every purpose line keeps
  // its load-bearing clause: what the app will never do with your credentials.
  const catalog = card('catalog', 'Connect', 'Verified servers, wired to the CLIs you already run — the app never authenticates one.', catalogBlock.block, { defaultOpen: true, attentionOpens: false })
  const servers = card('servers', 'Servers & registry', 'Register once, apply per CLI. Writes are surgical, backed up, and only on your click.', createServersBlock())
  const matrix = card('matrix', 'Workspace tool plans', 'Which servers reach this workspace’s panes. Context hygiene, not a permission.', toolplan.block)
  const grants = card('grants', 'Grants', 'Which MCP write tools agents get here. Default closed — approve is never a tool.', grantsBlock.block)
  const keys = card('keys', 'Service keys', 'One paste, encrypted by your OS keychain. Never a config file, a log, or plaintext on disk.', keysBlock.block)

  const cards: Record<SectionId, CollapsibleCardHandle> = { catalog, servers, matrix, grants, keys }
  onSignal((id, sig) => cards[id]?.setAttention(sig.chip))

  const section = el('div', { class: 'integrations-section' }, [
    createIntegrationsIntro(),
    catalog.el,
    servers.el,
    matrix.el,
    grants.el,
    keys.el,
    createIntegrationsPrivacy()
  ])

  focusTargets = { matrix, servers }
  // Every entry into Settings re-reads what can go stale. Reading it once at boot is
  // what left the matrix and the grants blank on a fresh install (see SyncedBlock).
  const syncs = [catalogBlock.sync, toolplan.sync, grantsBlock.sync, keysBlock.sync]
  syncAll = (): void => {
    for (const sync of syncs) sync()
  }
  onViewChange((v) => {
    if (v === 'settings') enterIntegrations()
  })
  return section
}
