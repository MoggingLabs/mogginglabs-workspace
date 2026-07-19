Wire the money into ENTITLEMENTS by EXTENDING what ships. The site already
runs a Stripe webhook → `revenue_events` ledger (`api/webhooks/stripe/
route.ts`: event-id idempotent, hashed customers, 400/200/503) + a
`stripe-reconcile` cron. The FAKE's `t=,v1=` HMAC shape IS Stripe's — so
this is a fill-in: grow that webhook to derive entitlements, add the
lifecycle.

## Steps
1. **Extend the existing Stripe webhook** (the live route, not a new
   `mor-webhook`): keep its proven order — signature over the RAW body via
   `constructEvent` BEFORE any state, event-id idempotency (replays no-op),
   the 400/200/503 contract — and ADD an entitlement-derivation branch
   beside the ledger write. Forged and replayed deliveries still flip
   nothing; the ledger does not regress.
2. **The entitlement schema** — 09 defines it; here land the append-only
   Neon migrations alongside 001-007 and confirm `validate-schema.mjs`
   covers them. Do not redefine the tables.
3. **The full lifecycle** → `subscriptions` + derived `entitlements`, keyed
   to `TIERS.md` — **Free + Pro ONLY; no Team price id exists** (08). Pro
   carries **two price ids (monthly + annual)**, so derivation maps price
   id → plan+interval, never a hard-coded product:
   `checkout.completed` + `subscription.created` (grant), `.updated` (plan
   OR interval — re-derive from the new price id; Stripe owns proration),
   `.deleted`/period-end (Free at period-end, never mid-period),
   `charge.refunded` (revoke), `invoice.paid`/`past_due` (grace, not
   cutoff). Each idempotent + an immutable row.
4. **Extend the reconcile cron** (`stripe-reconcile`): heal entitlement
   drift a missed webhook left — the backstop making "works from day one"
   true when a delivery is lost. **Lifecycle email** via the EXISTING
   Loops: payment failed / grace / reverted / refunded — a silent
   downgrade is a support ticket.
5. **The promised commercials** — every row of `TIERS.md`'s reconciliation
   table: promotion codes with **stacking OFF**; the **founding Pro price
   $15/mo FOR LIFE** as its own never-expiring price id (a lifetime rate
   is a permanent obligation — never a lapsing coupon); **price-lock**
   (grandfather by price id, so a rise never re-prices an existing sub);
   the early-access→GA migration.
6. **Local-offline gate**: FAKE Stripe deliveries (genuine, forged,
   replayed, out-of-order, redelivered) drive the route against local
   Neon/pg; assert forged/replayed flip nothing, `created`→Pro then
   `deleted`→Free-at-period-end, a redelivery no-ops, a price rise leaves
   a grandfathered sub alone. Zero network — pg-ws proxy.

## Files
- `../MoggingLabs-Website/`: `api/webhooks/stripe/route.ts` (extended) ·
  `src/lib/stripe.ts` · `db/migrations/NNN-entitlements.sql` ·
  `api/admin/cron/stripe-reconcile/route.ts` · derive lib + tests ·
  `docs/21-backend.md` · `CHECKLIST.md` (mark 10)

## Definition of Done
- The webhook ALSO derives entitlements, its signature-before-state +
  idempotency + 400/200/503 contract intact; forged and replayed
  deliveries change nothing (proven).
- Every lifecycle event maps to the right `TIERS.md` transition (Free/Pro,
  both intervals); each writes an immutable row; an interval switch
  re-derives; the cron heals a dropped webhook; each sends its Loops note.
- Every commercial in `TIERS.md`'s table is real: codes don't stack, the
  founding price applies, a rise leaves existing subs alone.
- Migrations pass `validate-schema`; the ledger unregressed.

## Checks that must be green
- Website `build` + `typecheck` → 0; billing tests green (forged/replayed/
  redelivered asserted); `validate-schema`; migrations.

## Guardrails
- EXTEND the live webhook — never fork a second; its contract is law.
- The webhook is the ONLY way to Pro — no client claim (ADR 0016 §5).
- Idempotent everywhere; a retry never double-applies. Offline via pg
  proxy.
