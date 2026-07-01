# ADR 0004 — Layered, feature-sliced architecture

- **Status:** Accepted (2026-07-01)
- **Context:** We want to develop many features in parallel with minimal coupling,
  strong separation of concerns, and easy debugging. The product will grow large
  (terminal, layout, workspaces, agents, command-blocks, git, memory, swarm, …).

## Decision

Organize `src/` into **four layers**, with **feature slices** inside the two big ones:

```
src/
  contracts/   Shared seam: domain types + typed IPC contract. Depends on NOTHING.
  backend/     ALL Node-side logic. Electron-free. Imports only @contracts.
    core/      cross-feature infra (the BackendContext / FeatureModule registry)
    platform/  OS-specific isolation (shell, process-tree, …)
    features/  one self-contained folder per feature (terminal, agent-state, …)
  ui/          ALL renderer logic. Imports only @contracts. Never imports @backend.
    core/      bridge client + feature registry
    shell/     app chrome (titlebar, layout host)
    features/  one self-contained folder per feature (terminal, agent-state, …)
  main/ preload/ renderer/   Thin APP-WIRING. The ONLY place the two sides meet.
  pty-host/    (Phase 1) dedicated backend process home
```

Path aliases (`@contracts`, `@backend`, `@ui`) make the seams explicit and grep-able.

## Boundary rules (the whole point)

- `contracts` imports nothing from `backend`/`ui`/wiring.
- `backend` imports **only** `@contracts` (+ node/npm). Never `@ui`. Never `electron`
  (the Electron binding lives in `src/main/electron-context.ts`).
- `ui` imports **only** `@contracts` (+ browser/npm). Never `@backend`. Never `node-pty`.
- `main`/`preload`/`renderer` may import across layers — they are the composition root.
- Features never import sibling features' internals; they communicate via `@contracts`
  events/commands (e.g. the agent-state chip listens to the terminal state channel,
  it does not import the terminal feature).

Electron's process model already enforces the UI/backend runtime split; these rules
+ path aliases make the *source* boundaries match. (A boundary lint — e.g.
`eslint-plugin-boundaries` — can be added to fail CI on violations.)

## Why single package (not npm workspaces) — for now

Electron already gives a hard UI/backend wall (separate processes, IPC-only). Path
aliases + these rules deliver the rest without the build overhead of a workspaces
monorepo. **The tree maps 1:1 to future packages** (`contracts`, `backend`, `ui`,
`app`), so we can promote to real workspaces later with near-zero code movement if we
want hard package walls or independent versioning.

## Consequences

- More files/folders — deliberately. Each feature is small, owned, and testable.
- **Parallel work:** a new feature = a new folder on each side + a contract slice +
  one line in a bootstrap/registry. Central files barely change → few merge conflicts.
- `backend` is unit-testable headless (give a fake `BackendContext`); `ui` is testable
  against a fake `bridge`; the `contract` lets each side be built before the other.
- See `docs/04-adding-a-feature.md` for the step-by-step.
