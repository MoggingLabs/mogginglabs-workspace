# REST-to-MCP bridge — the OSS survey addendum (2026-07-24)

Companion to `2026-07-integrations-oss-survey.md`, scoped to ONE question: how does
the ecosystem turn a provider's plain REST API (a global API key, no MCP endpoint)
into tools an agent can call — and what should we adopt or refuse? Motivated by a
real user ask: Cloudflare's hosted MCP servers are OAuth-only, yet one account API
token can reach everything via `api.cloudflare.com`.

## The art

| Project | Shape | License lane | Verdict |
|---|---|---|---|
| **openapi-mcp-generator** (harsha-iiiv) | CLI: OpenAPI 3.0+ → standalone TS MCP server that proxies the REST API, validating structure + security | MIT — copyable | The generator pattern, proven; but it ships EVERY endpoint |
| **openapi-mcp-codegen** (cnoe-io) | OpenAPI → templated Python MCP package | Apache — copyable | Same pattern, same blindness |
| **openapi-mcp-server** (AWS Labs) | Runtime bridge: point at a spec, get tools | Apache — copyable | Runtime (no codegen step) — closest to our house-bridge shape |
| **FastMCP OpenAPI import** | Framework: spec → MCP components at runtime | Apache — ideas | Confirms runtime conversion is routine |
| **Tyk api-to-mcp** | Gateway-flavored spec→MCP | OSS | Same family |
| **Speakeasy / Gram** | Managed platform + the best WRITTEN doctrine: toolsets, curation | Commercial — ideas only | The doctrine matters more than the code |
| **Nango actions/proxy** (ELv2) | Declarative per-provider REST actions + proxy w/ retry metadata | Ideas only | We already adopted its retry grammar (phase-tools/02) |
| **Activepieces pieces** (MIT core) | Hand-curated typed actions per provider, prove-before-save auth | Copyable (community pieces) | The CURATED-per-provider counterexample to spec dumping |

## The one weakness that decides the architecture

**Tool explosion.** Speakeasy's production write-ups and the cited academic result
agree: auto-converting a 200-endpoint spec shoves 40–80k tokens of schema into the
agent's context, degrades reasoning, and makes tool selection worse — "effective API
design does not automatically create effective MCP servers"; curation into small,
purpose-focused toolsets is the load-bearing practice. Every naive generator above
inherits this; the managed platforms exist largely to sell the curation back.

Sources: [Speakeasy: generate MCP from OpenAPI](https://www.speakeasy.com/blog/generate-mcp-from-openapi) ·
[benefits, limits, best practices](https://www.speakeasy.com/mcp/tool-design/generate-mcp-tools-from-openapi/) ·
[less is more](https://www.speakeasy.com/mcp/tool-design/less-is-more) ·
[lessons from 50+ production servers](https://www.speakeasy.com/blog/generating-mcp-from-openapi-lessons-from-50-production-servers/) ·
[openapi-mcp-generator](https://github.com/harsha-iiiv/openapi-mcp-generator) ·
[cnoe-io/openapi-mcp-codegen](https://github.com/cnoe-io/openapi-mcp-codegen) ·
[AWS Labs openapi-mcp-server](https://awslabs.github.io/mcp/servers/openapi-mcp-server) ·
[FastMCP OpenAPI](https://gofastmcp.com/integrations/openapi)

## The verdict that binds `prompts/phase-restbridge/`

- **Adopt**: the runtime-bridge shape (AWS Labs), executed by OUR house bridge —
  custody unchanged (vaulted key, hold-and-proxy, ADR 0014); Nango's declarative
  metadata (we already carry `retry`/`verification`/`profile` per provider);
  Activepieces' hand-curated typed actions; Speakeasy's curation doctrine as LAW
  (a hard cap per service, curated names/descriptions, read tools by default).
- **Kill by construction**: tool explosion (the catalog ships CURATED `restTools`
  blocks — an OpenAPI spec is an INPUT to a curator script, never a runtime source);
  cloud dependence (everything local); write-by-default (the existing per-workspace
  write grant gates every mutating tool); unpinned endpoints (tools name
  catalog-pinned URLs — the bridge never executes an agent-supplied URL).
- **The UX prize**: providers whose hosted MCP is OAuth-only (Cloudflare) or absent
  gain an honest "Paste an API key" method on the SAME tool card — the user never
  learns whether a tool rode the provider's MCP or our REST bridge.
