# Phase 9 research — where each organ of the loop comes from

Research run 2026-07-03..05 (web, sourced; verbatim quotes marked). This file
is the receipts behind the pack's design decisions. Confidence notes inline —
vendor marketing is labeled as such.

## 1. BridgeAgent (BridgeMind) — the competitor to answer

- Product: "BridgeAgent: The Recursive AI Software Engineer" / "Software that
  builds itself"; the loop is marketed literally as **"design → ship → fix →
  rewrite ↻"** (bridgeagent.app). Stages, verbatim from
  bridgemind.ai/products/bridgeagent: "Maps the codebase, drafts the approach,
  and splits the mission into tasks it can verify." / "Writes the code, runs
  the tests, and opens the PR" / "Watches Sentry and PostHog after merge.
  Error spikes become root-cause investigations, then fix PRs." / "Patches
  its own playbook from what the pass exposed."
- **Reality check:** the runtime is an openly acknowledged **rebranded fork
  of Nous Research's open-source hermes-agent (MIT)** — per its own PyPI
  description (pypi.org/pypi/bridgeagent/json). The "rewrite step" is
  hermes' skills/memory machinery: Markdown skills (SKILL.md, agentskills.io
  format) created/patched by a `skill_manage` tool, optionally **staged for
  human approval** (`write_approval: true` → pending/approve/reject). No
  distinct "playbook" artifact exists; it's marketing vocabulary.
- **Loops board** (their desktop changelog, v0.1.9, 2026-07-02): "tone-colored
  progress rings with state glyphs, a stalled indicator, and every non-running
  loop can be restarted" — first-class loop UI; we match this in 9/07.
- **Red flags we deliberately answer:** marketing sells "ships without you in
  the loop"; no rollback/canary/human-gate documented; no independent reviews
  or case studies of BridgeAgent exist; source repo is 404. Beta, unpriced.
  → Our loop laws 3 (gated landing) and the staged learn step (9/06) are the
  direct counter-positioning: same power, receipts and gates.

## 2. The Karpathy Loop — the discipline

- Definition (named by analyst Janakiram MSV; Fortune, Jeremy Kahn,
  2026-03-17): an agent + **a single modifiable file** + **a single
  objectively-testable metric** + **a fixed time limit** per experiment.
- Results: 700 experiments in 2 days on a small LM → 20 optimizations → 11%
  speedup on a larger model; Shopify's Tobi Lütke: overnight, 37 experiments,
  19% gain. Karpathy: "All LLM frontier labs will do this. It's the final
  boss battle"; "*any* metric you care about that is reasonably efficient to
  evaluate...can be autoresearched by an agent swarm."
- When loops work vs fail (insightarea.com, 2026-05-08): "If you can measure
  success clearly, agents can improve quickly"; soft-judgment tasks resist.
  New human skills: task decomposition, instruction precision, **verification
  design**. "Bad instructions can waste enormous amounts of compute. Weak
  review can merge bad work." "Leverage without judgment is fragile."
  → 9/02's verify runner (exit code is the judge, agent's self-report never
  consulted) and the spec's human-owned verify commands are this, verbatim.

## 3. Ralph (Geoffrey Huntley) — the mechanics that survive contact

- The loop: `while :; do cat PROMPT.md | agent ; done` (ghuntley.com/ralph/,
  2025-07-14; canonized by Anthropic's official ralph-wiggum plugin, which
  implements it via a Stop hook and warns: "Always rely on `--max-iterations`
  as your primary safety mechanism").
- Why it works: **fresh context every iteration** (quality degrades past
  ~150k tokens); state lives in files + git (PROMPT.md, @fix_plan.md,
  AGENT.md, specs/); **one item per loop**; tests as "backpressure".
- Documented failure modes: placeholder implementations chasing compile
  rewards; overcooking/undercooking; "morning wake-ups to non-compiling
  code"; "There is no way this is possible without senior expertise guiding
  Ralph." Receipts: the CURSED language (3 months, 1,198 commits, ~$14k,
  Simon Willison 2025-09-09); Codex CLI later shipped /goal as "their own
  version of the Ralph loop" (Willison, 2026-04-30).
  → Loop laws 1–2, the playbook/FIX_PLAN files (9/06), paused-failing with
  receipts instead of surprise mornings (9/02).

