Part II begins with the DECISIONS, recorded as an ADR — reconciled with
what is ALREADY deployed: the company site (`../MoggingLabs-Website`,
Next.js + Neon + Vercel) already runs **Stripe** billing + a revenue
ledger. So this mostly RATIFIES the built reality + the one architecture
split. Grounded in `RESEARCH.md` + `RESEARCH-web.md`. No code this step.

## Steps
1. **ADR 0019 — the real service stack**. Ratify, each with rationale +
   the $0 basis:
   (a) **The authN/authZ split (binding)** — the shipped app does DPoP
   (RFC 9449) and NO off-the-shelf IdP speaks it; so the IdP does IDENTITY
   only (`id_token`) and OUR backend mints the DPoP-bound token + the
   Ed25519 entitlement. Keeps every shipped line; IdP stays swappable.
   (b) **The backend lives in the WEBSITE**, not a greenfield workspace
   `server/`: the entitlement/account API is new Next.js routes on the
   EXISTING Neon + Vercel + Stripe stack (`../MoggingLabs-Website`) — one
   deploy, reusing the live revenue ledger + reconcile cron.
   (c) **Billing = Stripe (already the rail)** — a Stripe webhook →
   `revenue_events` ledger + reconcile cron are live. Supersedes the
   earlier Polar note. Tax, honestly: **Stripe direct + Stripe Tax now**; a
   **Polar/Paddle MoR wrapper** (both on Stripe rails, not a rip-out) is an
   OPTIONAL later move if global tax filing becomes a burden — with raw
   Stripe WE are merchant of record and own registration where thresholds
   hit.
   (d) **IdP** for the Next.js/Neon stack: **Auth.js (NextAuth)** on Neon
   ($0, owned) primary, **Clerk** the polished-DX alternative, **WorkOS
   AuthKit** the pre-declared Enterprise SSO swap — all behind the same
   `id_token` seam. Supabase Auth is viable but adds a vendor the stack
   doesn't need.
   (e) **Pricing = DECIDED tiers** (`PRICING-STRATEGY.md`): **Free / Pro $19
   / Team $29 per seat (2+) / Enterprise (contact sales)**, annual ~17% off.
   FREE_ENTITLEMENTS revises to **2 workspaces x 4 panes, all integrations**
   (from the shipped 16-pane baseline); Team/Enterprise add **org +
   per-seat** to the claim.
2. **Map the FAKEs to the reals**: `fake-idp.ts` → the chosen IdP + our
   token endpoint; `fake-entitle.ts` `/mor/webhook` → the EXISTING Stripe
   webhook (same event-id idempotency + signature-before-state), EXTENDED
   to drive entitlements; `fake-entitle.ts` issuer → a new backend Ed25519
   signer with the same `deviceId`+watermark claims. A fill-in, not a
   redesign.
3. **Operator accounts**: Stripe + Neon (live), the IdP project —
   operator-action in CHECKLIST; no gate depends on them (gates run
   local/FAKE). Domain + GSC already done.
4. **Deferrals**: SSO (WorkOS) until Enterprise scale; RFC 8414 discovery pin,
   `iss`/`aud` in the entitlement JWT, RS-side `jti` replay — with the real
   issuer (11); the MoR-wrapper option — post-launch if tax demands it.

## Files
- `docs/adr/0019-real-service-stack.md` · `RESEARCH.md` + `RESEARCH-web.md`
  · `../MoggingLabs-Website` (the stack being ratified) · `CHECKLIST.md`

## Definition of Done
- ADR 0019 ratifies the split, the website-hosted backend, Stripe-as-rail
  (+ the tax note), the IdP choice, and the Free/Pro/Team/Enterprise tiers — each
  with rationale; the split is binding on 09-13.
- The FAKE→real map shows every shipped contract the reals must keep,
  including that the Stripe webhook is EXTENDED, not replaced.
- Operator-account items are in CHECKLIST, flagged, no gate depending on
  them.

## Checks that must be green
- `npm run typecheck` → 0 (no code changed); `check-docs-refs` on the ADR
  cross-links; gate-count unchanged.

## Guardrails
- Decisions + rationale only — zero backend code this step.
- Ratify the DEPLOYED reality (Stripe, Neon, Vercel, the pricing) — do not
  re-recommend a vendor the owner already chose without a costed reason.
- The DPoP/device-binding design is preserved, not re-opened.
