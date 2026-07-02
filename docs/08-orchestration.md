# Orchestration — the Phase-3 loop

*(Numbered 08 because 07 is the perception budget.)*

Phase 3's promise, as one sentence: **a board card becomes an isolated agent, the agent
asks for you, you review the diff, you merge — and nothing freezes.** This document
describes the loop, the control surface, the safety model, and the scripted demo. The
whole loop is ASSERTED by `MOGGING_ORCHESTRATION` (see Enforcement).

## The loop

1. **Card** — the Board (`Ctrl+Shift+G`) holds local task cards (To do / Doing /
   Review / Done). Card text is user content: it lives in the local app db and nowhere
   else — never telemetry, notify payloads, or logs (ADR 0005).
2. **Start** — a card's menu launches an installed agent: a 1-pane workspace at the
   project folder; when that folder is a git repo, the pane gets its **own worktree on
   its own `mogging/<slug>` branch** (random slug — task text never becomes a path).
   The task (title + notes) is written to the CLI as its **first prompt**. The card
   binds to the pane and moves to Doing.
3. **Work** — the agent works in its worktree; N agents on one repo cannot trample
   each other. Everything is scriptable meanwhile: `mogging list / send / send-key /
   capture` (daemon socket, token-authed) and `mogging open / layout / focus / expand /
   close-pane` (validated deep-link relay).
4. **Needs you** — `mogging notify --event needs-input` (agent hooks) flips the pane
   to attention: the rail badges, the taskbar badges, and the **card shows "needs
   you"** — click it to jump to the pane. Event-driven end to end; zero polling.
5. **Review** — the pane/card menu opens Review: the full diff versus the branch's
   recorded fork base (committed + uncommitted), **secrets redacted in the backend**
   before transport, rendered as text nodes only (hostile diff lines can never become
   markup).
6. **Merge or stop** — one guarded verb: `merge --no-ff`, refused unless the repo is
   clean, behind a typed "merge" confirmation. Conflicts are left paused for a human
   terminal — never auto-resolved. The human moves the card to Done.

## Safety model

| Boundary | Mechanism |
|---|---|
| Agent writes | confined to its worktree; the repo's HEAD/index untouched by setup (smoke-asserted byte-identical) |
| Landing code | review-before-merge; merge is the ONLY mutating verb, clean-repo gated + typed confirm; conflicts → human terminal |
| Secrets | deny-pattern scrub (PEM, AWS, GCP, GitHub, sk-, Slack, JWT, key=value) runs before diff text leaves the backend; smoke plants a fake `ghp_…` and asserts it never reaches the DOM |
| Markup injection | diff renders via `textContent` only — a `<script>` line in a diff stays inert text (smoke-asserted: zero elements created) |
| Task text / card content | local sqlite only — grep + review gates keep it out of telemetry/notify/logs (ADR 0005) |
| Control plane | daemon socket (0600 endpoint, token handshake) + main-validated closed verb unions; renderer never parses raw CLI input |

## The scripted demo (fresh machine, only `mogging …` + the app)

```sh
# 1. open the app on your repo with 4 panes
mogging open ~/my-project --panes 4

# 2. see the fleet; drive a pane
mogging list
mogging send 101 "claude"                  # or start from a Board card (Ctrl+Shift+G)
mogging capture 101 --lines 40

# 3. in the Board (Ctrl+Shift+G): New card -> "⋯ -> Start Claude Code on this…"
#    -> the card binds, the agent gets the task as its first prompt in its own worktree

# 4. when the agent needs you (hooks fire `mogging notify --event needs-input`):
#    the card + rail light up -> click "needs you"

# 5. pane ⋯ -> Review changes… -> read the redacted diff -> type "merge" -> done
```

## Enforcement

- **`MOGGING_ORCHESTRATION`** asserts the entire loop on an isolated temp repo (shell
  provider for determinism — never a vendor CLI's output shape), then re-runs the
  Phase-2 frame sampler with the board visited, 12 live panes (3 worktree-isolated),
  a 3 s ANSI torrent and 4 workspace switches, against the UNCHANGED budget
  (worst gap ≤ 150 ms, avg fps ≥ 30, heap ≤ 300 MB).
- Reference numbers (2026-07-02, Win11): **130.3 fps avg · 62.5 ms worst gap · 21 MB
  heap · 12 live panes**; loop flags all true, 1 planted secret redacted.
- `bash scripts/qa-smokes.sh` runs every gate (Phase 0 → 3) isolated in one sweep.
