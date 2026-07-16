Freeze the pack the house way: write the book (docs/19-accounts.md), finish
the gallery, and prove the WHOLE promise in ONE composed milestone — a user
subscribes, unlocks Pro, and a copied install goes inert — all on FAKE
services with zero network, both budgets unmoved.

## Steps
1. **docs/19-accounts.md**: the custody stance (ADR 0016); the enforcement
   doctrine (hardware binding + server value are the teeth; local checks are
   UX); the offline-grace law; the fuse wall + asarUnpack caveat; the
   runtime split (ADR 0017); per-OS device-key notes; the honest limits of
   bytecode/watermark/tamper-check; the freemium boundary. Update
   `docs/02-mvp-and-roadmap.md`, `prompts/README.md` (phases row → done),
   the README roadmap + tagline nuance ("free local core + optional Pro").
   Note explicitly: **code-signing certs are the operator's deferred final
   step**, out of this pack.
2. **Gallery completeness** (both themes): the account panel (anon +
   authed), the plan badge, a locked-feature upgrade state, the grace-state
   banner, a device-mismatch notice. Fixture data only — no real email in
   visible crumbs; `out/gallery/errors.json` empty.
3. **`MOGGING_PRODMILESTONE`** (env-gated; FAKE IdP + FAKE MoR/issuer + FAKE
   hardware key; zero network, zero vendor CLIs): one composed run — anon
   free app opens OFFLINE with no account and `mogging list/send/capture`
   work → login (PKCE, FAKE IdP) → a FAKE MoR "subscription" webhook issues
   a device-bound entitlement → Pro unlocks a previously-capped feature →
   pull the network: Pro holds through grace, then degrades to Free, never
   bricks → present the entitlement as a DIFFERENT device: rejected, no
   re-license → tamper flag withholds Pro but the free app still runs →
   logout returns cleanly to anon-free. Verdict
   `out/prodmilestone-result.json`.
4. **Budgets + fuses, measured on the composed surface**: MILESTONE (16
   panes + the account/entitlement machinery live: worst gap ≤ 150ms, avg
   fps ≥ 30, heap ≤ 300MB) and PERCEPTION — UNCHANGED numbers, per-OS in
   REPORT.md; and FUSES reads the exact wall incl. `runAsNode:false`. All
   anti-crack work proven OFF the boot path (I7).
5. **Sweep + freeze**: all ten gate rows (ORIGINPIN · FUSES · LOCKDOWN ·
   ACCOUNT · ENTITLE · DEVICEKEY · BYTECODE · WATERMARK · RUNTIMESPLIT ·
   PRODMILESTONE) wired into `scripts/qa-smokes.sh` docs + CI; targeted
   green here (the full uncut sweep + 3-OS dispatch is the operator's run,
   the phase-11 rule); README § Freeze ledger (per-step commits, run ids);
   REPORT.md receipts (measured numbers, platform finds).

## Files
- `docs/19-accounts.md` · `docs/02-mvp-and-roadmap.md` · `prompts/README.md`
  · `README.md` · `src/main/prodmilestone-smoke.ts` · `src/main/gallery.ts`
  (parts) · main dispatch · qa-smokes.sh + CI rows ·
  `prompts/phase-accounts/README.md` (§ Freeze) · REPORT.md

## Definition of Done
- PRODMILESTONE green; all ten gates wired; the sweep count reflects them.
- One run proves it: subscribe → Pro; offline → grace → Free, never bricks;
  copied to new hardware → inert; tampered → free-only; free tier + CLI
  untouched throughout.
- Both perf budgets numerically unchanged; FUSES shows `runAsNode:false`;
  the book + gallery match a fresh machine.

## Checks that must be green
- typecheck 0; build (all arches + helper) ok; static gates (AUDIT ·
  SPACING · PTYSEAM · PROTOVER · FUSES · BYTECODE); targeted sweep + both
  budgets. Full uncut + 3-OS dispatch = operator.

## Guardrails
- PRODMILESTONE is the ONLY authority on "phase done" — no gate skipped.
- ADR 0002 sweep before freeze: grep for any provider credential in this
  surface — there is none. Signing certs remain the operator's step.
- FAKE-first proven: the whole milestone runs with zero network; protocol v9.
