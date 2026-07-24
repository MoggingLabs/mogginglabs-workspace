# Phase RestBridge — execution report

## 02 — The bridge executor (2026-07-24)

The house bridge serves curated `restTools` as real MCP tools:

- **Pure core** (`backend/features/integrations/rest-bridge.ts`): tools/list
  verbatim from the catalog (typed inputSchema per param); tools/call = typed
  validation (unknown/missing/mistyped → typed refusal, zero requests), pinned
  endpoint resolution (`${config}` from the STORED connection only, path params
  encodeURIComponent'd per `{slot}`, `://`/`..` into a path slot refused),
  restAuth injection (header scheme or query param — the key dies with the
  frame), catalog `retry` grammar (one retry, provider-header delay, capped),
  same-origin `next`-link pagination ≤3 pages with an honest more-pages line,
  ~50KB response cap with an honest truncation sentence, provider failures as
  status + 200-char key-scrubbed excerpt (never headers, never the key).
- **Wiring** (`mcp-endpoint.ts handleConnectionRpc`): the KEY route serves the
  bridge when the row declares restTools (`restBridgeUpstream` — token still
  from `accessTokenFor`, the ONE decryption point, unchanged); OAuth-connected
  services keep the MCP proxy path untouched (the guardrail). The connection
  shim (`bin/mogging-connection.mjs`) now passes pane identity (same rule as
  mogging-mcp.mjs) so the write gate can resolve the calling workspace.
- **Write gate**: `resolveWriteAllGranted` in `main/integrations.ts` — the SAME
  `getIntegrationsGrant` seam MCP write tools ride; `readOnly:false` refuses
  without `writeTools:'all'`, naming the switch; fail-closed on paneless callers.
- **Status/identity ride free, ZERO engine changes**: `verifyOne` already
  prefers the catalog `verification` block for key-auth and the identity ladder
  already reads `profile` — this step's diff touches neither
  `connection-pulse`/status-engine nor identity code (grep-verifiable).
- **Telemetry**: `restBridgeStatsForSmoke` counters (lists/calls/refusals) —
  counts only, never a tool or service name (ADR 0005).

Gate — **RESTEXEC** (`scripts/restexec-pure-smoke.ts`, run_static row, sweep
now 196 = 168 app-boot + 28 static, GATECOUNT reconciled): (a)–(f) all green
against a fixture REST API; mutation-reds run LIVE — `_testDisableWriteGate`
lands the ungranted write at the fixture and `_testDisablePinning` lands the
traversal, proving both zero-hit assertions bite. TOOLCRED, CONNPURE (74),
TOOLPULSE, UNIT (208), LINT, CUSTODY, CATSCHEMA green on the same bytes.
(Worktree note: TOOLPULSE needed `build/node-helper` + the device-key Release
dir copied in — the known worktree artifact trap, not a product failure.)


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
