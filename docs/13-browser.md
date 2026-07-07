# 13 — The browser dock & agent control

Phase-6/05 + 05b. A toggleable right dock (`Ctrl+Shift+U`, the titlebar globe,
or the palette) that previews what the agents build — and, with consent,
lets agents drive it.

## The dock (6/05; in-DOM <webview> since 8/07; per-workspace since 8/07b)

A toggleable right dock; the grid narrows, terminals stay visible and
interactive. The renderer owns the chrome (header, URL bar, empty state);
the page is an in-DOM `<webview>` guest.

**Why a `<webview>`, not a `WebContentsView` (8/07).** The dock originally
floated a main-owned `WebContentsView` over the chrome's rect. That is a
SEPARATE Chromium compositor layer, so it and the DOM chrome resize on
different clocks — dragging the dock made the page visibly lag/tear the
chrome (a documented, unfixable Electron limitation; the migration guide only
offers an async `resize` listener). Snapshots/freezes hid it but weren't a
real fix. The proper fix is to make the page a participant in the SAME
compositor: an in-DOM `<webview>` (an out-of-process iframe Chromium's
surface-sync resizes atomically with its parent layout). Now the dock resizes
the page in perfect LOCKSTEP with the chrome — one DOM layout, zero artifacts.
The guest still runs OUT of process in its own partition/sandbox (the page
never enters the trusted renderer); MAIN drives it by `getWebContentsId()` →
`webContents.fromId()` for agent control, screenshots, and cookies.

**Per-workspace browsers (8/07b).** Every workspace has its OWN browser: two
`<webview>` guests (preview / agent-web) with WORKSPACE-SCOPED partitions
(`persist:bdock.<wsId>` and the vault-conditioned `persist:aweb.<wsId>`), so
each workspace keeps its own live page (url/history/scroll) AND its own cookie
jar/logins — you can be signed into different accounts per workspace.
Switching workspaces switches the dock to that workspace's browser (its guest
sits on top; the others stay live underneath). Guests are kept per workspace
with an LRU cap (3 live workspaces × 2 profiles); an evicted workspace
re-creates and restores its last url on return. Dock open/width persist
globally; last-url/profile/consent/grant are per workspace.

**Agents drive their OWN workspace's browser (8/07c).** Each agent's browser
tools carry its pane, which resolves to its workspace — so an agent acts on
THAT workspace's browser, gated by THAT workspace's consent/grant, never
whatever's in the foreground (no cross-workspace bleed). You can leave an
agent working in one workspace's browser and go work in another: its browser
is materialized on demand (even if you never opened it), pinned from eviction
while the agent is attached, and its workspace tab shows a possession dot
(pulsing while the agent is driving) so you always see who's at the wheel —
visible possession, now across workspaces. The dock's Stop button governs the
browser you're looking at; to approve a signed-in origin you view that
workspace and click allow (the confirm is scoped to the browser you see).

Security posture (ADR 0002): each guest is `sandbox: true`, no preload, no
nodeIntegration, its own partition; `window.open` denied (http(s) links open
in the system browser), http(s) only; a deny-all permission handler on every
guest session — nothing is injected or read by us, and the system browser's
sessions are never touched (Branch B parked).

## Agent control (6/05b)

