# ADR 0005 — Observability (Sentry + optional PostHog) via a vendor-agnostic port

- **Status:** Accepted (2026-07-01). Seam shipped; adapters gated behind `prompts/observability/`.
- **Context:** We need error/crash reporting (Sentry) and possibly product analytics
  (PostHog), wired so (a) features never couple to a vendor, (b) we don't retrofit
  telemetry calls across the codebase later, and (c) it never violates our privacy
  positioning (local-first, no account, your data stays yours).

## Decision

**Wire the seam, not the vendor.**

- A vendor-agnostic **`Telemetry` port** lives in `@contracts`
  (`src/contracts/observability/telemetry.ts`).
- Each side has a **settable singleton** defaulting to `NoopTelemetry`
  (`src/backend/core/telemetry`, `src/ui/core/telemetry`). Features call
  `getTelemetry()` and never import a vendor SDK.
- **Real adapters are constructed only at the composition roots** —
  `src/main/telemetry.ts` (main) and `src/renderer/telemetry.ts` (renderer). Vendor SDK
  imports are confined to those two files. Swapping or disabling a vendor is a one-file
  change.
- **Errors/crashes → Sentry** via `@sentry/electron` (one SDK covering main + renderer +
  native crashpad; it auto-bridges renderer events to main).
- **Analytics → PostHog, optional and opt-in**, via `posthog-node` from the **main**
  process, **explicit events only, no autocapture**. `posthog-js` in the renderer is
  discouraged (autocapture + web-style tracking conflicts with our privacy stance).
- **Consent + config gate** (`TelemetryConfig`): telemetry is **opt-in**; default
  `enabled: false`. Adapters are built only when consent + config allow; otherwise noop.

## Privacy guardrails (hard rules)

1. Telemetry **NEVER** receives terminal/PTY output, prompt text, code, file
   contents/paths, environment variables, or provider credentials.
2. Event props are **primitives only** (`TelemetryProps`) — the port shape discourages
   dumping sensitive blobs.
3. The Sentry adapter **must** set `beforeSend` / `beforeBreadcrumb` scrubbers (strip
   message bodies that may contain paths/commands; drop console breadcrumbs).
4. **No PII.** Identify by a locally-generated anonymous install id only — never tied to
   provider identity or email.
5. **Opt-in**, with a visible setting and an easy off switch; honor `DO_NOT_TRACK`.

## Consequences

- Features stay vendor-agnostic and testable (fake `Telemetry`); the seam is live now
  (noop). Turning it on = the `prompts/observability/` work, **no feature refactor**.
- Sourcemaps must be uploaded for readable Sentry stack traces (electron-vite build +
  `@sentry/vite-plugin` or `sentry-cli`).
- One demonstrated use already exists: `PtyService.spawn` reports spawn failures via
  `getTelemetry().captureError(...)` with structured, primitive context only.

## How to emit telemetry (playbook)

- **Backend feature:** `import { getTelemetry } from '../../core/telemetry'` then
  `getTelemetry().captureError(err, { feature, op })` or
  `getTelemetry().captureEvent({ name: 'workspace.opened', props: { paneCount } })`.
- **UI feature:** `import { getTelemetry } from '@ui/core/telemetry'` (or relative) and
  the same calls.
- Never pass terminal/prompt/code/credential data. Names are dot.namespaced.
