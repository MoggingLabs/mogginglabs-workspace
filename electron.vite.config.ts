import { copyFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// Terminals spawned by Electron-based hosts (VS Code, Claude Code desktop) leak
// ELECTRON_RUN_AS_NODE=1 into child shells. electron-vite passes its env through
// to the Electron it spawns, which then boots as PLAIN NODE: `electron.app` is
// undefined and the first main-side import that touches it (@sentry/electron's
// normalize.js) throws `Cannot read properties of undefined (reading 'getAppPath')`.
// This config module runs in the electron-vite process before Electron spawns,
// so clearing it here fixes `npm run dev` from every terminal. The daemon is
// unaffected — daemon-client sets ELECTRON_RUN_AS_NODE on its OWN spawn env.
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

export default defineConfig({
  main: {
    resolve: { alias },
    plugins: [externalizeDepsPlugin(), copyMcpCatalog],
    // Two entries: the Electron main process AND the detached PTY daemon (ADR 0006).
    // The daemon (out/main/daemon.js) is launched via Electron-as-Node; it imports no
    // electron APIs, so it bundles clean. node-pty stays external for both.
    build: {
      sourcemap: true, // uploaded to Sentry on release so crash stacks de-minify (ADR 0005)
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
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
    build: { sourcemap: true, rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } } }
  }
})
