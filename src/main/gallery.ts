import { app, type BrowserWindow } from 'electron'
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { createWorktree } from '@backend/features/worktrees'
import { setFakeMode } from '@backend/features/usage'
import { UsageChannels } from '@contracts'
import { getUsageService, getUsageStatusService } from './usage'
import { getSettingsStore } from './app-settings'
import { clearTrail, flushTrailForSmoke, recordTrail } from './trail'

// MOGGING_SHOT=all (Phase-5/01): the GALLERY — drive the app through every surface
// and write numbered PNGs to out/gallery/, in BOTH themes. The audit + before/after
// evidence base for the UI/UX phase. States are staged with the same building
// blocks the smokes use (temp repo, worktrees, CLI verbs, ssh shim, dev handles).

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'mogging-gallery-'))
  git(repo, ['init'])
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repo, ['config', 'user.email', 'gallery@mogging.test'])
  git(repo, ['config', 'user.name', 'Gallery'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(repo, 'README.md'), 'gallery repo\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'init'])
  return repo
}

const SHIM_SRC =
  process.platform === 'win32'
    ? '@echo SSH_SHIM connected\r\n@%COMSPEC%\r\n'
    : '#!/bin/sh\necho "SSH_SHIM connected"\nexec ${SHELL:-/bin/sh}\n'

/**
 * A synthetic project tree for the folder-browser shots, at a path whose EVERY
 * SEGMENT is safe to publish. The breadcrumb renders each one, so a temp dir under
 * `C:\Users\<name>\AppData\Local\Temp` would print the operator's username into a
 * committed screenshot. Prefer the filesystem root; fall back to temp if it is not
 * writable (and accept the longer trail rather than fail the gallery).
 */
function makeShowcase(): string {
  const candidates = [join(parse(tmpdir()).root, 'mogging-showcase'), join(tmpdir(), 'mogging-showcase')]
  for (const dir of candidates) {
    try {
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      for (const d of ['api', 'design-system', 'docs', 'infra', 'web-app']) mkdirSync(join(dir, d))
      mkdirSync(join(dir, 'web-app', '.git')) // earns the repo pill
      mkdirSync(join(dir, 'api', '.git'))
      return dir
    } catch {
      /* not writable — try the next candidate */
    }
  }
  throw new Error('no writable showcase root')
}

export function runGallery(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 420000) // safety net
  const wc = win.webContents
  wc.setBackgroundThrottling(false)
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const cliPath = join(app.getAppPath(), 'bin', 'mogging.mjs')
  const dir = join(process.cwd(), 'out', 'gallery')
  const errors: string[] = []
  let n = 0

  const cli = (args: string[], extraEnv: Record<string, string> = {}): Promise<number> =>
    new Promise((resolveCli) => {
      execFile(
        process.execPath,
        [cliPath, ...args],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...extraEnv }, timeout: 15000, windowsHide: true },
        (err) => resolveCli(err ? 1 : 0)
      )
    })

  const snap = async (name: string): Promise<void> => {
    await sleep(150) // settle paints
    const img = await wc.capturePage()
    writeFileSync(join(dir, `${String(++n).padStart(2, '0')}-${name}.png`), img.toPNG())
  }
  /** A block that must not kill the whole gallery if one surface misbehaves. */
  const part = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn()
    } catch (e) {
      errors.push(`${name}: ${String(e)}`)
    }
  }

  const key = (opts: string): Promise<unknown> =>
    ES(`window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ${opts} }))`)
  const escape = (): Promise<unknown> => key(`key: 'Escape'`)
  const click = (sel: string): Promise<unknown> =>
    ES(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (e) e.click(); return !!e })()`)

  const run = async (): Promise<void> => {
    try {
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      writeFileSync(process.env.MOGGING_SSH_SHIM ?? join(tmpdir(), 'mogging-shim.cmd'), SHIM_SRC)
      win.setSize(1600, 950)

      // Staging materials (main-side): repo + two worktrees (review gated/approved).
      const repo = makeRepo()
      const wt1 = await createWorktree(repo) // will be APPROVED
      const wt2 = await createWorktree(repo) // stays GATED
      for (const wt of [wt1, wt2]) {
        if (wt.ok && wt.path) {
          writeFileSync(join(wt.path, 'feature.ts'), `export const built = true // ${wt.branch}\n`)
          git(wt.path, ['add', '-A'])
          git(wt.path, ['commit', '-m', 'agent work'])
        }
      }

      await sleep(1800) // boot settles on Home

      // ── Pristine states, both themes (empty Home/board are unreachable later) ─
      for (const t of ['midnight', 'light'] as const) {
        const tag = t === 'midnight' ? 'dark' : 'light'
        await ES(`window.__mogging.setTheme('${t}')`)
        await sleep(400)
        await part(`${tag}-home-empty`, async () => {
          // Closing board/wizard with zero workspaces lands on an empty grid view
          // (logged as UX finding) — toggle Home back on before the snap.
          await ES(
            `(document.querySelector('#content.view-home') ? 1 : (document.querySelector('.titlebar-right .icon-btn[aria-label="Home"]')?.click(), 1))`
          )
          await sleep(400)
          await snap(`${tag}-home-empty`)
        })
        // First-run checklist (6/06): fresh state, so it shows live on Home.
        await part(`${tag}-firstrun`, async () => {
          await ES(
            `(document.querySelector('#content.view-home') ? 1 : (document.querySelector('.titlebar-right .icon-btn[aria-label="Home"]')?.click(), 1))`
          )
          await ES(`window.__mogging.firstrun && window.__mogging.firstrun.refresh()`)
          await sleep(600)
          await snap(`${tag}-firstrun`)
        })
        // Usage glance (7/03): popover with every fixture state; gauge rest/warn/stale
        // (FAKE adapter — gallery runs in the fixture world, zero network).
        await part(`${tag}-usage`, async () => {
          // 7/09: a Phase-4 profile pair on the fake provider stages the
          // multi-profile popover — severity ordering + the ACTIVE identity
          // treatment on the order-0 lane (removed again at part end).
          getSettingsStore()?.saveProfile({ id: 'default', name: 'Main', provider: 'fake', env: {}, order: 0 })
          getSettingsStore()?.saveProfile({ id: 'fresh-reset', name: 'Backup', provider: 'fake', env: {}, order: 1 })
          await ES(`window.__mogging.usage && window.__mogging.usage.open()`)
          await sleep(600)
          await snap(`${tag}-usage-popover`)
          await ES(`window.__mogging.usage.close()`)
          const dir = mkdtempSync(join(tmpdir(), 'mog-gallery-usage-'))
          const hot = join(dir, 'hot.json')
          writeFileSync(hot, JSON.stringify([{ providerId: 'fake', profileId: 'default', planLabel: 'Fake Pro (hot)', windows: [{ label: 'Session (5h)', usedPct: 93, resetsAt: new Date(Date.now() + 4 * 3600_000).toISOString() }, { label: 'Weekly', usedPct: 88, resetsAt: new Date(Date.now() + 90 * 3600_000).toISOString() }], fetchedAt: Date.now(), health: 'fresh' }]))
          process.env.MOGGING_USAGE_FIXTURE = hot
          getUsageService()?.refresh()
          await sleep(900)
          await snap(`${tag}-usage-gauge-warn`)
          setFakeMode('error')
          getUsageService()?.refresh()
          await sleep(900)
          await snap(`${tag}-usage-gauge-stale`)
          // provider outage (7/08): the ONE-glyph incident overlay + status
          // chip + "provider outage" relabel on the failing tile (fixture
          // status body — zero network, like everything else here).
          process.env.MOGGING_USAGE_STATUS = 'outage'
          await getUsageStatusService()?.refresh()
          await sleep(600)
          await snap(`${tag}-usage-outage-gauge`)
          await ES(`window.__mogging.usage && window.__mogging.usage.open()`)
          await sleep(400)
          await snap(`${tag}-usage-outage-popover`)
          await ES(`window.__mogging.usage.close()`)
          process.env.MOGGING_USAGE_STATUS = 'operational'
          await getUsageStatusService()?.refresh()
          setFakeMode('ok')
          delete process.env.MOGGING_USAGE_FIXTURE
          getUsageService()?.refresh()
          await sleep(600)
          // threshold + suggestion toast and the OPT-IN reset confetti (7/09):
          // synthesized payloads through the real alert channel — live copy
          // (formatter-verbatim) is smoke-asserted; this stages the visuals.
          wc.send(UsageChannels.alert, {
            kind: 'threshold',
            level: 'warn',
            providerId: 'fake',
            profileId: 'near-limit',
            planLabel: 'Fake Pro (near limit)',
            windowLabel: 'Session (5h)',
            usedPct: 95,
            title: 'Fake Pro (near limit) — 95% of Session (5h) used',
            body: 'Ahead of pace — runs out ~Tue 14:00',
            failover: { profileId: 'fresh-reset', profileName: 'Backup' }
          })
          await sleep(500)
          await snap(`${tag}-usage-toast-suggestion`)
          wc.send(UsageChannels.alert, {
            kind: 'reset',
            providerId: 'fake',
            profileId: 'default',
            planLabel: 'Fake Pro (normal)',
            windowLabel: 'Session (5h)',
            usedPct: 2,
            title: 'Fake Pro (normal) — fresh Session (5h) window',
            body: 'Counters reset — a full window ahead.',
            confetti: true
          })
          await sleep(500)
          await snap(`${tag}-usage-toast-reset-confetti`)
          // display modes (7/10): a two-provider fixture with distinct
          // severity/usage winners — merged, auto, pinned, content options.
          const ddir = mkdtempSync(join(tmpdir(), 'mog-gallery-display-'))
          const two = join(ddir, 'two.json')
          writeFileSync(
            two,
            JSON.stringify([
              { providerId: 'alpha', profileId: 'default', planLabel: 'Alpha Pro', windows: [{ label: 'Session (5h)', usedPct: 70, resetsAt: new Date(Date.now() + 4 * 3600_000).toISOString(), windowMs: 5 * 3600_000 }], fetchedAt: Date.now(), health: 'fresh' },
              { providerId: 'zeta', profileId: 'default', planLabel: 'Zeta Pro', windows: [{ label: 'Session (5h)', usedPct: 96, resetsAt: new Date(Date.now() + 3 * 60_000).toISOString(), windowMs: 5 * 3600_000 }], fetchedAt: Date.now(), health: 'fresh' }
            ])
          )
          process.env.MOGGING_USAGE_FIXTURE = two
          getUsageService()?.refresh()
          await sleep(900)
          await ES(`window.__mogging.usage.open()`)
          await sleep(400)
          await snap(`${tag}-usage-display-merged`)
          await ES(`window.bridge.invoke('usage:displaySet', { mode: 'auto' })`)
          await sleep(400)
          await snap(`${tag}-usage-display-auto`)
          await ES(`window.bridge.invoke('usage:displaySet', { mode: 'pinned', pin: 'zeta' })`)
          await sleep(400)
          await snap(`${tag}-usage-display-pinned`)
          await ES(`window.bridge.invoke('usage:displaySet', { showPct: true, showLabel: true, showGlyph: true, density: 'compact' })`)
          await sleep(400)
          await snap(`${tag}-usage-display-content`)
          await ES(`window.bridge.invoke('usage:displaySet', { mode: 'merged', showPct: false, showLabel: false, showGlyph: false, density: 'roomy' })`)
          await ES(`window.__mogging.usage.close()`)
          delete process.env.MOGGING_USAGE_FIXTURE
          getUsageService()?.refresh()
          await sleep(600)
          getSettingsStore()?.removeProfile('default')
          getSettingsStore()?.removeProfile('fresh-reset')
          // The FULL Usage tab (7/12): the five-class provider grid (top),
          // then the plans × profiles + pace/alerts blocks, then privacy.
          await ES(`(document.querySelector('.titlebar-right .icon-btn[aria-label="Settings"]')?.click(), 1)`)
          await sleep(300)
          await ES(`document.querySelector('.settings-section[data-section="usage"]')?.scrollIntoView({ block: 'start' })`)
          await sleep(600)
          await snap(`${tag}-usage-settings`)
          await ES(`document.querySelector('.usage-plans-block')?.scrollIntoView({ block: 'start' })`)
          await sleep(300)
          await snap(`${tag}-usage-tab-plans`)
          await ES(`document.querySelector('.usage-privacy-block')?.scrollIntoView({ block: 'center' })`)
          await sleep(300)
          await snap(`${tag}-usage-tab-privacy`)
          // Settings § Integrations (8/05): the Activity trail with seeded
          // fixture entries — refs only, offline, both outcomes visible.
          const galleryWs = 'gallery-fixture-ws'
          const seedTs = Date.now()
          recordTrail({ ts: seedTs - 40_000, source: 'web', workspaceId: galleryWs, verb: 'click', target: 'https://staging.example.dev', outcome: 'ok' })
          recordTrail({ ts: seedTs - 25_000, source: 'web', workspaceId: galleryWs, verb: 'navigate', target: 'https://shop.example.dev', outcome: 'refused', reason: 'ungranted origin' })
          recordTrail({ ts: seedTs - 12_000, source: 'web', workspaceId: galleryWs, verb: 'confirm', target: 'https://staging.example.dev', outcome: 'confirmed' })
          recordTrail({ ts: seedTs - 5_000, source: 'mcp', workspaceId: galleryWs, verb: 'send_to_pane', target: 'pane 102', outcome: 'ok', pane: '101' })
          flushTrailForSmoke()
          await ES(`document.querySelector('.settings-section[data-section="integrations"]')?.scrollIntoView({ block: 'start' })`)
          await sleep(500)
          await snap(`${tag}-integrations-settings`) // servers registry + grants (8/06)
          await ES(`document.querySelector('.trail-activity')?.scrollIntoView({ block: 'start' })`)
          await ES(`(document.querySelector('.trail-activity .trail-btn')?.click(), 1)`)
          await sleep(500)
          await snap(`${tag}-integrations-activity`)
          clearTrail(galleryWs)
          // 8.5/01: About is the layout primitives' first live customer —
          // Card + SectionHeader + TwoColumn + FieldGroup, staged in both themes
          // so the ramp's rhythm is reviewable before 02-08 adopt it everywhere.
          await ES(`(document.querySelector('.settings-nav-item[data-target="about"]')?.click(), 1)`)
          await sleep(400)
          await snap(`${tag}-settings-about-primitives`)
          await ES(`(document.querySelector('.settings-back')?.click(), 1)`)
          await sleep(300)
        })
        await part(`${tag}-board-empty`, async () => {
          await key(`ctrlKey: true, shiftKey: true, code: 'KeyG'`)
          await sleep(500)
          await snap(`${tag}-board-empty`)
          await key(`ctrlKey: true, shiftKey: true, code: 'KeyG'`)
          await sleep(300)
        })
        await part(`${tag}-wizard`, async () => {
          // 8.5/02: the wizard is a full PAGE beside the rail, not a modal — one
          // scroll, three cards. Never click the footer primary here: it launches.
          //
          // 8.5/03: open it ON A FIXTURE. With no cwd the folder browser opens at
          // $HOME and photographs the operator's real directory names straight into a
          // committed screenshot. Every shot must be of a synthetic tree — AND at a
          // path with no username in it, because the breadcrumb renders every segment
          // (a temp dir under C:\Users\<name>\AppData would put it on screen).
          const showcase = makeShowcase()
          await ES(`window.__mogging.templates.openWizard({ cwd: ${JSON.stringify(showcase)} })`)
          await sleep(700)
          await snap(`${tag}-wizard-page`)
          await ES(`document.querySelector('#view-wizard .wizard')?.scrollTo({ top: 99999 })`)
          await sleep(400)
          await snap(`${tag}-wizard-agents`)
          // Expand, THEN re-scroll: expanding grows the column, so the disclosure
          // we came to photograph lands below the fold if we shoot immediately.
          await ES(`(document.querySelectorAll('#view-wizard .wizard-adv').forEach((d) => (d.open = true)), 1)`)
          await sleep(300)
          await ES(`document.querySelector('#view-wizard .wizard')?.scrollTo({ top: 99999 })`)
          await sleep(400)
          await snap(`${tag}-wizard-advanced`)
          await escape()
          await sleep(300)
          try {
            rmSync(showcase, { recursive: true, force: true })
          } catch {
            /* best effort */
          }
        })
      }
      await ES(`window.__mogging.setTheme('midnight')`)
      await sleep(400)

      // ── Stage the full world once ─────────────────────────────────────────────
      await part('staging', async () => {
        await ES(`window.bridge.invoke('remotes:save', ${JSON.stringify({ id: 'h1', name: 'buildbox', host: 'build.example', user: 'dev' })})`)
        await ES(
          `window.__mogging.workspace.create({ name: 'Alpha', cwd: ${JSON.stringify(repo)}, paneCount: 4, ` +
            `roles: ['worker','worker','reviewer',null], remotes: [null, null, null, { hostId: 'h1', name: 'buildbox' }] })`
        )
        await sleep(4500) // spawns + git chips + roles reach the daemon
        const base = ((await ES('window.__mogging.workspace.active()')) as { ordinal: number }).ordinal * 100
        await cli(['claim', 'src/ui/**'], { MOGGING_PANE_ID: String(base + 1) })
        await cli(['approve', wt1.branch ?? ''], { MOGGING_PANE_ID: String(base + 3) }) // pane 3 is reviewer
        // Board cards (one bound via start-on-card while Alpha is active).
        await ES(`window.__mogging.board.createCard('Ship the parser rewrite', 'Tokens, AST, tests.')`)
        await ES(`window.__mogging.board.createCard('Audit the color system', 'AA everywhere.')`)
        const cardId = String(await ES(`window.__mogging.board.createCard('Fix flaky reflow test', 'See CI run 812.')`))
        await ES(`window.__mogging.workspace.switchByIndex(0)`)
        await sleep(300)
        await ES(`window.__mogging.board.startOnCard(${JSON.stringify(cardId)}, 'shell')`)
        await sleep(2500)
        // Beta: the density/zoom playground.
        await ES(`window.__mogging.workspace.create({ name: 'Beta' })`)
        await sleep(1500)
      })

      // ── Themed sweep ──────────────────────────────────────────────────────────
      for (const t of ['midnight', 'light'] as const) {
        const tag = t === 'midnight' ? 'dark' : 'light'
        await ES(`window.__mogging.setTheme('${t}')`)
        await sleep(500)

        await part(`${tag}-grid-chips`, async () => {
          await ES(`window.__mogging.workspace.switchByIndex(0)`) // Alpha: chips galore
          await sleep(600)
          await snap(`${tag}-grid-4-chips`)
        })

        await part(`${tag}-rail-attention`, async () => {
          const base = 0 * 100 // Alpha is ordinal 0
          await ES(`window.__mogging.workspace.switchByIndex(2)`) // Beta active; Alpha backgrounds
          await sleep(400)
          await ES(`window.__mogging.attention.setPaneState(${base + 2}, 'attention')`)
          await sleep(500)
          await snap(`${tag}-rail-attention`)

          // Rail states matrix (5/02): three identity colors; Beta SELECTED (vivid
          // identity treatment) + its live attention badge (the active workspace
          // never rings — Phase-2 semantics), Alpha ringing in brand orange.
          await ES(`window.__mogging.attention.setPaneState(201, 'attention')`)
          await sleep(500)
          await snap(`${tag}-rail-states`)

          // Collapsed rail inherits the treatment (left bar + icon ink + badges).
          await click('.titlebar-right .icon-btn.rail-toggle')
          await sleep(400)
          await snap(`${tag}-rail-collapsed`)
          await click('.titlebar-right .icon-btn.rail-toggle')
          await sleep(400)

          // Geometry probe: the selected treatment must not shift layout — the 3px
          // bar is an inset shadow, so tab width and icon x match unselected tabs.
          if (tag === 'dark') {
            const probe = (await ES(
              `(() => {
                const tabs = [...document.querySelectorAll('#workspace-tabs .workspace-tab')]
                return tabs.map((t) => ({
                  active: t.classList.contains('active'),
                  w: t.getBoundingClientRect().width,
                  iconX: t.querySelector('.ws-icon')?.getBoundingClientRect().left ?? -1
                }))
              })()`
            )) as { active: boolean; w: number; iconX: number }[]
            const ws = probe.map((p) => p.w)
            const xs = probe.map((p) => p.iconX)
            const pass =
              probe.some((p) => p.active) &&
              Math.max(...ws) - Math.min(...ws) < 0.5 &&
              Math.max(...xs) - Math.min(...xs) < 0.5
            writeFileSync(join(dir, 'probe-rail.json'), JSON.stringify({ pass, probe }, null, 2))
            if (!pass) errors.push(`rail-probe: layout shift between selected/unselected: ${JSON.stringify(probe)}`)
          }

          await ES(`window.__mogging.attention.setPaneState(201, 'idle')`)
          await ES(`window.__mogging.attention.setPaneState(${base + 2}, 'idle')`)
        })

        // Browser dock (6/05): the empty state IS the offline-honest shot — the
        // gallery never touches the network, so no page is loaded. 8/04 adds
        // the agent-web profile state (switch + notice line, still offline).
        await part(`${tag}-browser-dock`, async () => {
          await ES('window.__mogging.browser.toggle(true)')
          await sleep(600)
          await snap(`${tag}-browser-dock`)
          await ES(`window.__mogging.browser.setProfile('agent-web')`)
          await sleep(600)
          await snap(`${tag}-browser-agentweb`)
          await ES(`window.__mogging.browser.setProfile('preview')`)
          await sleep(400)
          await ES('window.__mogging.browser.toggle(false)')
          await sleep(300)
        })

        await part(`${tag}-densities`, async () => {
          // Beta is active from the previous part.
          for (const count of [1, 8, 16]) {
            await ES(`window.__mogging.layout.apply(${count})`)
            await sleep(count > 4 ? 4000 : 1500)
            await snap(`${tag}-grid-${count}`)
          }
          await ES(`window.__mogging.layout.apply(4)`)
          await sleep(1500)
        })

        await part(`${tag}-zoom-expand`, async () => {
          await ES(`window.__mogging.layout.zoom()`)
          await sleep(400)
          await snap(`${tag}-pane-zoom`)
          await ES(`window.__mogging.layout.zoom()`)
          await sleep(300)
          const beta = ((await ES('window.__mogging.workspace.active()')) as { ordinal: number }).ordinal * 100
          await ES(`window.__mogging.layout.expand(${beta + 1}, 'col')`)
          await sleep(400)
          await snap(`${tag}-pane-expand-col`)
          await ES(`window.__mogging.layout.expand(${beta + 1}, 'col')`)
          await sleep(300)
          await ES(`window.__mogging.layout.expand(${beta + 1}, 'row')`)
          await sleep(400)
          await snap(`${tag}-pane-expand-row`)
          await ES(`window.__mogging.layout.expand(${beta + 1}, 'row')`)
          await sleep(300)
        })

        await part(`${tag}-pane-menu`, async () => {
          await ES(`window.__mogging.workspace.switchByIndex(0)`)
          await sleep(400)
          await click(`.layout-slot[data-pane-id="1"] .pane-actions .pane-act`)
          await sleep(300)
          await snap(`${tag}-pane-menu`)
          await click('#content') // dismiss
          await sleep(200)
        })

        await part(`${tag}-chrome-states`, async () => {
          // Window-state matrix (5/04): restored / maximized / fullscreen. The
          // restored frame shows the rounded bottom corners; maximized/fullscreen
          // must be square with zero dead gap in the bar.
          await snap(`${tag}-chrome-restored`)
          type ChromeMeasure = {
            gap: number
            centerDelta: number
            overflow: boolean
            cls: string
            pad: string
            iw: number
            barRight: number
            clusterRight: number
            clusterW: number
            wco: { visible: boolean; w: number } | null
          }
          const MEASURE = `(() => {
            const last = document.querySelector('#titlebar .titlebar-right .icon-btn:last-of-type')
            const trigger = document.querySelector('.palette-trigger')
            const cluster = document.querySelector('#titlebar .titlebar-right')
            const bar = document.getElementById('titlebar')
            const wco = navigator.windowControlsOverlay
            return {
              gap: window.innerWidth - (last?.getBoundingClientRect().right ?? 0),
              centerDelta: trigger ? Math.abs((trigger.getBoundingClientRect().left + trigger.getBoundingClientRect().right) / 2 - window.innerWidth / 2) : -1,
              overflow: document.documentElement.scrollWidth > window.innerWidth,
              cls: document.getElementById('app')?.className ?? '',
              pad: cluster ? getComputedStyle(cluster).paddingRight : '',
              iw: window.innerWidth,
              barRight: bar?.getBoundingClientRect().right ?? -1,
              clusterRight: cluster?.getBoundingClientRect().right ?? -1,
              clusterW: cluster?.getBoundingClientRect().width ?? -1,
              wco: wco ? { visible: wco.visible, w: wco.getTitlebarAreaRect().width } : null
            }
          })()`
          const chromeState = (): Promise<unknown> =>
            ES(`document.getElementById('app')?.dataset.chromeState ?? 'MISSING'`)
          // Measure RESTORED first — clean state, before any maximize/fullscreen dance.
          const restored = tag === 'dark' ? ((await ES(MEASURE)) as ChromeMeasure) : null
          const at_rest = tag === 'dark' ? await chromeState() : ''
          win.maximize()
          await sleep(700)
          const at_max = tag === 'dark' ? await chromeState() : ''
          await snap(`${tag}-chrome-maximized`)
          win.unmaximize()
          await sleep(700)
          win.setFullScreen(true)
          await sleep(1000)
          await snap(`${tag}-chrome-fullscreen`)
          if (tag === 'dark' && restored) {
            // Probe (fullscreen): the right cluster ends a normal inset from the
            // window edge — the native-controls reserve must be gone.
            const fs = (await ES(MEASURE)) as ChromeMeasure
            const px = (s: string): number => parseFloat(s) || 0
            const pass =
              Math.abs(fs.iw - fs.clusterRight) <= 1 && // cluster flush right (F11)
              Math.abs(restored.iw - restored.clusterRight) <= 1 && // and restored
              px(fs.pad) >= 8 && px(fs.pad) <= 24 && // F11: reserve collapsed to ~sp-3
              px(restored.pad) >= 100 && // restored: the controls reserve/floor holds
              fs.centerDelta <= 1.5 && restored.centerDelta <= 1.5 && // true window center
              !fs.overflow && !restored.overflow &&
              at_max === 'maximized' // corner logic depends on the maximize event
            writeFileSync(
              join(dir, 'probe-chrome.json'),
              JSON.stringify({ pass, at_rest, at_max, fullscreen: fs, restored }, null, 2)
            )
            if (!pass) errors.push(`chrome-probe: ${JSON.stringify({ at_rest, at_max, fs, restored })}`)
          }
          win.setFullScreen(false)
          await sleep(1000)
          win.setSize(1600, 950)
          await sleep(500)
        })

        await part(`${tag}-palette`, async () => {
          await key(`ctrlKey: true, key: 'k'`)
          await sleep(400)
          await snap(`${tag}-palette`)
          await escape()
          await sleep(200)
        })

        await part(`${tag}-board-cards`, async () => {
          await key(`ctrlKey: true, shiftKey: true, code: 'KeyG'`)
          await sleep(500)
          await snap(`${tag}-board-cards`)
          await key(`ctrlKey: true, shiftKey: true, code: 'KeyG'`)
          await sleep(300)
        })

        await part(`${tag}-review`, async () => {
          await ES(`window.__mogging.review.open(${JSON.stringify(repo)}, ${JSON.stringify(wt2.path ?? '')})`)
          await sleep(900)
          await snap(`${tag}-review-gated`)
          await escape()
          await sleep(300)
          await ES(`window.__mogging.review.open(${JSON.stringify(repo)}, ${JSON.stringify(wt1.path ?? '')})`)
          await sleep(900)
          await snap(`${tag}-review-approved`)
          await escape()
          await sleep(300)
        })

        await part(`${tag}-settings`, async () => {
          await click('.titlebar-right .icon-btn[aria-label="Settings"]')
          await sleep(600)
          await snap(`${tag}-settings`)
          // The page scrolls — bring the Profiles section into frame for the form shot.
          await click('.settings-nav-item[data-target="profiles"]')
          await sleep(600)
          await click('button[aria-label="Add profile"]')
          await sleep(300)
          await ES(
            `(() => {
              const set = (sel, v) => { const i = document.querySelector(sel); if (i) { i.value = v; i.dispatchEvent(new Event('input')) } }
              set('.prof-name', 'Work')
              set('.prof-env-key', 'FAKE_KEY')
              set('.prof-env-val', 'sk-THISLOOKSLIKEASECRET123')
              const b = document.querySelector('button[aria-label="Save profile"]'); if (b) b.click()
              return 1
            })()`
          )
          await sleep(500)
          await snap(`${tag}-settings-profile-error`)
          await escape()
          await sleep(300)
        })

        await part(`${tag}-focus-walk`, async () => {
          // Focus-visible audit receipt (5/07): a real keyboard Tab shows the
          // 01 focus ring (JS .focus() would not match :focus-visible).
          if (tag === 'dark') {
            await ES(`(document.activeElement instanceof HTMLElement && document.activeElement.blur(), 1)`)
            wc.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
            wc.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
            await sleep(200)
            wc.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
            wc.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
            await sleep(300)
            await snap(`${tag}-focus-walk`)
          }
        })

        await part(`${tag}-icon-sheet`, async () => {
          await ES(`window.__mogging.iconSheet()`)
          await sleep(400)
          await snap(`${tag}-icon-sheet`)
          // Crispness at non-integer DPRs (dark pass only): 125% / 150% zoom.
          if (tag === 'dark') {
            for (const z of [1.25, 1.5]) {
              wc.setZoomFactor(z)
              await sleep(400)
              await snap(`${tag}-icon-sheet-${z * 100}`)
            }
            wc.setZoomFactor(1)
            await sleep(300)
          }
          await ES(`window.__mogging.iconSheet()`)
          await sleep(200)
        })

        await part(`${tag}-toasts`, async () => {
          // The stack caps at 4 — five tones need two batches or the first drops out.
          const fire = (tones: string[]): Promise<unknown> =>
            ES(
              `(${JSON.stringify(tones)}.forEach((tone) => window.__mogging.toast(` +
                `tone, tone[0].toUpperCase() + tone.slice(1) + ' toast', 'Sample body copy for the gallery.')), 1)`
            )
          const dismissAll = async (): Promise<void> => {
            await ES(`(document.querySelectorAll('.toast-dismiss').forEach((b) => b.click()), 1)`)
            await sleep(400)
          }
          await fire(['neutral', 'info', 'success'])
          await sleep(400)
          await snap(`${tag}-toasts-a`)
          await dismissAll()
          await fire(['attention', 'danger'])
          await sleep(400)
          await snap(`${tag}-toasts-b`)
          await dismissAll()
        })

        await part(`${tag}-home`, async () => {
          await click('.titlebar-right .icon-btn[aria-label="Home"]')
          await sleep(500)
          await snap(`${tag}-home`)
          await click('.titlebar-right .icon-btn[aria-label="Home"]')
          await sleep(300)
        })
      }

      writeFileSync(join(dir, 'errors.json'), JSON.stringify({ count: errors.length, errors }, null, 2))
      app.exit(0)
    } catch (e) {
      try {
        writeFileSync(join(dir, 'errors.json'), JSON.stringify({ fatal: String(e), errors }, null, 2))
      } catch {
        /* ignore */
      }
      app.exit(1)
    }
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 1500))
  else setTimeout(() => void run(), 1500)
}
