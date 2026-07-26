import { app, type BrowserWindow } from 'electron'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  distillAttemptsForSmoke,
  distillHttpAttemptsForSmoke,
  serializeMemory,
  setDraftCapsForSmoke
} from '@backend/features/brain'
import { boardDebug, createCard } from '../board'
import { brainDebug, handleBrainOverview, handleBrainRebuild, setEmbedTarget, setSemanticAllowed } from '../brain'
import { captureStatsForSmoke, handleBrainDrafts, setDistillAllowed, setDistillModel } from '../brain-capture'
import { setIntegrationsGrant } from '../integrations'
import { spawnPaneMcpSmokeClient, type PaneMcpSmokeClient } from './pane-mcp-smoke-client'

// Env-gated dual-memory capture smoke (MOGGING_BRAINCAP, ADR 0018 revision C):
// drafts are captured FROM SIGNALS the app already watches — a REAL scripted
// pane runs a fail→fix OSC 133 arc and its session end lands a reasoning
// draft; a board card reaching Done lands a knowledge draft — then the whole
// quarantine law is proven through the REAL `bin/mogging-mcp.mjs`:
//   (a) both draft kinds exist on disk with exact structured fields — the
//       failing command + exit code, the fixed arc, the card's task — under
//       `auto: true` + `source:` provenance frontmatter;
//   (b) search finds drafts RANKED BELOW a curated fixture memory, every
//       draft hit flagged `draft: true` (the curated hit carries no new key);
//   (c) drafts are absent from suggest_connections AND from the recall probe
//       (semantic mode over the FAKE embedder) — quarantine as construction;
//   (d) grantless promote refuses; a granted promote MOVES the file bytes-
//       verbatim into `.memory/` and suggestions now include it (fixture-known
//       score, breakdown served);
//   (e) discard on the promoted slug refuses (promoted memories are
//       permanent); discard on a draft deletes exactly that file;
//   (f) distill OFF → ZERO provider calls (the adapter spy); ON with the FAKE
//       endpoint → prose present and labeled (distilled/provider/model), the
//       structured body preserved BELOW it, zero real sockets;
//   (g) retention honesty: cap N, land N+5 more → 5+ evictions, COUNTED in
//       the drafts answer and the overview — never silent;
//   (h) `.memory/drafts/` holds only `.md` files afterwards;
//   (i) the RING law — the pane's block ladder is a 300-entry ring that spans
//       restarts, so the capture high-water mark must be a BLOCK ID, never an
//       array index: three lives on one pane (arc → a life that floods the ring
//       past its cap → one more arc) and the THIRD life still lands its own
//       reasoning draft. With an index mark that third life captured nothing at
//       all — slice(length) of a saturated ring is empty.
// Verdict: out/braincap-result.json.

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

const CURATED = serializeMemory({
  slug: 'flumox-notes',
  description: 'Flumox subsystem notes',
  tags: ['ops'],
  body: 'Flumox lore: the flumox pipeline is fickle.\n'
})

const ARC_COMMAND = 'node flumox-test.mjs'

// The scripted pane's arc: REAL OSC 133 marks through the REAL PTY — the same
// bytes a shell-integrated session emits, which is exactly the vocabulary
// capture is allowed to read. Fail (exit 1), retry verbatim, fix (exit 0).
const ARC_SOURCE =
  `const w = (s) => process.stdout.write(s)\n` +
  `const OSC = (s) => '\\x1b]133;' + s + '\\x07'\n` +
  `w(OSC('A') + OSC('B') + ${JSON.stringify(ARC_COMMAND)} + OSC('C') + '\\r\\n')\n` +
  `w('flumox exploding\\r\\n')\n` +
  `w(OSC('D;1'))\n` +
  `w(OSC('A') + OSC('B') + ${JSON.stringify(ARC_COMMAND)} + OSC('C') + '\\r\\n')\n` +
  `w('flumox fixed\\r\\n')\n` +
  `w(OSC('D;0'))\n`

interface Fixture {
  base: string
  repo: string
}

