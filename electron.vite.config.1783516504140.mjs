// electron.vite.config.ts
import { copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
var __electron_vite_injected_dirname = "C:\\Users\\pedro\\Documents\\GitHub\\MoggingLabs-Workspace";
var alias = {
  "@contracts": resolve(__electron_vite_injected_dirname, "src/contracts"),
  "@backend": resolve(__electron_vite_injected_dirname, "src/backend"),
  "@ui": resolve(__electron_vite_injected_dirname, "src/ui")
};
var copyMcpCatalog = {
  name: "copy-mcp-catalog",
  buildStart() {
    copyFileSync(
      resolve(__electron_vite_injected_dirname, "src/contracts/integrations/mcp-catalog.json"),
      resolve(__electron_vite_injected_dirname, "bin/mcp-catalog.json")
    );
  }
};
var electron_vite_config_default = defineConfig({
  main: {
    resolve: { alias },
    plugins: [externalizeDepsPlugin(), copyMcpCatalog],
    // Two entries: the Electron main process AND the detached PTY daemon (ADR 0006).
    // The daemon (out/main/daemon.js) is launched via Electron-as-Node; it imports no
    // electron APIs, so it bundles clean. node-pty stays external for both.
    build: {
      sourcemap: true,
      // uploaded to Sentry on release so crash stacks de-minify (ADR 0005)
      rollupOptions: {
        input: {
          index: resolve(__electron_vite_injected_dirname, "src/main/index.ts"),
          daemon: resolve(__electron_vite_injected_dirname, "src/pty-daemon/index.ts")
        }
      }
    }
  },
  preload: {
    resolve: { alias },
    plugins: [externalizeDepsPlugin()],
    build: { sourcemap: true, rollupOptions: { input: { index: resolve(__electron_vite_injected_dirname, "src/preload/index.ts") } } }
  },
  renderer: {
    resolve: { alias },
    root: resolve(__electron_vite_injected_dirname, "src/renderer"),
    build: { sourcemap: true, rollupOptions: { input: { index: resolve(__electron_vite_injected_dirname, "src/renderer/index.html") } } }
  }
});
export {
  electron_vite_config_default as default
};
