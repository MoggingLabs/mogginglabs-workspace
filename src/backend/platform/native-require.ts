// HOW A NATIVE MODULE FINDS ITS ABI-MATCHED BINARY (ADR 0017 — the runtime split).
//
// The app's node_modules natives (node-pty, better-sqlite3) are compiled against
// ELECTRON's ABI (postinstall / rebuild:native). Since the runtime split, the detached
// PTY daemon no longer runs inside that ABI: it is hosted by the standalone Node helper,
// which carries its OWN deps built for its own pinned Node
// (build/node-helper/<platform>-<arch>/node_deps/, scripts/build-node-helper.mjs). One
// package name, two incompatible binaries — so the require must pick by HOST, not by path:
//
//   under the helper    plain node + MOGGING_HELPER_NATIVES in the spawn env (set by
//                       daemon-client on the daemon spawn) → the helper's deps dir. We
//                       resolve the two packages by EXPLICIT absolute path, because the
//                       ordinary node_modules walk from the (asar-unpacked) daemon.js
//                       would find the ELECTRON-ABI copies first — a NODE_MODULE_VERSION
//                       crash at first open. Their transitive bare deps (better-sqlite3's
//                       `bindings`) resolve via NODE_PATH=<deps>, which the daemon spawn
//                       also sets — the deps dir is npm-flattened, so everything sits at
//                       its top level.
//   under Electron      (main process, in-proc fallback) → resolve normally, exactly
//                       as before the split.
//
// The env var alone is never trusted: `process.versions.electron` guards the branch, so
// a leaked MOGGING_HELPER_NATIVES can never repoint the Electron app's own natives.
import { createRequire } from 'node:module'
import * as path from 'node:path'

/** Value-require one of the two ABI-bound natives from the module tree that matches THIS
 *  host. node-pty additionally stays behind the pty-host chokepoint: check-pty-seam.mjs
 *  treats this seam as a value-require too, so pulling a pty through it is allowed in
 *  pty-host.ts and nowhere else. */
export function requireNative<T>(name: 'node-pty' | 'better-sqlite3'): T {
  const helperDeps = process.env.MOGGING_HELPER_NATIVES
  if (helperDeps && !process.versions.electron) {
    // Absolute path into the helper's deps dir — never the node_modules walk (it would
    // hit the Electron-ABI copies). The anchor file need not exist.
    const req = createRequire(path.join(helperDeps, 'native-require-anchor.js'))
    return req(path.join(helperDeps, name)) as T
  }
  return createRequire(__filename)(name) as T
}
