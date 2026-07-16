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
nodeIntegration, its own partition, http(s) only; `window.open` is funneled
through main's handler — a real popup (OAuth) opens as a hardened child window on
the SAME partition, a plain `target=_blank` opens a new tab, and the system browser
is only ever reached by the explicit globe button; a deny-all permission handler +
check on every guest session (each refusal surfaced honestly, never granted), the
`will-attach-webview` guard, and the Chrome-honest UA — nothing is injected or read
by us, and the system browser's sessions are never touched (Branch B parked).

## Agent control (6/05b)

With consent, agents get the wheel via a verb toolset on the MAIN-side driver:
`navigate` · `back/forward/reload` · `snapshot` (accessibility outline +
visible text + stable refs — the agent's eyes; descends into open shadow roots
and same-origin iframes, capped + `truncated`-flagged) · `screenshot` · `click`
(a full pointer gesture, so pointer-first widgets respond) · `type` (writes
through the prototype value-setter, so React-controlled inputs fire onChange) ·
`scroll` (relative, or absolute with `to: 'y'`) · `select` · `eval` (arbitrary
page script, capped) · `console` · `network_failures` (the error feedback loop —
now also HTTP 4xx/5xx, which `did-fail-load` never sees) · `wait_for` · and the
TAB verbs `tab_list` / `tab_new` / `tab_select` (F4 — an agent can hold the docs
and the dev server open at once). Together they close the
build→preview→see-the-error→fix loop without a human alt-tabbing.

## Tabs (F4)

Each (workspace, profile) holds an ordered set of tabs — one out-of-process
`<webview>` guest each — with a Chrome/Comet-style strip above the address bar
(favicon + title, close ×, + new-tab). The base tab (`t0`) is the pre-tabs single
guest, so a workspace that never opens a second tab is byte-for-byte the old
behavior. A page's `window.open` / `target=_blank` opens a NEW TAB (never the
system browser — the globe button stays the one explicit door out); an OAuth popup
(window features) still opens as a hardened child window on the same partition. The
header, zoom, find, and possession all follow the ACTIVE tab, which the renderer
publishes to main so the driver and the `tab_*` agent verbs act on the tab you see.
Tabs are per-(workspace, profile) and ephemeral (a new tab is lost on LRU eviction;
the base tab restores its last url).

## The browser chrome (Comet parity)

The dock behaves like a browser, not a preview pane:
- **Omnibox** — the address bar resolves what you type: a URL opens (https-first,
  except a dev server — localhost / an IP / an explicit port — which takes http), and
  anything else is a SEARCH (DuckDuckGo by default, `browser.searchEngine`). It never
  "refuses" a query.
- **Sign-in works** — every guest session presents a Chrome-honest user agent (the
  Electron + product tokens stripped, the platform + Chromium version honest), so
  walls that refuse Electron (Google) accept it; OAuth popups complete on the same
  partition. Still our own partition only — the system browser's sessions are never
  read (Branch B parked).
- **Find in page** (`Ctrl+F`), **zoom** (`Ctrl+=` / `-` / `0`, persisted per
  workspace), a **page context menu** (back/reload/copy/copy-link/pin/inspect), and
  **DevTools** (context-menu Inspect) — humans get the agent's console/network view.
- **Header truth** — a favicon / lock (https) / "not secure" (http) indicator in the
  address bar, and Reload becomes Stop while a page loads.
- **Error + crash overlays** — a dead address or a crashed renderer explains itself
  (with Retry), never a white rectangle.
- **App shortcuts still work with the page focused** — the guest is a separate
  process, so main relays the app's own chords (`Ctrl+Shift+U/E/B`, `Ctrl+K`, find,
  zoom) back to the renderer's handlers.
- **Pins + recents** — the empty preview is a dev-loop new-tab page: recent hosts as
  chips, pin/unpin via the page context menu (per-workspace).
- **Honest permissions** — the deny-all handler stays absolute (nothing is granted),
  but each refusal surfaces a transient "Blocked: location" chip instead of silence.
- **Audio** — a mute control appears while the active tab makes sound (a background
  workspace's video no longer plays invisibly).

## Which agent is at the wheel (visible possession)

The driving agent's PANE rides the possession state, so the dock names WHO is
driving and WHAT it is doing right now: the banner reads "Claude Code · pane N is
browsing" with the live action ("Reading the page…/Clicking…"), an animated brand
GLOW wraps the dock, a pulsing indicator shows work in progress, and the titlebar
pill + each workspace tab's tooltip name the driver too. Reduced-motion becalms the
animations (the app's blanket clamp) while the outline + label keep the meaning.

## Hardening (defense in depth)

The dock's guests are the ONLY webviews the app attaches, and the boundary is
enforced twice: a `will-attach-webview` guard forces isolation, strips any preload,
and REFUSES any partition that isn't ours (`persist:bdock.*` / `aweb.*` /
`aweb-mem.*`); and each guest session is hardened (deny-all permissions +
permission-check, the honest UA) the instant it attaches — before dom-ready, before
its first load — so a permission request can't race the default. None of this reads
or imports the system browser's sessions (ADR 0002; Branch B stays parked).

**Transport — the house MCP server (`mogging`).** Agents reach the tools
through the first-party MCP server, `bin/mogging-mcp.mjs` (stdio JSON-RPC 2.0,
serverInfo `mogging` since 8/02 — any MCP-speaking client can use it; MCP
Inspector and a real Claude Code session are both dev-verified). Its catalog is
DATA: `bin/mcp-catalog.json`, build-copied from
`src/contracts/integrations/mcp-catalog.json` (both committed; the MCP smoke
byte-compares them and holds served `tools/list` to the file). It is a pure
CLIENT of two token-authed local sockets it does not own (nothing on TCP, the
daemon protocol untouched by this phase):

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

The whole path is exercised by these gates: `MOGGING_BROWSER` (the dock + sign-in:
Chrome UA, OAuth popups on the shared partition), `MOGGING_BROWSERCTL` (dock driving,
including the driver's real hands — React-tracked inputs, pointer-first widgets,
shadow-DOM reach, the HTTP-error ring, moved-pane resolution), `MOGGING_BROWSERUX`
(the chrome: omnibox, find, zoom, error overlay, context menu, shortcut relay, the
permission chip + pins + the attach guard), `MOGGING_BROWSERTABS` (the tab strip +
`tab_*` agent verbs), `MOGGING_DOCKUX` (visible possession + which-agent identity),
and `MOGGING_MCP` (both upstreams, catalog equality, degradation, token hygiene).

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
TOOLS — the wheel, not the vault. No session injection, no hidden second
browser: the verbs drive the ONE visible dock the human is looking at.
("Hidden" as in offscreen — the app never drives a browser the user cannot
see. Not the CI sense of *headless*, where `xvfb` hands the ONE real window a
virtual display.) The only cookie store the APP itself ever touches is its own
agent-web partition, below, at the user's explicit request (Signed-in sites /
forget) — never the system browser's (Branch B stays parked behind its own
future ADR).

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
  in Settings § Activity (filters, outcome badges, export, per-workspace
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
