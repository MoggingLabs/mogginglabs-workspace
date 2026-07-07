import {
  AgentChannels,
  IntegrationsChannels,
  planHasServerForCli,
  toolCellState,
  type WorkspaceToolPlan,
  type McpAuthKind,
  type HostedCliId,
  type McpCliStatus,
  type McpPreset,
  type McpServerEntry,
  type TrailEntry,
  type TrailSource,
  type WorkspaceIntegrationsGrant
} from '@contracts'
import { getBridge } from '../../core/ipc/bridge'
import { el, loadingRow, showToast } from '../../components'
import { getWorkspaces } from '../../core/workspace/workspace-info-port'
import { openWorkspaceFromTemplate } from '../../core/workspace/open-service'
import { fmtAge } from '../usage'

/**
 * Settings § Integrations — ONE module, one home (the 7/12 lesson; index.ts
 * stays an assembler). 8/05 landed the Activity trail; 8/06 grows the section
 * into the manager: the server REGISTRY fanned out per CLI dialect (diff
 * preview, surgical writes, drift chips) and the per-workspace GRANTS
 * (write tools + act origins). 07/08 extend this module in place — no
 * integrations knob renders anywhere else, ever.
 */

const CLI_LABEL: Record<HostedCliId, string> = { 'claude-code': 'Claude Code', codex: 'Codex', gemini: 'Gemini' }
const CLI_PROVIDER: Record<HostedCliId, string> = { 'claude-code': 'claude', codex: 'codex', gemini: 'gemini' }
const HOSTED: readonly HostedCliId[] = ['claude-code', 'codex', 'gemini']

