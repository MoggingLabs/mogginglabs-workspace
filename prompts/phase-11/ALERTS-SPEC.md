# Alerts & status dots — validated spec

Direction taken from Pedro, 2026-07-14, in a full behavior-by-behavior review of the
pulse/attention system. This supersedes the current implementation wherever they disagree.
Two documented decisions are deliberately **reversed** — they are marked ⚠ below.

The governing sentence, in his words:

> **"I don't want to ever guess when an agent is finished. I want you to be sure always."**

---

## 1. The verdict law (the root fix)

### The disease

State is currently inferred from **output activity**:

- `data()` (bytes arrived) → `busy`
- the quiet timer (1.5s of silence) → `idle`
- the `busy → idle` edge, if the episode lasted ≥ `MIN_WORK_MS` (2500ms) → **`finished`**

`done` is flattened to `'idle'` at the contract boundary (`notifyEventToState`), so by the
time the attention port derives "finished", **it cannot tell an explicit `Stop` hook from
"the terminal went quiet for 1.5 seconds."** It infers completion from the *edge* plus a
duration floor. The 2.5s floor is the only thing standing between that inference and total
nonsense, and its entire safety margin is ~1 second of repaint.

Four confirmed phantom-green sources, all of which Pedro has seen live:

| # | Trigger | Why it greens |
|---|---------|---------------|
| 1 | **You typing** | Keystrokes echo → bytes → `busy`. Type >1s, pause >1.5s → `busy→idle`, episode ≥2.5s → **green**. Nothing finished; you typed slowly. |
| 2 | **The workspace switch itself** | Switch → refit → pty resize → ConPTY repaints the whole viewport → output burst. Burst ≥1s + the 1.5s quiet window clears the floor → **green**. |
| 3 | **A mid-turn pause** | Agent streams, waits >1.5s on a slow tool call → **green**, while it is still working. |
| 4 | **Any long command** | `npm install` in an agent pane → output, then quiet → **green**. A command finished, not the agent. |

### The law

**State is only ever raised by a signal that knows. Output bytes drive nothing.**

| State | Raised by |
|-------|-----------|
| **busy** (green) | `turn-start` (UserPromptSubmit / BeforeAgent) · `subagent-start` · explicit busy notify · OSC 133;C · **answering a latched red** (see the deduction below) |
| **attention** (red) | an explicit needs-input verdict (Claude `Notification` whitelist, Codex `approval-requested`) · **an uncontradicted chime** (see the deduction below) |
| **finished** (green + halo) | an explicit `done` verdict **only** — `Stop` / `agent-turn-complete` / `AfterAgent` / OpenCode's plugin / aider's notify command |
| **idle** (yellow) | explicit idle · `idle-prompt` · a `done` whose sticky flag has been acknowledged |
| **exited** (gray) | the PTY died (`markDead`) |

**Delete:** `data()` → `busy`. The quiet timer → `idle`. `MIN_WORK_MS` (the 2.5s floor) and
every comment defending it.

**Keep:** the subagent gate (a main that fans out still fires `Stop` while its subagents run).
`input()` clearing the attention latch. `bell()` + `BELL_CONFIRM_MS` — see below.

### The two permitted deductions

A deduction is not a guess. Both of these combine **two facts we are certain of** into a
conclusion that is therefore also certain. Neither resembles "bytes went quiet, so probably
finished."

**1. Answering a red means it is working.**
The agent said *by name* that it was blocked on you. You answered it. Therefore it is no longer
blocked, and it is working. `input()` on a latched pane → `busy`, on your keystroke.

> Without this, the approval gap: no hook fires when you type `y` at a permission prompt, so the
> pane would go red → you approve → **yellow (idle) for the three minutes it then works** → green.
> A working agent that looks asleep.

**2. An uncontradicted chime means blocked.**
The chime is ambiguous — every CLI rings it on *completion* as well as when blocked — so it is
held for `BELL_CONFIRM_MS` and asks whether an explicit `done` lands behind it.

- chime **+ a `done`** within the window → completion → **green**
- chime **+ no `done`** → blocked → **red**

Both inputs are certain (the CLI *did* ring; no `done` *did* arrive). This is load-bearing:

| CLI | explicit needs-input verdict? |
|-----|-------------------------------|
| Claude Code | ✅ `Notification` hook (whitelisted types) |
| Codex | ✅ `approval-requested` |
| **Gemini** | ❌ **chime only** — `hooks/gemini/settings.json` explicitly forbids wiring its `Notification` hook (it fires for warnings/errors, which are not "blocked on you") |
| **OpenCode** | ❌ **chime only** — `question`/`permission` arrive as chime, nothing else |
| aider | ❌ no chime at all — already has no red today |

Killing the bell would leave **three of five CLIs permanently unable to say "I am blocked on you."**
It stays.

### Consequences to expect

- **Quick tasks now go green.** A `done` is a `done`; duration was only ever a filter for a guess
  we no longer make. A 0.3s task earns the same green as a 30s one — dot, pulse, rail count, toast.
- **Hookless agents claim nothing, ever** — see the hollow dot below.
- **A pane you unblock shows green(busy) immediately**, from your keystroke.

---

## 2. The dot

