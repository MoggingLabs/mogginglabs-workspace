CodexBar ships a bundled CLI (`codexbar cost/config/serve`) so usage is
scriptable and CI-readable. Ours already has `mogging` — give it usage verbs
over the EXISTING app endpoint (6/05b's authed transport), so the daemon
protocol never changes. Research:
`docs/research/2026-07-codexbar-parity.md`.

## Steps
1. **`mogging usage`** (in `bin/mogging.mjs`, sharing its client): prints the
   current snapshot — one line per (provider, plan): label, each window's
   `usedPct` + reset countdown, the pace verdict (02's formatter, verbatim —
   same wording as the popover), health. `--json` emits the `PlanUsage[]`
   for scripts. Reads the APP endpoint (the 6/05b socket already carries
   browser control; usage is one more request type), NOT a new listener.
2. **`mogging usage cost --provider <id|all>`**: runs the local cost scan
   (07) and prints per-day spend + total; `--json` for CI. Offline, reads
   known logs only. Mirrors `codexbar cost` semantics.
3. **`mogging usage providers`**: lists catalog rows with enabled state +
   detected/configured status (the CodexBar `config providers` analog);
   `--json` for scripting. Read-only.
4. **`mogging usage refresh [--provider <id>]`**: pokes the poller and
   waits for the next snapshot, then prints it. Bounded wait, clean exit
   codes (0 ok, 3 app-not-running, the CLI's existing semantics).
5. **`mogging usage set-key --provider <id> --stdin` / `clear-key`**: the
   `codexbar config set-api-key` analog — key piped via stdin (never an
   argv, never echoed), sent over the authed endpoint, stored via 0007.a
   (ciphertext, WRITE-ONLY). No get-key verb exists, by design.
6. **App-endpoint message types + smoke**: extend the app endpoint (main
   side, 6/05b) with `usage.list/cost/providers/refresh/setKey/clearKey`
   request types
   (token-authed, same handshake). `MOGGING_USAGECLI` smoke: boot the app
   with the FAKE adapter, spawn `mogging usage --json` + `usage providers` +
   `usage cost` + a `set-key`/`clear-key` round trip (presence flips, the
   piped value absent from every frame + the result JSON), assert shapes +
   verdict wording equals the formatter output + exit codes. Zero network; verdict via
   `out/usagecli-result.json`.

## Files
- `bin/mogging.mjs` (usage verbs) + shared client · `src/main/mcp-endpoint.ts`
  or the app-endpoint module (usage request types) · `src/main/usagecli-
  smoke.ts` · `scripts/qa-smokes.sh` (gate row) · `docs/12-usage.md` (CLI ref)

## Definition of Done
- `mogging usage`, `usage cost`, `usage providers`, `usage refresh` all work
  against a running app in dev, `--json` included; wording matches the
  popover exactly (one formatter).
- No new daemon wire surface and no new listener — usage rides the existing
  authed app endpoint (protocol v3 intact; DOCS say so).
- USAGECLI gate green; sweep count bumped in the books.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- Full local sweep including the new gate.

## Guardrails
- The CLI is a CLIENT of the authed app endpoint — no token in any frame,
  no bypass of the handshake, no second socket.
- `--json` is the same `PlanUsage[]`/`CostScan` contracts — no token, key,
  cookie, or path in the output (grep in the smoke).
- Verdict strings come from 02's formatter — the CLI must not re-spell them.
- Usage values never enter telemetry (ADR 0005); the CLI emits none.
