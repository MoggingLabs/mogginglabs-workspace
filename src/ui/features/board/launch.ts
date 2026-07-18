import {
  GitChannels,
  TerminalChannels,
  WorktreeChannels,
  formulaPaneId,
  isAgentCliId,
  type BoardCard,
  type BoardCardPatch,
  type CreateWorktreeResult,
  type PaneId
} from '@contracts'
import { getBridge } from '../../core/ipc/bridge'
import { openWorkspaceFromTemplate } from '../../core/workspace/open-service'
import { openWizard } from '../../core/workspace/wizard-port'
import { getWorkspaces, requestWorkspaceSwitch } from '../../core/workspace/workspace-info-port'
import { onPaneAgentSession } from '../../core/agents/agent-session-port'
import { composeFirstPrompt } from '../agents/launch'
import { paneInstance } from '../../core/terminal/pane-instance-port'
import { setActiveView } from '../../core/shell/view-port'
import { showToast } from '../../components'

/**
 * Start an agent on a card (through the open/worktree/write seams) — the
 * board's whole point, and the queue's one verb. providerId is a plain string,
 * NOT narrowed to AgentCliId: the contract is to safely handle a FAILED OR
 * UNKNOWN agent (BOARDFAIL's exact property). An unknown/unlaunchable id still
 * opens a pane, binds the card for diagnosis, and fail-closes when no agent
 * ever becomes `running` — card text is arbitrary user prose, and typing it
 * into a pane whose agent never appeared turns that prose into shell input.
 */

/** 'handed' = the agent got the task. Everything else is fail-CLOSED (the task
 *  was NOT sent), with the reason: the 9s startup window elapsed, or the
 *  card/pane binding broke mid-launch. */
export type LaunchOutcome = 'handed' | 'failed-startup' | 'failed-unbound'

export interface LaunchResult {
  opened: boolean
  /** Resolves once the handoff settled. null when nothing opened. */
  outcome: Promise<LaunchOutcome> | null
}

/** What a launcher needs from whoever holds the cards — the view's model and
 *  the queue engine both satisfy it. */
export interface CardPort {
  findCard(id: string): BoardCard | undefined
  patchCard(card: BoardCard, patch: BoardCardPatch): void
}

