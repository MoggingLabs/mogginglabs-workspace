import { execFile } from 'node:child_process'
import { ipcMain } from 'electron'
import {
  BoardChannels,
  type Board,
  type BoardCard,
  type BoardGhResult,
  type LinkStatus,
  type ServiceLink
} from '@contracts'
import { getSettingsStore } from './app-settings'
import { boardGhWorld } from './fixture-port'
import { applyCardPatch, createCard, noteCardActivity, onCardLaneChange, patchBoardMeta } from './board'
import { linkCardDirect, linkForCard, linkedRefs, setLinkTransitionRules } from './services'

/**
 * Board ↔ GitHub, two-way (ADR 0015). READS ride the user's own gh and stay
 * ungated: detect the origin remote, import open issues as backlog cards,
 * find the PR for a card's worktree branch. WRITES — create/close an issue —
 * additionally demand the board's `github.writeBack` grant (default OFF,
 * risk-confirmed in Board settings) and happen only on an explicit verb or an
 * explicitly enabled rule; there is no silent mutation path. The app still
 * holds no credential: gh authenticates itself, and a reason string never
 * carries a token. Card text leaves the machine ONLY through the writeBack
 * door (ghPush's title/body) — the one deliberate, human-granted exception to
 * the local-only rule, which is exactly why it has its own grant.
 */

type RunResult = { ok: boolean; stdout: string; reason?: string }

function run(cmd: 'gh' | 'git', args: string[], cwd?: string): Promise<RunResult> {
  const world = boardGhWorld()
  if (world) return world.run(cmd, args)
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: 15_000, windowsHide: true, encoding: 'utf8', ...(cwd ? { cwd } : {}) },
      (err, stdout, stderr) => {
        if (err) {
          const raw = String(stderr || err.message || 'failed').trim()
          resolve({ ok: false, stdout: '', reason: raw.slice(0, 200) || `${cmd} failed` })
        } else {
          resolve({ ok: true, stdout: String(stdout) })
        }
      }
    )
  })
}

/** The engine's links ride the fixture adapter under the harness ('fake'),
 *  the real gh adapter otherwise — decided where the link is minted. */
const linkService = (): string => boardGhWorld()?.linkService ?? 'github'

/** "owner/repo" from the origin remote's URL — github.com forms only. */
export function parseRepoRef(url: string): string | null {
  const m =
    /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim()) ??
    /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(url.trim()) ??
    /^ssh:\/\/git@github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(url.trim())
  return m ? `${m[1]}/${m[2]}` : null
}

const boardOr = (boardId: unknown): Board | null =>
  typeof boardId === 'string' ? (getSettingsStore()?.getBoard(boardId) ?? null) : null

async function ghDetect(boardId: unknown): Promise<BoardGhResult> {
  const board = boardOr(boardId)
  if (!board) return { ok: false, reason: 'unknown board' }
  if (board.projectKey.startsWith('::')) return { ok: false, reason: 'this board has no project folder' }
  const r = await run('git', ['-C', board.projectKey, 'remote', 'get-url', 'origin'])
  if (!r.ok) return { ok: false, reason: r.reason ?? 'no origin remote' }
  const repoRef = parseRepoRef(r.stdout)
  if (!repoRef) return { ok: false, reason: 'the origin remote is not a github.com repository' }
  patchBoardMeta(board.id, { repoRef })
  return { ok: true, repoRef }
}

/** Board's repoRef, detecting once when absent — import/find call through here. */
async function requireRepoRef(board: Board): Promise<{ repoRef?: string; reason?: string }> {
  if (board.repoRef) return { repoRef: board.repoRef }
  const detected = await ghDetect(board.id)
  return detected.ok && detected.repoRef ? { repoRef: detected.repoRef } : { reason: 'bind a GitHub repository first (Board settings → Detect repo)' }
}

