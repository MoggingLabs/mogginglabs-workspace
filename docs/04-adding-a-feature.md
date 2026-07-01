# 04 · Adding a feature (the parallel-work playbook)

Every feature touches its own folders plus three tiny shared edits. Two people
adding two features rarely touch the same lines.

## Steps

1. **Contract slice** — `src/contracts/ipc/<feature>.ipc.ts`
   - Define command payloads (UI→backend) and event payloads (backend→UI).
   - Add `<Feature>Channels` in `src/contracts/ipc/channels.ts` and spread it into
     `AllChannels`. Re-export from `src/contracts/ipc/index.ts`.
   - *(This is the contract both sides code against — write it first.)*

2. **Backend** — `src/backend/features/<feature>/`
   - `*.service.ts` — pure logic (no Electron). Unit-test with a fake sink.
   - `<feature>.module.ts` — a `FeatureModule` that registers handlers on the
     `BackendContext` and emits events.
   - `index.ts` — export the module factory.
   - Register it in `src/backend/bootstrap.ts` (one line).

3. **UI** — `src/ui/features/<feature>/`
   - `<feature>.client.ts` — typed wrapper over `getBridge()` using the contract.
   - components/logic — render + interact.
   - `index.ts` — export a `UiFeature` (`mount(ctx)`).
   - Register it in `src/ui/index.ts` (one line).

## Rules of thumb

- **Never** import another feature's internals. Need cross-feature data? Put it on
  the `@contracts` wire, or lift shared state into `core/`.
- **Backend stays Electron-free**; UI stays `@backend`-free and `node-pty`-free.
- If a feature has no UI-facing IPC (like `agent-state` today), it can be a plain
  library consumed by another feature — not every feature owns channels.

## The three shared touch points (kept intentionally tiny)

- `contracts/ipc/channels.ts` → add channels to `AllChannels`.
- `backend/bootstrap.ts` → add the backend module.
- `ui/index.ts` → register the UI feature.

Later these can become auto-discovery (filesystem globbing) so even they disappear.
