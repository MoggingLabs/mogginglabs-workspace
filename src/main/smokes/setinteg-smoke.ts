import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { emitBridgeEvent, saveWebhook } from '../event-bridge'

// Env-gated Integrations smoke (MOGGING_SETINTEG, Phase-8.5/05). The tab was the
// audit's only F: 1174 lines rendering nine sections at once. It is now an overview
// band plus five folded Cards — the event bridge and the activity trail earned
// their OWN tabs (Webhooks under Agents & tools, Activity under Trust). This gate
// asserts the restructure did not cost a single behavior — and that what stayed
// folded never buries a signal.
//
//   (a) the overview band's stats come from real fixtures, not placeholders;
//   (b) sections collapse/expand and the choice survives a leave/return;
//   (c) a FAILING webhook reads 'failing' on its own tab — per-row health on an
//       always-open page; there is no fold left to bury it under;
//   (d) every DOM hook INTEGUX / WEBTRAIL / the gallery key off still resolves —
//       the trail hooks on the Activity tab, the rest inside Integrations' cards;
//   (e) MEASURED: `.mgr-chip` and the trail's `.trail-btn` clear a 28px hit
//       target, and adjacent cards sit >= --sp-4 apart.
//
// (e) is the whole point of the hitbox work. `.mgr-chip { padding: 1px … }` and
// `.trail-btn { padding: 2px … }` use px literals the spacing gate SANCTIONS, so
// check-spacing.mjs reads both rules as clean while they render an 18.5px and a
// 20.5px button. A gate that measures declarations cannot see a hit target. This one
// measures the box.
//
// Zero network: the failing webhook points at a closed loopback port, so delivery
// dies on ECONNREFUSED without a packet leaving the machine.

const HIT = 28

