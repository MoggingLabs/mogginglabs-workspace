Now the real backend exists, re-threat-model the WHOLE product and close
what's cheap to close — without a single dishonest claim. The teeth stay
ADR 0016 §5 (hardware binding + server value); this step sharpens
friction, attribution, and revocation, and writes down every residual so
nothing is oversold at launch.

## Steps
1. **Threat re-model** (`docs/23-threat-model.md`): the attacker set
   (casual patcher, asar-extractor, license-sharer, key-lifter, MITM,
   replay), what each wants, and which control actually stops or merely
   slows them. Re-derive from docs/19's "honest limits" now that server
   value is real — the license-sharer and the offline-forever cracker are
   the two that server-side issuance + device cap genuinely raise the cost
   for; say exactly how much.
2. **Close the cheap residuals** found in the re-model: confirm no
   env-repointable origin survives (ORIGINPIN over IdP/backend/issuer),
   the entitlement TTL is tuned so revocation latency is acceptable but a
   plane-flight still works (the grace law), the device cap is enforced
   server-side (11), the update feed integrity check bites (docs/10's
   `latest.yml` cross-check), and the JWKS/pinned-key rotation path (13)
   is exercised. Each is a small, honest hardening — not a new wall.
3. **Add attribution + revocation teeth** where free: the boolean piracy
   telemetry (`build.modified`, `entitlement.device_mismatch`) flows to a
   revocation workflow (server-side, next-refresh degrade); the watermark
   trace tool (`trace-watermark.mjs`) is documented as the leak-response
   runbook. Revocation is refusal-to-reissue, never detonation.
4. **PIRACYAUDIT gate** (`scripts/check-piracy-audit.mjs` +/or a smoke,
   qa-smokes row): asserts the controls that MUST hold — no env origin
   override anywhere, tampered→Free-only, copied→Free, forged/replayed
   webhook→no-op, revoked→Free-next-refresh, feed-integrity bites — as one
   consolidated regression fence. Verdict `out/piracyaudit-result.json`.
5. **The honesty pass**: every security sentence in docs/19/21/22/23 and
   any UI copy is checked to CLAIM only what the control does; a wall
   described as a wall that is really a speed bump is a finding.

## Files
- `docs/23-threat-model.md` · `scripts/check-piracy-audit.mjs` (and/or a
  smoke) · `scripts/qa-smokes.sh` · any origin/TTL/feed hardening in
  `src/` · `docs/19` cross-links · `CHECKLIST.md` (mark 14)

## Definition of Done
- The threat model maps every attacker to the control that stops/slows it,
  with the residual stated; the two "real teeth" cases show their raised
  cost concretely. It states plainly that **the tier caps are honor-system
  client nudges** and that at v1 **Pro has no server-enforced lever**
  (sync, its intended spine, is unbuilt) — `TIERS.md`.
- PIRACYAUDIT green and bite-proven for each control it fences (flip one →
  red).
- Every added measure is honestly scoped — no control is described beyond
  what it does; the honesty pass finds and fixes any overclaim.

## Checks that must be green
- `npm run typecheck` → 0; build ok; static battery; PIRACYAUDIT; FUSES +
  BYTECODE + WATERMARK + tamper + the entitlement/device gates green;
  PRODMILESTONE unmoved; both budgets held.

## Guardrails
- The teeth are hardware binding + server value — everything else is
  friction/attribution; the doc and the gate must say so.
- No new control that costs money or adds a runtime dependency (ADR 0004).
- Revocation is refusal-to-reissue; there is NO remote kill of a running
  app — do not add one.
