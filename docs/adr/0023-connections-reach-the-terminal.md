# ADR 0023 — Connections reach the terminal, not only the agent

Date: 2026-07-31 · Status: **proposed** · Owner: integrations
Builds on ADR 0014 (app-held service connections) and ADR 0020 (tool-first
integrations), both of which stand word for word. ADR 0002 is untouched and is
not in tension with this — see "What this does not change".

## The report that started it

> "I went into Integrations and connected GitHub — client id and secret — and it
> shows as connected. Then I made a terminal in a workspace to start cloning
> projects from that account, and it said it had no access at all. It's
> completely useless in a workspace or a terminal, even after we added it to
> that workspace in the wizard."

Every clause of that is accurate. The card was right, the wizard was right, and
the terminal was right. This ADR explains why all three can be right at once,
and proposes the seam that is missing.

## Decision, in one paragraph

An app-held connection currently has exactly **one** consumer: the MCP bridge,
reachable only by a hosted agent CLI whose workspace tool plan names it. A
terminal is excluded by construction at three independent points, and there is
no second door — no credential helper, no askpass, no env slot, nothing. We
propose adding a **second consumer seam**, architecturally parallel to
`bin/mogging-connection.mjs`: a `mogging-credential` shim that speaks **Git's
credential-helper protocol**, fetches the token over the *same* 0600 token-authed
local endpoint, and is pointed at by per-pane `GIT_CONFIG_*` env. Custody is ADR
0014 verbatim — the token stays in the app, is decrypted at one point, dies with
the request, and never lands in a config file or a process environment. Scope of
the first pass: **GitHub only**, gated by the **existing workspace tool plan**.

## Why no path exists today — the three exclusion points

Not one bug. Three deliberate, independently-authored refusals that happen to
compose into a dead end.

### 1. A pane's environment carries no credential, by construction

Both PTY backends build the spawn env the same way: the process env, the shell
integration vars, the aider analytics pointer, and the pane's own identity. No
credential is in reach of either function.

- `src/backend/features/terminal/pty.service.ts:143-162` (in-process)
- `src/pty-daemon/session.ts:504-512`, `520-524`, `551` (detached daemon)

The daemon takes a `spec.env` from the app, and that is the only aperture. Which
leads to:

### 2. The one env aperture is agent-gated and fails closed on a shell

`src/main/daemon-relay.ts:395` is the sole caller that fills `spec.env` with
anything credential-shaped:

```ts
const env = remote ? undefined : resolveServiceKeyEnv(workspaceId, agentId)
```

and `src/main/service-keys.ts:86-89`:

```ts
export function referencedServiceKeyNames(workspaceId?: string, agentId?: string): string[] {
  const cli = agentId ? AGENT_TO_CLI[agentId] : undefined
  if (!workspaceId || !cli || !hasToolPlan(workspaceId)) return []
```

`AGENT_TO_CLI` (`service-keys.ts:78`) maps `claude`/`codex`/`gemini` only. A
plain shell has no `agentId`, so `cli` is `undefined`, so the function returns
`[]` before it reads a single vault slot.

This is not an oversight — it is **pinned by a gate**.
`src/main/smokes/integmilestone-smoke.ts:521`:

```ts
resolveServiceKeyEnv(keyWsId, 'shell')[VAULT_NAME] === undefined && // a plain shell is not an agent
```

Any change here must move that assertion deliberately, with its comment rewritten.

### 3. The tool plan — what the wizard actually wrote — is agent-launch-only

Connecting registers the connection as an ordinary MCP stdio server whose command
is our bridge (`src/main/connections.ts:1064-1088`):

```ts
command: runtime.connectionShim,
args: ['--connection', serviceId]
```

Picking it in the wizard adds it to that workspace's tool plan. The plan is
materialized in exactly one place — `src/main/tool-plan.ts:71-90`, called from
`src/main/agents.ts:90` — and it opens with:

```ts
const cli = cliForAgent(req.agentId)
if (!cli || !req.workspaceId || !hasToolPlan(req.workspaceId)) return { ok: true, args: [] }
```

Opening a terminal never calls it. The wizard's own copy is honest about this
(`src/ui/features/wizard/index.ts:1166`) — the section is titled **"Agent
tools"** and reads *"Unpicked tools stay out of this workspace's **agents**"* —
but a user who has just watched a card go green and then picked "GitHub" for a
workspace does not read that as "and your shell gets nothing."

ADR 0014 already stated the consequence, in the ADR and nowhere the user looks:

> **A connected account is reachable by any agent whose workspace tool plan
> includes it.**