export async function startOnCard(
  model: CardPort,
  cardId: string,
  providerId: string,
  opts?: { cwd?: string; actor?: string }
): Promise<LaunchResult> {
  const bridge = getBridge()
  const card = model.findCard(cardId)
  if (!card) return { opened: false, outcome: null }
  const snap = getWorkspaces()
  const active = snap.workspaces.find((w) => w.id === snap.activeId) ?? snap.workspaces[0]
  const cwd = opts?.cwd ?? active?.cwd ?? ''
  if (!cwd) {
    // No folder to anchor the task to — hand off to the wizard instead (real agents only).
    if (isAgentCliId(providerId)) openWizard({ name: card.title.slice(0, 28), mix: [{ provider: providerId, count: 1 }] })
    showToast({ tone: 'info', title: 'Pick a folder', body: 'The card binds when launched from a workspace.' })
    return { opened: false, outcome: null }
  }
  // Worktree isolation when the folder is a repo (03) — never blocks the launch.
  let paneCwds: (string | null)[] | undefined
  let branch: string | null = null
  try {
    const isRepo = (await bridge.invoke(GitChannels.query, cwd)) != null
    if (isRepo) {
      const wt = (await bridge.invoke(WorktreeChannels.create, { repo: cwd })) as CreateWorktreeResult
      if (wt.ok && wt.path) {
        paneCwds = [wt.path]
        // Managed worktrees live at .mogging/worktrees/<slug> on mogging/<slug> —
        // remember the branch ON the card so approval/PR lookups survive the pane.
        const slug = wt.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
        branch = slug ? `mogging/${slug}` : null
      }
    }
  } catch {
    /* plain cwd launch */
  }
  const opened = openWorkspaceFromTemplate({
    name: card.title.slice(0, 28) || 'Task',
    cwd,
    paneCount: 1,
    assignments: [providerId],
    paneCwds
  })
  if (!opened) return { opened: false, outcome: null }
  const paneId = formulaPaneId(opened.ordinal, 1) // a fresh workspace's first slot
  const targetInstance = paneInstance(paneId as PaneId)
  model.patchCard(card, {
    paneId,
    workspaceId: opened.id,
    branch,
    lane: card.lane === 'backlog' || card.lane === 'todo' ? 'doing' : card.lane
  })
  // The task IS the agent's first prompt: one write through the existing terminal
  // path, user content renderer -> PTY only (never telemetry/notify/logs).
  //
  // WHEN is the whole problem: the daemon says when an agent actually appears in
  // the pane's process subtree (typed-launch detection) — wait for THAT and hand
  // the task to something listening. Detection failure fails CLOSED: keep the
  // failed pane visible for diagnosis and say the task was NOT sent.
  //
  // 06: cold panes start ORIENTED — the compose seam prepends the project's
  // repomap as a fenced block when this workspace opted in (the default),
  // typed visibly through the same write as the task. Composed up front, once:
  // the prompt the handoff sends is fixed before any timer arms.
  const task = `${card.title}\n\n${card.notes}`.trim().replace(/\r/g, '')
  const prompt = await composeFirstPrompt({
    task,
    root: paneCwds?.[0] ?? cwd,
    anchorWorkspaceId: active?.id ?? null
  })
  let handed = false
  let offSession: (() => void) | undefined
  let fallback: ReturnType<typeof setTimeout> | undefined
  let settle: ReturnType<typeof setTimeout> | undefined
  let settleOutcome: (o: LaunchOutcome) => void = () => {}
  const outcome = new Promise<LaunchOutcome>((resolve) => {
    settleOutcome = resolve
  })
  const stillBound = (): boolean => {
    const current = model.findCard(cardId)
    // Instance identity catches pane-id REUSE (a recreated pane wearing the old
    // number must not receive the old card's task — BOARDFAIL's reuse case).
    // A pane launched while the BOARD view is open has no xterm instance YET —
    // the grid mounts it later — so an undefined capture accepts the mount;
    // ownership still rides the card binding (paneId + workspaceId), which a
    // reused id from a different workspace cannot satisfy.
    const instanceOk = targetInstance === undefined || paneInstance(paneId as PaneId) === targetInstance
    return instanceOk && current?.paneId === paneId && current?.workspaceId === opened.id
  }
  const cleanup = (): void => {
    offSession?.()
    offSession = undefined
    if (fallback) clearTimeout(fallback)
    fallback = undefined
    if (settle) clearTimeout(settle)
    settle = undefined
  }
  const hand = (): void => {
    if (handed || !stillBound()) {
      cleanup()
      if (!handed) settleOutcome('failed-unbound')
      return
    }
    handed = true
    cleanup()
    bridge.send(TerminalChannels.write, { id: paneId as PaneId, data: prompt + '\r' })
    settleOutcome('handed')
  }
  offSession = onPaneAgentSession((id, session) => {
    // Only `running` (the backend saw the process in the pane's PTY subtree)
    // means there is something on the other end of the keyboard — never the
    // app's own launch write, never an agent going AWAY.
    if (id !== (paneId as PaneId) || !session?.running) return
    // And only THE agent this card launched: a different CLI appearing in the
    // pane — hand-typed by the user, or a stray process misattributed by a
    // busy machine's process table (found live 2026-07-16) — must never
    // receive prose meant for another. 'shell' keeps the open door (a plain
    // terminal hands to whatever the user starts there — the orchestration
    // flow's contract); an UNKNOWN provider id hands to nothing, ever
    // (BOARDFAIL's fail-closed guarantee, now independent of detection noise).
    const accepts = providerId === 'shell' || (isAgentCliId(providerId) && session.provider === providerId)
    if (!accepts) return
    if (fallback) clearTimeout(fallback)
    fallback = undefined
    if (settle) clearTimeout(settle)
    settle = setTimeout(hand, 800) // it is up; give it a beat to paint a prompt to type into
  })
  fallback = setTimeout(() => {
    if (handed) return
    const bound = stillBound()
    cleanup()
    settleOutcome('failed-startup')
    if (!bound) return
    showToast({
      tone: 'danger',
      title: 'Agent did not start',
      body: 'The task was not sent. Open the pane to inspect the CLI error, then retry from the card.',
      timeout: 0,
      action: {
        label: 'Open pane',
        onClick: () => {
          requestWorkspaceSwitch(opened.id)
          setActiveView('grid')
        }
      }
    })
  }, 9000)
  return { opened: true, outcome }
}
