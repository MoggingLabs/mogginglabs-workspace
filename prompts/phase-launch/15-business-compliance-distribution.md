The paperwork a public launch legally needs — and the distribution prep —
all $0, all producible now. Today the LICENSE grants NO right to use;
you cannot ship even a free user until this lands. Drafts + runbooks
here; the operator signs/deploys later. No code beyond a copy gate.

## Steps
1. **The legal set** (`legal/`): an **EULA** granting free-tier use
   (fixes the LICENSE-grants-nothing gap), **subscription terms** for Pro,
   a **privacy policy** naming every subprocessor (Sentry, PostHog, the
   IdP, the MoR) and the tiny data map (email, subscription status, device
   records, opt-in telemetry), and a **security.txt** + disclosure policy
   (you hold users' OAuth grants — a researcher needs a door). Templates
   are fine; mark each "operator: review with counsel before publish."
2. **Business runbook** (`docs/24-launch-ops.md`): the Stripe reality —
   with raw Stripe WE are merchant of record, so **enable Stripe Tax** and
   note where registration thresholds apply; the products/prices
   (Free/Pro $19/Team $29-per-seat/Enterprise) checklist; the refund/chargeback flow; the
   **optional-later MoR wrapper** (Polar/Paddle on Stripe rails) with its
   tax tradeoff; a support channel (email + GitHub issues) + a one-sentence
   Pro SLA; the subprocessor/DPA notes. Every item flagged operator-action
   with its cost ($0 unless noted; incorporation may be needed for Stripe
   payouts — verify for the operator's country).
3. **Positioning reconciliation**: audit README + docs/00 non-goals + all
   marketing copy so "free, local, **account-free core**" stays exact
   while "no account, ever / no server, ever" absolutes are corrected to
   the freemium truth. `check-credential-wording.mjs` grows the patterns
   that keep the retired absolutes from creeping back (extend 12's work).
4. **Distribution prep**: the winget + homebrew submission playbooks
   (docs/10) turned into a ready checklist (fork, copy `packaging/*`, PR)
   — GATED on signed artifacts, so marked PENDING-operator (post-signing);
   the homebrew-tap-first path; the Stripe Checkout page plan (hosted
   checkout keeps PCI off us) and the funnel events (via the site's own
   first-party collector, never a third-party analytics script).
5. **COMPLIANCE static gate** (`scripts/check-compliance.mjs`, qa-smokes
   row): asserts every required legal doc EXISTS and is non-placeholder,
   security.txt is well-formed, and the subprocessor list is present.
   Verdict `out/compliance-result.json`.

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
- The launch-ops runbook covers Stripe products/prices + Stripe Tax,
  refunds, support, the optional-later MoR wrapper, and the payout/
  incorporation point — all costed.
- Distribution playbooks are a ready checklist, PENDING-operator behind
  signing.

## Checks that must be green
- `npm run typecheck` → 0; build ok; static battery; COMPLIANCE; the
  credential-wording gate; gate-count re-derived.

## Guardrails
- $0 — drafts + runbooks only; the operator publishes/incorporates/signs.
  Nothing here spends.
- Legal templates are a STARTING point flagged for counsel — never
  presented as final legal advice.
- The account-free FREE core promise stays literally true; only the
  now-false absolutes are corrected.
