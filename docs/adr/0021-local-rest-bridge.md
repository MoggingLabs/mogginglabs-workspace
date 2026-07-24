# ADR 0021 — The local REST bridge: curated catalog tools over plain REST APIs

Date: 2026-07-24 · Status: accepted · Owner: integrations
Builds on ADR 0020 (tool-first integrations, the provider catalog) and ADR 0014
(app-held service connections), both of which stand word for word. Grounded in
`docs/research/2026-07-rest-bridge-survey.md` and `prompts/phase-restbridge/`.

## Decision, in one paragraph

The tool stays the unit (ADR 0020). A provider whose plain REST API takes a global
key — even when its hosted MCP is OAuth-only or nonexistent — gets first-class agent
tools through **our house bridge**: a local server that executes **CATALOG-pinned
REST endpoints** declared as curated `restTools` data on the provider's catalog row.
Custody is ADR 0014 verbatim: the key is pasted once, encrypted by the OS keychain,
and decrypted at exactly one point — the bridge's request injection; it never enters
a CLI config, a tool schema, or an agent's context. The user sees the SAME tool card
either way; whether a tool rode the provider's MCP or our bridge is plumbing the UI
never speaks.

## The motivation, verbatim

From the survey: "Cloudflare's hosted MCP servers are OAuth-only, yet one account
API token can reach everything via `api.cloudflare.com`." A real user holds a key
that reaches everything, and we offer no honest "Paste an API key" door for it.

## The named enemy: tool explosion, and the cap that cures it

The survey's one deciding weakness: auto-converting a 200-endpoint OpenAPI spec
shoves 40–80k tokens of schema into the agent's context, degrades reasoning, and
makes tool selection worse. Every naive generator inherits this; the managed
platforms exist largely to sell the curation back. So curation is LAW here:

- **≤12 tools per service** — schema-enforced (`maxItems`), no exceptions.
- **≥1 tool must be read-only** — a service whose only tools are writes is a
  curation smell the gate rejects.
- Names (snake_case, ≤40 chars) and one-sentence descriptions are **written for an
  agent choosing tools**, never mirrored from a spec.
- **Provenance per tool**: every tool carries its own `source` URL naming the
  provider's primary API documentation it was re-authored from (license lanes:
  Nango/Speakeasy content is ideas-only).

An **OpenAPI spec is curator INPUT, never runtime truth**: the step-03 curator
script may read a spec to DRAFT `restTools` blocks, but the catalog ships only the
hand-curated result, and the bridge never fetches or serves a spec at runtime.

## Pinned endpoints, typed params

The bridge executes only endpoints pinned in the catalog. An endpoint is `https://`
and may interpolate `${connectionConfig}` placeholders ONLY (declared per-method
config such as an instance URL) — never free interpolation, never an agent-supplied
URL. Every parameter is typed data (`key`, `in: path|query|body`, `type`,
`required`, `description`); path params fill declared `{slots}` in the pinned URL.

## Writes ride the existing boundary

A mutating REST tool (`readOnly: false` — and any non-GET tool must declare its
stance explicitly) is exactly as gated as an MCP write tool: the per-workspace
write grant, nothing new invented.

## Least privilege as data, and the guided key

Per service the row declares `restAuth` (how the key rides: header name/scheme or
query param — one declaration reused by every tool), `requiredPermissions[]` (the
provider's own permission names the curated set needs), and `setupTokenUrl` — a
PRE-FILLED token-creation link (Cloudflare's official template URLs carry
permissionGroupKeys+name; GitHub prefills scopes/name/expiry on
`/settings/tokens/new` and fine-grained `/settings/personal-access-tokens/new`),
collapsing the 9-step provider ceremony to click → Create → copy.

## The curation checklist (binding on every `restTools` block)

The curator (`scripts/curate-rest-tools.mjs`) reads an OpenAPI document and
emits DRAFT blocks to stdout — capped, typed, provenance-stamped, and marked
`TODO-reword` on every drafted name/description. The spec is INPUT; a human
finishes the job. Before a block ships:

1. **Reword every name and description** for an agent choosing among tools —
   never the spec's own words. A `TODO-reword` marker anywhere in the catalog
   is a RESTSCHEMA failure: drafts cannot ship, by gate.
2. **Drop anything an agent should not do unattended** — the cap is a ceiling,
   not a target; fewer, better-worded tools beat coverage.
3. **Verify each tool live with a real key** before stamping `verifiedAt` —
   a doc-authored endpoint is a claim, not a fact.
4. The curator never writes into `catalog/` — stdout only; the human pastes,
   rewords, and CATSCHEMA/RESTSCHEMA judge the result.

## Sequencing

The schema lands DARK (this step): data + validation only, RESTSCHEMA-gated inside
`scripts/check-catalog.mjs`; no runtime reads `restTools` until step 02's executor.
The `McpPreset` projection ignores the new fields — pinned by the unit suite.
