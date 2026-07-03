import { app, type BrowserWindow } from 'electron'
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorktree } from '@backend/features/worktrees'

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
        await part(`${tag}-board-empty`, async () => {
          await key(`ctrlKey: true, shiftKey: true, code: 'KeyG'`)
          await sleep(500)
          await snap(`${tag}-board-empty`)
          await key(`ctrlKey: true, shiftKey: true, code: 'KeyG'`)
          await sleep(300)
        })
        await part(`${tag}-wizard`, async () => {
          await ES(`window.__mogging.templates.openWizard()`)
          await sleep(600)
          await snap(`${tag}-wizard-start`)
          await click('.wizard-footer .btn--primary')
          await sleep(400)
          await snap(`${tag}-wizard-layout`)
          await click('.wizard-footer .btn--primary')
          await sleep(400)
          await snap(`${tag}-wizard-agents`)
          await escape()
          await sleep(300)
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
