# 21 · Agent-state signals — the complete reference

**Purpose.** One pane, one question: *what is this pane's agent doing right now?* The answer
is derived from many overlapping channels — terminal escape sequences, first-party hooks, a
notify socket, process detection — and it is easy to lose track of which channel carries what.
This document is the single map: every signal each agent CLI can emit, what we consume today,
where each one lands in the state machine, and where we currently lose information.

It is the engineering companion to two existing docs — [`hooks/README.md`](../hooks/README.md)
(user-facing: how to install the hooks) and [17 · Agent CLI settings](17-agent-cli-settings.md)
(the config control plane). This one is the internal truth table.

Nothing here changes behavior. It exists so the next change is made with the whole board in view.

**Status (2026-07-23).** The audit's recommendations are IMPLEMENTED: G1/G2/G3 are closed on
every CLI that has a channel for them, and G6 (the modern hook systems of Codex/Gemini/
OpenCode) landed in the same pass. The tool-signal decision was settled by measurement
(`scripts/measure-hook-latency.mjs`), not estimate — see §7. G4 (SSH: layer A only) and G5
(verdict-mute environments) remain open by nature; their safety nets are unchanged.

**Provenance.** Every CLI signal below was verified against the provider's **official
documentation** on **2026-07-20** (sources in §8). Facts are marked *official* (documented and
supported by the provider) or *empirical* (behavior we observe and rely on, but the provider does
not document as a contract — so it can change under us without notice). The distinction matters:
an *empirical* dependency is a maintenance risk to re-check on each CLI upgrade.

Code of record:
- `src/backend/features/agent-state/activity.ts` — the state machine (**the verdict law**)
- `src/backend/features/agent-state/osc-parser.ts` — terminal-escape decoding
- `src/backend/features/agents/notify-hook.ts` — the hooks/config we generate per CLI
- `src/backend/features/agents/global-hooks.ts` — the hand-typed-session (global) variant
- `src/pty-daemon/session.ts` — routes every decoded signal into the tracker
- `bin/mogging.mjs` — the `mogging notify` twin of the generated hook (`NOTIFYPARITY` gate)

---

## 1 · What we are deriving: the five states

The dot in every pane header, the workspace-rail ring, the toasts, the OS badge — all of them
render from ONE per-pane value, `AgentState` (`contracts/domain/agent.ts`):

| state | meaning | dot | rail |
|-------|---------|-----|------|
| `unknown` | this pane has **never spoken a verdict** — we cannot say anything (never a yellow lie) | hollow | nothing |
| `busy` | an agent is **actively working a turn** | solid green | identity ring (background) / selection glow (active) |
| `attention` | the agent is **blocked on the human** | solid red | pulsing orange (latched until viewed) |
| `done` | the agent **explicitly finished a turn** (the only thing that paints green) | green + halo | orange until viewed, then cleared |
| `idle` | settled, **but nothing completed** (an acknowledged done, an idle timer, a shell prompt) | solid yellow | nothing |

Two facts about the surfaces:
- **Sticky green.** `done` stays "finished" until you click/land on the pane; after that the dot
  rests at yellow (`idle`) though the underlying state is still `done` until new work reclaims it.
  (`ui/core/attention/attention-port.ts`, `ui/features/terminal/terminal-pane.ts`.)
- **The rail ring is *activity*, not *presence*.** An idle-but-alive agent shows **no** rail ring —
  the ring only lights for `busy` / `attention` / `done`. (See [11 · Design system] / the rail in
  `ui/features/workspace/controller.ts` `refreshAttention`.)

### The verdict law

> **Every state is raised by a signal that KNOWS. Output activity raises nothing.**

