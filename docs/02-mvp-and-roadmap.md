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
Full Linux/macOS/Windows gate-sweep parity (the same 35-gate `qa-smokes.sh` on
four environments), the browser dock (toggleable right sidebar, agent-drivable
via a first-party MCP server), per-slot profile persistence, first-run checklist
+ one-click update UX, signing readiness + winget/homebrew manifests. Closed by
the `MOGGING_PRODUCT` milestone (installer-fresh → guided setup → swarm + browser
in one asserted flow, budgets held with everything on) and shipped as **v0.4.0**
on all three platforms. Per-OS numbers in `prompts/phase-6/README.md`.

### Phase 7 — Usage & metering ✅ (`prompts/phase-7/`)
CLI-owned session adapters behind one seam (ADR 0007), the titlebar usage gauge +
popover, cost/spend/history, plans × profiles with thresholds + failover, the
`mogging usage` CLI, and the pointer-grammar key vault. The sweep grew 30→35
gates. Receipts + per-OS numbers in `prompts/phase-7/README.md`; surface in
`docs/12-usage.md`.

### Phase 8 — Integrations, five directions ✅ (`prompts/phase-8/`)
The workspace reaches out and is reached, five directions on one philosophy —
*nothing runs, proxies, or holds a credential it doesn't have to* (ADR 0008;
daemon still v3, grant-blind):
1. **Tools → agents** — register any MCP server across the Claude Code / Codex /
   Gemini config dialects (surgical, backed-up, drift-detected) from a curated
   Catalog, the registry, or a pasted preset; per-workspace **tool plans** scope
   which servers each CLI even sees.
2. **Agents → the fleet** — the shipped MCP server becomes `mogging`: control-plane
   reads free to a pane-identity session, the six **write** tools behind a
   per-workspace grant (default off — invisible and refused); `approve` is never a
   tool.
3. **Agents → the web** — a consented **agent-web** browser profile: reads free,
   acts gated per **origin** + human-confirmed, sensitive origins blocklisted,
   every act in a local **trail**.
4. **House → your automations** — an outbound **event bridge**: pane/board events
   POST to your n8n/Make/Zapier/Slack webhooks (versioned payload, vault-held URLs,
   a doorbell not a bus).
5. **The world → the board** — service-link **adapters** (GitHub first, riding your
   own `gh`): a linked PR/issue chips a card live and a review transition lands a
   notify on the owning pane.

The **custody rule** runs throughout: what we store rests as OS-vault ciphertext or
is refused; what the CLIs store after their own logins is theirs. Closed by the
`MOGGING_INTEGMILESTONE` milestone — all five compose in one fixture world, zero
network, machine budget unmoved. The sweep grew 35→**52 gates** (thirteen new).
Surface: `docs/14-integrations.md`; per-OS numbers in `prompts/phase-8/README.md`.

### Phase 8.5 — The UI/UX revamp ✅ (`prompts/phase-8.5/`)
The chrome catches up to the product. Phases 6–8 grew usage, integrations, a browser
and a swarm faster than the surfaces around them; this pack **audits every
user-facing surface** (`AUDIT.md` — graded on density/hierarchy, keep/fix/remove
verdicts, a `file:line` on every finding) and rebuilds them on one **layout
vocabulary** added to the token system — `Card` · `SectionHeader` · `FieldGroup` ·
`TwoColumn`, on the ramp extended to `--sp-7/8`:
- The wizard collapses from three cramped modal screens to **one full page** beside
  the rail; a folder is pickable by **click** through a real browser (breadcrumb +
  repo badges), no `cd` bar.
- The Settings shell + both dense tabs (**Integrations**, **Usage**) open
  **overview-first** with per-section disclosure that persists, and no attention chip
  can hide behind a collapsed header.
- Home + first-run, the board + palette, one **feedback language** (the destructive
  confirm focuses the safe action and can never be silenced), the titlebar / rail /
  pane chrome, the browser **possession banner**, and the Usage-glance CodexBar recut.

21st.dev informs (clean-room pattern research only — vanilla TS + house tokens, no
new deps; ADR 0004). **13 removals executed** (dead affordances deleted, not hidden),
**16 bugs routed and fixed**. Closed by the `MOGGING_UXMILESTONE` milestone — the
whole revamp composed in one fixture world, zero network, behind a hard **coverage
gate** (`check-audit.mjs`: no surface below grade A, no unrouted finding) and the
spacing drift grep **frozen at `--max 0`**. **Both perf budgets unmoved** — an
unchanged `docs/05` is the freeze criterion. The sweep grew 52→**66 gates** (fourteen
new). Design system: `docs/11`; per-OS numbers in `prompts/phase-8.5/README.md`.

### Phase 11 — Files: the sidebar that watches your agents work ✅ (`prompts/phase-11/`)
Sixteen agents can be writing into a workspace at once, and the app showed their
**output** (terminals, blocks, attention) but never their **footprint**. This pack adds
the **file explorer**: a right-side dock with the workspace's folder open in a
virtualized, git-decorated tree that updates live as agents write, toggled from the
**far right** of the app bar (`panel-right`, mirroring the rail's `panel-left` at the far
left) or `Ctrl+Shift+E`.

