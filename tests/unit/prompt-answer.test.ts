import { describe, expect, it, beforeEach } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  answerPromptIfLive,
  closePromptWindows,
  openPromptWindow,
  promptWindowOpen,
  trustDialogLive
} from '../../src/ui/features/agents/prompt-answer'

// A pane's output is not trustworthy input. Everything an agent prints goes through it —
// files it reads, pages it fetches, tool output — so text there is reachable by whoever
// wrote the repo or the dependency. These tests hold the line that recognising a prompt in
// that stream may only ever answer it inside a window the app itself opened.

const TRUST_TAIL = 'Do you trust this folder?\n1. Yes, I trust this folder\nEnter to confirm'

describe('a prompt is answerable only inside its window', () => {
  beforeEach(() => {
    closePromptWindows(1)
    closePromptWindows(2)
  })

  it('refuses a live prompt when no window is open', () => {
    // The whole attack: a pane prints the dialog's words at a moment of its choosing.
    expect(promptWindowOpen(1, 'folder-trust')).toBe(false)
    expect(answerPromptIfLive(1, 'folder-trust'), 'no window, no keystroke').toBe(false)
  })

  it('opens and closes, and the closer is idempotent', () => {
    const close = openPromptWindow(1, 'folder-trust')
    expect(promptWindowOpen(1, 'folder-trust')).toBe(true)
    close()
    expect(promptWindowOpen(1, 'folder-trust')).toBe(false)
    expect(() => close()).not.toThrow()
    expect(promptWindowOpen(1, 'folder-trust')).toBe(false)
  })

  it('scopes a window to ONE pane and ONE prompt', () => {
    const close = openPromptWindow(1, 'folder-trust')
    expect(promptWindowOpen(2, 'folder-trust'), 'a neighbour pane borrows nothing').toBe(false)
    expect(promptWindowOpen(1, 'batch-trap'), 'one prompt does not open another').toBe(false)
    close()
  })

  it('drops a pane’s windows when the pane is gone, so a recycled id inherits nothing', () => {
    openPromptWindow(1, 'folder-trust')
    openPromptWindow(1, 'batch-trap')
    closePromptWindows(1)
    expect(promptWindowOpen(1, 'folder-trust')).toBe(false)
    expect(promptWindowOpen(1, 'batch-trap')).toBe(false)
  })
})

describe('recognising the trust dialog', () => {
  it('needs BOTH halves, so a spent dialog cannot be answered twice', () => {
    expect(trustDialogLive(TRUST_TAIL)).toBe(true)
    // The hint line scrolls away first; the question alone must not match.
    expect(trustDialogLive('Do you trust this folder?')).toBe(false)
    expect(trustDialogLive('Enter to confirm')).toBe(false)
    expect(trustDialogLive(null)).toBe(false)
    expect(trustDialogLive('')).toBe(false)
  })
})

describe('one file may read a pane and write to it', () => {
  // Rule 4. The safety of the two prompts above comes from their windows; this is what
  // stops a THIRD site appearing that has no window at all. It is the same shape as the
  // bug that started this: a shell's prompt mark, read from the stream, was allowed to
  // authorise typing a launch command into a live agent.
  it('no other ui module both reads pane output and writes to a pane', () => {
    const root = join(process.cwd(), 'src', 'ui')
    // Assembled, so this file does not match its own needles.
    const READ = 'readPane' + 'BufferTail'
    const WRITE = ['TerminalChannels' + '.write', 'terminalClient' + '.write']
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(p)
          continue
        }
        if (!entry.name.endsWith('.ts')) continue
        if (entry.name === 'prompt-answer.ts') continue // the one sanctioned site
        const src = readFileSync(p, 'utf8')
        if (src.includes(READ) && WRITE.some((w) => src.includes(w))) {
          offenders.push(p.slice(root.length + 1).replace(/\\/g, '/'))
        }
      }
    }
    walk(root)
    expect(offenders, 'route it through prompt-answer.ts, which requires a window').toEqual([])
  })
})