function makeFixture(): Fixture {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'mog-braincap-')))
  const repo = join(base, 'repo')
  const files: Record<string, string> = {
    'src/keep.ts': 'export function keeper(): number {\n  return 1\n}\n',
    '.memory/flumox-notes.md': CURATED
  }
  for (const [rel, src] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true })
    writeFileSync(join(repo, rel), src)
  }
  git(repo, ['init'])
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repo, ['config', 'core.autocrlf', 'false'])
  git(repo, ['config', 'user.email', 'smoke@mogging.test'])
  git(repo, ['config', 'user.name', 'Mogging Smoke'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'fixture'])
  writeFileSync(join(base, 'arc.mjs'), ARC_SOURCE)
  return { base, repo }
}

interface ToolAnswer {
  ok: boolean
  isError: boolean
  rpcError: string | null
  text: string
  data: Record<string, unknown>
}

type MemHit = {
  slug: string
  name: string
  description: string
  tags: string[]
  root: string
  draft?: boolean
  source?: string
}
type SuggestOut = {
  slug: string
  score: number
  breakdown: { sharedLinks: string[]; sharedTags: string[]; sharedTerms: string[]; weights: Record<string, number> }
}

export function runBrainCapSmoke(win: BrowserWindow): void {
  const resultFile = join(app.getAppPath(), 'out', 'braincap-result.json')
  // RE-ENTRY guard (electron-vite dev respawns electron after app.exit).
  if (existsSync(resultFile)) {
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
  // Progress ledger for the net below: each act stamps where it got to, and the ring act
  // (the long tail) stamps every step, so a stall still writes a result file that NAMES it.
  const marks: Record<string, unknown> = { stage: 'boot' }
  const mark = <T>(key: string, value: T): T => {
    marks[key] = value
    return value
  }
  // THE NET MUST BEAT THE GATE. The outer budget (qa-smokes: `run_smoke BRAINCAP … 300`)
  // covers the whole `npm run dev` — the electron-vite build and the app's boot are spent
  // before a line of this runs — so a 280s net could never fire first, and an overrun
  // reported MISSING: no result file, no flags, nothing to diagnose from. 220s leaves ~80s
  // for build+boot+teardown and still gives this smoke >3x its healthy runtime (~60s).
  setTimeout(() => {
    let stats: unknown = null
    try {
      stats = captureStatsForSmoke()
    } catch {
      /* the feature may not have initialised — the marks are the evidence that matters */
    }
    write({
      pass: false,
      error: 'TIMEOUT: braincap smoke did not complete',
      marks,
      captureStats: stats,
      platform: process.platform
    })
    app.exit(1)
  }, 220000)

  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const root = app.getAppPath()

  const cli = (args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; stdout: string }> =>
    new Promise((res) => {
      execFile(
        process.execPath,
        [join(root, 'bin', 'mogging.mjs'), ...args],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...extraEnv }, timeout: 15000, windowsHide: true },
        (err, stdout) => res({ code: err ? ((err as unknown as { code?: number }).code ?? 1) : 0, stdout: String(stdout) })
      )
    })

  const call = async (c: PaneMcpSmokeClient, name: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> => {
    const m = await c.rpc('tools/call', { name, arguments: args })
    if (m.error) return { ok: false, isError: false, rpcError: m.error.message ?? 'error', text: '', data: {} }
    const r = (m.result ?? {}) as { content?: { text?: string }[]; isError?: boolean }
    const text = r.content?.[0]?.text ?? ''
    let data: Record<string, unknown> = {}
    if (r.isError !== true) {
      try {
        data = JSON.parse(text) as Record<string, unknown>
      } catch {
        /* non-JSON success payloads keep data empty */
      }
    }
    return { ok: r.isError !== true, isError: r.isError === true, rpcError: null, text, data }
  }

  const waitFor = async (probe: () => Promise<boolean> | boolean, tries = 60, gapMs = 500): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      if (await probe()) return true
      await sleep(gapMs)
    }
    return false
  }

  const mems = (a: ToolAnswer): MemHit[] => (Array.isArray(a.data.memories) ? (a.data.memories as MemHit[]) : [])
  const suggestions = (a: ToolAnswer): SuggestOut[] =>
    Array.isArray(a.data.suggestions) ? (a.data.suggestions as SuggestOut[]) : []

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    let fx: Fixture | null = null
    const clients: PaneMcpSmokeClient[] = []
    try {
      marks.stage = 'fixture'
      fx = makeFixture()
      const F = fx
      const draftsDir = join(F.repo, '.memory', 'drafts')
      const draftFiles = (): string[] => {
        try {
          return readdirSync(draftsDir).sort()
        } catch {
          return []
        }
      }
      await sleep(1500)

      await ES(`window.__mogging.workspace.create({ name: 'CapA', cwd: ${JSON.stringify(F.repo)}, paneCount: 2 })`)
      await sleep(3500)
      const wsA = (await ES('window.__mogging.workspace.active()')) as { id: string; ordinal: number }
      const paneA1 = String(wsA.ordinal * 100 + 1)
      const paneA2 = wsA.ordinal * 100 + 2

      marks.stage = 'rebuild'
      const built = await handleBrainRebuild({ root: F.repo })
      if (!built.ok) throw new Error('fixture rebuild refused: ' + JSON.stringify(built))

      const c1 = await spawnPaneMcpSmokeClient({ cli, paneId: paneA1, mcpPath: join(root, 'bin', 'mogging-mcp.mjs') })
      clients.push(c1)
      await c1.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} })

      // The recall lens for probe (c): consent + the FAKE embedder — zero net.
      if (!setSemanticAllowed(wsA.id, true)) throw new Error('semantic consent flip refused')
      const semCfg = setEmbedTarget(wsA.id, 'fake:', 'fake-embed')
      if (!semCfg.ok) throw new Error('fake embed target refused')

      const attempts0 = distillAttemptsForSmoke()

      // ── The REAL scripted pane: fail → retry → fix, then session end ───────
      marks.stage = 'arc'
      const sent = await cli(['send', String(paneA2), 'node ../arc.mjs'])
      if (sent.code !== 0) throw new Error('could not drive the arc pane')
      const paneBlocks = `(() => { const p = (window.__mogging.panes || []).find((x) => x.id === ${paneA2}); return p ? p.blocks() : [] })()`
      const arcTracked = await waitFor(async () => {
        const blocks = (await ES<{ command: string; exitCode?: number }[]>(paneBlocks)) ?? []
        const runs = blocks.filter((b) => b.command === ARC_COMMAND)
        return runs.length >= 2 && runs.some((b) => b.exitCode === 1) && runs.some((b) => b.exitCode === 0)
      })
      if (!arcTracked) {
        // Shell testimony before the verdict (the house debugging law: only the pane's own
        // bytes prove what the shell did) — the arc first went red on macos CI with no
        // evidence beyond this error string.
        const testimony = await cli(['capture', String(paneA2)])
        const blocksNow = (await ES<{ command: string; exitCode?: number }[]>(paneBlocks)) ?? []
        throw new Error(
          'the arc pane never tracked its blocks — blocks=' +
            JSON.stringify(blocksNow).slice(0, 500) +
            ' capture(code ' + testimony.code + ')=' + JSON.stringify(testimony.stdout).slice(0, 1500)
        )
      }
      // Session end = the shell process exits; markDead hands the ladder over.
      marks.stage = 'session-end'
      mark('arcTracked', arcTracked)
      await cli(['send', String(paneA2), 'exit'])
      const sessionLanded = mark('sessionLanded', await waitFor(() => draftFiles().some((f) => f.startsWith('session-'))))
      const sessionFile = draftFiles().find((f) => f.startsWith('session-')) ?? ''
      const sessionSlug = sessionFile.replace(/\.md$/, '')
      const sessionBytes = sessionFile ? readFileSync(join(draftsDir, sessionFile), 'utf8') : ''

      // ── The board card reaching Done ───────────────────────────────────────
      marks.stage = 'card'
      const board = boardDebug().ensureForCwd(F.repo)
      const card1 = createCard({ boardId: board.id, title: 'Flumox rollout', notes: 'Rolled the flumox pipeline out.', labels: ['ops'], actor: 'human' })
      if (!card1) throw new Error('card create refused')
      boardDebug().patchDirect(card1.id, { lane: 'done' })
      const cardLanded = await waitFor(() => draftFiles().includes('card-flumox-rollout.md'))
      const cardBytes = cardLanded ? readFileSync(join(draftsDir, 'card-flumox-rollout.md'), 'utf8') : ''

      // ── (a) both kinds, exact structured fields, honest provenance ─────────
      const sessionOk =
        sessionLanded &&
        sessionBytes.includes(`\`${ARC_COMMAND}\` — exit 1`) && // the failing command + exit code
        sessionBytes.includes(`\`${ARC_COMMAND}\` — exit 0`) &&
        sessionBytes.includes('## Commands') &&
        sessionBytes.includes('## Failures') &&
        sessionBytes.includes('## Fixed') &&
        sessionBytes.includes('succeeded on attempt 2') &&
        sessionBytes.includes('auto: true') &&
        sessionBytes.includes('source: session') &&
        !sessionBytes.includes('distilled: true')
      const cardOk =
        cardLanded &&
        cardBytes.includes('## Task') &&
        cardBytes.includes('- Flumox rollout') &&
        cardBytes.includes('auto: true') &&
        cardBytes.includes('source: card') &&
        cardBytes.includes('tags: [auto, card, ops]') &&
        !cardBytes.includes('distilled: true')
      // (f-first) consent OFF the whole way here: the adapter was NEVER called.
      const distillOffOk = distillAttemptsForSmoke() === attempts0

      // The quarantine is GIT-INVISIBLE: two drafts just landed and the repo
      // is still clean — the review merge gate (clean-repo law) stays open.
      const cleanOk = git(F.repo, ['status', '--porcelain']) === ''

      // ── (b) search: drafts BELOW curated, flagged on every hit ─────────────
      marks.stage = 'search'
      const found = await call(c1, 'search_memories', { query: 'flumox' })
      const hits = mems(found)
      const curatedIdx = hits.findIndex((h) => h.slug === 'flumox-notes')
      const draftIdxs = hits.map((h, i) => (h.draft === true ? i : -1)).filter((i) => i >= 0)
      const draftSlugs = new Set(hits.filter((h) => h.draft === true).map((h) => h.slug))
      const searchOk =
        found.ok &&
        curatedIdx === 0 &&
        !('draft' in hits[0]) && // the curated hit carries no new key
        draftSlugs.has(sessionSlug) &&
        draftSlugs.has('card-flumox-rollout') &&
        draftIdxs.length >= 2 &&
        draftIdxs.every((i) => i > curatedIdx) && // ranked BELOW curated, all of them
        hits.filter((h) => h.draft === true).every((h) => h.source === 'session' || h.source === 'card')

      // ── (c) quarantined from suggestions AND the recall probe ──────────────
      marks.stage = 'quarantine'
      const suggest1 = await call(c1, 'suggest_connections', { slug: 'flumox-notes' })
      const suggestClean =
        suggest1.ok && suggestions(suggest1).every((s) => s.slug !== sessionSlug && s.slug !== 'card-flumox-rollout')
      const embedded = await waitFor(() => brainDebug().embedStats().performed >= 1)
      const recall = await call(c1, 'search_memories', { query: 'flumox', mode: 'semantic' })
      const recallHits = mems(recall)
      const recallOk =
        embedded &&
        recall.ok &&
        recallHits.some((h) => h.slug === 'flumox-notes') &&
        recallHits.every((h) => h.slug !== sessionSlug && h.slug !== 'card-flumox-rollout')

      // ── (d) grantless promote refuses; granted promote MOVES the file ──────
      marks.stage = 'promote'
      const promoteNone = await call(c1, 'promote_memory', { slug: 'card-flumox-rollout' })
      const grantlessOk = !!promoteNone.rpcError && /grant/i.test(promoteNone.rpcError)
      setIntegrationsGrant({ workspaceId: wsA.id, writeTools: 'all', web: 'off', actOrigins: [] })
      const preMove = readFileSync(join(draftsDir, 'card-flumox-rollout.md'))
      let promoted: ToolAnswer = promoteNone
      const promotedOk = await waitFor(async () => {
        promoted = await call(c1, 'promote_memory', { slug: 'card-flumox-rollout' })
        return promoted.ok
      }, 15, 400)
      const promotedPath = join(F.repo, '.memory', 'card-flumox-rollout.md')
      const movedOk =
        promotedOk &&
        promoted.data.slug === 'card-flumox-rollout' &&
        !draftFiles().includes('card-flumox-rollout.md') &&
        existsSync(promotedPath) &&
        readFileSync(promotedPath).equals(preMove) // bytes verbatim — a move, not a rewrite
      // Promotion is the ONE door into git: the repo's only dirt is now the
      // promoted memory (commit-ready, team-bound); the quarantine stays invisible.
      const promoteDirt = git(F.repo, ['status', '--porcelain'])
      const promoteGitOk = promoteDirt.includes('card-flumox-rollout.md') && !promoteDirt.includes('drafts')
      const suggest2 = await call(c1, 'suggest_connections', { slug: 'flumox-notes' })
      const promotedSuggestion = suggestions(suggest2).find((s) => s.slug === 'card-flumox-rollout')
      const suggestNowOk =
        suggest2.ok &&
        !!promotedSuggestion &&
        promotedSuggestion.score === 3 && // tag 'ops' (2) + term 'flumox' (1), fixture-known
        JSON.stringify(promotedSuggestion.breakdown.sharedTags) === JSON.stringify(['ops']) &&
        JSON.stringify(promotedSuggestion.breakdown.sharedTerms) === JSON.stringify(['flumox'])

      // ── (e) discard: promoted refuses; a draft deletes ─────────────────────
      marks.stage = 'discard'
      const discardPromoted = await call(c1, 'discard_memory', { slug: 'card-flumox-rollout' })
      const discardPromotedOk =
        discardPromoted.isError && /promoted|not a draft/i.test(discardPromoted.text) && existsSync(promotedPath)
      const discardDraft = await call(c1, 'discard_memory', { slug: sessionSlug })
      const discardDraftOk = discardDraft.ok && !draftFiles().includes(sessionFile)

      // ── (f) distill ON with the FAKE provider: labeled, additive prose ─────
      marks.stage = 'distill'
      setDistillAllowed(wsA.id, true)
      setDistillModel(wsA.id, 'fake-chat')
      const attempts1 = distillAttemptsForSmoke()
      const card2 = createCard({ boardId: board.id, title: 'Flumox phase two', notes: 'Second phase.', labels: ['ops'], actor: 'human' })
      if (!card2) throw new Error('card2 create refused')
      boardDebug().patchDirect(card2.id, { lane: 'done' })
      const distilledLanded = await waitFor(() => draftFiles().includes('card-flumox-phase-two.md'))
      const distilledBytes = distilledLanded ? readFileSync(join(draftsDir, 'card-flumox-phase-two.md'), 'utf8') : ''
      const proseAt = distilledBytes.indexOf('Distilled: ')
      const structureAt = distilledBytes.indexOf('## Task')
      const distilledOk =
        distilledLanded &&
        distilledBytes.includes('distilled: true') &&
        distilledBytes.includes('provider: fake') &&
        distilledBytes.includes('model: fake-chat') &&
        proseAt >= 0 &&
        structureAt > proseAt && // the structured body SURVIVES, below the prose
        distilledBytes.includes('- Flumox phase two') &&
        distillAttemptsForSmoke() === attempts1 + 1 &&
        distillHttpAttemptsForSmoke() === 0 // FAKE = zero real sockets, ever

      // ── (g) retention honesty: cap 4, land 9 more → evictions COUNTED ──────
      marks.stage = 'retention'
      setDraftCapsForSmoke({ maxDrafts: 4 })
      const before = handleBrainDrafts({ root: F.repo })
      const beforeRows = before.ok ? before.drafts.length : -1
      const beforeEvicted = before.ok ? before.evicted : -1
      const bulkTitles = ['Bulk one', 'Bulk two', 'Bulk three', 'Bulk four', 'Bulk five', 'Bulk six', 'Bulk seven', 'Bulk eight', 'Bulk nine']
      for (const title of bulkTitles) {
        const c = createCard({ boardId: board.id, title, notes: '', labels: [], actor: 'human' })
        if (!c) throw new Error('bulk card create refused')
        boardDebug().patchDirect(c.id, { lane: 'done' })
      }
      const settled = await waitFor(() => {
        const a = handleBrainDrafts({ root: F.repo })
        return a.ok && a.evicted === beforeEvicted + (beforeRows + 9 - 4)
      })
      const after = handleBrainDrafts({ root: F.repo })
      const overview = handleBrainOverview({ root: F.repo })
      const retentionOk =
        settled &&
        after.ok &&
        after.drafts.length === 4 &&
        draftFiles().length === 4 &&
        overview.ok &&
        overview.drafts === 4 &&
        overview.draftsEvicted === (after.ok ? after.evicted : -1) // the overview says the same truth

      // ── (h) the quarantine holds only .md files ────────────────────────────
      const onlyMdOk = draftFiles().length > 0 && draftFiles().every((f) => f.endsWith('.md'))

      // ── (i) the RING law: the capture high-water mark is a BLOCK ID, never an index ─
      // The pane's block ladder is a 300-entry RING (block-tracker.ts MAX_BLOCKS) that
      // DELIBERATELY spans restarts — scrollback survives a restart, so the ladder does
      // too. An array index goes stale the instant that ring shifts: once saturated,
      // list().length stops growing, so slice(index) returns EMPTY and every
      // post-restart life captured NOTHING — the Brain never heard that session existed
      // (and it degrades before saturation too: at 295/300 with 20 new blocks, 15 are
      // lost). Block.id is a monotonic mint, so it stays true across shifts.
      // THREE lives on the SAME pane, in order:
      //   life 1  the real arc above — the mark parks at its last block;
      //   life 2  floods the ring PAST the cap and ends. THAT emission is what parks the
      //           pre-fix mark at ladder.length (300), where an index can never grow again;
      //   life 3  one distinct arc — which must still land its OWN reasoning draft.
      // Pre-fix, life 3 emits nothing at all (slice(300) of a 300-long ladder is empty):
      // no third draft on disk and the emission counter never moves.
      // The fill is REAL OSC 133 bytes written into the pane's own xterm (PANERESTART's
      // fill technique) — the vocabulary the tracker reads from a shell — so the ring it
      // saturates is the shipped ring at the shipped cap, and the saturation itself is
      // ASSERTED: a run that failed to overrun the ring goes red, never quietly vacuous.
      //
      // Poll budgets here are sized to what each step DOES, not padded: this act is the
      // gate's long tail and every second of it is spent before any of the seventeen flags
      // above can be written out. A restart is a real PTY respawn (7.5s), the fill is one
      // ~13KB xterm write the tracker drains in well under a second (9s), a shell `exit` is
      // four pokes of 2.4s (the PANERESTART trap: a booting shell drops the first write),
      // the life-3 arc is two blocks (6s), and the draft is one file write behind the
      // session-end channel (12s) — 61.2s worst case, against 85.6s before.
      setDraftCapsForSmoke({}) // (g) is measured — retention must not eat this evidence
      marks.stage = 'ring'
      const RING_CAP = 300 // block-tracker.ts MAX_BLOCKS
      const RING_FILL = 330 // past the cap even with life 1's blocks: the ring MUST shift
      const LIFE3_CMD = 'ringlife3-probe'
      const ringPane = `(window.__mogging.panes || []).find((x) => x.id === ${paneA2})`
      const ringButton = `document.querySelector('.layout-slot[data-pane-id="${paneA2}"] .pane-dead-restart')`
      const readRing = (): Promise<{ n: number; last: number }> =>
        ES<{ n: number; last: number }>(
          `(() => { const p = ${ringPane}; if (!p) return { n: -1, last: -1 }; const b = p.blocks(); ` +
            `return { n: b.length, last: b.length ? b[b.length - 1].id : -1 } })()`
        ).catch(() => ({ n: -1, last: -1 }))
      const ringRestart = async (): Promise<boolean> => {
        const clicked = await ES<number>(
          `(() => { const el = ${ringButton}; if (!el) return 0; el.click(); return 1 })()`
        ).catch(() => 0)
        if (clicked !== 1) return false
        return waitFor(
          () => ES<boolean>(`(() => { const p = ${ringPane}; return !!p && !p.dead() })()`).catch(() => false),
          25, 300 // 7.5s: one PTY respawn through the daemon
        )
      }
      // Session end is a REAL process exit. A freshly respawned shell can miss the first
      // write while it boots (the PANERESTART trap), so the poke repeats until the pane
      // holds the dead fact itself.
      const ringEndLife = async (): Promise<boolean> => {
        for (let poke = 0; poke < 4; poke++) {
          await ES(`(() => { const p = ${ringPane}; if (p) p.write('exit\\r'); return 1 })()`).catch(() => 0)
          const died = await waitFor(
            () => ES<boolean>(`(() => { const p = ${ringPane}; return !!p && p.dead() })()`).catch(() => false),
            6, 400 // 2.4s per poke, four pokes: the retries are the coverage, not the window
          )
          if (died) return true
        }
        return false
      }
      // Life 3's draft by CONTENT, not by filename: the slug is minted from the ladder
      // the emission happened to carry, and only the bytes can say whose life it was.
      const life3Draft = (): string => {
        for (const f of draftFiles()) {
          if (!f.startsWith('session-')) continue
          try {
            const b = readFileSync(join(draftsDir, f), 'utf8')
            if (b.includes(LIFE3_CMD)) return b
          } catch {
            /* a draft mid-write reads as not-yet */
          }
        }
        return ''
      }
      const emissions0 = captureStatsForSmoke().session

      // life 2: flood the ring past its cap, then end the session
      const life2Alive = mark('life2Alive', await ringRestart())
      if (life2Alive) {
        await ES(
          `(() => { const p = ${ringPane}; if (!p) return 0; ` +
            `const E = String.fromCharCode(27), BEL = String.fromCharCode(7); ` +
            `const osc = (s) => E + ']133;' + s + BEL; let s = '\\r\\n'; ` +
            `for (let i = 1; i <= ${RING_FILL}; i++) ` +
            `s += osc('A') + osc('B') + 'ringfill-' + i + osc('C') + '\\r\\n' + osc('D;0'); ` +
            `p.term.write(s); return ${RING_FILL} })()`
        ).catch(() => 0)
      }
      // BOTH halves of "the ring really shifted" in ONE predicate. Split across two round
      // trips they were a race by construction: at the instant `n` first reaches 300 the
      // last id is EXACTLY 300, and only the poll gap made the follow-up read see 301+.
      // Waiting on the conjunction is the same claim with the luck taken out — ids outran
      // indices while the ring sat at its cap, observed together.
      const ringSaturated = mark(
        'ringSaturated',
        life2Alive &&
          (await waitFor(
            async () => {
              const r = await readRing()
              return r.n >= RING_CAP && r.last > RING_CAP
            },
            30, 300 // 9s: one ~13KB xterm write, drained by the tracker
          ))
      )
      const ringFilled = mark('ringFilled', await readRing())
      const life2Ended = mark('life2Ended', ringSaturated && (await ringEndLife()))

      // life 3: one distinct arc, and its draft is the whole claim
      const life3Alive = mark('life3Alive', life2Ended && (await ringRestart()))
      if (life3Alive) {
        await ES(
          `(() => { const p = ${ringPane}; if (!p) return 0; ` +
            `const E = String.fromCharCode(27), BEL = String.fromCharCode(7); ` +
            `const osc = (s) => E + ']133;' + s + BEL; const c = ${JSON.stringify(LIFE3_CMD)}; ` +
            `p.term.write('\\r\\n' + osc('A') + osc('B') + c + osc('C') + '\\r\\n' + osc('D;1') + ` +
            `osc('A') + osc('B') + c + osc('C') + '\\r\\n' + osc('D;0')); return 1 })()`
        ).catch(() => 0)
      }
      const life3Minted = mark(
        'life3Minted',
        life3Alive &&
          (await waitFor(
            async () => (await readRing()).last >= ringFilled.last + 2,
            20, 300 // 6s: two blocks from one xterm write
          ))
      )
      const ringAfterLife3 = mark('ringAfterLife3', await readRing())
      const life3Ended = mark('life3Ended', life3Minted && (await ringEndLife()))
      const life3Landed = mark(
        'life3Landed',
        life3Ended && (await waitFor(() => life3Draft() !== '', 24, 500)) // 12s: one draft file write
      )
      const life3Bytes = life3Draft()
      const ringEmissions = mark('ringEmissions', captureStatsForSmoke().session - emissions0)
      marks.stage = 'verdict'
      const ringOk =
        life2Alive &&
        ringSaturated &&
        ringFilled.n === RING_CAP && // the ring sits AT its cap — from here an index is a lie
        ringFilled.last > RING_CAP && // ids outran indices: the shift really happened
        life2Ended &&
        life3Alive &&
        life3Minted &&
        ringAfterLife3.n === RING_CAP && // still saturated, so a pre-fix slice(300) IS empty
        life3Ended &&
        life3Landed &&
        life3Bytes.includes('source: session') &&
        life3Bytes.includes(`\`${LIFE3_CMD}\` — exit 1`) &&
        life3Bytes.includes(`\`${LIFE3_CMD}\` — exit 0`) &&
        life3Bytes.includes('succeeded on attempt 2') &&
        ringEmissions >= 2 // life 2 AND life 3 both spoke (pre-fix: only life 2 ever does)

      const pass =
        sessionOk && cardOk && distillOffOk && cleanOk && searchOk && suggestClean && recallOk &&
        grantlessOk && movedOk && promoteGitOk && suggestNowOk && discardPromotedOk && discardDraftOk &&
        distilledOk && retentionOk && onlyMdOk && ringOk
      result = {
        pass,
        cleanOk,
        promoteGitOk,
        sessionOk,
        sessionSlug,
        sessionHead: sessionBytes.slice(0, 400),
        cardOk,
        cardHead: cardBytes.slice(0, 300),
        distillOffOk,
        searchOk,
        searchHits: hits.map((h) => `${h.slug}${h.draft ? ':draft' : ''}`),
        suggestClean,
        recallOk,
        recallHits: recallHits.map((h) => h.slug),
        grantlessOk,
        grantlessMsg: promoteNone.rpcError,
        movedOk,
        suggestNowOk,
        promotedSuggestion: promotedSuggestion ?? null,
        discardPromotedOk,
        discardPromotedMsg: discardPromoted.text.slice(0, 200),
        discardDraftOk,
        distilledOk,
        distilledHead: distilledBytes.slice(0, 400),
        retentionOk,
        retention: { beforeRows, beforeEvicted, after: after.ok ? { rows: after.drafts.length, evicted: after.evicted } : null },
        onlyMdOk,
        ringOk,
        ring: {
          cap: RING_CAP,
          fill: RING_FILL,
          life2Alive,
          ringSaturated,
          ringFilled, // { n, last }: n must BE the cap, last must have outrun it
          life2Ended,
          life3Alive,
          life3Minted,
          ringAfterLife3,
          life3Ended,
          life3Landed,
          ringEmissions, // 2 post-fix; 1 pre-fix — life 3 never reaches the channel
          life3Head: life3Bytes.slice(0, 400)
        },
        captureStats: captureStatsForSmoke(),
        platform: process.platform
      }
    } catch (e) {
      result = { pass: false, error: String(e), stage: fx ? 'assertions' : 'fixture', marks }
    }
    setDraftCapsForSmoke({})
    for (const c of clients) c.kill()
    brainDebug().dispose()
    try {
      if (fx) rmSync(fx.base, { recursive: true, force: true })
    } catch {
      /* a live shell may hold the cwd — best effort */
    }
    write(result)
    app.exit(result.pass === true ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}
