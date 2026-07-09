import {
  AgentChannels,
  ProfileChannels,
  RemoteChannels,
  type AgentInfo,
  type AgentProfile,
  type RemoteHost
} from '@contracts'
import { Button, Card, confirmDialog, EmptyState, FieldGroup, SectionHeader, el } from '../../components'
import { getBridge } from '../../core/ipc/bridge'
import { announceProfilesChanged } from '../../core/agents/profiles-port'

/**
 * Settings § Profiles & SSH hosts (Phase-4 polish): full add/edit/remove management
 * for the two pointer stores. ADR 0002 is enforced MAIN-SIDE (`profiles:save` /
 * `remotes:save` return false on refusal) — this UI only SURFACES the refusal reason
 * inline; it never weakens or duplicates the deny-list. Values render in this form
 * and nowhere else (never telemetry/logs).
 */

const invoke = (channel: string, payload?: unknown): Promise<unknown> => getBridge().invoke(channel, payload)

const newId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`

function errorLine(): HTMLElement {
  const e = el('p', { class: 'settings-error', role: 'alert' })
  e.hidden = true
  return e
}

function showError(node: HTMLElement, message: string): void {
  node.textContent = message
  node.hidden = false
}

export function createProfilesHostsSection(): HTMLElement {
  const root = el('div', { class: 'ph-section' })
  const profilesList = el('div', { class: 'ph-list ph-profiles' })
  const hostsList = el('div', { class: 'ph-list ph-hosts' })
  const profileFormHost = el('div', {})
  const hostFormHost = el('div', {})
  let roster: AgentInfo[] = []

  async function refresh(): Promise<void> {
    const [profiles, hosts, agents] = await Promise.all([
      invoke(ProfileChannels.list) as Promise<AgentProfile[]>,
      invoke(RemoteChannels.list) as Promise<RemoteHost[]>,
      invoke(AgentChannels.detect) as Promise<AgentInfo[]>
    ])
    roster = (agents ?? []).filter((a) => a.installed)
    renderProfiles(profiles ?? [])
    renderHosts(hosts ?? [])
  }

  // ── Profiles ───────────────────────────────────────────────────────────────
  function renderProfiles(profiles: AgentProfile[]): void {
    profilesList.replaceChildren()
    if (!profiles.length) {
      profilesList.append(
        EmptyState({
          icon: 'user',
          title: 'No profiles yet',
          body: 'One per provider account (work, personal, …) — pointers only, never credentials.'
        })
      )
    }
    for (const p of profiles.sort((a, b) => a.provider.localeCompare(b.provider) || a.order - b.order)) {
      const envSummary = Object.entries(p.env)
        .map(([k, v]) => `${k}=${v}`)
        .join(' · ')
      profilesList.append(
        el('div', { class: 'ph-row' }, [
          el('div', { class: 'ph-row-main' }, [
            el('span', { class: 'ph-row-name', text: p.name }),
            el('span', { class: 'ph-row-meta', text: `${p.provider} · order ${p.order}` }),
            el('span', { class: 'ph-row-env', text: envSummary || 'no env pointers' })
          ]),
          el('div', { class: 'ph-row-actions' }, [
            Button({ label: 'Edit', size: 'sm', onClick: () => openProfileForm(p) }),
            Button({
              label: 'Delete',
              size: 'sm',
              variant: 'ghost',
              onClick: () => {
                void confirmDialog({
                  title: `Delete profile “${p.name}”?`,
                  message: 'This pointer set is removed. Panes already launched keep their env; new launches won’t offer it.',
                  confirmLabel: 'Delete profile',
                  danger: true
                }).then((ok) => {
                  if (!ok) return
                  void invoke(ProfileChannels.remove, p.id).then(() => {
                    announceProfilesChanged()
                    void refresh()
                  })
                })
              }
            })
          ])
        ])
      )
    }
  }

  function openProfileForm(existing?: AgentProfile): void {
    profileFormHost.replaceChildren()
    const err = errorLine()
    const name = el('input', {
      class: 'input prof-name',
      attrs: { type: 'text', placeholder: 'Profile name (e.g. Work)', value: existing?.name ?? '' }
    }) as HTMLInputElement
    const provider = el('select', { class: 'input prof-provider', ariaLabel: 'Provider' }) as HTMLSelectElement
    for (const a of roster) provider.append(new Option(a.name, a.id))
    if (!roster.length) provider.append(new Option('claude', 'claude'))
    if (existing) provider.value = existing.provider
    const order = el('input', {
      class: 'input prof-order',
      attrs: { type: 'number', min: '0', max: '99', value: String(existing?.order ?? 0) },
      ariaLabel: 'Failover order (0 = default)'
    }) as HTMLInputElement

    const envRows = el('div', { class: 'ph-env-rows' })
    const addEnvRow = (key = '', value = ''): void => {
      const k = el('input', {
        class: 'input input--mono prof-env-key',
        attrs: { type: 'text', placeholder: 'ENV_NAME', value: key, 'aria-label': 'Environment variable name' }
      }) as HTMLInputElement
      const v = el('input', {
        class: 'input input--mono prof-env-val',
        attrs: {
          type: 'text',
          placeholder: 'pointer value (a dir/file/flag — never a secret)',
          value,
          'aria-label': 'Pointer value (a dir, file, or flag — never a secret)'
        }
      }) as HTMLInputElement
      const rowEl = el('div', { class: 'ph-env-row' }, [
        k,
        v,
        Button({ label: '×', size: 'sm', variant: 'ghost', ariaLabel: 'Remove variable', onClick: () => rowEl.remove() })
      ])
      envRows.append(rowEl)
    }
    const existingEnv = Object.entries(existing?.env ?? {})
    if (existingEnv.length) existingEnv.forEach(([k, v]) => addEnvRow(k, v))
    else addEnvRow()

    const save = Button({
      label: existing ? 'Save profile' : 'Add profile',
      variant: 'primary',
      ariaLabel: 'Save profile',
      onClick: () => {
        const env: Record<string, string> = {}
        for (const rowEl of Array.from(envRows.querySelectorAll('.ph-env-row'))) {
          const k = (rowEl.querySelector('.prof-env-key') as HTMLInputElement).value.trim()
          const v = (rowEl.querySelector('.prof-env-val') as HTMLInputElement).value.trim()
          if (k || v) env[k] = v
        }
        const profile: AgentProfile = {
          id: existing?.id ?? newId('prof'),
          name: name.value.trim(),
          provider: provider.value,
          env,
          order: Number(order.value) || 0
        }
        void (invoke(ProfileChannels.save, profile) as Promise<boolean>).then((ok) => {
          if (!ok) {
            showError(
              err,
              'Refused: check the fields — env names must be UPPER_SNAKE, and a value that looks like a secret ' +
                '(key/token shapes) cannot be saved. Profiles hold POINTERS only (ADR 0002).'
            )
            return
          }
          profileFormHost.replaceChildren()
          announceProfilesChanged()
          void refresh()
        })
      }
    })
    profileFormHost.append(
      el('div', { class: 'ph-form' }, [
        el('div', { class: 'ph-form-grid' }, [
          FieldGroup({ label: 'Profile name', hint: 'e.g. Work' }, name),
          FieldGroup({ label: 'Provider' }, provider),
          FieldGroup({ label: 'Failover order', hint: '0 = the default lane' }, order)
        ]),
        el('div', { class: 'ph-env-head' }, [
          el('span', { class: 'field-group-label', text: 'Environment pointers' }),
          el('span', {
            class: 'field-group-hint',
            text: 'UPPER_SNAKE names your CLI reads → a pointer (a dir, file, or flag). Never a secret (ADR 0002).'
          })
        ]),
        envRows,
        el('div', { class: 'ph-form-actions' }, [
          Button({ label: '+ variable', size: 'sm', onClick: () => addEnvRow() }),
          el('span', { class: 'ph-spacer' }),
          Button({ label: 'Cancel', size: 'sm', onClick: () => profileFormHost.replaceChildren() }),
          save
        ]),
        err
      ])
    )
    name.focus()
  }

  // ── SSH hosts ──────────────────────────────────────────────────────────────
  function renderHosts(hosts: RemoteHost[]): void {
    hostsList.replaceChildren()
    if (!hosts.length) {
      hostsList.append(
        EmptyState({
          icon: 'globe',
          title: 'No SSH hosts yet',
          body: 'Your ssh config/agent does all auth — add a target to launch panes on it.'
        })
      )
    }
    for (const h of hosts) {
      hostsList.append(
        el('div', { class: 'ph-row' }, [
          el('div', { class: 'ph-row-main' }, [
            el('span', { class: 'ph-row-name', text: h.name }),
            el('span', {
              class: 'ph-row-meta',
              text: `${h.user ? h.user + '@' : ''}${h.host}${h.port ? ':' + h.port : ''}`
            }),
            h.identityHint ? el('span', { class: 'ph-row-env', text: h.identityHint }) : null
          ]),
          el('div', { class: 'ph-row-actions' }, [
            Button({ label: 'Edit', size: 'sm', onClick: () => openHostForm(h) }),
            Button({
              label: 'Delete',
              size: 'sm',
              variant: 'ghost',
              onClick: () => {
                void confirmDialog({
                  title: `Delete host “${h.name}”?`,
                  message: 'This SSH target is removed. Open remote panes stay connected; new panes won’t offer it.',
                  confirmLabel: 'Delete host',
                  danger: true
                }).then((ok) => {
                  if (!ok) return
                  void invoke(RemoteChannels.remove, h.id).then(() => {
                    announceProfilesChanged()
                    void refresh()
                  })
                })
              }
            })
          ])
        ])
      )
    }
  }

  function openHostForm(existing?: RemoteHost): void {
    hostFormHost.replaceChildren()
    const err = errorLine()
    const mk = (cls: string, placeholder: string, value = ''): HTMLInputElement =>
      el('input', { class: `input ${cls}`, attrs: { type: 'text', placeholder, value } }) as HTMLInputElement
    const name = mk('host-name', 'Display name (e.g. buildbox)', existing?.name ?? '')
    const host = mk('host-host', 'Hostname or ssh alias', existing?.host ?? '')
    const user = mk('host-user', 'User (optional)', existing?.user ?? '')
    const port = mk('host-port', 'Port (optional)', existing?.port ? String(existing.port) : '')
    const hint = mk('host-hint', 'Identity hint (optional note — never a key)', existing?.identityHint ?? '')
    const save = Button({
      label: existing ? 'Save host' : 'Add host',
      variant: 'primary',
      ariaLabel: 'Save host',
      onClick: () => {
        const remote: RemoteHost = {
          id: existing?.id ?? newId('host'),
          name: name.value.trim(),
          host: host.value.trim(),
          user: user.value.trim() || undefined,
          port: port.value.trim() ? Number(port.value) : undefined,
          identityHint: hint.value.trim() || undefined
        }
        void (invoke(RemoteChannels.save, remote) as Promise<boolean>).then((ok) => {
          if (!ok) {
            showError(err, 'Refused: hostname/user/port shape invalid (no spaces or shell characters; port 1–65535).')
            return
          }
          hostFormHost.replaceChildren()
          announceProfilesChanged()
          void refresh()
        })
      }
    })
    hostFormHost.append(
      el('div', { class: 'ph-form' }, [
        el('div', { class: 'ph-form-grid' }, [
          FieldGroup({ label: 'Display name', hint: 'e.g. buildbox' }, name),
          FieldGroup({ label: 'Hostname or ssh alias' }, host),
          FieldGroup({ label: 'User', hint: 'optional' }, user),
          FieldGroup({ label: 'Port', hint: 'optional' }, port),
          FieldGroup({ label: 'Identity hint', hint: 'optional note — never a key' }, hint)
        ]),
        el('div', { class: 'ph-form-actions' }, [
          el('span', { class: 'ph-spacer' }),
          Button({ label: 'Cancel', size: 'sm', onClick: () => hostFormHost.replaceChildren() }),
          save
        ]),
        err
      ])
    )
    name.focus()
  }

  root.append(
    Card(
      {
        tone: 'inset',
        header: SectionHeader({
          title: 'Provider profiles',
          caption: 'One per provider account (work, personal, …).',
          action: Button({ label: '+ Add profile', size: 'sm', ariaLabel: 'Add profile', onClick: () => openProfileForm() })
        })
      },
      [profilesList, profileFormHost]
    ),
    Card(
      {
        tone: 'inset',
        header: SectionHeader({
          title: 'SSH hosts',
          caption: 'ssh targets — your own config/agent does the auth.',
          action: Button({ label: '+ Add host', size: 'sm', ariaLabel: 'Add host', onClick: () => openHostForm() })
        })
      },
      [hostsList, hostFormHost]
    )
  )

  return Object.assign(root, { refresh }) as HTMLElement & { refresh: () => Promise<void> }
}
