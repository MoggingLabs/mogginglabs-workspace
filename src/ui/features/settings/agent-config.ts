import {
  AgentConfigChannels,
  type AgentConfigMutationResult,
  type AgentConfigProviderId,
  type AgentConfigProviderSummary,
  type AgentConfigScopeOption,
  type AgentConfigSettingState,
  type AgentConfigSnapshot,
  type AgentConfigTarget,
  type AgentConfigValue,
  type AgentInfo
} from '@contracts'
import {
  Button,
  Pill,
  Spinner,
  confirmDialog,
  el,
  icon,
  providerLogo,
  showToast,
  type PillTone
} from '../../components'
import { getBridge } from '../../core/ipc/bridge'

export interface AgentConfigWorkspace {
  el: HTMLElement
  open(provider: AgentConfigProviderId, agent?: AgentInfo): Promise<void>
  refresh(): Promise<void>
  activeProvider(): AgentConfigProviderId | null
}

let controlSequence = 0

function targetKey(target: AgentConfigTarget): string {
  return `${target.scope}\u0000${target.targetId}\u0000${target.execution.kind === 'ssh' ? `ssh:${target.execution.hostId}` : 'local'}`
}

function shortPath(state: AgentConfigSettingState): string {
  return `${state.setting.surface === 'tui' ? 'TUI · ' : ''}${state.setting.path.join('.')}`
}

function valueText(value: AgentConfigValue | undefined): string {
  if (value === undefined) return 'Not set'
  if (typeof value === 'string') return value || 'Empty text'
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'On' : 'Off'
  if (typeof value === 'number') return String(value)
  const serialized = JSON.stringify(value)
  return serialized.length > 96 ? `${serialized.slice(0, 93)}…` : serialized
}

function observedText(state: AgentConfigSettingState, which: 'selected' | 'effective'): string {
  const observed = state[which]
  if (!observed.known) return 'Unknown'
  if (observed.redacted) return observed.present ? 'Present · hidden' : 'Not set'
  return observed.present ? valueText(observed.value) : 'Not set'
}

function syncTone(sync: AgentConfigSettingState['sync']): PillTone {
  if (sync === 'synced' || sync === 'observed') return 'success'
  if (sync === 'drifted' || sync === 'shadowed' || sync === 'pending' || sync === 'pending-restart') return 'warning'
  if (sync === 'blocked' || sync === 'error' || sync === 'parse-error' || sync === 'unsupported') return 'danger'
  return 'neutral'
}

function syncLabel(sync: AgentConfigSettingState['sync']): string {
  return sync.replace(/-/g, ' ').replace(/^./, (letter) => letter.toUpperCase())
}

/** F-14: a status pill owes its reader a sentence — these are the hover titles. */
function syncTitle(sync: AgentConfigSettingState['sync']): string {
  switch (sync) {
    case 'observed':
      return 'Read from the CLI’s own files — nothing managed by this app yet.'
    case 'synced':
      return 'Every value the app manages matches the file.'
    case 'drifted':
      return 'A managed value changed on disk — open the setting to keep or restore it.'
    case 'shadowed':
      return 'A higher-priority layer overrides the managed value.'
    case 'pending':
      return 'Saved — applies to the next launch.'
    case 'pending-restart':
      return 'Saved — restart the affected panes to apply.'
    case 'blocked':
      return 'The file refused the write — see the setting’s message.'
    case 'parse-error':
      return 'The config file could not be parsed — fix it, then refresh.'
    case 'unsupported':
      return 'This CLI version does not support the setting.'
    case 'error':
      return 'The last read or write failed — refresh to retry.'
    default:
      return ''
  }
}

function initialValue(state: AgentConfigSettingState): AgentConfigValue {
  if (state.desired?.operation === 'set' && state.desired.value !== undefined) return state.desired.value
  if (state.selected.present && state.selected.value !== undefined) return state.selected.value
  if (state.effective.present && state.effective.value !== undefined) return state.effective.value
  if (state.setting.defaultValue !== undefined) return state.setting.defaultValue
  const schema = state.setting.schema
  if (schema.enum?.length) return schema.enum[0]
  if (schema.nullable) return null
  if (schema.kind === 'boolean') return false
  if (schema.kind === 'number' || schema.kind === 'integer') return schema.minimum ?? 0
  if (schema.kind === 'array') return []
  if (schema.kind === 'object' || schema.kind === 'map') return {}
  return ''
}

