# Phase RestBridge — execution report

## 01 — ADR 0021 + the restTools schema (2026-07-24)

Landed DARK, data + validation only:

- **ADR 0021** (`docs/adr/0021-local-rest-bridge.md`): the house bridge, custody =
  ADR 0014 verbatim, tool explosion named + capped, writes ride the existing
  per-workspace write grant, OpenAPI is curator input never runtime truth, the
  Cloudflare motivation recorded verbatim from the survey.
- **Schema**: `restAuth` / `requiredPermissions` / `setupTokenUrl` / `restTools`
  (cap 12 via `maxItems`, snake_case ≤40-char names, typed params, per-tool
  `source`, pagination/responsePath shaping) in `catalog/schema.json` +
  `ProviderEntry` (`RestAuthSpec`, `RestToolParam`, `RestToolSpec`).
- **RESTSCHEMA rules** in `scripts/check-catalog.mjs` (same CATSCHEMA sweep row):
  unique snake_case names, https + no `${}` outside declared connectionConfig
  keys, path params must have `{slots}`, per-tool provenance, restAuth carriage
  named, requiredPermissions present, ≥1 read tool, non-GET must declare
  `readOnly` explicitly. Selftest grew 14 mutations (cap breach, unnamed source,
  loose interpolation, all-writes, dup/bad/long names, untyped param, missing
  auth/permissions, write-by-silence, unslotted path param, http endpoint) —
  validator gained `maxItems`/`maxLength` support to make the cap structural.
- **Projection untouched**: `presetFromProvider` ignores the block;
  `tests/unit/provider-catalog.test.ts` pins strip-vs-full equality per entry.
- **Dark row**: `posthog.json` carries 4 read tools (projects, insights,
  dashboards, feature flags) re-authored from PostHog's primary API docs with
  per-tool provenance. **Dev-verify DEFERRED to step 04**: endpoints, the
  `preset=mcp_server` prefilled key link, and the scope names are doc-authored,
  not yet exercised against a live key; the row's `verifiedAt` was NOT bumped.

Gate evidence: RESTSCHEMA selftest green (every mutation caught), live catalog
green (60 entries), unit suite green; cap + loose-interpolation mutations proven
biting (mutation-red both ways via the selftest harness).
