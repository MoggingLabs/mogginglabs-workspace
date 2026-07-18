import { app, type BrowserWindow } from 'electron'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { getSettingsStore } from '../app-settings'
import { handleBrainMap, handleBrainRebuild, handleBrainStatus, setOrientAtLaunch, brainDebug } from '../brain'

// Env-gated repomap smoke (MOGGING_BRAINMAP, ADR 0018 step 06): cold panes start
// oriented. Against a fixture with a KNOWN HUB (a symbol referenced from five
// distinct files) and a known zero-inbound leaf:
//   (a) the hub's file LEADS the map; the leaf is absent at budget 1000;
//   (b) two renders are byte-identical, and STILL identical after a rebuild —
//       determinism through the generation-keyed rank cache;
//   (c) the budget binds: ≤ budget chars, whole lines only, the attribution
//       stamp closes the map;
//   (d) `mogging map` exit codes: 0 ok · 1 non-brain cwd · 3 app down — the
//       shared table holds;
//   (e) board launch, toggle ON (the default): the pane's first prompt STARTS
//       with the fenced map and the card task follows — proven through
//       `mogging capture`, the same eyes a human would use; toggle OFF: the
//       first prompt IS the task, zero map bytes;
//   (f) the attribution generation matches brain_status — one truth, stamped.
// MOGGING_BRAINMAP=HOLD keeps the launched world alive for the manual-first
// rule (a human watches a real card launch start with the map).
// Verdict: out/brainmap-result.json.

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

interface Fixture {
  base: string
  repo: string
  plain: string
}

function makeFixture(): Fixture {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'mog-brainmap-')))
  const repo = join(base, 'repo')
  mkdirSync(repo)
  // The known hub: referenced from FIVE distinct files — Aider's core insight
  // says it must float to the top, and arm (a) holds the render to it.
  writeFileSync(join(repo, 'hub.ts'), 'export function hub(): number {\n  return 1\n}\n')
  for (let i = 1; i <= 5; i++) {
    writeFileSync(join(repo, `u${i}.ts`), `import { hub } from './hub'\nexport function use${i}(): number {\n  return hub()\n}\n`)
  }
  // Connected padding (a circular import chain, so every pad file has inbound
  // weight and outranks the leaf deterministically) — enough body that budget
  // 1000 must CUT, which is what makes the leaf's absence meaningful.
  const PADS = 16
  for (let i = 0; i < PADS; i++) {
    const next = (i + 1) % PADS
    // Four defs per pad file (~130 rendered chars each): the full map lands well
    // past budget 1000, so the leaf's absence there is a real cut, not a fit.
    let src = `import { pad${next}a } from './p${String(next).padStart(2, '0')}'\n`
    src += `export function pad${i}a(): number {\n  return pad${next}a()\n}\n`
    for (const s of ['b', 'c', 'd']) src += `export function pad${i}${s}(): number {\n  return ${i}\n}\n`
    writeFileSync(join(repo, `p${String(i).padStart(2, '0')}.ts`), src)
  }
  // The zero-inbound, zero-outbound leaf: nobody references it, it references
  // nothing — the lowest-ranked file in the partition, by construction.
  writeFileSync(join(repo, 'leaf.ts'), 'export function leafOnly(): number {\n  return 9\n}\n')
  git(repo, ['init'])
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repo, ['config', 'core.autocrlf', 'false'])
  git(repo, ['config', 'user.email', 'smoke@mogging.test'])
  git(repo, ['config', 'user.name', 'Mogging Smoke'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'fixture'])
  const plain = join(base, 'plain-no-brain') // a valid dir with no index: exit-1 land
  mkdirSync(plain)
  return { base, repo, plain }
}

