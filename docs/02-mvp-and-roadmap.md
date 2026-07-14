# 02 · MVP & Roadmap

**Decided scope:** "Core + memory graph." Build the terminal/CLI-organizer core first
(it is the risky, load-bearing part), then the memory graph as the first differentiator
layer. They are *sequenced*, not truly parallel — the memory graph is lower-risk and
mostly independent, so it slots in as Phase 2.5 once the core renders reliably.

> **Status, 2026-07-12.** The core shipped and then some: Phases 0–8.5 and 11 are done
> (orchestration, swarm, usage, integrations, the explorer). **The memory graph never
> was** — the one differentiator the scope named, still unbuilt, while eight phases of
> chrome and plumbing went out around it. **Phase 12 is that debt, repaid and widened**
> (a *code* graph the agents query, not only a note graph the human reads); Phases 13–19
> are the next arc. See "The next arc" below.

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

### Phase 2.5 — Memory graph (the chosen differentiator) → **superseded by Phase 12**
- Local `.memory/` markdown knowledge graph with `[[wikilinks]]`, backlinks, a
  force-directed graph view.
- Exposed to every hosted agent via **MCP tools** (`create_memory`, `search_memories`,
  `find_backlinks`, `suggest_connections`, …) — our answer to BridgeMemory.
- Local-first, git-committable; no cloud.
- **Never built.** The instinct was right and the scope was half of one: a *human*
  note graph, when the expensive gap is a *code* graph the agents query. Phase 12
  absorbs this whole bullet list and adds the half that pays for itself.

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

### Phase 9 — Loops: the harness that keeps working after you stop 🔨 (`prompts/phase-9/`)
**Authored, not yet built** — seven steps + `RESEARCH.md`, sequenced to run after
Phase 8. Everything the app does today is a SESSION: someone starts it, someone
ends it. A **loop** is a standing harness — a trigger fires (schedule, queued card,
Sentry spike), an iteration launches the user's own CLI in a fresh worktree pane, an
**objective verify command** judges the work, the Phase-3/4 review gates land it, and
a staged playbook rewrite makes the next pass start sharper. Codified as ADR 0009:
fresh context per iteration · one work item per pass · **nothing lands without the
verify gate green AND a sign-off** (autoland is a typed per-loop opt-in stacked on
top of both, never a default) · budgets as the primary safety mechanism.
*Neutrality (binding, extends ADR 0002): the loop is OURS, the intelligence is
THEIRS — we ship no agent, broker no auth, take no cut.*
**Phase 12+ adds two organs it was missing** — see Phase 9′ below.

