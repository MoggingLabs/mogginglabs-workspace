The prize, earned last so it breaks nothing. Today our signed binary can be
run as a generic Node interpreter (`ELECTRON_RUN_AS_NODE=1`) — a keychain-
theft vector AND a cracker's lever. Split the daemon/MCP/CLI onto a minimal
helper, THEN disable `runAsNode`. Gated on the daemon-survival and control-
API smokes so ADR 0006 and the scriptable CLI provably hold.

## Steps
1. **ADR 0017 — split the Node runtime to disable `runAsNode`** (`docs/adr/`,
   touches ADR 0006): the detached daemon must outlive the app, so it cannot
   be a `UtilityProcess`; instead it (plus the house MCP server and the
   `mogging` shims) runs on a minimal standalone Node runtime, freeing the
   Electron binary to drop `runAsNode`. State the residual: the helper is a
   smaller, GUI-less, no-Keychain-entitlement target.
2. **Build the helper** (`build/node-helper/`): a Node SEA (native-addon
   support ≥ Node 24) or `@yao-pkg/pkg` binary with **node-pty rebuilt/
   bundled** against it. Ship + `asarUnpack` it beside the current unpacked
   natives. Its own integrity rides the bundle signature (operator's later
   step) — note the asarUnpack caveat (step 02) applies to it too.
3. **Repoint the three call sites** away from `process.execPath` +
   `ELECTRON_RUN_AS_NODE`: `daemon-client.ts:233-234` (daemon spawn),
   `mcp-manager.ts:78` (house server `command`/`env`), and `cli-runtime.ts:
   58-67` (the `mogging`/`mogging-connection` shim generators — the shims now
   invoke the helper, no `ELECTRON_RUN_AS_NODE` set). The daemon WIRE
   protocol is unchanged — this swaps the HOST, not the protocol; PROTOVER
   keeps proving v9.
4. **Disable the fuse**: set `electronFuses.runAsNode: false`
   (electron-builder.yml, step 02) and UPDATE the FUSES gate assertion to
   expect it OFF. The Electron app can no longer be used as a Node
   interpreter.
5. **Extend the invariant smokes to the new host, then gate on them**:
   update SURVIVE (`daemon-survive-smoke.ts` — pane survives app quit/
   relaunch on the helper) and CONTROL (`control-smoke.ts` — real
   `bin/mogging.mjs` list/send/send-key/capture + the auth refusals, now
   over the helper). **RUNTIMESPLIT smoke** (`MOGGING_RUNTIMESPLIT`,
   qa-smokes.sh): the packaged app carries `runAsNode:false`, the daemon
   starts via the helper, the house MCP server answers, and `mogging` verbs
   work — release BLOCKS unless SURVIVE + CONTROL + RUNTIMESPLIT are all
   green. Verdict `out/runtimesplit-result.json`.

## Files
- `docs/adr/0017-split-node-runtime.md` · `build/node-helper/` (SEA/pkg +
  node-pty) · `daemon-client.ts` · `mcp-manager.ts` · `cli-runtime.ts` ·
  `electron-builder.yml` (runAsNode:false) · `scripts/check-fuses.mjs`
  (assert OFF) · `daemon-survive-smoke.ts` · `control-smoke.ts` ·
  `src/main/runtimesplit-smoke.ts` · qa-smokes.sh

## Definition of Done
- RUNTIMESPLIT green AND SURVIVE + CONTROL green on the helper; the sweep
  count grows by one. FUSES now asserts `runAsNode:false`.
- The signed Electron app cannot be run as Node; the daemon still outlives
  an app quit/relaunch (ADR 0006) and the CLI is still fully scriptable.

## Checks that must be green
- `npm run typecheck` → 0; build (all arches, incl. the helper) → ok;
  static gates (PROTOVER — v9 unchanged); full sweep + the three smokes;
  MILESTONE.

## Guardrails
- Land the helper FIRST, flip the fuse SECOND — the split is gated on
  SURVIVE + CONTROL, extended to drive the helper, so I1/I3 are proven on
  the shipped runtime, not the old one.
- The daemon wire protocol does not change (v9); only its host does.
- node-pty must load in the helper on every OS; no network in the smoke.