### 4. And there is no alternative door

Across all of `src/`, these have **zero** occurrences:

| Symbol | Hits in `src/` |
|---|---|
| `GITHUB_TOKEN` / `GH_TOKEN` | 0 |
| `credential.helper` | 0 |
| `GIT_ASKPASS` / `askpass` | 0 |
| `git clone` (any clone feature) | 0 |

The app has never had a git-credential surface. The GitHub *board* adapter
(`src/backend/features/integrations/services/github.ts:5-10`) deliberately shells
out to the user's own `gh` and lets **it** authenticate — the token never enters
the process. That is a fine stance for read-only board polling and a non-answer
for `git clone`.

## What the user's token actually is

Worth stating, because it changes the fix: **the stored grant is fully capable of
cloning.** Verified live on 2026-07-31.

`api.githubcopilot.com/mcp/` challenges with an RFC 9728 pointer, and the
protected-resource metadata declares:

```json
{
  "resource": "https://api.githubcopilot.com/mcp/",
  "authorization_servers": ["https://github.com/login/oauth"],
  "scopes_supported": ["repo","read:org","read:user","user:email","read:packages",
                       "write:packages","read:project","project","gist",
                       "notifications","workflow","codespace"]
}
```

`pickScopes` (`src/backend/features/integrations/oauth.ts:289-296`, called at
`src/main/connections.ts:417`) asks for that list verbatim. **`repo` is in it.**
The user-pasted client secret is stored and sent at token exchange
(`oauth.ts:330`), so the exchange is a real GitHub OAuth App grant.

So the vault holds a token that would clone their private repos today, as an
HTTPS password, if anything handed it to git. Nothing does. **The credential is
capable; the plumbing to the shell does not exist.** That is the whole bug.

## Side-finding: the catalog declares OAuth endpoints nobody reads

Separate from the above, and worth fixing on its own.

`src/contracts/integrations/catalog/github-mcp.json` declares, on its `browser`
method:

```json
"endpoints": {
  "authorizationUrl": "https://github.com/login/oauth/authorize",
  "tokenUrl": "https://github.com/login/oauth/access_token"
},
"scopes": [ "repo", "read:org", "gist", "workflow" ]
```

Grepping all of `src/`, `authorizationUrl` and `tokenUrl` appear **only** in the
type declaration (`src/contracts/integrations/provider-catalog.ts:65-66`). There
is no reader. The connect path always discovers from the MCP URL
(`oauth.ts:117-191`); the declared endpoints and the curated 4-scope list are
never consulted.

Harmless *today* — discovery lands on those same endpoints, and the resource
declares a superset of those scopes — which is exactly what makes it dangerous:
it is data that reads as a promise about what we ask GitHub for, and it will stop
matching reality silently. Either wire it (`endpoints.discovery: 'mcp'` already
exists as the marker for "discover, don't use these") or drop the dead fields and
let CATSCHEMA refuse them. **This is not the cause of the report** and must not
be conflated with it.

## Proposed design — the credential seam

### The shape

Exactly the `mogging-connection.mjs` shape, one protocol over:

```
git clone https://github.com/me/private.git
  │
  ├─ git reads credential.https://github.com.helper  ← from per-pane GIT_CONFIG_*
  ├─ spawns:  mogging-credential get      (stdin: protocol/host/path)
  │             │
  │             ├─ reads the 0600 endpoint file (same one bin/lib/endpoint-client.mjs uses)
  │             ├─ sends { name: 'credential.get', host, pane: $MOGGING_PANE_ID }
  │             │
  │             │   main:  pane → workspace (workspaceIdForPane)
  │             │          workspace → tool plan  (planHasServer)
  │             │          serviceId → accessTokenFor()   ← THE one decryption point
  │             │
  │             └─ stdout:  username=x-access-token
  │                         password=<token>
  │
  └─ git uses it, the shim exits, the token is gone
```

### The pieces

| Piece | Where | Note |
|---|---|---|
| `bin/mogging-connection.mjs` (the `mogging-credential` shim landed inside it, not as its own file) | new | Git credential protocol on stdin/stdout: `get` answers, `store`/`erase` are no-ops. Reuses `bin/lib/endpoint-client.mjs` and `runtime-paths.mjs` verbatim. |
| `credentialShim` | `src/main/cli-runtime.ts` | Third shim alongside `connectionShim` (`cli-runtime.ts:203`), same stable-path + launcher treatment. |
| `credential.get` handler | `src/main/mcp-endpoint.ts` | Sibling of `connection.rpc` (`mcp-endpoint.ts:543`), same `boundPane` gating. |
| `credentialForHost(host, pane)` | `src/main/connections.ts` | Resolves pane → workspace (`workspaceIdForPane`, `integrations.ts:197`) → plan → `accessTokenFor`. Fail-closed at every step. |
| Per-pane env | `pty.service.ts` / `session.ts` spawn env | `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` pointing `credential.https://github.com.helper` at the shim. |

