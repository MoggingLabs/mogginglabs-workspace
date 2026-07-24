# 04 — Cards + Cloudflare: the key method, indistinguishable on the surface

Read the pack README + the survey first. Builds on steps 01–03.

## Goal
The user-visible payoff: a provider with `restTools` offers a real "Paste an API
key" method on its tool card — including providers whose hosted MCP is OAuth-only
(Cloudflare, the motivating ask). Connected that way, the tool verifies, names its
account, scopes, launches, and fixes IDENTICALLY to an MCP-backed tool.

## Deliverables
1. **The chooser learns the bridge**: a catalog row with `restTools` + an `apiKey`
   method renders "Paste an API key" even with no MCP token endpoint. Submit runs
   prove-before-save against the catalog `verification` block (MANDATORY for
   restTools services — RESTSCHEMA gains the rule + selftest mutation), vaults the
   key (one-paste-every-route law included), registers the bridge server row, and
   the card flips `✓ Connected · verified 0m ago` — the STATUS ENGINE's stamp, via
   the verification endpoint, no MCP probe involved.
2. **The family + the key**: on a FAMILY card (Cloudflare), the key method renders
   ONCE at family level when every member shares `restAuth` + one key — one paste
   lights the whole family (each member registers its bridge row; the family tag
   aggregates as ever). The chooser wording stays ADR 0020 verbatim.
3. **Cloudflare authored + dev-verified**: `restTools` for the family's majors —
   suggested: accounts/zones list, DNS records read, Workers list, KV namespaces
   read, analytics read, cache purge (readOnly:false), DNS record upsert
   (readOnly:false) — each ≤12/svc overall, re-authored from
   developers.cloudflare.com/api with per-tool provenance, LIVE-verified with a
   real token before `verifiedAt` lands (the operator step if no token in CI —
   mark rows pending-verify and keep them DARK until stamped; the checklist rule
   from step 03 holds).
4. **Two more majors** to prove generality where the MCP story is weak or absent —
   pick from: Stripe (read-heavy set), Vercel, PostHog (finish step 01's dark
   row), Notion. Same discipline.
5. **Identity + docs**: each authored service keeps/gains a `profile` spec so the
   card says WHO; the Library card copy gains one honest line for bridge-backed
   tools ("runs on this machine against the provider's own API") — TOOLWORDS
   clean, CUSTODY clean.

## Gate — RESTCARDS
Env-gated smoke, fixture REST API + fixture catalog rows: (a) the chooser renders
the key method for a restTools-only fixture, ADR strings verbatim, rank honored;
(b) paste → prove-before-save hits the verification endpoint (fixture asserts
path; a refused key retains the field, SECRETFORMS law) → card `✓ Connected ·
verified 0m ago`; (c) the FAMILY key method: one paste → every member connected,
one family card, aggregate tag; (d) tools/list through the real bridge row shows
the curated names; (e) identity lands from `profile` (accountSource asserted);
(f) heartbeat re-verifies via the verification endpoint (fixture counts — no MCP
handshake ever fired). Mutation-red ×2: break the family fan-out ((c) must red);
break the mandatory-verification rule (RESTSCHEMA selftest must red).

## Guardrails
- Existing gates reconciled in the same commit (TOOLCARDS' chooser asserts,
  TOOLPULSE's key-auth path, TOOLWHO's rest rung — new selectors, same
  guarantees, never deleted).
- No real Cloudflare token in any gate: fixtures only; live verification is the
  operator's stamped step.

## Done when
RESTCARDS green ×2 mutation-reds; TOOLCARDS/TOOLPULSE/TOOLWHO/TOOLSMILESTONE
green; the Cloudflare family shows the key method in a live dev instance; sweep
green vs baseline.