**Coverage.** Agent panes only. Plain shells and `custom:<cmd>` get **no dot at all** — its absence
is itself information. This already includes agents *you* typed at the pane's own prompt: typed-launch
detection writes the same `agent-session` port a launched agent does (`detected: true`), which is the
port the dot's gate subscribes to. Only the code comment (`"a launcher session"`) is stale — the
behavior is already correct.

**Colors** — unchanged, validated as-is:

| | |
|---|---|
| yellow | idle |
| green | working |
| green + halo | **finished** (sticky) |
| red | blocked on you |
| gray | process exited |
| **hollow** | **NEW** — an agent with no verdict channel wired |

**The hollow dot.** An agent we cannot get verdicts from (a remote pane without the hook config; a
CLI we don't support, found by typed-launch) shows a hollow dot and **never claims a state**. Hover:
*"completion tracking not available for this agent."* Silence must never read as "it never finished" —
you always know the difference between *didn't* and *can't tell you*.

**The red dot no longer pulses.** Steady red. (The pane already carries a red outline under §3; the
dot pulsing too was the same alarm, twice.)

---

## 3. The pane — a new resting state

Today the pulse fades to **zero** and hands the story to the header dot. The pane itself is left
unmarked. That changes: the pane now carries a **persistent outline**.

| Pane state | Outline |
|------------|---------|
| blocked | **red**, until the agent unblocks |
| finished | **green**, until the pane is clicked |
| focused **+** blocked | **both** — red edge *and* the orange inner selection glow |
| focused-on-entry **+** finished | pulse green, then **fully acknowledged** ⚠ |

⚠ **Landing on a finished pane counts as clicking it.** If the auto-focused pane on workspace entry
is the finished one, it pulses green and is then treated as clicked: dot → yellow, outline gone,
dropped from the rail count. *This reverses the explicit rule in `grid-layout.ts`, whose comment
currently says the flag "must survive a workspace switch that happens to auto-focus the finished pane."*

### The pulse

**Shape.** One swell (~1.2s) that **settles into the resting outline** — not three beats fading to
zero. The pulse is now an *arrival*, and the outline is where it lands: one continuous gesture.

```
opacity
 1.0 │    ╱╲
     │   ╱  ╲___________   ← rests at the outline's level
 0.4 │  ╱
   0 │╱
     └──────────────────
      0        1.2s
```

**Lifetimes.**

- **RED** — fires once on entering the workspace, and re-arms on **every re-entry** until resolved.
  Leave without answering, come back → it pulses at you again.
- **GREEN** — fires **once, ever**. Consumed only when the pane is **truly visible**: the workspace
  is active, the view is the grid, *and* the pane is not hidden behind an expanded pane. Sitting on
  Board/Home/Settings does **not** consume it (today it is silently marked "seen" and never plays —
  a real bug).
- **Many at once** — all alerting panes pulse simultaneously on entry. Confirmed intentional.

---

## 4. The rail

- **Split the badge by urgency.** A red count (blocked) and a green count (finished) — *not* one
  number. "Two agents need you, one finished" is a different message from "three agents need you."
- **The badge no longer pulses.** Steady glow.
- **The tab outline keeps pulsing forever.** ✅ Unchanged — the rail is the surface you are *not*
  looking at, and it is the one place perpetual motion earns its keep. Clears on visiting.
- **Clicking a blocked pane calms the rail.** The tab stops pulsing and the badge stops shouting;
  the pane keeps its red outline and red dot. *Seen ≠ resolved, but seen is worth something.* This is
  the only dismissal red has — nothing else silences it, and there is no snooze.
- **NEW: a quiet "working" hint on the tab.** Deliberately calm and non-orange, so "my agents are
  running" reads from the rail without competing with alerts. Today `busy` paints **nothing anywhere** —
  a workspace with three agents hard at work is indistinguishable from one that is asleep.

---

## 5. Outside the app

All kept, plus one addition:

- Toast with a "Go" button ✅
- Windows taskbar flash ✅
- macOS dock badge ✅
- **NEW: `finished` reaches outside too.** Today a completion is invisible unless the app is already
  in front of you. Completions now earn a toast / badge like blocks do.

---

## 6. New: per-pane completion history

Each pane's ⋯ menu shows **its own** completion history — so a green you dismissed (or that was
auto-acknowledged by landing on it, §3) is not gone forever. No global feed; the chrome stays clean.

---

## Open implementation questions

1. **How does a pane know it is "verdict-wired"** (solid dot) vs not (hollow)? The app writes
   user-level hook config for known providers, so app-launched and typed local agents are wired —
   but a **remote** pane's hook config lives on the remote machine. Options: introspect the config;
   or let the pane prove itself (hollow until its first explicit verdict arrives, solid thereafter).
   The second needs no config introspection and degrades honestly.
2. **Red outline vs. the focused pane's orange selection glow.** They were measured as mud before —
   which is exactly why the pulse is stacked at `z-index: 7`, above the selection's `6`. Under §3
   they now coexist *permanently*, not for 3 seconds. Needs real visual tuning, not a guess.
3. **"Truly visible"** needs a signal that does not exist yet: workspace active **∧** view is grid
   **∧** not covered by an expanded pane. The green-pulse debt hangs on it.
4. **`scripts/check-reduced-motion.mjs`** guards the reduced-motion twins. The new resting outline is
   static by construction, so reduced motion is now easy — the outline simply appears without the
   swell. Verify the guard still passes.
