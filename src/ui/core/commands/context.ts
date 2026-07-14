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
 * xterm reads the keyboard through a hidden `<textarea class="xterm-helper-textarea">` inside
 * every pane — `term.focus()` focuses that proxy, and it is what a keystroke in a terminal
 * targets. Keyed off `.xterm` (the root class xterm's own stylesheet is built on, so it cannot
 * drift) rather than the textarea's class, which is internal.
 */
function isTerminalKeyboardProxy(t: HTMLElement): boolean {
  return !!t.closest('.xterm')
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
export function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  if (isTerminalKeyboardProxy(t)) return false
  return t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName)
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
 */
export function shortcutsBlocked(target: EventTarget | null): boolean {
  return isEditableTarget(target) || isBlockingModalOpen()
}

/** The pane verbs (split/zoom/new terminal) only mean something while a workspace is on screen. */
export function requiresGrid(ctx: CommandContext): CommandAvailability {
  return ctx.activeView === 'grid'
    ? true
    : { enabled: false, reason: 'Open a workspace first — this acts on its panes.' }
}
