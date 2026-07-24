# 04 — Identity: catalog-driven profiles, user notes, never fabricate

Read README + the survey first. Builds on steps 01–03.

## Goal
Every connected tool answers "as WHO?" as well as it possibly can. Metorial's model,
as data: the catalog's `profile` spec drives one executor; a user-entered account note
covers providers with no identity door; the fallback line stays honest. Probed beats
noted; a note is never presented as proof.

## Deliverables
1. **The profile executor** — one function reads the service's catalog `profile` spec
   (step 01) and returns the normalized identity `{id, email, name, imageUrl}`
   (Metorial's shape — richer than a bare email; `account` on the Connection contract
   grows into this object, additively, with the old string kept as a computed
   fallback for untouched consumers). Rungs, tried in catalog-declared order:
   - `oidc` — id_token / userinfo (exists today; keep first where declared);
   - `rest` — the provider REST call (`GET /user` etc.) with JSON paths from the
     catalog (GitHub `.email // .login`, Slack `auth.test`, Google userinfo…);
   - `tool` — an MCP whoami-shaped tool, ONLY when the catalog names it or
     `tools/list` served a name on the small pinned allowlist (`whoami`, `get_me`,
     `me`, `current_user`…); one call, empty args, short timeout, tolerant reader,
     never speculative, never retried in a loop.
   Every rung is phase-2 enrichment (CONNPURE): best-effort, never state-bearing,
   riding `connectionEnrichmentPatch`, guarded by `enrichmentTargetsSameGrant`.
   Failures leave blanks; malformed JSON = blank, never a throw into the orchestrator.
   The landed result records its rung (`accountSource: 'oidc'|'rest'|'tool'`) — the
   card may caption `tool`-derived identity softer ("reported by the server").
   Re-probe on each successful verify ONLY when identity is still blank — an identity
   once probed is stable; don't spend a REST call per heartbeat.
2. **The account note.** `accountNote?: string` per service: user-entered, settings
   store (a label, not a secret — but NEVER in telemetry, ADR 0005). IPC get on the
   Connection shape + set/clear channel (trim, length cap). Survives disconnect and
   reconnect; only the user deletes it.
3. **Contract wording** (helpers in `connections.ts`, so no card words it twice):
   probed → the identity row (email preferred, else name); note only → `{note} ·
   noted by you` (distinct class, pencil affordance); both and differing → probed
   wins the row, note renders secondary (the "wrong account" catch); neither →
   `NO_ACCOUNT_NOTE` + "Add a note…" affordance.
4. **Catalog population**: `profile` specs for the step-01 majors, each with its
   `source:` provenance URL (CATSCHEMA extends: a `rest` profile spec must carry
   paths for at least `id` and one of email/name).

## Gate — TOOLWHO
Env-gated smoke on the fixture AS: (a) OIDC fixture → email lands,
`accountSource: 'oidc'`; (b) REST-profile fixture → rung `rest` lands via the exact
catalog path (fixture asserts the endpoint hit); (c) whoami-tool fixture → rung
`tool` lands, AND a fixture WITHOUT a matching tool name gets ZERO whoami calls
(fixture call-count); (d) identity-less fixture → fallback line; note set via IPC,
survives disconnect/reconnect, probed-vs-noted asserted as distinct DOM classes;
(e) a connected card with identity gets NO re-probe on the next heartbeat (fixture
call-count — the stability rule). Mutation-red ×2: break the allowlist match ((c)
must red); break the probed-beats-noted precedence ((d)-adjacent DOM assert must red).

## Guardrails
- No probe on the connect critical path; identity never delays CONNECTED rendering.
- The executor is catalog-driven — adding a provider's identity is a data PR, no code.

## Done when
TOOLWHO green with both mutation-reds; TOOLCRED/TOOLPULSE/CONNPURE green; a fresh
GitHub-fixture connect shows an email sourced `rest`.
