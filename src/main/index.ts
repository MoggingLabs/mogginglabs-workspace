import { bootMain, prepareRuntime } from './boot'

// THE PRODUCTION ENTRY. Everything it does is in boot.ts; what matters here is what it does NOT
// import (audit finding 41).
//
// This file used to be the only entry, and it carried the test harness: ~100 `import { runXxxSmoke }
// from './xxx-smoke'`, the gallery/shot capture, the SMOKE_ENV allowlist and an 86-branch
// MOGGING_<GATE> dispatcher. All of it was reachable in the shipped app.asar — a third of
// out/main/index.js was a test rig that a user's machine downloaded, scanned, and loaded into the
// main process on every launch, and any of it could be woken by an environment variable.
//
// Code-splitting would NOT have fixed that: electron-builder globs `out/main/**/*` into the asar,
// so rollup's chunks would ship anyway — and the trigger STRINGS and the dispatcher would still be
// right here, because they are what DECIDES whether to load a chunk. The only fix is for the
// harness to not be in this entry's module graph at all.
//
// So there are two entries over one boot sequence:
//   src/main/index.ts      (this file)  production — boot.ts, and nothing else
//   src/main/index.dev.ts               dev/test  — boot.ts PLUS the harness, hooked in at the
//                                                   two points boot.ts exposes
// electron.vite.config.ts picks by command: `build` (npm run build / dist) takes index.ts; `serve`
// (npm run dev — which every gate in scripts/qa-smokes.sh runs) takes index.dev.ts. Both emit
// out/main/index.js, so nothing downstream (package.json `main`, electron-builder) changes.
//
// scripts/check-prod-artifact.mjs is the lock: it builds THIS entry and fails if a single
// harness symbol or MOGGING_<GATE> trigger string reaches the bundle.
//
// MOGGING_USERDATA / MOGGING_CHANNEL / MOGGING_CI_KEYRING stay (in prepareRuntime): they are
// runtime knobs — state isolation, the dev/prod channel split, and the Linux CI keyring — not
// harness code, and the daemon and CLIs read them by inheritance.

prepareRuntime() // userData + channel + inherited-pane scrub, before anything derives a path
bootMain() // no hooks, no harness: take the lock, register the deep link, init auto-update
