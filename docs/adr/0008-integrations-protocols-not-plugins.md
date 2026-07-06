# ADR 0008 — Integrations are protocols, not plugins

- **Status:** accepted (Phase 8/01, 2026-07-06)
- **Extends:** ADR 0002 (never broker provider auth) · ADR 0007/0007a/0007b
  (pointers, the write-only vault, web sessions) · companion to ADR 0005
  (telemetry: counts/booleans only)
- **Sources:** `docs/03-research-synthesis.md` (the wedge + the hardened
  posture), `docs/09-swarm.md` (humans own the review gate),
  `docs/13-browser.md` (§ "The session, honestly"),
  `prompts/phase-10/FINDINGS.md` (the Comet fork),
  `docs/research/2026-07-third-party-integrations.md`

## Context

Phase 8 connects the app outward: agents get the control plane, the dock
browser gets real (consented) sessions, pane events reach automation
platforms, services light up board cards, and the app registers MCP servers
across every hosted CLI. Each of those could be built as a plugin system —
third-party code in our process — or as protocols: data in, data out, over
surfaces we already trust. The product's two load-bearing assets decide it:
**rendering reliability** (the wedge — a torn terminal is an uninstall) and
the **hardened posture** (ADR 0002's "we broker nothing" identity). An
in-process plugin ecosystem attacks both at once; a protocol surface attacks
neither. This ADR codifies the eight stances every phase-8 lane builds on.

## Decision

**(a) No in-process plugin runtime.** No third-party JavaScript executes
inside the app's processes — not in the renderer, not in main, not in the
daemon. A plugin API would put arbitrary code on the compositor thread that
must never jank and inside the process that holds the vault handle
(docs/03's hardening synthesis: the renderer is sandboxed precisely so
nothing foreign runs there). Extensibility is real, but it is *protocol*
extensibility, below.

**(b) The extensibility surface is the control API + hooks + ONE
first-party MCP server.** `mogging` verbs (docs/06), per-CLI hooks, and
`bin/mogging-mcp.mjs` — which is a pure CLIENT of two authed local sockets
it does not own: the daemon socket (protocol v3, frozen) and the app
endpoint. Stdio JSON-RPC to the agent, nothing listens on TCP, no new wire
surface. Anything an integration can do, it does by speaking these
protocols from its own process.

**(c) Write tools grant nothing `mogging send` doesn't.** The server's
control-plane write tools map 1:1 onto verbs any agent can already run in
its pane; the per-workspace grant (default `'none'`) is **tool-catalog
hygiene against prompt injection** — keeping the pen out of a hijacked
model's tool list — not the security boundary. The reviewer gate stays THE
boundary (docs/09): `approve` is a human verb, **never a tool**, in no
catalog, dispatch map, or `tools/list` frame, ever. The contracts assert it.

**(d) Service adapters ride the user's own tool sessions.** Board chips and
watchers read services through the session the user's own CLI already holds
(`gh auth token` — in memory, one request, never persisted, logged, or
shown). Third-party service KEYS are POINTERS, extending ADR 0007 to
services: an env-ref, or a slot in the OS vault — never a literal in
configs, profiles, or the KV. App-held OAuth (the app itself as an OAuth
client) is **deferred behind its own future ADR**; the MCP lane covers the
user-facing need without us holding a token, and OAuth 2.1 refresh-token
rotation makes a shared app-held grant technically unsound anyway
(IMPLEMENTATION: the cross-agent answer).

**(e) Web sessions enter by consent-by-login only.** The agent web profile
is FINDINGS' Branch C: a dedicated persistent profile the user signs into
ON PURPOSE, inside the dock. Acting on a signed-in origin requires that
origin's explicit per-origin grant; reading is never gated; sensitive
origins (banking/mail/gov — `SENSITIVE_ORIGIN_PATTERNS`) refuse grants
entirely, and every act lands in the local trail. Inheriting the SYSTEM
browser's cookie stores is Branch B: it **reverses ADR 0002** and starts,
if ever, with its own ADR — `prompts/phase-10/FINDINGS.md` §4 is its map.
Until that ADR exists, no cookie-store read, no keychain touch, no import.

**(f) UI extensibility waits for MCP Apps.** If integrations ever render
custom UI, they do it post-v1 via the MCP Apps pattern (declarative,
sandboxed, protocol-delivered) — never npm packages loaded in-process.
Stance (a) is not renegotiated by a widget.

**(g) Outbound events are user-configured webhooks.** The event bridge
POSTs to URLs the user configures; nothing listens, ever. Webhook URLs are
SECRETS (Slack/Make embed tokens in the path): vault-held or env-ref, shown
masked. The payload is versioned and documented verbatim: ids and the short
note text the user's own `notify` carried — **never scrollback, diffs, page
content, or origins**. The bridge is a doorbell, not a message bus.

**(h) The custody rule.** Any secret in OUR custody rests as OS-vault
ciphertext or does not rest at all: a vault-unavailable machine gets
refusal or session-only behavior — **never a plaintext downgrade** (the
7/13 posture, applied pack-wide: vault service keys, webhook URLs,
agent-web cookie persistence). What the CLIs store after their OWN logins
is theirs — exactly as if the user ran them in a plain terminal (ADR 0002);
we neither read, copy, nor "fix" it. Docs state both halves plainly.

## Consequences

- Integrations ship as DATA over protocols: the tool catalog, grants,
  presets, trail, bridge, and service shapes live in
  `src/contracts/integrations/` — one catalog every consumer (dispatch,
  docs, smokes) derives from; growing it never touches dispatch code.
- The daemon protocol stays at v3 across the whole phase: the MCP server,
  grants, the bridge, and adapters are all app/server-side composition.
- We forgo a plugin marketplace and its ecosystem energy. The bet: an
  agency automates around n8n/Make/Zapier already — meeting them at the
  webhook and the MCP registry beats hosting their code.
- Every agent-initiated action on the user's behalf (web act, MCP write,
  bridge delivery) is attributable and locally reviewable (the trail) and
  invisible to telemetry (ADR 0005) — auditability without exfiltration.
- The one first-party server is a protocol citizen: any MCP client (a
  hosted CLI, MCP Inspector, an n8n workflow) speaks to it unmodified.
