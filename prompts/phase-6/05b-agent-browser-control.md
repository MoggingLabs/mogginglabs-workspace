The dock (6/05) gives HUMANS the preview; this step gives AGENTS the wheel:
navigate, read the page, act on it, run script in it — build a web thing,
SEE its own errors, click its own flows, fix what it finds. Depends on 6/05
(the driver seam) and the phase-8 MCP server transport (8/02) — browser tools
are that server's richest toolset, not a new wire of their own.

## Steps
1. **The toolset** (main-side `driver`, exposed as MCP tools; every hosted CLI
   gets them for free through the phase-8 server):
   - `browser_navigate(url)` · `browser_back/forward/reload`
   - `browser_snapshot()` — accessibility-tree outline + visible text + URL/
     title (the agent's eyes; refs stable enough to click by)
   - `browser_screenshot(region?)` — PNG for vision-capable CLIs
   - `browser_click(ref|selector)` · `browser_type(text, ref?)` ·
     `browser_scroll` · `browser_select`
   - `browser_eval(js)` — full page manipulation, the "fully" in the ask
   - `browser_console(tail)` · `browser_network_failures(tail)` — the error
     feedback loop that makes self-fixing possible
   - `browser_wait_for(selector|navigation, timeoutMs)`
2. **Consent, per workspace, default OFF**: "Agents may drive the browser"
   toggle (the auto-failover consent pattern — Settings § per-workspace +
   wizard checkbox). Tools return a `disabled` error until it's on. Humans own
   the gate.
3. **Visible possession**: while any agent verb is in flight (and for a
   grace-beat after), the dock chrome wears an AGENT-DRIVING state — brand
   treatment + "Agent driving — Stop" button that revokes the grant instantly.
   An activity trail in the dock (⋯) lists recent verbs (verb + target ref
   only, never page content). The wheel is shared, never stolen: user input
   always works.
4. **What agents can NEVER touch** (ADR 0002 holds even at full throttle):
   no cookie/storage/credential READ tools, no session injection, no headless
   second browser — the tools drive the ONE visible dock the human is looking
   at. State the session fact honestly in docs: the dock runs the APP's own
   session partition (empty until the user signs into something in it) —
   agents act with what the DOCK holds, never with the system browser's
   sessions. Snapshot text is UNTRUSTED page content (prompt-injection is
   inherent to browser tools everywhere) — the consent copy says so.
5. **Smoke** (`MOGGING_BROWSERCTL`): consent off → verbs refuse; on → against
   the smoke's local http page: navigate/snapshot/click/type/eval round-trip
   (eval mutates DOM, snapshot sees it), console tail captures a planted
   error, wait_for resolves, Stop revokes mid-sequence, activity trail shows
   verbs only. No external network.

## Files
- `src/main/browser-dock.ts` (driver verbs) · phase-8 MCP server toolset
  registration · `src/ui/features/browser/` (agent state, Stop, trail) ·
  settings/wizard consent · `src/main/browserctl-smoke.ts` · `scripts/qa-smokes.sh`

## Definition of Done
- With consent on, an agent in a pane can open its dev server in the dock,
  read its own console error, click its own button, and verify the fix — via
  MCP tools alone. With consent off, every tool refuses with a clear reason.
- The human always sees agent possession and can revoke it in one click.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- `MOGGING_BROWSERCTL` + `MOGGING_BROWSER` green isolated; MILESTONE +
  PERCEPTION unchanged.

## Guardrails
- Consent is per-workspace and default OFF; no tool works without it.
- Verbs/refs in the trail and telemetry counts only — page content, URLs
  beyond origin, and screenshots NEVER enter telemetry or logs (ADR 0005).
- No cookie/credential access tools, ever — the wheel, not the vault.
- One dock, visible possession, instant revoke; no invisible automation.
