Phase 7 proved the paste-once vault (0007.a): ciphertext at rest, masked
forever, decrypted in memory at the moment of use. This step brings the
SAME grammar to the fleet: a service key pasted ONCE reaches api-key MCP
servers in every pane — no dotfile editing, no secret literal in any CLI
config, ever. Feasible because WE launch the panes (each spawn already
gets an env map — the profile path; vault keys join it); honest because
the copy says where it works.

## Steps
1. **Extract the vault**: `usage-keys.ts`'s safeStorage mechanics become
   `src/main/vault.ts` (encrypt/decrypt/slot, write-only discipline,
   vault-unavailable REFUSAL intact); usage-keys becomes consumer one
   (zero behavior change — USAGE/USAGESET as proof). This key store and
   10's URL store are consumers two and three.
2. **Service-key store**: slots keyed `vault:<name>` in the settings KV
   (ciphertext only). The 06/07 env forms grow the paste-once option: a
   secret-shaped value is OFFERED the vault instead of refused outright —
   accepted → ciphertext; the config gets the `${NAME}` form, never the
   literal. Masked as saved-chip forever (Replace/Delete, no reveal —
   the 7/12 key-control grammar reused).
3. **Materialization at launch**: the app resolves vault slots and
   merges them into the env map it ALREADY sends with pane spawn (the
   profile-env path — daemon v3 untouched). Decrypted in memory for the
   launch call only; never in KV, logs, trail, telemetry. Removal takes
   effect next launch, stated in the UI.
4. **Per-CLI env semantics dev-verified** (7/01, into cliQuirks): how
   each CLI expands/inherits envs for MCP servers (`${VAR}` in config vs
   process-env inheritance) — a real install per CLI, dated, before any
   preset claims it.
5. **Honest copy, both edges**: (a) "keys pasted here reach agents in
   panes launched by the Workspace — a CLI run elsewhere needs your own
   env var" (env-ref stays the everywhere alternative); (b) the grantCopy
   truth: any key an MCP server needs is readable by the agent process —
   same as any env var; scope servers per workspace.
6. **VAULTKEYS smoke** (`MOGGING_VAULTKEYS`, env-gated, in qa-smokes.sh):
   (a) a secret-shaped paste lands as vault ciphertext — KV and fixture
   CLI config grep FREE of the literal, config carries `${NAME}`; (b) a
   fixture pane's env contains the value (spawn-path assert); (c)
   survives restart; (d) delete → absent next launch; (e) vault-less
   machine → refusal, env-ref still offered (7/13); (f) no value in any
   log/trail/telemetry grep; (g) usage keys still round-trip. Verdict
   `out/vaultkeys-result.json`.

## Files
- `src/main/vault.ts` · `usage-keys.ts` (consumer) ·
  `@backend/features/integrations` key store · the pane-spawn env merge ·
  `settings/integrations.ts` slots · vaultkeys-smoke.ts · qa-smokes.sh ·
  books

## Definition of Done
- Dev-verified (books, dated): an api-key preset (PostHog or fal.ai)
  connected with a VAULT key — an agent in a pane lists its tools; disk
  inspected: no plaintext key anywhere (KV, config, backups).
- The paste-into-vault flow works in 06 custom entries AND 07 preset
  slots; plaintext-into-config remains impossible.
- USAGE + USAGESET green after the extraction; VAULTKEYS gate green;
  sweep count bumped in the books.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundaries clean.
- Full local sweep; MILESTONE + PERCEPTION re-run.

## Guardrails
- WRITE-ONLY forever: no getter channel, IPC, or CLI verb returns a
  vault value — structural, as in 0007.a; the smoke greps every surface.
- The daemon never learns the vault exists: the merge is app-side,
  pre-spawn, on the existing wire — protocol v3 untouched.
- The works-in-panes boundary is UI copy, not fine print — learned at
  paste time.
- Profiles' plaintext-refusal stays: the vault is the ONE sanctioned
  path for a secret to reach an agent; plaintext KV never returns.
