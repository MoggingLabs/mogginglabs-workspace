The third correctness sweep: the money paths and the app's reach — where
a wrong edge case is worst. A licensing bug refunds strangers or bricks a
payer; a custody bug leaks a token. This scope gets the HARDEST scrutiny.
Same rubric, same prove-and-route discipline.

## Scope (INVENTORY rows for this step)
Account (`account.ts`: PKCE/DPoP/refresh/logout, the transient-vs-
definitive session law), entitlements (`entitlements.ts`: verify, cache,
grace clock, device binding, revoke, the FREE baseline), the hardening
wall (fuses, bytecode, watermark, tamper self-check `native-preflight.ts`,
device key, runtime split), the updater FEED (signature verify, artifact
name), connections/integrations (OAuth, the event bridge, GitHub adapter),
usage/metering, the browser dock + agent-web trail, files/explorer, the
Brain (reads, freshness, symbol writes, memory), MCP + the `mogging` wedge.

## Steps
1. **Enumerate the adversarial + boundary edges**: an AS answering
   5xx/429 vs a 4xx (session kept vs ended); a grace boundary crossed by
   pure time; a wound-back clock; a future `fetchedAt`; a copied vault on
   a foreign device (reads Free); a tampered build (PAID withheld, Free
   runs); a forged/replayed MoR webhook (flips nothing); an entitlement
   JWT with wrong key/alg/typ (treated absent); a token that must NEVER
   cross IPC; offline everything. For reach: an OAuth callback failure, a
   webhook to a dead URL, a huge repo in the Brain, a symbol write racing
   the file hash (CAS refuses), an ungranted MCP write (zero).
2. **Verify against the code** and assert in the owning gate — ACCOUNT,
   the entitlement/grace/device gates, FUSES, BYTECODE, WATERMARK, tamper,
   PRODMILESTONE, the integrations/usage/brain/MCP families. The
   enforcement-honesty law holds: assert what the CHECK does, never
   overclaim it as a wall.
3. **Route findings**; in this scope a licensing/custody/redaction defect
   is **S1 by default**. Fix ALL of S1–S3 here (`invalid` needs disproof);
   a fix near the crypto/verify path gets an extra adversarial assertion.
4. **Grades derive** to **A** when a lens carries no unresolved finding
   (01 §3); **re-measure** both budgets on the composed surface (16 panes
   + account/brain machinery live).

## Files
- `INVENTORY.md` (grades) · `FINDINGS.md` (routing) · the account/
  entitlement/hardening/integration/brain smokes + units extended ·
  product files fixed · `CHECKLIST.md` (mark 04 areas)

## Definition of Done
- Every scoped row derives **A** on every lens; every finding (S1–S3)
  fixed with a regression assertion red on pre-fix bytes.
- The money invariants each carry a live assertion: no token over IPC,
  copied→Free, tampered→Free-only, forged-webhook→no-op, unreachable≠
  rejected, grace-then-Free-never-brick.
- FINDINGS has no `open` row for this scope; PRODMILESTONE + both budgets
  green.

## Checks that must be green
- `npm run typecheck` → 0; build ok; static battery; LAUNCHAUDIT; the
  account/entitlement/hardening/integration/brain/MCP gates in isolation;
  MILESTONE + PERCEPTION.

## Guardrails
- Custody rules are inviolable — a "fix" that adds a token getter over IPC
  is rejected outright (the surface stays status/login/logout/changed).
- Every security claim you touch must stay HONEST — restate the residual,
  never inflate the control (docs/19 "honest limits" is the standard).
- Zero network in any gate; the FAKE IdP/MoR drive everything here.
