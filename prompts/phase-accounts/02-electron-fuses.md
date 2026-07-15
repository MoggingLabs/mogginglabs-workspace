Make the shipped binary tamper-evident and strip its living-off-the-land
levers. Flip the four SAFE Electron fuses now (the fifth — `runAsNode` — is
load-bearing and waits for step 09's runtime split), embed ASAR integrity,
and prove the exact fuse wall on the packaged artifact with a gate.

## Steps
1. **Add `@electron/fuses`** (devDep) and wire fuses through electron-builder's
   `electronFuses` config block (`electron-builder.yml`), which flips at pack
   time and auto-embeds the ASAR integrity header. Set: `enableCookieEncryption:
   true` · `enableNodeOptionsEnvironmentVariable: false` ·
   `enableNodeCliInspectArguments: false` ·
   `enableEmbeddedAsarIntegrityValidation: true` · `onlyLoadAppFromAsar: true`.
   Leave `runAsNode: true` with a comment pointing at step 09 — flipping it now
   breaks the daemon (daemon-client.ts:234), the house MCP server
   (mcp-manager.ts:78) and every `mogging` shim (cli-runtime.ts:63-67).
2. **Verify no production path needs the disabled vars**: grep build/main/daemon
   for `NODE_OPTIONS` / `NODE_EXTRA_CA_CERTS` / `--inspect` reliance (none
   expected). Dev is unaffected — fuses apply to the PACKAGED app only.
3. **Document the asarUnpack caveat** (in ADR 0015 + docs/18 stub): the unpacked
   set (node-pty, better-sqlite3, `bin/**` — electron-builder.yml:28-32) lives
   OUTSIDE app.asar and is NOT covered by the integrity fuse. Those files —
   the CLI shims especially — are covered only by the bundle code SIGNATURE
   (the operator's later, deferred step). State this plainly; do not let
   "ASAR integrity on" imply the shims are hashed.
4. **FUSES artifact gate** (`scripts/check-fuses.mjs`, static, wired into
   qa-smokes.sh docs + CI): package the app (or read a prebuilt artifact),
   run `npx @electron/fuses read --app <path>`, and assert the EXACT wall —
   cookie-enc ON, nodeOptions OFF, cliInspect OFF, both ASAR fuses ON,
   runAsNode ON (until step 09 flips it and updates this assertion). Fail the
   release on any drift. Verdict `out/fuses-result.json`.
5. **Confirm boot is unmoved**: the integrity check is one-time at load, off
   the hot path — re-run MILESTONE, number unchanged (invariant I7).

## Files
- `package.json` (devDep) · `electron-builder.yml` (`electronFuses`) ·
  `scripts/check-fuses.mjs` · `scripts/qa-smokes.sh` + CI workflow rows ·
  `docs/adr/0015-accounts-and-entitlements.md` (caveat) · docs/18 stub

## Definition of Done
- FUSES green; the sweep count grows by one in the books.
- The packaged artifact reads the exact four-safe-fuse wall; a hand-edited
  app.asar fails to load (integrity bites).
- No `--inspect` debugger attaches to the packaged app; `NODE_OPTIONS` is
  ignored by it.

## Checks that must be green
- `npm run typecheck` → 0; `npm run build` → ok; static gates (AUDIT ·
  SPACING · PTYSEAM · PROTOVER); full sweep including FUSES; MILESTONE.

## Guardrails
- `runAsNode` stays TRUE this step — the daemon/MCP/CLI depend on it; step 09
  earns the flip. Flipping early is a review rejection.
- Signing is the operator's deferred step — this pack assumes it will happen
  and does not gate on it.
- Zero new runtime deps (fuses is dev-only); zero network; protocol stays v9.
