import { app, type BrowserWindow } from 'electron'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { REPOMAP_DEFAULT_BUDGET, MEMORY_RECALL_DEFAULT_LIMIT } from '@contracts'
import { embedHttpAttemptsForSmoke, serializeMemory } from '@backend/features/brain'
import { getSettingsStore } from '../app-settings'
import {
  brainDebug,
  handleBrainMcp,
  handleBrainMemUsage,
  handleBrainRebuild,
  handleBrainRecallMcp,
  handleBrainRecallUi,
  setEmbedTarget,
  setOrientAtLaunch,
  setRecallAtLaunch,
  setSemanticAllowed
} from '../brain'

// Env-gated RECALL-organ smoke (MOGGING_BRAINRECALL, ADR 0018 revision D):
// memory reaches the agent without being asked for. Curated fixtures + one
// quarantined draft sharing their vocabulary:
//   (a) a task naming a fixture term ranks its memory FIRST — mode 'exact',
//       breakdown returned with components summing to the score, tag and
//       backlink boosts counted, the DRAFT absent from every answer;
//   (b) board launch, both toggles ON (the defaults): the pane's first prompt
//       carries the repomap section AND the "what the team knows" section —
//       proven through `mogging capture`, the same eyes a human would use —
//       with the attribution stamp naming mode + generation; the compose seam
//       proves the ONE shared budget precisely (map + memories ≤ 06's
//       constant); recall OFF → map only; orient OFF → neither;
//   (c) hybrid ONLY under the workspace's semantic consent (FAKE embedder):
//       hits labeled probabilistic with provider+model, RRF components sum —
//       and the exact world before the flip embedded NOTHING (spied), with
//       zero real network ever;
//   (d) bodies never injected: a sentinel string in every fixture BODY appears
//       in no composed prompt (byte-scan) — titles + descriptions only;
//   (e) usage truth: two recalls + one get_memory land EXACT per-slug deltas
//       in the view's data (brain:memUsage), most-used first;
//   (f) `mogging recall` exit codes: 0 ok · 1 no brain for this cwd ·
//       2 usage · 3 app down — the shared table, held.
// MOGGING_BRAINRECALL=HOLD keeps the launched world alive for the manual-first
// rule (a human watches a real card launch start knowing the team's memory).
// Verdict: out/brainrecall-result.json.

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

// Body sentinels: bytes that must NEVER reach a first prompt (arm d).
const SENT_A = 'BODY_SENTINEL_ALPHA_90731'
const SENT_B = 'BODY_SENTINEL_BETA_90732'
const SENT_C = 'BODY_SENTINEL_GAMMA_90733'

const QUATERNION = serializeMemory({
  slug: 'quaternion-panes',
  description: 'How the quaternion pane arithmetic folds ids',
  tags: ['arithmetic'],
  body: `The quaternion fold maps pane ids. ${SENT_A}\nSee [[fold-rules]].\n`
})
const FOLD = serializeMemory({
  slug: 'fold-rules',
  description: 'The fold rules ledger',
  tags: ['arithmetic'],
  body: `Folding ledger notes. ${SENT_B}\nBack to [[quaternion-panes]].\n`
})
const HISTORY = serializeMemory({
  slug: 'pane-history',
  description: 'Why pane moves keep their session',
  tags: ['ops'],
  body: `Pane moves keep sessions. ${SENT_C}\nRoot cause lives in [[quaternion-panes]].\n`
})
// The quarantined draft SHARES the probe vocabulary — its absence from every
// recall answer is the quarantine biting, not a vocabulary accident.
const DRAFT =
  '---\nname: quaternion-draft\ndescription: Auto-captured draft about the quaternion fold\nsource: session\n---\n\nDraft quaternion pane arithmetic notes.\n'

const TASK = 'fix the quaternion pane arithmetic overflow'

interface Fixture {
  base: string
  repo: string
  plain: string
}

