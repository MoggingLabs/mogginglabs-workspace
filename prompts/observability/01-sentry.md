# 01 — Sentry (errors + native crashes)

**Prereq:** `00` green. **Shared context:** `README.md` + `docs/adr/0005`.

## Goal
Real error and crash reporting across both processes, scrubbed of sensitive data, with
readable stack traces — implemented as a `Telemetry` adapter behind the existing seam.

## Steps
1. Install: `npm i @sentry/electron` and (for sourcemaps) `npm i -D @sentry/vite-plugin`.
2. **Main adapter** — in `src/main/telemetry.ts`, when `config.errorReporting`:
   - `import * as Sentry from '@sentry/electron/main'`; `Sentry.init({ dsn, environment, release, ... })`.
   - Implement a `SentryTelemetry implements Telemetry` mapping `captureError` -> `Sentry.captureException`, `captureEvent` -> a breadcrumb or `captureMessage`, `addBreadcrumb`/`setContext`/`flush` -> Sentry equivalents.
   - Enable native crash reporting (crashpad is on by default in `@sentry/electron`).
3. **Renderer adapter** — in `src/renderer/telemetry.ts`, when `config.errorReporting`:
   - `import * as Sentry from '@sentry/electron/renderer'`; `Sentry.init({})` (it auto-forwards to main).
   - Same `SentryTelemetry` mapping. (Consider a shared adapter file imported by both, but keep the `@sentry/electron/main` vs `/renderer` entry points in their own factory.)
4. **Scrubbers (required):** set `beforeSend` and `beforeBreadcrumb` to drop console
   breadcrumbs and strip any message text that could contain file paths, commands, or
   env values. Do not send default PII (`sendDefaultPii: false`).
5. **Sourcemaps:** add `@sentry/vite-plugin` to `electron.vite.config.ts` (main + renderer
   builds) or upload via `sentry-cli` in CI, so stack traces de-minify.
6. **DSN** via env (e.g. `SENTRY_DSN`); a separate dev DSN or noop in development.

## Files
- `package.json` (deps)
- `src/main/telemetry.ts`, `src/renderer/telemetry.ts` (adapters — the ONLY `@sentry/*` importers)
- `electron.vite.config.ts` (sourcemap plugin), `electron-builder.yml` (ship symbols if needed)
- `src/contracts/observability/telemetry.ts` (reference the port shape)

## Definition of Done
- A deliberately thrown error in main and in the renderer both arrive in Sentry
  (or the dev DSN), with **de-minified** stack traces.
- Native crash produces a report.
- Payloads contain **no** terminal content, paths, env, or credentials (verify a sample event).
- With `errorReporting: false` / `DO_NOT_TRACK` -> nothing is sent.

## Checks that must be green
- `npm run typecheck` -> exit 0
- `npm run build` -> succeeds, sourcemaps emitted/uploaded
- Boundary: `@sentry/*` imported only in the two factory files
- Manual: forced error captured + scrubbed; disabled config sends nothing
