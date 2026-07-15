import type { ClipboardEntry } from '@contracts'
import {
  Button,
  Card,
  EmptyState,
  IconButton,
  SectionHeader,
  clear,
  createToggleRow,
  el,
  showToast
} from '../../components'
import {
  clearHistory,
  copyOnSelect,
  historyEnabled,
  history,
  onHistoryChange,
  removeEntry,
  restoreEntry,
  setCopyOnSelect,
  setHistoryEnabled
} from '../../core/clipboard/clipboard-port'

/**
 * Settings § Clipboard — the app's clipboard, and everything it has held this session.
 *
 * The list is the honest part of the feature. A clipboard manager that quietly retains
 * everything you ever copied is a liability in an app whose panes run coding agents:
 * scrollback carries API keys, and a copy is how a key gets from a browser into a CLI.
 * So the ring is IN MEMORY ONLY (it dies with the app — nothing is written to disk),
 * every row names where it came from, and deleting a row that is currently ON the
 * system clipboard also clears the system clipboard. See clipboard.ipc.ts.
 */

const KIND_LABEL: Record<ClipboardEntry['kind'], string> = {
  text: 'Text',
  image: 'Image',
  files: 'Paths'
}

const SOURCE_LABEL: Record<ClipboardEntry['source'], string> = {
  terminal: 'from a terminal',
  app: 'from the app',
  system: 'from another app',
  drop: 'from a drop'
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
const ABSOLUTE = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' })

/** "just now" / "3 minutes ago" / "2 hours ago". Coarse on purpose — the exact instant
 *  lives in the `title`, where it is available without adding noise to every row. */
function relativeTime(at: number, now: number): string {
  const seconds = Math.round((at - now) / 1000)
  const abs = Math.abs(seconds)
  if (abs < 45) return 'just now'
  if (abs < 3600) return RELATIVE.format(Math.round(seconds / 60), 'minute')
  if (abs < 86400) return RELATIVE.format(Math.round(seconds / 3600), 'hour')
  return RELATIVE.format(Math.round(seconds / 86400), 'day')
}

function bytesLabel(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function entryRow(entry: ClipboardEntry, now: number, refresh: () => void): HTMLElement {
  const stamp = el('span', {
    class: 'clip-row-time',
    text: relativeTime(entry.at, now),
    title: ABSOLUTE.format(new Date(entry.at))
  })

  const meta = el('div', { class: 'clip-row-meta' }, [
    el('span', { class: 'clip-row-kind', dataset: { kind: entry.kind }, text: KIND_LABEL[entry.kind] }),
    stamp,
    el('span', { class: 'clip-row-source', text: SOURCE_LABEL[entry.source] }),
    el('span', { class: 'clip-row-bytes', text: bytesLabel(entry.bytes) })
  ])

  // An image row shows the image; everything else shows its (already sanitised,
  // already clamped) preview as preformatted text, so indentation survives.
  const preview =
    entry.kind === 'image' && entry.imageDataUrl
      ? el('img', { class: 'clip-row-image', attrs: { src: entry.imageDataUrl, alt: entry.preview } })
      : el('pre', { class: 'clip-row-preview', text: entry.preview })

  const copyBtn = IconButton({
    icon: 'copy',
    label: 'Copy to clipboard',
    title: 'Put this back on the clipboard',
    onClick: () => {
      void restoreEntry(entry.id).then(() => {
        showToast({ tone: 'success', title: 'Copied' })
        refresh()
      })
    }
  })

  const deleteBtn = IconButton({
    icon: 'trash',
    label: 'Delete from history',
    title: 'Remove this entry (and clear it from the system clipboard if it is current)',
    class: 'icon-btn--danger',
    onClick: () => {
      void removeEntry(entry.id).then(refresh)
    }
  })

  return el('li', { class: 'clip-row' }, [
    el('div', { class: 'clip-row-main' }, [meta, preview]),
    el('div', { class: 'clip-row-actions' }, [copyBtn, deleteBtn])
  ])
}

export function createClipboardSection(): HTMLElement {
  const list = el('ul', { class: 'clip-list' })
  let enabled = historyEnabled()

  const clearBtn = Button({
    label: 'Clear history',
    variant: 'danger',
    size: 'sm',
    icon: 'trash',
    // It clears the SYSTEM clipboard too. That is the point of a privacy control, but a
    // user who loses what they just copied without warning would be right to be annoyed.
    title: 'Erase every entry — and clear the system clipboard',
    onClick: () => {
      void clearHistory().then(() => showToast({ tone: 'success', title: 'Clipboard history cleared' }))
    }
  })

  const render = (entries: ClipboardEntry[]): void => {
    clear(list)
    clearBtn.disabled = !enabled || entries.length === 0
    if (!enabled) {
      list.append(
        el('li', { class: 'clip-empty' }, [
          EmptyState({
            icon: 'shield',
            title: 'Clipboard history is off',
            body: 'The app is not reading or remembering the system clipboard. Turn on Keep a history above to opt in.'
          })
        ])
      )
      return
    }
    if (!entries.length) {
      list.append(
        el('li', { class: 'clip-empty' }, [
          EmptyState({
            icon: 'copy',
            title: 'Nothing copied yet',
            body: 'Anything you copy — here or in another app — shows up in this list. It is kept in memory only, and clears when you quit.'
          })
        ])
      )
      return
    }
    const now = Date.now()
    for (const entry of entries) list.append(entryRow(entry, now, refresh))
  }

  const refresh = (): void => {
    void history().then(render)
  }

  // The ring is main-side and machine-wide, so it changes without this page acting:
  // a copy in another app, or in another window, must appear here live.
  onHistoryChange(render)
  refresh()

  // "just now" stops being true a minute later, and nothing else would redraw it. Re-run
  // only while this tab is actually the visible one — the settings DOM is built once and
  // merely hidden, so an unguarded interval would poll IPC forever in the background.
  setInterval(() => {
    const section = list.closest('.settings-section') as HTMLElement | null
    if (list.isConnected && section && !section.hidden) refresh()
  }, 60_000)

  const copyOnSelectRow = createToggleRow({
    label: 'Copy on select',
    hint: 'Selecting text in a terminal with the mouse copies it immediately, without Ctrl+C. When an agent draws its own UI (Claude Code and co. take the mouse), the agent’s selection copies via the terminal protocol instead — hold Shift (⌥ on macOS) to select with the app.',
    checked: copyOnSelect(),
    onChange: setCopyOnSelect
  })

  const historyRow = createToggleRow({
    label: 'Keep a history',
    hint: 'Off by default. When on, the app checks the machine-wide clipboard about every 800 ms — including copies made in other apps — and keeps up to 100 non-secret entries in memory until you turn it off or quit. Secret-shaped text is never retained.',
    checked: enabled,
    // setHistoryEnabled stops main from RECORDING and drops what it already holds —
    // no separate clearHistory() call, which would only race it.
    onChange: (on) => {
      enabled = on
      setHistoryEnabled(on)
      if (on) refresh()
      else render([])
    }
  })

  return el('div', { class: 'clip-tab' }, [
    Card(
      {
        header: SectionHeader({
          title: 'Behaviour',
          caption:
            'These bindings are handled by the app before the terminal sees them, so they work the same in Claude Code, Codex, Gemini and a bare shell — on Windows and macOS alike.'
        })
      },
      [copyOnSelectRow.el, historyRow.el]
    ),
    Card(
      {
        header: SectionHeader({
          title: 'History',
          caption: 'Newest first. Kept in memory only — quitting the app erases it.',
          action: clearBtn
        })
      },
      [list]
    )
  ])
}
