# ADR 0020 — Tool-first integrations on a declarative provider catalog

Date: 2026-07-24 · Status: accepted · Owner: integrations
Supersedes nothing; builds on ADR 0014 (app-held connections) and ADR 0002 (never
broker provider logins), both of which stand word for word. Grounded in the OSS survey
`docs/research/2026-07-integrations-oss-survey.md` and the phase pack
`prompts/phase-tools/` (the 2026-07-23 UX decisions, recorded below verbatim in intent).

## Decision, in one paragraph

The unit of the integrations surface is the TOOL, not the plumbing that connects it.
Every fact the app needs about a provider — its auth methods, identity fetcher,
liveness probe, refresh quirks, retry metadata, humanized scopes, setup links — lives
in one declarative **provider catalog** (`src/contracts/integrations/catalog/`), and
code consumes the catalog. Adding or correcting a provider is a data PR with cited
provenance, not a code change. The UI never speaks mechanism (MCP, server, stdio,
transport, drift); it speaks outcomes.

## The UX decisions (2026-07-23, binding)

1. Clicking a tool that is not connected opens a **chooser** of its connect methods,
   ranked, in outcome wording: **"Sign in with your browser"** (app-held OAuth),
   **"Paste an API key"**, **"Let Claude Code sign in itself (advanced)"** (CLI-owned
   config). Each carries a one-line custody subtitle in fine print. Mechanism words
   never appear at top level.
2. **Claude Code first.** Codex and Gemini render greyed "coming soon", zero
   interactive pixels. Backend three-CLI truth is untouched; presentation filters only.
3. **Identity.** The card answers "as WHO?": probed identity first (the catalog's
   `profile` spec: OIDC → REST whoami → allowlisted MCP whoami tool), a **user-entered
   account note** where no door exists, and the honest fallback line otherwise.
   Probed beats noted; a note is never presented as proof.
4. **Store/inventory split stays.** The Library is browse; Settings § Integrations is
   the tool-card inventory.
5. **Workspace scoping lives inside each tool's detail.** The matrix card is demoted
   to a power-user overview; the vault card stays the audit view.
6. **Status is real verification, never inference**, on three triggers: a background
   heartbeat (~15 min, budgeted, jittered), page entry (one poll), and pre-launch
   (bounded ~2s; a slow probe never delays a pane). Card-level status tags are exactly
   four: `✓ Connected · verified {n}m ago` · `Needs attention` · `Not connected` ·
   `Connecting…`. Failures raise the attention port app-wide; network-down flips
   nothing.
7. **No Claude Code login card** on this page — tools only (ADR 0002).
8. **The Route B drift machinery becomes a silent reconciler**: healthy is invisible;
   drift renders as `Needs attention → Fix` with the diff preview kept; writes happen
   only on the user's click. The apply/adopt/forget vocabulary leaves the UI.

## The catalog-as-foundation principle

One JSON per service, validated by `schema.json` and the CATSCHEMA gate. Per service:
`methods[]` (named auth methods with kind, rank, endpoints or MCP discovery, humanized
scopes `{scope,title,description}`, typed input fields, `connectionConfig` fields,
quirks), `profile` (how to learn who you are, as data), `verification` (declarative
liveness probe for key-auth; MCP services default to initialize + tools/list),
`retry` (rate-limit-aware retry metadata), `setupGuideUrl` and typed docs links, and a
**`source:` provenance URL on every entry** — the Nango scopes-file discipline: every
fact names where it came from. Survey lineage: Nango's providers.yaml taxonomy ×
Metorial's per-method model, **re-authored** — see license lanes.

Consumers arrive by phase-tools step: step 02 (credential core) reads methods/quirks/
retry; step 03 (status engine) reads verification; step 04 (identity) reads profile;
step 05 (tool cards) renders methods, scopes, and setup links, and retires the
`McpPreset` shim. Until then `presets.json` remains the runtime source and the shim
keeps existing consumers compiling — the catalog lands dark, gate-guarded.

## The product promise (differentiator, stated)

Sign-in runs entirely on this machine: the browser consent, the loopback redirect, the
keychain ciphertext. No vendor cloud of ours ever sees a token (contrast: the surveyed
"open-source" OAuth layers that phone home to a hosted API). Continuous re-verification
("verified {n}m ago") is ours alone among the surveyed projects — validate-once-then-
trust is a named weakness we do not inherit.

## License lanes (binding)

Verbatim copying only from MIT/Apache sources (mcp-s-oauth, Klavis, Activepieces
community pieces, Composio SDK, modelcontextprotocol/servers). Nango (ELv2) and
Metorial (FSL) are ideas-only: every catalog entry is re-authored from the provider's
own primary documentation, and its `source:` cites that documentation — never the
licensed catalogs.

## Appendix A — the naming table

| Where | String |
|---|---|
| Chooser, oauth | Sign in with your browser |
| Chooser, apiKey | Paste an API key |
| Chooser, cliOwned | Let Claude Code sign in itself (advanced) |
| Custody subtitle, oauth | Held by this app, encrypted by your OS keychain — never written into any CLI config. |
| Custody subtitle, apiKey | Pasted once, encrypted by your OS keychain, referenced as ${NAME}. |
| Custody subtitle, cliOwned | Claude Code holds its own credential; the app brokers nothing on this route. |
| Status tags (exactly four) | ✓ Connected · verified {n}m ago · / Needs attention / Not connected / Connecting… |
| Identity, probed | {email or name} |
| Identity, noted | {note} · noted by you |
| Identity, neither | Signed in — this provider doesn’t share an account name. (+ "Add a note…") |
| Reconciler, edited | Claude Code’s config for this tool was edited by hand. → **Fix** (secondary: keep my edit) |
| Reconciler, missing | Claude Code’s config for this tool was removed outside the app. → **Fix** (secondary: forget this tool on Claude Code) |
| Banned at top level | MCP, server, stdio, transport, drift, apply, adopt, preset, Route A/B |

## Appendix B — the IA spec

Settings § Integrations: overview band → **tool-card grid** in groups (Connected →
Needs attention → Not connected-but-known) with filter → power-user matrix card
(shrunk Workspace tools) → vault card (audit view) → privacy block. A card opens the
tool DETAIL: status + Check + Disconnect · identity row + note editor · the chooser
(when not connected) · workspace checkboxes · `${VAR}` key slots · what-it-can-do
(humanized scopes, tool list). The Library overlay keeps browsing (services grid +
the advanced CLI-owned fold with registry search/import), reading the same catalog.