### Phase 10 — Agents on real logged-in sessions ✅ *resolved, not built* (`prompts/phase-10/`)
The "Comet question", forked and decided (2026-07-06): **Branch C** (a dedicated
agent-web profile — real logins the user creates on purpose, per-origin action
grants, sensitive-origin blocklist, local trail) shipped **inside Phase 8**; **Branch
B** (inheriting the system browser's cookie stores + OS keychain) **stays PARKED** —
it reverses ADR 0002 and starts, if ever, with its own ADR. `FINDINGS.md` remains the
durable analysis and the map for that day. The boundary itself now lives in ADR 0008(e).

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

### Phase 11.5 — Scroll: the conversation you are actually having ✅
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

### Phase 11.6 — Tooltips: the last surface the OS still draws 🔨
**Authored, not yet built** (this entry + `docs/11` §Tooltips; no pack yet.) Twelve phases
of token work — AA-measured inks, per-workspace identity ramps, eight themes — and the app
still hands its most-read microcopy to **Windows** to draw. Every hover hint in the product
is a native `title` attribute: the OS paints it, in the OS's white box, in the OS's font, at
the OS's pace, and **no CSS in this repo can reach it**. It is Phase 11.5's defect class
exactly — *a surface we designed, rendered by someone else* — and it takes the same shape of
fix: one delegated controller, app-wide, and the native thing is gone.

- **The mechanism, not the three symptoms.** ~180 native tooltips: ≈130 through
  `el({ title })` → the single funnel at `components/dom.ts:42`, plus ~50 direct
  `.title =` assignments (over half in `terminal-pane.ts`). The reported white boxes are
  `terminal-pane.ts:1550` (the git chip — its six lines are built by
  `core/git/git-display.ts:100`), `:1116` (agent context) and `:1013` (the idle dot), but
  fixing three would be missing the point. The mechanism is app-wide, so the fix is too.
- **`title` STAYS the authoring API** — the finding that shaped the design. The obvious
  migration (rename every `title` → `data-tooltip`) is *wrong here*, because `title` is
  also read back as **data**: `explorer/index.ts:773`/`:813` find file rows by
  `element.title === path`, and five gates assert on it (`git-smoke`, `fileact-smoke`,
  `treegit-smoke`, `authrunner-smoke`, and `homeux-smoke`'s `[title="Home" i]` selector).
  So instead: the controller strips `title` on pointer-enter (the only thing that stops the
  OS drawing), renders ours, and **restores the attribute on leave**. At rest the DOM is
  unchanged — every gate and every query keeps passing, and **not one of the ~180 call
  sites is touched.**
- **Titles change mid-hover.** The update dot ticks its download percentage
  (`updates/index.ts:86`); the state dot flips idle→busy. A `MutationObserver` on the
  hovered element's `title` re-captures and re-suppresses — without it the OS box pops back
  up mid-hover and our text goes stale.
- **Themed by construction**: `--bg-elevated` / `--border` / `--text-hi` / `--shadow-2` —
  the `.menu` surface recipe — so it inherits every theme `themes.ts` stamps, present and
  future, with no per-theme rule. `white-space: pre-line`, because the git chip's title is
  `lines.join('\n')`.
- **It needs no grep gate** — the one guardrail this pack doesn't have to buy. A `title`
  added tomorrow is themed the moment it is hovered; there is no drift to police. (The
  `data-tooltip` design would have owed CI a gate forbidding `title=` forever.)
- **A11y gets better, not just prettier**: `role="tooltip"` + `aria-describedby` (already
  the house pattern — `field-group.ts:51`), opens on `focus-visible` so keyboard users
  finally get text `title` never gave them, `Esc` dismisses, `:root.motion-calm` honoured.
  Screen readers are unaffected: they read `title` at rest, and at rest it is there.
- **Out of scope, permanently**: the Windows taskbar's own tooltip (the "MLW" box in the
  report) is drawn by the shell, outside the renderer. It stays white; nothing in our
  process can touch it. Say so rather than chase it.

Cost: one module (`ui/core/tooltip/`), ~40 lines of CSS, one boot line, **zero new
dependencies** — a positioner here is a rect clamp, and floating-ui would be 10× the code
(ADR 0004). Verified by hand first (the multi-line git chip · the flip case at the titlebar,
where DOM cannot paint over `titleBarOverlay` · the update dot *while its percentage ticks*),
then one gate asserting the tooltip's text, that the trigger carries **no** `title` while
hovered, and that `title` is **restored** after `pointerout` — that last assertion is what
keeps the five existing `title`-reading gates safe. Surface: `docs/11` §Tooltips.

---

## The next arc — Phases 12–19 (planned)

Sourced from the 2026-07 ecosystem sweep: **`docs/research/2026-07-vibe-coding-ecosystem.md`**
(what to absorb, what to refuse, the licence map). Ordered by value to *this* app,
not by the popularity of the projects behind them.

Three rules bind every phase below, and they are why these land as **capabilities,
not dependencies**:
- **ADR 0008** — protocols, not plugins. Foreign code never runs in our processes;
  ideas enter as data over MCP/hooks/the control API, or they don't enter.
- **ADR 0002** — we broker nothing. Every one of these works on the user's own CLIs,
  keys, and machine.
- **Risk #5** — clean-room only. The loudest projects in this space (claude-squad,
  cmux, opcode, coder/mux) are **AGPL/GPL**: read them, never link them. asciinema's
  `.cast` **format** is fair game; its GPL code is not.

