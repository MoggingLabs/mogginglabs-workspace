import {
  AgentHookChannels,
  type GlobalHooksMutationResult,
  type GlobalHooksProviderStatus,
  type GlobalHooksStatus
} from '@contracts'
import { Button, Card, Pill, SectionHeader, Spinner, el, showToast } from '../../components'
import { getBridge } from '../../core/ipc/bridge'
import { onViewChange } from '../../core/shell/view-port'

/**
 * Settings § Notifications — alerts for agents you start yourself (F-08: moved
 * OUT of Agent CLIs; it was filed under install/configure when its user goal is
 * "why doesn't my pane ring?").
 *
 * An agent launched from the app rings its pane through session-scoped bell
 * config (claude's --settings overlay, codex -c flags, the gemini/opencode
 * env-pointed files); an agent TYPED at a pane's own prompt carries none of it,
 * so its pane never rings. Wiring the same config into each CLI's own global
 * files closes that: the notify script (and OpenCode's plugin around it) no-ops
 * outside a MoggingLabs pane. Explicit action + backup + atomic write, same as
 * every user-owned config we touch; a CONFLICT (the user's own codex `notify`,
 * a differing tui value) shows its reason instead of an Apply button (F-07:
 * summarized, raw value behind a disclosure).
 */
export function createSessionAlertsCard(): HTMLElement {
  const invoke = (channel: string, payload?: unknown): Promise<unknown> => getBridge().invoke(channel, payload)
  const hooksList = el('div', { class: 'prov-list' })
  let hooksStatus: GlobalHooksStatus | null = null

  const HOOKS_LABEL: Record<GlobalHooksProviderStatus['provider'], string> = {
    claude: 'Claude Code',
    codex: 'Codex',
    gemini: 'Gemini',
    opencode: 'OpenCode'
  }
  const HOOKS_PILL: Record<GlobalHooksProviderStatus['state'], { text: string; tone: 'success' | 'neutral' | 'warning' | 'danger' }> = {
    applied: { text: '✓ wired', tone: 'success' },
    partial: { text: 'stale', tone: 'warning' },
    'not-applied': { text: 'not wired', tone: 'neutral' },
    conflict: { text: 'their config', tone: 'warning' },
    unreadable: { text: 'unreadable', tone: 'danger' }
  }
  const hooksAct = (channel: string, provider: GlobalHooksProviderStatus['provider'], done: string): void => {
    void (invoke(channel, { provider }) as Promise<GlobalHooksMutationResult>).then(async (result) => {
      if (result?.ok) showToast({ title: done, body: result.backups?.length ? `Backup: ${result.backups.join(' · ')}` : undefined, tone: 'success' })
      else showToast({ title: 'Nothing was written', body: result?.reason, tone: 'danger' })
      await refreshHooks()
    })
  }
  const hooksRow = (row: GlobalHooksProviderStatus): HTMLElement => {
    const label = HOOKS_LABEL[row.provider]
    const actions = el('div', { class: 'prov-actions' })
    if (row.state === 'not-applied' || row.state === 'partial') {
      actions.append(Button({
        label: row.state === 'partial' ? 'Re-apply' : 'Wire alerts',
        icon: 'bell',
        size: 'sm',
        onClick: () => hooksAct(AgentHookChannels.apply, row.provider, `${label} alerts wired globally`)
      }))
    }
    if (row.state === 'applied' || row.state === 'partial') {
      actions.append(Button({
        label: 'Remove',
        variant: 'ghost',
        size: 'sm',
        onClick: () => hooksAct(AgentHookChannels.remove, row.provider, `${label} alert wiring removed`)
      }))
    }
    // F-07: a conflict's `reason` can embed the user's entire config value — an escaped
    // Windows path, unbroken — which used to print inline and drag a horizontal scrollbar
    // onto the whole page. The row now says WHAT in one sentence; the raw value sits
    // behind a disclosure in a wrapping <pre> (the install-log surface, same class).
    const blocked = row.state === 'conflict' || row.state === 'unreadable'
    const note = blocked
      ? row.state === 'conflict'
        ? 'This CLI’s own config already sets these values — yours, not the app’s, so nothing is overwritten.'
        : 'The config file could not be read — fix or remove it, then Wire alerts again.'
      : row.files.join(' · ')
    let detail: HTMLElement | null = null
    if (blocked) {
      detail = el('pre', { class: 'prov-log prov-conflict-detail', text: `${row.reason ?? 'not writable'}\n${row.files.join('\n')}` })
      detail.hidden = true
      const toggle: HTMLButtonElement = Button({
        label: 'Show details',
        variant: 'ghost',
        size: 'sm',
        onClick: () => {
          detail!.hidden = !detail!.hidden
          toggle.textContent = detail!.hidden ? 'Show details' : 'Hide details'
        }
      })
      actions.append(toggle)
    }
    return el('div', { class: 'prov-item', dataset: { hooksProvider: row.provider } }, [
      el('div', { class: 'prov-row prov-row--static' }, [
        el('div', { class: 'prov-row-main' }, [
          el('div', { class: 'prov-row-head' }, [
            el('span', { class: 'prov-name', text: `${label} · global alerts` }),
            Pill(HOOKS_PILL[row.state])
          ]),
          // F-15: file paths are for the expert's eye — faint, one line, full on hover.
          el('div', { class: `settings-row-caption${blocked ? '' : ' prov-paths'}`, text: note, title: blocked ? undefined : note })
        ]),
        actions
      ]),
      detail
    ])
  }
  const renderHooks = (): void => {
    if (!hooksStatus) {
      hooksList.replaceChildren(el('div', { class: 'settings-row-caption' }, [Spinner()]))
      return
    }
    hooksList.replaceChildren(...hooksStatus.map(hooksRow))
  }
  const refreshHooks = async (): Promise<void> => {
    try {
      hooksStatus = (await invoke(AgentHookChannels.status)) as GlobalHooksStatus
    } catch {
      hooksStatus = null
    }
    renderHooks()
  }

  // Wiring state changes from outside this page (a nudge accepted, a file edited) —
  // every entry into Settings re-reads it, deferred so the view switch paints first.
  let entryQueued = false
  const sync = (): void => {
    if (entryQueued) return
    entryQueued = true
    setTimeout(() => {
      entryQueued = false
      void refreshHooks()
    }, 0)
  }
  onViewChange((v) => {
    if (v === 'settings') sync()
  })
  sync()

  // Aider has no wiring row on purpose: launched panes ring via the AIDER_NOTIFICATIONS* env,
  // and its only global config is the user's own YAML (~/.aider.conf.yml) — a file the app
  // will not rewrite (comments don't survive a faithful round-trip, and the house rule is
  // refuse over clobber). The row still exists so the card answers "why doesn't my hand-typed
  // aider ring?" instead of silently listing four CLIs of five. NO data-hooks-provider
  // attribute: the GLOBALHOOKS gate counts those, and this row is information, not wiring.
  const aiderRow = el('div', { class: 'prov-item' }, [
    el('div', { class: 'prov-row prov-row--static' }, [
      el('div', { class: 'prov-row-main' }, [
        el('div', { class: 'prov-row-head' }, [
          el('span', { class: 'prov-name', text: 'Aider · global alerts' }),
          Pill({ text: 'launch-only', tone: 'neutral' })
        ]),
        el('div', {
          class: 'settings-row-caption',
          text: 'Rings when launched by the app. A hand-typed aider can’t be wired in one click — its config is your own YAML — see hooks/README.md for the two-line manual snippet.'
        })
      ])
    ])
  ])

  return Card(
    {
      header: SectionHeader({
        title: 'Alerts for agents you start yourself',
        caption:
          'Agents launched by the app already ring their pane. Wire each CLI’s global config so an agent you type at a pane’s own prompt rings too — outside a pane the wiring is a silent no-op. Remote (SSH) panes can’t be wired from here: their config lives on the remote host, so a remote agent speaks through its chime only and its dot stays hollow.'
      })
    },
    [hooksList, aiderRow]
  )
}