## 4. Anthropic — official loop primitives + harness guidance

- Primitives (code.claude.com/docs): `/loop` (cron skill), `/goal`
  (Stop-hook judge loop), Routines (cloud cron, "no approval prompts during
  a run", guarded by branch prefixes + network allowlists + daily caps),
  headless `-p` with `--max-turns` / `--max-budget-usd`, checkpointing;
  Stop hooks are overridden after 8 no-progress blocks (runaway protection).
- Harness guidance (anthropic.com/engineering, 2025-11-26 + 2026-03-24): an
  initializer writes a feature list + progress file; the coding agent does
  **one feature per session**, reads progress + git log, commits
  descriptively, marks work done "only after careful testing"; self-praise
  is a known failure ("agents tend to respond by confidently praising the
  work") → external evaluators.
  → The engine-enforced budgets (law 4), one-item iterations, receipts
  ledger, and the objective verify gate all mirror this.

## 5. Sentry Seer / Datadog / Meta — the error→fix loop at scale

- **Seer/Autofix pipeline** (docs.sentry.io): root cause → solution plan →
  code generation → PR, with **configurable stopping points** — verbatim:
  "Stop after Root Cause", "Stop after Plan", "Stop after PR Drafted" — an
  org-wide code-gen kill switch, and (GA blog) "nothing gets merged without
  your approval". **Auto-trigger conditions**, verbatim: "(1) The issue has
  10 or more events (2) The issue occurred within the last 14 days (3) The
  issue has a sufficient fixability score." Vendor-reported: 94.5% root-cause
  identification, 38k+ issues in beta. Seer can hand off to Claude/Cursor/
  Copilot cloud agents which run "type checks, lint, and tests" and open PRs.
  → 9/04's qualification filter and 9/05's stop-points are Seer's shape on
  our primitives; the handoff-to-YOUR-agent model is exactly our neutrality.
- **Datadog Bits Code** (GA 2026-06-09): error/CI/flaky-test triggered agent
  that opens a PR and "monitors for any CI failures and iterates on any
  failures until the build passes"; "The resulting pull request still goes
  through normal human review."
- **Meta Engineering Agent** (arXiv 2507.18755): CI-triggered test-failure
  repair at scale — 42.3% offline solve; **25.5% of generated fixes landed**
  after review. The honest number: even at Meta, most agent fixes don't land
  → human review is load-bearing, not ceremonial.
- Counterweight (CodeRabbit via stackoverflow.blog, 2026-01-28, vendor-
  affiliated): "AI created 1.7 times as many bugs as humans" in their corpus
  → verify gates + review are not optional.

## 6. OpenAI Codex — triggers and closed loops

- Linear integration: triage rules **auto-route issues to the agent**; it
  posts status and ends at PR creation (human merges). GitHub: automatic PR
  review, `@codex fix it` / `fix the CI failures` spin up cloud tasks.
  /goal loops "until it evaluates that the goal has been completed... or the
  configured token budget has been exhausted."
  → Queue-column triggers (9/03) and budget exhaustion semantics.

## 7. What we ship that none of them do

1. **Neutral loops**: every rival's loop is welded to its own agent.
   Ours drives ANY installed CLI (ADR 0002) — switch the brain, keep the
   harness, receipts identical.
2. **Quota-aware pacing**: pace-guard (Phase 7) pauses/fails-over BEFORE the
   provider wall. Nobody else can see the wall coming locally.
3. **Local-first, zero-account, inspectable**: loops, ledgers, and playbooks
   are files + local db; no cloud, no seats, no credits.
4. **Gates as composition, not features**: worktree isolation, redacted
   review, reviewer gate, typed confirms already exist and are smoke-proven —
   loops reuse them rather than reimplementing trust.
