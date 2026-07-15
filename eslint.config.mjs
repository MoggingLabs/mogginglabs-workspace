import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

// The linter the codebase's own `eslint-disable` comments always claimed to have —
// three files carried disables no linter ever read (the review's vestige finding; those
// comments are gone now, and unused directives are errors below so new ones can't
// accrete). Scope: the recommended sets, syntax-only — no type-aware rules, so
// `npm run lint` stays fast enough to run in the sweep.
//
// Tuning below is deliberate, not silencing: each `off`/`option` names the house idiom
// it protects. New rules earn their way in by catching something real.
export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'dist/**',
      'release/**',
      '.claude/**',
      'packaging/**'
    ]
  },
  {
    // Vestigial disables were the finding that brought this file into existence;
    // erroring on unused directives keeps them from growing back.
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      // This is a TERMINAL EMULATOR. Regexes over \x00–\x1f (ANSI stripping, OSC
      // parsing, control-byte quoting) are the domain, at ~40 sites — the rule fights
      // the app's whole subject matter, so it is off rather than disabled inline 40x.
      'no-control-regex': 'off',
      // House idiom: `let x = fallback` before a try that assigns it — the fallback
      // IS the story when the try throws. The rule calls each one useless (~100
      // sites); it is wrong about this codebase.
      'no-useless-assignment': 'off',
      // House idiom: `let x` declared up front, read inside closures defined above the
      // single assignment (menu handles, subscription cleanups). `ignoreReadBeforeAssign`
      // keeps those; `destructuring: 'all'` skips pairs where one half IS reassigned.
      'prefer-const': ['error', { destructuring: 'all', ignoreReadBeforeAssign: true }],
      // The codebase is intentionally underscore-free for unused vars EXCEPT catch
      // bindings and destructure-rest, which the style uses to drop fields.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }
      ],
      // `require()` appears only in the two CJS preload/daemon seams where ESM cannot
      // load yet; those files justify themselves inline.
      '@typescript-eslint/no-require-imports': 'off',
      // Empty catch = deliberate "best-effort, failure is fine" — the house style
      // annotates each with a comment; an empty BLOCK elsewhere is still an error.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // `{}`-typed accumulators and `as any` escapes are used at a handful of codec
      // seams; `any` stays visible (warn) without failing the sweep on the backlog.
      '@typescript-eslint/no-explicit-any': 'warn',
      // xterm/electron callbacks are frequently declared () => void but implemented
      // async for awaits inside; TS already checks the contract.
      '@typescript-eslint/no-misused-promises': 'off',
      // Namespaces appear only as `declare global` bridges for window.* dev handles.
      '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }]
    }
  },
  {
    // Node scripts outside the bundler graph: gate/build scripts, the bin shims,
    // agent hook plugins, and the catalog compiler. They see Node globals, not the DOM.
    files: ['scripts/**', 'bin/**', 'hooks/**', 'electron.vite.config.ts', 'src/backend/features/agent-settings/catalog/*.mjs'],
    languageOptions: { globals: globals.node }
  }
)
