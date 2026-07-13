import type { UiFeature } from '../../core/registry/feature-registry'
import {
  ClipboardChannels,
  ReviewChannels,
  type ReviewDiff,
  type ReviewMergeResult
} from '@contracts'
import { createAsyncGuard } from '../../core/async/async-state'
import { getBridge } from '../../core/ipc/bridge'
import { getFocusedPane } from '../../core/layout/focus'
import { setCommands } from '../../core/commands/command-port'
import { Button, createModal, el, icon, showToast } from '../../components'

/**
 * Pre-ship diff review (Phase-3/04): NOTHING an agent wrote lands without a human
 * reading it. The diff arrives already REDACTED (backend scrub) and every line lands
 * in the DOM as a TEXT NODE via textContent — never innerHTML — so a hostile diff
 * line can never become markup. The one mutating verb (merge --no-ff) sits behind a
 * typed confirmation and a clean-repo gate; conflicts are left for a human terminal.
 */

const WT_RE = /^(.*)[\\/]\.mogging[\\/]worktrees[\\/][^\\/]+$/

function reviewTargetFromCwd(cwd: string | undefined | null): { repo: string; worktree: string } | null {
  if (!cwd) return null
  const m = WT_RE.exec(cwd)
  return m ? { repo: m[1], worktree: cwd } : null
}

/** One hunk -> a <pre> of per-line <span>s (textContent only, tint by first char). */
function renderHunk(hunk: string): HTMLElement {
  const pre = el('pre', { class: 'review-hunk' })
  for (const line of hunk.split('\n')) {
    const cls = line.startsWith('@@')
      ? 'rl rl-hunk'
      : line.startsWith('+')
        ? 'rl rl-add'
        : line.startsWith('-')
          ? 'rl rl-del'
          : 'rl'
    const span = document.createElement('span')
    span.className = cls
    span.textContent = line // THE safety property: text node, never parsed as markup
    pre.append(span, document.createTextNode('\n'))
  }
  return pre
}

function renderDiff(diff: ReviewDiff): HTMLElement {
  const body = el('div', { class: 'review-body' })
  if (diff.error) {
    body.append(el('p', { class: 'review-note', text: `Could not read the diff: ${diff.error}` }))
    return body
  }
  const adds = diff.files.reduce((s, f) => s + f.additions, 0)
  const dels = diff.files.reduce((s, f) => s + f.deletions, 0)
  const summary = el('div', { class: 'review-summary' }, [
    el('span', { class: 'review-stat-add', text: `+${adds}` }),
    el('span', { class: 'review-stat-del', text: `−${dels}` }),
    el('span', {
      class: 'review-stat-meta',
      text:
        `${diff.files.length} file${diff.files.length === 1 ? '' : 's'}` +
        (diff.redactions > 0 ? ` · ${diff.redactions} secret${diff.redactions === 1 ? '' : 's'} redacted` : '') +
        (diff.truncated ? ' · truncated (large diff)' : '')
    })
  ])
  body.append(summary)

  if (diff.files.length === 0 && diff.untracked.length === 0) {
    body.append(el('p', { class: 'review-note', text: 'No changes versus the base branch yet.' }))
    return body
  }
  for (const f of diff.files) {
    const section = el('section', { class: 'review-file' })
    section.append(
      el('div', { class: 'review-file-head' }, [
        el('span', { class: 'review-file-path', text: f.path }),
        el('span', { class: 'review-file-counts' }, [
          el('span', { class: 'review-stat-add', text: `+${f.additions}` }),
          el('span', { class: 'review-stat-del', text: `−${f.deletions}` })
        ])
      ])
    )
    for (const h of f.hunks) section.append(renderHunk(h))
    body.append(section)
  }
  if (diff.untracked.length > 0) {
    body.append(
      el('p', {
        class: 'review-note',
        text: `Untracked (not yet added): ${diff.untracked.join(', ')}`
      })
    )
  }
  return body
}

/** One guard for the one call site. Both callers do `void openReview(...)`, so before finding 39 a
 *  rejected diff was an unhandled promise and the UI just SAT there — no modal, no error, and no
 *  way for the user to tell "still working" from "already dead". */
const diffGuard = createAsyncGuard<ReviewDiff>()
let dismissDiffLoading: (() => void) | null = null

