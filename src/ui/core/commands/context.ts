import { activeView, type AppView } from '../shell/view-port'
import { getWorkspaces } from '../workspace/workspace-info-port'

/**
 * The state a command needs in order to answer "may I run right now?".
 *
 * The audit (finding 29) found shortcuts that fired into places the user could not see:
 * Ctrl+Shift+D split a pane while the Board was on screen — in a workspace whose entire host
 * is `display:none` and whose rail tab is `display:none` too. The split happened, correctly,
 * invisibly, to a workspace the user had no way to identify. A keystroke that mutates
 * something you cannot see is indistinguishable from a keystroke that did nothing.
 *
 * So every command may declare when it is available, and the palette shows the refusal
 * instead of hiding it.
 */
export interface CommandContext {
  activeView: AppView
  /** A real blocking dialog is up (.modal-overlay). NOT the palette — see below. */
  modalOpen: boolean
  editableFocused: boolean
  workspaceId: string | null
}

/** true → runnable. Otherwise the reason, in words a user can act on. */
export type CommandAvailability = true | { enabled: false; reason: string }

/**
 * The shape a typing decision reads off an element. PLAIN DATA on purpose, so the rule
 * itself can be asserted under node — the DOM read is `probe()` below, and only that.
 * Same idiom as core/commands/chords.ts: the rule spelled longhand at each call site is
 * the rule that drifts.
 */
export interface EditableProbe {
  /** `tagName` as the DOM reports it — 'INPUT', 'TEXTAREA', 'BODY'. */
  tag: string
  contentEditable?: boolean
  /**
   * Inside a `.xterm` root. xterm reads the keyboard through a hidden
   * `<textarea class="xterm-helper-textarea">` inside every pane — `term.focus()` focuses
   * that proxy, and it is what a keystroke in a terminal targets. Keyed off `.xterm` (the
   * root class xterm's own stylesheet is built on, so it cannot drift) rather than the
   * textarea's class, which is internal.
   */
  inTerminal?: boolean
}

/**
 * Typing. A shortcut must never steal a keystroke from a text field.
 *
 * With one exception, and it is most of the app: the terminal's keyboard proxy is a
 * `<textarea>`, so a tagName test could not tell a focused TERMINAL — this app's resting
 * state, auto-focused on every pane and workspace switch — from a focused webhook-URL box.
 * That made `shortcutsBlocked` true almost always, and every chord below it died in silence:
 * Ctrl+Shift+D, Ctrl+T, Ctrl+Shift+Enter, Ctrl+Alt+arrows, Ctrl+1..9. No toast, because the
 * handler returns before it can even refuse.
 *
 * The pane verbs exist precisely to be pressed while you are typing in a terminal — that is
 * why they capture and stopPropagation, "so xterm never sees these". The proxy is not a form
 * field the user is filling in; it IS the terminal, and the terminal is what they act on.
 */
export function isEditableElement(c: EditableProbe | null): boolean {
  if (!c) return false
  if (c.inTerminal) return false
  return !!c.contentEditable || /^(input|textarea|select)$/i.test(c.tag)
}

/**
 * THE TYPING RULE: a chord is refused when the CARET is in a text field — whether or not
 * the event happens to be aimed at it.
 *
 * The two arguments are the whole finding. `e.target` answers "where was this event
 * aimed?", `document.activeElement` answers "where is the user typing?", and those agree
 * only for a listener on the direct path to the focused element. A CAPTURE-phase listener
 * is always on that path, so `e.target` sufficed there and the rule looked complete. A
 * BUBBLE-phase listener is not: it hears an event only when the focused field did NOT
 * swallow it, so by construction the events it sees are the ones whose target is something
 * else — window, <body>, a rail tab, or a re-dispatched relay (browser/index.ts hands the
 * dock's guest chords to `document`, whose target is the document itself). Asking only
 * about the target there is asking the one question that cannot come back true.
 *
 * That is the Ctrl+Shift+G / Ctrl+Shift+D split: the workspace's pane verbs capture, so
 * renaming a workspace blocked them; the Board's toggle bubbles, so it did not.
 */
export function typingBlocksShortcuts(target: EditableProbe | null, focused: EditableProbe | null): boolean {
  return isEditableElement(target) || isEditableElement(focused)
}

/** The one DOM read: an element (or anything else) reduced to what the rule needs. */
function probe(t: EventTarget | null): EditableProbe | null {
  if (!(t instanceof HTMLElement)) return null
  return { tag: t.tagName, contentEditable: t.isContentEditable, inTerminal: !!t.closest('.xterm') }
}

export function isEditableTarget(t: EventTarget | null): boolean {
  return isEditableElement(probe(t))
}

/**
 * Deliberately matches ONLY `.modal-overlay`, never `.palette-overlay`. The palette's own
 * search box is an `<input>` and the palette is an overlay — if either counted, every command
 * would render permanently disabled inside the one surface whose entire job is running them.
 */
export function isBlockingModalOpen(): boolean {
  return !!document.querySelector('.modal-overlay')
}

export function getCommandContext(): CommandContext {
  return {
    activeView: activeView(),
    modalOpen: isBlockingModalOpen(),
    editableFocused: isEditableTarget(document.activeElement),
    workspaceId: getWorkspaces().activeId
  }
}

/**
 * The guard every raw global `keydown` listener owes the user, applied BEFORE the handler runs.
 *
 * This cannot live inside runCommand(): the app's global shortcuts are registered in the
 * CAPTURE phase, so they fire before the event ever reaches the focused <input>. That is why
 * the `stopPropagation()` calls sprinkled through the app's text fields never blocked them —
 * those only stop the bubble phase, and there was nothing bubbling yet.
 *
 * It reads the FOCUSED element as well as the event's target — see typingBlocksShortcuts.
 * `getCommandContext()` below has always asked about focus; this asked about the target
 * alone, and the palette's refusal and the raw listeners' refusal have to be the same
 * refusal or one of them is lying.
 */
export function shortcutsBlocked(target: EventTarget | null): boolean {
  return typingBlocksShortcuts(probe(target), probe(document.activeElement)) || isBlockingModalOpen()
}

/** The pane verbs (split/zoom/new terminal) only mean something while a workspace is on screen. */
export function requiresGrid(ctx: CommandContext): CommandAvailability {
  return ctx.activeView === 'grid'
    ? true
    : { enabled: false, reason: 'Open a workspace first — this acts on its panes.' }
}