function makeFixture(): Fixture {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'mog-brainrecall-')))
  const repo = join(base, 'repo')
  mkdirSync(join(repo, '.memory', 'drafts'), { recursive: true })
  writeFileSync(join(repo, 'keep.ts'), 'export function keeper(): number {\n  return 1\n}\n')
  writeFileSync(join(repo, '.memory', 'quaternion-panes.md'), QUATERNION)
  writeFileSync(join(repo, '.memory', 'fold-rules.md'), FOLD)
  writeFileSync(join(repo, '.memory', 'pane-history.md'), HISTORY)
  writeFileSync(join(repo, '.memory', 'drafts', 'quaternion-draft.md'), DRAFT)
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

type RecallHit = {
  slug: string
  name: string
  description: string
  score: number
  probabilistic?: boolean
  provider?: string
  model?: string
  breakdown?: Record<string, unknown>
}
type RecallReply = { ok: boolean; reason?: string; mode?: string; generation?: number; memories?: RecallHit[] }

export function runBrainRecallSmoke(win: BrowserWindow): void {
  const hold = process.env.MOGGING_BRAINRECALL === 'HOLD'
  const resultFile = join(app.getAppPath(), 'out', 'brainrecall-result.json')
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
      write({ pass: false, error: 'TIMEOUT: brainrecall smoke did not complete' })
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

  /** Breakdown components must SUM to the score — the auditable-arithmetic law. */
  const sums = (h: RecallHit, keys: string[]): boolean => {
    const b = h.breakdown ?? {}
    const total = keys.reduce((acc, k) => acc + (typeof b[k] === 'number' ? (b[k] as number) : NaN), 0)
    return Number.isFinite(total) && Math.abs(total - h.score) < 1e-9
  }
  const slugsOf = (r: RecallReply): string[] => (r.memories ?? []).map((h) => h.slug)
  const noDraft = (r: RecallReply): boolean => !slugsOf(r).includes('quaternion-draft')

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    let fx: Fixture | null = null
    try {
      fx = makeFixture()
      const F = fx
      await sleep(1500)

      // ── The anchor workspace (whose toggles + consent govern the launch) ───
      await ES(`window.__mogging.workspace.create({ name: 'RecallAnchor', cwd: ${JSON.stringify(F.repo)}, paneCount: 1 })`)
      await sleep(3500)
      const anchor = (await ES('window.__mogging.workspace.active()')) as { id: string; ordinal: number }

      const b0 = await handleBrainRebuild({ root: F.repo })
      if (!b0.ok) throw new Error('fixture rebuild refused: ' + JSON.stringify(b0))

      // ── (a) exact ranking: the named memory leads; breakdown; draft absent ─
      const exact = (await handleBrainRecallMcp({ root: F.repo, task: TASK }, undefined)) as RecallReply
      const top = exact.memories?.[0]
      const topB = (top?.breakdown ?? {}) as Record<string, unknown>
      const exactOk =
        exact.ok === true &&
        exact.mode === 'exact' &&
        typeof exact.generation === 'number' &&
        (exact.memories ?? []).length >= 2 &&
        top?.slug === 'quaternion-panes' &&
        sums(top, ['ftsComponent', 'tagComponent', 'backlinkComponent']) &&
        Array.isArray(topB.matchedTags) &&
        (topB.matchedTags as string[]).includes('arithmetic') &&
        topB.backlinks === 2 &&
        (exact.memories ?? []).every((h) => sums(h, ['ftsComponent', 'tagComponent', 'backlinkComponent'])) &&
        noDraft(exact)
      // The tag-only candidate: 'fold-rules' shares no task TERM but wears the
      // matched tag — its presence proves tags mint candidates, not just boosts.
      const tagOnlyOk = slugsOf(exact).includes('fold-rules')
      const badLimit = (await handleBrainRecallMcp({ root: F.repo, task: TASK, limit: 0 }, undefined)) as RecallReply
      const junkOk = badLimit.ok === false && badLimit.reason === 'invalid'

      // A 'shell' launch is a launch NO-OP (launch-port): replay the daemon's
      // typed-launch verdict so the REAL handoff path runs (the board is
      // fail-closed by design).
      const confirmAgentUp = async (paneId: number): Promise<void> => {
        await ES(
          `window.__mogging.agents.detected({ id: ${paneId}, agentId: 'claude', cwd: ${JSON.stringify(F.repo)}, sinceMs: Date.now() })`
        )
      }

      if (hold) {
        // ── The manual-first door: launch a real card, leave the world up ────
        const cardId = (await ES(
          `window.__mogging.board.createCard('BRAINRECALL MANUAL 4242', ${JSON.stringify('Deal with the ' + TASK + ' — read what the team knows above first.')})`
        )) as string
        await ES(`window.__mogging.board.startOnCard(${JSON.stringify(cardId)}, 'shell')`)
        await until(() => getSettingsStore()?.getCard(String(cardId))?.paneId != null, 15000)
        const manualPane = getSettingsStore()?.getCard(String(cardId))?.paneId ?? null
        if (manualPane != null) await confirmAgentUp(manualPane)
        writeFileSync(
          join(root, 'out', 'brainrecall-manual.json'),
          JSON.stringify({ repo: F.repo, pane: manualPane, anchorWorkspace: anchor.id }, null, 2)
        )
        return
      }

      // ── (b) board launch, both toggles ON: map + memories, visibly typed ───
      const paneOf = async (cardId: string): Promise<number> => {
        await until(() => getSettingsStore()?.getCard(cardId)?.paneId != null, 20000)
        const pane = getSettingsStore()?.getCard(cardId)?.paneId
        if (pane == null) throw new Error(`card ${cardId} never bound a pane`)
        return pane
      }
      const captureHas = async (pane: number, needle: string, capMs = 25000): Promise<string> => {
        let last = ''
        const ok = await until(async () => {
          const c = await cli(['capture', String(pane), '--lines', '400'])
          last = c.stdout
          return c.code === 0 && last.includes(needle)
        }, capMs, 700)
        if (!ok) throw new Error(`pane ${pane} capture never showed ${needle} — tail=${JSON.stringify(last.slice(-400))}`)
        return last
      }

      const onCard = (await ES(
        `window.__mogging.board.createCard('BRAINRECALL_TASK_4242', ${JSON.stringify('handle the quaternion pane arithmetic 4242')})`
      )) as string
      const startedOn = (await ES(`window.__mogging.board.startOnCard(${JSON.stringify(onCard)}, 'shell')`)) as boolean
      const paneOn = await paneOf(String(onCard))
      await confirmAgentUp(paneOn)
      const onCapture = await captureHas(paneOn, 'BRAINRECALL_TASK_4242')
      const mapFenceAt = onCapture.indexOf('```repomap')
      const memFenceAt = onCapture.indexOf('```team-memory')
      const attributionAt = onCapture.indexOf('[team-memory: generation ')
      const taskAt = onCapture.indexOf('BRAINRECALL_TASK_4242')
      const launchOk =
        startedOn &&
        mapFenceAt >= 0 &&
        memFenceAt > mapFenceAt && // the map first, then what the team knows, then the task
        // A short needle: capture reflows long lines at the pane's width.
        onCapture.includes('quaternion-panes — How the') &&
        /\[team-memory: generation \d+, exact\]/.test(onCapture) &&
        attributionAt > memFenceAt &&
        taskAt > attributionAt

      // ── The compose seam: the ONE budget, precisely (capture reflows lines) ─
      const composeVia = (): Promise<string> =>
        ES<string>(
          `window.__mogging.agents.compose(${JSON.stringify('handle the quaternion pane arithmetic 4242')}, ${JSON.stringify(F.repo)}, ${JSON.stringify(anchor.id)})`
        )
      const composed = await composeVia()
      const mapMatch = /```repomap\n([\s\S]*?)\n```/.exec(composed)
      const memMatch = /```team-memory\n([\s\S]*?)\n```/.exec(composed)
      const mapLen = mapMatch ? mapMatch[1].length : -1
      const memLen = memMatch ? memMatch[1].length : -1
      const memLines = memMatch ? memMatch[1].split('\n') : []
      const budgetOk =
        mapLen > 0 &&
        memLen > 0 &&
        mapLen + memLen <= REPOMAP_DEFAULT_BUDGET && // combined ≤ 06's ceiling — recall never inflates spawn cost
        memLines.length >= 2 &&
        memLines.length - 1 <= MEMORY_RECALL_DEFAULT_LIMIT && // ≤ K hit lines + the stamp
        /^\[team-memory: generation \d+, exact\]$/.test(memLines[memLines.length - 1])

      // ── (d) bodies never injected: byte-scan the composed prompt + capture ─
      const noBodyOk = [SENT_A, SENT_B, SENT_C].every(
        (s) => !composed.includes(s) && !onCapture.includes(s)
      )

      // ── the toggle matrix (the same seam the launch runs) ──────────────────
      setRecallAtLaunch(anchor.id, false)
      const recallOff = await composeVia()
      const recallOffOk = recallOff.includes('```repomap') && !recallOff.includes('```team-memory')
      setRecallAtLaunch(anchor.id, true)
      setOrientAtLaunch(anchor.id, false)
      const orientOff = await composeVia()
      const orientOffOk = orientOff === 'handle the quaternion pane arithmetic 4242'
      setOrientAtLaunch(anchor.id, true)

      // ── (c-first) the exact world embedded NOTHING — the spies say so ──────
      const zeroEmbedOk = brainDebug().recallEmbedCalls() === 0

      // ── (c) hybrid only with consent: FAKE embedder, labeled, sums ─────────
      if (!setSemanticAllowed(anchor.id, true)) throw new Error('consent flip refused')
      const cfg = setEmbedTarget(anchor.id, 'fake:', 'fake-recall')
      if (!cfg.ok) throw new Error('embed target refused: ' + (cfg.reason ?? ''))
      const embedded = await until(() => brainDebug().embedStats().performed >= 3, 20000)
      const hybrid = (await handleBrainRecallUi({ root: F.repo, task: TASK, workspaceId: anchor.id })) as RecallReply
      const hybridTop = hybrid.memories?.[0]
      const hybridOk =
        embedded &&
        hybrid.ok === true &&
        hybrid.mode === 'hybrid' &&
        (hybrid.memories ?? []).length > 0 &&
        (hybrid.memories ?? []).every(
          (h) => h.probabilistic === true && h.provider === 'fake' && h.model === 'fake-recall' && sums(h, ['baseComponent', 'semComponent'])
        ) &&
        hybridTop?.slug === 'quaternion-panes' &&
        noDraft(hybrid)
      const hybridEmbedOk = brainDebug().recallEmbedCalls() === 1 && embedHttpAttemptsForSmoke() === 0
      // Consent OFF again: the very next recall is exact — deterministic by default.
      setSemanticAllowed(anchor.id, false)
      const backExact = (await handleBrainRecallUi({ root: F.repo, task: TASK, workspaceId: anchor.id })) as RecallReply
      const consentOffOk = backExact.ok === true && backExact.mode === 'exact' && brainDebug().recallEmbedCalls() === 1

      // ── (e) usage truth: two recalls + one get_memory → EXACT deltas ───────
      const usage0 = handleBrainMemUsage({ root: F.repo })
      if (!usage0.ok) throw new Error('memUsage refused: ' + JSON.stringify(usage0))
      const before = new Map(usage0.rows.map((r) => [r.slug, { recalls: r.recalls, reads: r.reads }]))
      const r1 = (await handleBrainRecallMcp({ root: F.repo, task: TASK }, undefined)) as RecallReply
      const r2 = (await handleBrainRecallMcp({ root: F.repo, task: 'pane history sessions' }, undefined)) as RecallReply
      const got = handleBrainMcp('brain.memGet', { root: F.repo, slug: 'quaternion-panes' }, undefined)
      const expected = new Map<string, { recalls: number; reads: number }>()
      for (const slug of [...slugsOf(r1), ...slugsOf(r2)]) {
        const e = expected.get(slug) ?? { recalls: 0, reads: 0 }
        e.recalls += 1
        expected.set(slug, e)
      }
      const gm = expected.get('quaternion-panes') ?? { recalls: 0, reads: 0 }
      gm.reads += 1
      expected.set('quaternion-panes', gm)
      const usage1 = handleBrainMemUsage({ root: F.repo })
      if (!usage1.ok) throw new Error('memUsage refused after: ' + JSON.stringify(usage1))
      const after = new Map(usage1.rows.map((r) => [r.slug, { recalls: r.recalls, reads: r.reads }]))
      const deltasOk =
        got.ok === true &&
        r1.ok === true &&
        r2.ok === true &&
        usage1.rows.every((r) => {
          const b = before.get(r.slug) ?? { recalls: 0, reads: 0 }
          const e = expected.get(r.slug) ?? { recalls: 0, reads: 0 }
          return r.recalls === b.recalls + e.recalls && r.reads === b.reads + e.reads
        }) &&
        [...expected.keys()].every((slug) => after.has(slug))
      const sortedOk = usage1.rows.every(
        (r, i) => i === 0 || usage1.rows[i - 1].recalls + usage1.rows[i - 1].reads >= r.recalls + r.reads
      )

      // ── (f) `mogging recall`: 0 ok · 1 no brain · 2 usage · 3 app down ─────
      const cliOk = await cli(['recall', 'quaternion', 'pane', 'arithmetic'], { cwd: F.repo })
      const cliNoBrain = await cli(['recall', 'anything'], { cwd: F.plain })
      const cliUsage = await cli(['recall'], { cwd: F.repo })
      const cliBadLimit = await cli(['recall', '--limit', 'nope', 'x'], { cwd: F.repo })
      const deadDir = join(F.base, 'dead-localappdata')
      mkdirSync(deadDir, { recursive: true })
      const cliAppDown = await cli(['recall', 'quaternion'], { cwd: F.repo, env: { LOCALAPPDATA: deadDir, XDG_RUNTIME_DIR: deadDir, HOME: deadDir } })
      const cliCodesOk =
        cliOk.code === 0 &&
        cliOk.stdout.startsWith('quaternion-panes\t') &&
        !cliOk.stdout.includes('quaternion-draft') &&
        cliNoBrain.code === 1 && /no team memories|no brain/i.test(cliNoBrain.stderr) &&
        cliUsage.code === 2 &&
        cliBadLimit.code === 2 &&
        cliAppDown.code === 3 && /app not running/.test(cliAppDown.stderr)

      const pass =
        exactOk && tagOnlyOk && junkOk && launchOk && budgetOk && noBodyOk &&
        recallOffOk && orientOffOk && zeroEmbedOk && hybridOk && hybridEmbedOk &&
        consentOffOk && deltasOk && sortedOk && cliCodesOk
      result = {
        pass,
        exactOk,
        exactTop: top ?? null,
        tagOnlyOk,
        junkOk,
        launchOk, mapFenceAt, memFenceAt, attributionAt, taskAt,
        budgetOk, mapLen, memLen, combined: mapLen + memLen, budget: REPOMAP_DEFAULT_BUDGET,
        noBodyOk,
        recallOffOk,
        orientOffOk,
        zeroEmbedOk,
        hybridOk,
        hybridTop: hybridTop ?? null,
        hybridEmbedOk,
        consentOffOk,
        deltasOk,
        sortedOk,
        usageRows: usage1.rows,
        cliCodesOk,
        cliCodes: { ok: cliOk.code, noBrain: cliNoBrain.code, usage: cliUsage.code, badLimit: cliBadLimit.code, appDown: cliAppDown.code },
        recallEmbedCalls: brainDebug().recallEmbedCalls(),
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
