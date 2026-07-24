import {
  AgentChannels,
  ConnectionsChannels,
  IntegrationsChannels,
  planHasServerForCli,
  planSignature,
  toolCellState,
  transportLabel,
  type McpStatusSnapshot,
  type WorkspaceToolPlan,
  type HostedCliId,
  type McpCliStatus,
  type McpPreset,
  type McpServerEntry,
  type WorkspaceIntegrationsGrant
} from '@contracts'
import { getBridge } from '../../core/ipc/bridge'
import { Button, EmptyState, FieldGroup, clear, createCheckbox, createCollapsibleCard, createModal, createToggleRow, el, icon, providerLogo, scrubFields, showToast, submitWithRetain } from '../../components'
import type { CollapsibleCardHandle } from '../../components'
import { getWorkspaces } from '../../core/workspace/workspace-info-port'
import { onToolPlanPanesChange, restartNeededPaneIds } from '../../core/agents/toolplan-panes'
import { requestIntegrationsFocus, takeIntegrationsFocus, type IntegrationsFocus } from '../../core/shell/integrations-focus-port'
import { runIntegrationAuthorization } from './auth-runner'
import { connectedCount, createConnectionsBlock } from './connections'
import { CLI_LABEL, CLI_PROVIDER, HOSTED } from './cli-meta'
import { openLibrary } from './library'

// ── Attention, reported upward (8.5/05) ──────────────────────────────────────
// Four folded Cards now (the store/inventory split, 2026-07-18: browsing —
// catalog grid, registry search, preset import — moved to the Library overlay;
// this page is the INVENTORY plus per-workspace scoping). NOT ONE of this file's
// attention states is knowable at build time — every one arrives from an async
// refresh or a pushed channel. So a section that discovers it needs you says so,
// and the shell puts that on the fold's header, where a collapse cannot bury it.
type SectionId = 'connections' | 'servers' | 'workspace' | 'keys'
interface SectionSignal {
  /** Rendered in the collapsed header. Null clears. */
  chip: Node | null
  /** One-glance number for the overview band. */
  stat: string | null
}
type SignalListener = (id: SectionId, sig: SectionSignal) => void
const signalListeners = new Set<SignalListener>()
const lastSignal = new Map<SectionId, SectionSignal>()
// Dev-gate counters for the status transport contract. They count causes, not rows:
// entering Integrations requests one poll; a resulting push only repaints.
let statusPollRequests = 0
let statusPushPaints = 0

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
 * Settings § Integrations — the INVENTORY (the store/inventory split, 2026-07-18).
 *
 * Three user questions, three cards, in order: what's connected and as whom
 * (Connected accounts), what's on the CLIs (Servers on your CLIs — the registry
 * fanned out per CLI dialect: diff preview, surgical writes, drift chips, and now
 * route badges + per-server key slots), and which workspace carries what
 * (Workspace tools — the plan matrix and the write grant, one card, one picker).
 * The vault stays as an advanced fold: a key is pasted where the server that
 * needs it lives, and the vault list is the audit view, not the front door.
 *
 * BROWSING — the catalog grid, the registry search, the preset import — lives in
 * the Library overlay (library.ts), reachable from the overview band, the empty
 * states, the wizard's Agent-tools step, and the palette. This page manages what
 * you already added; the Library is where you get more. The event bridge
 * (webhooks.ts) and the activity trail (activity.ts) keep their OWN tabs.
 */

