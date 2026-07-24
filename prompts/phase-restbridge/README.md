# Phase RestBridge — global API keys become agent tools, without the explosion

Sequenced prompts giving keyed REST APIs first-class tool cards, grounded in
`docs/research/2026-07-rest-bridge-survey.md` (READ IT FIRST in every step) and
building directly on the phase-tools architecture (ADR 0020 catalog, the status
engine, the identity ladder, the tool cards, the write grant). Same format as
`prompts/phase-tools/`: self-contained steps, pasteable as `/goal`, ≤4000 chars,
executed in order. The survey's verdict binds the pack:

**The bridge is OURS and LOCAL (custody unchanged: vaulted key, hold-and-proxy —
ADR 0014); the tools are CURATED DATA in the provider catalog (never a runtime
OpenAPI dump — tool explosion is the weakness this pack exists to not inherit);
the user sees the SAME tool card either way.**

## The product decisions (2026-07-24, user-driven, binding)

1. A provider with a keyed REST API gets a real **"Paste an API key"** method even
   when its hosted MCP is OAuth-only or nonexistent (Cloudflare is the poster
   child). One global key per provider; the one-paste-every-route law (phase-tools)
   applies.
2. **Curation is law.** Per service: a hard cap of 12 `restTools`, hand-curated
   (names/descriptions written for agents, not mirrored from the spec), read tools
   by default, provenance per tool. An OpenAPI spec is an INPUT to the curator
   script — never shipped whole, never fetched at runtime.
3. **Write tools ride the existing boundary**: a mutating REST tool is exactly as
   gated as an MCP write tool — the per-workspace write grant, nothing new.
4. **Endpoints are pinned.** The bridge executes catalog-pinned URLs with typed
   params only; an agent can never steer the bridge to an arbitrary URL.
5. **The card never speaks plumbing** (TOOLWORDS): a bridge-backed tool connects,
   verifies (status engine), names its account (identity ladder), scopes, and
   fixes exactly like an MCP-backed one.

## Strengths adopted → steps

- AWS-Labs-style **runtime bridge** (no codegen artifacts) → step 02
- Nango's **declarative metadata** (we already carry retry/verification/profile) → steps 01–02
- Activepieces' **typed, hand-curated actions** + prove-before-save → steps 01, 04
- Speakeasy's **curation doctrine** (small toolsets, agent-UX naming) → the cap in step 01, the curator in step 03

## Weaknesses killed by construction

- Tool explosion → the cap + curation law (RESTSCHEMA bites it)
- Cloud dependence (Composio/Gram) → everything local, key never leaves the vault
- Write-by-default → the write grant gates every mutating tool (RESTEXEC bites it)
- Arbitrary-URL execution → pinned endpoints only (RESTEXEC bites it)
- Spec-as-truth rot → provenance per tool + dev-verified dates (CATSCHEMA discipline)

## License lanes (binding)

Verbatim copying ONLY from MIT/Apache (openapi-mcp-generator, cnoe codegen, AWS
Labs openapi-mcp-server, FastMCP, Activepieces community pieces). Nango (ELv2) and
Speakeasy/Gram docs are ideas-only. Every `restTools` block is re-authored from the
provider's PRIMARY API documentation with a `source:` URL per tool.

## Gate policy (binding on every step)

Every new gate lands with a bite proof (mutation-red both ways where stated); every
existing gate touching this surface (TOOLCARDS, TOOLPULSE, TOOLWHO, TOOLCRED,
CONNPURE, TOOLWORDS, CATSCHEMA, the wording gates) is reconciled in the SAME commit
that moves its DOM/contract. Step 05 audits nothing was weakened.

## Sequence

| # | File | Gate |
|---|------|------|
| 01 | `01-adr-and-resttools-schema.md` | ADR 0021 + the `restTools` catalog schema + curation law; **RESTSCHEMA** |
| 02 | `02-the-bridge-executor.md` | The house bridge serves catalog REST tools (auth injection, retry, caps, pinning, write gate); **RESTEXEC** |
| 03 | `03-openapi-curator.md` | The curator: OpenAPI → DRAFT restTools blocks, capped + provenance-pinned; **RESTIMPORT** |
| 04 | `04-cards-and-cloudflare.md` | The key method on real cards; Cloudflare + majors authored + dev-verified; **RESTCARDS** |
| 05 | `05-write-gate-audit-and-milestone.md` | Write-grant proof, gate reconciliation, docs/14 §, composed milestone; **RESTMILESTONE** |
