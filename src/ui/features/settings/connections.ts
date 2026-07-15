import {
  ConnectionsChannels,
  connectionAccount,
  connectionScopes,
  connectionSummary,
  NO_ACCOUNT_NOTE,
  type Connection,
  type ConnectionState
} from '@contracts'
import { getBridge } from '../../core/ipc/bridge'
import { EmptyState, el, icon, loadingRow, providerLogo, showToast } from '../../components'

/**
 * Settings § Connections (ADR 0014) — the page's new first citizen.
 *
 * A card here is a CONNECTION TO AN ACCOUNT, and nothing else. It is deliberately
 * not a CLI knob: there is no "which CLIs?" checkbox, no config preview, no apply
 * button. You connect your Sentry account to the APP, once, and the card tells you
 * the truth about it — who you are, how many tools the server actually served, and
 * when the grant renews. Which CLIs then RECEIVE the connection is a tool-plan
 * question, and it lives where every other scoping question lives, below.
 *
 * Everything on a card was answered by the server. Nothing is inferred from the
 * presence of a config block, and nothing is scraped out of a CLI's stdout.
 */

const STATE_LABEL: Record<ConnectionState, string> = {
  connected: 'connected',
  connecting: 'connecting…',
  disconnected: 'not connected',
  expired: 'expired',
  error: 'error'
}

export interface ConnectionsBlock {
  block: HTMLElement
  sync: () => void
}

