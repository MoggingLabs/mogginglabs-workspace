---
name: verify
description: How to run one env-gated smoke against the live app to verify a change (launch recipe, traps, teardown)
---

# Verifying a change against the running app

The smokes in `src/main/*-smoke.ts` boot the REAL app and drive it via
`webContents.executeJavaScript` — they are the fastest runtime handle. Gate env
vars are dispatched in **`src/main/index.dev.ts`**: `MOGGING_STATE=1`,
`MOGGING_SMOKE=1`, `MOGGING_MULTIPANE=1`, … Verdict is `out/<name>-result.json`
(`pass: true`), never the exit code.

`index.DEV.ts`, not `index.ts` — the harness is not in the shipped app (audit
finding 41). There are two entries over one `src/main/boot.ts`, and
electron-vite picks by command: `serve` (i.e. `npm run dev`) gets
`index.dev.ts` + every gate; `build` gets the production `index.ts`, which
dispatches nothing. Add a new gate to `index.dev.ts` — `scripts/check-gates.mjs`
reconciles it against the sweep, and `scripts/check-prod-artifact.mjs` fails the
build if it ever lands in the production entry.

## Launch one gate directly (no qa-smokes.sh, no sweep teardown)

```bash
iso="$LOCALAPPDATA/Temp/claude/<name>" && mkdir -p "$iso/userdata" "$iso/local"
env -u ELECTRON_RUN_AS_NODE -u ELECTRON_CLI_ARGS -u ELECTRON_EXEC_PATH -u NODE_ENV_ELECTRON_VITE \
  MOGGING_USERDATA="$iso/userdata" LOCALAPPDATA="$iso/local" XDG_RUNTIME_DIR="$iso/local" \
  MOGGING_MACHINE_MB=65536 MOGGING_MACHINE_CORES=16 \
  MOGGING_STATE=1 timeout 150 npm run dev > "$iso/gate.log" 2>&1
```

- **Must be `npm run dev`** (electron-vite dev). `npm run start` / preview boots
  the production bundle where the renderer drive hooks (`window.__mogging`,
  `window.bridge` test surface) are absent — the smoke reports `chip: null`,
  zero state events — and the production CSP blocks a data: font, which lands a
  `console.error` that fails any smoke counting errors.
- `MOGGING_USERDATA` (any value) also bypasses the single-instance lock.
- `MOGGING_MACHINE_MB/CORES` pin the pane budget's machine (the canonical
  64 GiB / 16-core harness world, matching qa-smokes.sh): without them, dense
  fixtures clamp to the REAL box — a 16-pane gate goes red on small machines
  for the hardware, not the product.
- electron-vite dev RESPAWNS electron after the smoke's `app.exit()`, so the
  command only ends when `timeout` kills it; the result JSON lands much earlier
  (~60s) — poll for it instead of waiting.

## Teardown — surgical, never by image name

The isolated run leaves a detached PTY daemon (mogging-node.exe — the standalone
helper, ADR 0016 — running daemon.js). Kill ONLY yours, via its endpoint:

```bash
ep=$(ls "$iso"/local/MoggingLabs/run/v*/endpoint.json | head -1)
# stdin + node-side kill: node resolves a git-bash /tmp/... argv path drive-relatively
# (C:\tmp\..., reads nothing), and git-bash `kill` can't signal native pids — either
# trap silently leaks the daemon.
node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const p=JSON.parse(s).pid;process.kill(p);console.log('killed',p)})" <"$ep"
```

`taskkill //IM electron.exe` or `pkill -f electron` kills the user's REAL
daemons and live agent sessions — never do it.

## Extra evidence (colors, pixels)

Smokes assert DOM attributes, not rendered style. For visual claims, temp-edit
the smoke: add `getComputedStyle(el)` fields to its DOM reads and crop-capture
with `wc.capturePage(rectFromGetBoundingClientRect)` → PNG. Revert the temp
edit after collecting evidence.
