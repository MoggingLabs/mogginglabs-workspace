# First-party agent hooks — `mogging notify`

These are config snippets that let an agent CLI explicitly raise its pane's attention in
MoggingLabs Workspace — a richer signal than OSC escape sequences alone. When Claude/Codex/Gemini
**finishes** or **needs your input**, it runs `mogging notify`, and the pane's tab starts ringing
(and its badge flips to attention) so you know exactly which of many agents needs you.

> **Launched from the app? Already wired.** Every agent launch from a MoggingLabs pane
> auto-carries the session-scoped equivalent of these snippets — no install, no writes to your
> config files: Claude Code gets a `--settings` overlay (notify hooks + `terminal_bell`), Codex
> gets `-c tui.notifications` overrides (OSC 9), Gemini/OpenCode get generated settings via
> `GEMINI_CLI_SYSTEM_SETTINGS_PATH` / `OPENCODE_TUI_CONFIG` (OSC 9), and aider gets
> `AIDER_NOTIFICATIONS*` env (the generated notify script). The snippets below remain for
> agents you start yourself — a plain command typed into a pane, or a terminal outside the app.
>
> **Typing an agent at a pane's own prompt?** The session-scoped config can't reach it, so the
> app can wire the equivalents below into each CLI's **own global config** for you — one click
> per CLI in Settings › Agent CLIs › *Hand-typed session alerts* (explicit apply, timestamped
> backup, removable the same way): Claude's hooks into `~/.claude/settings.json`, Codex's
> `notify` + `[tui]` keys into `config.toml` (your own `notify` is never replaced — a conflict
> refuses and says why), Gemini's hooks + `enableNotifications` into its `settings.json`, and
> OpenCode's attention pair + the generated verdict plugin into `tui.json`/`opencode.json`.
> The notify script (and the OpenCode plugin around it) no-op outside a MoggingLabs pane, so
> globally wired means wired everywhere it matters and inert everywhere else.

OSC-based agent-state stays the baseline for *any* CLI (Phase-2/01); these hooks are the sharper,
first-party layer for the CLIs that support hooks.

## How it works

