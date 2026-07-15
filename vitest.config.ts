import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Unit tests for the PURE modules (the review's missing-fast-tier finding): the
// Electron-boot gates in scripts/qa-smokes.sh remain the system safety net; this tier
// answers in seconds what those answer in minutes, for logic that needs no window —
// pace math, codec editing, secret redaction, shell quoting. Aliases mirror
// tsconfig.json's paths so tests import production modules exactly as the app does.
const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@contracts$/, replacement: r('./src/contracts/index.ts') },
      { find: /^@contracts\/(.*)$/, replacement: r('./src/contracts') + '/$1' },
      { find: /^@backend$/, replacement: r('./src/backend/index.ts') },
      { find: /^@backend\/(.*)$/, replacement: r('./src/backend') + '/$1' },
      { find: /^@ui$/, replacement: r('./src/ui/index.ts') },
      { find: /^@ui\/(.*)$/, replacement: r('./src/ui') + '/$1' }
    ]
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node'
  }
})
