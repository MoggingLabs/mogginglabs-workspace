import { ExplorerChannels, type ExplorerEntry, type ExplorerResult } from '@contracts'
import type { UiFeature } from '../../core/registry/feature-registry'
import { el, createFileTree, type FileTreeHandle } from '../../components'
import { getBridge } from '../../core/ipc/bridge'

/**
 * DEV-only file-tree harness (Phase-11/02). The component is channel-free by
 * contract (ADR 0004), so the FILETREE smoke needs one place that injects a
 * loader and mounts a standalone tree into #content — this is it. Two mounts:
 *
 *  - `__mogging.filetree.mount(root)`  — the REAL `explorer:list` channel behind
 *    a spy, so the smoke can assert laziness (no dir is listed before its first
 *    expand) against the live seam.
 *  - `__mogging.filetree.mountSynthetic(dirs, filesPerDir, hostileName?)` — a
 *    generated in-renderer listing (no fs, no cap), so ten thousand ROWS and a
 *    hostile filename are exercised regardless of what a host OS allows on disk.
 *
 * Nothing here ships to users: the feature body is DEV-gated and the production
 * bundle tree-shakes it to a no-op mount.
 */

export const filetreeDevFeature: UiFeature = {
  name: 'filetree-dev',
  mount(ctx) {
    if (!import.meta.env.DEV) return
    const w = window as unknown as { __mogging?: Record<string, unknown>; __ftActivations?: string[] }
    w.__mogging = w.__mogging ?? {}

    const calls: string[] = []
    let handle: FileTreeHandle | null = null
    let host: HTMLElement | null = null

    const mountWith = async (list: (path: string, showHidden: boolean) => Promise<ExplorerResult>, root: string): Promise<boolean> => {
      host?.remove()
      calls.length = 0
      handle = createFileTree({
        list,
        onActivate: (e) => {
          w.__ftActivations = [...(w.__ftActivations ?? []), e.path]
        }
      })
      host = el('div', { class: 'ft-dev-host' }, [handle.el])
      ctx.content.append(host)
      await handle.setRoot(root)
      return true // primitive on purpose — executeJavaScript cannot clone a handle
    }

    w.__mogging.filetree = {
      mount: (root: string) =>
        mountWith(async (path, showHidden) => {
          calls.push(path)
          return (await getBridge().invoke(ExplorerChannels.list, { path, showHidden })) as ExplorerResult
        }, root),
      mountSynthetic: (dirs: number, filesPerDir: number, hostileName?: string) => {
        const root = '/synth'
        const dirName = (i: number): string => 'd' + String(i).padStart(3, '0')
        const list = (path: string): Promise<ExplorerResult> => {
          calls.push(path)
          if (path === root) {
            const entries: ExplorerEntry[] = []
            for (let i = 0; i < dirs; i++) entries.push({ name: dirName(i), path: `${root}/${dirName(i)}`, kind: 'dir', isRepo: i === 0 })
            if (hostileName) entries.push({ name: hostileName, path: `${root}/hostile`, kind: 'file' })
            return Promise.resolve({ ok: true, path, parent: null, entries, truncated: false })
          }
          const entries: ExplorerEntry[] = []
          for (let i = 0; i < filesPerDir; i++) entries.push({ name: `f${String(i).padStart(5, '0')}.txt`, path: `${path}/f${i}`, kind: 'file' })
          return Promise.resolve({ ok: true, path, parent: root, entries, truncated: false })
        }
        return mountWith(list, root)
      },
      calls: () => [...calls],
      // Handle verbs the smoke drives — wrapped so every return is clone-safe.
      setExpanded: async (dirs: string[]) => {
        await handle?.setExpanded(dirs)
        return true
      },
      reveal: async (path: string) => {
        await handle?.reveal(path)
        return true
      },
      applyChanged: async (dirs: string[]) => {
        await handle?.applyChanged(dirs)
        return true
      },
      expandedDirs: () => handle?.expandedDirs() ?? [],
      focusList: () => {
        handle?.focusList()
        return true
      }
    }
  }
}
