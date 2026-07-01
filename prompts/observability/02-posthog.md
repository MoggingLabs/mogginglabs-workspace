# 02 — PostHog (product analytics) — OPTIONAL, opt-in

**Prereq:** `00` green (`01` recommended). **Shared context:** `README.md` + `docs/adr/0005`.

> Optional. Only do this if we decide product analytics is worth the privacy tradeoff.
> It must be **opt-in** and must never weaken our "your data stays yours" positioning.

## Goal
Anonymous, explicit-event product analytics from the **main** process, behind the seam,
gated by `config.productAnalytics`.

## Steps
1. Install: `npm i posthog-node`. (Do **not** use `posthog-js` autocapture in the
   renderer — it conflicts with the privacy stance.)
2. **Main adapter** — in `src/main/telemetry.ts`, when `config.productAnalytics`:
   - `import { PostHog } from 'posthog-node'`; construct with project key + host.
   - Implement `captureEvent({ name, props })` -> `posthog.capture({ distinctId, event: name, properties: props })`.
   - `distinctId` = the anonymous local install id from step `00` (never email/provider identity).
   - `captureError` may stay Sentry-only; PostHog handles `captureEvent` (and `flush`).
3. **Event taxonomy:** define a small allowlist of dot.namespaced events
   (e.g. `app.launched`, `workspace.opened`, `agent.launched` with `props: { cli }`).
   Names and props are curated — **no** free-form or user/terminal content.
4. UI features that need to emit analytics call `getTelemetry().captureEvent(...)`; route
   to main if the renderer adapter is noop (either send over a `@contracts` telemetry
   channel to the main adapter, or run PostHog only in main and have UI forward events).
5. Ensure opt-out is real: `productAnalytics: false` -> construct no PostHog client, send nothing.

## Files
- `package.json` (deps)
- `src/main/telemetry.ts` (the ONLY `posthog*` importer)
- *(if UI emits)* a `@contracts` telemetry channel slice + a tiny forwarder in `src/main`
- `src/contracts/observability/telemetry.ts` (event shape)

## Definition of Done
- An opt-in test event (`app.launched`) reaches PostHog with an anonymous `distinctId`.
- With `productAnalytics: false` -> **no** PostHog client, **no** network calls.
- No PII, no terminal/prompt/code data in any event.

## Checks that must be green
- `npm run typecheck` -> exit 0
- `npm run build` -> succeeds
- Boundary: `posthog*` imported only in `src/main/telemetry.ts`
- Manual: opt-in event received; opt-out sends nothing