With consent, agents get the wheel via a verb toolset on the MAIN-side driver:
`navigate` · `back/forward/reload` · `snapshot` (accessibility outline +
visible text + stable refs — the agent's eyes) · `screenshot` · `click` ·
`type` · `scroll` · `select` · `eval` (arbitrary page script) · `console` ·
`network_failures` (the error feedback loop) · `wait_for`. Together they close
the build→preview→see-the-error→fix loop without a human alt-tabbing.

**Transport — the house MCP server (`mogging`).** Agents reach the tools
through the first-party MCP server, `bin/mogging-mcp.mjs` (stdio JSON-RPC 2.0,
serverInfo `mogging` since 8/02 — any MCP-speaking client can use it; MCP
Inspector and a real Claude Code session are both dev-verified). Its catalog is
DATA: `bin/mcp-catalog.json`, build-copied from
`src/contracts/integrations/mcp-catalog.json` (both committed; the MCP smoke
byte-compares them and holds served `tools/list` to the file). It is a pure
CLIENT of two token-authed local sockets it does not own (nothing on TCP, the
daemon protocol stays v3):

- **browser family → the app's browser-control endpoint**: the MAIN process
  opens a token-authed local socket (unix socket / named pipe — the same class
  as the daemon's, ADR 0006) and writes `browser-control.json` into the
  per-user runtime dir; verbs relay to `agentAct`, consent enforced app-side.
- **control family (READ half, 8/02) → the PTY daemon socket** the `mogging`
  CLI already speaks: `list_panes` · `capture_pane` (tail ≤ 10000, to the
  calling model only, like `capture`) · `mail_read` (identity =
  `MOGGING_PANE_ID`, human view outside a pane) · `list_owners` ·
  `list_board` (the board lives app-side, so this one rides the app endpoint).
  The upstreams degrade independently — no daemon means control tools answer a
  clean JSON-RPC error naming the fix while browser tools keep working, and
  vice versa. Control WRITES (8/03: `send_to_pane` · `send_key` · `mail_send`
  · `claim_files` / `release_files` · `update_card`) serve ONLY under the
  per-workspace integrations grant (default OFF): ungranted means invisible in
  `tools/list` AND refused on a direct call; the grant is re-checked LIVE per
  call so a revoke lands mid-session (`notifications/tools/list_changed`
  follows flips); sessions without a pane identity get no write tools, period.
  Every granted write is attributable — a receipt lands "MCP: … by pane N"
  attention on the target pane and feeds the activity trail (8/05). The write
  tools add NO daemon capability: same verbs, allowlists, and caps as the
  `mogging` CLI, and `approve` is never a tool (docs/09 — humans own the
  review gate).

The whole path is exercised by two gates: `MOGGING_BROWSERCTL` (dock driving)
and `MOGGING_MCP` (both upstreams, catalog equality, degradation, token
hygiene).

Register it with a CLI until the phase-8 MCP manager (8/06) automates the
fan-out (dev machines registered under the old `mogging-browser` name should
re-register):

```
claude mcp remove mogging-browser ; claude mcp add mogging -- node <install>/bin/mogging-mcp.mjs
```

### Consent — per workspace, default OFF

Settings § Browser (and, later, the wizard) toggles "Agents may drive the
browser" for the active workspace. Stored as `browser.agentControl.<wsId>`;
every verb refuses with `disabled` until it's on. Humans own the gate.

### Visible possession

While an agent holds the wheel (and a grace beat after), the dock wears a
brand outline and an "Agent driving — Stop" banner; Stop revokes instantly and
halts any in-flight load. A ⋯ activity trail lists recent actions as verb
names + target refs ONLY — never the typed text, the eval body, or page
content. User input to the dock always works; the wheel is shared, never
stolen.

### What agents can NEVER touch

ADR 0002 holds at full throttle. There are no cookie, storage, or credential
TOOLS — the wheel, not the vault. No session injection, no headless second
browser: the verbs drive the ONE visible dock the human is looking at. The
only cookie store the APP itself ever touches is its own agent-web partition,
below, at the user's explicit request (Signed-in sites / forget) — never the
system browser's (Branch B stays parked behind its own future ADR).

**The session, honestly — two profiles (8/04, ADR 0008.e).** The dock has two
separate session partitions, switched in the header:

- **Preview** (`persist:browser-dock`) — the 6/05 behavior, byte-for-byte: an
  isolated partition that starts signed out of everything. Agents act here
  under the workspace consent alone (reads and acts alike) — your dev server,
  docs, any public page.
- **Agent web** (`persist:agent-web`) — the dedicated signed-in profile, the
  FINDINGS Branch-C resolution. You sign into sites here ON PURPOSE; sessions
  persist in this profile and nowhere else. It is NOT your system browser and
  never shares its logins. Agents READ freely, but ACT verbs (click / type /
  select / eval / navigate — `eval` has no read-tier exception) require the
  page's ORIGIN in this workspace's grant, checked at dispatch inside
  `agentAct()`, the one choke point every transport funnels through. Sensitive
  origins (banking/mail/gov) refuse at both ends: the editor won't save them
  and dispatch refuses them even if persisted. The first act per origin per
  possession additionally needs the human's one-click banner confirm
  (session-scoped, cleared on Stop), cross-origin navigation raises an alert,
  and every act/refusal/confirm lands in the local activity trail — the audit
  ledger (8/05): per-workspace JSONL under userData, ring-capped, reviewable
  in Settings § Integrations (filters, outcome badges, export, per-workspace
  clear) with the last acts echoed on the dock's possession surface. Origins
  + verbs only, structurally (every field length-capped) — never page
  content, typed text, eval bodies, or cookies; local forever, never
  telemetry (ADR 0005).

**The custody rule here (ADR 0008.h).** Chromium encrypts cookies at rest with
the same OS facility as the app's vault. A machine without a real vault gets a
NON-persist agent-web partition and the chrome says so plainly ("logins here
last until the dock closes") — never weakly-protected cookies on disk. What
you signed into stays inspectable: the Sites & grants panel lists every
signed-in site in the agent-web partition, each with Forget, plus Clear all
agent logins.

**Untrusted content.** A page an agent reads via `snapshot`/`screenshot` is
untrusted input; a hostile page can attempt to steer the agent through its
text (prompt injection is inherent to browser tools everywhere). On the
signed-in profile that risk has real stakes — which is exactly why acts are
origin-gated, confirmed, alerted, and trailed. The consent copy says so. Keep
agent-driving off for workspaces where you'd browse sensitive or adversarial
pages.

### Telemetry (ADR 0005)

Only counts and booleans (dock opened; a verb ran). URLs beyond origin, page
content, typed text, eval bodies, and screenshots NEVER enter telemetry or
logs.

---

The agent-web profile, its origin-grant boundary, the activity trail, and the
custody rule are the subject of **docs/14 — Integrations** (direction 3). That
page also maps the house MCP server that drives this dock.
