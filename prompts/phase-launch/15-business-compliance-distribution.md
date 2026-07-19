The paperwork a public launch legally needs — and the distribution prep —
all $0, all producible now. Today the LICENSE grants NO right to use; you
cannot ship even a free user until this lands. Drafts + runbooks here; the
operator signs later. No code beyond a copy gate.

## Steps
1. **The legal set** (`legal/`): an **EULA** granting free-tier use (fixes
   the LICENSE-grants-nothing gap); **subscription terms** carrying the
   **7-day money-back guarantee** (GROWTH-PLAN promises it on all paid
   plans — a contract term, not copy); a **privacy policy** naming every
   subprocessor (Sentry, PostHog, the IdP, Stripe, Loops) + the data map,
   its erasure section describing **11a's request-based mechanism + SLA**,
   never a self-serve erasure we did not build; a **security.txt** +
   policy (you hold users' OAuth grants — a researcher needs a door).
   Templates are fine; mark each "operator: counsel before publish."
2. **Business runbook** (`docs/24-launch-ops.md`): the Stripe reality —
   with raw Stripe WE are merchant of record, so **enable Stripe Tax** and
   note where thresholds apply; prices per `TIERS.md` (**Pro monthly +
   annual ONLY** — no Team product) + Portal config (11a: cancel +
   interval switch); the refund flow honoring the 7-day window; the
   **optional-later MoR wrapper** with its tax tradeoff; a support channel
   + a one-sentence Pro SLA; subprocessor/DPA notes. Every item flagged
   operator-action with cost ($0 unless noted; incorporation may be needed
   for Stripe payouts — verify per country).
3. **Positioning reconciliation**: audit README + docs/00 non-goals + all
   marketing copy so "free, local, **account-free core**" stays exact
   while "no account, ever / no server, ever" absolutes become the
   freemium truth; `check-credential-wording.mjs` grows patterns keeping
   them out. **Also fix the STALE strategy docs at the source** —
   `GROWTH-PLAN.md` ("three tiers", "$39 anchor", the $12 founding price)
   and `PRICING-STRATEGY.md:52` (the retired notifications split) —
   reconciling both to `TIERS.md`.
4. **Distribution prep**: winget + homebrew playbooks (docs/10) as a ready
   checklist (fork, copy `packaging/*`, PR) — GATED on signed artifacts,
   so PENDING-operator; homebrew-tap-first; the Stripe Checkout plan
   (hosted keeps PCI off us) + funnel events via the site's first-party
   collector, never a third-party script.
5. **COMPLIANCE static gate** (`scripts/check-compliance.mjs`, qa-smokes
   row): asserts every legal doc EXISTS and is non-placeholder,
   security.txt is well-formed, the subprocessor list is present. Verdict
   `out/compliance-result.json`.

## Files
- `legal/{EULA,subscription-terms,privacy,security.txt}.md` ·
  `docs/24-launch-ops.md` · `scripts/check-compliance.mjs` ·
  `scripts/check-credential-wording.mjs` · `README.md`/`docs/00`
  (positioning) · `scripts/qa-smokes.sh` · `CHECKLIST.md` (mark 15)

## Definition of Done
- The legal set exists (EULA + terms + privacy + security.txt), each
  naming the real subprocessors, each flagged for counsel review; the
  LICENSE-grants-nothing gap is closed for the free tier.
- COMPLIANCE green (docs present + well-formed); the wording gate passes
  with the freemium-accurate copy.
- The launch-ops runbook covers prices + Stripe Tax + portal config,
  refunds, support, the optional MoR wrapper, and the payout point — all
  costed.
- Distribution playbooks are a ready checklist, PENDING-operator behind
  signing.

## Checks that must be green
- `npm run typecheck` → 0; build ok; static battery; COMPLIANCE; the
  credential-wording gate; gate-count re-derived.

## Guardrails
- $0 — drafts + runbooks only; the operator publishes/signs.
- Legal templates are a STARTING point flagged for counsel — never
  presented as final legal advice.
- The account-free FREE core promise stays true; only the
  now-false absolutes are corrected.
