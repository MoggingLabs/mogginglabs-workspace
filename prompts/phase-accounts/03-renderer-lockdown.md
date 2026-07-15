Shrink the trusted renderer's blast radius to nothing before the account
flow ships through it. Tighten the CSP that already exists, and add the
main-window navigation guard that today is MISSING — so the renderer can
never be driven to a remote page or open one.

## Steps
1. **Harden the renderer CSP** (`src/renderer/index.html:6-8`): the current
   policy is `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src
   'self' data:; script-src 'self'`. Add explicit `connect-src 'none'` (all
   network lives in main — the renderer reaches nothing directly),
   `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`, and a
   `frame-src` scoped to the webview guest partition only. Keep
   `style-src 'unsafe-inline'` (the token system needs it) — note why in a
   comment so it is not "tightened" away by mistake.
2. **Emit CSP as a response header too** (`src/main/window.ts` or the app
   session): `session.defaultSession.webRequest.onHeadersReceived` sets the
   same policy as a header on the app origin — defense in depth over the
   meta tag, which a compromised document could otherwise ignore. Scope it
   to the app's own requests; do not attach it to the webview guest session.
3. **Add the main-window navigation guard** (`src/main/window.ts` — currently
   ABSENT; guards exist only on the browser-dock guest, browser-dock.ts:178,
   187): on the main `webContents`, `setWindowOpenHandler(() => ({ action:
   'deny' }))` and a `will-navigate` + `will-redirect` handler that denies
   any navigation whose origin is not the local app origin. External links
   route through `shell.openExternal` explicitly (the account flow's only
   sanctioned outbound hop — step 04). The trusted renderer can never leave
   its page.
4. **LOCKDOWN smoke** (`MOGGING_LOCKDOWN`, env-gated, dispatch branch,
   qa-smokes.sh row): assert (a) the CSP header is present on an app request
   and includes `connect-src 'none'`; (b) a scripted `location='https://
   evil'` / `window.open` on the main renderer is DENIED (no navigation,
   no new window); (c) the webview browser dock still navigates normally
   (its own handlers untouched); (d) `shell.openExternal` still works for a
   sanctioned link. Verdict `out/lockdown-result.json`.

## Files
- `src/renderer/index.html` (CSP) · `src/main/window.ts` (header +
  navigation guard) · `src/main/lockdown-smoke.ts` · main dispatch ·
  `scripts/qa-smokes.sh` (new row)

## Definition of Done
- LOCKDOWN green; the sweep count grows by one in the books.
- The main renderer cannot be navigated or window.open'd to any remote
  origin; the CSP ships as both meta and header with `connect-src 'none'`.
- The browser dock (an intentional remote surface) is unaffected and still
  works, isolated in its own partition.

## Checks that must be green
- `npm run typecheck` → 0; build ok; static gates (AUDIT · SPACING ·
  PTYSEAM · PROTOVER); full sweep including LOCKDOWN; MILESTONE +
  PERCEPTION (renderer-touching step).

## Guardrails
- The deny applies to the TRUSTED renderer only — the out-of-process
  webview guest keeps its ADR-0002/docs-13 posture and its own handlers.
- No feature regressed: external links the app already opens still open via
  `shell.openExternal`.
- Zero new deps; zero new daemon surface; protocol stays v9.