async function ghImport(raw: unknown): Promise<BoardGhResult> {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as { boardId?: unknown; limit?: unknown }
  const board = boardOr(r.boardId)
  if (!board) return { ok: false, reason: 'unknown board' }
  const bound = await requireRepoRef(board)
  if (!bound.repoRef) return { ok: false, reason: bound.reason ?? 'no repository' }
  const limit = Math.max(1, Math.min(50, Math.floor(Number(r.limit)) || 25))
  const res = await run('gh', [
    'issue',
    'list',
    '-R',
    bound.repoRef,
    '--state',
    'open',
    '--json',
    'number,title,body',
    '--limit',
    String(limit)
  ])
  if (!res.ok) return { ok: false, reason: res.reason ?? 'gh issue list failed' }
  let rows: { number: number; title: string; body?: string }[]
  try {
    const parsed = JSON.parse(res.stdout) as unknown
    rows = Array.isArray(parsed) ? (parsed as typeof rows) : []
  } catch {
    return { ok: false, reason: 'gh returned something that was not JSON' }
  }
  const already = linkedRefs()
  const store = getSettingsStore()
  if (!store) return { ok: false, reason: 'the board store is unavailable' }
  let created = 0
  for (const row of rows) {
    if (!Number.isInteger(row.number) || typeof row.title !== 'string' || !row.title) continue
    const ref = `${bound.repoRef}#${row.number}`
    if (already.has(ref)) continue // an issue that's already a card stays ONE card
    const card = createCard(
      { boardId: board.id, title: row.title, notes: typeof row.body === 'string' ? row.body : '', lane: 'backlog', actor: 'sync' },
      'sync'
    )
    if (!card) continue
    linkCardDirect(card.id, ref, 'issue', linkService())
    noteCardActivity(card.id, 'github', `imported from ${ref}`)
    created++
  }
  return { ok: true, created }
}

async function ghFindPr(cardId: unknown): Promise<BoardGhResult> {
  const store = getSettingsStore()
  const card = typeof cardId === 'string' ? store?.getCard(cardId) : null
  if (!store || !card) return { ok: false, reason: 'unknown card' }
  const board = store.getBoard(card.boardId)
  if (!board) return { ok: false, reason: 'unknown board' }
  if (!card.branch) return { ok: false, reason: 'the card has no worktree branch to search by' }
  const bound = await requireRepoRef(board)
  if (!bound.repoRef) return { ok: false, reason: bound.reason ?? 'no repository' }
  const res = await run('gh', ['pr', 'list', '-R', bound.repoRef, '--head', card.branch, '--state', 'all', '--json', 'number', '--limit', '1'])
  if (!res.ok) return { ok: false, reason: res.reason ?? 'gh pr list failed' }
  let rows: { number: number }[]
  try {
    const parsed = JSON.parse(res.stdout) as unknown
    rows = Array.isArray(parsed) ? (parsed as typeof rows) : []
  } catch {
    return { ok: false, reason: 'gh returned something that was not JSON' }
  }
  if (!rows.length || !Number.isInteger(rows[0]?.number)) return { ok: false, reason: `no PR found for ${card.branch}` }
  const ref = `${bound.repoRef}#${rows[0].number}`
  const linked = linkCardDirect(card.id, ref, 'pr', linkService())
  if (!linked.ok) return { ok: false, reason: linked.reason ?? 'link refused' }
  noteCardActivity(card.id, 'github', `linked ${ref} (branch ${card.branch})`)
  return { ok: true, ref }
}

/** The ONE write-back gate. Every mutation funnels through here. */
const writeBackRefusal = (board: Board): string | null =>
  board.config.github.writeBack ? null : 'write-back is OFF for this board — enable it in Board settings (it asks you to confirm the risk)'

