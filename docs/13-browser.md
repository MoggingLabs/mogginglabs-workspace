# 13 — The browser dock & agent control

Phase-6/05 + 05b. A toggleable right dock (`Ctrl+Shift+U`, the titlebar globe,
or the palette) that previews what the agents build — and, with consent,
lets agents drive it.

## The dock (6/05)

A `WebContentsView` the MAIN process owns and floats over one stable rect
right of the grid; the grid narrows, terminals stay visible and interactive.
The renderer owns only the chrome (header, URL bar, empty state); the page
never enters the renderer. Each workspace remembers its last preview URL
(switching never navigates — a chip offers it). Dock open/width persist.

Security posture (ADR 0002): `sandbox: true`, no preload, no nodeIntegration,
`window.open` denied (http(s) links open in the system browser), http(s) only.
The dock runs its OWN session partition (`persist:browser-dock`) with a
deny-all permission handler — nothing is injected or read by us.

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
  vice versa. Write tools are NOT served: they arrive behind the 8/03
  per-workspace grant; calling one today is a spec error that says so.

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
tools — the wheel, not the vault. No session injection, no headless second
browser: the verbs drive the ONE visible dock the human is looking at.

**The session, honestly.** The dock uses its own empty partition. It is NOT
your system browser and does not share its logins — it starts signed out of
everything, and an agent acts only with whatever the DOCK itself holds (i.e.
what you signed into inside the dock). Agents can reach a local dev server or
any public page without touching your real browser sessions.

**Untrusted content.** A page an agent reads via `snapshot`/`screenshot` is
untrusted input; a hostile page can attempt to steer the agent through its
text (prompt injection is inherent to browser tools everywhere). The consent
copy says so. Keep agent-driving off for workspaces where you'd browse
sensitive or adversarial pages.

### Telemetry (ADR 0005)

Only counts and booleans (dock opened; a verb ran). URLs beyond origin, page
content, typed text, eval bodies, and screenshots NEVER enter telemetry or
logs.