interface ValueControl {
  el: HTMLElement
  read(): { ok: true; value: AgentConfigValue } | { ok: false; reason: string }
}

function valueControl(state: AgentConfigSettingState, disabled: boolean): ValueControl {
  const setting = state.setting
  const value = initialValue(state)
  const id = `agentcfg-${++controlSequence}`
  if (setting.schema.kind === 'boolean') {
    const input = el('input', { type: 'checkbox', class: 'switch-input', disabled })
    input.id = id
    input.checked = value === true
    const control = el('label', { class: 'switch', attrs: { for: id } }, [
      input,
      el('span', { class: 'switch-track' }, [el('span', { class: 'switch-thumb' })])
    ])
    const status = el('span', { class: 'agentcfg-bool-state', text: input.checked ? 'On' : 'Off' })
    input.addEventListener('change', () => { status.textContent = input.checked ? 'On' : 'Off' })
    return { el: el('div', { class: 'agentcfg-bool' }, [status, control]), read: () => ({ ok: true, value: input.checked }) }
  }
  if (setting.schema.enum?.length) {
    const select = el('select', { class: 'input agentcfg-input', disabled, ariaLabel: `Value for ${setting.title}` })
    setting.schema.enum.forEach((choice, index) => {
      const label = setting.schema.enumLabels?.[index] ?? valueText(choice)
      const option = el('option', { value: String(index), text: label })
      if (JSON.stringify(choice) === JSON.stringify(value)) option.selected = true
      select.append(option)
    })
    return { el: select, read: () => ({ ok: true, value: setting.schema.enum![Number(select.value)] }) }
  }
  if (setting.schema.kind === 'number' || setting.schema.kind === 'integer') {
    const input = el('input', {
      type: 'number',
      class: 'input agentcfg-input',
      value: typeof value === 'number' ? String(value) : '',
      disabled,
      ariaLabel: `Value for ${setting.title}`
    })
    if (setting.schema.minimum !== undefined) input.min = String(setting.schema.minimum)
    if (setting.schema.maximum !== undefined) input.max = String(setting.schema.maximum)
    if (setting.schema.kind === 'integer') input.step = '1'
    return {
      el: input,
      read: () => {
        const parsed = Number(input.value)
        return Number.isFinite(parsed) ? { ok: true, value: parsed } : { ok: false, reason: 'Enter a finite number.' }
      }
    }
  }
  if (setting.schema.kind === 'array' && setting.schema.item &&
    ['string', 'number', 'integer', 'boolean', 'enum'].includes(setting.schema.item.kind)) {
    const values = Array.isArray(value) ? value : []
    const input = el('textarea', {
      class: 'input agentcfg-input agentcfg-textarea',
      value: values.map((item) => typeof item === 'string' ? item : JSON.stringify(item)).join('\n'),
      disabled,
      ariaLabel: `Values for ${setting.title}, one per line`
    })
    return {
      el: el('label', { class: 'agentcfg-array-editor' }, [
        input,
        el('small', { text: 'One value per line.' })
      ]),
      read: () => {
        const lines = input.value.split(/\r?\n/).filter((line) => line.length > 0)
        const item = setting.schema.item!
        if (item.kind === 'number' || item.kind === 'integer') {
          const parsed = lines.map(Number)
          if (parsed.some((entry) => !Number.isFinite(entry) || item.kind === 'integer' && !Number.isInteger(entry))) {
            return { ok: false, reason: `Enter one ${item.kind} per line.` }
          }
          return { ok: true, value: parsed }
        }
        if (item.kind === 'boolean') {
          if (lines.some((entry) => entry !== 'true' && entry !== 'false')) return { ok: false, reason: 'Enter true or false on each line.' }
          return { ok: true, value: lines.map((entry) => entry === 'true') }
        }
        return { ok: true, value: lines }
      }
    }
  }
  if (setting.schema.kind === 'string') {
    const multiline = setting.schema.format === 'multiline' || (typeof value === 'string' && value.length > 120)
    const input = multiline
      ? el('textarea', { class: 'input agentcfg-input agentcfg-textarea', value: typeof value === 'string' ? value : '', disabled, ariaLabel: `Value for ${setting.title}` })
      : el('input', { type: 'text', class: 'input agentcfg-input', value: typeof value === 'string' ? value : '', disabled, ariaLabel: `Value for ${setting.title}` })
    return { el: input, read: () => ({ ok: true, value: input.value }) }
  }
  const textarea = el('textarea', {
    class: 'input agentcfg-input agentcfg-json',
    value: JSON.stringify(value, null, 2),
    disabled,
    ariaLabel: `Structured value for ${setting.title}`
  })
  return {
    el: textarea,
    read: () => {
      try {
        return { ok: true, value: JSON.parse(textarea.value) as AgentConfigValue }
      } catch {
        return { ok: false, reason: 'Enter valid JSON for this structured setting.' }
      }
    }
  }
}