async function openReview(repo: string, worktree: string): Promise<void> {
  await diffGuard.run(() => getBridge().invoke(ReviewChannels.diff, { repo, worktree }) as Promise<ReviewDiff>, {
    action: 'read the diff',
    onLoading: () => {
      // The modal only exists once the diff lands, so the waiting state has nowhere else to live.
      // Dismiss any previous one first: a second open supersedes the first, whose onSettle will
      // never run — and a sticky toast nobody takes down is its own bug.
      dismissDiffLoading?.()
      dismissDiffLoading = showToast({ tone: 'info', title: 'Reading the diff…', timeout: 0 })
    },
    onSuccess: (diff) => showReview(diff, repo, worktree),
    // onError stays the default danger toast: there is no panel of ours on screen to render into.
    onSettle: () => {
      dismissDiffLoading?.()
      dismissDiffLoading = null
    },
    // git is local — 15s of silence is a hang, and a hang must not strand "Reading the diff…".
    timeoutMs: 15_000
  })
}

/** Render the review modal for an already-fetched diff. Split from openReview so a
 *  fixture diff can drive both gate states + the footer with no repo (8.5/07b). */
function showReview(diff: ReviewDiff, repo: string, worktree: string): void {
  const modal = createModal({
    title: 'Review changes',
    subtitle: diff.branch && diff.base ? `${diff.branch} → ${diff.base}` : 'worktree diff',
    variant: 'wizard',
    width: 880,
    closeOnBackdrop: false
  })
  modal.el.classList.add('review-modal')
  modal.setBody(renderDiff(diff))

  const footer = el('div', { class: 'review-footer' })
  const rebuildFooter = (): void => {
    footer.replaceChildren()
    // Reviewer gate (4/03): the sign-off state is always visible; unapproved merges
    // demand the DISTINCT typed word "override" — a human can always land, deliberately.
    const gated = diff.approved !== true
    const incomplete = diff.dirty || diff.truncated || diff.unreviewable || diff.untracked.length > 0 || !diff.snapshot
    const blockers = [
      diff.dirty ? 'uncommitted changes' : '',
      diff.untracked.length > 0 ? 'untracked files' : '',
      diff.truncated ? 'truncated diff' : '',
      diff.unreviewable ? 'binary, mode-only, or other non-rendered changes' : '',
      !diff.snapshot ? 'snapshot unavailable' : ''
    ].filter(Boolean)
    // Blocker 2: the sign-off state carries a non-colour difference — a distinct glyph
    // AND a distinct word — so it reads for a colour-blind reviewer and at a glance.
    const gateChip = el('span', { class: `review-gate ${gated ? 'review-gate-closed' : 'review-gate-open'}` }, [
      icon(gated ? 'shield' : 'check-circle', 13),
      el('span', { text: gated ? 'No reviewer sign-off' : 'Approved by reviewer' })
    ])
    const visibleHunks = diff.files.flatMap((file) => file.hunks).join('\n')
    const copy = Button({
      label: 'Copy visible hunks',
      disabled: !visibleHunks.trim(),
      onClick: async () => {
        try {
          await getBridge().invoke(ClipboardChannels.write, { text: visibleHunks })
          showToast({ tone: 'success', title: 'Visible redacted hunks copied' })
        } catch (error) {
          showToast({
            tone: 'danger',
            title: 'Could not copy visible hunks',
            body: error instanceof Error ? error.message : String(error)
          })
        }
      }
    })
    const confirmWord = gated ? 'override' : 'merge'
    const merge = Button({
      label: gated ? `Override & merge into ${diff.base}…` : `Merge into ${diff.base}…`,
      // Danger-styled, not the filled primary that invited the click (07b): a destructive
      // merge should read as "careful", never as "the thing to do".
      variant: 'danger',
      disabled: !diff.branch || diff.files.length === 0 || incomplete,
      onClick: () => {
        // Typed confirmation — clicks can't land a merge; ungated needs "override".
        footer.replaceChildren()
        const input = el('input', {
          class: 'review-confirm-input',
          attrs: {
            type: 'text',
            placeholder: `type "${confirmWord}" to merge ${diff.branch} into ${diff.base}`
          }
        }) as HTMLInputElement
        const go = Button({
          label: gated ? 'Confirm override' : 'Confirm merge',
          variant: 'danger',
          onClick: () => {
            if (input.value.trim().toLowerCase() !== confirmWord) {
              showToast({ tone: 'danger', title: `Type "${confirmWord}" to confirm` })
              return
            }
            void (getBridge().invoke(ReviewChannels.merge, {
              repo,
              worktree,
              override: gated ? input.value.trim().toLowerCase() : undefined
            }) as Promise<ReviewMergeResult>).then(
              (res) => {
                if (res.state === 'merged') {
                  showToast({ tone: 'success', title: `Merged ${diff.branch} into ${diff.base}` })
                  modal.close()
                } else if (res.state === 'dirty') {
                  showToast({
                    tone: 'danger',
                    title: 'Repo has uncommitted changes',
                    body: 'Commit or stash in the repo first — the merge was not started.'
                  })
                  rebuildFooter()
                } else if (res.state === 'ungated') {
                  showToast({
                    tone: 'attention',
                    title: 'No reviewer sign-off',
                    body: 'A reviewer pane must `mogging approve` this branch — or use the typed override.'
                  })
                  rebuildFooter()
                } else if (res.state === 'unreviewable') {
                  showToast({
                    tone: 'danger',
                    title: 'Commit and review the complete change first',
                    body: res.error ?? 'Dirty, untracked, truncated, binary, or mode-only changes cannot be merged from this review.'
                  })
                  rebuildFooter()
                } else if (res.state === 'stale') {
                  showToast({
                    tone: 'attention',
                    title: 'Review is stale',
                    body: res.error ?? 'The source or destination changed. Close this dialog and review again.'
                  })
                  rebuildFooter()
                } else if (res.state === 'conflict') {
                  modal.setSubtitle('Merge paused with conflicts — resolve in a terminal, then commit.')
                  showToast({
                    tone: 'attention',
                    title: 'Conflicts',
                    body: 'The merge is paused in the repo. Resolve in a terminal, then commit.',
                    timeout: 10000
                  })
                  rebuildFooter()
                } else {
                  showToast({ tone: 'danger', title: 'Merge failed', body: res.error })
                  rebuildFooter()
                }
              }
            )
          }
        })
        const cancel = Button({ label: 'Cancel', variant: 'ghost', onClick: () => rebuildFooter() })
        // Safe-first: Cancel precedes the destructive Confirm (was `input, go, cancel`).
        footer.append(input, cancel, go)
        input.focus()
      }
    })
    const close = Button({ label: 'Close', variant: 'ghost', onClick: () => modal.close() })
    // Safe-first: the safe actions precede the danger merge (was `…, merge, close`); the
    // modal auto-focuses the first button (Copy), never the destructive merge.
    footer.append(gateChip)
    if (blockers.length > 0) {
      footer.append(
        el('span', {
          class: 'review-gate review-gate-closed review-merge-blocked',
          attrs: { role: 'status' },
          text: `Merge unavailable: ${blockers.join(', ')}.`
        })
      )
    }
    footer.append(copy, close, merge)
  }
  rebuildFooter()
  modal.setFooter(footer)
  modal.open()
}

