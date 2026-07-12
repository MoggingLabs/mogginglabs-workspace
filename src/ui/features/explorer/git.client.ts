import { GitChannels, type GitFilesEvent } from '@contracts'
import { getBridge } from '../../core/ipc/bridge'

// The explorer's git seam (11/05) — the ONE place this feature names a git channel. The
// file-tree component never sees it: the dock computes decorations and hands the tree a
// paint map, so the component stays free of both channels and git (ADR 0004).

/** Register the folder we're SHOWING. Main resolves the repo root with a filesystem walk —
 *  a non-repo registers nothing and never spawns git. The first list arrives at once. */
export function gitFilesWatch(cwd: string): void {
  getBridge().send(GitChannels.filesWatch, cwd)
}

export function gitFilesUnwatch(cwd: string): void {
  getBridge().send(GitChannels.filesUnwatch, cwd)
}

/** Change-only: an idle repo — polled every 2.5s like always — sends NOTHING. */
export function onGitFiles(cb: (e: GitFilesEvent) => void): () => void {
  return getBridge().on(GitChannels.filesChange, (payload) => {
    const e = payload as GitFilesEvent | null
    if (e && typeof e.root === 'string' && Array.isArray(e.files)) cb(e)
  })
}

/** ONE `check-ignore --stdin` batch. Repo-relative in, the ignored subset back. */
export function gitCheckIgnore(root: string, paths: string[]): Promise<string[]> {
  return getBridge().invoke(GitChannels.checkIgnore, { root, paths }) as Promise<string[]>
}