- **The custody stance is the whole design** — [ADR 0010](adr/0010-explorer-window-not-manager.md):
  the explorer is a **window, not a manager**. v1 is read-only (browse · open · reveal ·
  copy · send-to-pane); create/rename/delete/move and an in-app editor are **deferred with
  rationale, not refused**. Opening delegates to the OS and the user's own tools (ADR 0002's
  neutrality, extended to files). **We type; the user executes** — nothing ever presses
  Enter in a pane.
- **The tree**: one virtualized flat list wearing tree semantics (the VS Code shape,
  clean-room), tree ARIA because rows virtualize, APG keyboard verbatim. **10k rows scroll
  with 32 DOM rows and zero long frames.**
- **The liveness law — watch what's visible, nothing else**: per-expanded-dir
  non-recursive `fs.watch`, LRU-capped at 64 handles with a jittered poll fallback,
  coalesced into batches. **A collapsed dir, a hidden window, and a closed explorer each
  cost exactly zero** — measured, not asserted.
- **The decorations add ZERO pollers**: `git/probe.ts` already ran `status --porcelain=v2`
  every 2.5s and threw the file lines away; we parse what we already pay for. M/A/U/D/C on
  files, colour-only propagation to folders (VS Code's `propagate`), ignore-dimming via
  `check-ignore` (never our own `.gitignore` parser), and the **Changes lens** — the
  changed-files view every orchestrator converged on, except it is the same tree, filtered.

Zero new runtime dependencies (no tree, watcher, or icon library). Closed by the
`MOGGING_FILESMILESTONE` milestone: a **real shell pane** writes into the workspace and the
explorer shows it — decorated, live, actionable — with the budgets measured **on the
composed surface** (16 panes + the explorer open + a write torrent: 142.8 avg fps, worst
gap 25.1ms, heap 20MB). The sweep grew 76→**83 gates** (seven new). The book: `docs/16`;
receipts + platform finds: `prompts/phase-11/REPORT.md`.

### Phase 12 — Scroll: the conversation you are actually having ✅
Sixteen agents can be talking at once, and the app had spent eleven phases making sure you
could *see* them — then dropped you at the **top of every conversation** the moment you
walked into a workspace. Reported against codex, but it was never about codex: the **pane**
owns the viewport, not the CLI, so the same defect was one stray scroll away for Claude,
Gemini and a plain shell. This pack fixes the reading position and then rebuilds the
scrollbar the whole app draws.

- **The scroll ANCHOR — the pane follows its newest output, and only a human may leave it**
  (`terminal/pane-anchor.ts`). Not a patch to whichever sequence in the reattach replay does
  the scrolling: an **invariant**. A replay burst, a reveal refit, a reflow, a zoom — anything
  that moves the viewport off the bottom is corrected on the next frame; a wheel, a drag, a
  scroll key or the slide bar is obeyed and *remembered* (output no longer yanks you back).
  Typing and the jump pill re-arm it; **auto-replies never do** — xterm answers CPR/DA queries
  on the same `onData` channel typing uses, and agents poll them constantly.
- **Intent is a POSITION, not an event** — the finding that shaped the design. xterm's viewport
  is a natively scrollable div: the wheel's default action moves it and xterm syncs its buffer
  from the `scrollTop`, often emitting **no `onScroll` at all**. An anchor that listened for
  scroll events would never learn you had scrolled away, and the next line of agent output
  would drag you back down. So a gesture opens a window, and the anchor reads where the
  viewport comes to **rest**. It also **yields while a human is driving**: a pin already queued
  for the frame would land between the wheel and xterm's sync and undo it.
- **OVERLAY scrollbars, app-wide** (`core/scroll/overlay-scroll.ts`) — the macOS/VS Code model,
  in the panes *and* in every settings panel, file tree, board column and menu: invisible at
  rest, lit while you scroll (fading 900ms after you stop), and lit when the pointer is in the
  **bar's own lane** at the edge. Hovering the container is deliberately **not** a reveal — a bar
  that appears whenever the pointer is anywhere inside the box is the noise this removes, and it
  is the one thing a CSS `:hover` cannot express. Two delegated listeners for the entire app; no
  per-container wiring, and no layout read except while the pointer is over a scrollable. The
  pane's rail is now **full height**, so the ends mean what they say — flush on the floor at the
  newest line, flush against the ceiling at the oldest.
- **The anchor deliberately did not travel.** Stick-to-bottom is *terminal* semantics; Settings
  and the file tree would be worse for it. Panes likewise opt out of the native bar: they own a
  real, draggable, click-pageable one.

Closed by two gates the sweep now carries (83→**85**). `MOGGING_PANESCROLL` drives the shipped
listeners with real events and **fails without the anchor at `viewportY 0` of `baseY 950`** — the
reported symptom, exactly — then proves the guarantee is the pane's and not the CLI's by streaming
each agent's characteristic output (Claude's OSC 133 turn marks, **codex's repaint traffic** —
cursor save/restore, DECSTBM scroll region, the CPR polling that breaks the naive fix — Gemini's
SGR rewrites, a plain shell) into its own pane, stranding each one and requiring all of them back
at the end of their conversation, across a full 8-pane grid. `MOGGING_APPSCROLL` holds the overlay
contract in **both** scrollbar systems (Chromium honours `scrollbar-color` when set and then
ignores the `::-webkit-*` pseudos — a rule written in only one is one Electron bump from a
permanently visible bar), and asserts a pane never grows a second bar. Zero new dependencies;
both perf budgets unmoved.

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