export function runBrainMapSmoke(win: BrowserWindow): void {
  const hold = process.env.MOGGING_BRAINMAP === 'HOLD'
  const resultFile = join(app.getAppPath(), 'out', 'brainmap-result.json')
  // RE-ENTRY guard (electron-vite dev respawns electron after app.exit).
  if (!hold && existsSync(resultFile)) {
    app.exit(0)
    return
  }
  const write = (o: object): void => {
    try {
      mkdirSync(dirname(resultFile), { recursive: true })
      writeFileSync(resultFile, JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }
  if (!hold) {
    setTimeout(() => {
      write({ pass: false, error: 'TIMEOUT: brainmap smoke did not complete' })
      app.exit(1)
    }, 280000)
  }

  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const root = app.getAppPath()

  const cli = (
    args: string[],
    opts: { cwd?: string; env?: Record<string, string> } = {}
  ): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((res) => {
      execFile(
        process.execPath,
        [join(root, 'bin', 'mogging.mjs'), ...args],
        {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...(opts.env ?? {}) },
          cwd: opts.cwd,
          timeout: 20000,
          windowsHide: true
        },
        (err, stdout, stderr) =>
          res({ code: err ? ((err as unknown as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) })
      )
    })

  const until = async (pred: () => boolean | Promise<boolean>, capMs: number, stepMs = 300): Promise<boolean> => {
    const t0 = Date.now()
    for (;;) {
      if (await pred()) return true
      if (Date.now() - t0 > capMs) return false
      await sleep(stepMs)
    }
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    let fx: Fixture | null = null
    try {
      fx = makeFixture()
      const F = fx
      await sleep(1500)

      // ── The anchor workspace (the launch's governing setting lives on it) ──
      await ES(`window.__mogging.workspace.create({ name: 'MapAnchor', cwd: ${JSON.stringify(F.repo)}, paneCount: 1 })`)
      await sleep(3500)
      const anchor = (await ES('window.__mogging.workspace.active()')) as { id: string; ordinal: number }

      const b0 = await handleBrainRebuild({ root: F.repo })
      if (!b0.ok) throw new Error('fixture rebuild refused: ' + JSON.stringify(b0))

      // ── (a) the hub leads; the leaf is cut at budget 1000 ──────────────────
      const full = handleBrainMap({ root: F.repo })
      const m1000 = handleBrainMap({ root: F.repo, budget: 1000 })
      const fullMap = String(full.map ?? '')
      const smallMap = String(m1000.map ?? '')
      const hubLeadsOk =
        full.ok === true && fullMap.split('\n')[0] === 'hub.ts:' && smallMap.split('\n')[0] === 'hub.ts:'
      const leafCutOk =
        fullMap.includes('leaf.ts:') && // it EXISTS at full budget — absence below is ranking, not a hole
        !smallMap.includes('leaf.ts') &&
        smallMap.includes('hub.ts:')

      // ── (b) byte-identical twice, and byte-identical THROUGH a rebuild ─────
      const again = handleBrainMap({ root: F.repo })
      const rb = await handleBrainRebuild({ root: F.repo })
      const afterRebuild = handleBrainMap({ root: F.repo })
      // The stamp carries the generation, which a rebuild moves — determinism
      // is the BODY byte-for-byte; the stamp must move exactly with the truth.
      const body = (m: unknown): string => String(m).split('\n').slice(0, -1).join('\n')
      const stampGen = (m: unknown): number => Number(/generation (\d+),/.exec(String(m))?.[1] ?? -1)
      const determinismOk =
        String(again.map) === fullMap &&
        rb.ok &&
        body(afterRebuild.map) === body(fullMap) &&
        stampGen(afterRebuild.map) === stampGen(fullMap) + 1

      // ── (c) the budget binds: whole lines, the stamp closes the map ────────
      const lines = smallMap.split('\n')
      const stampRe = /^\[repomap: generation \d+, \d+\/\d+ files\]$/
      const budgetOk =
        smallMap.length <= 1000 &&
        stampRe.test(lines[lines.length - 1]) &&
        lines.slice(0, -1).every((l) => /^\S.*:$/.test(l) || /^ {2}\S/.test(l)) &&
        fullMap.length <= 4000

      // ── (f) the stamp's generation IS brain_status's ───────────────────────
      const status = handleBrainStatus({ root: F.repo })
      const genOk = status.ok && stampGen(afterRebuild.map) === status.generation

      // A 'shell' launch is a launch NO-OP (launch-port): it registers no agent
      // session, so the board — fail-closed by design — would never type the
      // task. Replay the daemon's own typed-launch verdict (the orchestration
      // smoke's shim, same event, same shape) so the REAL handoff path runs.
      const confirmAgentUp = async (paneId: number): Promise<void> => {
        await ES(
          `window.__mogging.agents.detected({ id: ${paneId}, agentId: 'claude', cwd: ${JSON.stringify(F.repo)}, sinceMs: Date.now() })`
        )
      }

      if (hold) {
        // ── The manual-first door: launch a real card, leave the world up ────
        const cardId = (await ES(
          `window.__mogging.board.createCard('BRAINMAP MANUAL 4242', 'Read the map above, then say hello.')`
        )) as string
        await ES(`window.__mogging.board.startOnCard(${JSON.stringify(cardId)}, 'shell')`)
        await until(() => getSettingsStore()?.getCard(String(cardId))?.paneId != null, 15000)
        const manualPane = getSettingsStore()?.getCard(String(cardId))?.paneId ?? null
        if (manualPane != null) await confirmAgentUp(manualPane)
        writeFileSync(
          join(root, 'out', 'brainmap-manual.json'),
          JSON.stringify({ repo: F.repo, pane: manualPane, anchorWorkspace: anchor.id }, null, 2)
        )
        return
      }

      // ── (d) `mogging map`: 0 ok · 1 non-brain cwd · 3 app down ─────────────
      const cliOk = await cli(['map'], { cwd: F.repo })
      const cliNoBrain = await cli(['map'], { cwd: F.plain })
      const deadDir = join(F.base, 'dead-localappdata')
      mkdirSync(deadDir, { recursive: true })
      const cliAppDown = await cli(['map'], { cwd: F.repo, env: { LOCALAPPDATA: deadDir, XDG_RUNTIME_DIR: deadDir, HOME: deadDir } })
      const cliBadBudget = await cli(['map', '--budget', 'nope'], { cwd: F.repo })
      const cliOkOut = cliOk.stdout
      const cliCodesOk =
        cliOk.code === 0 && cliOkOut.startsWith('hub.ts:') && stampRe.test(cliOkOut.trim().split('\n').pop() ?? '') &&
        cliNoBrain.code === 1 && /no brain|nothing to map|rebuild/i.test(cliNoBrain.stderr) &&
        cliAppDown.code === 3 && /app not running/.test(cliAppDown.stderr) &&
        cliBadBudget.code === 2

      // ── (e) board launch: ON prepends the fenced map; OFF is the task alone ─
      const paneOf = async (cardId: string): Promise<number> => {
        await until(() => getSettingsStore()?.getCard(cardId)?.paneId != null, 20000)
        const pane = getSettingsStore()?.getCard(cardId)?.paneId
        if (pane == null) throw new Error(`card ${cardId} never bound a pane`)
        return pane
      }
      const captureHas = async (pane: number, needle: string, capMs = 25000): Promise<string> => {
        let last = ''
        let lastCode = -1
        let lastErr = ''
        const ok = await until(async () => {
          const c = await cli(['capture', String(pane), '--lines', '400'])
          last = c.stdout
          lastCode = c.code
          lastErr = c.stderr
          return c.code === 0 && last.includes(needle)
        }, capMs, 700)
        if (!ok) {
          const list = await cli(['list'])
          throw new Error(
            `pane ${pane} capture never showed ${needle} — lastCode=${lastCode} stderr=${lastErr.slice(0, 200)} ` +
              `list(code=${list.code})=${list.stdout.slice(0, 300)} tail=${JSON.stringify(last.slice(-500))}`
          )
        }
        return last
      }

      const onCard = (await ES(
        `window.__mogging.board.createCard('BRAINMAP_TASK_4242', 'do the oriented thing 4242')`
      )) as string
      const startedOn = (await ES(`window.__mogging.board.startOnCard(${JSON.stringify(onCard)}, 'shell')`)) as boolean
      const paneOn = await paneOf(String(onCard))
      await confirmAgentUp(paneOn)
      const onCapture = await captureHas(paneOn, 'BRAINMAP_TASK_4242')
      const fenceAt = onCapture.indexOf('```repomap')
      const hubAt = onCapture.indexOf('hub.ts:')
      const taskAt = onCapture.indexOf('BRAINMAP_TASK_4242')
      const onOk = startedOn && fenceAt >= 0 && hubAt > fenceAt && taskAt > hubAt // map first, visibly, then the task

      setOrientAtLaunch(anchor.id, false) // the workspace opts out — zero injection bytes
      await ES(`window.__mogging.workspace.switchByIndex(0)`) // launches anchor from OUR workspace again
      await sleep(800)
      const offCard = (await ES(
        `window.__mogging.board.createCard('BRAINMAP_TASK_OFF_4242', 'the plain task 4242')`
      )) as string
      const startedOff = (await ES(`window.__mogging.board.startOnCard(${JSON.stringify(offCard)}, 'shell')`)) as boolean
      const paneOff = await paneOf(String(offCard))
      await confirmAgentUp(paneOff)
      const offCapture = await captureHas(paneOff, 'BRAINMAP_TASK_OFF_4242')
      const offOk = startedOff && !offCapture.includes('```repomap') && !offCapture.includes('[repomap:')

      const pass = hubLeadsOk && leafCutOk && determinismOk && budgetOk && genOk && cliCodesOk && onOk && offOk
      result = {
        pass,
        hubLeadsOk,
        leafCutOk,
        determinismOk,
        budgetOk, smallLen: smallMap.length, fullLen: fullMap.length,
        genOk, stampGeneration: stampGen(afterRebuild.map),
        cliCodesOk,
        cliCodes: { ok: cliOk.code, noBrain: cliNoBrain.code, appDown: cliAppDown.code, badBudget: cliBadBudget.code },
        onOk, fenceAt, hubAt, taskAt,
        offOk,
        mapHead: fullMap.split('\n').slice(0, 4),
        platform: process.platform
      }
    } catch (e) {
      result = { pass: false, error: String(e), stage: fx ? 'assertions' : 'fixture' }
    }
    brainDebug().dispose()
    try {
      if (fx) rmSync(fx.base, { recursive: true, force: true })
    } catch {
      /* live shells may hold cwds — best effort */
    }
    write(result)
    app.exit(result.pass === true ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}
