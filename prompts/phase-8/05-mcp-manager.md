One fleet, one registry: Settings § Integrations lets the user register any
MCP server ONCE and fan it out to every hosted CLI — Claude Code, Codex, and
Gemini each in their own config dialect. It's the `hooks/` install pattern
generalized: the app orchestrates config files the CLIs own; it never runs,
proxies, or authenticates a server itself.

## Steps
1. **Server registry** (`@backend/features/integrations`): persisted list of
   `McpServerEntry { id, label, transport: 'stdio'|'http', command/args or
   url, env?: Record<string,string> }` — env values are `${VAR}` REFERENCES
   only; a secret-shaped literal (the Phase-4 profile heuristics) is refused
   at save with the house wording. The house server ships as a built-in
   first row — "MoggingLabs", stdio, the shipped `mogging-mcp` bin (02's
   unified server: one entry, whole app).
2. **Per-CLI config writers**, one adapter per dialect beside a per-OS path
   table (the usage-adapter discipline): Claude Code (`~/.claude.json`,
   `mcpServers` JSON), Codex (`~/.codex/config.toml`, `mcp_servers` TOML),
   Gemini (`~/.gemini/settings.json`, `mcpServers` with its `httpUrl`-vs-
   `url` quirk). SURGICAL edits: parse, touch only our entries (marked
   `_managedBy: "mogginglabs"` or the dialect's comment equivalent), preserve every
   other key + formatting, `.bak` timestamped backup before the session's
   first write. Respect
   profile pointer homes (a profile relocates a CLI's home — write to the
   pointed-at home; canonical-path compare on win32, the 6/03 lesson).
3. **Settings § Integrations** (house division rhythm): the registry list
   (add/edit/remove), per-CLI apply toggles with detected-CLI chips (CLI not
   installed → chip dimmed, writer skipped), a DIFF PREVIEW before any write
   ("this block lands in ~/.codex/config.toml"), and per-workspace grants
   as its own subsection — write toggles AND act-origins (01's contract,
   03/04's store — Lane A not landed → render disabled, the 7/03 pattern). Remove = clean
   extraction of our entries only; backups listed for restore.
4. **Drift detection**: on open, re-read each target file; hand-edited or
   deleted managed entries show a `drift` chip with re-apply/adopt/forget —
   never silently rewrite on launch. Detection is read-only; writes happen
   only on explicit user action.
5. **MCPMGR smoke** (`MOGGING_MCPMGR`, env-gated, in qa-smokes.sh): FIXTURE
   config homes (temp dirs seeded with realistic
   files, foreign entries, odd formatting) — assert add/apply lands the right dialect in
   all three, foreign keys byte-preserved (TOML/JSON round-trip), backup
   exists, remove extracts cleanly, secret-literal refused, drift detected
   after an out-of-band edit. Zero writes to the real user homes; verdict
   via `out/mcpmgr-result.json`.

## Files
- `src/backend/features/integrations/` (registry, writers/, path tables) ·
  `src/ui/features/settings/` (§ Integrations) · `src/contracts/ipc` additions
  · `src/main/mcpmgr-smoke.ts` · `scripts/qa-smokes.sh` (gate row) ·
  `src/main/gallery.ts` (states)

## Definition of Done
- The house server registered to all three CLIs in one click on the dev
  machine; each CLI's own `mcp list`-equivalent sees it (books, per CLI).
- A foreign hand-written entry in each dialect survives our add + remove
  byte-identical (smoke-asserted).
- MCPMGR gate green; gallery has the section in both themes.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- Full local sweep; MILESTONE + PERCEPTION re-run (renderer touched).

## Guardrails
- ADR 0002: never write to auth/credential keys in any CLI config; env
  REFERENCES only — the writer refuses secret literals, same heuristics as
  profiles.
- The app never launches or proxies a registered server — registration is
  config, execution belongs to the CLIs.
- No config file is written without a same-session backup and an explicit
  user action (drift never auto-heals).