*What the sweep found already shipped — worktrees, the board, notifications, the
usage gauge, MCP registration — is listed in the research doc's "do not re-buy"
table. It is not repeated here.*

### Phase 12 — The Workspace Brain (the differentiator, finally) 🔨
*Absorbs Phase 2.5. The flagship.* One **context daemon per workspace**, mounted into
every pane over MCP, so sixteen agents share one map instead of re-scanning one tree
sixteen times.
- **The code graph** (Graphify's shape, MIT, clean-room): tree-sitter AST across the
  workspace — **deterministic, no LLM, no embeddings, no vector store**, which is the
  only kind of index that fits a free, local-first, no-account app. Queried as
  `query_graph` / `get_node` / `get_neighbors` / `shortest_path`.
- **Symbol-level writes** (Serena's shape): panes edit *by symbol*, not by blind file
  rewrite — the same LSP truth the graph reads. Directly reduces the cross-pane
  collisions Phase 13 then polices.
- **The one thing a local graph cannot know** (Context7's shape): version-correct
  third-party library docs, registered once at workspace level, killing hallucinated
  APIs in every pane at once.
- **Ranked injection at spawn** (Aider's repomap algorithm — tree-sitter + PageRank):
  a cold pane starts *already oriented*, instead of burning its first 20k tokens
  rediscovering the repo.
- **Phase 2.5's `.memory/` graph, kept whole**: `[[wikilinks]]`, backlinks, the
  force-directed view, git-committable — now one lens on the Brain rather than a
  separate feature.
- **The economic claim this unlocks** (and no single-pane tool can make it): *many
  agents become cheaper per question than one agent working badly.* Our core feature
  stops being an ergonomic story and becomes an economic one.

### Phase 13 — Contention: sixteen agents, one repo, zero collisions 🔨
The failure mode **our own product creates**, and the highest value-per-hour work on
this list. Phase 3 gave every agent its own worktree; it did not give them their own
*ports*, dev servers, or a way home.
- **Ports & dev servers per worktree** (uzi's idea, MIT, ~200 lines): auto-assigned,
  auto-started, shown in the pane chrome. Six agents each running `npm run dev` on
  :3000 is the single most-felt bug in parallel agent work and **no desktop rival
  advertises solving it**.
- **Race the agents** (Crystal's idea): N attempts at *one* task in N worktrees, then
  diff-compare and keep the winner — a first-class flow, not a manual ritual.
- **The way home** (Sculptor's Pairing Mode): sync an isolated agent's tree back into
  the user's real checkout. Isolation without a return path is a dead end; this is the
  missing half of every sandbox story, including Phase 15's.

### Phase 14 — ACP: from scraped bytes to a control plane 🔨
The structural bet. Today attention, busy/idle, and approvals are inferred from **TTY
text**; Phase 2's OSC parser is a good guess and still a guess.
- **Speak ACP** (Zed's Agent Client Protocol, Apache-2.0): structured turns, typed
  tool-call approvals, real diffs. `mogging send` stops being a keystroke injector and
  becomes an API; every ACP-speaking agent becomes a drop-in pane.
- **Degrade honestly** (ccmanager's per-CLI heuristics): CLIs that don't speak ACP keep
  the OSC/scrape path — **one seam, two fidelities**, never two products.
- **Typed approval events** (HumanLayer's shape): "this pane is blocked on a decision"
  becomes a routable event — which is what makes Phase 17 worth having.
- Respects risk #4 (*prefer OSC over brittle hooks*) by making ACP the **richer** path,
  never the required one.

### Phase 9′ — Loops, enriched (fold into `prompts/phase-9/` before building) 🔨
Phase 9's harness is sound; the sweep gives it the two organs it lacks:
- **Where the work comes from** (spec-kit's shape): `/specify` → `/plan` → `/tasks`, one
  spec fanning out to N panes — the workflow our grid has never had.
- **Where the work lives** (Backlog.md's shape): tasks as **committed markdown in the
  repo**, human- and agent-readable. Git is the database: zero infra, survives restarts,
  syncs across machines, and it is the natural memory for a loop that must start fresh
  each iteration (ADR 0009's law 1).
- **The board pulls** (vibe-kanban's queueing, the one thing our board doesn't do): the
  backlog auto-spawns the next agent when a pane frees.

### Phase 15 — Sandboxed panes, opt-in and account-free 🔨
Answers the objection every rival leads with — *"I won't let an agent loose on my
machine"* — **without** surrendering local-first.
- **Agents opt into isolation themselves** (container-use, Apache-2.0, MCP-native): a
  container + branch per agent, exposed as a *tool*. We write no runtime.
- **The local backend** (microsandbox, Apache-2.0): microVM isolation with **no cloud
  account** — the only sandbox story that doesn't contradict our pitch. E2B stays the
  escape hatch for shops that want hosted.
- **Secret hygiene under autonomy** (vibekit's redaction): what an unattended agent may
  never see. Pairs with Phase 13's way home; an alternate **spawn target** for an
  existing pane, never a rewrite of it.

### Phase 16 — Replay: every agent run, watchable and searchable 🔨
- **`.cast` per pane** (asciinema's *format only* — ⛔ GPL code, clean-room): shareable
  replays straight out of the PTY stream we already own.
- **A typed event stream beside it** (OpenHands' action/observation log): pixels show
  *what happened*, the log shows *what it meant* — so a replay is searchable, and pane
  history becomes resumable.
- **Tapes** (VHS's shape): our control API is already a tape runtime — scripted demos
  and repeatable UI smokes become **one artifact**, paying the gate sweep back directly.

### Phase 17 — Remote attach 🔨
The daemon already outlives the app (ADR 0006), so the hard part is done: serve a
running pane to a browser (vibetunnel's shape, MIT) and let Phase 14's typed approvals
be answered from a phone. *Check your agents from the couch.* Ships only behind a real
security review — nothing listens on TCP today (ADR 0008(b)) and that is a promise.

### Phase 18 — The review pane 🔨
Sixteen agents produce more diff than a human can read: the fix for our own success.
A dedicated pane critiques what the others just wrote (pr-agent's shape, MIT), verifies
its claims **structurally** rather than by re-reading files (ast-grep, MIT — "find every
caller" as one command), and hands the human a ranked diff at the Phase-3 review gate.
Mostly composition of Phases 12 and 13; cheap once they land.

### Phase 19 — Portable workspaces 🔨
A layout says *where the panes go* (zellij's layout-file shape, MIT); **AGENTS.md**
(openai/agents.md, MIT) says *how each agent behaves* once it's there — vendor-neutral,
which is our whole neutrality stance in a file. Together: clone the repo, open the
workspace, six agents spawn correctly configured. The onboarding and team story.

## Cross-cutting from day one
Sentry crash reporting · a hard perf budget for N panes · CI that builds + signs for
win-x64 / mac-arm64 / mac-x64.

## Top risks (see 03-research-synthesis §8)
1. **Rendering perf at high pane counts** — the make-or-break; BridgeSpace's exact
   failure mode. Electron de-risks *divergence*, not raw perf. Perf budget + throttling.
   *Insurance (2026-07 sweep):* the cheap wins are xterm.js's own WebGL + serialize
   addons (already on WebGL); the escape hatch, if 16 streaming panes ever cap out the
   DOM renderer, is an embeddable GPU VT core — **libghostty** (MIT, Zig). Kept on the
   shelf deliberately: a swap that large is only justified by a measured ceiling, and
   the budgets say we are nowhere near one (142.8 avg fps at 16 panes + explorer).
2. **Windows/ConPTY quirks + AV/SmartScreen** — where cross-platform projects bleed.
3. **BYO-auth boundary** — never store/broker credentials; keep it crisp in code + copy.
4. **Agent-CLI churn** — prefer OSC (works for any CLI) over brittle hook integrations.
5. **Licensing hygiene** — zero code from AGPL/GPL rivals; clean-room only.