async function ghPush(cardId: unknown): Promise<BoardGhResult> {
  const store = getSettingsStore()
  const card = typeof cardId === 'string' ? store?.getCard(cardId) : null
  if (!store || !card) return { ok: false, reason: 'unknown card' }
  const board = store.getBoard(card.boardId)
  if (!board) return { ok: false, reason: 'unknown board' }
  const refusal = writeBackRefusal(board)
  if (refusal) return { ok: false, reason: refusal }
  if (linkForCard(card.id)) return { ok: false, reason: 'the card is already linked — unlink it first' }
  const bound = await requireRepoRef(board)
  if (!bound.repoRef) return { ok: false, reason: bound.reason ?? 'no repository' }
  const res = await run('gh', [
    'issue',
    'create',
    '-R',
    bound.repoRef,
    '--title',
    card.title,
    '--body',
    card.notes.trim() || 'Created from the MoggingLabs board.'
  ])
  if (!res.ok) return { ok: false, reason: res.reason ?? 'gh issue create failed' }
  const num = /\/issues\/(\d+)\s*$/.exec(res.stdout.trim())?.[1]
  if (!num) return { ok: false, reason: 'gh did not return an issue URL' }
  const ref = `${bound.repoRef}#${num}`
  linkCardDirect(card.id, ref, 'issue', linkService())
  noteCardActivity(card.id, 'github', `created issue ${ref}`)
  return { ok: true, ref }
}

async function ghClose(cardId: unknown): Promise<BoardGhResult> {
  const store = getSettingsStore()
  const card = typeof cardId === 'string' ? store?.getCard(cardId) : null
  if (!store || !card) return { ok: false, reason: 'unknown card' }
  const board = store.getBoard(card.boardId)
  if (!board) return { ok: false, reason: 'unknown board' }
  const refusal = writeBackRefusal(board)
  if (refusal) return { ok: false, reason: refusal }
  const link = linkForCard(card.id)
  if (!link || link.kind !== 'issue') return { ok: false, reason: 'the card has no linked issue' }
  const [repo, num] = link.ref.split('#')
  if (!repo || !/^\d+$/.test(num ?? '')) return { ok: false, reason: 'the stored link ref is malformed' }
  const res = await run('gh', ['issue', 'close', '-R', repo, num])
  if (!res.ok) return { ok: false, reason: res.reason ?? 'gh issue close failed' }
  noteCardActivity(card.id, 'github', `closed issue ${link.ref}`)
  return { ok: true, ref: link.ref }
}

// ── Inbound rules: transitions the engine saw → lane moves the board makes ────

function applyTransitionRules(card: BoardCard, link: ServiceLink, status: LinkStatus): void {
  const board = getSettingsStore()?.getBoard(card.boardId)
  if (!board || card.lane === 'done' || card.archivedAt) return
  const merged = link.kind === 'pr' && status.state === 'merged' && board.config.rules.prMergedToDone
  const closed = link.kind === 'issue' && status.state === 'closed' && board.config.rules.issueClosedToDone
  if (!merged && !closed) return
  const done = applyCardPatch(card.id, { lane: 'done' }, { actor: 'sync' })
  if (done.ok) {
    noteCardActivity(card.id, 'rule', merged ? `PR merged → Done (${link.ref})` : `issue closed → Done (${link.ref})`)
  }
}

export function registerGithubBoard(): void {
  ipcMain.handle(BoardChannels.ghDetect, (_e, boardId: unknown) => ghDetect(boardId))
  ipcMain.handle(BoardChannels.ghImport, (_e, raw: unknown) => ghImport(raw))
  ipcMain.handle(BoardChannels.ghFindPr, (_e, cardId: unknown) => ghFindPr(cardId))
  ipcMain.handle(BoardChannels.ghPush, (_e, cardId: unknown) => ghPush(cardId))
  ipcMain.handle(BoardChannels.ghClose, (_e, cardId: unknown) => ghClose(cardId))
  setLinkTransitionRules(applyTransitionRules)
  // Auto-link (read-only rule): a card entering Review with a branch and no
  // link looks up its PR. Opt-in per board, like every rule.
  onCardLaneChange((card, _from) => {
    if (card.lane !== 'review' || !card.branch || linkForCard(card.id)) return
    const board = getSettingsStore()?.getBoard(card.boardId)
    if (!board?.config.rules.autoLinkPr) return
    void ghFindPr(card.id)
  })
}

/** Smoke-only handles (BOARDGH drives the real handlers through these). */
export const githubBoardDebug = { ghDetect, ghImport, ghFindPr, ghPush, ghClose, applyTransitionRules }
