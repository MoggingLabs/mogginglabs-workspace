# Phase RestBridge — execution report

## 04 — Cards + Cloudflare (2026-07-24)

The user-visible payoff, indistinguishable on the surface:

- **The chooser learned the bridge**: a restTools row renders "Paste an API
  key" (ADR 0020 strings verbatim); the key form became the GUIDED PANEL —
  "Create your token ↗" opening the catalog's prefilled `setupTokenUrl`
  (openExternal), the `requiredPermissions` listed in the provider's own words
  ("This needs: … — nothing more."), the paste field, the over-scope fine print
  ("a scoped one is safer"), and the Library's honest line ("Runs on this
  machine against the provider's own API").
- **submitKey learned the route**: restTools rows prove against the MANDATORY
  catalog `verification` block (new RESTSCHEMA rule + `rest-no-verification`
  selftest mutation — no MCP handshake exists on this route), vault, stamp
  `✓ Connected · verified 0m ago` (`connectedVia:'key'` on the Connection
  meta records the user's actual method — `authKind` describes the catalog's
  primary), register the bridge row, fan the key into the env slot
  (one-paste-every-route). The verify engine treats `connectedVia:'key'` as
  key-route (verification-block re-verify, no url precondition) — additive,
  zero behavior change for existing connections.
- **The family key** (`submitFamilyKey` + the family-card method): rendered
  ONCE when ≥2 key-ready members share `restAuth`; one paste proves once and
  lights every member with its own bridge row. `MOGGING_REST_BREAK_FANOUT` is
  the mutation knob.
- **Authored rows** (re-authored from primary docs, per-tool provenance):
  cf-bindings (accounts/Workers/KV reads), cf-dns-analytics (zones, DNS reads,
  DNS create + cache purge as writes, DNS report), cf-graphql (one explicit
  readOnly:true POST analytics query), stripe (balance/customers/invoices/
  subscriptions/products reads) — each with apiKey method, restAuth,
  requiredPermissions, prefilled setupTokenUrl, verification, profile.
  **PENDING-VERIFY: the restTools blocks are doc-authored; live verification
  with a real token is the operator's step — `verifiedAt` was NOT bumped for
  any of them (it still stamps the earlier MCP-preset verification), and the
  Cloudflare permissionGroupKeys in the setupTokenUrls need the same live
  confirmation.** posthog's step-01 row already carried verification+profile
  and needed nothing.

Gate — **RESTCARDS** (app-boot, `MOGGING_RESTCARDS`; sweep now 198 = 169
app-boot + 29 static, GATECOUNT reconciled): (a) chooser + guided panel with
the exact spied setupTokenUrl; (b) refused key retained (SECRETFORMS law),
good key → `verified 0m ago`; (c) family one-paste, one card per surface,
both bridge rows; (d) curated tools/list through the real upstream; (e)
identity accountSource 'rest'; (f) heartbeat re-verifies with ZERO MCP traffic.
Mutation-reds live: the broken fan-out half-lights the family; a restTools row
without `verification` reds the shipped-row judge. Reconciliation on the same
bytes: TOOLCARDS, TOOLPULSE, TOOLWHO, TOOLSMILESTONE, SECRETFORMS, CONNPURE
(74), UNIT (208), CUSTODY, TOOLWORDS, RESTEXEC, RESTIMPORT (its judge fixture
gained the now-mandatory verification block), CATSCHEMA all green. Live-dev
proof: a CDP-driven dev instance showed the real Cloudflare family card with
"Paste an API key" and the guided panel (famUp/methodUp/panelUp all true).


## 03 — The OpenAPI curator (2026-07-24)

Specs in, DRAFTS out, humans decide:

- **`scripts/curate-rest-tools.mjs`** (node; JSON + YAML via the repo's existing
  `yaml` dep, no new dependency): menu mode lists every operation read-first
  (method, path, operationId, summary, param count, read/WRITE guess); `--pick`
  emits the draft `restTools` block to STDOUT only — snake_cased names, every
  description stamped `TODO-reword` (the agent-UX naming pass is forced), typed
  params mapped (path/query/body, required honored; header/cookie params and
  non-primitive body props deliberately dropped — curation decisions), verb-
  derived `readOnly:false`, per-tool `source` = spec URL + `#/paths/…` JSON
  pointer, the ≤12 cap refused at emit with the Speakeasy sentence. It never
  writes into `catalog/`; `--url` fetch is a convenience that no gate uses.
- **RESTSCHEMA's TODO rule**: a `TODO-reword` marker anywhere in a shipped row
  fails `check-catalog.mjs` (+ the `rest-draft-marker` selftest mutation —
  drafts cannot ship). New `--entry <file>` mode judges ONE composed entry with
  the same rules, which is how the gate judges curator output.
- **Curation checklist** appended to ADR 0021 (reword for agents, drop what an
  agent shouldn't do unattended, dev-verify before `verifiedAt`, stdout-only).
- **Fixture spec** `tests/fixtures/openapi-curator-fixture.json`: 20 ops
  (11 reads / 9 writes), path/query/body params, one 25-param search op.

Gate — **RESTIMPORT** (`scripts/check-restimport.mjs`, run_static; sweep now
197 = 168 app-boot + 29 static, GATECOUNT reconciled): (a) menu lists 20 ops
read-first; (b) a 4-pick draft fails the shipped-row judge ONLY on its
TODO-reword markers and passes clean once reworded; (c) a 13-pick refuses on
the cap; (d) provenance pointers name the spec + op; (e) writes emit
`readOnly:false`. Mutation-reds live on every run: `--test-disable-cap` makes
the 13-pick succeed, `--test-no-todo` strips the marker — both assertions
proven biting. Tooling isolation grep-proven: nothing under `src/` or `bin/`
references the curator.


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
