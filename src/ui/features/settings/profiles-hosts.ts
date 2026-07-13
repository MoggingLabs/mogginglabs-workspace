import {
  ProfileChannels,
  RemoteChannels,
  type AgentInfo,
  type AgentProfile,
  type AgentProfileDraft,
  type ProfileRemoveResult,
  type RemoteHost,
  type RemoteRemoveResult
} from '@contracts'
import {
  Button,
  Card,
  confirmDialog,
  EmptyState,
  FieldGroup,
  Pill,
  SectionHeader,
  el,
  loadingRow,
  providerLogo,
  showToast
} from '../../components'
import { createAsyncGuard } from '../../core/async/async-state'
import { getBridge } from '../../core/ipc/bridge'
import { announceProfilesChanged } from '../../core/agents/profiles-port'
import { switchActiveProfile } from '../../core/agents/profile-switch'
import { refreshAgentRegistry } from '../../core/agents/registry'

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

  // Finding 39: one un-caught Promise.all fed BOTH lists, so any rejection skipped both render
  // calls and left the tab literally blank — the lists are born as empty <div>s. Two reads, two
  // containers, two guards: a failure now names itself in the list it belongs to, and the other
  // list still loads.
  const profilesGuard = createAsyncGuard<[AgentProfile[], readonly AgentInfo[]]>()
  const hostsGuard = createAsyncGuard<RemoteHost[]>()

  /** An error state IS an EmptyState (alert icon + the guard's human sentence + a retry) — the same
   *  primitive the empty lists use, so "we could not ask" can never be read as "you have none". */
  function renderLoadError(host: HTMLElement, title: string, message: string): void {
    host.replaceChildren(
      EmptyState({
        icon: 'alert',
        title,
        body: message,
        action: Button({ label: 'Retry', icon: 'rotate-cw', size: 'sm', onClick: () => void refresh() })
      })
    )
  }

  /** Spinner only when there is nothing real on screen: refresh() also runs after every save and
   *  delete, and a mutation must not blink its own list back to a loading row. */
  function showLoading(host: HTMLElement, label: string): void {
    if (!host.querySelector('.ph-row')) host.replaceChildren(loadingRow(label))
  }

  async function refresh(): Promise<void> {
    await Promise.all([
      // The roster rides with the profiles: it is what the form's provider picker offers.
      profilesGuard.run(() => Promise.all([invoke(ProfileChannels.list) as Promise<AgentProfile[]>, refreshAgentRegistry()]), {
        action: 'load your profiles',
        onLoading: () => showLoading(profilesList, 'Loading profiles…'),
        onSuccess: ([profiles, agents]) => {
          roster = (agents ?? []).filter((a) => a.installed)
          renderProfiles(profiles ?? [])
        },
        onError: (message) => renderLoadError(profilesList, 'Profiles didn’t load', message),
        timeoutMs: 15_000
      }),
      hostsGuard.run(() => invoke(RemoteChannels.list) as Promise<RemoteHost[]>, {
        action: 'load your SSH hosts',
        onLoading: () => showLoading(hostsList, 'Loading SSH hosts…'),
        onSuccess: (hosts) => renderHosts(hosts ?? []),
        onError: (message) => renderLoadError(hostsList, 'SSH hosts didn’t load', message),
        timeoutMs: 15_000
      })
    ])
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
      const deleteButton = detected
        ? null
        : Button({
            label: 'Delete',
            size: 'sm',
            variant: 'ghost',
            onClick: () => {
              deleteButton!.disabled = true
              void (async () => {
                try {
                  const ok = await confirmDialog({
                    title: `Delete profile “${p.name}”?`,
                    message: 'A profile assigned to a saved workspace cannot be deleted until those panes use another profile.',
                    confirmLabel: 'Delete profile',
                    danger: true
                  })
                  if (!ok) return
                  const result = (await invoke(ProfileChannels.remove, p.id)) as ProfileRemoveResult
                  if (!result.ok) {
                    const where = result.workspaces?.length ? ` Used by: ${result.workspaces.join(', ')}.` : ''
                    showToast({
                      tone: 'danger',
                      title: 'Profile was not deleted',
                      body:
                        result.reason === 'referenced'
                          ? `Choose another profile for every saved workspace first.${where}`
                          : result.reason === 'missing'
                            ? 'The profile no longer exists.'
                            : 'The profile could not be deleted.'
                    })
                    return
                  }
                  announceProfilesChanged()
                  await refresh()
                } catch (error) {
                  showToast({ tone: 'danger', title: 'Profile was not deleted', body: String(error) })
                } finally {
                  if (deleteButton?.isConnected) deleteButton.disabled = false
                }
              })()
            }
          })
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
                  onClick: (event) => {
                    const button = event.currentTarget as HTMLButtonElement
                    button.disabled = true
                    button.setAttribute('aria-busy', 'true')
                    void switchActiveProfile(p.provider, p.id)
                      .then(() => refresh())
                      .catch((error) => showToast({ tone: 'danger', title: 'Default profile was not changed', body: String(error) }))
                      .finally(() => {
                        if (!button.isConnected) return
                        button.disabled = false
                        button.removeAttribute('aria-busy')
                      })
                  }
                })
              : null,
            Button({ label: 'Edit', size: 'sm', onClick: () => openProfileForm(p) }),
            // A detected login can't be deleted away — while the CLI stays signed
            // in, the next reconcile would truthfully bring it back.
            deleteButton
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
              text:
                `${h.user ? h.user + '@' : ''}${h.host}${h.port ? ':' + h.port : ''}` +
                ` · ${h.platform ?? 'posix'}/${h.shell ?? 'sh'}`
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
                  message: 'A host assigned to a saved workspace cannot be deleted until those remote panes are changed or removed.',
                  confirmLabel: 'Delete host',
                  danger: true
                }).then((ok) => {
                  if (!ok) return
                  void invoke(RemoteChannels.remove, h.id).then((raw) => {
                    const result = raw as RemoteRemoveResult
                    if (!result.ok) {
                      showToast({
                        tone: 'danger',
                        title: 'SSH host was not deleted',
                        body: result.reason ?? 'The host is still in use.'
                      })
                      return
                    }
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
    // The platform is CONFIRMED, never guessed: a legacy row (no platform) opens with no
    // selection and cannot be saved until the user says what is on the other end. The
    // shell list follows the platform, so the command dialect is always a stated fact.
    const platform = el('select', { class: 'input host-platform' }) as HTMLSelectElement
    platform.append(
      new Option('Select the remote platform…', ''),
      new Option('POSIX (Linux/macOS/BSD)', 'posix'),
      new Option('Windows', 'windows')
    )
    platform.value = existing?.platform ?? ''
    platform.setAttribute('aria-label', 'Confirm which shell platform this SSH host runs')
    const remoteShell = el('select', { class: 'input host-shell' }) as HTMLSelectElement
    const syncShells = (): void => {
      const before = remoteShell.value
      remoteShell.replaceChildren()
      const names = platform.value === 'windows' ? ['powershell', 'cmd'] : ['sh', 'bash', 'zsh']
      for (const value of names) remoteShell.append(new Option(value, value))
      remoteShell.value = names.includes(before) ? before : names[0]
    }
    syncShells()
    if (existing?.shell) remoteShell.value = existing.shell
    platform.onchange = syncShells
    const save = Button({
      label: existing ? 'Save host' : 'Add host',
      variant: 'primary',
      ariaLabel: 'Save host',
      onClick: () => {
        if (!platform.value) {
          showError(err, 'Confirm the remote shell platform before saving this host.')
          return
        }
        const remote: RemoteHost = {
          id: existing?.id ?? newId('host'),
          name: name.value.trim(),
          host: host.value.trim(),
          user: user.value.trim() || undefined,
          port: port.value.trim() ? Number(port.value) : undefined,
          platform: platform.value as RemoteHost['platform'],
          shell: remoteShell.value as RemoteHost['shell'],
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
          FieldGroup({ label: 'Remote operating system', hint: 'required for terminal integration' }, platform),
          FieldGroup({ label: 'Remote shell' }, remoteShell),
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
