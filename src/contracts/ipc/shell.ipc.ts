/**
 * Shell chrome IPC payloads (window-level state, never window control).
 */

/** main -> renderer: pushed on enter/leave fullscreen and (un)maximize — plus once
 *  after load so a reloaded renderer starts with the correct chrome classes. */
export interface WindowStateEvent {
  fullscreen: boolean
  maximized: boolean
}