function sourceLine(label: string, value: string, source?: string): HTMLElement {
  return el('div', { class: 'agentcfg-source-line' }, [
    el('span', { class: 'agentcfg-source-label', text: label }),
    el('span', { class: 'agentcfg-source-value', text: value, title: value }),
    source ? el('span', { class: 'agentcfg-source-origin', text: source }) : null
  ])
}

export function createAgentConfigWorkspace(onBack: () => void): AgentConfigWorkspace {
  const root = el('div', { class: 'agentcfg-workspace', hidden: true })
  let provider: AgentConfigProviderId | null = null
  let agent: AgentInfo | undefined
  let summary: AgentConfigProviderSummary | undefined
  let snapshot: AgentConfigSnapshot | null = null
  let selectedCategory = ''
  let query = ''
  let loadEpoch = 0

  async function invoke<T>(channel: string, payload?: unknown): Promise<T> {
    return getBridge().invoke(channel, payload) as Promise<T>
  }

  async function load(target?: AgentConfigTarget): Promise<void> {
    if (!provider) return
    const epoch = ++loadEpoch
    root.replaceChildren(el('div', { class: 'agentcfg-loading' }, [Spinner(), el('span', { text: 'Reading provider settings…' })]))
    const [next, summaries] = await Promise.all([
      invoke<AgentConfigSnapshot | null>(AgentConfigChannels.snapshot, { provider, ...(target ? { target } : {}) }),
      invoke<AgentConfigProviderSummary[]>(AgentConfigChannels.providers)
    ]).catch(() => [null, []] as [AgentConfigSnapshot | null, AgentConfigProviderSummary[]])
    if (epoch !== loadEpoch) return
    snapshot = next
    summary = summaries.find((candidate) => candidate.provider === provider)
    if (!snapshot) {
      renderUnavailable()
      return
    }
    const categories = [...new Set(snapshot.settings.map((state) => state.setting.category))]
    if (!selectedCategory || !categories.includes(selectedCategory)) selectedCategory = categories[0] ?? 'General'
    render()
  }

  function renderUnavailable(): void {
    root.replaceChildren(
      Button({ label: 'All agent CLIs', icon: 'chevron-left', variant: 'ghost', size: 'sm', onClick: onBack }),
      el('div', { class: 'agentcfg-empty' }, [
        icon('alert', 24),
        el('strong', { text: 'Settings are unavailable' }),
        el('span', { text: 'The last-known-good catalog or selected target could not be loaded.' }),
        Button({ label: 'Try again', icon: 'rotate-cw', onClick: () => void load(snapshot?.target) })
      ])
    )
  }

  function scopePicker(options: AgentConfigScopeOption[], target: AgentConfigTarget): HTMLElement {
    const select = el('select', { class: 'input agentcfg-scope-select', ariaLabel: 'Configuration scope' })
    const groups = new Map<string, HTMLOptGroupElement>()
    const groupName = (scope: AgentConfigTarget['scope']): string => {
      if (scope === 'project' || scope === 'local') return 'Projects'
      if (scope === 'session') return 'Next launch'
      if (scope === 'profile') return 'Profiles'
      if (scope === 'user') return 'User'
      return 'System'
    }
    options.forEach((entry, index) => {
      const label = groupName(entry.target.scope)
      let group = groups.get(label)
      if (!group) {
        group = document.createElement('optgroup')
        group.label = label
        groups.set(label, group)
        select.append(group)
      }
      const row = el('option', { value: String(index), text: entry.label, disabled: false })
      row.selected = targetKey(entry.target) === targetKey(target)
      if (!entry.writable) row.textContent += ' · read-only'
      group.append(row)
    })
    select.addEventListener('change', () => {
      const next = options[Number(select.value)]
      if (next) void load(next.target)
    })
    return select
  }

  function header(): HTMLElement {
    const installed = snapshot?.installed ?? agent?.installed ?? false
    const catalogStale = snapshot?.catalogStale ?? summary?.catalogStale ?? true
    const checkedAt = summary?.catalogCheckedAt
      ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(summary.catalogCheckedAt)
      : 'bundled catalog'
    return el('div', { class: 'agentcfg-head' }, [
      el('div', { class: 'agentcfg-head-top' }, [
        Button({ label: 'All agent CLIs', icon: 'chevron-left', variant: 'ghost', size: 'sm', onClick: onBack }),
        el('div', { class: 'agentcfg-head-actions' }, [
          Pill({ text: installed ? snapshot?.installedVersion ? `v${snapshot.installedVersion}` : 'Available' : 'Not installed', tone: installed ? 'success' : 'neutral' }),
          Pill({ text: syncLabel(snapshot?.sync ?? 'observed'), tone: snapshot ? syncTone(snapshot.sync) : 'neutral', title: syncTitle(snapshot?.sync ?? 'observed') }),
          catalogStale ? Pill({ text: 'Catalog stale', tone: 'warning', title: 'The settings catalog was checked more than 7 days ago — Refresh catalog re-fetches it.' }) : null,
          Button({
            label: 'Refresh catalog',
            icon: 'rotate-cw',
            variant: 'outline',
            size: 'sm',
            onClick: async () => {
              if (!provider) return
              const result = await invoke<{ ok: boolean; reason?: string }>(AgentConfigChannels.refresh, { provider, force: true })
              showToast({ title: result.ok ? 'Catalog refreshed' : 'Using last-known-good catalog', body: result.reason, tone: result.ok ? 'success' : 'attention' })
              await load(snapshot?.target)
            }
          })
        ])
      ]),
      el('div', { class: 'agentcfg-identity' }, [
        el('span', { class: 'agentcfg-logo', attrs: { 'aria-hidden': 'true' } }, [providerLogo(provider!, 26)]),
        el('div', {}, [
          el('h3', { text: snapshot?.providerName ?? agent?.name ?? provider ?? 'Agent CLI' }),
          el('p', { text: `Catalog checked ${checkedAt}. Values are read from provider layers; file paths and secrets never enter this screen.` })
        ])
      ]),
      snapshot?.message ? el('p', { class: 'agentcfg-snapshot-note', text: snapshot.message }) : null
    ])
  }

  function settingRow(state: AgentConfigSettingState, scope: AgentConfigScopeOption | undefined): HTMLElement {
    const currentSnapshot = snapshot!
    const setting = state.setting
    const availableAtScope = setting.scopes.includes(currentSnapshot.target.scope)
    const writable = availableAtScope && !!scope?.writable && setting.writable && setting.editor !== 'read-only' && setting.editor !== 'dedicated'
    const control = valueControl(state, !writable)
    const ownership = el('select', { class: 'input agentcfg-ownership', disabled: !writable, ariaLabel: `Synchronization mode for ${setting.title}` }, [
      el('option', { value: 'enforce', text: 'Keep in sync' }),
      el('option', { value: 'once', text: 'Apply once' })
    ])
    ownership.value = state.desired?.ownership ?? 'enforce'

    const statusBadges: HTMLElement[] = []
    if (setting.surface === 'tui') statusBadges.push(Pill({ text: 'TUI', tone: 'accent' }))
    if (setting.stability !== 'stable') statusBadges.push(Pill({ text: setting.stability, tone: setting.stability === 'deprecated' ? 'warning' : 'neutral' }))
    if (setting.sensitive) statusBadges.push(Pill({ text: 'Secret hidden', tone: 'neutral' }))
    if (state.desired) statusBadges.push(Pill({ text: syncLabel(state.sync), tone: syncTone(state.sync) }))

    async function save(operation: 'set' | 'unset'): Promise<void> {
      if (!provider || !snapshot) return
      let value: AgentConfigValue | undefined
      if (operation === 'set') {
        const parsed = control.read()
        if (!parsed.ok) {
          showToast({ title: 'Check this value', body: parsed.reason, tone: 'attention' })
          return
        }
        value = parsed.value
      }
      if (setting.danger) {
        const confirmed = await confirmDialog({
          title: setting.danger === 'permission-bypass' ? 'Reduce provider permission checks?' : `Apply ${setting.title}?`,
          message: setting.danger === 'permission-bypass'
            ? 'This can let the agent act without the provider’s usual approval prompts. The change applies only to the selected scope.'
            : 'This provider marks the setting as high impact. Review the selected scope before continuing.',
          confirmLabel: 'Apply setting',
          danger: true,
          rememberKey: `agentcfg:${setting.id}`
        })
        if (!confirmed) return
      }
      const result = await invoke<AgentConfigMutationResult>(AgentConfigChannels.set, {
        provider,
        target: currentSnapshot.target,
        settingId: setting.id,
        operation,
        ...(operation === 'set' ? { value } : {}),
        ownership: ownership.value
      })
      showToast({
        title: result.ok ? (ownership.value === 'enforce' ? 'Setting is now managed' : 'Setting applied') : 'Setting was not changed',
        body: result.reason,
        tone: result.ok ? 'success' : 'danger'
      })
      if (result.ok) await load(currentSnapshot.target)
    }

    async function release(behavior: 'keep' | 'restore'): Promise<void> {
      if (!provider || !snapshot) return
      const result = await invoke<AgentConfigMutationResult>(AgentConfigChannels.release, {
        provider,
        target: currentSnapshot.target,
        settingId: setting.id,
        behavior
      })
      showToast({ title: result.ok ? 'App ownership released' : 'Could not release setting', body: result.reason, tone: result.ok ? 'success' : 'danger' })
      if (result.ok) await load(currentSnapshot.target)
    }

    const disabledReason = !availableAtScope
      ? 'This provider does not support the setting at the selected scope.'
      : !scope?.writable
        ? scope?.reason ?? 'This target is read-only.'
        : setting.writeReason
    // S4/F-13: 521 primary Saves were an accent flood — Save renders quiet and ARMS
    // to primary on the row's first edit, so the accent marks intent, not furniture.
    // The ownership select gains its visible label: what it decides is what happens
    // on DRIFT, which nothing on screen said before you saved.
    const saveBtn = Button({ label: 'Save', variant: 'outline', size: 'sm', onClick: () => void save('set') })
    const armSave = (): void => {
      saveBtn.classList.remove('btn--outline')
      saveBtn.classList.add('btn--primary')
    }
    control.el.addEventListener('input', armSave)
    control.el.addEventListener('change', armSave)
    const actionRow = writable
      ? el('div', { class: 'agentcfg-setting-actions' }, [
          el('label', { class: 'agentcfg-ownership-label' }, [el('span', { text: 'On drift:' }), ownership]),
          saveBtn,
          currentSnapshot.target.scope !== 'session' && (state.selected.present || state.desired)
            ? Button({ label: 'Remove from layer', variant: 'ghost', size: 'sm', onClick: () => void save('unset') })
            : null
        ])
      : el('div', { class: 'agentcfg-readonly' }, [icon('info', 14), el('span', { text: disabledReason ?? 'Read-only in Workspace.' })])

    const releaseRow = state.desired
      ? el('div', { class: 'agentcfg-release' }, [
          el('span', { text: state.desired.ownership === 'enforce' ? 'Workspace will restore this value if the file drifts.' : 'This intent applies once.' }),
          Button({ label: 'Keep value & release', variant: 'ghost', size: 'sm', onClick: () => void release('keep') }),
          currentSnapshot.target.scope !== 'session'
            ? Button({ label: 'Restore original', variant: 'outline', size: 'sm', onClick: () => void release('restore') })
            : null
        ])
      : null

    return el('article', { class: `agentcfg-setting${writable ? '' : ' is-readonly'}`, dataset: { setting: setting.id } }, [
      el('div', { class: 'agentcfg-setting-head' }, [
        el('div', { class: 'agentcfg-setting-title' }, [
          el('h4', { text: setting.title }),
          el('code', { text: shortPath(state) })
        ]),
        el('div', { class: 'agentcfg-setting-badges' }, statusBadges)
      ]),
      el('p', { class: 'agentcfg-setting-desc', text: setting.description }),
      state.message ? el('p', { class: 'agentcfg-setting-message', text: state.message }) : null,
      el('div', { class: 'agentcfg-source-grid' }, [
        sourceLine('This layer', observedText(state, 'selected'), state.selected.sourceLabel),
        sourceLine('Effective', observedText(state, 'effective'), state.effective.sourceLabel),
        state.desired
          ? sourceLine(
              'Desired',
              state.desired.operation === 'unset' ? 'Remove from layer' : valueText(state.desired.value),
              `Workspace · ${state.desired.ownership === 'enforce' ? 'enforced' : 'apply once'}`
            )
          : null
      ]),
      el('div', { class: 'agentcfg-editor' }, [control.el, actionRow]),
      releaseRow
    ])
  }

  function renderSettings(host: HTMLElement, categoryHost: HTMLElement): void {
    if (!snapshot) return
    const normalized = query.trim().toLowerCase()
    const candidates = snapshot.settings.filter((state) => {
      if (!normalized) return state.setting.category === selectedCategory
      return [state.setting.title, state.setting.description, state.setting.category, state.setting.path.join('.')]
        .some((value) => value.toLowerCase().includes(normalized))
    })
    const visible = candidates.slice(0, 120)
    const selectedScope = snapshot.scopes.find((entry) => targetKey(entry.target) === targetKey(snapshot!.target))
    host.replaceChildren(
      el('div', { class: 'agentcfg-results-head' }, [
        el('div', {}, [
          el('h3', { text: normalized ? 'Search results' : selectedCategory }),
          el('span', { text: `${candidates.length} setting${candidates.length === 1 ? '' : 's'}${candidates.length > visible.length ? ` · showing first ${visible.length}` : ''}` })
        ])
      ]),
      ...(visible.length
        ? visible.map((state) => settingRow(state, selectedScope))
        : [el('div', { class: 'agentcfg-no-results' }, [icon('search', 20), el('span', { text: 'No settings match this search.' })])])
    )
    for (const button of categoryHost.querySelectorAll<HTMLButtonElement>('.agentcfg-category')) {
      button.classList.toggle('is-active', !normalized && button.dataset.category === selectedCategory)
    }
  }

  function render(): void {
    if (!snapshot || !provider) return
    root.hidden = false
    const categoryHost = el('nav', { class: 'agentcfg-categories', ariaLabel: 'Setting categories' })
    const counts = new Map<string, number>()
    for (const state of snapshot.settings) counts.set(state.setting.category, (counts.get(state.setting.category) ?? 0) + 1)
    for (const category of [...counts.keys()].sort((left, right) => left.localeCompare(right))) {
      categoryHost.append(el('button', {
        type: 'button',
        class: `agentcfg-category${category === selectedCategory && !query ? ' is-active' : ''}`,
        dataset: { category },
        onClick: () => {
          selectedCategory = category
          query = ''
          search.value = ''
          renderSettings(settingsHost, categoryHost)
        }
      }, [el('span', { text: category }), el('span', { class: 'agentcfg-category-count', text: String(counts.get(category)) })]))
    }

    const search = el('input', {
      type: 'search',
      class: 'input agentcfg-search-input',
      value: query,
      placeholder: `Search ${snapshot.settings.length} settings…`,
      ariaLabel: `Search ${snapshot.providerName} settings`
    })
    const settingsHost = el('div', { class: 'agentcfg-settings' })
    search.addEventListener('input', () => {
      query = search.value
      renderSettings(settingsHost, categoryHost)
    })
    const selectedScope = snapshot.scopes.find((entry) => targetKey(entry.target) === targetKey(snapshot!.target))
    root.replaceChildren(
      header(),
      el('div', { class: 'agentcfg-toolbar' }, [
        el('label', { class: 'agentcfg-scope-field' }, [
          el('span', { text: 'Configuration scope' }),
          scopePicker(snapshot.scopes, snapshot.target),
          el('small', { text: selectedScope?.description ?? 'Choose where this provider reads the value.' })
        ]),
        el('label', { class: 'agentcfg-search' }, [icon('search', 15), search])
      ]),
      el('div', { class: 'agentcfg-body' }, [categoryHost, settingsHost])
    )
    renderSettings(settingsHost, categoryHost)
  }

  getBridge().on(AgentConfigChannels.changed, (payload) => {
    const event = payload as { provider?: AgentConfigProviderId }
    if (provider && event.provider === provider && !root.hidden) void load(snapshot?.target)
  })

  return {
    el: root,
    open: async (nextProvider, nextAgent) => {
      provider = nextProvider
      agent = nextAgent
      selectedCategory = ''
      query = ''
      root.hidden = false
      await load()
    },
    refresh: () => load(snapshot?.target),
    activeProvider: () => provider
  }
}
