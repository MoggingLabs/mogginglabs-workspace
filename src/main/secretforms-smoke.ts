import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IntegrationsChannels, UsageChannels } from '@contracts'
import { isVaultAvailable } from './vault'
import { keyClear } from './usage-keys'
import { serviceKeyClear } from './service-keys'
import {
  armSecretFormAudit,
  failNextServerRegister,
  failNextVaultWrites,
  resetSecretFormAuditFaults,
  secretFormAuditCounts
} from './secretform-audit-faults'

// Env-gated secret-form smoke (MOGGING_SECRETFORMS, audit finding 35). Four forms in
// this app accept a secret, and every one of them mishandled it on the branch nobody
// clicks in a demo — the REFUSAL:
//
//   (1) Service keys      — cleared the password field BEFORE the await. A refused NAME
//                           destroyed a key that was pasted once and exists nowhere else.
//   (2) Add-server        — TWO bugs. It vaults each `KEY=literal` env pair one at a time,
//                           then registers; a failure at either step left every literal it
//                           had already vaulted ORPHANED (nothing referenced them, nothing
//                           cleared them). And it never reset its inputs AT ALL, so a
//                           pasted literal sat in the hidden form for the whole session —
//                           including after a SUCCESSFUL save — and re-appeared on reopen.
//   (3) Usage key         — cleared before the invoke. Same loss.
//   (4) Webhook URL       — cleared before the await. Same loss (the URL IS the token).
//
// Every assertion here reads REAL IPC list channels for ground truth (serviceKeyList,
// serversList, webhookList, usage configGet) — a form that LOOKS right while the vault
// disagrees is the exact failure this gate exists to catch. Main-side faults are injected
// at the two seams (vault.ts's vaultStore, mcp-manager's serversSave); the app's own
// handlers, validation and refusal strings are untouched.
//
// Zero network: the webhook is saved but never fired (delivery only happens on an emitted
// event), and under any MOGGING_* env the usage registry holds no real adapters.

const KEY_NAME = 'MOG_SECRETFORM_KEY'
const KEY_VALUE = 'sk-secretforms-a1b2c3d4e5f60718' // secret-shaped, fixed for the run
const DBL_NAME = 'MOG_SECRETFORM_DOUBLE'
const DBL_VALUE = 'sk-secretforms-doubleclick-9911'
const ORPHAN_NAME = 'ORPHAN_KEY'
const ORPHAN_VALUE = 'sk-orphan-77c1e0a9d3b2f4a6'
const ORPHAN_PAIR = `${ORPHAN_NAME}=${ORPHAN_VALUE}`
const SERVER_ID = 'sf-fixture'
const SERVER_LABEL = 'SF fixture'
const SERVER_CMD = 'sf-fixture-server'
const CANCEL_PAIR = 'CANCEL_KEY=sk-cancelled-3311aa77bb99'
const USAGE_ID = 'openrouter'
const USAGE_VALUE = 'sk-or-v1-SECRETFORMS-0123456789abcdef'
const HOOK_LABEL = 'secretform-hook'
const HOOK_URL = 'https://hooks.example.dev/sf-secret-path'

// Form hooks (dataset attributes on the forms' own fields — no positional selectors).
const SK_NAME = '[data-mgr-field="key-name"]'
const SK_VALUE = '[data-mgr-field="key-value"]'
const SK_SAVE = '[data-mgr-action="save-key"]'
const SK_ERR = '.collapsible-card[data-collapsible="keys"] .mgr-note'
const SRV_ENV = '[data-mgr-field="env"]'
const SRV_SAVE = '[data-mgr-action="save-server"]'
const SRV_TOGGLE = '[data-mgr-action="add-server"]'
const SRV_FORM = '[data-mgr-form="add-server"]'
const SRV_ERR = '.mgr-save-note'
const USAGE_ROW = `.usage-prov-row[data-provider="${USAGE_ID}"]`
const USAGE_INPUT = `${USAGE_ROW} .usage-key-input`
const USAGE_ERR = `${USAGE_ROW} .usage-key-err`
const WH_LABEL = '[data-wh-field="label"]'
const WH_URL = '[data-wh-field="url"]'
const WH_SAVE = '[data-wh-action="save"]'
const WH_ERR = '[data-section="webhooks"] .mgr-note'

