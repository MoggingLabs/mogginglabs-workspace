/**
 * High-level per-pane state we surface for "which agent needs me" UX.
 *
 * THE VERDICT LAW. Every one of these is raised by a signal that KNOWS — an agent hook, an
 * explicit `mogging notify`, real shell integration (OSC 133). Output activity raises NOTHING.
 * It used to: bytes flowing meant `busy`, 1.5s of silence meant `idle`, and the busy->idle edge
 * (over a 2.5s floor) was read as a COMPLETION. So typing a prompt slowly, or switching
 * workspaces (the refit resizes the pty and ConPTY answers by repainting the whole viewport),
 * or an agent merely pausing on a slow tool call, each stamped a pane "finished working" when
 * nothing had finished. Explicit direction: never guess that an agent is done — be sure.
 *
 *   unknown    this pane has never spoken a verdict, so we have NOTHING to say about it. Not a
 *              state the agent is in — a state WE are in. It renders as a hollow dot and is
 *              counted in no alert. A pane leaves `unknown` on its first verdict and never
 *              returns: the dot going solid IS the proof that this agent's hooks reach us,
 *              which is the only proof that exists (a config file we can read is not one — a
 *              remote pane's lives on the remote host, and a config present is not a hook
 *              firing). Everything else in this union is a claim; this is the absence of one.
 *   idle       an explicit idle verdict, or a done that has been acknowledged. Nothing running.
 *   busy       working. `turn-start` (the user submitted a prompt), a subagent running, an
 *              explicit busy notify, OSC 133;C — or the user answering a latched `attention`,
 *              which is a deduction from two certainties, not a guess: the agent said BY NAME
 *              that it was blocked on this human, and the human answered it.
 *   attention  blocked ON YOU. An explicit needs-input verdict, or a chime with no `done`
 *              behind it (see BELL_CONFIRM_MS — that absence is the verdict for the CLIs whose
 *              chime is the only signal they have).
 *   done       the agent said it FINISHED — `Stop` / `agent-turn-complete` / `AfterAgent` /
 *              OpenCode's plugin / aider's notify command. The ONLY thing that may ever paint
 *              green: the UI turns this into the sticky "finished" story (halo until the pane
 *              is clicked). Nothing infers it, and no duration floor gates it — a done is a
 *              done whether the task took 30 seconds or 300 milliseconds.
 */
export type AgentState = 'unknown' | 'idle' | 'busy' | 'attention' | 'done'
