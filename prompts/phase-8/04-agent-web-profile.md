The Comet resolution, the safe branch: a dedicated **agent web profile** —
real logins the user creates ON PURPOSE inside the dock, separate from both
the empty preview session and the system browser (FINDINGS Branch C). Agents may then act as the user — only on granted origins, never on
the blocklist, reads/acts separated, every act receipted. The app still
reads no external cookie store, ever (ADR 0008.e).

## Steps
1. **Two partitions, one dock**: the shipped `persist:browser-dock` stays
   the PREVIEW profile (today's behavior byte-for-byte). Add
   `persist:agent-web` — same hardening (deny-all permissions, sandbox,
   window.open denied, http(s) only) — and a profile switch in the dock
   chrome (Preview ⇄ Agent web, per-workspace choice persisted).
   Sign-ins live ONLY in agent-web; a quiet banner: "sessions you create
   here persist — agents can act on origins you grant".
2. **Grant enforcement** (the `web`/`actOrigins` half of 01's grant; 03
   shipped the store): in agent-web, READ tools (snapshot/screenshot/console/
   network/wait_for) work as today; ACT tools require the page origin ∈ `actOrigins` — refusal
   is a tool error naming the grant and the origin, CLI-worded.
   `SENSITIVE_ORIGIN_PATTERNS` refuse at BOTH ends: the editor won't save
   one, dispatch refuses even if persisted. Preview ignores `actOrigins` —
   its sessions are throwaway.
3. **Human-in-the-loop, session-scoped**: the first ACT per granted origin
   per possession raises the possession banner's confirm ("allow acting on
   {origin} this session") — one click, then quiet; Stop and possession
   stay as shipped. Navigation crossing origins mid-possession lands an
   origin-change alert in the trail + banner tick.
4. **Session controls**: dock menu gains "Signed-in sites…" — origins with
   cookies in agent-web (our OWN partition via `session.cookies`), each
   with "forget" — plus "Clear all agent logins". Grant editor (minimal here if 05
   hasn't landed): add/remove act origins per workspace.
5. **AGENTWEB smoke** (`MOGGING_AGENTWEB`, env-gated, in qa-smokes.sh):
   localhost fixture site (login form → cookie session → a state-changing
   button; a second port as the "foreign" origin): assert (a) preview
   profile = shipped behavior, no regression; (b) agent-web + ungranted →
   snapshot OK, click REFUSED naming grant + origin; (c) granted +
   confirmed → click lands, receipt + trail record origin only; (d)
   origin-change alert on cross-port navigation; (e) blocklisted pattern
   (test-only env entry) refused at save AND dispatch; (f) "forget
   site" kills the session (next request unauthenticated); (g) cookie
   survives dock close/reopen. Verdict via `out/agentweb-result.json`.
   Zero external network.

## Files
- `src/main/browser-dock.ts` · `src/ui/features/browser/` ·
  `src/backend/features/integrations` · `src/main/agentweb-smoke.ts` ·
  `scripts/qa-smokes.sh` (gate row) · `src/main/gallery.ts` (both themes)

## Definition of Done
- Dev-verified in the books: sign into a real site in agent-web, grant the
  origin, an agent completes a task there; on an ungranted origin it
  reads but cannot act.
- Preview behavior unchanged (BROWSER + BROWSERCTL untouched-green).
- AGENTWEB gate green; docs/13-browser.md § "The session, honestly"
  updated for two profiles; sweep count bumped in the books.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- Full local sweep; MILESTONE + PERCEPTION re-run (renderer touched).

## Guardrails
- NO system-browser cookie/keychain reads — Branch B stays parked; this
  step must not create its plumbing.
- `browser_eval` counts as ACT everywhere in agent-web — it can exfiltrate
  or mutate; no read-tier exception.
- Trail/receipts record origins and refs only — never page content, never
  eval bodies (the 6/05b leak lesson), never cookies (ADR 0005).
- Telemetry: counts/booleans; origins never leave the machine.