export function runSetIntegSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 180000) // safety net
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const waitTrue = async (js: string, tries = 24, gap = 250): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      if (await ES<boolean>(js).catch(() => false)) return true
      await sleep(gap)
    }
    return false
  }

  /** Selectors a pre-existing gate or the gallery reads out of the Integrations tab. */
  const INTEG_HOOKS = [
    '.integux-intro',
    '.integux-intro .integux-setup-cta',
    '.integux-privacy',
    '.integux-empty', // INTEGUX calls this one DoD-critical
    '.toolplan-empty'
  ]
  /** …and out of the Activity tab (WEBTRAIL's whole stage h lives here now). */
  const ACTIVITY_HOOKS = ['.trail-activity', '.trail-activity .trail-btn', '.trail-ws', '.trail-list']

  const openSettings = async (tab = 'integrations'): Promise<void> => {
    await ES(`(document.querySelector('.titlebar-right .icon-btn[aria-label="Settings"]')?.click(), 1)`)
    await sleep(400)
    await ES(`(document.querySelector('.settings-nav-item[data-target="${tab}"]')?.click(), 1)`)
    await sleep(400)
  }
  const showTab = async (tab: string): Promise<void> => {
    await ES(`(document.querySelector('.settings-nav-item[data-target="${tab}"]')?.click(), 1)`)
    await sleep(400)
  }
  const leaveAndReturn = async (): Promise<void> => {
    await ES(`document.querySelector('.settings-back')?.click()`) // the same exit SETSHELL uses
    await sleep(300)
    await openSettings()
  }
  const cardOpen = (id: string): Promise<boolean> =>
    ES<boolean>(`document.querySelector('.collapsible-card[data-collapsible="${id}"]')?.classList.contains('is-open') === true`)
  const toggle = (id: string): Promise<unknown> =>
    ES(`(document.querySelector('.collapsible-card[data-collapsible="${id}"] .cc-toggle')?.click(), 1)`)

  let result: Record<string, unknown> = { pass: false }

  const run = async (): Promise<void> => {
    try {
      await sleep(1500)
      await ES('window.__mogging.workspace.create({ name: "Alpha" })')
      await sleep(1000)
      const wsId = (await ES<{ id: string }>('window.__mogging.workspace.active()')).id

      // ── the offline failing-webhook fixture ────────────────────────────────
      // Port 1 on loopback: nothing listens, the connect refuses instantly, and no
      // packet ever leaves the host. Health flips to 'failing' after its retries.
      const saved = saveWebhook({ label: 'dead-hook', url: 'http://127.0.0.1:1/hook', events: ['notify'] })
      emitBridgeEvent('notify', { workspace: wsId, note: 'fixture' })

      // Seed the OTHER kind of attention. Every house preset carries a `verifiedAt`, so
      // `.cat-badge.is-draft` never appears on a stock catalog — an imported preset gets
      // `verifiedAt: ''` and is the only way to raise it. Create the condition; do not
      // assert a state the fixture cannot produce.
      const imported = await ES<{ ok: boolean; reason?: string }>(
        `window.bridge.invoke('integrations:cat:import', JSON.stringify({ id: 'fixture-community', label: 'Fixture (community)', transport: 'http', urlOrCommand: 'https://mcp.example.dev/sse', authKinds: ['none'] }))`
      )

      await openSettings()

      // ── (d) every legacy Integrations hook resolves, cards folded shut ──────
      const hooks: Record<string, boolean> = {}
      for (const sel of INTEG_HOOKS) hooks[sel] = await waitTrue(`!!document.querySelector(${JSON.stringify(sel)})`)

      // ── (a) the overview band reads from fixtures, not placeholders ─────────
      // Two stats since the split (Servers · Service keys) — webhooks and the
      // trail report on their own tabs now.
      const statsOk = await waitTrue(
        `[...document.querySelectorAll('.integux-stats .integux-stat-value')].length === 2 &&
         [...document.querySelectorAll('.integux-stats .integux-stat-value')].every(e => (e.textContent||'').trim() && e.textContent.trim() !== '—')`
      )

      // The imported preset renders `.cat-badge.is-draft`, and its chip proves the
      // INFORMATIONAL path: attention that surfaces on the header WITHOUT prising the
      // section open. Assert both halves — a chip that force-opened would be a bug.
      const draftBadge = await waitTrue(`!!document.querySelector('.cat-badge.is-draft')`)
      const draftChip = await waitTrue(`!!document.querySelector('.collapsible-card[data-collapsible="catalog"] .cc-attn .cc-chip.is-draft')`)
      // Every section that can raise attention must be able to render its chip. A
      // signal wired in one place and forgotten in another is how `.cat-badge.is-draft`
      // nearly shipped counted-but-never-emitted.
      const wiredSections = await ES<string[]>(
        `[...document.querySelectorAll('.collapsible-card')].map(c => c.dataset.collapsible)`
      )
      const sectionsOk = ['catalog', 'servers', 'matrix', 'grants', 'keys'].every((id) => wiredSections.includes(id))

      // ── (b) disclosure persists across a leave/return ───────────────────────
      const catalogOpenByDefault = await cardOpen('catalog')
      await toggle('catalog')
      await sleep(150)
      await toggle('grants')
      await sleep(150)
      await leaveAndReturn()
      const persistOk =
        catalogOpenByDefault && !(await cardOpen('catalog')) && (await cardOpen('grants')) && !(await cardOpen('keys'))

      // ── (e/1) Integrations hit targets, measured on the real box ────────────
      // Cards must be open for a box to exist: a `display:none` body measures 0.
      await ES(`document.querySelectorAll('.collapsible-card:not(.is-open) .cc-toggle').forEach(b => b.click())`)
      await sleep(400)
      const integBoxes = await ES<{ mgrChip: number | null; gap: number | null }>(`(() => {
        const h = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return r.height ? Math.round(r.height * 100) / 100 : null }
        const cards = [...document.querySelectorAll('#view-settings .integrations-section .collapsible-card')]
        let gap = null
        if (cards.length >= 2) {
          const a = cards[0].getBoundingClientRect(), b = cards[1].getBoundingClientRect()
          gap = Math.round((b.top - a.bottom) * 100) / 100
        }
        return { mgrChip: h('.mgr-chip'), gap }
      })()`)

      // ── (c) the failing webhook reads 'failing' on the Webhooks tab ─────────
      await showTab('webhooks')
      const failingShown = await waitTrue(`!!document.querySelector('.evbridge-health.is-failing')`, 40, 250)
      const hookRowShown = await ES<boolean>(
        `[...document.querySelectorAll('.mgr-row .mgr-label')].some(e => (e.textContent||'').includes('dead-hook'))`
      )
      const attentionOk = failingShown && hookRowShown

      // ── (d/2 + e/2) the Activity tab: WEBTRAIL's hooks, honesty, hit target ──
      await showTab('activity')
      for (const sel of ACTIVITY_HOOKS) hooks[sel] = await waitTrue(`!!document.querySelector(${JSON.stringify(sel)})`)
      const hooksOk = Object.values(hooks).every(Boolean)
      // The trail's retention promise must stay inside `.trail-activity`'s first 4000
      // characters — WEBTRAIL slices exactly that far before searching it.
      const honestyOk = await ES<boolean>(
        `(document.querySelector('.trail-activity')?.textContent || '').slice(0, 4000).includes('never sent anywhere')`
      )
      // The first `.trail-btn` inside the trail card must still be Refresh: WEBTRAIL
      // and the gallery both click it blind, and its neighbours are Export (opens a
      // file dialog, hangs the gate) and Clear (destroys the workspace's trail).
      const refreshFirstOk = await ES<boolean>(
        `/^Refresh$/.test(document.querySelector('.trail-activity .trail-btn')?.textContent?.trim() || '')`
      )
      const trailBtn = await ES<number | null>(
        `(() => { const e = document.querySelector('.trail-activity .trail-btn'); if (!e) return null; const r = e.getBoundingClientRect(); return r.height ? Math.round(r.height * 100) / 100 : null })()`
      )

      const sp4 = await ES<number>(`parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sp-4')) || 16`)
      const hitOk = !!trailBtn && trailBtn >= HIT && (integBoxes.mgrChip === null || integBoxes.mgrChip >= HIT)
      const gapOk = integBoxes.gap !== null && integBoxes.gap >= sp4 - 0.5

      result = {
        pass: saved.ok && imported.ok && hooksOk && honestyOk && refreshFirstOk && statsOk && attentionOk && draftBadge && draftChip && sectionsOk && persistOk && hitOk && gapOk,
        importedOk: imported.ok,
        importedReason: imported.reason ?? null,
        draftBadge,
        draftChip,
        sectionsOk,
        wiredSections,
        savedOk: saved.ok,
        hooksOk,
        honestyOk,
        refreshFirstOk,
        statsOk,
        attentionOk,
        persistOk,
        hitOk,
        gapOk,
        missingHooks: Object.entries(hooks).filter(([, v]) => !v).map(([k]) => k),
        attention: { failingShown, hookRowShown },
        boxes: { ...integBoxes, trailBtn },
        sp4
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'setinteg-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}