export function createConnectionsBlock(onChange?: (cs: Connection[]) => void): ConnectionsBlock {
  const bridge = getBridge()
  const grid = el('div', { class: 'conn-grid' })
  let connections: Connection[] = []
  /** Which cards have their key form open — a repaint must not close a form the
   *  user is mid-paste in. Keyed by service, not by node: the node is rebuilt. */
  const keyFormOpen = new Set<string>()
  /** What the user has TYPED into an open form, keyed by service. The grid repaints
   *  wholesale on every push — any connection changing state rebuilds every card's
   *  DOM — and an input rebuilt empty is a pasted key eaten mid-thought. The draft
   *  survives the rebuild; it dies on success or an explicit close, never sooner. */
  const drafts = new Map<string, { key: string; url: string }>()
  const draftFor = (id: string): { key: string; url: string } => {
    const d = drafts.get(id) ?? { key: '', url: '' }
    drafts.set(id, d)
    return d
  }
  /** Which cards have their tool list expanded — same repaint-survival rule. */
  const toolsOpen = new Set<string>()

  async function refresh(): Promise<void> {
    connections = ((await bridge.invoke(ConnectionsChannels.list)) as Connection[]) ?? []
    paint()
  }

  function paint(): void {
    grid.innerHTML = ''
    if (!connections.length) {
      grid.append(EmptyState({ icon: 'plug', title: 'No services to connect', body: 'The catalog is empty.' }))
      return
    }
    for (const c of connections) grid.append(card(c))
    onChange?.(connections)
  }

  function card(c: Connection): HTMLElement {
    const chip = el('span', { class: `conn-chip is-${c.state}`, text: STATE_LABEL[c.state] })
    const head = el('div', { class: 'conn-card-head' }, [
      providerLogo(c.id, 16),
      el('span', { class: 'conn-label', text: c.label }),
      chip
    ])
    // WHOSE account — the line the user is actually here to read. It gets its own row,
    // above everything else, because "am I connected as the right account?" is the
    // question a connection card exists to answer. When the provider never told us, the
    // blank is EXPLAINED rather than left silent; we never fill it with a guess.
    // No identity row for a `local` connection: an open server has no account, so
    // "signed in as nobody" would be a false sentence where no sentence is due.
    const who = connectionAccount(c)
    const identity =
      c.state === 'connected' && c.authKind !== 'local'
        ? el('div', { class: `conn-account${who ? '' : ' is-unknown'}` }, [
            icon(who ? 'user' : 'info', 13),
            el('span', { text: who ?? NO_ACCOUNT_NOTE })
          ])
        : null

    // ONE sentence, written by the contract — so "connected" can never be worded
    // two different ways by two different pens.
    const summary = el('div', { class: `conn-summary${c.state === 'error' ? ' is-error' : ''}`, text: connectionSummary(c) })

    // What the grant can DO. Being signed in as the right person with the wrong powers
    // is still the wrong connection, and this is the only place a user can see which.
    const grantScopes = connectionScopes(c)
    const scopeLine = grantScopes.length
      ? el('div', {
          class: 'conn-scopes',
          text: `Can: ${grantScopes.join(' · ')}`,
          attrs: { title: grantScopes.join('\n') }
        })
      : null

    // Full observability: the actual TOOL NAMES this connection serves — what an
    // agent can really do through it, listed by the server itself, not a bare count.
    let toolsBlock: HTMLElement | null = null
    if (c.state === 'connected' && c.tools?.length) {
      const open = toolsOpen.has(c.id)
      const toggle = el('button', {
        class: 'conn-tools-toggle',
        type: 'button',
        text: `${open ? '▾' : '▸'} ${c.tools.length}${(c.toolCount ?? 0) > c.tools.length ? ` of ${c.toolCount}` : ''} tools`,
        attrs: { 'aria-expanded': String(open) }
      }) as HTMLButtonElement
      toggle.onclick = (): void => {
        if (toolsOpen.has(c.id)) toolsOpen.delete(c.id)
        else toolsOpen.add(c.id)
        paint()
      }
      toolsBlock = el('div', { class: 'conn-tools' }, [
        toggle,
        ...(open
          ? [el('div', { class: 'conn-tools-list' }, c.tools.map((t) => el('span', { class: 'conn-tool', text: t })))]
          : [])
      ])
    }

    const actions = el('div', { class: 'conn-actions' })
    const body = el('div', { class: 'conn-card-body' })

    const busy = (btn: HTMLButtonElement, on: boolean, text?: string): void => {
      btn.disabled = on
      if (on) btn.setAttribute('aria-busy', 'true')
      else btn.removeAttribute('aria-busy')
      if (text) btn.textContent = text
    }

    // ── The connect on-ramp. Two shapes of truth: an OAuth service opens the
    // user's browser and finishes LATER (the push repaints); a no-account service
    // has no consent to wait on — connect() returns the final verdict directly.
    const beginConnect = (btn: HTMLButtonElement): void => {
      const local = c.authKind === 'local'
      void (async () => {
        busy(btn, true, local ? 'Connecting…' : 'Opening your browser…')
        try {
          const r = (await bridge.invoke(ConnectionsChannels.connect, { serviceId: c.id })) as {
            ok: boolean
            reason?: string
          }
          if (!r.ok) {
            showToast({ tone: 'danger', title: `${c.label} was not connected`, body: r.reason ?? 'The attempt was refused.' })
            busy(btn, false, 'Connect')
            return
          }
          if (local) return // done for real — the push has already repainted this card
          // Deliberately NOT re-enabled here. The flow is not finished — the user is
          // at a consent screen. The `changed` push repaints this card when they land.
          showToast({
            tone: 'info',
            title: `Finish signing in to ${c.label}`,
            body: 'We opened your browser. The card updates the moment you approve.',
            timeout: 8000
          })
        } catch (e) {
          showToast({ tone: 'danger', title: `${c.label} was not connected`, body: String(e) })
          busy(btn, false, 'Connect')
        }
      })()
    }

    // ── The key on-ramp: paste once, and we PROVE it before claiming success ──
    const keyForm = (): HTMLElement => {
      const draft = draftFor(c.id)
      let urlInput: HTMLInputElement | null = null
      // Self-hosted (n8n, Make): the key means nothing without the instance URL, and
      // this field used to not exist — the submit refused with "paste your instance's
      // MCP URL first" while offering no pixel to paste it into.
      if (c.needsBaseUrl) {
        urlInput = el('input', {
          class: 'browser-sites-input conn-key-input',
          placeholder: 'https://your-instance… (its MCP URL)'
        }) as HTMLInputElement
        urlInput.value = draft.url
        urlInput.setAttribute('aria-label', `${c.label} instance URL`)
        urlInput.spellcheck = false
        urlInput.addEventListener('keydown', (e) => e.stopPropagation())
        urlInput.addEventListener('input', () => (draft.url = urlInput!.value))
      }
      const input = el('input', { class: 'browser-sites-input conn-key-input', placeholder: 'paste your API key…' }) as HTMLInputElement
      input.type = 'password'
      input.value = draft.key
      input.addEventListener('keydown', (e) => e.stopPropagation())
      input.addEventListener('input', () => (draft.key = input.value))
      const save = el('button', { class: 'trail-btn is-armed', type: 'button', text: 'Connect' }) as HTMLButtonElement
      // Closing is a CANCEL (the 8/06 form's lesson): the draft dies with it, so a
      // half-typed key never sits in memory waiting to reappear next session.
      const close = el('button', { class: 'trail-btn conn-mini', type: 'button', text: 'Close' }) as HTMLButtonElement
      close.onclick = (): void => {
        drafts.delete(c.id)
        keyFormOpen.delete(c.id)
        paint()
      }
      const note = el('div', { class: 'conn-summary is-error', hidden: true, role: 'alert' })
      save.onclick = (): void => {
        const value = input.value
        if (!value.trim()) return
        void (async () => {
          busy(save, true, 'Checking the key…')
          note.hidden = true
          const r = (await bridge.invoke(ConnectionsChannels.submitKey, {
            serviceId: c.id,
            value,
            baseUrl: urlInput?.value.trim() || undefined
          })) as { ok: boolean; reason?: string }
          if (!r.ok) {
            // The key stays in the field AND in the draft: it was pasted once, and a
            // refusal the user can fix (a typo, a wrong scope) must not eat it —
            // not directly, and not via a state-push repaint (main no longer pushes
            // an intermediate state for exactly this reason).
            note.textContent = r.reason ?? 'The key was refused.'
            note.hidden = false
            busy(save, false, 'Connect')
            return
          }
          drafts.delete(c.id) // verified and vaulted — the plaintext leaves the DOM and the draft
          keyFormOpen.delete(c.id)
          showToast({ tone: 'success', title: `${c.label} connected`, body: 'The key is encrypted by your OS keychain.' })
        })()
      }
      return el('div', { class: 'conn-key-form' }, [...(urlInput ? [urlInput] : []), input, save, close, note])
    }

    switch (c.state) {
      case 'connected': {
        const check = el('button', { class: 'trail-btn conn-mini', type: 'button', text: 'Check' }) as HTMLButtonElement
        check.onclick = (): void => {
          void (async () => {
            busy(check, true, 'Checking…')
            await bridge.invoke(ConnectionsChannels.verify, c.id)
            busy(check, false, 'Check')
          })()
        }
        const drop = el('button', { class: 'trail-btn trail-clear conn-mini', type: 'button', text: 'Disconnect' }) as HTMLButtonElement
        drop.onclick = (): void => {
          void (async () => {
            busy(drop, true, 'Disconnecting…')
            await bridge.invoke(ConnectionsChannels.disconnect, c.id)
            showToast({
              tone: 'info',
              title: `${c.label} disconnected`,
              // Say exactly what we did and did NOT do. We drop OUR credential; we
              // cannot promise the vendor forgot the grant, so we don't imply it.
              body: 'The credential was deleted from this machine. To revoke it at the provider too, sign out there.'
            })
          })()
        }
        actions.append(check, drop)
        break
      }
      case 'connecting': {
        actions.append(loadingRow('Waiting for you to finish in the browser…'))
        // Without this, an abandoned consent held the card hostage for the full
        // 5-minute timeout with nothing to click.
        const cancel = el('button', { class: 'trail-btn conn-mini', type: 'button', text: 'Cancel' }) as HTMLButtonElement
        cancel.onclick = (): void => {
          void bridge.invoke(ConnectionsChannels.cancel, c.id)
        }
        actions.append(cancel)
        break
      }
      // disconnected | expired | error — all three offer the same verbs, worded for
      // where the user actually is.
      default: {
        const takesKey = c.authKind === 'key' || c.hasKeyOption
        if (takesKey && keyFormOpen.has(c.id)) {
          body.append(keyForm())
          break
        }
        const label = c.state === 'expired' || c.state === 'error' ? 'Reconnect' : 'Connect'
        if (c.authKind === 'key') {
          const open = el('button', { class: 'trail-btn is-armed', type: 'button', text: label }) as HTMLButtonElement
          open.onclick = (): void => {
            keyFormOpen.add(c.id)
            paint()
          }
          actions.append(open)
        } else {
          // `oauth` and `local` both connect through the same verb; the handler
          // words the wait honestly for each.
          const btn = el('button', { class: 'trail-btn is-armed', type: 'button', text: label }) as HTMLButtonElement
          btn.onclick = (): void => beginConnect(btn)
          actions.append(btn)
          // A dual-auth service (GitHub's PAT, Sentry's auth token): the key path
          // EXISTED in main but had no pixel — this ghost button is its on-ramp.
          if (c.hasKeyOption) {
            const useKey = el('button', { class: 'trail-btn conn-mini', type: 'button', text: 'Use API key…' }) as HTMLButtonElement
            useKey.onclick = (): void => {
              keyFormOpen.add(c.id)
              paint()
            }
            actions.append(useKey)
          }
        }
      }
    }

    return el('div', { class: `conn-card is-${c.state}`, dataset: { connection: c.id } }, [
      head,
      ...(identity ? [identity] : []),
      summary,
      ...(scopeLine ? [scopeLine] : []),
      ...(toolsBlock ? [toolsBlock] : []),
      body,
      ...(actions.childNodes.length ? [actions] : [])
    ])
  }

  const block = el('div', { class: 'trail-block conn-block' }, [
    el('div', {
      class: 'settings-row-caption',
      text:
        'Connect a service to MoggingLabs Workspace once, and every agent you launch can use it — no CLI to configure, no key to copy around. Sign-in happens in your own browser, on the provider’s real page. The credential is encrypted by your OS keychain and stays in this app: your CLIs reach the service through us, so no token is ever written into a CLI’s config file.'
    }),
    grid
  ])

  // The browser lands back here. This push is what turns "click Connect" into
  // something you can SEE: the card repaints the moment the grant is real.
  bridge.on(ConnectionsChannels.changed, (payload) => {
    connections = (payload as Connection[]) ?? []
    paint()
  })

  const sync = (): void => void refresh()
  setTimeout(sync, 0)
  return { block, sync }
}

/** The overview band's one-glance number. */
export const connectedCount = (cs: Connection[]): number => cs.filter((c) => c.state === 'connected').length
