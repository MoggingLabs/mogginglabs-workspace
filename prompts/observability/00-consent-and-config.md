# 00 — Consent & config surface

**Prereq:** none (the seam exists). **Shared context:** `README.md` + `docs/adr/0005`.

## Goal
Give the telemetry factories a real `TelemetryConfig` derived from **user consent** +
build environment, defaulting to **off**. No vendor SDKs yet — just the gate that later
steps read.

## Steps
1. Add a small settings source for consent (local, no account):
   - persist an anonymous install id (random UUID) + booleans `errorReporting`,
     `productAnalytics` locally (e.g. a JSON settings file in `app.getPath('userData')`,
     or reuse the Phase-1 SQLite store when it lands).
   - default everything **off** until the user opts in (first-run consent prompt or a
     Settings toggle — a minimal main-process default is fine for now).
2. Build `TelemetryConfig` in each factory:
   - `enabled = consent && !process.env.DO_NOT_TRACK`
   - `environment = app.isPackaged ? 'production' : 'development'`
   - `release = app version` (from `package.json` / `app.getVersion()`).
3. In `initMainTelemetry` / `initRendererTelemetry`: if `!config.enabled` -> keep
   `NoopTelemetry`; else construct the real adapter (added in 01/02). For now, still noop
   — just prove the gate selects correctly (log which path was taken in dev).

## Files
- `src/main/telemetry.ts`, `src/renderer/telemetry.ts` (read config, select adapter)
- `src/contracts/observability/telemetry.ts` (`TelemetryConfig` — extend if needed)
- a new settings module (main side), e.g. `src/backend/features/settings/` or `src/backend/core/settings/`
- renderer consent read: pass config to the renderer via a `@contracts` channel (add a `settings`/`telemetry` channel slice) — do not read files from the renderer.

## Definition of Done
- A single source of truth for consent + config; default OFF.
- Factories select noop vs (future) real adapter purely from config.
- `DO_NOT_TRACK` forces noop.

## Checks that must be green
- `npm run typecheck` -> exit 0
- Manual: with consent off (default) both factories install `NoopTelemetry`; flipping the
  flag selects the real path (still noop until 01/02).

## Guardrails
Renderer must not read settings files directly — get config over `@contracts` IPC
(respects sandbox + the layer boundaries).
