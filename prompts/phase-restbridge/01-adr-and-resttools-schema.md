# 01 — ADR 0021 + the restTools schema: curated tools as data

Read the pack README + `docs/research/2026-07-rest-bridge-survey.md` first.

## Goal
Write the ADR and land the schema DARK: a provider catalog row may declare curated
`restTools` — the declarative, capped, provenance-pinned tool set our house bridge
will serve over the provider's plain REST API. No executor yet; data + validation
only, so the shape is gate-hardened before a single request flows.

## Deliverables
1. **ADR 0021 — the local REST bridge.** One page: the tool stays the unit (ADR
   0020); the bridge is OUR house server executing CATALOG-pinned REST endpoints
   with vault-held credentials (custody = ADR 0014 verbatim, one decryption point);
   tool explosion is the named enemy (survey) and the cap is the cure; write tools
   ride the existing per-workspace write grant; an OpenAPI spec is curator INPUT,
   never runtime truth. Record the Cloudflare motivation verbatim.
2. **Schema** (`catalog/schema.json` + `ProviderEntry`): optional `restTools`:
   - per tool: `name` (agent-facing, snake_case, ≤40 chars), `description`
     (one sentence, written for an agent choosing tools), `method`, `endpoint`
     (https, may carry `${connectionConfig}` placeholders ONLY — never free
     interpolation), `params[]` (typed: key, in: path|query|body, type, required,
     description), `readOnly: boolean` (default true; `false` marks a WRITE tool),
     `pagination?` (cursor/page param names + item path), `responsePath?` (JSON
     path shaping the answer), `source` (per-tool provenance URL, REQUIRED);
   - per service: `restAuth` (how the key rides: header name/scheme or query
     param — one declaration, reused by every tool), `requiredPermissions[]`
     (the provider's own permission names the curated set needs — least
     privilege as data), and `setupTokenUrl` (a PRE-FILLED token-creation link:
     Cloudflare's official template URLs carry permissionGroupKeys+name; GitHub
     prefills scopes/name/expiry on /settings/tokens/new and fine-grained
     /settings/personal-access-tokens/new — the 9-step provider ceremony
     becomes click → Create → copy);
   - **THE CAP: ≤12 tools per service** (schema-enforced `maxItems`), and ≥1 must
     be `readOnly` — a service whose only tools are writes is a curation smell.
3. **CATSCHEMA extension → RESTSCHEMA rules** in `check-catalog.mjs`: validate the
   block (names snake_case + unique per service, endpoint https + no `${}` outside
   declared connectionConfig keys, params typed, per-tool `source`, the cap, the
   read-tool floor); extend `--selftest` with one mutation per new rule (cap
   breach, unnamed source, loose interpolation, all-writes).
4. **Type + projection untouched**: `restTools` is invisible to `McpPreset` — the
   projection ignores it (the unit suite asserts no drift).
5. Land one REAL dark row to hold the schema honest: `cloudflare-api.json`? NO —
   the cf family already exists; instead add `restTools` to ONE existing key-auth
   row (posthog: 3–4 read tools from its primary API docs, provenance per tool,
   dev-verify deferred to step 04 and marked so).

## Gate — RESTSCHEMA
`check-catalog.mjs` (extended; keeps the CATSCHEMA sweep row, +selftest): every
rule above catches its fixture mutation; the live catalog passes; the posthog dark
row validates. Mutation-red ×2 minimum: the cap and the loose-interpolation rules
proven biting.

## Guardrails
- Data lands DARK: no runtime reads `restTools` this step (grep-proven in review).
- License lanes: every tool re-authored from the provider's primary docs.

## Done when
RESTSCHEMA green (selftest + live); ADR 0021 committed; unit suite still pins the
projection; sweep green vs baseline.
