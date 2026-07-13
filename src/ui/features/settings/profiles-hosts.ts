import {
  AgentChannels,
  ProfileChannels,
  RemoteChannels,
  type AgentInfo,
  type AgentProfile,
  type AgentProfileDraft,
  type RemoteHost
} from '@contracts'
import { Button, Card, confirmDialog, createCheckbox, EmptyState, FieldGroup, Pill, SectionHeader, el, providerLogo } from '../../components'
import { getBridge } from '../../core/ipc/bridge'
import { announceProfilesChanged } from '../../core/agents/profiles-port'
import { switchActiveProfile } from '../../core/agents/profile-switch'

/**
 * Settings § Profiles & SSH hosts (Phase-4 polish, profiles simplified): a profile
 * asks for exactly TWO things — a name and the subscription email. The env pointer
 * set and failover order are DERIVED main-side at save (src/main/profiles.ts); the
 * form never shows them. ADR 0002 is enforced MAIN-SIDE (`profiles:save` /
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
          title: 'No logins detected yet',
          body: 'Sign in with an agent CLI (e.g. run `claude`) and it appears here — or add a profile for another subscription.'
        })
      )
    }
    // Default per provider = the lowest failover order (what new launches use).
    const defaultIds = new Set<string>()
    for (const p of profiles) {
      const top = profiles.filter((x) => x.provider === p.provider).sort((a, b) => a.order - b.order)[0]
      if (top) defaultIds.add(top.id)
    }
    for (const p of profiles.sort((a, b) => a.provider.localeCompare(b.provider) || a.order - b.order)) {
      const home = Object.values(p.env)[0]
      const detected = p.id.startsWith('login-')
      const isDefault = defaultIds.has(p.id)
      const siblings = profiles.filter((x) => x.provider === p.provider).length
      profilesList.append(
        el('div', { class: 'ph-row' }, [
          el('div', { class: 'ph-row-main' }, [
            el('span', { class: 'ph-row-name' }, [
              el('span', { text: p.name }),
              isDefault ? Pill({ text: 'Default', tone: 'success', title: 'New launches use this account' }) : null,
              detected ? Pill({ text: 'detected', title: 'Signed in on this machine — found automatically' }) : null
            ]),
            el('span', { class: 'ph-row-meta' }, [
              providerLogo(p.provider, 13),
              el('span', { text: `${p.provider}${p.email ? ' · ' + p.email : ''}` })
            ]),
            el('span', { class: 'ph-row-env', text: home ? `own config home · ${home}` : 'your CLI’s usual sign-in' })
          ]),
          el('div', { class: 'ph-row-actions' }, [
            !isDefault && siblings > 1
              ? Button({
                  label: 'Make default',
                  size: 'sm',
                  onClick: () => {
                    void switchActiveProfile(p.provider, p.id).then(() => refresh())
                  }
                })
              : null,
            Button({ label: 'Edit', size: 'sm', onClick: () => openProfileForm(p) }),
            // A detected login can't be deleted away — while the CLI stays signed
            // in, the next reconcile would truthfully bring it back.
            detected
              ? null
              : Button({
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
    const email = el('input', {
      class: 'input prof-email',
      attrs: { type: 'email', placeholder: 'you@company.com', value: existing?.email ?? '' },
      ariaLabel: 'Subscription email'
    }) as HTMLInputElement
    // The one PICK (defaulted): which CLI this subscription signs into. Fixed on
    // edit — a profile's provider is its identity (usage lanes, failover, homes).
    const provider = el('select', { class: 'input prof-provider', ariaLabel: 'Provider' }) as HTMLSelectElement
    for (const a of roster) provider.append(new Option(a.name, a.id))
    if (!roster.length) provider.append(new Option('claude', 'claude'))
    if (existing) {
      if (!Array.from(provider.options).some((o) => o.value === existing.provider))
        provider.append(new Option(existing.provider, existing.provider))
      provider.value = existing.provider
      provider.disabled = true
    }

    const save = Button({
      label: existing ? 'Save profile' : 'Add profile',
      variant: 'primary',
      ariaLabel: 'Save profile',
      onClick: () => {
        // Name + subscription email are ALL a profile takes. Env pointers and
        // failover order are derived main-side (edits keep the stored ones).
        const draft: AgentProfileDraft = {
          id: existing?.id ?? newId('prof'),
          name: name.value.trim(),
          provider: existing?.provider ?? provider.value,
          email: email.value.trim()
        }
        if (!draft.name || !draft.email) {
          showError(err, 'Two fields, both needed — a profile name and the subscription email.')
          return
        }
        void (invoke(ProfileChannels.save, draft) as Promise<boolean>).then((ok) => {
          if (!ok) {
            showError(err, 'Refused: the email must look like you@example.com (and the name fit in 60 characters).')
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
          FieldGroup({ label: 'Subscription email', hint: 'the account this profile launches under' }, email),
          FieldGroup({ label: 'Provider' }, provider)
        ]),
        el('span', {
          class: 'field-group-hint',
          text:
            'That’s it — sign-in stays in the CLI (ADR 0002). Your first profile uses the login you already have; ' +
            'extra profiles get their own config home and the CLI asks you to sign in there on first launch.'
        }),
        el('div', { class: 'ph-form-actions' }, [
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
            h.platform ? null : Pill({ text: 'Platform confirmation required', tone: 'warning' }),
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
    const posix = createCheckbox({
      checked: existing?.platform === 'posix',
      label: 'POSIX-compatible shell (Linux, macOS, or BSD)',
      ariaLabel: 'Confirm this SSH host uses a POSIX-compatible shell'
    })
    const save = Button({
      label: existing ? 'Save host' : 'Add host',
      variant: 'primary',
      ariaLabel: 'Save host',
      onClick: () => {
        if (!posix.checked()) {
          showError(err, 'Confirm the remote shell platform before saving this host.')
          return
        }
        const remote: RemoteHost = {
          id: existing?.id ?? newId('host'),
          name: name.value.trim(),
          host: host.value.trim(),
          platform: 'posix',
          user: user.value.trim() || undefined,
          port: port.value.trim() ? Number(port.value) : undefined,
          identityHint: hint.value.trim() || undefined
        }
        void (invoke(RemoteChannels.save, remote) as Promise<boolean>).then((ok) => {
          if (!ok) {
            showError(err, 'Refused: hostname/user/port shape invalid (no leading dash, spaces, or shell characters; port 1–65535).')
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
          FieldGroup({ label: 'Remote shell', hint: 'required for terminal integration' }, posix.el),
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
          caption: 'Every signed-in CLI account, plus any extra subscriptions you add. The default is what launches.',
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