`GIT_CONFIG_*` rather than writing git config: nothing is mutated on the user's
machine, the scope is exactly one pane's process tree, and it disappears when the
pane dies. It also keeps the ADR 0014 rule intact — **what lands anywhere is a
command and a host, never a token.**

### The trust boundary, stated plainly

Unchanged from ADR 0014, and this is the reason the design fits:

- The token still rests **only** as `safeStorage` ciphertext.
- It is still decrypted at exactly one point, immediately before use.
- No IPC channel returns it; the shim is not a renderer.
- Anything that can read the 0600 endpoint file can already call a connection and
  drive the browser. This adds `git`-shaped reach behind that same file — a real
  widening of *what* is behind the boundary, not of *who* is inside it. ADR 0014
  said this out loud about the bridge; it must be said again here.

One genuine new exposure: **a process inside the pane can run `git credential
fill` and read the token.** That is strictly less than putting `GH_TOKEN` in the
environment (where `env` prints it and every child inherits it), and it is the
reason this ADR proposes the helper *instead of* env slots. It should still be
stated on the card.

### Gating — the existing boundary, no new surface

A terminal gets a host's credential **only if that workspace's tool plan includes
that connection** — the same boundary agents ride, the same checkbox the user
already ticked in the wizard. Fail-closed: no pane → no workspace → no plan → no
credential. No third grant surface; `WorkspaceIntegrationsGrant` and
`WorkspaceToolPlan` are enough, and the codebase avoids a third on purpose.

The wizard section will need to stop saying "Agent tools" — or the copy needs to
say that a picked connection reaches this workspace's terminals too. That copy
change is part of the work, not a follow-up.

### First pass boundary

**GitHub only.** `github-mcp` is the reported case, it is the one whose token is
already proven to carry `repo`, and it exercises every part of the seam. The
generalization (catalog rows declaring a `gitHost`, so gitlab and the rest are a
data PR per ADR 0020) is the obvious second step and should not be built
speculatively in the first.

## What this does not change

**ADR 0002 stands, entirely.** This is a third-party service account the user
asked us to connect on their behalf — the same category ADR 0014 carved out. No
provider login (Claude, Codex, Gemini) is touched, brokered, or stored. "Your
keys, your CLIs" is unaffected.

**ADR 0014's custody rules stand, verbatim.** Nothing here distributes a token to
N holders, nothing writes a secret into a config file, and the refresh
coordinator remains the single refresher.

**The per-CLI route stands.** A user who wants `gh auth login` to own their git
credentials keeps exactly what they have; this adds a lane.

## Consequences, if accepted

- **The app must be running for a connected git host to work in a pane.** Same
  honest cost ADR 0014 already pays for the bridge — and here it is even less
  theoretical, since the pane is the app's own.
- **A pane's git credential is a workspace-scoped fact.** Two workspaces with
  different plans get different git access, which is correct and will surprise
  someone at least once. It belongs in the docs, not only here.
- **`git credential fill` inside a pane reveals the token.** Stated above; must be
  on the connection card, not buried in an ADR.
- **`integmilestone-smoke.ts:521` must be revisited deliberately.** "A plain shell
  is not an agent" stays true for *vault env slots*; the credential helper is a
  different door and needs its own assertion, not a relaxation of that one.
- **The wizard's "Agent tools" copy becomes wrong** the day this lands, and the
  wording gate should be taught the new sentence so the old one cannot creep back.

## Open questions for the implementing phase

1. Does the helper answer for a **remote (SSH) pane**? `session.ts:527-530` strips
   local pane capabilities for remote specs on purpose. Default answer: **no**,
   same as service keys — the remote host is not ours to credential.
2. Does a **worktree** pane inherit its parent workspace's plan? Presumably yes via
   `locatePane`, but it needs a test rather than an assumption.
3. Should `erase` (git's "these credentials were rejected") surface as
   `attentionLedger.record(serviceId, 'unauthorized')`? It is a free, high-quality
   liveness signal we would otherwise ignore.
4. What does the card say when the plan does **not** include GitHub and the user
   clones anyway? Silence is what git already gives them. A one-line hint beats a
   second failure.
