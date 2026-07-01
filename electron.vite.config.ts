import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

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

export default defineConfig({
  main: {
    resolve: { alias },
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } } }
  },
  preload: {
    resolve: { alias },
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } } }
  },
  renderer: {
    resolve: { alias },
    root: resolve(__dirname, 'src/renderer'),
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } } }
  }
})