// ── The Integrations Catalog (8/07): presets as data, one pipeline ───────────
function createCatalogBlock(): HTMLElement {
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
    panel.append(el('div', { class: 'mgr-panel-summary', text: `Connect ${preset.label}` }))
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
          text: `Key slots (env references, never literals): ${preset.envRefSlots.map((s) => `\${${s}}`).join(', ')} — set the variable yourself, or a vault slot (8/08).`
        })
      )
    }
    panel.append(
      el('div', {
        class: 'settings-row-caption',
        text: 'Scope stays per workspace: registering makes the server available to a CLI; which WORKSPACES see it is a tool plan (8/09), and what its agents may do here stays this page’s grants.'
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
    try {
      const agents = (await bridge.invoke(AgentChannels.detect, undefined)) as { id: string; installed: boolean }[]
      installed = new Set(agents.filter((a) => a.installed).map((a) => a.id))
    } catch {
      installed = new Set()
    }
    grid.innerHTML = ''
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
        el('div', { class: 'cat-card-head' }, [el('span', { class: 'mgr-label', text: label }), badge]),
        el('div', { class: 'cat-card-copy', text: preset.group ? `${rows.map((r) => r.label).join(' · ')} — one card, ${rows.length} endpoints.` : preset.grantCopy }),
        el('div', { class: 'trail-controls' }, [connect, feedBtn, exportBtn]),
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
    el('div', { class: 'settings-row-label', text: 'Integrations catalog' }),
    el('div', {
      class: 'settings-row-caption',
      text: 'Official servers, verified with dates — Connect writes each CLI’s own config through the manager below. The app never runs, proxies, or authenticates a server; OAuth belongs to each CLI, keys are env references.'
    }),
    grid,
    panel,
    el('div', { class: 'trail-controls' }, [searchInput, searchBtn]),
    searchResults,
    el('div', { class: 'trail-controls' }, [importInput, importBtn]),
    importNote
  ])
  setTimeout(() => void refresh(), 0)
  return block
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

  async function refresh(): Promise<void> {
    const servers = (await bridge.invoke(IntegrationsChannels.serversList, undefined)) as McpServerEntry[]
    list.innerHTML = ''
    for (const server of servers) {
      const statuses = (await bridge.invoke(IntegrationsChannels.mgrStatus, server.id)) as McpCliStatus[]
      const chips = statuses.map((s) => {
        const chip = el('button', {
          class: `mgr-chip is-${s.state}${s.installed ? '' : ' is-uninstalled'}`,
          type: 'button',
          text: `${CLI_LABEL[s.cli]} · ${s.installed ? STATE_TEXT[s.state] : 'not installed'}`
        }) as HTMLButtonElement
        chip.title = s.file
        chip.disabled = !s.installed && s.state === 'not-applied' // writer skipped; applied entries stay actionable
        chip.onclick = (): void => void openPanel(server, s)
        return chip
      })
      const row = el('div', { class: 'mgr-row' }, [
        el('span', { class: 'mgr-label', text: server.label }),
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
    el('div', { class: 'settings-row-label', text: 'MCP servers' }),
    el('div', {
      class: 'settings-row-caption',
      text:
        'Register a server once and apply it to each CLI in its own config dialect. Writes are surgical (only our marked entries), backed up first, and only ever on your click — the app never runs, proxies, or authenticates a server. Env values are ${VAR} references; paste a key value and it’s vaulted (encrypted, materialized into pane env), never written as a literal.'
    }),
    list,
    panel,
    el('div', { class: 'trail-controls' }, [addToggle]),
    form,
    saveNote
  ])
  setTimeout(() => void refresh(), 0)
  return block
}

// ── Grants: the per-workspace boundary knobs (03/04's store) ─────────────────
function createGrantsBlock(): HTMLElement {
  const bridge = getBridge()
  const wsSelect = el('select', { class: 'trail-select' }) as HTMLSelectElement
  wsSelect.setAttribute('aria-label', 'Workspace')
  const body = el('div', { class: 'mgr-grant-body' })

  async function render(): Promise<void> {
    const wsId = wsSelect.value
    body.innerHTML = ''
    if (!wsId) return
    const grant = (await bridge.invoke(IntegrationsChannels.grantGet, wsId)) as WorkspaceIntegrationsGrant
    const set = async (patch: Partial<WorkspaceIntegrationsGrant>): Promise<void> => {
      await bridge.invoke(IntegrationsChannels.grantSet, { ...grant, ...patch })
      await render()
    }
    // Write tools: none (default) / all — the catalog boundary (8/03).
    const writesOn = grant.writeTools === 'all'
    const writeBtn = el('button', {
      class: `trail-btn${writesOn ? ' is-armed' : ''}`,
      type: 'button',
      text: writesOn ? 'Write tools: ALL (agents can send/mail/claim/update here)' : 'Write tools: none (default)'
    }) as HTMLButtonElement
    writeBtn.onclick = (): void => void set({ writeTools: writesOn ? 'none' : 'all' })
    body.append(el('div', { class: 'trail-controls' }, [writeBtn]))
    // Act origins: the agent-web boundary (8/04). Sensitive origins refuse.
    body.append(el('div', { class: 'settings-row-caption', text: `Origins agents may ACT on (web tier: ${grant.web})` }))
    for (const origin of grant.actOrigins) {
      const drop = el('button', { class: 'browser-sites-forget', type: 'button', text: 'Revoke' }) as HTMLButtonElement
      drop.onclick = (): void => void set({ actOrigins: grant.actOrigins.filter((o) => o !== origin) })
      body.append(el('div', { class: 'browser-sites-row' }, [el('span', { class: 'browser-sites-host', text: origin }), drop]))
    }
    const addInput = el('input', { class: 'browser-sites-input' }) as HTMLInputElement
    addInput.placeholder = 'github.com'
    addInput.spellcheck = false
    addInput.addEventListener('keydown', (e) => e.stopPropagation())
    const refusedNote = el('div', { class: 'menu-note browser-sites-refused', hidden: true })
    const addBtn = el('button', { class: 'browser-sites-add', type: 'button', text: 'Grant origin' }) as HTMLButtonElement
    addBtn.onclick = async (): Promise<void> => {
      const raw = addInput.value.trim()
      if (!raw) return
      const saved = (await bridge.invoke(IntegrationsChannels.grantSet, {
        ...grant,
        web: 'signed-in',
        actOrigins: [...grant.actOrigins, raw]
      })) as WorkspaceIntegrationsGrant | null
      if (!saved || saved.actOrigins.length === grant.actOrigins.length) {
        refusedNote.textContent = `“${raw}” was refused — sensitive origins never accept act grants.`
        refusedNote.hidden = false
        return
      }
      await render()
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

  const block = el('div', { class: 'trail-block mgr-grants-block' }, [
    el('div', { class: 'settings-row-label', text: 'Workspace grants' }),
    el('div', {
      class: 'settings-row-caption',
      text: 'Per workspace, default closed: which MCP write tools agents get, and which signed-in origins they may act on. The reviewer gate stays the boundary — approve is never a tool.'
    }),
    el('div', { class: 'trail-controls' }, [wsSelect]),
    body
  ])
  setTimeout(() => {
    refreshWorkspaces()
    void render()
  }, 0)
  return block
}

// ── Activity: the audit trail viewer (8/05, absorbed) ────────────────────────
function createActivityBlock(): HTMLElement {
  const bridge = getBridge()

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

  const controls = el('div', { class: 'trail-controls' }, [wsSelect, srcSelect, refreshBtn, exportBtn, clearBtn])
  const block = el('div', { class: 'trail-block trail-activity' }, [
    el('div', { class: 'settings-row-label', text: 'Agent activity' }),
    honesty,
    controls,
    emptyNote,
    list
  ])

  // First paint: populate lazily so a fresh settings open shows live data.
  setTimeout(() => {
    refreshWorkspaceOptions()
    void refresh()
  }, 0)

  return block
}

// ── Service keys: the paste-once fleet vault (8/08) ──────────────────────────
// A service key pasted ONCE -> OS-vault ciphertext -> materialized into the env
// of every pane the Workspace launches, so api-key MCP servers read it without
// a secret literal in any CLI config. WRITE-ONLY, like the 7/12 usage keys: a
// masked saved chip with Delete/Replace, never a reveal (no getter channel
// exists). The env forms reference these by ${NAME}; the literal is refused.
function createServiceKeysBlock(): HTMLElement {
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
    el('div', { class: 'settings-row-label', text: 'Service keys (vault)' }),
    el('div', {
      class: 'settings-row-caption',
      text:
        'Paste an api key once — it’s encrypted by your OS keychain and reaches agents in panes MoggingLabs Workspace launches, as the env var ${NAME}. No secret ever lands in a CLI config, a log, or on disk in plaintext. A CLI you run elsewhere needs the same variable set in your own environment.'
    }),
    el('div', {
      class: 'settings-row-caption',
      text:
        'Honest boundary: any key an MCP server needs is readable by that agent’s process — the same as any env var. Scope servers per workspace so only the agents you intend can reach a given key.'
    }),
    list,
    el('div', { class: 'mgr-form' }, [nameInput, keyInput, saveBtn]),
    note
  ])
  setTimeout(() => void refresh(), 0)
  return block
}

// ── The tool plan: which servers reach a workspace's panes, per CLI (8/09) ───
function createToolPlanBlock(): HTMLElement {
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
      table.append(el('div', { class: 'toolplan-row' }, [el('span', { class: 'toolplan-tool', text: s.label }), ...cells]))
    }
    body.append(table)

    const counts = CLI_ORDER.map((cli) => {
      const n = 1 + servers.filter((s) => !s.builtIn && planHasServerForCli(plan, s.id, cli)).length
      return `${CLI_LABEL[cli]} ${n}`
    })
    body.append(
      el('div', {
        class: 'settings-row-caption toolplan-truth',
        text: `Panes here launch with — ${counts.join(' · ')} — servers (house + plan${plan.inheritGlobal ? ' + global' : ''}). Restart a running pane to apply a change.`
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
  // A plan edit elsewhere (or a fresh launch) re-renders the matrix.
  bridge.on(IntegrationsChannels.planChanged, () => void render())

  const block = el('div', { class: 'trail-block mgr-grants-block' }, [
    el('div', { class: 'settings-row-label', text: 'Workspace tools' }),
    el('div', {
      class: 'settings-row-caption',
      text: 'Which registered servers reach this workspace’s panes, per CLI — so agents carry only the tools the work needs, not everything connected. The house server is always on; “global” tools are inherited only when you turn inheritance on. Scoping is context hygiene, not a permission — grants stay the boundary.'
    }),
    el('div', { class: 'trail-controls' }, [wsSelect]),
    body
  ])
  setTimeout(() => {
    refreshWorkspaces()
    void render()
  }, 0)
  return block
}

export function createIntegrationsSection(): HTMLElement {
  return el('div', { class: 'integrations-section' }, [
    createCatalogBlock(),
    createServersBlock(),
    createServiceKeysBlock(),
    createToolPlanBlock(),
    createGrantsBlock(),
    createActivityBlock()
  ])
}
