# Phase 10 — Agents on real logged-in sessions (the "Comet" question)

**Status: RESOLVED into Phase 8 (2026-07-06) — Branch B stays PARKED.** The
fork below was decided: Branch C (the dedicated agent web profile — real
logins the user creates on purpose, per-origin action grants, sensitive-
origin blocklist) is now **`prompts/phase-8/04-agent-web-profile.md`**, and
the boundary against Branch B is codified in ADR 0008.e (phase-8/01) rather
than living only here. This folder remains as the durable analysis and the
map for Branch B, which starts — if ever — with its own ADR revising 0002.
`FINDINGS.md` is unchanged and still the read-first document for that day.

## The ask
6/05b gave agents the wheel of the browser dock, but the dock runs an EMPTY,
isolated session (ADR 0002) — agents can drive `localhost` and public pages,
never act as *you* on your logged-in sites. The open question: let agents
operate on **real logged-in sessions**, the way Perplexity Comet's agent acts
on your authenticated web life.

## The fork (this decides step vs. phase — see FINDINGS.md)
- **Branch A — log the agent's browser in.** The dock partition is already
  `persist:`; sign into a site IN the dock once and agents can act on it.
  Real, persistent, consented-by-login. A small STEP, not a phase — and most
  of it already works today.
- **Branch B — inherit your system browser's sessions** (Chrome/Safari/Edge
  cookies + OS keychain). The true Comet experience. A genuine PHASE whose
  work is ~80% security design, and which **consciously reverses ADR 0002** —
  the product's "we broker nothing" identity. Not a flag; an ADR.

## Why this is parked, not built
Branch B trades the single property that makes the product trustworthy (a
hijacked agent today has an empty session = near-zero blast radius) for
convenience. With real sessions, a hostile page that injects instructions into
a snapshot can steer an agent into acting **as you** on authenticated sites —
the exact failure mode in the agentic-browser headlines. That trade is worth
making ONLY on purpose, with the consent model, per-origin scoping, injection
defenses, and threat model as the actual deliverables. FINDINGS.md enumerates
them.

## When we pick this up
1. Decide Branch A vs. B (or A-now, B-later). A is cheap and safe; do it first
   regardless.
2. If B: the first step is an ADR (0011+) that revises ADR 0002's boundary —
   nothing else starts until that lands.
3. Draft the pack from FINDINGS.md § "What a responsible Branch-B phase
   contains", house format (each step < 4000 chars, pasteable as a `/goal`).

## Guardrails carried in from today (binding on any future step)
- Per-workspace consent default OFF is the FLOOR, not the ceiling — Branch B
  needs per-ORIGIN grants + a sensitive-origin blocklist.
- Visible possession + instant Stop (built in 6/05b) stay.
- State-changing actions (send/buy/delete) on authenticated origins need
  human-in-the-loop confirmation — reading a page is not acting on it.
- Telemetry: counts/booleans only; no page content, cookies, or origins beyond
  a hash (ADR 0005).
