Wire the money into ENTITLEMENTS by EXTENDING what already ships. The
website already runs a Stripe webhook → `revenue_events` ledger
(`../MoggingLabs-Website/src/app/api/webhooks/stripe/route.ts`:
event-id idempotent, hashed customers, 400/200/503 contract) + a
`stripe-reconcile` cron. The FAKE's `t=,v1=` HMAC shape IS Stripe's
signature scheme — so this is a fill-in: grow the same webhook to derive
entitlements, and add the subscription lifecycle.

## Steps
1. **Extend the existing Stripe webhook** (the live route, not a new
   `mor-webhook`): keep its proven order — Stripe signature over the RAW
   body via `stripe.webhooks.constructEvent` BEFORE any state, event-id
   idempotency (replays are no-ops), the 400/200/503 contract — and ADD an
   entitlement-derivation branch beside the ledger write. A forged or
   replayed delivery still flips nothing. Nothing about the revenue ledger
   regresses.
2. **The entitlement schema** (new Neon migrations `db/migrations/NNN-*.sql`,
   append-only alongside 001-007): `accounts` (id ⇄ IdP subject),
   `subscriptions` (plan, status, Stripe ids, current-period), `entitlements`
   (derived plan + features + limits), `devices` (deviceId thumbprint ⇄
   account, per-plan cap). `validate-schema.mjs` covers them.
3. **The full lifecycle** → `subscriptions` + derived `entitlements`, keyed
   to the DECIDED tiers (Free/Pro $19/Agency $39): `checkout.session.
   completed` + `customer.subscription.created` (grant), `.updated` (plan
   change), `.deleted`/period-end (revert to Free at current-period-end,
   never mid-period), `charge.refunded` (revoke), `invoice.paid`/`past_due`
   (grace, not instant cutoff). Each transition idempotent; each an
   immutable ledger/audit row. "A plan can only widen" is the ISSUER's
   contract (11).
4. **Extend the reconcile cron** (`stripe-reconcile`): also heal
   entitlement drift a missed webhook left — the backstop that makes "works
   from day one" true when a delivery is lost. Idempotent by construction.
5. **Local-offline gate**: a FAKE Stripe delivery (genuine, forged,
   replayed, out-of-order, redelivered) drives the route against a local
   Neon/pg; assert forged/replayed flip nothing, `subscription.created`→Pro
   then `deleted`→Free-at-period-end, a redelivery is a no-op. Zero external
   network — reuse the site's pg-ws proxy for local runs.

## Files
- `../MoggingLabs-Website/src/app/api/webhooks/stripe/route.ts` (extended) ·
  `src/lib/stripe.ts` · `db/migrations/NNN-entitlements.sql` ·
  `src/app/api/admin/cron/stripe-reconcile/route.ts` (extended) ·
  entitlement-derive lib + tests · `docs/21-backend.md` (billing chapter) ·
  `CHECKLIST.md` (mark 10)

## Definition of Done
- The existing Stripe webhook now ALSO derives entitlements, with its
  signature-before-state + idempotency + 400/200/503 contract intact; a
  forged and a replayed delivery each change nothing (proven).
- Every lifecycle event maps to the right transition against Free/Pro/Agency
  (period-end revert, revoke, grace); each writes an immutable row; the
  reconcile cron heals a dropped webhook in test.
- New migrations pass `validate-schema`; the revenue ledger is unregressed.

## Checks that must be green
- Website `npm run build` + `typecheck` → 0; billing tests green (forged/
  replayed/redelivered asserted); `validate-schema` green; migrations clean.

## Guardrails
- EXTEND the live webhook — do not fork a second one; the revenue ledger's
  contract is law and must not regress.
- The webhook is the ONLY way to Pro — no client claim, no manual flip;
  server-side value (ADR 0016 §5).
- Idempotent everywhere; a retry never double-applies. Offline gate via the
  local pg proxy.
