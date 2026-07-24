# 01 — ADR 0020 + the provider catalog: the foundation everything rides

Read `prompts/phase-tools/README.md` AND `docs/research/2026-07-integrations-oss-survey.md`
first. This step lays the data foundation; no UI moves yet.

## Goal
One declarative **provider catalog** becomes the single source of truth for every
integration fact the app needs — auth methods, identity fetchers, verification probes,
refresh quirks, retry metadata, scope descriptions, setup links — plus ADR 0020 and the
naming/IA spec. Survey lineage: Nango's providers.yaml taxonomy × Metorial's
per-method model, re-authored license-clean.

## Deliverables
1. `docs/adr/0020-tool-first-integrations.md` — the UX decisions (README list), the
   catalog-as-foundation principle (code consumes catalog; a new provider is a data PR),
   custody unchanged (ADR 0014/0002), the local-only-auth differentiator stated as a
   product promise, and the license lanes (re-author from primary docs; verbatim only
   from MIT/Apache). Appendices: the naming table (chooser labels, four card-level
   status tags, identity-line grammar — the 2026-07-23 wording decisions verbatim) and
   the IA spec (tool-card grid groups; detail view contents; Library keeps browse;
   matrix + vault cards demoted to power-user/audit views).
2. **The catalog** — `src/contracts/integrations/catalog/` (one JSON per service +
   `schema.json`), superseding presets.json fields incrementally (a migration shim
   keeps `McpPreset` consumers compiling until step 05 retires them). Per service:
   - `id`, `label`, `logo`, `categories`, `docs`, `setupGuideUrl` (Nango), typed docs
     links (Metorial), `source:` provenance URL **per entry** (binding).
   - `methods[]` — Metorial-style named auth methods, each: `kind`
     (`oauth` | `apiKey` | `cliOwned` | `none` — extensible enum, Nango's lesson),
     display name, rank, endpoints (`authorizationUrl`/`tokenUrl` or MCP discovery),
     `scopes[]` as `{scope,title,description}` (humanized), typed input fields
     (`{key,label,help,secret,required}` — Activepieces), `connectionConfig` fields
     with `${placeholders}` (generalizing needsBaseUrl), quirks
     (`scopeSeparator`, `authorizationParams`, `refreshUrl`, `tokenExpirationBuffer`).
   - `profile` — how to learn who you are: `{via: 'oidc'|'rest'|'tool', url|tool,
     paths: {id,email,name,imageUrl}}` (Metorial's getProfile as data; step 04 executes).
   - `verification` — declarative liveness probe `{method,endpoint,headers}` (Nango;
     step 03 executes) for key-auth; MCP services default to initialize+tools/list.
   - `retry` — `{atHeader, remainingHeader, errorCodes}` (Nango; the bridge proxy
     adopts it this step or step 02, whichever touches the proxy first).
   Populate the ~15 majors first (GitHub, Google×4, Slack, Linear, Sentry, Vercel,
   Supabase, Notion, Stripe, PostHog, Cloudflare, Atlassian, GitLab); the remaining
   presets migrate mechanically with minimal entries.
3. `scripts/check-catalog.mjs` — **CATSCHEMA** static gate: every catalog file
   validates against schema.json; every entry has `source:` provenance; every OAuth
   method has humanized scopes; ids unique; no secret-shaped literal anywhere in the
   catalog (entropy + known-prefix scan). Wire into the static battery (sequentially —
   the NPMCONFIG lesson). Bite proof: a fixture entry violating each rule must fail.
4. `scripts/check-tool-wording.mjs` — **TOOLWORDS**: bans plumbing jargon (`MCP`,
   `server`, `stdio`, `transport`, `drift`, `apply`, `adopt`, `preset`, `Route`) in
   user-visible string literals under `src/ui/features/settings/`, allowlist for
   fine-print custody lines + the Library's advanced fold. Prove it bites on TODAY'S
   copy, then wire **report-only** (LAUNCHAUDIT pattern) until steps 05–06 flip it.

## Done when
ADR 0020 + catalog schema + majors landed; CATSCHEMA green with bite proofs;
TOOLWORDS biting-but-report-only; sweep green; no user-visible change.
