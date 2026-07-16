# ADR 0014 — App-held service connections

- **Status:** Accepted (2026-07-14)
- **Supersedes:** ADR 0008 stance **(d)**, which deferred exactly this behind "its own
  future ADR". This is that ADR.
- **Does NOT touch:** ADR 0002. See "What this does not change", below — it is the first
  thing a reader will worry about, and it is the thing we are not doing.

## Context

Integrations shipped (Phase 8) as a **CLI config-file orchestrator**. "Connect Sentry"
meant: write a `sentry` server block into `~/.claude.json`, `~/.codex/config.toml` and
`~/.gemini/settings.json`, then open a terminal and type `claude /mcp` into it so the CLI
could run its own OAuth. The app never held a credential, and could not: it inferred
"connected" by shelling out to `claude mcp list` every fifteen minutes and regex-matching
the word *Connected* in the output.

Three things were wrong with that, and they are the same thing wearing three hats:

1. **The app could not answer "am I connected?"** It knew it had written bytes to a file.
   Whether a grant existed, whose account it was, or whether it still worked, it could
   only guess — from another program's stdout, on a quarter-hour delay.
2. **The connection was per-CLI, N times.** Connecting one service to three CLIs meant
   three OAuth grants, in three credential stores, with three places to revoke and three
   things to re-authorize when one expired. There was no such thing as *"this machine is
   connected to Sentry."*
3. **The unit was wrong.** A user does not want to configure an MCP server. They want
   their Sentry account available to their agents. The page was made of config rows when
   it should have been made of connections.

## Decision

**The app is the OAuth client.** It holds ONE grant per service and the CLIs reach the
service *through* it.

- **Connect** runs OAuth 2.1 + PKCE(S256) in the user's **own browser**, against the
  vendor's real consent page (`shell.openExternal` + an ephemeral `127.0.0.1` loopback
  redirect, RFC 8252). The app never renders a login form and never sees a password.
- **Registration is dynamic.** Where the authorization server advertises a
  `registration_endpoint` (RFC 7591), the app registers **itself**, as a *public* client
  with no secret. Verified live against Sentry, Notion, Vercel, Stripe, Figma, ClickUp,
  Airtable and GitLab — no vendor paperwork, and no client secret shipped in a bundle
  every user can read. GitHub and Slack do not offer DCR; they need a pre-registered
  client id, and the card says so in words rather than failing silently.
- **Custody.** Access and refresh tokens rest **only** as OS-keychain ciphertext
  (`safeStorage`, ADR 0008.h). They are decrypted at exactly one point — the moment a
  token is attached to an outbound request — and no IPC channel can return one, by
  construction (the 8/08 write-only discipline). **No keychain → we refuse to connect**,
  rather than hold a refresh token in plaintext.
- **The CLIs get a command, not a credential.** A connected service is registered as an
  ordinary stdio MCP server whose command is our bridge
  (`bin/mogging-connection.mjs --connection <id>`). The bridge forwards the agent's
  JSON-RPC frames over the **existing** token-authed local socket; the app attaches the
  bearer token on the far side. What lands in `~/.claude.json` is a command and a service
  id. **There is nothing in that file worth stealing.**
- **Connected means proven.** After a grant lands, the app calls the server —
  `initialize` + `tools/list` — and the card reports what it *answered*: the server's
  name, the tool count, the granted scopes, the renewal time. Nothing on a card is
  inferred from the presence of a config block.
- **Ask the RESOURCE what it needs, never the authorization server what it has.** The
  protected-resource metadata (RFC 9728 `scopes_supported`) declares the scopes *this MCP
  server* requires. The authorization server's list is everything the whole platform can
  do. Reaching for the second is how a client quietly asks for the world:

  ```
  gitlab.com   AS offers:      api  read_api  write_repository  create_runner
                               manage_runner  k8s_proxy  sudo  admin_mode  …
  gitlab.com   RESOURCE needs: mcp
  ```

  An early draft of this feature defaulted to the AS's list. It would have put a consent
  screen in front of the user asking for **`sudo` and `admin_mode` on their GitLab** in
  order to read an issue. We ask the resource; if the resource declares nothing, we ask
  for **nothing** and let the server apply its own default. The only scopes we ever add
  are `openid` / `email` / `profile`, where offered — they grant access to nothing and
  they are what let a card name the account.
- **Whose account, answered honestly or not at all.** A connection card's job is to tell
  you which account you are acting as; an agent acting as the *wrong* account is how this
  feature does real damage. We prefer an **email** — it is unambiguous where a display name
  is not — and request the `email` scope wherever the authorization server offers it. But
  the OAuth layer usually cannot say: measured across the catalog, **8 of 10 servers publish
  no `userinfo_endpoint` and no `openid` scope**. So identity is resolved down a ladder,
  cheapest first: the OIDC `id_token`'s `email` claim; the provider's own fields in the
  token response (Notion nests the user's email at `owner.user.person.email` and names the
  workspace at top level; Slack names the team); the access token's own JWT claims; a
  `userinfo` endpoint; and finally the **server itself** — most expose a `whoami`-shaped
  tool, and it always knows, because it is serving that account's data. At every rung the
  miner walks the whole response and **prefers a keyed email over a display name over a
  loose email-shaped string**, so an email buried deeper than a name (exactly Notion's
  shape) still wins, while a stray `billing_email` never outranks the real user. The
  whoami call is fenced: the tool must appear in the server's own `tools/list`, its name
  must be on a fixed allowlist, and it must take no required arguments. **If nothing
  answers, the card says so** ("this provider doesn't share an account name") rather than
  inventing one.

