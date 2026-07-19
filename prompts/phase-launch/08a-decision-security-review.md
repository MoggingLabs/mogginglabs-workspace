Every decision in this pack creates an incentive, and an incentive is an
attack surface. The tier decision proved it: Free dropped to 4 panes while
Pro got 16, which quietly made a plain-text renderer constant the entire
product difference — nobody noticed until someone asked "what is the
cheapest way to defeat this?". That question found it in minutes. Make the
question STRUCTURAL, so the next one is not found by luck. No code here:
this is the review instrument and the gate that enforces it.

## Steps
1. **The review instrument** (`prompts/phase-launch/SECREVIEW.md`): six
   questions every decision answers, each in a sentence, none skippable —
   (a) what does this protect or gate; (b) who wants past it and what do
   they gain; (c) **what is the CHEAPEST defeat** (name the file, the
   value, the step); (d) what does that defeat cost the attacker versus
   what it costs us; (e) what is the residual we accept; (f) what fact
   would change this answer. (c) is the one that bites — an answer that
   cannot name a concrete cheapest defeat has not been reviewed.
2. **Bind it to ADRs**: no ADR merges without a `## Security review`
   section carrying the six. **ADR 0019 (08) is the first**, retroactively
   — its authN/authZ split, its Stripe rail, and its tier matrix each get
   the six, and whatever (c) surfaces is routed to FINDINGS like any other
   defect (01 §3: must-fix, no defer).
3. **Bind it to PRODUCT decisions too, not just architecture.** Anything
   that gates, prices, caps, or paywalls gets the review — that is the
   class the tier decision fell into and slipped through, because it looked
   commercial rather than technical. `TIERS.md` is the worked example: each
   gated row names its enforcement point, so a row whose only enforcement
   is "a constant in the renderer" is visible at decision time, not after
   launch.
4. **SECREVIEW static gate** (`scripts/check-security-review.mjs`,
   qa-smokes row): fails if any ADR under `docs/adr/` lacks the section or
   answers a question with a placeholder, if any `TIERS.md` gated row lacks
   a named enforcement point, or if a (c) answer has no matching FINDINGS
   id. Pure file parse, zero boot. Bite-prove it by blanking one answer.
   Verdict `out/secreview-result.json`.
5. **The standing law** (pack README, beside the enforcement-honesty law):
   every decision this pack ratifies carries the six, and a decision whose
   cheapest defeat is cheaper than the value it guards is **not ratified
   until that changes or the residual is accepted in writing**.

## Files
- `prompts/phase-launch/SECREVIEW.md` · `docs/adr/0019-*.md` (first to
  carry it) · `TIERS.md` (enforcement point per gated row) ·
  `scripts/check-security-review.mjs` · `scripts/qa-smokes.sh` · pack
  `README.md` (the law) · `FINDINGS.md` · `CHECKLIST.md` (mark 08a)

## Definition of Done
- SECREVIEW.md exists with the six questions and a worked example — the
  tier decision, reviewed honestly, including that its cheapest defeat was
  a renderer constant.
- ADR 0019 carries the section; every (c) answer is either fixed or has a
  FINDINGS id (never a defer — 01 §3).
- Every gated `TIERS.md` row names where it is enforced.
- SECREVIEW green + bite-proven; the README law is written.

## Checks that must be green
- `npm run typecheck` → 0 (no product code); build ok; static battery;
  SECREVIEW; `check-docs-refs`; gate-count re-derived.

## Guardrails
- No product code — instrument, ADR section, and gate only.
- The review is adversarial or it is decoration: (c) must name a concrete
  cheapest defeat, and "it is obfuscated" is not an answer.
- It may not be used to CLAIM security — it records what is defeatable and
  how cheaply, so the enforcement-honesty law still governs every sentence.
