import type { UiFeature } from '../../core/registry/feature-registry'
import {
  ClipboardChannels,
  ReviewChannels,
  type ReviewDiff,
  type ReviewMergeResult
} from '@contracts'
import { getBridge } from '../../core/ipc/bridge'
import { getFocusedPane } from '../../core/layout/focus'
import { setCommands } from '../../core/commands/command-port'
import { Button, createModal, el, showToast } from '../../components'

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

async function openReview(repo: string, worktree: string): Promise<void> {
  const diff = (await getBridge().invoke(ReviewChannels.diff, { repo, worktree })) as ReviewDiff

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
    const gateChip = el('span', {
      class: `review-gate ${gated ? 'review-gate-closed' : 'review-gate-open'}`,
      text: gated ? 'No reviewer sign-off' : 'Approved by reviewer'
    })
    const copy = Button({
      label: 'Copy patch',
      onClick: () => {
        const patch = diff.files.map((f) => f.hunks.join('\n')).join('\n')
        void getBridge().invoke(ClipboardChannels.write, { text: patch })
        showToast({ tone: 'success', title: 'Patch copied (redacted)' })
      }
    })
    const confirmWord = gated ? 'override' : 'merge'
    const merge = Button({
      label: gated ? `Override & merge into ${diff.base}…` : `Merge into ${diff.base}…`,
      variant: 'primary',
      disabled: !diff.branch || diff.files.length === 0,
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
          variant: 'primary',
          onClick: () => {
            if (input.value.trim().toLowerCase() !== confirmWord) {
              showToast({ tone: 'danger', title: `Type "${confirmWord}" to confirm` })
              return
            }
            void (getBridge().invoke(ReviewChannels.merge, {
              repo,
              branch: diff.branch,
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
        const cancel = Button({ label: 'Cancel', onClick: () => rebuildFooter() })
        footer.append(input, go, cancel)
        input.focus()
      }
    })
    const close = Button({ label: 'Close', onClick: () => modal.close() })
    footer.append(gateChip, copy, merge, close)
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
    dev.review = { open: (repo: string, worktree: string) => openReview(repo, worktree) }
  }
}
