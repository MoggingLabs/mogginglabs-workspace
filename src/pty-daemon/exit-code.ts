// Pure seam, deliberately its own module — the same reason attach-dims.ts is one: session.ts
// imports node-pty at module top, so anything it exports drags the native binding into whoever
// imports it, and a rule that cannot be unit-tested off-platform cannot be PROVEN off-platform.
// The rule lives here, native-free; both pty twins import it downward.

/**
 * The exit code a pane's epitaph should name.
 *
 * node-pty reports `{ exitCode, signal }`, and on POSIX a WIFSIGNALED death yields **exitCode 0**
 * with the number in `signal`. Reading only `exitCode` therefore made a SIGKILL or SIGSEGV
 * byte-identical to the user typing `exit` — wrong exactly on the crashes the dead-pane epitaph
 * was built to diagnose (an OOM kill, a segfault), and a violation of the seam's stated contract:
 * "a crash, a clean exit and a kill are distinguishable from the pane itself".
 *
 * 128+signal is the shell's own convention — the number the user already reads in `$?` — so a
 * SIGKILL reads 137 and still satisfies the epitaph's `code \d+` shape.
 *
 * Windows has no WIFSIGNALED: ConPTY names a real exit code for every death and `signal` is
 * never set, so this is the identity there. That is precisely why the rule is unit-tested rather
 * than gate-tested — the behaviour cannot be observed on a win32 box at all.
 */
export function exitCodeFor(ev: { exitCode: number; signal?: number }): number {
  return ev.signal ? 128 + ev.signal : ev.exitCode
}