export const reviewFeature: UiFeature = {
  name: 'review',
  mount() {
    // Pane ⋯ menu -> "Review changes…" (dispatched by TerminalPane for worktree panes).
    document.addEventListener('mogging:review-pane', (e) => {
      const d = (e as CustomEvent<{ repo: string; worktree: string }>).detail
      if (d?.repo && d?.worktree) void openReview(d.repo, d.worktree)
    })

    // Palette entry — reviews the focused pane's worktree (toast when there is none).
    setCommands('review', [
      {
        id: 'review:changes',
        title: 'Review changes (focused pane)',
        hint: 'Worktree',
        run: () => {
          const target = reviewTargetFromCwd(getFocusedPane()?.cwd)
          if (target) void openReview(target.repo, target.worktree)
          else showToast({ tone: 'attention', title: 'No worktree pane focused', body: 'Review works on isolated agent panes.' })
        }
      }
    ])

    const g = globalThis as Record<string, unknown>
    const dev = (g.__mogging ?? (g.__mogging = {})) as Record<string, unknown>
    dev.review = {
      open: (repo: string, worktree: string) => openReview(repo, worktree),
      // Fixture renderer (8.5/07b FEEDBACKUX): both gate states + the safe-first footer,
      // no repo/worktree.
      showFixture: (approved: boolean, empty = false) =>
        showReview(
          {
            base: 'main',
            branch: 'demo/feature',
            approved,
            files: empty
              ? []
              : [{ path: 'src/app.ts', additions: 3, deletions: 1, hunks: ['@@ -1,2 +1,3 @@\n keep\n+added\n-gone'] }],
            untracked: [],
            redactions: 0,
            truncated: false,
            dirty: false,
            unreviewable: false,
            snapshot: {
              repoId: 'demo-repo',
              branch: 'demo/feature',
              head: '1111111111111111111111111111111111111111',
              base: 'main',
              baseHead: '2222222222222222222222222222222222222222',
              mergeBase: '2222222222222222222222222222222222222222'
            }
          },
          'demo-repo',
          'demo-worktree'
        )
    }
  }
}
