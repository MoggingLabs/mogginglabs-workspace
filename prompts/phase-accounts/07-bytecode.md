Raise the cost of READING the code from "open in an editor" to "reverse V8
bytecode." Compile the main process to bytecode and obfuscate the sensitive
constants — MAIN ONLY, because bytecode for preload would force
`sandbox:false`, and we do not trade away a real hardening win for a
deterrent. Honest framing: friction, not a wall.

## Steps
1. **Enable electron-vite `bytecodePlugin` for the MAIN build only**
   (`electron.vite.config.ts`, the `main` block): the shipped `out/main/*`
   ships as V8 bytecode, not readable JS. Do NOT enable it for `preload` —
   bytecode there requires `sandbox:false`, but we ship `sandbox:true`
   (window.ts:49), and the preload is 44 lines of allowlist glue with
   nothing to hide (preload/index.ts). Renderer stays as-is behind the CSP
   (step 03).
2. **String-obfuscate the sensitive constants** (the plugin's string
   transform, scoped to `account.ts` / `entitlements.ts` / `origins.ts`):
   bytecode hides LOGIC, not strings — the pinned Ed25519 public key, the
   origin table, and feature/limit keys would otherwise stay greppable.
   Obfuscation makes them harder to locate, not secret; note this limit in
   docs/18 so it is never oversold internally.
3. **Per-arch build wiring**: bytecode is bound to the exact V8 version + CPU
   arch, so each platform/arch artifact compiles its own — fold the compile
   step into the existing build matrix (win-x64, mac-arm64/x64, linux-x64).
   Confirm `PRODARTIFACT` still passes: the harness stays out of the graph
   and the bytecode'd entry emits `out/main/index.js` unchanged in path
   (electron.vite.config.ts:41-58).
4. **Confirm zero perf/functional regression**: bytecode has ~zero runtime
   cost (slight startup improvement per the plugin) — re-run MILESTONE
   (unchanged or better, I7) and a full targeted sweep to prove the app
   behaves identically. The daemon entry (`out/main/daemon.js`) also builds
   clean under the plugin (it imports no Electron APIs).
5. **BYTECODE artifact gate** (`scripts/check-bytecode.mjs`, static,
   qa-smokes.sh + CI): assert (a) `out/main/*` shipped files are V8 bytecode
   (magic/format check), NOT plain JS source; (b) the preload is NOT bytecode
   and `sandbox:true` is intact; (c) the entitlement public key / origins do
   not appear as plain readable strings in the main bundle. Verdict
   `out/bytecode-result.json`.

## Files
- `electron.vite.config.ts` (main-only bytecode + string transform) ·
  build matrix rows · `scripts/check-bytecode.mjs` · `docs/18-accounts.md`
  (honest-limit note) · qa-smokes.sh + CI

## Definition of Done
- BYTECODE green; the sweep count grows by one.
- Shipped `out/main/*` is bytecode; preload is untouched source with
  `sandbox:true`; entitlement constants are not plainly greppable.
- Every gate still green and MILESTONE unchanged — behavior identical.

## Checks that must be green
- `npm run typecheck` → 0; `npm run build` (all arches) → ok; `PRODARTIFACT`
  green; static gates; full sweep + BYTECODE; MILESTONE.

## Guardrails
- MAIN only — the sandboxed preload is a hardening win we keep.
- Bytecode is a speed bump, described as one — never as security.
- Per-arch, matches the build matrix; zero new runtime deps; protocol v9.
