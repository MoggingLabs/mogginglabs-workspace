One fleet, one registry: register any MCP server ONCE and fan it out to
every hosted CLI — Claude Code, Codex, Gemini, each in its own config
dialect. The `hooks/` install pattern generalized: the app orchestrates
config files the CLIs own; it never runs, proxies, or authenticates a
server. Also builds the ONE settings home the pack grows in (7/12 lesson).

## Steps
1. **Server registry** (`@backend/features/integrations`): persisted
   `McpServerEntry { id, label, transport: 'stdio'|'http', command/args or
   url, env? }` list — env values are `${VAR}` REFERENCES only; a
   secret-shaped literal refused at save, house wording. The house server
   ships as the built-in first row — "MoggingLabs", stdio, the
   `mogging-mcp` bin (one entry, whole app).
2. **Per-CLI config writers**, one adapter per dialect beside a per-OS
   path table (the usage-adapter discipline): Claude Code
   (`~/.claude.json`, `mcpServers` JSON), Codex (`~/.codex/config.toml`,
   `mcp_servers` TOML — line-splice, no parser dep, see IMPLEMENTATION),
   Gemini (`~/.gemini/settings.json`, its `httpUrl`-vs-`url` quirk).
   SURGICAL: touch only our entries (marked `_managedBy: "mogginglabs"` or
   the dialect's comment equivalent), preserve every other key +
   formatting, `.bak` timestamped backup before the session's first write.
   Respect profile pointer homes (canonical-path compare on win32, 6/03).
3. **Settings § Integrations — ONE module** (`settings/integrations.ts`,
   the usage.ts pattern; index.ts stays an assembler): registry list,
   per-CLI apply toggles with detected-CLI chips (not installed → dimmed,
   writer skipped), a DIFF PREVIEW before any write ("this block lands in
   ~/.codex/config.toml"), per-workspace grants as a subsection — write
   toggles AND act-origins (03/04's store) — and 05's Activity block
   ABSORBED if it landed on a stub shell. 07/08 grow this module; no knob
   renders anywhere else, ever. Remove = clean extraction of our entries
   only; backups listed for restore.
4. **Drift detection**: on open, re-read each target; hand-edited or
   deleted managed entries show a `drift` chip with re-apply/adopt/forget
   — never silently rewrite on launch. Detection is read-only. Drift hash
   = sha256 of our block, in the KV at write time.
5. **MCPMGR smoke** (`MOGGING_MCPMGR`, env-gated, in qa-smokes.sh):
   FIXTURE config homes (temp dirs, realistic files, foreign entries, odd
   formatting) — add/apply lands the right dialect in all three, foreign
   keys byte-preserved, backup exists, remove extracts cleanly,
   secret-literal refused, drift detected after an out-of-band edit, both
   Claude-config vintages handled (risk #2). Zero writes to real user
   homes; verdict `out/mcpmgr-result.json`.

## Files
- `src/backend/features/integrations/` (registry, writers/, path tables) ·
  `src/ui/features/settings/integrations.ts` · `src/contracts/ipc` ·
  `src/main/mcpmgr-smoke.ts` · qa-smokes.sh gate row · gallery (states)

## Definition of Done
- The house server registered to all three CLIs in one click on the dev
  machine; each CLI's own `mcp list`-equivalent sees it (books, per CLI,
  dated).
- A foreign hand-written entry in each dialect survives our add + remove
  byte-identical (smoke-asserted).
- MCPMGR gate green; gallery has the section in both themes.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- Full local sweep; MILESTONE + PERCEPTION re-run (renderer touched).

## Guardrails
- ADR 0002: never write to auth/credential keys in any CLI config; env
  REFERENCES only — secret literals refused, same heuristics as profiles.
- The app never launches or proxies a registered server — registration is
  config, execution belongs to the CLIs.
- No config file is written without a same-session backup and an explicit
  user action (drift never auto-heals).
- One home: the LAST new settings surface this pack creates — 07/08 extend
  it in place.