- The MoggingLabs daemon spawns each pane with two env vars: `MOGGING_PANE_ID` (which pane this is)
  and `MOGGING_DAEMON_ENDPOINT` (the path to the daemon's endpoint file).
- `mogging notify --event <event>` reads those, connects to the daemon over its **authed** local
  socket (same token handshake as everything else), and raises that pane's attention.
- The payload is an **event label** (+ an optional short message) only — **never** credentials or
  terminal/prompt content (ADR 0002). If the pane wasn't spawned by MoggingLabs, `mogging notify`
  detects the missing env and silently no-ops (it never fails the agent).

### Events

| event | pane state | typical trigger |
|-------|-----------|-----------------|
| `needs-input` | attention | the agent is waiting on you (permission / a question) — red until you type |
| `done` | idle | the agent finished its turn — surfaces as the sticky green "finished" halo until you click the pane |
| `busy` | busy | long-running work started (softer, non-ringing) |
| `idle` | idle | back to idle |
| `subagent-start` | *(gate only — holds busy)* | work fanned out to a subagent |
| `subagent-stop` | *(gate only — emits nothing)* | a subagent landed |
| `turn-start` | busy | a new prompt was submitted |
| `idle-prompt` | idle *(never red)* | "Claude is waiting for your input" — parked, not blocked |
| `usage-limit` | attention *(+ failover offer)* | the agent hit a provider usage limit — the app offers a profile switch |

### Not every `Notification` is a call for help

Claude Code's `Notification` hook is **multiplexed** — one event carrying eleven different `type`s.
Only four of them mean a human is actually blocking the agent:

| ringing (red) | silent |
|---------------|--------|
| `permission_prompt`, `worker_permission_prompt`, `agent_needs_input`, `elicitation_dialog` | `agent_completed`, `auth_success`, `elicitation_complete`, `elicitation_response`, `computer_use_enter`, `computer_use_exit`, `push_notification` |

`agent_completed` fires the instant an agent **finishes** (its message is literally
"`<label> finished`"). Mapping the whole `Notification` event to `needs-input` therefore painted
*completed* panes red — racing the `Stop` hook's green, and winning often enough to be maddening
(both are ~130ms process spawns; whichever lands last wins, and attention is a **latch**, so the red
stuck until you typed).

`idle_prompt` ("Claude is waiting for your input") is fired by an idle **timer**, so it turned a
finished pane's green halo red a minute later purely for sitting there. It is not a block — it is an
*idle* verdict, and green already carries "come look".

So `mogging notify` reads the payload's `type` off stdin and whitelists the four that block. An
**unrecognized type is a guess**, and guesses never latch red directly: it is sent as `notice`,
which the daemon holds for a beat and reads in context (swallowed mid-turn and on a finished
pane; rung one confirmation window later when the pane is genuinely idle). The old behavior —
"an unknown type still rings" — painted freshly-finished panes red the day Claude shipped new
notification types (2026-07-15). The `type` field **only** ever leaves the process — never the
message or title.

> **Parity is gated.** `mogging notify` and the app's generated notify hook are twins by
> contract, and the `NOTIFYPARITY` sweep gate runs both shipped artifacts over one event corpus
> and fails on any divergence — the mapping above cannot silently fork again.

### The bell is a guess, not a verdict

The same trap sits one layer down. A terminal bell (`BEL`) or an `OSC 9`/`99`/`777` notification on
the PTY reads like "I need you" — but **every CLI also rings it when it finishes.** Codex fires
OSC 9 on turn-complete *and* on approval requests; Claude's `terminal_bell` channel fires for
`agent_completed`. Taken as "blocked", a bell painted finished panes red.

So a bell is **held for a beat** rather than latching. If an explicit verdict lands inside that
window — the `done` or `needs-input` riding a hook, ~130-260ms behind — the verdict wins and the
guess is discarded. Only an *unclaimed* bell, from a CLI with no hook wired at all, actually rings;
there it is the only signal there is, so it must.

This is what makes Codex legible, and it's why its snippet wires **both** channels: its OSC 9 fires
on both events, but its `notify` program fires only on turn-complete. A bell with a `done` behind it
is a completion (green); a bell alone is an approval (red).

Output does **not** count as a contradiction — an agent painting its approval dialog *after* ringing
is exactly the case that still has to go red.

### Every CLI needs two channels

That is the shape of the whole problem, and it is the same for all of them. Each CLI has an
**ambiguous chime** (it rings for completion *and* for a block), so each also needs an **explicit
`done`** for the chime to be read against. Verified against the real CLIs:

| CLI | ambiguous chime (the guess) | explicit `done` (the verdict) |
|-----|-----------------------------|-------------------------------|
| **Claude Code** | `terminal_bell` channel (fires for `agent_completed`) | `Stop` hook |
| **Codex** | OSC 9 — fires on turn-complete **and** on approval | its `notify` program (turn-complete **only**) |
| **Gemini** | `enableNotifications` — one switch for *"action-required prompts and session completion"* | the `AfterAgent` hook |
| **OpenCode** | its attention chime — `question`/`permission`/`error`/`done`/`subagent_done` | a generated **plugin** (`session.idle`) |
| **aider** | *(none)* | `AIDER_NOTIFICATIONS_COMMAND` |

aider is the one that was always honest: it has no chime, only a done.

**Subagents stay invisible everywhere**, which is the house rule. Gemini's `AfterAgent` fires only
for the main loop (its subagents run through a different executor that fires no agent hooks at all).
OpenCode's `session.idle` *does* fire for subagent sessions, so its plugin splits root from child on
`parentID` — a child going idle sends `subagent-stop`, which authors no state and exists only to
cancel the `subagent_done` chime that would otherwise ring the pane red for a subagent finishing.

### The subagent gate

**Every alert you see is the main agent's story.** The pane dot, the workspace-rail badge, the
pulses — all of them are authored by the main agent's own events. Subagents are invisible: the
`subagent-*` events only raise and lower a counter, and **never emit a pane state of their own**.

They exist because an agent that fans work out **ends its own turn** while the subagents run: it
fires `Stop`, goes quiet, and (after 60s at the prompt) fires an idle `Notification`. Read literally,
those say "finished" and then "blocked on you" — so a pane flashed green and then rang red with the
work still very much in flight.

While the count is above zero:

- a quiet terminal does **not** settle to idle (the work is elsewhere, not absent);
- the main's `done` is **dropped** — that's the main *parking*, not finishing. The green belongs to
  its **next** `done`, once the subagent results re-invoke it and it ends for real;
- an `idle-prompt` is **dropped** — parked-on-subagents is not blocked-on-you.

A real permission prompt still rings red instantly (that one *is* blocked on you), and a sibling
subagent starting never clears it.

`turn-start` (UserPromptSubmit) resets the count: if a subagent is killed hard and its stop event
never arrives, the stale count can't swallow every future `done` and strand the pane on busy past
your next prompt.

`mogging notify` reads Claude Code's hook payload on stdin to tell an idle `Notification` from a
permission one — it takes the `type` field **only**, never the message text.

## Prerequisite

`mogging` must be on your `PATH` (the same requirement as `mogging .`). If it isn't, replace
`mogging` in the snippets with the absolute path, e.g. `node /path/to/MoggingLabs/bin/mogging.mjs`.

## Install (pick your CLI)

Each snippet **merges** into your existing config — don't overwrite the whole file; add the `hooks`
(or `notify`) key. All are user-level and reversible (delete the key to uninstall).

- **Claude Code** → merge [`claude-code/settings.json`](./claude-code/settings.json) into
  `~/.claude/settings.json` (or a project's `.claude/settings.json`).
- **Codex** → add the `notify` line **and** the `[tui]` block from
  [`codex/config.toml`](./codex/config.toml) to `~/.codex/config.toml` (must be user-level; Codex
  ignores a project-level `notify`). Both are needed — see below.
- **Gemini CLI** → merge [`gemini/settings.json`](./gemini/settings.json) into
  `~/.gemini/settings.json`. Hooks are on by default.
- **OpenCode** → drop [`opencode/plugin/mogging-notify.js`](./opencode/plugin/mogging-notify.js)
  into `~/.config/opencode/plugin/` (auto-loaded), and enable the chime in
  `~/.config/opencode/tui.json`: `{ "attention": { "enabled": true, "notifications": true } }`.
- **aider** → add to `~/.aider.conf.yml`:
  `notifications: true` and `notifications-command: mogging notify --event done`.
  (App launches already set the `AIDER_NOTIFICATIONS*` env twins; this covers aider you type
  yourself. aider has no chime — the done is its whole story — and the app deliberately offers
  no one-click global wiring for it: your `.aider.conf.yml` is YAML the app won't rewrite.)

## Verify

In a MoggingLabs pane **that is running an agent the app knows about** (launch one from the app,
or type a CLI and let detection adopt it — the pane's dot goes solid), run
`mogging notify --event needs-input` by hand — the pane's tab should ring immediately. Then
install a snippet and let the agent trigger it on its next turn.

In a **plain shell** pane the same command deliberately raises nothing — no dot, no ring, no
toast, no webhook. Alerts are the agent story, everywhere or nowhere (ALERTAGREE): a pane whose
own surfaces cannot corroborate an alert may not have one raised elsewhere on its behalf. The
same rule is why a bare `echo -e '\a'` in a plain shell no longer produces a "needs your input"
toast. Remote (SSH) panes are the honest edge: their config lives on the far host and the daemon
env never crosses SSH, so remote agents speak through the chime only — the dot stays hollow, and
chime-alone reads as attention.
