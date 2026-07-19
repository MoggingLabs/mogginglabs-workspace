Stand up the robust backend's FOUNDATION — schema, migrations, config,
observability, and a local-run + test harness that lets every later gate
reach a REAL backend on loopback, offline. Not minimal: idempotency, an
audit log, and observability exist from the first commit, because
money-adjacent state has no forgiving version.

> **Reconciled (ADR 0019):** the backend is NOT a greenfield `server/`. It
> is new API routes + Neon migrations on the EXISTING website stack
> (`../MoggingLabs-Website`: Next.js + Neon + Vercel), which already runs
> migrations (`db/migrations/`, `scripts/migrate.mjs`, `validate-schema.mjs`),
> the `/api/t` collector, error logging, and Stripe. Read every `server/…`
> path below as its Next.js-route + Neon-migration equivalent; reuse the
> site's harness (its `test/`, its pg-ws proxy) instead of a new one.

## Steps
1. **The service skeleton** (new API routes in the website's Next.js app on
   Vercel — read `server/` per the banner): routing, a typed request/
   response layer, health + readiness endpoints, graceful shutdown, and
   config loaded from
   ENV per environment (`local` / `staging` / `prod`) — secrets NEVER
   committed, read at boot, absent-honest in `local`.
2. **The schema + migrations** (`server/db/migrations/`, SQL, forward-only,
   checked in): `accounts` (id ⇄ IdP subject), `subscriptions` (plan,
   status, MoR ids, current-period), `entitlements` (derived plan +
   features + limits), `devices` (deviceId thumbprint ⇄ account, per-plan
   cap), and an append-only `events` audit table (every webhook + issuance
   + revocation, immutable). Postgres for prod; a local SQLite/Postgres
   for gates — one migration runner, both targets.
3. **Robustness primitives from day one**: an `idempotency_keys` table +
   middleware (a repeated request is a no-op ack), request-id propagation,
   structured JSON logs to a free sink (Sentry/Logtail; no-op locally),
   rate-limiting on public routes, and input validation with typed
   refusals (junk → 4xx, never a 500 stack). No PII beyond email + ids in
   logs (ADR 0005 discipline extends to the server).
4. **Local-run + test harness** (`server/test/`): a one-command
   `server:dev` that boots the service on `127.0.0.1` against the local DB
   with a FAKE MoR delivery and a FAKE IdP subject — the substrate steps
   10–11 and the app-facing gates run on, zero external network. A vitest
   suite covering routing, config, migrations up/down, and the
   idempotency middleware.
5. **CI**: extend the site's CI (typecheck + migrate + test on a local DB);
   it does NOT touch the app sweep count. Document the deploy path
   (Vercel env matrix, Neon connection) as operator-action in CHECKLIST.

## Files
- `server/` (service, `db/migrations/`, `test/`) · `server/package.json` ·
  `.github/workflows/` (server-ci) · `docs/21-backend.md` (start the book:
  architecture, schema, robustness stance) · `CHECKLIST.md` (mark 09)

## Definition of Done
- `server:dev` boots on loopback against a local DB with zero external
  network; health/readiness answer; migrations run up AND down clean.
- The idempotency middleware + audit-log + typed-refusal primitives exist
  and are unit-tested (a replayed request is a proven no-op).
- `server-ci` green; no secret committed; config is absent-honest locally.
- `docs/21-backend.md` states the schema + robustness stance.

## Checks that must be green
- `server` typecheck → 0; `server` vitest green; migration up/down green;
  the app's own gate-count + static battery UNCHANGED (no app code moved).

## Guardrails
- Robust, not minimal — idempotency, audit log, and observability are not
  deferred; they are the foundation.
- The server is a separate package; it must not perturb the app build,
  bundle, or gate count.
- Secrets from ENV only, never committed; local runs are offline by
  construction.
