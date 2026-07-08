import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { emitBridgeEvent, saveWebhook } from './event-bridge'

// Env-gated Integrations smoke (MOGGING_SETINTEG, Phase-8.5/05). The tab was the
// audit's only F: 1174 lines rendering nine sections at once. It is now an overview
// band plus seven folded Cards. This gate asserts the restructure did not cost a
// single behavior — and that folding never buries a signal.
//
//   (a) the overview band's three stats come from real fixtures, not placeholders;
//   (b) sections collapse/expand and the choice survives a leave/return;
//   (c) a FAILING webhook auto-expands its section AND its chip stays on the header
//       after you fold it again — attention beats persistence, and collapse != hide;
//   (d) every DOM hook INTEGUX / WEBTRAIL / the gallery key off still resolves —
//       INCLUDING from inside a collapsed card, because the body is hidden, not unbuilt;
//   (e) MEASURED: `.mgr-chip` and `.trail-btn` clear a 28px hit target, and adjacent
//       cards sit >= --sp-4 apart.
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

  /** Every selector a pre-existing gate or the gallery reads out of this tab. */
  const HOOKS = [
    '.integux-intro',
    '.integux-intro .integux-setup-cta',
    '.integux-privacy',
    '.integux-empty', // INTEGUX calls this one DoD-critical
    '.toolplan-empty',
    '.trail-activity',
    '.trail-activity .trail-btn',
    '.trail-ws',
    '.trail-list'
  ]

  const openSettings = async (): Promise<void> => {
    await ES(`(document.querySelector('.titlebar-right .icon-btn[aria-label="Settings"]')?.click(), 1)`)
    await sleep(400)
    await ES(`(document.querySelector('.settings-nav-item[data-target="integrations"]')?.click(), 1)`)
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

      // ── (d) every legacy hook resolves, with six of seven cards folded shut ──
      const hooks: Record<string, boolean> = {}
      for (const sel of HOOKS) hooks[sel] = await waitTrue(`!!document.querySelector(${JSON.stringify(sel)})`)
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

      // ── (a) the overview band reads from fixtures, not placeholders ─────────
      const statsOk = await waitTrue(
        `[...document.querySelectorAll('.integux-stats .integux-stat-value')].length === 3 &&
         [...document.querySelectorAll('.integux-stats .integux-stat-value')].every(e => (e.textContent||'').trim() && e.textContent.trim() !== '—')`
      )

      // ── (c) attention beats persistence, and survives a fold ────────────────
      const failChip = `.collapsible-card[data-collapsible="webhooks"] .cc-attn .cc-chip.is-failing`
      const chipShown = await waitTrue(`!!document.querySelector('${failChip}')`, 40, 250)
      const autoExpanded = await cardOpen('webhooks')
      await toggle('webhooks') // fold it by hand
      await sleep(200)
      const foldedShut = !(await cardOpen('webhooks'))
      const chipSurvivesFold = await ES<boolean>(`!!document.querySelector('${failChip}')`)
      const attentionOk = chipShown && autoExpanded && foldedShut && chipSurvivesFold
      await toggle('webhooks') // leave it as we found it

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
      const sectionsOk = ['catalog', 'servers', 'matrix', 'grants', 'webhooks', 'keys', 'trail'].every((id) => wiredSections.includes(id))

      // ── (b) disclosure persists across a leave/return ───────────────────────
      const catalogOpenByDefault = await cardOpen('catalog')
      await toggle('catalog')
      await sleep(150)
      await toggle('grants')
      await sleep(150)
      await leaveAndReturn()
      const persistOk =
        catalogOpenByDefault && !(await cardOpen('catalog')) && (await cardOpen('grants')) && !(await cardOpen('keys'))

      // ── (e) hit targets, measured on the real box ───────────────────────────
      // Cards must be open for a box to exist: a `display:none` body measures 0.
      await ES(`document.querySelectorAll('.collapsible-card:not(.is-open) .cc-toggle').forEach(b => b.click())`)
      await sleep(400)
      const boxes = await ES<{ mgrChip: number | null; trailBtn: number | null; gap: number | null }>(`(() => {
        const h = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return r.height ? Math.round(r.height * 100) / 100 : null }
        const cards = [...document.querySelectorAll('#view-settings .integrations-section .collapsible-card')]
        let gap = null
        if (cards.length >= 2) {
          const a = cards[0].getBoundingClientRect(), b = cards[1].getBoundingClientRect()
          gap = Math.round((b.top - a.bottom) * 100) / 100
        }
        return { mgrChip: h('.mgr-chip'), trailBtn: h('.trail-activity .trail-btn'), gap }
      })()`)
      const sp4 = await ES<number>(`parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sp-4')) || 16`)
      const hitOk = !!boxes.trailBtn && boxes.trailBtn >= HIT && (boxes.mgrChip === null || boxes.mgrChip >= HIT)
      const gapOk = boxes.gap !== null && boxes.gap >= sp4 - 0.5

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
        attention: { chipShown, autoExpanded, foldedShut, chipSurvivesFold },
        boxes,
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