export function runSecretFormsSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 240000) // safety net
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const J = (v: unknown): string => JSON.stringify(v)

  const emit = (o: object): void => {
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'secretforms-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }

  /** Poll a predicate that reads REAL state (never a bare DOM class). */
  const waitFor = async (probe: () => Promise<boolean>, tries = 40, gap = 200): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      if (await probe().catch(() => false)) return true
      await sleep(gap)
    }
    return false
  }

  // ── Ground truth: the app's own list channels, invoked from the renderer ──────
  const serviceKeys = (): Promise<string[]> =>
    ES<string[]>(`window.bridge.invoke(${J(IntegrationsChannels.serviceKeyList)}).then(n => (n || []).map(String))`)
  const serverIds = (): Promise<string[]> =>
    ES<string[]>(`window.bridge.invoke(${J(IntegrationsChannels.serversList)}).then(rows => (rows || []).map(r => String(r.id)))`)
  const serverEnvRef = (id: string, name: string): Promise<string> =>
    ES<string>(
      `window.bridge.invoke(${J(IntegrationsChannels.serversList)})
        .then(rows => String((rows || []).find(r => r.id === ${J(id)})?.env?.[${J(name)}] ?? ''))`
    )
  const webhookMasks = (): Promise<string[]> =>
    ES<string[]>(
      `window.bridge.invoke(${J(IntegrationsChannels.webhookList)})
        .then(rows => (rows || []).filter(w => w.label === ${J(HOOK_LABEL)}).map(w => String(w.urlMask)))`
    )
  const usageKeyKind = (): Promise<string> =>
    ES<string>(
      `window.bridge.invoke(${J(UsageChannels.configGet)})
        .then(c => String((c?.providers || []).find(p => p.id === ${J(USAGE_ID)})?.key ?? 'none'))`
    )

  // ── DOM driving ──────────────────────────────────────────────────────────────
  const value = (sel: string): Promise<string> => ES<string>(`document.querySelector(${J(sel)})?.value ?? ''`)
  const errorShown = (sel: string): Promise<string> =>
    ES<string>(`(() => { const e = document.querySelector(${J(sel)}); return e && !e.hidden ? (e.textContent || '').trim() : '' })()`)
  // Both throw on a missing hook: a gate that silently no-ops its own clicks would report a
  // green "the secret was retained" for a form it never submitted.
  const click = async (sel: string): Promise<void> => {
    const hit = await ES<boolean>(`(() => { const b = document.querySelector(${J(sel)}); if (!b) return false; b.click(); return true })()`)
    if (!hit) throw new Error(`no element for ${sel}`)
  }
  const fill = async (pairs: Record<string, string>): Promise<void> => {
    const missing = await ES<string>(
      `(() => { const p = ${J(pairs)}; for (const [sel, v] of Object.entries(p)) { const i = document.querySelector(sel); if (!i) return sel; i.value = v } return '' })()`
    )
    if (missing) throw new Error(`no field for ${missing}`)
  }
  const openSettings = async (tab: string): Promise<void> => {
    await ES(`(document.querySelector('.titlebar-right .icon-btn[aria-label="Settings"]')?.click(), 1)`)
    await sleep(500)
    await showTab(tab)
  }
  const showTab = async (tab: string): Promise<void> => {
    await ES(`(document.querySelector('.settings-nav-item[data-target="${tab}"]')?.click(), 1)`)
    await sleep(600)
  }
  /** A collapsed card's body is display:none — open every card on the visible tab so the
   *  forms are as reachable to the gate as they are to a user. */
  const openCards = async (): Promise<void> => {
    await ES(
      `(document.querySelectorAll('#view-settings .settings-section:not([hidden]) .collapsible-card:not(.is-open) .cc-toggle').forEach(b => b.click()), 1)`
    )
    await sleep(400)
  }

  /** Every fixture this gate creates, removed. Run BEFORE the gate too: the assertions are
   *  "the vault does NOT contain X", and a leftover X from an earlier run would fail a
   *  correct build (the smoke profile survives between gates). */
  const cleanSlate = async (): Promise<void> => {
    try {
      await ES(`window.bridge.invoke(${J(IntegrationsChannels.serversRemove)}, ${J(SERVER_ID)}).then(() => 1)`)
      await ES(
        `window.bridge.invoke(${J(IntegrationsChannels.webhookList)})
          .then(rows => Promise.all((rows || []).filter(w => w.label === ${J(HOOK_LABEL)})
            .map(w => window.bridge.invoke(${J(IntegrationsChannels.webhookRemove)}, w.id))))
          .then(() => 1)`
      )
    } catch {
      /* the window may already be gone (teardown) */
    }
    for (const name of [KEY_NAME, DBL_NAME, ORPHAN_NAME, 'CANCEL_KEY']) serviceKeyClear(name)
    keyClear(USAGE_ID) // …including a stale env-ref, which would render the saved chip instead of the paste field
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    const ev: Record<string, unknown> = {}
    try {
      // A vault-less machine cannot distinguish "retained because we refused" from
      // "retained because nothing works" — say so instead of passing a hollow run.
      const vaultOk = isVaultAvailable()
      ev.vaultAvailable = vaultOk
      if (!vaultOk) throw new Error('no REAL OS vault on this machine — the secret-form gate needs one')

      await sleep(1500)
      await cleanSlate()
      armSecretFormAudit() // counters on, nothing failing yet
      await openSettings('integrations')
      await openCards()

      // ══ (1) Service keys: a refused vault write must not eat the pasted key ══════
      failNextVaultWrites(1)
      await fill({ [SK_NAME]: KEY_NAME, [SK_VALUE]: KEY_VALUE })
      await click(SK_SAVE)
      const keyErr = await waitFor(async () => (await errorShown(SK_ERR)).length > 0)
      const keyRetained = (await value(SK_VALUE)) === KEY_VALUE // the WHOLE point: still there
      const keyNotStored = !(await serviceKeys()).includes(KEY_NAME) // …and the vault agrees it is not saved
      ev.serviceKeyRefusal = { keyErr, keyRetained, keyNotStored, reason: await errorShown(SK_ERR) }

      // …and the retry (nothing armed) saves the SAME field, then clears it.
      await click(SK_SAVE)
      const keySaved = await waitFor(async () => (await serviceKeys()).includes(KEY_NAME))
      const keyCleared = (await value(SK_VALUE)) === '' && (await value(SK_NAME)) === ''
      const keyErrGone = (await errorShown(SK_ERR)) === ''
      ev.serviceKeyRetry = { keySaved, keyCleared, keyErrGone }

      // ══ Double-submit: one click's worth of vault writes, whatever the mouse does ══
      const before = secretFormAuditCounts().vaultWrites
      // Both clicks in ONE evaluation: the first is still in flight (a real IPC hop) when
      // the second lands — exactly the race a fast double-click creates.
      const disabledSync = await ES<boolean>(`(() => {
        const name = document.querySelector(${J(SK_NAME)})
        const val = document.querySelector(${J(SK_VALUE)})
        const save = document.querySelector(${J(SK_SAVE)})
        name.value = ${J(DBL_NAME)}
        val.value = ${J(DBL_VALUE)}
        save.click()
        const busy = save.disabled === true   // disabled SYNCHRONOUSLY, in the click's own task
        save.click()                          // …so this one cannot reach the handler
        return busy
      })()`)
      const dblSaved = await waitFor(async () => (await serviceKeys()).includes(DBL_NAME))
      await sleep(400) // give a (bugged) second write time to land before we count
      const dblWrites = secretFormAuditCounts().vaultWrites - before
      ev.doubleSubmit = { disabledSync, dblSaved, dblWrites }

      // ══ (2) Add-server: the ORPHAN. The literal really vaults, then the register fails ══
      const keysBeforeOrphan = await serviceKeys()
      const writesBeforeOrphan = secretFormAuditCounts().vaultWrites
      failNextServerRegister(1) // ONLY the register — the vault write must succeed
      await click(SRV_TOGGLE) // open the form
      await sleep(200)
      await fill({
        '[data-mgr-field="id"]': SERVER_ID,
        '[data-mgr-field="label"]': SERVER_LABEL,
        '[data-mgr-field="command"]': SERVER_CMD,
        [SRV_ENV]: ORPHAN_PAIR
      })
      await click(SRV_SAVE)
      const srvErr = await waitFor(async () => (await errorShown(SRV_ERR)).length > 0)
      // The literal REACHED the vault (a main-side write, counted at the seam) — so the
      // orphan condition really existed and the rollback below is not a no-op.
      const literalWasVaulted = secretFormAuditCounts().vaultWrites - writesBeforeOrphan === 1
      const envRetained = (await value(SRV_ENV)) === ORPHAN_PAIR
      const serverNotSaved = !(await serverIds()).includes(SERVER_ID)
      // THE assertion: the vault no longer holds a key nothing references.
      const orphanRolledBack = await waitFor(async () => !(await serviceKeys()).includes(ORPHAN_NAME))
      ev.orphan = {
        srvErr,
        literalWasVaulted,
        envRetained,
        serverNotSaved,
        orphanRolledBack,
        hadOrphanBefore: keysBeforeOrphan.includes(ORPHAN_NAME),
        reason: await errorShown(SRV_ERR)
      }

      // …retry unfaulted: it registers, the literal is vaulted for real, the config
      // references ${ORPHAN_KEY} and the form is left with NO plaintext in it.
      await click(SRV_SAVE)
      const serverSaved = await waitFor(async () => (await serverIds()).includes(SERVER_ID))
      const orphanNowStored = (await serviceKeys()).includes(ORPHAN_NAME)
      const envRefWritten = (await serverEnvRef(SERVER_ID, ORPHAN_NAME)) === `\${${ORPHAN_NAME}}`
      const envClearedAfterSave = (await value(SRV_ENV)) === ''
      const formHidden = await ES<boolean>(`document.querySelector(${J(SRV_FORM)})?.hidden === true`)
      // Reopen: the resident-plaintext bug. The node was never destroyed, only hidden.
      await click(SRV_TOGGLE)
      await sleep(250)
      const reopenEmpty = await ES<boolean>(`(() => {
        const f = document.querySelector(${J(SRV_FORM)})
        if (!f || f.hidden) return false
        return [...f.querySelectorAll('input')].every(i => i.value === '')
      })()`)
      ev.addServerSuccess = { serverSaved, orphanNowStored, envRefWritten, envClearedAfterSave, formHidden, reopenEmpty }

      // …and CANCEL: a half-filled form scrubs on the way out (the form is still open).
      await fill({ [SRV_ENV]: CANCEL_PAIR })
      await click(SRV_TOGGLE) // collapse == cancel
      await sleep(250)
      const cancelScrubbed =
        (await ES<boolean>(`document.querySelector(${J(SRV_FORM)})?.hidden === true`)) && (await value(SRV_ENV)) === ''
      const cancelNotVaulted = !(await serviceKeys()).includes('CANCEL_KEY')
      ev.cancel = { cancelScrubbed, cancelNotVaulted }

      // ══ (3) Usage provider key ═══════════════════════════════════════════════════
      await showTab('usage')
      await sleep(300)
      await openCards()
      const gridUp = await waitFor(async () => (await ES<number>(`document.querySelectorAll('.usage-prov-row').length`)) > 0)
      failNextVaultWrites(1)
      // Set + click in ONE evaluation: an async grid re-render must not swap the node between.
      await ES(`(() => {
        const i = document.querySelector(${J(USAGE_INPUT)})
        const b = [...document.querySelectorAll(${J(`${USAGE_ROW} .usage-key-ctl .btn`)})].find(x => x.textContent.trim() === 'Save')
        if (!i || !b) return 0
        i.value = ${J(USAGE_VALUE)}
        b.click()
        return 1
      })()`)
      const usageErr = await waitFor(async () => (await errorShown(USAGE_ERR)).length > 0)
      const usageRetained = (await value(USAGE_INPUT)) === USAGE_VALUE
      const usageNotStored = (await usageKeyKind()) === 'none' // presence readback, not the DOM
      ev.usageRefusal = { gridUp, usageErr, usageRetained, usageNotStored, reason: await errorShown(USAGE_ERR) }

      // …retry unfaulted: saved, and the row repaints as the masked chip (the input is GONE,
      // which is this form's version of "the secret left the DOM").
      await ES(
        `(() => { const b = [...document.querySelectorAll(${J(`${USAGE_ROW} .usage-key-ctl .btn`)})].find(x => x.textContent.trim() === 'Save'); if (!b) return 0; b.click(); return 1 })()`
      )
      const usageSaved = await waitFor(async () => (await usageKeyKind()) === 'keychain')
      const usageMasked = await waitFor(async () =>
        ES<boolean>(
          `!!document.querySelector(${J(`${USAGE_ROW} .usage-key-saved`)}) && !document.querySelector(${J(`${USAGE_ROW} input[type="password"]`)})`
        )
      )
      ev.usageRetry = { usageSaved, usageMasked }

      // ══ (4) Webhook URL ══════════════════════════════════════════════════════════
      await showTab('webhooks')
      failNextVaultWrites(1)
      await fill({ [WH_LABEL]: HOOK_LABEL, [WH_URL]: HOOK_URL })
      await click(WH_SAVE)
      const hookErr = await waitFor(async () => (await errorShown(WH_ERR)).length > 0)
      const hookRetained = (await value(WH_URL)) === HOOK_URL
      const hookNotStored = (await webhookMasks()).length === 0
      ev.webhookRefusal = { hookErr, hookRetained, hookNotStored, reason: await errorShown(WH_ERR) }

      // …retry unfaulted: it lands, MASKED (host only — the secret path never comes back).
      await click(WH_SAVE)
      const hookSaved = await waitFor(async () => (await webhookMasks()).length === 1)
      const masks = await webhookMasks()
      const hookMaskedOk = masks.length === 1 && masks[0].includes('hooks.example.dev') && !masks[0].includes('sf-secret-path')
      const hookCleared = (await value(WH_URL)) === '' && (await value(WH_LABEL)) === ''
      ev.webhookRetry = { hookSaved, hookMaskedOk, hookCleared, mask: masks[0] ?? '' }

      const pass =
        // (1) refusal retains + the vault agrees; the retry saves and only then clears
        keyErr && keyRetained && keyNotStored && keySaved && keyCleared && keyErrGone &&
        // double-submit: one write
        disabledSync && dblSaved && dblWrites === 1 &&
        // (2) the orphan: really vaulted, really rolled back, nothing registered
        srvErr && literalWasVaulted && envRetained && serverNotSaved && orphanRolledBack &&
        serverSaved && orphanNowStored && envRefWritten && envClearedAfterSave && formHidden && reopenEmpty &&
        cancelScrubbed && cancelNotVaulted &&
        // (3) usage
        gridUp && usageErr && usageRetained && usageNotStored && usageSaved && usageMasked &&
        // (4) webhooks
        hookErr && hookRetained && hookNotStored && hookSaved && hookMaskedOk && hookCleared
      result = { pass, ...ev }
    } catch (error) {
      result = { pass: false, error: String(error), ...ev }
    } finally {
      // Faults off FIRST: the teardown below writes nothing, but a gate that exits with an
      // armed seam would poison whatever runs next in this process.
      resetSecretFormAuditFaults()
      await cleanSlate() // the fixture must not outlive the run — a stray vault key here would be an orphan of our own making
    }
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}
