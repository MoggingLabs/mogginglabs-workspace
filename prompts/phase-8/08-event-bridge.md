The outbound direction the WEBSITE promises verbatim — n8n: "trigger
self-hosted workflows from your panes"; Make: "from a notify call to any
webhook"; Slack: "when a pane needs you, the right channel knows." The
**event bridge**: house events → user-configured webhooks. POST only;
URLs are secrets; the daemon stays v3 (ADR 0008.g).

## Steps
1. **The shared vault first**: extract `usage-keys.ts`'s safeStorage
   mechanics into `src/main/vault.ts` (encrypt/decrypt/slot, write-only
   discipline, vault-unavailable REFUSAL intact); usage-keys becomes a
   consumer (zero behavior change — USAGE/USAGESET stay green as proof);
   the bridge's URL store is consumer two.
2. **Webhook store** (`@backend/features/integrations/bridge.ts`): 01's
   `IntegrationWebhook` — the URL is a SECRET by default (Slack/Make
   embed tokens in paths): pasted once → vault ciphertext, masked as
   `host/…` forever (0007.a: Replace/Delete only); env-ref alternative.
   https anywhere; plain http ONLY loopback; private-LAN http needs the
   explicit, loudly-labeled "insecure URL" acknowledgment (LAN n8n is
   real).
3. **The subscription**: the app's main process already sees the
   attention/notify stream — subscribe there (daemon untouched). Events
   v1 (01's union): needs-you · notify (the CLI verb — the site's
   promise) · card-moved · review-changed (09 emits). Payload =
   `BridgeEvent` — ids + the short note the user's own notify carried;
   never scrollback, diffs, page content, or origins. Per-webhook event
   filter + optional workspace scope.
4. **Polite delivery**: per-webhook queue, at-most-once stated honestly:
   fire, 3 exponential retries, drop with a `bridge` trail entry (LABEL,
   never the URL). Never blocks notify (queue + 5 s timeout); response
   capped 1 KB; no redirects; a hung receiver costs nothing. Per-webhook
   health chip (ok/failing/off) from outcomes, in-memory.
5. **Settings block** in 06's module: webhook list, masked URL grammar,
   event checkboxes, workspace scope, "Send test event" (a fixture-note
   `notify`), the health chip, the payload schema inline — build the n8n
   side without leaving the app.
6. **EVBRIDGE smoke** (`MOGGING_EVBRIDGE`, env-gated, in qa-smokes.sh):
   in-process localhost receiver — (a) notify lands with the exact v1
   schema; (b) unchecked kind never arrives; (c) workspace scoping;
   (d) retry/backoff on 500 → drop + trail entry with the LABEL;
   (e) vault-conditioned URL storage (round-trip or refusal, 7/13);
   (f) non-loopback http refused sans acknowledgment; (g) a dead receiver
   never stalls a notify (timing); (h) grep: no URL in the trail, no
   secret in logs. Verdict `out/evbridge-result.json`.

## Files
- `src/main/vault.ts` · `usage-keys.ts` (consumer) ·
  `@backend/features/integrations/bridge.ts` · main subscription ·
  `settings/integrations.ts` block · `src/contracts/ipc` ·
  evbridge-smoke.ts · qa-smokes.sh · gallery (both themes)

## Definition of Done
- Dev-verified (books, dated): a real self-hosted n8n Webhook node
  receives a pane's `mogging notify` and triggers a workflow; a Slack
  incoming webhook receives `needs-you` — the site's sentences literal.
- USAGE + USAGESET green after the vault extraction (proven).
- EVBRIDGE gate green; sweep count bumped in the books.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundaries clean.
- Full local sweep; MILESTONE + PERCEPTION re-run.

## Guardrails
- POST only, ever: no listener, no inbound route, no redirects —
  "a notify call to any webhook" is outbound by definition.
- The payload is the CONTRACT: adding a field bumps `v` and the docs —
  receivers are user infrastructure; we don't break them silently.
- Webhook URLs never appear in logs, trail, telemetry, or error strings —
  the label is the only public name (ADR 0005/0008.g).
- A doorbell, not a message bus: no guarantees beyond the stated retries,
  no payload beyond the shape.
