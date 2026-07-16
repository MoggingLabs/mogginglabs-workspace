import { AccountChannels, EntitlementsChannels, type AccountLoginResult, type AccountStatus, type EntitlementsSnapshot } from '@contracts'
import { Button, Card, SectionHeader, el, icon, showToast } from '../../components'
import { getBridge } from '../../core/ipc/bridge'
import { entitlementsSnapshot } from '../../core/entitlements/entitlements-store'

// Settings › Account (phase-accounts/10) — the ONE surface that says who is signed in
// and what plan this install actually runs. CLAIMS ONLY, by construction: everything
// here comes from `account:status` and the entitlements snapshot — there is no token
// to display because no channel can return one (ADR 0015 §3).
//
// The degradation law is a UI law here too (ADR 0015 §4): at most ONE quiet line ever
// explains why a plan is not being honored — grace, device mismatch, revocation, or a
// failed integrity check — and the free core is never described as at risk, because it
// never is. Sign-in runs in the user's own browser (PKCE); the app never sees a
// password, and the button says so.

/** The one honest line (or none). Priority: the causes that need action before the
 *  ones that resolve themselves. Copy states what changed and what did not — never
 *  a nag, never a countdown. */
function degradeLine(snap: EntitlementsSnapshot): { text: string; reason: string } | null {
  if (snap.reason === 'tampered')
    return {
      reason: 'tampered',
      text: 'This install failed its integrity check, so paid features are paused. The free app is unaffected — reinstalling restores your plan.'
    }
  if (snap.reason === 'device_mismatch')
    return {
      reason: 'device_mismatch',
      text: 'Your plan was activated on a different computer, so this install runs as Free. Sign in on this machine to activate it here.'
    }
  if (snap.reason === 'revoked')
    return { reason: 'revoked', text: 'Your plan was deactivated by the service, so this install runs as Free.' }
  if (snap.graceState === 'grace' && snap.plan !== 'free')
    return {
      reason: 'grace',
      text: 'Offline — your plan is honored through the grace window. Past it the app simply runs as Free; nothing locks.'
    }
  if (snap.reason === 'grace_expired')
    return {
      reason: 'grace_expired',
      text: 'Your plan could not be refreshed for a while, so the app runs as Free. It picks your plan back up on the next successful refresh.'
    }
  return null
}

export function createAccountSection(): HTMLElement & { refresh: () => Promise<void> } {
  let status: AccountStatus = { state: 'anon' }

  const statusLine = el('div', { class: 'account-status' })
  const statusHint = el('p', { class: 'toggle-row-hint account-hint' })
  const planBadge = el('span', { class: 'pill plan-badge' })
  const noteBox = el('div', { class: 'settings-note account-note', hidden: true })
  const actionBtn = Button({ label: 'Sign in', size: 'sm', onClick: () => void act() })
  actionBtn.classList.add('account-action')

  async function act(): Promise<void> {
    actionBtn.disabled = true
    try {
      if (status.state === 'authed') {
        await getBridge().invoke(AccountChannels.logout)
        return // the push re-renders
      }
      const started = (await getBridge().invoke(AccountChannels.login)) as AccountLoginResult
      if (!started.ok) {
        showToast({ tone: 'attention', title: 'Sign-in did not start', body: started.reason ?? 'Try again.' })
        return
      }
      showToast({ tone: 'info', title: 'Continue in your browser', body: 'Finish signing in there — this page updates by itself.' })
    } catch (e) {
      showToast({ tone: 'danger', title: 'Sign-in failed', body: String(e) })
    } finally {
      actionBtn.disabled = false
    }
  }

  function render(): void {
    const snap = entitlementsSnapshot()
    const authed = status.state === 'authed'
    statusLine.textContent = authed ? (status.email ?? 'Signed in') : 'Not signed in'
    statusHint.textContent = authed
      ? 'Signed in to MoggingLabs — for the Pro tier only, never your CLI logins (ADR 0002).'
      : 'The free core never needs an account. Sign-in runs in your own browser — the app never sees a password.'
    actionBtn.textContent = authed ? 'Sign out' : 'Sign in'
    actionBtn.setAttribute('aria-label', authed ? 'Sign out of MoggingLabs' : 'Sign in to MoggingLabs')
    // The plan badge states the EFFECTIVE plan (the entitlement engine's answer) —
    // never the IdP's plan claim, which is marketing until a signed claim backs it.
    const plan = snap.plan || 'free'
    planBadge.textContent = plan.charAt(0).toUpperCase() + plan.slice(1)
    planBadge.classList.toggle('pill--accent', plan !== 'free')
    const line = degradeLine(snap)
    noteBox.hidden = !line
    noteBox.dataset.reason = line?.reason ?? ''
    noteBox.replaceChildren(icon('info', 14), el('span', { text: line?.text ?? '' }))
  }

  async function refresh(): Promise<void> {
    try {
      const s = (await getBridge().invoke(AccountChannels.status)) as AccountStatus
      if (s && (s.state === 'anon' || s.state === 'authed')) status = s
    } catch {
      /* bridge unavailable (tests) — anon stands */
    }
    render()
  }

  // Start the entitlements STORE before subscribing: same-channel listeners fire in
  // registration order, so the store's must precede ours or every re-render reads the
  // PREVIOUS snapshot — a one-push lag the gallery photographed before this line existed.
  entitlementsSnapshot()
  try {
    const bridge = getBridge()
    bridge.on(AccountChannels.changed, (payload) => {
      const s = payload as AccountStatus | null
      if (s && (s.state === 'anon' || s.state === 'authed')) status = { state: s.state, email: s.email, plan: s.plan }
      // A FAILED sign-in rides the push as one transient sentence (AccountStatus.reason,
      // push-only): without it, the browser tab was the only witness — the app said
      // "continue in your browser" and then nothing, forever.
      if (s?.reason) showToast({ tone: 'attention', title: 'Sign-in failed', body: s.reason })
      render()
    })
    // This subscription only schedules a re-render off the (already-updated) store.
    bridge.on(EntitlementsChannels.changed, () => render())
  } catch {
    /* non-Electron host (tests): static render below */
  }

  const body = el('div', { class: 'account-panel' }, [
    el('div', { class: 'account-row' }, [
      el('div', { class: 'account-who' }, [statusLine, statusHint]),
      actionBtn
    ]),
    el('div', { class: 'account-plan-row' }, [el('span', { class: 'account-plan-label', text: 'Plan' }), planBadge]),
    noteBox
  ])

  const section = Card(
    {
      header: SectionHeader({
        title: 'MoggingLabs account',
        caption:
          'For the optional Pro tier only. The free local core needs no account and works fully offline — signing out (or never signing in) costs you nothing it has.'
      })
    },
    [body]
  ) as HTMLElement & { refresh: () => Promise<void> }

  // I7: this section is CONSTRUCTED at boot (settingsFeature mounts with the shell), so it
  // fires NO IPC here. The sync render paints the anon/Free default; the live `status` is
  // pulled by `refresh()` only when Settings is actually entered (index.ts onViewChange),
  // and pushes keep it current in between. Nothing new touches the boot critical path.
  render()
  section.refresh = refresh
  return section
}
