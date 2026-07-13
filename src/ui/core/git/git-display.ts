import type { GitStatus } from '@contracts'

export type GitTone = 'clean' | 'dirty' | 'conflict' | 'unknown'

export interface GitDisplay {
  branchLabel: string
  worktreeLabel: string
  stateLabel: string
  stagedLabel: string
  comparisonLabel: string
  tone: GitTone
  title: string
  menuLabel: string
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

const leaf = (p: string): string => {
  const trimmed = p.replace(/[\\/]+$/, '')
  return trimmed.split(/[\\/]/).pop() || trimmed
}

const divergenceLabel = (status: GitStatus): string => {
  if (!status.available || !status.head) return status.available && !status.head ? 'no commits yet' : ''
  if (!status.baseBranch) return ''
  if (!status.baseAhead && !status.baseBehind) return `= ${status.baseBranch}`
  const counts = [status.baseAhead ? `↑${status.baseAhead}` : '', status.baseBehind ? `↓${status.baseBehind}` : '']
    .filter(Boolean)
    .join(' ')
  return `${counts} vs ${status.baseBranch}`
}

/** One formatting policy for the header, tooltip, and pane menu. Git can count staged paths and
 * commits already made; it deliberately never guesses how many future commits the user intends. */
export function displayGitStatus(status: GitStatus): GitDisplay {
  const branchLabel = status.detached ? `detached @ ${status.branch}` : status.branch
  const worktreeName = status.linkedWorktree ? leaf(status.root) : ''
  const branchLeaf = status.branch.split('/').pop() ?? status.branch
  const worktreeLabel = worktreeName && worktreeName !== branchLeaf ? worktreeName : ''
  const tone: GitTone = !status.available
    ? 'unknown'
    : status.conflicted > 0
      ? 'conflict'
      : status.dirty
        ? 'dirty'
        : 'clean'
  const stateLabel = !status.available
    ? 'status unavailable'
    : status.conflicted > 0
      ? plural(status.conflicted, 'conflict')
      : status.dirty
        ? `${status.changed} uncommitted`
        : 'clean'
  const stagedLabel = status.available && status.dirty ? `${status.staged} staged` : ''
  const comparisonLabel = divergenceLabel(status)

  const lines = [
    `${status.detached ? 'Detached HEAD' : 'Branch'}: ${status.branch}`,
    `Worktree: ${status.root}${status.linkedWorktree ? ' (linked)' : ''}`
  ]
  if (!status.available) {
    lines.push('Git status unavailable; branch identity is best-effort.')
  } else {
    lines.push(status.head ? `HEAD: ${status.head.slice(0, 12)}` : 'HEAD: no commits yet')
    lines.push(
      status.dirty
        ? `Working tree: dirty · ${plural(status.changed, 'uncommitted path')}`
        : 'Working tree: clean'
    )
    lines.push(
      `Staged: ${status.staged} · Unstaged: ${status.unstaged} · Untracked: ${status.untracked} · Conflicts: ${status.conflicted}`
    )
    if (status.baseBranch) {
      lines.push(
        `Compared with ${status.baseBranch}: ${plural(status.baseAhead, 'commit')} ahead · ${plural(status.baseBehind, 'commit')} behind`
      )
    }
    if (status.upstream) {
      lines.push(`Upstream ${status.upstream}: ${status.ahead} to push · ${status.behind} to pull`)
    }
  }

  const menuLabel = [
    `${status.detached ? 'Detached at' : 'Branch:'} ${status.branch}`,
    worktreeLabel ? `worktree ${worktreeLabel}` : '',
    stateLabel,
    stagedLabel,
    comparisonLabel
  ]
    .filter(Boolean)
    .join(' · ')

  return {
    branchLabel,
    worktreeLabel,
    stateLabel,
    stagedLabel,
    comparisonLabel,
    tone,
    title: lines.join('\n'),
    menuLabel
  }
}
