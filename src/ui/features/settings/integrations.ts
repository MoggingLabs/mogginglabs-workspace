import {
  IntegrationsChannels,
  type HostedCliId,
  type McpCliStatus,
  type McpServerEntry,
  type TrailEntry,
  type TrailSource,
  type WorkspaceIntegrationsGrant
} from '@contracts'
import { getBridge } from '../../core/ipc/bridge'
import { el } from '../../components'
import { getWorkspaces } from '../../core/workspace/workspace-info-port'
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

// ── Servers: the registry + per-CLI apply surface (8/06) ─────────────────────
function createServersBlock(): HTMLElement {
  const bridge = getBridge()
  const list = el('div', { class: 'mgr-list' })
  const panel = el('div', { class: 'mgr-panel', hidden: true })
  const saveNote = el('div', { class: 'menu-note trail-empty mgr-save-note', hidden: true })

  async function openPanel(server: McpServerEntry, status: McpCliStatus): Promise<void> {
    panel.hidden = false
    panel.innerHTML = ''
    const action = status.state === 'applied' ? 'remove' : 'apply'
    const preview = (await bridge.invoke(IntegrationsChannels.mgrPreview, {
      serverId: server.id,
      cli: status.cli,
      action
    })) as { file: string; block: string; summary: string } | null
    if (!preview) return
    panel.append(el('div', { class: 'mgr-panel-summary', text: preview.summary }))
    if (action === 'apply' && preview.block) {
      const pre = el('pre', { class: 'mgr-panel-block' })
      pre.textContent = preview.block
      panel.append(pre)
    }
    const actions = el('div', { class: 'trail-controls' })
    const doThen = (fn: () => Promise<unknown>) => async (): Promise<void> => {
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
  const envInput = field('Env references', 'env: KEY=${VAR}, comma-separated')
  const saveBtn = el('button', { class: 'trail-btn', type: 'button', text: 'Save server' }) as HTMLButtonElement
  saveBtn.onclick = async (): Promise<void> => {
    const env: Record<string, string> = {}
    for (const pair of envInput.value.split(',').map((s) => s.trim()).filter(Boolean)) {
      const eq = pair.indexOf('=')
      if (eq > 0) env[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim()
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
    saveNote.textContent = r.ok ? 'Saved.' : (r.reason ?? 'refused')
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
        'Register a server once and apply it to each CLI in its own config dialect. Writes are surgical (only our marked entries), backed up first, and only ever on your click — the app never runs, proxies, or authenticates a server, and env values are ${VAR} references, never secrets.'
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

export function createIntegrationsSection(): HTMLElement {
  return el('div', { class: 'integrations-section' }, [createServersBlock(), createGrantsBlock(), createActivityBlock()])
}
