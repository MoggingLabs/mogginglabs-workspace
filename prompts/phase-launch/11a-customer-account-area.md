A paying customer currently has NOWHERE to go: the site has `pricing`,
`privacy`, `terms` and no account surface at all. Checkout takes money and
strands them — no plan view, no card change, no CANCEL. That is a launch
blocker and a consumer-law problem (EU/UK/CA: cancelling must be as easy
as subscribing). Build the minimum honest surface, in
`../MoggingLabs-Website`, all $0.

## Steps
1. **Site login** (Auth.js on the existing Neon stack — the SAME IdP ADR
   0019 picks for the app, one project, one user table): email + OAuth,
   session cookie, `/account` behind it. Identity only; no entitlement
   logic here — the backend (10/11) stays the authority.
2. **`/account` — one honest page**: current plan + interval + renewal or
   period-end date, read from `subscriptions`/`entitlements` (never from a
   client claim); the registered **devices** list (thumbprint, first seen,
   last issuance) with a per-plan cap readout from `TIERS.md`; a "revoke
   this device" action that frees a slot (server-side, next-refresh
   effect). Free accounts see the Free row and an upgrade CTA — never a
   dead page.
3. **Stripe Customer Portal** (`/api/billing/portal`): a POST route that
   creates a `billingPortal.Session` for the signed-in customer and
   redirects. Stripe hosts card update, invoice history, plan/interval
   change, and CANCEL — so we own no PCI surface and get cancellation for
   free. Configure the portal to allow cancel + plan switch between the
   two Pro price ids. Portal-driven changes come back as the SAME webhooks
   10 already handles — no second code path.
4. **Data rights, honestly** (`/account` + `legal/privacy`): an export
   ("email me my data") and a delete-account request, each writing a
   `data_requests` row and notifying the operator, with the stated SLA in
   the privacy policy. Request-based fulfilment is legal; the policy must
   describe THIS mechanism and not promise instant self-serve erasure.
   Deleting revokes entitlements and unregisters devices.
5. **ACCOUNTAREA gate** (offline smoke or route tests): signed-out
   `/account` redirects; a Free session renders the Free row; a Pro
   session renders plan + devices; the portal route refuses without a
   session and returns a redirect WITH one (Stripe stubbed on loopback);
   a delete request writes its row. Zero external network.

## Files
- `../MoggingLabs-Website/src/app/(site)/account/` · `src/app/api/billing/
  portal/route.ts` · Auth.js config + `db/migrations/NNN-data-requests.sql`
  · `legal/privacy` (the real mechanism) · `docs/21-backend.md` (account
  chapter) · `CHECKLIST.md` (mark 11a)

## Definition of Done
- A signed-in customer can see their plan, see and revoke devices, reach
  the Stripe portal, and CANCEL without contacting support.
- Cancel/plan-change/card-update all route through Stripe's portal and
  land back through the EXISTING webhook — no duplicate lifecycle code.
- Export + delete requests are recorded and the privacy policy describes
  exactly this request-based mechanism (no overclaim).
- ACCOUNTAREA green offline; Lighthouse 100 holds on `/account`; zero
  third-party requests beyond the portal redirect itself.

## Checks that must be green
- Website `build` + `typecheck` → 0; ACCOUNTAREA; `validate-schema`; the
  site's frozen SEO gates unmoved (account pages are `noindex`).

## Guardrails
- The page RENDERS server truth; it never grants. No entitlement decision
  happens in the browser (ADR 0016 §5).
- Stripe's portal owns card + cancel — do not rebuild PCI surface.
- `/account` is `noindex` and outside the sitemap; it must not perturb the
  frozen SEO gates or the zero-third-party law.
