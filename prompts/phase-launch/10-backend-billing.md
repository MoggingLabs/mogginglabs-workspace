Wire the money into ENTITLEMENTS by EXTENDING what already ships. The site
already runs a Stripe webhook → `revenue_events` ledger (`api/webhooks/
stripe/route.ts`: event-id idempotent, hashed customers, 400/200/503) + a
`stripe-reconcile` cron. The FAKE's `t=,v1=` HMAC shape IS Stripe's
signature scheme — so this is a fill-in: grow the same webhook to derive
entitlements, and add the subscription lifecycle.

## Steps
1. **Extend the existing Stripe webhook** (the live route, not a new
   `mor-webhook`): keep its proven order — signature over the RAW body via
   `stripe.webhooks.constructEvent` BEFORE any state, event-id idempotency
   (replays are no-ops), the 400/200/503 contract — and ADD an
   entitlement-derivation branch beside the ledger write. Forged and
   replayed deliveries still flip nothing; the ledger does not regress.
2. **The entitlement schema** (new Neon migrations, append-only alongside
   001-007): `accounts` (id ⇄ IdP subject), `subscriptions` (plan, status,
   Stripe ids, current-period), `entitlements` (derived plan + features +
   limits), `devices` (thumbprint ⇄ account, cap per `TIERS.md`).
   `validate-schema.mjs` covers them.
3. **The full lifecycle** → `subscriptions` + derived `entitlements`, keyed
   to `TIERS.md` — **Free + Pro ONLY; no Team price id exists** (waitlist,
   08). Pro carries **two price ids (monthly + annual)**, so derivation
   maps price id → plan+interval, never a hard-coded product:
   `checkout.session.completed` + `customer.subscription.created` (grant),
   `.updated` (plan OR interval change — re-derive from the new price id;
   Stripe owns proration), `.deleted`/period-end (revert to Free at
   current-period-end, never mid-period), `charge.refunded` (revoke),
   `invoice.paid`/`past_due` (grace, not instant cutoff). Each transition
   idempotent + an immutable row. "A plan can only widen" is 11's contract.
4. **Extend the reconcile cron** (`stripe-reconcile`): also heal
   entitlement drift a missed webhook left — the backstop that makes "works
   from day one" true when a delivery is lost. Idempotent.
   **Lifecycle email** via the EXISTING Loops setup: payment failed /
   grace / reverted to Free / refunded — a silent downgrade the user never
   heard about is a support incident.
5. **Local-offline gate**: FAKE Stripe deliveries (genuine, forged,
   replayed, out-of-order, redelivered) drive the route against a local
   Neon/pg; assert forged/replayed flip nothing, `created`→Pro then
   `deleted`→Free-at-period-end, a redelivery is a no-op. Zero network —
   reuse the site's pg-ws proxy.

## Files
- `../MoggingLabs-Website/`: `api/webhooks/stripe/route.ts` (extended) ·
  `src/lib/stripe.ts` · `db/migrations/NNN-entitlements.sql` ·
  `api/admin/cron/stripe-reconcile/route.ts` (extended) · derive lib +
  tests · `docs/21-backend.md` (billing) · `CHECKLIST.md` (mark 10)

## Definition of Done
- The existing webhook ALSO derives entitlements, its signature-before-
  state + idempotency + 400/200/503 contract intact; forged and replayed
  deliveries each change nothing (proven).
- Every lifecycle event maps to the right `TIERS.md` transition (Free/Pro,
  both intervals); each writes an immutable row; an interval switch
  re-derives; the cron heals a dropped webhook; each user-visible
  transition sends its Loops email.
- New migrations pass `validate-schema`; the ledger is unregressed.

## Checks that must be green
- Website `build` + `typecheck` → 0; billing tests green (forged/replayed/
  redelivered asserted); `validate-schema`; migrations clean.

## Guardrails
- EXTEND the live webhook — never fork a second; the revenue ledger's
  contract is law.
- The webhook is the ONLY way to Pro — no client claim, no manual flip
  (ADR 0016 §5).
- Idempotent everywhere; a retry never double-applies. Offline gate via
  the local pg proxy.