// ── Servers: the registry + per-CLI apply surface (8/06) ─────────────────────
function createServersBlock(): SyncedBlock {
  const bridge = getBridge()
  const list = el('div', { class: 'mgr-list' })
  const saveNote = el('div', { class: 'menu-note trail-empty mgr-save-note', role: 'status', attrs: { 'aria-live': 'polite' }, hidden: true })

  // The mgr PANEL died as a surface (phase-tools/06): its preview/write verbs live
  // on each tool's card now, as the Fix flow — one sentence, one primary verb, the
  // diff preview kept as the trust artifact. This card is the read-only audit view:
  // chips state facts in outcome words and act only where acting is honest
  // (needs sign-in → re-authorize). Claude Code is the one CLI whose config health
  // renders this phase; a coming-soon CLI's config trouble must not raise an alarm
  // the user cannot act on, so those chips state the base fact and nothing more.
  const STATE_TEXT: Record<McpCliStatus['state'], string> = {
    'not-applied': 'not set up',
    applied: '✓ on',
    'drift-edited': 'needs fixing',
    'drift-missing': 'gone'
  }
  /** A coming-soon CLI's config trouble, stated as the base fact (see above). */
  const SOFT_STATE_TEXT: Record<McpCliStatus['state'], string> = {
    'not-applied': 'not set up',
    applied: '✓ on',
    'drift-edited': '✓ on',
    'drift-missing': 'not set up'
  }

  const CONN_TEXT: Record<string, string> = { connected: 'working', 'needs-auth': 'needs sign-in', error: 'not working', drift: 'needs fixing', registered: 'saved', off: 'not installed' }
  // Re-authorize (11): run the CLI's catalog-owned OAuth command in a visible
  // plain terminal. A token-configured server routes back to its env reference.
  function runReauthorize(cli: HostedCliId, server: McpServerEntry, cmd: string | null): void {
    if (server.headers && Object.keys(server.headers).length) {
      showToast({
        tone: 'attention',
        title: `${server.label} uses token auth`,
        body: 'Check its Service key or shell environment; there is no browser sign-in for it.'
      })
      return
    }
    if (!cmd) {
      showToast({
        tone: 'danger',
        title: 'No authorization command is available',
        body: `The ${CLI_LABEL[cli]} capability table has no OAuth command.`
      })
      return
    }
    void runIntegrationAuthorization({
      cli,
      cliLabel: CLI_LABEL[cli],
      serverId: server.id,
      serverLabel: server.label,
      command: cmd
    }).then((started) => {
      if (!started.ok) showToast({ tone: 'danger', title: 'Authorization did not start', body: started.reason })
    })
  }

  async function refresh(): Promise<void> {
    let needsAuth = 0
    let needFixing = 0
    let connected = 0
    const servers = (await bridge.invoke(IntegrationsChannels.serversList, undefined)) as McpServerEntry[]
    const snap = ((await bridge.invoke(IntegrationsChannels.statusGet)) as McpStatusSnapshot | null) ?? { statuses: [], at: 0 }
    const conn = new Map(snap.statuses.map((s) => [`${s.serverId}:${s.cli}`, s.state]))
    const caps = ((await bridge.invoke(IntegrationsChannels.catCapabilities)) as { cli: HostedCliId; authorizeCommand: string | null }[]) ?? []
    // The vault's saved names — so a server that needs ${VAR} can say, on its own
    // row, whether that key exists yet. The key lives with the thing it unlocks;
    // the vault fold below stays the audit view.
    let keyNames = new Set<string>()
    try {
      keyNames = new Set(((await bridge.invoke(IntegrationsChannels.serviceKeyList)) as string[]) ?? [])
    } catch {
      /* vault unavailable — chips render as unknown-free rows */
    }
    clear(list)
    for (const server of servers) {
      const statuses = (await bridge.invoke(IntegrationsChannels.mgrStatus, server.id)) as McpCliStatus[]
      const chips = statuses.map((s) => {
        // The pushed connection state (11) is the LIVE truth when applied. A
        // coming-soon CLI never wears an alarm here (phase-tools/06): its drift is
        // detected backend-side and surfaces nowhere the user cannot act.
        const claudeCode = s.cli === 'claude-code'
        const cs = conn.get(`${server.id}:${s.cli}`)
        const rawLive = cs && cs !== 'registered' && cs !== 'off' ? cs : null
        const live = rawLive === 'drift' && !claudeCode ? null : rawLive
        const cls = live ?? s.state
        if (cls === 'needs-auth') needsAuth++
        else if (claudeCode && (cls === 'drift' || cls === 'drift-edited' || cls === 'drift-missing')) needFixing++
        else if (cls === 'connected' || cls === 'applied') connected++
        const stateText = claudeCode ? STATE_TEXT[s.state] : SOFT_STATE_TEXT[s.state]
        const label = s.installed ? (live ? CONN_TEXT[live] : stateText) : 'not installed'
        if (live === 'needs-auth') {
          const cmd = caps.find((c) => c.cli === s.cli)?.authorizeCommand ?? null
          const chip = el('button', {
            class: `mgr-chip is-${cls}${s.installed ? '' : ' is-uninstalled'}`,
            type: 'button',
            text: `${CLI_LABEL[s.cli]} · ${label}`
          }) as HTMLButtonElement
          chip.title = s.file
          chip.onclick = (): void => runReauthorize(s.cli, server, cmd)
          return chip
        }
        // A FACT, not a verb: the mgr panel died as a surface — fixing lives on the
        // tool's own card. Same class (SETINTEG's hit-target math keys on it).
        const chip = el('span', {
          class: `mgr-chip is-${cls}${s.installed ? '' : ' is-uninstalled'}`,
          text: `${CLI_LABEL[s.cli]} · ${label}`
        })
        chip.title = s.file
        return chip
      })
      // Route honesty (the merged-inventory rule): a row must say WHO holds its
      // auth, because "connected" is proven on one route and only configured on
      // the other. Built-in = the house server; a bridge command = an app-held
      // account connection (ADR 0014); anything else = the CLI owns its auth.
      const viaConnection = !server.builtIn && !!server.command?.includes('mogging-connection')
      const routeBadge = server.builtIn
        ? el('span', { class: 'mgr-route is-house', text: 'house' })
        : viaConnection
          ? el('span', { class: 'mgr-route is-app', text: 'via your account', title: 'This server rides an app-held connection — see Connected accounts above. No credential lives in any CLI config.' })
          : el('span', { class: 'mgr-route is-cli', text: 'CLI-owned auth', title: 'Each CLI holds its own credential for this server; the app brokers nothing on this route.' })
      // Key slots, on the row that needs them: every ${VAR} this server references,
      // with its vault state. A missing key gets its paste field HERE — the user
      // should never have to learn the vault before the server that needs it.
      const neededVars = [...new Set(
        [...Object.values(server.env ?? {}), ...Object.values(server.headers ?? {})]
          .flatMap((v) => [...String(v).matchAll(/\$\{([A-Z0-9_]+)\}/g)].map((m) => m[1]))
      )]
      const keyBits: HTMLElement[] = []
      const keyFormHost = el('div', { class: 'mgr-keyslot-form-host' })
      for (const name of neededVars) {
        const saved = keyNames.has(name)
        if (saved) {
          keyBits.push(el('span', { class: 'mgr-keyslot is-saved', text: `\${${name}} · saved`, title: 'Encrypted by your OS keychain; reaches agents as this env var at launch.' }))
          continue
        }
        const add = el('button', { class: 'mgr-keyslot is-missing', type: 'button', text: `\${${name}} · add key…` }) as HTMLButtonElement
        add.onclick = (): void => {
          clear(keyFormHost)
          const input = el('input', { class: 'browser-sites-input mgr-input', placeholder: `paste the ${name} value…` }) as HTMLInputElement
          input.type = 'password'
          input.setAttribute('aria-label', `${name} key value`)
          input.addEventListener('keydown', (e) => e.stopPropagation())
          const save = el('button', { class: 'trail-btn', type: 'button', text: 'Save to vault' }) as HTMLButtonElement
          const slotNote = el('div', { class: 'settings-error mgr-note', role: 'alert', hidden: true })
          save.onclick = (): void => {
            if (!input.value) return
            void submitWithRetain({
              trigger: save,
              retainFields: [input],
              errorEl: slotNote,
              submit: () =>
                bridge.invoke(IntegrationsChannels.serviceKeySet, { name, value: input.value }) as Promise<{ ok: boolean; reason?: string }>,
              onSuccess: async () => {
                clear(keyFormHost)
                await refresh()
              }
            })
          }
          const cancel = el('button', { class: 'trail-btn cat-mini', type: 'button', text: 'Cancel' }) as HTMLButtonElement
          cancel.onclick = (): void => {
            scrubFields(input)
            clear(keyFormHost)
          }
          keyFormHost.append(el('div', { class: 'mgr-form' }, [input, el('div', { class: 'trail-controls' }, [save, cancel]), slotNote]))
          input.focus()
        }
        keyBits.push(add)
      }
      const row = el('div', { class: 'mgr-row' }, [
        el('span', { class: 'mgr-label' }, [providerLogo(server.id, 14), el('span', { text: server.label })]),
        routeBadge,
        el('span', {
          class: 'mgr-id',
          text: `${server.id} · ${transportLabel(server)}`,
          // The tag is the ENDPOINT scheme, not the wire keyword: a bare "http" next to a
          // server name read as an insecure connection when the endpoint is https. The
          // title carries the precise transport for anyone who wants it.
          attrs: { title: server.transport === 'http' ? 'Streamable-HTTP MCP transport' : 'stdio transport — a local subprocess' }
        }),
        ...(keyBits.length ? [el('span', { class: 'mgr-keyslots' }, keyBits)] : []),
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
      if (neededVars.length) list.append(keyFormHost)
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
            title: 'Only the built-in tools so far',
            body: 'Browse the Library to add your first tool — connect an account once, or give a CLI its own copy.'
          })
        ])
      )
    }
    signal('servers', {
      chip: needsAuth ? attnChip('needs-auth', `${needsAuth} need sign-in`) : needFixing ? attnChip('drift', `${needFixing} need fixing`) : null,
      stat: `${connected} connected`
    })
  }

  // Add-server form (env values are ${VAR} references; a literal is vaulted, never written).
  const addToggle = el('button', {
    class: 'trail-btn',
    type: 'button',
    text: 'Add server…',
    dataset: { mgrAction: 'add-server' }
  }) as HTMLButtonElement
  const statusRefreshBtn = el('button', {
    class: 'trail-btn',
    type: 'button',
    text: 'Refresh connection status',
    attrs: { 'data-mcp-status-refresh': 'true' }
  }) as HTMLButtonElement
  const requestStatusRefresh = async (): Promise<void> => {
    if (statusRefreshBtn.disabled) return
    statusPollRequests++
    statusRefreshBtn.disabled = true
    try {
      await bridge.invoke(IntegrationsChannels.statusRefresh)
    } catch (error) {
      showToast({
        tone: 'danger',
        title: 'Could not refresh connection status',
        body: error instanceof Error ? error.message : String(error)
      })
    } finally {
      statusRefreshBtn.disabled = false
    }
  }
  statusRefreshBtn.onclick = (): void => void requestStatusRefresh()
  const form = el('div', { class: 'mgr-form', hidden: true, dataset: { mgrForm: 'add-server' } })
  const field = (label: string, placeholder: string, hook: string): HTMLInputElement => {
    const input = el('input', { class: 'browser-sites-input mgr-input', dataset: { mgrField: hook } }) as HTMLInputElement
    input.placeholder = placeholder
    input.setAttribute('aria-label', label)
    input.spellcheck = false
    input.addEventListener('keydown', (e) => e.stopPropagation())
    return input
  }
  const idInput = field('Server id', 'id (e.g. sentry)', 'id')
  const labelInput = field('Label', 'Label', 'label')
  const transportSel = el('select', { class: 'trail-select' }) as HTMLSelectElement
  transportSel.append(el('option', { value: 'stdio', text: 'stdio' }), el('option', { value: 'http', text: 'http' }))
  const commandInput = field('Command', 'command (stdio)', 'command')
  const argsInput = field('Arguments', 'args (space-separated; quote nothing)', 'args')
  const urlInput = field('URL', 'https://… (http transport)', 'url')
  // The one SECRET-bearing field on this form: `KEY=<literal>` is a key value, typed once.
  const envInput = field('Env references', 'env: KEY=${VAR} (or paste a key value — it’s vaulted), comma-separated', 'env')
  const formFields = [idInput, labelInput, commandInput, argsInput, urlInput]
  const saveBtn = el('button', {
    class: 'trail-btn',
    type: 'button',
    text: 'Save server',
    dataset: { mgrAction: 'save-server' }
  }) as HTMLButtonElement
  saveBtn.onclick = (): void => {
    // Hoisted OUT of submit() so a THROWN failure can still be compensated: a `vaulted`
    // living inside the submit closure dies with the stack that threw, and the literals it
    // had already written would stay in the vault with nothing left to name them.
    const vaulted: string[] = []
    void submitWithRetain<{ ok: boolean; reason?: string; vaulted: string[] }>({
      trigger: saveBtn,
      // envInput may hold `POSTHOG_API_KEY=phc_live…` — a real key, pasted once. It is
      // retained on every refusal and scrubbed only when the server is really registered.
      retainFields: [envInput],
      clearFields: formFields,
      errorEl: saveNote,
      submit: async () => {
        const env: Record<string, string> = {}
        for (const pair of envInput.value.split(',').map((s) => s.trim()).filter(Boolean)) {
          const eq = pair.indexOf('=')
          if (eq <= 0) continue
          const k = pair.slice(0, eq).trim()
          const v = pair.slice(eq + 1).trim()
          if (v.includes('${')) {
            env[k] = v // already an env/vault reference — kept as-is
            continue
          }
          // 8/08: a literal is OFFERED the vault (not refused outright) — paste once, store
          // as ciphertext, and the config keeps only the ${NAME}. Each pair is a SEPARATE
          // vault write, so a refusal here (or at serversSave below) lands mid-transaction:
          // `vaulted` is the ledger onFailure needs to undo the writes that did land.
          const r = (await bridge.invoke(IntegrationsChannels.serviceKeySet, { name: k, value: v })) as { ok: boolean; reason?: string }
          if (!r.ok) return { ok: false, reason: r.reason ?? 'refused', vaulted }
          env[k] = `\${${k}}`
          vaulted.push(k)
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
        return { ok: r.ok, reason: r.reason, vaulted }
      },
      onSuccess: async (r) => {
        saveNote.textContent = r.vaulted.length
          ? `Saved. ${r.vaulted.join(', ')} stored in the vault — the config references \${${r.vaulted[0]}}, never the value.`
          : 'Saved.'
        saveNote.hidden = false
        form.hidden = true
        await refresh()
      },
      onFailure: async () => {
        // ROLLBACK — the orphan bug. serversSave never touches the vault, so a register that
        // refuses AFTER the literals were vaulted (a bad id, a store not ready) used to leave
        // them there FOREVER: secrets the user never chose to store, under names they never
        // chose to keep, invisible from this form and silently overwritten by the next retry.
        // Best-effort per name: one failing clear must not strand the rest.
        for (const name of vaulted) {
          try {
            await bridge.invoke(IntegrationsChannels.serviceKeyClear, name)
          } catch {
            /* the refusal is already on screen; a stranded name must not also throw here */
          }
        }
      }
    })
  }
  // F-34's sibling: the add-server fields were placeholder-labeled too. Visible
  // labels via FieldGroup — the data-mgr-* hooks and classes stay (SECRETFORMS).
  form.append(
    el('div', { class: 'wh-form-grid' }, [
      FieldGroup({ label: 'Server id', hint: 'e.g. sentry — the registry key.' }, idInput),
      FieldGroup({ label: 'Label' }, labelInput),
      FieldGroup({ label: 'Transport' }, transportSel),
      FieldGroup({ label: 'Command', hint: 'stdio transport.' }, commandInput),
      FieldGroup({ label: 'Arguments', hint: 'Space-separated; quote nothing.' }, argsInput),
      FieldGroup({ label: 'URL', hint: 'http transport.' }, urlInput),
      FieldGroup({ label: 'Env', hint: 'KEY=${VAR} references, comma-separated — paste a literal value and it’s vaulted.' }, envInput)
    ]),
    el('div', { class: 'wh-form-actions' }, [el('span', { class: 'ph-spacer' }), saveBtn])
  )
  addToggle.onclick = (): void => {
    form.hidden = !form.hidden
    // Collapsing is a CANCEL, and this form is only display-toggled — the node survives. A
    // half-typed `KEY=secret` would otherwise sit in a live input for the rest of the session
    // and reappear, verbatim, on the next open (in any workspace). Scrub on the way out.
    if (form.hidden) scrubFields(envInput, ...formFields)
  }

  const block = el('div', { class: 'trail-block mgr-block' }, [
    el('div', { class: 'settings-row-caption', text: 'Every server your CLIs know about, with who holds its auth: “via your account” rides an app-held connection (its config entry is a command — no credential in any CLI file); “CLI-owned auth” means that CLI authenticates itself. A tool whose Claude Code config needs fixing says so on its own card above — with a Fix button, a preview of the change, and a backup taken first; nothing is ever written without your click. A ${VAR} key slot on a row is pasted right there and vaulted — never written as a literal. Add more from the Library.' }),
    list,
    el('div', { class: 'trail-controls' }, [statusRefreshBtn, addToggle]),
    form,
    saveNote
  ])
  // A push repaints from the snapshot already produced by main. It must never request another
  // poll: request -> push -> request was an unbounded subprocess/IPC feedback loop.
  bridge.on(IntegrationsChannels.statusChanged, () => {
    statusPushPaints++
    void refresh()
  })
  return {
    block,
    sync: () => {
      // Exactly one on-demand poll when the Integrations page is entered. The resulting push
      // only repaints via the listener above.
      void requestStatusRefresh()
      void refresh()
    }
  }
}