The old engine guessed: bytes flowing = `busy`, silence = `idle`, and the `busy→idle` edge over a
2.5 s floor = "finished". That stamped four ordinary things as completions (typing, a workspace
switch's repaint, a mid-turn pause, any long shell command). It was deleted. `done` is now a state
of its own, raised only by an explicit completion verdict. See `activity.ts` for the full rationale.

### The four deductions (certain, not guesses)

1. **Answering a red means it is working.** A blocked agent + the human feeds a submitted line or a
   printable key ⇒ `busy`. (Permission dialogs take single-key answers and fire no hook —
   `activity.ts input()`, `replies.ts isEngagedInput`.)
2. **A chime with no `done` behind it means blocked.** Every CLI rings on *completion* too, so a
   raw bell/OSC-9 is *held* `BELL_CONFIRM_MS` (2000 ms) for an explicit `done` to contradict it.
3. **An unknown notification type mid-turn is not a block.** Its arrival proves the channel works;
   real blocks arrive as explicit needs-input, so mid-`busy` it is swallowed (`notice()`).
4. **A shell prompt means the foreground program is gone.** `133;D`/injected prompt marks kill a
   standing `busy`/`attention` but never author a first verdict and never spend a green.

### The subagent gate

Alerts are the **main** agent's story. `subagent-start`/`subagent-stop` only move a counter; no
subagent event authors a pane state. While the count is > 0: a `done` from the main is **deferred**
(it fanned out and parked, it did not finish), an `idle-prompt` is dropped, and a quiet terminal
does not settle. `turn-start` resets the counter so a hard-killed subagent can't strand the pane.

---

## 2 · Two signal layers

| layer | source | applies to | strength |
|-------|--------|-----------|----------|
| **A — Terminal escapes** | bytes on the PTY stream (`osc-parser.ts`) | *any* CLI, zero config | the baseline; ambiguous (a chime rings for done *and* block) |
| **B — First-party hooks** | the CLI runs our command / plugin on lifecycle events | the CLIs that support hooks | the sharper layer; explicit verdicts disambiguate layer A |

Every launch from an app pane wires layer B session-scoped; a hand-typed session gets layer B
wired into the CLI's **own global config** on detection (`global-hooks.ts`), else it falls back to
layer A alone. Remote (SSH) panes get layer A only — the daemon env never crosses SSH.

---

## 3 · Layer A — terminal escape signals (`osc-parser.ts`)

The parser is an incremental OSC state machine (survives chunk splits). `→ state` is the tracker
call it drives via `session.ts`.

| sequence | meaning | our reading | → tracker |
|----------|---------|-------------|-----------|
| `BEL` (outside any OSC) | terminal bell — "look at me" | ambiguous chime | `bell()` → held 2 s → `attention` if uncontradicted |
| `OSC 9 ; <text>` | iTerm2/ConEmu desktop notification | ambiguous chime | `bell()` |
| `OSC 9 ; 9 ; <path>` | **cwd report** (ConEmu/Windows-Terminal; cmd.exe via ConPTY) — **we inject this** | shell is at prompt + cwd | `shellPrompt()` → `idle`; + cwd |
| `OSC 9 ; 4 ; <state>;<pct>` | **taskbar progress** (WT/ConPTY/cargo/npm/pip/winget) | pane is *working*, not blocked | **ignored** (was a false red) |
| `OSC 99` | kitty notification | notification | `attention` |
| `OSC 777 ; notify ; …` | rxvt notification (only the `notify` sub-cmd) | notification | `attention` |
| `OSC 133 ; A` | prompt start | command-block mark | (mark only) |
| `OSC 133 ; B` | command-line start | command-block mark | (mark only) |
| `OSC 133 ; C` | command execution start | shell integration | `shellCmdStart()` → `busy` (never authors first state) |
| `OSC 133 ; D[;exit]` | command end (+ exit code) | shell back at prompt | `shellPrompt()` → `idle` |
| `OSC 7 ; file://host/path` | cwd (bash/zsh) | cwd only | cwd (never a state) |
| `OSC 633 ; P ; Mogging*` | **our injected private dialects** (prompt boundary + safe cwd, incl. remote) | prompt / cwd | `shellPrompt()` and/or cwd |

Notes worth keeping in mind:
- **`OSC 9` is overloaded on Windows** — `9;9` (cwd), `9;4` (progress), `9;<text>` (notify) all
  wear code 9. Both non-notify forms are checked *first*; either one, read as attention, lit a red
  for nothing (a build with a progress bar; every prompt).
- **Oversized OSC bodies** (vim/tmux OSC 52 clipboard > 4 KB) are discarded *including their BEL
  terminator*, so a big clipboard write never rings a false attention.
- **Terminal auto-replies** (CPR/DA/DECRPM/focus/color/DCS) ride the renderer→pty channel like
  keystrokes; `replies.ts isTerminalReply` filters them so a scrollback replay never clears a red.

---

## 4 · Layer B — first-party hooks, per CLI

Legend: **✅ wired** (we consume it today) · **◻ available, unused** · **🚫 n/a for this CLI**.

### 4.1 Claude Code — full hook vocabulary

Verified against `code.claude.com/docs/en/hooks`. Claude Code exposes ~30 events; we wire seven.

| event | fires | we wire | → our event / state |
|-------|-------|:------:|---------------------|
| `UserPromptSubmit` | user submits a prompt (before processing) | ✅ | `turn-start` → **busy** |
| `Notification` | multiplexed notice (11 `type`s) | ✅ | whitelist → `needs-input`/`idle-prompt`/silent/`notice` |
| `Stop` | Claude **finishes responding** | ✅ | `done` → **done** |
| `SubagentStart` | a subagent is spawned | ✅ | `subagent-start` (gate +1) |
| `SubagentStop` | a subagent finishes | ✅ | `subagent-stop` (gate −1) |
| `PostToolBatch` | **after a parallel tool batch resolves, before the next model call** | ✅ | `busy` → **busy** (the G1/G3 fix — chosen over per-tool hooks on measured cost, §7) |
| `StopFailure` | **turn ends due to an API error** (*"output and exit code are ignored"* — the command still runs, so our socket side-effect fires; Claude just won't read its output) | ✅ | `turn-failed` → **idle** (the G2 stuck-busy fix; settles like a shell prompt — resets turn leftovers, spares a standing green) |
| `PreToolUse` | before **every** tool call (blocking) | ◻ | rejected on measured cost: ~150ms of hook on the critical path of every tool call (§7) |
| `PostToolUse` | after a tool call succeeds | ◻ | rejected with PreToolUse — same fidelity as PostToolBatch at ~200× the fires |
| `PostToolUseFailure` | after a tool call fails | ◻ | (still working) |
| `PreCompact` / `PostCompact` | around context compaction | ◻ | (compaction ≈ still working) |
| `SessionStart` / `SessionEnd` | session begins / terminates | ◻ | lifecycle |
| `PermissionRequest` / `PermissionDenied` | permission dialog / auto-deny | ◻ | an explicit block channel (richer than Notification) |
| `Elicitation` / `ElicitationResult` | MCP asks for input / answered | ◻ | an explicit block/clear channel |
| `TeammateIdle` | agent-team teammate about to idle | ◻ | — |
| `SubagentStart` extras, `TaskCreated/Completed`, `MessageDisplay`, `CwdChanged`, `FileChanged`, `WorktreeCreate/Remove`, `ConfigChange`, `InstructionsLoaded`, `Setup`, `UserPromptExpansion` | various | ◻ | mostly not state-relevant |

**Claude hook I/O contract** (load-bearing for the cost analysis in §7):
- Hooks run **synchronously — Claude waits.** Default timeout 600 s (30 s for `UserPromptSubmit`).
  `PreToolUse` is a *blocking* event, so its hook is on the critical path of **every tool call**.
- **Token cost of a tool hook is zero.** `PreToolUse` / `PostToolUse` / `PostToolBatch` stdout goes
  to the **debug log only — never into Claude's context.** Our notify hook writes nothing to stdout
  and exits 0, so it adds **no tokens** and makes **no API call**. (Only `SessionStart`,
  `UserPromptSubmit`, `Stop`, `SubagentStop` stdout / `additionalContext` reach the model — and we
  never emit any.)
- Exit 0 = success (JSON parsed); exit 2 = blocking error (we never do this); other = non-blocking.
- A hook *may* emit `terminalSequence` (OSC 0/1/2/9/99/777 or BEL) — an alternate way for Claude to
  ring layer A itself. We do not use it.

**The `Notification` whitelist** (`notify-hook.ts`, `hooks/README.md`) — one event, eleven types,
only four of which block:

| → ring red (`needs-input`) | → parked (`idle-prompt`) | → silent | → guess (`notice`) |
|---|---|---|---|
| `permission_prompt`, `worker_permission_prompt`, `agent_needs_input`, `elicitation_dialog` | `idle_prompt` | `agent_completed`, `auth_success`, `elicitation_complete/response`, `computer_use_enter/exit`, `push_notification` | any unrecognized type |

The discriminator is the payload's `notification_type` (read off stdin) — **not** `type` (the docs
are wrong; reading `type` returned undefined and painted every completion red). Type field only —
never the message text (ADR 0002).

### 4.2 Codex

Today we wire the **OSC 9 + `notify`** pair (`codexBellArgs`): `tui.notifications=true`,
`tui.notification_method=osc9`, `tui.notification_condition=always`, and
`notify=[ "node", "<script>" ]`.

The two documented notification event *types* are **`agent-turn-complete`** and
**`approval-requested`** (`tui.notifications` can filter by them — official). The two channels
carry them differently, and that split is the whole disambiguation:

| channel | fires on | we wire | → state | provenance |
|---------|----------|:------:|---------|-----------|
| OSC 9 chime (`tui.notifications`) | **both** `agent-turn-complete` **and** `approval-requested` | ✅ | `bell()` (ambiguous — held for a `done`) | official |
| `notify` program | **`agent-turn-complete` only** ("*supported events, currently only agent-turn-complete*") | ✅ | `done` — the verdict that disambiguates the chime | official |
| **`hooks.UserPromptSubmit`** (command handler) | user submits a prompt | ✅ | `turn-start` → **busy** (the turn boundary Codex never had — resets the subagent counter, ends the done state between turns) | official |
| **`hooks.PostToolUse`** (command handler) | after a supported tool produces output | ✅ | `busy` (G1/G3 proof-of-work — Codex has no batch-level event, so per-tool is its only tool signal; ~150ms/fire accepted as the only option) | official |
| **`hooks.<other>`** — `PreToolUse`, `PermissionRequest`, `Stop`, `SubagentStart/Stop`, `PreCompact`, `PostCompact`, `SessionStart` (command handlers only — *"prompt and agent hook handlers are parsed but skipped"*) | lifecycle | ◻ | `Stop` deliberately unwired: `notify` already lands the official `done`, a second copy is dead weight | official |

- `tui.notification_method`: `auto | osc9 | bel` (default `auto` → *"prefers OSC 9…falls back to
  BEL"*). `tui.notification_condition`: `unfocused | always` (we force `always` so the dot flips
  regardless of focus).
- **Correction from the first pass:** `approval-requested` reaches us via the **OSC 9 chime**, not
  via `notify` — `notify` officially emits only `agent-turn-complete`. Our notify *script* keeps a
  defensive `approval-requested → needs-input` mapping (`codexTypeToEvent`), but current Codex never
  sends it through that channel, so it is dead-but-harmless. The `notify` payload also carries
  `thread-id`/`turn-id`/`cwd`/`input-messages`/`last-assistant-message` — we read the `type` only.
- Codex has **no `PostToolBatch` and no `StopFailure`** (those are Claude-only); its tool signal is
  `PostToolUse` (see §7).

### 4.3 Gemini CLI

Today we wire **`BeforeAgent` + `AfterAgent` + `enableNotifications`** (`geminiSystemSettings`).

| event | fires | we wire | → state |
|-------|-------|:------:|---------|
| `general.enableNotifications` chime | *"run-event notifications for action-required prompts and session completion"* (one switch) | ✅ | `bell()` (ambiguous) |
| `BeforeAgent` | *"after a user submits a prompt, but before the agent begins planning"* | ✅ | `turn-start` → **busy** |
| `AfterAgent` | *"once per turn after the model generates its final response"* (main loop only; subagents use a different executor) | ✅ | `done` |
| `AfterTool` | after a tool executes | ✅ | `busy` (G1/G3 proof-of-work — Gemini's batch-adjacent alternative, `AfterModel`, fires per response CHUNK, which is worse; per-tool accepted as the only option) |
| `BeforeTool` | before tool execution | ◻ | AfterTool already carries the signal |
| `BeforeModel` / `AfterModel` | before request / after each LLM response chunk | ◻ | fine-grained turn activity |
| `BeforeToolSelection` | before the model picks tools | ◻ | — |
| `Notification` | *"when the CLI emits a system alert"* | ◻ | — |
| `PreCompress` | before history summarization (Gemini's compaction; **not** `PreCompact`) | ◻ | — |
| `SessionStart` / `SessionEnd` | session begins / ends | ◻ | lifecycle |

- **Platform caveat (matters on Windows):** `enableNotifications` is **experimental and macOS-only**
  today — its rich desktop notification only fires on macOS; **elsewhere it falls back to a terminal
  `BEL`**, which our OSC parser reads as the ambiguous chime (`bell()`). So on Windows/Linux the
  Gemini "chime" is literally a BEL, and the `AfterAgent` hook is what supplies the explicit `done`.
- Hooks run synchronously; a `matcher` limits which tools fire them. `showStatusInTitle` +
  `dynamicWindowTitle` also feed the pane header its live thought subject (see `title.ts`).

### 4.4 OpenCode

Today we wire the **tui attention chime + a generated plugin on `session.idle`** (`opencodeTuiConfig`,
`opencodePluginSource`).

| event | fires | we wire | → state |
|-------|-------|:------:|---------|
| tui attention chime | `question`/`permission`/`error`/`done`/`subagent_done` | ✅ | `bell()` (ambiguous) |
| plugin `session.idle` (root) | main session completes | ✅ | `done` |
| plugin `session.idle` (child, via `parentID`) | a subagent completes | ✅ | `subagent-stop` (cancels the `subagent_done` chime; authors nothing) |
| `tool.execute.after` | after tool execution | ✅ | `busy`, THROTTLED to one fire per 15s window (G1/G3 — the plugin is in-process, so the spawn cost is ours to cap; `session.error` resets the window so a recovering turn re-lights instantly) |
| `permission.asked` / `permission.replied` | permission dialog / answer | ✅ | `needs-input` / `busy` — the explicit block channel (G6): a named red the instant the dialog opens, sharper than the 2s-held chime deduction |
| `session.error` | the turn died | ✅ | `turn-failed` → idle (G2 — without it an errored turn wears busy forever) |
| `tool.execute.before` | before tool execution | ◻ | `.after` already carries the signal |
| `session.compacted`, `message.updated`, `message.part.updated`, `command.executed`, `file.edited` | various | ◻ | not state-relevant |

- **Caveat:** the plugins *events* page lists these names but does **not** document how a handler
  receives session info or the `parentID` root/child relationship our `session.idle` split relies on.
  That comes from the OpenCode **SDK** session object (`client.session.list()` → `parentID`), not the
  events doc — so the root/child split is an SDK-level dependency, not a guarantee of the events API.
  Our plugin already fails safe here: if the lookup fails it treats the session as root (a missed
  green is recoverable; a pane stuck busy is not).
- The plugin runs **in-process** in OpenCode and shells out to `node <notify script>` per fire; the
  config spec must be a `file://` URL (a bare path is fetched as an npm package and hangs the launch).

### 4.5 Aider

The honest one: **no chime vocabulary, no hook system** — only a notifications command that fires
*"when LLM responses are ready"* (the model finished, awaiting input).

| channel | fires | we wire | → state |
|---------|-------|:------:|---------|
| `--notifications` / `AIDER_NOTIFICATIONS` | terminal **BEL** when responses are ready (default off) | — (we set the command instead) | — |
| `--notifications-command` / `AIDER_NOTIFICATIONS_COMMAND` | *"when LLM responses are ready"*, **instead of** the bell | ✅ | `done` |
| *(anything else)* | — | 🚫 | Aider has no busy/attention/tool channel; it is `unknown` → `done` only |

We set both env twins: `AIDER_NOTIFICATIONS=true` **and** `AIDER_NOTIFICATIONS_COMMAND=<notify done>`
— because a command specified means it runs *instead of* the bell, and aider's Windows default
notification (with no command) is a blocking MessageBox dialog we must avoid.

---

## 5 · The mapping — every event → tracker → state

`mogging notify --event <e>` (and the generated hooks) all land in `session.ts applyNotify`, which
routes to the `ActivityTracker`:

| event label | tracker method | resulting state | notes |
|-------------|----------------|-----------------|-------|
| `turn-start` | `turnStart()` | **busy** | resets subagent counter, ends done-grace |
| `busy` | `notify('busy')` | **busy** | clears deferred-done |
| `needs-input` | `raiseAttention()` | **attention** | explicit, never retractable |
| `done` | `notify('done')` | **done** (or deferred if subagents pending) | arms the 2.5 s done-chime grace |
| `idle` | `notify('idle')` | **idle** | never greens; held busy if subagents pending |
| `idle-prompt` | `idlePrompt()` | **idle** | dropped while latched or subagents pending |
| `turn-failed` | `turnFailed()` | **idle** (from busy/attention only) | the dead-turn settle (StopFailure / session.error): resets turn leftovers, never authors a first verdict, never spends a green |
| `subagent-start` | `subagentStart()` | busy (gate +1) | never clears a red |
| `subagent-stop` | `subagentStop()` | redeems deferred done, else stays busy (gate −1) | stray stop (count 0) ignored |
| `notice` | `notice()` | context-dependent | swallowed mid-turn / on done; else held like a bell |
| `usage-limit` | — (+ `notify`) | attention | also emits the failover signal (4/04) |
| OSC bell / 9 / 99 / 777 | `bell()` | attention (held 2 s) | ambiguous chime |
| OSC 133;C | `shellCmdStart()` | busy | never authors first state |
| OSC 133;D / injected prompt | `shellPrompt()` | idle | kills busy/attention; keeps done/unknown |

---

## 6 · Where we lose the state (the gaps) — statuses as of 2026-07-23

| # | gap | status |
|---|-----|--------|
| **G1** | **`Stop` treated as terminal, but it isn't.** A continued turn (`/goal`, auto-continue, post-compaction resume) worked on with **no new `turn-start`** — a working agent wore `idle` | **CLOSED**: tool activity re-asserts busy on every CLI with a tool channel (Claude `PostToolBatch`, Codex `hooks.PostToolUse`, Gemini `AfterTool`, OpenCode `tool.execute.after`). Gated: ATTENTION `toolReassertsBusy`/`continuedTurnRegreens` |
| **G2** | **Turn dies on an API error** — pane stuck on `busy` forever | **CLOSED**: `turn-failed` event (Claude `StopFailure`, OpenCode `session.error`) → `ActivityTracker.turnFailed()` settles the pane like a shell prompt. Codex/Gemini expose no turn-failure hook today (their next `turn-start`/prompt still unsticks). Gated: ATTENTION `fail*` asserts, NOTIFYPARITY `argv-turn-failed` |
| **G3** | **No tool-use signal on any CLI** | **CLOSED** with G1 (same signal). Aider remains `done`-only — it has no tool channel at all |
| **G4** | **Remote (SSH) panes: layer A only** — the daemon env never crosses SSH | **OPEN by nature.** The OSC 633 Mogging dialects remain the remote story; hooks cannot call home without the endpoint |
| **G5** | **Verdict-mute agents** (`node` off PATH, profile home without the global file) | **OPEN, mitigated**: the global wiring now carries the full event set the moment it IS applied, and `globalHooksState` reads an old vintage as `partial` so the UI re-offers Apply |
| **G6** | **Newer full hook systems unused** (Codex/Gemini/OpenCode) | **CLOSED**: Codex `hooks.UserPromptSubmit`/`hooks.PostToolUse` (session `-c` + global config.toml blocks), Gemini `AfterTool`, OpenCode `permission.asked`/`permission.replied`/`session.error`/`tool.execute.after`. Manual snippets in `hooks/` carry the same wiring, pinned by NOTIFYHOOK's snippet-parity asserts (bite-proven 2026-07-23) |

**G1 is the one that started this review.** It was not a rail bug — the rail is correct for the
state it is given. It was a *signal* bug: we stopped hearing "still working" the moment a turn
was continued past its `Stop`.

---

## 7 · Best implementation — the decision menu

The fix for G1/G2/G3 is the same shape on every CLI: **re-assert `busy` on tool activity**, and
**map turn-end-failure to `idle`.** The question is *which* tool signal, weighed on three axes —
**tokens, process spawns, and agent latency.**

### The universal cost facts

- **Tokens: zero for tool hooks, on every CLI.** Claude routes `PreToolUse`/`PostToolUse`/
  `PostToolBatch` stdout to the debug log only (verified); Codex/Gemini/OpenCode tool hooks run
  local commands/plugins. None add to the model context or make an API call. (The *only* way a
  hook costs tokens is returning `additionalContext` on `SessionStart`/`UserPromptSubmit`/`Stop` —
  which we never do.)
- **Spawns + latency are the real cost**, and they scale with *fire frequency*:

**MEASURED (2026-07-23, `scripts/measure-hook-latency.mjs`, 40 cold fires against a fixture
endpoint on the quiet dev box): one hook fire = 151ms median / 205ms p95 / 248ms max** — a cold
`node` spawn plus the full daemon handshake, the exact work a synchronous hook adds.

| Claude signal | fires | spawns / turn (≈100 tools) | measured per-turn cost | fidelity for G1 |
|---------------|-------|:---:|---------------|-----------------|
| **`PostToolBatch`** | once per resolved parallel batch, before the next model call | ~1 per model step | **~15.1s across a 100-step turn (~1% of a typical 5–30s model step each)** | re-lights busy the moment a continuing agent touches a tool — **CHOSEN** |
| `PreToolUse` | before **every** tool call (blocking) | ~100 | ~15.1s, but **~151ms on the critical path of every tool call** — a 3–15× slowdown of a fast local tool | a few seconds earlier than PostToolBatch — imperceptible on a rail |
| `PreToolUse` + `PostToolUse` | before and after every tool | ~200 | **~30.2s per 100-tool turn, ~302ms per tool call** | identical rail fidelity to PostToolBatch |

The trade-off is NOT negligible: per-tool hooks put ~300ms of process spawn on every tool call
for zero additional rail fidelity — the batch hook already fires before each next model call,
so the dot re-lights at the same human-visible moment. For reliability, redundancy buys
nothing either: a missed batch fire is re-asserted by the very next batch. **`PostToolBatch`
alone is the implementation**, and NOTIFYHOOK asserts `PreToolUse`/`PostToolUse` stay unwired
so the decision cannot erode silently.

### The implemented signal set per CLI

| CLI | **busy re-assert** (G1/G3) | **turn-end failure** (G2) |
|-----|-------------------------------------|----------------------------|
| **Claude Code** | `PostToolBatch → busy` | `StopFailure → turn-failed` |
| **Codex** | `hooks.PostToolUse → busy` + `hooks.UserPromptSubmit → turn-start` (the turn boundary it never had) — OSC 9 + `notify` kept for the chime/done; `hooks.Stop` deliberately unwired (a duplicate done is dead weight) | 🚫 no turn-failure hook documented — the next `turn-start` unsticks |
| **Gemini** | `AfterTool → busy` | 🚫 none documented — AfterAgent + BeforeAgent bracket the turn |
| **OpenCode** | `tool.execute.after → busy` (throttled 15s in the in-process plugin) + `permission.asked/replied → needs-input/busy` (the explicit block channel) | `session.error → turn-failed` |
| **Aider** | 🚫 no tool channel — stays `done`-only | 🚫 |

All of these are **idempotent under the tracker** (busy→busy coalesces) and **safe double-wired**
alongside the existing session + global hooks (`global-hooks.ts` already relies on this).

### What the change touched (the regression surface)

1. `contracts/daemon/protocol.ts` — `turn-failed` in the NotifyEvent union + stateless fallback.
2. `activity.ts` — `turnFailed()` (shares the settle rule with `shellPrompt()` — one body, two
   named claims); `busy` needed no new tracker method.
3. `session.ts applyNotify` — routes `turn-failed` statefully.
4. `notify-hook.ts` — every builder above; `bin/mogging.mjs` passes labels through untouched.
5. `global-hooks.ts` — Claude HOOK_EVENTS now DERIVED from `claudeNotifyHooks` (the twin lists
   cannot diverge by construction); Gemini `AfterTool`; Codex tagged `[[hooks.*]]` blocks.
6. `hooks/` manual snippets — same wiring, pinned by NOTIFYHOOK's snippet-parity asserts.
7. Gates: NOTIFYPARITY (+`argv-busy`, `argv-turn-failed`), ATTENTION (G1/G2 tracker asserts),
   NOTIFYHOOK (builders + snippet parity + the PostToolBatch-only decision),
   `tests/unit/global-hooks.test.ts` (codex blocks, gemini AfterTool, stale-vintage → partial).

### The decisions, settled

- **Tool signal: `PostToolBatch`**, by measurement (above) — per-tool hooks cost ~300ms per
  tool call for zero additional rail fidelity or reliability.
- **Scope: G6 landed in the same pass** — the modern hook systems are what close G1 for
  Codex/Gemini/OpenCode at all.

---

## 8 · Sources (official docs, verified 2026-07-20)

Every §4 vocabulary was checked verbatim against the provider's own documentation:

| provider | source | what it confirms |
|----------|--------|------------------|
| **Claude Code** | <https://code.claude.com/docs/en/hooks> | the full 30-event hook list (incl. `PreToolUse`, `PostToolUse`, `PostToolBatch`, `StopFailure`, `SubagentStart/Stop`); the I/O contract (synchronous, timeouts, exit codes); that `PreToolUse`/`PostToolUse`/`PostToolBatch` stdout goes to the **debug log only** (zero tokens) |
| **Codex** | <https://developers.openai.com/codex/config-reference> · <https://developers.openai.com/codex/config-advanced> (both → learn.chatgpt.com) | the `hooks.<Event>` system (command handlers only); `notify` fires *"supported events, currently only agent-turn-complete"*; `tui.notifications` filters `agent-turn-complete` **and** `approval-requested`; `notification_method auto\|osc9\|bel`, `notification_condition unfocused\|always` |
| **Gemini CLI** | <https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md> · <https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/settings.md> · <https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/notifications.md> | the hook events (`BeforeAgent`/`AfterAgent`/`Before-`/`AfterTool`/`Before-`/`AfterModel`/`BeforeToolSelection`/`SessionStart`/`SessionEnd`/`Notification`/`PreCompress`); `general.enableNotifications` = *"action-required prompts and session completion"*, **experimental, macOS-only, BEL fallback** |
| **OpenCode** | <https://opencode.ai/docs/plugins> | the event bus (`session.idle`, `tool.execute.before/after`, `permission.asked/replied`, `session.error`, …); the page does **not** document handler signatures or the `parentID` split |
| **Aider** | <https://aider.chat/docs/config/options.html> | `--notifications` (BEL when responses ready) and `--notifications-command` (*"instead of the terminal bell"*); env twins `AIDER_NOTIFICATIONS`/`AIDER_NOTIFICATIONS_COMMAND`; fires *"when LLM responses are ready"* |

## 9 · Empirical dependencies — re-check on every CLI upgrade

These are the places we rely on behavior the provider does **not** guarantee as a documented
contract. None is broken today; each is a thing to re-verify when that CLI updates:

| # | dependency | why it's empirical | our safety net |
|---|-----------|--------------------|----------------|
| E1 | **OpenCode root/child split via `parentID`** | the plugins events page documents neither the handler payload nor `parentID`; it comes from the SDK session object | lookup failure → treat as root (a missed green, never a stuck-busy) |
| E2 | **Codex OSC 9 fires on approval, not just completion** | the two *event types* are documented, but the docs don't state the OSC 9 mechanism emits on both — we observe it does | if a future Codex stops OSC-9-ing approvals, we'd miss a red (self-heals on next verdict), never a false green |
| E3 | **Claude `terminal_bell` rings on `agent_completed`** | our done-chime grace assumes the completion bell exists; it's Claude bell/notification behavior, not a hooks-doc guarantee | `DONE_CHIME_GRACE_MS` swallows it defensively regardless |
| E4 | **Codex `notify` type set stays `agent-turn-complete`-only** | docs say *"currently only"* — a new type could appear | `codexTypeToEvent` maps known types and routes the unknown to `notice` (never a direct red) |
| E5 | **`node` on PATH for every hook** | the generated hooks/plugins shell out to `node` | missing `node` → hook silently no-ops; OSC/BEL baseline still applies (but the dot stays hollow — this is G5) |
| E6 | **Codex `-c` accepts inline-table `hooks.<Event>` values** | the config-advanced doc shows `[[hooks.*]]` file syntax; that `-c` parses the equivalent inline array-of-inline-tables is observed, not documented | live-verified on 0.144.1 (`codex doctor` with the exact overrides: `config.toml parse ok`); a future refusal degrades to the chime+notify baseline — a launch never breaks (the flags are additive config, not commands) |
| E7 | **Claude `PostToolBatch`/`StopFailure` hook commands actually execute** | both are documented events, but the "StopFailure output is ignored — the command still runs" reading is doc-derived; the socket side-effect is the part we rely on | a Claude that stops running them degrades to exactly the pre-fix behavior (G1/G2 symptoms), never a false green — and the next `Stop`/`turn-start` still lands |
| E8 | **OpenCode `permission.asked`/`replied`/`session.error` payload shapes** | the plugins page lists the names, not the handler payloads | the handlers read no payload fields (labels only), so a shape change cannot break them; a renamed event silently degrades to the chime deduction |

The NOTIFYPARITY gate keeps the generated hook and `mogging notify` in lock-step, but it cannot
catch a provider changing its own event names — that is what §8 re-verification is for.
