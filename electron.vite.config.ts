import { copyFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { ENTITLEMENT_VERIFY_PUBKEY, ORIGINS } from './src/backend/core/origins'
import { ENTITLEMENT_LIMIT_NAMES } from './src/contracts/entitlements'

// Terminals spawned by Electron-based hosts (VS Code, Claude Code desktop) leak
// ELECTRON_RUN_AS_NODE=1 into child shells. electron-vite passes its env through
// to the Electron it spawns, which then boots as PLAIN NODE: `electron.app` is
// undefined and the first main-side import that touches it (@sentry/electron's
// normalize.js) throws `Cannot read properties of undefined (reading 'getAppPath')`.
// This config module runs in the electron-vite process before Electron spawns,
// so clearing it here fixes `npm run dev` from every terminal. The daemon is
// unaffected — it runs on the standalone Node helper (ADR 0017), which ignores
// the variable like any plain node does.
delete process.env.ELECTRON_RUN_AS_NODE

// Path aliases mirror tsconfig "paths" and encode the layer seams:
//   @contracts  shared IPC + domain types (imported by BOTH sides, depends on nothing)
//   @backend    Node-side logic (bundled into the main/pty-host build only)
//   @ui         renderer-side logic (never imports @backend)
// node-pty is native and stays external (externalizeDepsPlugin); our @-aliased
// source is bundled because it resolves to file paths, not bare specifiers.
const alias = {
  '@contracts': resolve(__dirname, 'src/contracts'),
  '@backend': resolve(__dirname, 'src/backend'),
  '@ui': resolve(__dirname, 'src/ui')
}

// Interactive-dev-only CSP relax (ADR 0016 §hardening): src/renderer/index.html ships
// connect-src 'none' — the trusted renderer owns no network — which also blocks vite's
// OWN HMR websocket under `serve`. Relax JUST connect-src, JUST for a human dev run:
// never for a gate (every gate sets MOGGING_USERDATA) and never for `build`
// (transformIndexHtml only runs on the dev server, so the built html keeps the shipped
// policy byte-for-byte). src/main/window.ts applies the same relax to the CSP response
// header under the same condition, so header and meta never disagree.
const relaxCspForInteractiveDev = {
  name: 'relax-csp-for-interactive-dev',
  apply: 'serve' as const,
  transformIndexHtml(html: string): string {
    if (process.env.MOGGING_USERDATA) return html // a gate run: keep the shipped policy
    return html.replace("connect-src 'none'", 'connect-src http: ws:')
  }
}

// The other half of running gates on the shipped CSP: vite's dev client opens its HMR
// WebSocket at module evaluation, and Chromium logs the connect-src refusal as a
// console.error that the clean-console gates (RELOAD) rightly fail on. `server.hmr:
// false` does NOT stop the attempt — the client module still evaluates (the injected
// tag, and every dev-served CSS module imports its updateStyle) — so under a gate the
// client's WebSocket is SHADOWED into a no-op: no attempt, no violation, and the
// overlay/style exports stay intact. Interactive dev is untouched.
const muteViteClientSocketForGates = {
  name: 'mute-vite-client-socket-for-gates',
  apply: 'serve' as const,
  transform(code: string, id: string): string | null {
    if (!process.env.MOGGING_USERDATA || !/vite[\\/]dist[\\/]client[\\/]client\.mjs$/.test(id)) return null
    return (
      'const WebSocket = class { addEventListener(){} removeEventListener(){} send(){} close(){} };\n' + code
    )
  }
}

// 8/02: `bin/` is plain node and cannot import the TS contracts — the build
// copies the ONE tool catalog from contracts to `bin/mcp-catalog.json`. BOTH
// files are committed; the MCP smoke byte-compares them, so drift fails a gate
// instead of shipping.
const copyMcpCatalog = {
  name: 'copy-mcp-catalog',
  buildStart(): void {
    copyFileSync(
      resolve(__dirname, 'src/contracts/integrations/mcp-catalog.json'),
      resolve(__dirname, 'bin/mcp-catalog.json')
    )
  }
}

// The read-cost raiser (ADR 0016 §hardening, phase-accounts/07): the SHIPPED main process
// is V8 BYTECODE, not readable JS — `build.bytecode` below compiles the `index` chunk to
// out/main/index.jsc, leaving index.js as a three-line loader stub (same path, so
// package.json `main` and electron-builder's globs never change). Honest framing, stated
// where the knob lives: this raises the cost of READING the code from "open an editor" to
// "reverse V8 bytecode" — friction, never a wall, and never to be described as security
// (docs/19-accounts.md §honest limits). The plugin is inert under `serve`, so dev and
// every gate in scripts/qa-smokes.sh run the exact same plain-JS graph they always did.
//
//   INDEX ONLY, BY chunkAlias (ADR 0017). The daemon chunk — and the chunks it shares
//   with index — must ship as PLAIN JS: .jsc is bound to the exact V8 that compiled it
//   (Electron's), and since the runtime split the daemon is hosted by the standalone
//   Node helper, whose V8 is the pinned Node's. A bytecode daemon under the helper is a
//   boot crash. The friction claim narrows accordingly and docs/18 says so; the pinned
//   constants below live in the index graph, which stays compiled (check-bytecode.mjs
//   asserts BOTH sides: index.jsc real bytecode, daemon.js readable, constants nowhere).
//
//   MAIN ONLY. Preload bytecode requires `sandbox: false`, and we ship `sandbox: true`
//   (src/main/window.ts) — we do not trade a real hardening win for a deterrent; the
//   preload is 44 lines of allowlist glue with nothing to hide. Renderer is unsupported
//   by the plugin and stays behind the shipped CSP.
//
//   PER-ARCH BY CONSTRUCTION. The compile spawns the LOCAL node_modules Electron as Node,
//   so the .jsc is bound to that exact V8 version + CPU arch. Every build-matrix row
//   (win-x64, mac-arm64, linux-x64) runs `npm run build` on its own runner and compiles
//   its own — never package one arch's out/ into another arch's artifact.
//
//   STRINGS ARE NOT HIDDEN BY BYTECODE. V8 keeps string literals readable in the .jsc
//   constant pool, so the sensitive constants — the pinned entitlement verify key, the
//   origin table, the limit names — are additionally rewritten to String.fromCharCode
//   via `protectedStrings`. That makes them harder to LOCATE, not secret; the values are
//   imported from their single sources of truth so the list cannot drift.
//
// scripts/check-bytecode.mjs is the gate: out/main ships bytecode, the preload ships
// readable source with the sandbox intact, and none of these constants greps in plain text.
const protectedStrings = [
  ENTITLEMENT_VERIFY_PUBKEY.ed25519Pem,
  ...Object.values(ORIGINS),
  ...ENTITLEMENT_LIMIT_NAMES
]

// The main entry is chosen by COMMAND, and that is the whole of audit finding 41's fix.
//
//   command === 'build'  →  src/main/index.ts       production: boot.ts and nothing else
//   command === 'serve'  →  src/main/index.dev.ts   dev/test:   boot.ts PLUS the smoke harness
//
// `npm run dev` (electron-vite dev — what every gate in scripts/qa-smokes.sh runs) is `serve`;
// `npm run build` and `npm run dist*` are `build`, and electron-builder packages what `build`
// produced. So the ~100 harness modules, the SMOKE_ENV allowlist and the MOGGING_<GATE> dispatcher
// are simply not in the shipped module graph — while dev keeps every gate it ever had.
//
// Code-splitting was NOT an option: electron-builder.yml globs `out/main/**/*` into app.asar, so
// rollup's chunks would have shipped anyway, and the trigger strings + dispatcher would still have
// sat in index.js (they are what DECIDES whether to import a chunk). Only leaving the harness out
// of the entry's graph removes it. scripts/check-prod-artifact.mjs builds this entry and fails on
// any harness symbol or gate trigger string that reaches the bundle.
//
// Both keep the rollup input KEY `index`, so both emit out/main/index.js and nothing downstream
// (package.json `main`, electron-builder's files globs) changes.
export default defineConfig(({ command }) => ({
  main: {
    resolve: { alias },
    plugins: [externalizeDepsPlugin(), copyMcpCatalog],
    // Two entries: the Electron main process AND the detached PTY daemon (ADR 0006).
    // The daemon (out/main/daemon.js) is launched via Electron-as-Node; it imports no
    // electron APIs, so it bundles clean. node-pty stays external for both.
    build: {
      sourcemap: true, // uploaded to Sentry on release so crash stacks de-minify (ADR 0005)
      // Build-only; inert under `serve` (see the block above). transformArrowFunctions
      // OFF: the babel arrow transform cannot handle `this`-capturing arrows in class
      // fields (workspace controllers use them) and exists for a long-fixed V8 lazy-
      // compile bug — Electron 39's V8 compiles arrows into cached data under --no-lazy.
      // Not taken on faith: check-bytecode.mjs compiles and EXECUTES a fixture carrying
      // exactly these constructs through the same compiler on every run.
      // chunkAlias 'index': ONLY the Electron-hosted entry compiles — the daemon graph
      // runs under the standalone Node helper (ADR 0017), a different V8.
      bytecode: { chunkAlias: ['index'], protectedStrings, transformArrowFunctions: false },
      rollupOptions: {
        input: {
          index: resolve(__dirname, command === 'build' ? 'src/main/index.ts' : 'src/main/index.dev.ts'),
          daemon: resolve(__dirname, 'src/pty-daemon/index.ts')
        }
      }
    }
  },
  preload: {
    resolve: { alias },
    plugins: [externalizeDepsPlugin()],
    build: { sourcemap: true, rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } } }
  },
  renderer: {
    resolve: { alias },
    root: resolve(__dirname, 'src/renderer'),
    plugins: [relaxCspForInteractiveDev, muteViteClientSocketForGates],
    // Gates additionally get NO HMR server: an HMR apply mid-gate rewrites the app
    // under the assertion (the sweep's oldest flake source). The client-side attempt
    // is muted by the plugin above. Interactive dev keeps both.
    ...(process.env.MOGGING_USERDATA ? { server: { hmr: false } } : {}),
    build: { sourcemap: true, rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } } }
  }
}))