// ── Workspace tools: ONE card for "which workspace gets what" ────────────────
// The store/inventory split's third question. Tool plans (8/09) and the write
// grant (8/03) were two sibling folds with two workspace pickers asking two
// halves of one question — merged: one picker, the plan chips (with the per-CLI
// matrix as the advanced detail), and the write-grant switch right under the
// tools it gates. The grant object also carries `web` + `actOrigins`, but those
// are a BROWSER boundary: their editor stays on Trust › Browser (act-origins.ts)
// and this card patches only `writeTools` — no field fought over.
function createWorkspaceToolsBlock(): SyncedBlock {
  const bridge = getBridge()
  const wsSelect = el('select', { class: 'trail-select' }) as HTMLSelectElement
  wsSelect.setAttribute('aria-label', 'Workspace')
  const toolsBody = el('div', { class: 'mgr-grant-body' })
  const grantBody = el('div', { class: 'mgr-grant-body' })
  let renderGeneration = 0
  /** The advanced per-CLI fold survives repaints: closing it on every mutation
   *  would make the matrix unusable. */
  let advancedOpen = false

  async function render(): Promise<void> {
    const generation = ++renderGeneration
    const wsId = wsSelect.value
    clear(toolsBody)
    clear(grantBody)
    if (!wsId) {
      // F-38: never a dead empty picker — say why there is nothing to scope.
      toolsBody.append(el('div', { class: 'menu-note', text: 'No workspace open — tools are scoped per workspace. Create or open one, then decide here.' }))
      return
    }
    const plan = (await bridge.invoke(IntegrationsChannels.planGet, wsId)) as WorkspaceToolPlan
    const servers = ((await bridge.invoke(IntegrationsChannels.serversList)) as McpServerEntry[]) ?? []
    const globalFor = new Map<string, Set<HostedCliId>>()
    for (const s of servers) {
      const statuses = ((await bridge.invoke(IntegrationsChannels.mgrStatus, s.id)) as McpCliStatus[]) ?? []
      globalFor.set(s.id, new Set(statuses.filter((x) => x.state === 'applied').map((x) => x.cli)))
    }
    let grant: WorkspaceIntegrationsGrant | null = null
    try {
      grant = (await bridge.invoke(IntegrationsChannels.grantGet, wsId)) as WorkspaceIntegrationsGrant
    } catch {
      /* grant unavailable — the grant sub-block says so below */
    }
    if (generation !== renderGeneration || wsSelect.value !== wsId) return

    const mutatePlan = async (mutation: Record<string, unknown>, button: HTMLButtonElement): Promise<void> => {
      button.disabled = true
      button.setAttribute('aria-busy', 'true')
      try {
        await bridge.invoke(IntegrationsChannels.planMutate, { workspaceId: wsId, ...mutation })
        if (wsSelect.value === wsId) await render()
      } catch (error) {
        showToast({ tone: 'danger', title: 'Tool plan was not changed', body: String(error) })
      } finally {
        if (button.isConnected) {
          button.disabled = false
          button.removeAttribute('aria-busy')
        }
      }
    }

    // ── The primary control: one chip per tool, on/off for the whole workspace.
    // The per-CLI matrix below is the precision instrument; most decisions are
    // "does this workspace use Sentry?", not "…on Codex but not Gemini?".
    const pickable = servers.filter((s) => !s.builtIn)
    const chipsRow = el('div', { class: 'wstool-chips' })
    for (const s of pickable) {
      const onCount = HOSTED.filter((cli) => planHasServerForCli(plan, s.id, cli)).length
      const state = onCount === HOSTED.length ? 'on' : onCount > 0 ? 'partial' : 'off'
      const chip = el(
        'button',
        {
          class: `wstool-chip${state === 'on' ? ' is-on' : state === 'partial' ? ' is-partial' : ''}`,
          type: 'button',
          ariaLabel: `${s.label} in this workspace: ${state === 'partial' ? 'some CLIs' : state}`,
          title: state === 'partial' ? 'On for some CLIs — open the per-CLI detail below' : undefined
        },
        [providerLogo(s.id, 12), el('span', { text: s.label }), ...(state === 'partial' ? [el('span', { class: 'wstool-chip-note', text: 'some CLIs' })] : [])]
      ) as HTMLButtonElement
      chip.setAttribute('aria-pressed', String(state !== 'off'))
      chip.onclick = (): void => {
        const enabled = state !== 'on' // partial or off -> everything on; on -> everything off
        chip.disabled = true
        chip.setAttribute('aria-busy', 'true')
        void (async () => {
          try {
            for (const cli of HOSTED) {
              await bridge.invoke(IntegrationsChannels.planMutate, { workspaceId: wsId, kind: 'cell', serverId: s.id, cli, enabled })
            }
            if (wsSelect.value === wsId) await render()
          } catch (error) {
            showToast({ tone: 'danger', title: 'Tool plan was not changed', body: String(error) })
          } finally {
            if (chip.isConnected) {
              chip.disabled = false
              chip.removeAttribute('aria-busy')
            }
          }
        })()
      }
      chipsRow.append(chip)
    }
    toolsBody.append(el('div', { class: 'settings-row-caption', text: 'The built-in tools are always on. Toggle a tool for this workspace’s agents:' }), chipsRow)
    // The tools empty state (8/13): explain plans in one sentence — and point at
    // the Library, where the first tool actually comes from.
    if (pickable.length === 0) {
      toolsBody.append(el('div', { class: 'menu-note toolplan-empty', text: 'A plan decides which tools reach this workspace’s agents — minimal by default, so panes carry only what the work needs. Browse the Library to connect a tool, then turn it on here.' }))
      const browse = Button({ label: 'Browse the Library', icon: 'plug', variant: 'ghost', onClick: () => openLibrary({ onClose: () => void render() }) })
      toolsBody.append(el('div', { class: 'trail-controls' }, [browse]))
    }

    // F-25 sibling: "Inherit global tools" stays a switch — state, never a verb.
    const inheritToggle = createToggleRow({
      label: 'Inherit global (“everywhere”) tools',
      hint: 'On: tools set up at the global (everywhere) tier reach this workspace too. Off: panes carry only this plan.',
      checked: plan.inheritGlobal,
      onChange: () => {
        const next = inheritToggle.checked()
        inheritToggle.setDisabled(true)
        inheritToggle.input.setAttribute('aria-busy', 'true')
        void (async () => {
          try {
            await bridge.invoke(IntegrationsChannels.planMutate, { workspaceId: wsId, kind: 'inherit', value: next })
            if (wsSelect.value === wsId) await render()
          } catch (error) {
            inheritToggle.setChecked(!next)
            showToast({ tone: 'danger', title: 'Tool plan was not changed', body: String(error) })
          } finally {
            if (inheritToggle.input.isConnected) {
              inheritToggle.setDisabled(false)
              inheritToggle.input.removeAttribute('aria-busy')
            }
          }
        })()
      }
    })

    // ── The per-CLI matrix — the advanced detail, folded by default. Nothing
    // was removed: every cell, every state, exactly the 8/09 surface, one
    // <details> down so the common case reads as chips, not a table.
    const table = el('div', { class: 'toolplan-matrix' })
    table.append(
      el('div', { class: 'toolplan-row toolplan-head' }, [
        el('span', { class: 'toolplan-tool', text: 'Tool' }),
        ...HOSTED.map((c) => el('span', { class: 'toolplan-cell-head', text: CLI_LABEL[c] }))
      ])
    )
    for (const s of servers) {
      const cells = HOSTED.map((cli) => {
        if (s.builtIn) return el('span', { class: 'toolplan-cell is-locked', text: 'always', title: 'The built-in tools are always available' })
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
          void mutatePlan({ kind: 'cell', serverId: s.id, cli, enabled: state !== 'planned' }, cell)
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
    const advanced = el('details', { class: 'toolplan-advanced' }, [
      el('summary', { class: 'toolplan-advanced-summary', text: 'Per-CLI detail' }),
      table
    ]) as HTMLDetailsElement
    advanced.open = advancedOpen
    advanced.addEventListener('toggle', () => {
      advancedOpen = advanced.open
    })
    toolsBody.append(inheritToggle.el, advanced)

    const counts = HOSTED.map((cli) => {
      const n = 1 + servers.filter((s) => !s.builtIn && planHasServerForCli(plan, s.id, cli)).length
      return `${CLI_LABEL[cli]} ${n}`
    })
    const pending = restartNeededPaneIds(wsId, planSignature(plan)).length
    signal('workspace', {
      chip: pending ? attnChip('pending', `${pending} pane${pending === 1 ? '' : 's'} to restart`) : null,
      stat: counts.join(' · ')
    })
    toolsBody.append(
      el('div', {
        class: 'settings-row-caption toolplan-truth',
        text:
          `Panes here launch with — ${counts.join(' · ')} — tools (built-in + plan${plan.inheritGlobal ? ' + global' : ''}).` +
          (pending ? ` ${pending} live pane${pending === 1 ? '' : 's'} pick this up on restart.` : '')
      })
    )

    // ── The write grant, right under the tools it gates (8/03). F-25: a switch
    // states the setting and never moves its label. Same single-fire contract
    // (MUTATIONRACE asserts it): disabled + aria-busy across the round-trip,
    // reverted on failure, truth re-rendered on success.
    if (!grant) {
      grantBody.append(el('div', { class: 'menu-note', text: 'Grant state is unavailable for this workspace.' }))
      return
    }
    const grantTruth = grant
    const writeToggle = createToggleRow({
      label: 'Allow write tools in this workspace',
      hint: 'Off by default. On: agents here can send, mail, claim, update cards, and edit code symbols in their own checkout through connected tools.',
      checked: grantTruth.writeTools === 'all',
      onChange: () => {
        const next = writeToggle.checked()
        writeToggle.setDisabled(true)
        writeToggle.input.setAttribute('aria-busy', 'true')
        void (async () => {
          try {
            await bridge.invoke(IntegrationsChannels.grantMutate, {
              workspaceId: wsId,
              field: 'writeTools',
              value: next ? 'all' : 'none'
            })
            if (wsSelect.value === wsId) await render()
          } catch (error) {
            writeToggle.setChecked(!next) // put the switch back where the truth is
            showToast({ tone: 'danger', title: 'Write-tool permission was not changed', body: String(error) })
          } finally {
            if (writeToggle.input.isConnected) {
              writeToggle.setDisabled(false)
              writeToggle.input.removeAttribute('aria-busy')
            }
          }
        })()
      }
    })
    grantBody.append(writeToggle.el)
  }

  function refreshWorkspaces(): void {
    const current = wsSelect.value
    clear(wsSelect)
    for (const w of getWorkspaces().workspaces) wsSelect.append(el('option', { value: w.id, text: w.name }))
    wsSelect.value = current || (getWorkspaces().activeId ?? '')
    if (!wsSelect.value && wsSelect.options.length) wsSelect.selectedIndex = 0
    wsSelect.hidden = !wsSelect.options.length // an empty picker is a stub, not a control (F-38)
  }
  wsSelect.onchange = (): void => void render()
  // A plan edit -> re-render + nudge any live panes that now need a restart.
  bridge.on(IntegrationsChannels.planChanged, (payload) => {
    const p = payload as WorkspaceToolPlan
    const stale = restartNeededPaneIds(p.workspaceId, planSignature(p)).length
    if (stale) {
      showToast({ title: 'Tool plan changed', body: `${stale} live pane${stale === 1 ? '' : 's'} pick this up on restart`, tone: 'info', timeout: 6000 })
    }
    void render()
  })
  // A launch/close changes the live-pane set -> refresh the pending count.
  onToolPlanPanesChange(() => void render())

  // TWO sub-blocks, deliberately: the mgr-grants-block + caption text pairs are
  // the MUTATIONRACE smoke's anchors, and each sub-block's first switch is the
  // one that smoke clicks. One card, one picker, two honest captions.
  const toolsSub = el('div', { class: 'trail-block mgr-grants-block' }, [
    el('div', { class: 'settings-row-caption', text: 'Which of your tools reach this workspace’s panes, per CLI — so agents carry only what the work needs, not everything connected. Scoping is context hygiene, not a permission — the write grant below stays the boundary.' }),
    toolsBody
  ])
  const grantSub = el('div', { class: 'trail-block mgr-grants-block' }, [
    el('div', { class: 'settings-row-caption', text: 'Per workspace, default closed: which write tools agents get. The reviewer gate stays the boundary — approve is never a tool. Which ORIGINS agents may act on is a browser boundary: Trust › Browser.' }),
    grantBody
  ])
  const block = el('div', { class: 'trail-block wstool-block' }, [
    el('div', { class: 'trail-controls' }, [wsSelect]),
    toolsSub,
    grantSub
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
  const nameInput = el('input', {
    class: 'browser-sites-input mgr-input',
    placeholder: 'ENV NAME (e.g. POSTHOG_API_KEY)',
    dataset: { mgrField: 'key-name' }
  }) as HTMLInputElement
  nameInput.spellcheck = false
  nameInput.addEventListener('keydown', (e) => e.stopPropagation())
  const keyInput = el('input', {
    class: 'browser-sites-input mgr-input',
    placeholder: 'paste key value…',
    dataset: { mgrField: 'key-value' }
  }) as HTMLInputElement
  keyInput.type = 'password'
  keyInput.addEventListener('keydown', (e) => e.stopPropagation())
  const saveBtn = el('button', {
    class: 'trail-btn',
    type: 'button',
    text: 'Save key to vault',
    dataset: { mgrAction: 'save-key' }
  }) as HTMLButtonElement
  const note = el('div', { class: 'settings-error mgr-note', role: 'alert', hidden: true })

  async function refresh(): Promise<void> {
    const names = ((await bridge.invoke(IntegrationsChannels.serviceKeyList)) as string[]) ?? []
    clear(list)
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
      // F-24: one value grammar across the band — numerals always, unit always.
      stat: `${names.length} saved`
    })
  }

  saveBtn.onclick = (): void => {
    const name = nameInput.value.trim()
    const value = keyInput.value
    if (!name || !value) return
    // The secret used to leave the DOM BEFORE the round trip — and `serviceKeySet` refuses
    // for reasons the user can fix and retry: a name that isn't SHOUTY_SNAKE, a settings
    // store not up yet, a locked keychain. Each refusal ate a key that was pasted once and
    // exists nowhere else. It now leaves only when the vault says it holds the ciphertext.
    void submitWithRetain({
      trigger: saveBtn,
      retainFields: [keyInput],
      clearFields: [nameInput],
      errorEl: note,
      submit: () =>
        bridge.invoke(IntegrationsChannels.serviceKeySet, { name, value }) as Promise<{ ok: boolean; reason?: string }>,
      onSuccess: () => refresh()
    })
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

    if (!detected.length) {
      body.append(el('div', { class: 'settings-row-caption', text: 'Install a coding-agent CLI (Claude Code, Codex, or Gemini) first — then come back and we’ll wire your tools to it.' }))
      modal.setFooter(el('div', { class: 'confirm-actions' }, [Button({ label: 'Close', variant: 'ghost', onClick: () => modal.close() })]))
      return
    }

    // F-23: pick first, then walk ONLY the picked. The old flow marched every preset
    // one modal at a time — a three-tool stack meant Skip ×25 — with no sense of how
    // much was left. Same write path (catConnect), same done-marks, same end screen.
    let queue: McpPreset[] = []
    let total = 0

    const showDone = (): void => {
      body.replaceChildren(
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
    }

    const step = (): void => {
      const next = queue.shift()
      if (!next) {
        showDone()
        return
      }
      const at = total - queue.length
      const note = el('div', { class: 'settings-error', role: 'alert', hidden: true })
      body.replaceChildren(
        el('div', { class: 'integux-flow-tool', attrs: { 'data-preset': next.id } }, [
          el('div', { class: 'settings-row-caption integux-flow-progress', text: `${at} of ${total}` }),
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

    const showPick = (): void => {
      const done = flowDone()
      const remaining = presets.filter((p) => !done.includes(p.id))
      if (!remaining.length) {
        showDone()
        return
      }
      const boxes = new Map<string, ReturnType<typeof createCheckbox>>()
      body.replaceChildren(
        el('div', { class: 'settings-row-label', text: 'Which tools do you use?' }),
        el('div', {
          class: 'settings-row-caption',
          text: `Pick what to connect — each one wires into ${detected.map((c) => CLI_LABEL[c]).join(', ')}. Come back for the rest any time.`
        }),
        el('div', { class: 'integux-flow-pick' }, remaining.map((p) => {
          const cb = createCheckbox({ label: p.label })
          cb.el.classList.add('integux-pick-item')
          boxes.set(p.id, cb)
          return cb.el
        }))
      )
      const start = Button({
        label: 'Connect selected',
        variant: 'primary',
        onClick: () => {
          queue = remaining.filter((p) => boxes.get(p.id)?.checked())
          if (!queue.length) return
          total = queue.length
          step()
        }
      })
      start.dataset.flowAction = 'start'
      modal.setFooter(
        el('div', { class: 'confirm-actions' }, [
          Button({ label: 'Close', variant: 'ghost', onClick: () => modal.close() }),
          start
        ])
      )
    }

    showPick()
  })()
}

// The overview band (8.5/05). Not a Card and never folded: it is the one thing on
// this page that answers "is anything wrong?" without opening anything. Its three
// stats are fed by `onSignal` — nothing here is knowable at build time.
function createIntegrationsIntro(): HTMLElement {
  // The Library is the front door now (the store/inventory split): browsing and
  // connecting live there; this page manages what you already added. The guided
  // flow keeps its CTA — it is the "walk me through it" on-ramp, not a duplicate.
  const browse = Button({ label: 'Browse the Library', icon: 'plug', variant: 'primary', onClick: () => openLibrary({ onClose: () => enterIntegrations() }) })
  browse.classList.add('integux-library-cta')
  const setup = Button({ label: 'Set up integrations…', icon: 'sparkles', variant: 'ghost', onClick: () => openGuidedFlow() })
  setup.classList.add('integux-setup-cta')

  const stat = (label: string): { el: HTMLElement; set: (v: string) => void } => {
    const value = el('span', { class: 'integux-stat-value', text: '—' })
    return {
      el: el('div', { class: 'integux-stat' }, [el('span', { class: 'integux-stat-label', text: label }), value]),
      set: (v) => (value.textContent = v)
    }
  }
  const connections = stat('Connections')
  const servers = stat('Servers')
  const keys = stat('Service keys')
  const setters: Partial<Record<SectionId, (v: string) => void>> = {
    connections: connections.set,
    servers: servers.set,
    keys: keys.set
  }
  onSignal((id, sig) => {
    if (sig.stat) setters[id]?.(sig.stat)
  })

  return el('div', { class: 'trail-block integux-intro' }, [
    el('div', { class: 'settings-row-label', text: 'Connect your stack' }),
    el('div', {
      class: 'settings-row-caption',
      text:
        'Browse the Library to connect a service once — sign-in happens in your own browser, the credential is encrypted by your OS keychain and never written into a CLI’s config, and every agent you launch can use it. This page is what you HAVE: your connected accounts, the tools on your CLIs, and which workspace carries what.'
    }),
    el('div', { class: 'integux-stats' }, [connections.el, servers.el, keys.el]),
    el('div', { class: 'trail-controls' }, [browse, setup])
  ])
}

// The in-app privacy block (the usage-tab pattern) — the custody rule in user
// words + the docs/14 pointer.
function createIntegrationsPrivacy(): HTMLElement {
  return el('div', { class: 'trail-block integux-privacy' }, [
    el('div', { class: 'settings-row-label', text: 'What the app can and can’t see' }),
    el('div', { class: 'settings-note' }, [
      icon('check-circle', 14),
      // Say the true thing, including the uncomfortable half. The app now HOLDS
      // OAuth grants — pretending otherwise would be the one unforgivable line on
      // this page, and the wording gate (scripts/check-credential-wording.mjs)
      // exists precisely to stop a comforting lie from creeping back in.
      el('span', {
        text:
          'When you connect a tool here, this app holds that connection: sign-in runs entirely on this machine, and the OAuth token is encrypted by your OS keychain and never leaves it — not to us, not into a CLI’s config file, not into a log or telemetry. Your agents reach the tool through the app, so a connected account is reachable by any agent whose workspace plan includes it — scope deliberately, and disconnect here to delete the credential. Provider LOGINS (Claude, Codex, Gemini) are still never brokered: those CLIs sign in as themselves, as they always have (ADR 0002). Repo names, tool lists, and titles stay in the app: telemetry is counts and booleans only (docs/14).'
      })
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
    // Trigger 2 of the status engine (phase-tools/03): entering Integrations requests
    // exactly ONE verification sweep — same coalescing as the syncs, same request→
    // push→repaint contract as the status poll above (results land over `changed`).
    void getBridge().invoke(ConnectionsChannels.verifySweep)
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

  const connectionsBlock = createConnectionsBlock({
    browse: false, // the INVENTORY: browsing/connecting lives in the Library
    onBrowse: () => openLibrary({ onClose: () => enterIntegrations() }),
    workspaceScoping: true,
    onChange: (cs) => {
      const live = connectedCount(cs)
      const broken = cs.filter((c) => c.state === 'expired' || c.state === 'error').length
      signal('connections', {
        // An expired grant is the one thing here that silently stops an agent's tools
        // working, so it must reach the fold's header even when the card is collapsed.
        chip: broken ? attnChip('needs-auth', `${broken} need${broken === 1 ? 's' : ''} you`) : null,
        // F-24: one value grammar across the band — numerals always, unit always.
        stat: `${live} connected`
      })
    }
  })
  const serversBlock = createServersBlock()
  const workspaceBlock = createWorkspaceToolsBlock()
  const keysBlock = createServiceKeysBlock()
  const card = (
    id: SectionId,
    title: string,
    caption: string | Node,
    body: HTMLElement,
    o: { defaultOpen?: boolean; attentionOpens?: boolean; class?: string } = {}
  ): CollapsibleCardHandle =>
    createCollapsibleCard({ id, title, caption, storagePrefix: 'integrations', ...o }, [body])

  // The user's three questions, in order (the store/inventory split): what's
  // connected and as whom · what's on the CLIs · which workspace gets what. The
  // vault closes the page as the advanced audit view — a key is normally pasted
  // on the row (or card) that needs it. Browsing lives in the Library overlay.
  // One line each on a fold — the full paragraph lives at the top of each body.
  const connections = card(
    'connections',
    'Connected accounts',
    'What you’ve connected, and as whom. Add more from the Library.',
    connectionsBlock.block,
    { defaultOpen: true, attentionOpens: true }
  )
  const servers = card('servers', 'On your CLIs (advanced)', 'Everything your CLIs carry, and who holds its auth. A tool that needs fixing says so on its card above; writes are surgical, backed up, and only on your click.', serversBlock.block)
  // Shrunk to the POWER-USER view (phase-tools/05): everyday scoping happens on
  // each tool's own card above; this card keeps the matrix and the write grant.
  const workspace = card('workspace', 'Workspace tools', 'The power-user matrix: which tools each workspace’s agents carry, per CLI, and whether they may write. Everyday scoping lives on each tool’s card above.', workspaceBlock.block)
  const keys = card('keys', 'Service keys (advanced)', 'The vault’s audit view — every saved ${NAME}, encrypted by your OS keychain. Keys are normally pasted where they’re needed.', keysBlock.block)

  const cards: Record<SectionId, CollapsibleCardHandle> = { connections, servers, workspace, keys }
  onSignal((id, sig) => cards[id]?.setAttention(sig.chip))

  const section = el('div', { class: 'integrations-section' }, [
    createIntegrationsIntro(),
    connections.el,
    servers.el,
    workspace.el,
    keys.el,
    createIntegrationsPrivacy()
  ])

  // 'matrix' is the focus port's historical name for "the workspace scoping
  // surface" — it lands on the merged Workspace-tools card now. Routes, not
  // capabilities: every existing caller keeps working.
  focusTargets = { matrix: workspace, servers }
  // Every entry into Settings re-reads what can go stale. Reading it once at boot is
  // what left the matrix and the grants blank on a fresh install (see SyncedBlock).
  const syncs = [connectionsBlock.sync, serversBlock.sync, workspaceBlock.sync, keysBlock.sync]
  syncAll = (): void => {
    for (const sync of syncs) sync()
  }
  if (import.meta.env.DEV) {
    const w = window as unknown as { __mogging?: Record<string, unknown> }
    w.__mogging = w.__mogging ?? {}
    w.__mogging.integrationsStatusDebug = (): { pollRequests: number; pushPaints: number } => ({
      pollRequests: statusPollRequests,
      pushPaints: statusPushPaints
    })
  }
  return section
}
