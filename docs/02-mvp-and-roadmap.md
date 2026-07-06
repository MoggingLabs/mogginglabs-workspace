# 02 · MVP & Roadmap

**Decided scope:** "Core + memory graph." Build the terminal/CLI-organizer core first
(it is the risky, load-bearing part), then the memory graph as the first differentiator
layer. They are *sequenced*, not truly parallel — the memory graph is lower-risk and
mostly independent, so it slots in as Phase 2.5 once the core renders reliably.

## Phases

### Phase 0 — Parity spike (1–2 wks) · *current*
Electron + xterm.js(WebGL) + node-pty. One live PTY pane rendering an actual **Claude
Code** session **identically on Windows (ConPTY) and macOS (forkpty)** — same
rendering, input, resize. **Gate:** if rendering diverges, revisit the engine choice
*now*. (Implemented as the current single-pane app.)

### Phase 1 — MVP core (4–8 wks)
- Multi-pane grid + workspace tabs (templates 1/2/4/6/…; drag-resize).
- **Persistent PTY-host process + reconnect-after-UI-crash.**
- SQLite persistence + layout/cwd restore.
- Shell/PATH fidelity; agent launcher for the CLI roster (Claude Code, Codex, Gemini,
  Aider, OpenCode) — **BYO auth, never brokered.**
- `mogging .` launcher; themes.
- Code-signing + notarization + signed auto-update wired in from the start.

### Phase 2 — Agent awareness (3–5 wks)
- OSC parser (9/99/777/133/7) → tab **rings/badges** + busy/idle per pane.
- **Warp-style command blocks** (collapsible, exit-code color, timestamps, search).
- Per-pane git branch/dirty (read-only).
- `mogging notify` socket + first-party Claude/Codex hooks.
- **Milestone demo:** "16 agents, see who needs you at a glance, nothing freezes."

### Phase 2.5 — Memory graph (the chosen differentiator)
- Local `.memory/` markdown knowledge graph with `[[wikilinks]]`, backlinks, a
  force-directed graph view.
- Exposed to every hosted agent via **MCP tools** (`create_memory`, `search_memories`,
  `find_backlinks`, `suggest_connections`, …) — our answer to BridgeMemory.
- Local-first, git-committable; no cloud.

### Phase 3 — Orchestration ✅ (shipped 2026-07)
- [x] Git **worktree-per-agent** isolation + **pre-ship diff review** (secret-redacting,
  injection-resistant, guarded `merge --no-ff`).
- [x] **Kanban** board that launches an agent into a pane with task context (the task
  IS the first prompt) and follows the pane's live attention.
- [x] **Control API** (`list` / `send` / `send-key` / `capture` + `open` / `layout` /
  `focus` / `expand` / `close-pane`) — tmux/cmux parity over the authed daemon socket
  and the validated deep-link relay.
- [x] End-to-end milestone asserted (`MOGGING_ORCHESTRATION`): card → isolated agent →
  notify → redacted review → merge, with the Phase-2 perf budget UNCHANGED and green
  (measured 130 fps avg / 62.5 ms worst gap / 21 MB heap across 12 live panes).
  See `docs/08-orchestration.md`.

### Phase 4 — Differentiators (swarm core shipped 2026-07)
- [x] Multi-agent **swarm**: roles + shared mailbox (`mogging mail`/`role`),
  exclusive file ownership (`mogging claim/release/owners`), reviewer gate
  (`mogging approve` fronts the merge verb; typed human override).
- [x] Multi-profile switching + **usage-limit failover** (pointer profiles — still
  never brokering auth; secret-shaped values refused at save).
- [x] **SSH/remote panes** (daemon-spawned `ssh -tt`; honest degradation).
- [x] Linux target (AppImage/deb config + CI build-and-boot job).
- [x] Built-in browser (Phase 6 — a toggleable dock, agent-drivable via MCP).
- [ ] Voice. *(own pack, later)*
End-to-end milestone asserted (`MOGGING_SWARMMILESTONE`): ledger denial, mailbox
handshake, territory commits, gated + overridden merges — 134.7 fps avg / 41.7 ms
worst / 21 MB with the swarm up. See `docs/09-swarm.md`.

### Phase 5 — UI/UX excellence ✅ (`prompts/phase-5/`, REPORT.md has the receipts)
Full visual/UX sweep, shipped: audit-driven design-token system (AA-measured, one
token layer, grep-gated) with VIVID per-workspace identity ramps and
identity-colored rail selection; a lucide-convention icon family (intent-revealing
expand trio/kanban/sliders, purpose chip glyphs); window-chrome fixes (true-center
command box, event-driven F11 with zero dead gap, `--window-corner` harmony);
full-app top-level views (rail is grid-only; Settings modal → page with sections);
empirical 14px/1.3 terminal default + live 12–16px control through the house
remeasure→refit path. All 23 audit findings closed or deferred-with-reason;
budgets unchanged (perception gained a size-change gate); full sweep green.

### Phase 6 — Product-ready ✅ (`prompts/phase-6/`)
Full Linux/macOS/Windows gate-sweep parity (the same 31-gate `qa-smokes.sh` on
four environments), the browser dock (toggleable right sidebar, agent-drivable
via a first-party MCP server), per-slot profile persistence, first-run checklist
+ one-click update UX, signing readiness + winget/homebrew manifests. Closed by
the `MOGGING_PRODUCT` milestone (installer-fresh → guided setup → swarm + browser
in one asserted flow, budgets held with everything on) and shipped as **v0.4.0**
on all three platforms. Per-OS numbers in `prompts/phase-6/README.md`.

## Cross-cutting from day one
Sentry crash reporting · a hard perf budget for N panes · CI that builds + signs for
win-x64 / mac-arm64 / mac-x64.

## Top risks (see 03-research-synthesis §8)
1. **Rendering perf at high pane counts** — the make-or-break; BridgeSpace's exact
   failure mode. Electron de-risks *divergence*, not raw perf. Perf budget + throttling.
2. **Windows/ConPTY quirks + AV/SmartScreen** — where cross-platform projects bleed.
3. **BYO-auth boundary** — never store/broker credentials; keep it crisp in code + copy.
4. **Agent-CLI churn** — prefer OSC (works for any CLI) over brittle hook integrations.
5. **Licensing hygiene** — zero code from AGPL/GPL rivals; clean-room only.
