# Phase Tools — tool-first integrations, rebuilt on the proven architecture

Sequenced prompts rebuilding integrations around the TOOL, grounded in the OSS survey
(`docs/research/2026-07-integrations-oss-survey.md` — READ IT FIRST in every step). Same
format as `prompts/phase-1..11/` (self-contained steps, pasteable as `/goal`, ≤ 4000
chars). Execute in order. The survey's verdict binds the pack: **ADR 0014 hold-and-proxy
is the proven shape — we rebuild the feature on a declarative provider catalog, we do
not change custody.**

## The UX decisions (asked and answered 2026-07-23 — unchanged, binding)

1. Click a tool → chooser of its connect methods, ranked, **outcome wording** ("Sign in
   with your browser" / "Paste an API key" / "Let Claude Code sign in itself
   (advanced)"). No MCP/server/stdio/transport words at top level.
2. Claude Code only this phase; Codex/Gemini greyed "coming soon", zero handlers.
3. Identity: aggressive probing + graceful no-name fallback + a **user-entered account
   note** (probed beats noted; a note is never presented as proof).
4. Store/inventory split stays (Library = browse; Settings = tool-card inventory).
5. Workspace scoping lives inside each tool's detail; matrix card = power-user view.
6. Status freshness: background heartbeat (~15 min) + page entry + pre-launch verify;
   failures raise attention app-wide. Always real verification, never inference.
7. No Claude Code login card on this page (ADR 0002 untouched).
8. Route B drift → silent reconciler: "Needs attention → Fix", writes only on click.

## Strengths adopted (from the survey — each lands in a named step)

- **Nango**: declarative provider taxonomy (auth modes incl. MCP-native OAuth),
  per-provider `verification` probes, retry/rate-limit metadata, refresh discipline
  (per-connection lock + margin + failure cooldown + budgeted sweep), setup-guide URLs,
  provenance comments per catalog row. → steps 01, 02, 03
- **Metorial**: multiple named auth methods per service; `getProfile →
  {id,email,name,imageUrl}` per method; humanized scopes ({title,description,scope});
  refresh tolerating non-rotating providers; typed docs links. → steps 01, 04, 05
- **mcp-s-oauth (MIT)**: minimal connector core (4 mandatory fields, quirks optional);
  **token normalization at exchange** into one canonical credential shape. → step 02
- **Activepieces (MIT pieces)**: **prove-before-save** — every method's submit runs a
  declared validator; typed auth input fields with display names + help text. → 02, 05
- **Klavis (Apache)**: reference corpus for per-service MCP behavior + env-var naming;
  tool-design doctrine for our house verbs. → consulted throughout
- **Composio**: the `authorize → wait → live` narrative only. Nothing else.

## Weaknesses killed (by construction, not by patch)

- Cloud-dependent OAuth (Klavis) → **all auth local**: PKCE + loopback + keychain.
  Named on the page as a differentiator ("your sign-in never touches our servers").
- Validate-once-then-trust (Activepieces) → continuous re-verify (TOOLPULSE) stays OUR
  edge — no surveyed project has it.
- Server-first footprint (Nango/Metorial) → catalog + engines run in main; no new
  processes, nothing on the boot critical path (invariant I7).
- Non-uniform token responses as scattered special cases → one normalization seam.
- Blind proxy retries → catalog retry metadata drives the bridge.
- Closed credential runtime (Composio) → custody stays ADR 0014; telemetry stays
  counts/booleans (ADR 0005).

## License lanes (binding)

Verbatim copying ONLY from MIT/Apache sources (mcp-s-oauth, Klavis, Activepieces
community, Composio SDK, modelcontextprotocol/servers). Nango (ELv2) and Metorial
(FSL) are ideas-only: **every catalog entry is re-authored from the provider's primary
docs**, with a `source:` provenance URL per entry (the Nango scopes-file pattern).

## Gate policy (binding on every step)

Every new gate lands with a **bite proof** (mutation-red both ways where stated); every
EXISTING gate touching this surface (CONNPURE, CONNLIVE, SETINTEG, MCPCAT, AUTHRUNNER,
integux, MUTATIONRACE, SECRETFORMS, the wording gates) is reconciled in the SAME commit
that moves its DOM/contract — the sweep never goes red between commits. Step 07 audits
that no gate was silently weakened.

## Sequence
| # | File | Gate |
|---|------|------|
| 01 | `01-adr-and-catalog-foundation.md` | ADR 0020 + the provider catalog schema + naming/IA; **CATSCHEMA** + **TOOLWORDS** |
| 02 | `02-credential-core.md` | Canonical credentials, normalization, refresh discipline, prove-before-save; **TOOLCRED** |
| 03 | `03-status-engine.md` | Heartbeat + entry + pre-launch verify, declarative verification probes; **TOOLPULSE** |
| 04 | `04-identity.md` | Catalog-driven getProfile ladder + account note; **TOOLWHO** |
| 05 | `05-tool-cards.md` | Tool cards + detail + chooser (methods/scopes/setup links from catalog); **TOOLCARDS** |
| 06 | `06-silent-reconciler.md` | Drift → "Needs attention → Fix"; **TOOLFIX** |
| 07 | `07-gate-reconciliation-and-milestone.md` | Existing-gate audit, CC-first polish, docs/14, composed milestone; **TOOLSMILESTONE** |