## Rationale

### Why 0008(d)'s objection does not reach this design

0008(d) refused app-held OAuth partly on the grounds that *"OAuth 2.1 refresh-token
rotation makes a shared app-held grant technically unsound."*

That is **correct about a different design.** Rotation breaks when a token is *handed out*
to N consumers, which then race to refresh and invalidate each other's refresh token. It
does not break when there is exactly **one holder**. Here the CLIs never possess the
token — they call through the app — so there is one refresher, serialized per connection
(`refreshing`, a promise map, in `src/main/connections.ts`). The rotated refresh token is
persisted on every renewal, because many providers issue a new one each time and dropping
it strands the grant at the *next* expiry, hours away from its cause.

The objection was against **token distribution**. This ADR does not distribute tokens; it
is the reason it can be written.

### Why this is a *smaller* credential footprint, not a larger one

Counter-intuitively, the app holding the token means **fewer** places a token exists:

| | Before (0008) | After (0012) |
|---|---|---|
| Grants per service | one **per CLI** (up to 3) | **one** |
| Token lives in | each CLI's own credential store | one OS-keychain slot |
| Secrets in CLI config files | `${VAR}` env-refs to vaulted keys | **none** — a command |
| Revoke by | re-authorizing each CLI, separately | one **Disconnect** |
| "Connected?" answered by | regex over `claude mcp list`, ≤15 min stale | the server, on demand |

### Why not a local HTTP proxy

Because ADR 0008(b) says nothing listens on TCP, and it is right. The bridge is a stdio
process that is a pure **client** of the same 0600 local socket the house MCP server has
used since 6/05b. No new listener, no new port, no daemon-protocol change.

## What this does not change

**ADR 0002 stands, entirely and without qualification.** We still never broker, store,
proxy, pool, resell, or meter a **provider login** — Claude, Codex and Gemini authenticate
themselves, against the user's own accounts, and no token of theirs ever enters this
process. That ADR is about the AI providers whose CLIs we host, and the business model
that would tempt us to sit in the middle of them. This ADR is about **third-party service
accounts** (Sentry, Notion, Linear) that the user asks us to connect on their behalf.
Those are different things, and conflating them would be the easiest mistake to make here.

"Your keys, your CLIs" remains true: the CLIs authenticate themselves, and no provider
credential of yours ever enters this process. The unconditional second half this
paragraph originally made — that MoggingLabs runs no server and sells nothing — is
bounded by [ADR 0015](0015-accounts-and-entitlements.md): a paid tier with our OWN
account is doctrine now, gating PAID features only, while the free local core keeps
needing no account and keeps working fully offline. *(Sentence amended by ADR 0015;
the original absolute was true when this ADR was accepted.)*

The per-CLI route also **remains**, unchanged and fully supported (Settings › Integrations
› *Per-CLI servers*). A user who wants a CLI to own its own auth, or who needs a server
that must run locally (`aws`, `azure` — those ride the machine's own credential chain and
have nothing to connect), still has exactly what they had. We added a lane; we removed
nothing.

## Consequences

- **The app must be running for a connected service to work.** The credential lives here,
  so the bridge cannot serve an agent when the app is closed. It says so in one sentence
  rather than hanging. This is the honest cost of the app owning the grant, and it is
  mostly theoretical — agents are launched *by* the app, into its panes.
- **A connected account is reachable by any agent whose workspace tool plan includes it.**
  The plan and the grant are therefore the real boundary, and the Connections copy says
  this out loud. This was *already* true of a vaulted service key (8/08); it is now true of
  an OAuth grant, which is a bigger deal, which is why it is stated on the page and not
  only here.
- **Anything that can read the 0600 endpoint file can call a connection.** That is the same
  trust boundary the house MCP server has always had (it can already drive the browser and
  write to panes). It is a user-only file. We are not widening it — but we are putting more
  behind it, and that is worth saying plainly.
- **The wording gate grew four patterns.** `scripts/check-credential-wording.mjs` now also
  refuses the old promises about OAuth custody — the app-never-authenticates-a-server line,
  the OAuth-belongs-to-the-CLI line, and the two spellings of not-holding-a-token. Each was
  **true when it was written**, which is precisely what makes it dangerous: a sentence you
  remember is one you re-type without re-checking. The gate is what stops the old promise
  creeping back in from muscle memory. (It bites its own author: the first draft of this
  bullet quoted one of the banned phrases and the gate failed the build. Working as
  intended.)
- **GitHub and Slack need a registered OAuth client** before their cards can connect. Until
  then GitHub still connects by PAT (its `token` on-ramp is unchanged) and both remain
  fully usable via the per-CLI route.
- **We do not revoke at the vendor on Disconnect.** We delete our copy of the credential
  and say so; many providers have no revoke endpoint, and a promise we cannot keep is worse
  than the sentence that tells the user where to go and kill the grant properly.
