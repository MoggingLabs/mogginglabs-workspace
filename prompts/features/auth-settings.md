# Master Prompt — Settings-driven agent-CLI authentication ("Accounts")

> **When:** a Phase-1+ feature (roadmap Phase 4, "multi-profile account switching"). Run
> AFTER `prompts/phase-0/` is green. Self-contained; same format as the phase-0 prompts.
>
> **READ FIRST:** `docs/adr/0002-never-broker-provider-auth.md`. This feature must
> ORCHESTRATE each CLI's own login. It must NEVER see, store, inject, or proxy provider
> credentials. Getting this wrong = account bans (Anthropic blocked OpenClaw for exactly
> this; Google banned Gemini token-proxying; revChatGPT users terminated — see
> `docs/03-research-synthesis.md`).

## Goal
A **Settings -> "Accounts"** page that lets a user sign each hosted agent CLI (Claude
Code, Codex, Gemini) into their OWN provider account from one place — so they never have
to run login commands by hand in each terminal. The user adds an account by **email** and
clicks **Sign in**; the app launches that CLI's **native login flow** (its own
OAuth/browser/device flow) in a managed background PTY, watches for completion, and shows
live per-CLI auth status. Afterwards, the CLI persists its own session and every pane that
runs it is already authenticated.

**What the email actually is (be precise):** a human-readable **account label + hint** —
used to show "signed in as", to pass to a CLI's login command where it supports one, and
to warn on mismatches. **The email does not authenticate anything by itself.** The
provider authenticates the user through its own consent flow. We persist the label; never
the secret.

## Compliance reframe (non-negotiable — ADR 0002)
- ALLOWED: launch/trigger the CLI's own `login`/OAuth/device flow; read auth **status**
  (signed-in yes/no + account label) WITHOUT reading secret contents; orchestrate which
  account/profile is active; open the provider's browser consent via `shell.openExternal`.
- FORBIDDEN: collecting the user's password/token in our UI or DB; piping credentials into
  a CLI to bypass its login; proxying/pooling/reselling provider access; "silent" auth
  that skips provider consent.
- The provider's browser/OAuth step is REQUIRED and correct — it is the provider
  authenticating the user, not us. "Automatic / in the background" here means we DETECT
  status and ONE-CLICK-LAUNCH the native flow — never that we inject credentials.

## Prerequisites / current state
- Phase 0 green: a real CLI already runs as a TUI in a pane and self-authenticates
  (proven in `prompts/phase-0/03`).
- Seams available: `@contracts` IPC; `backend/features/*` (Electron-free);
  `ui/features/*`; `src/main` app-wiring; the `terminal` feature + `PtyService`.
- `src/backend/features/agents/` is the reserved home for per-CLI adapters (README stub).

## Steps
1. **Per-CLI auth adapters** — `src/backend/features/agents/adapters/{claude,codex,gemini}.ts`
   (+ `registry.ts`). Each is pure/Electron-free and declares: `id`, display name,
   `detect()` (installed?), a **status probe** (command/heuristic that reports signed-in +
   account label WITHOUT reading secret file contents), `loginCommand(emailHint?)`,
   `logoutCommand`, and how to detect login success/failure from PTY output/exit/OSC.
   Research the real commands at impl time (e.g. Claude Code interactive login or
   `claude setup-token`; `codex login`; `gemini` Google OAuth). Only presence/status — never
   secret contents.
2. **Accounts service (backend)** — `src/backend/features/accounts/`. A persisted registry
   of entries `{ id, provider, cliId, emailLabel, status, lastCheckedAt }` (NO secrets).
   Methods: `list`, `add(emailLabel, cliId)`, `remove`, `refreshStatus` (runs each adapter
   probe), `startLogin(accountId)` (runs the adapter's login in a MANAGED PTY, streams
   progress), `signOut(accountId)`. Persist labels/status to the workspace store
   (SQLite/JSON) — never credentials.
3. **Managed login PTY** — reuse `PtyService` (or a dedicated auth PTY) to run login
   commands in a managed session whose output the Settings UI surfaces (or a temporary
   visible pane). If the CLI prints an OAuth URL, open it with `shell.openExternal`
   (app-layer, `src/main`). Detect completion via exit code / success marker / OSC, then
   `refreshStatus`.
4. **Contracts** — `src/contracts/ipc/accounts.ipc.ts` + `AccountsChannels`
   (list/add/remove/refresh/startLogin/signOut + status/progress events); add to
   `AllChannels`.
5. **Settings/Accounts UI** — `src/ui/features/settings/`. A Settings surface with an
   "Accounts" panel: one card per CLI showing installed + auth status ("Signed in as X" /
   "Not signed in"), an "Add account" email input + "Sign in" button (calls `startLogin`,
   shows live progress), and "Sign out". Non-blocking. Add a settings entry point (gear
   icon) to `src/ui/shell/titlebar.ts`.
6. **Auto pre-flight ("background")** — on app start / workspace open, call `refreshStatus`;
   if a CLI the workspace will use is not signed in, surface a non-blocking banner linking
   to Settings -> Sign in. Never auto-inject credentials; at most auto-open the native
   login on explicit user opt-in.
7. **Active profile (optional, roadmap)** — let a pane choose which signed-in account it
   uses (orchestrate the CLI's profile/env selection), still never handling secrets.

## Files
- `src/backend/features/agents/adapters/{claude,codex,gemini}.ts`, `registry.ts`
- `src/backend/features/accounts/{accounts.service.ts,accounts.module.ts,index.ts}`
- `src/contracts/ipc/accounts.ipc.ts`; edit `channels.ts` (+ `AllChannels`), `ipc/index.ts`
- `src/ui/features/settings/**` (panel, account cards, client), `src/ui/shell/titlebar.ts`
- `src/main/` — `shell.openExternal` for OAuth URLs + any electron-only auth bits (keep
  `@backend` Electron-free)
- `src/backend/features/terminal/pty.service.ts` (managed login PTY, if reused)
- `docs/adr/0002-never-broker-provider-auth.md` (reference)

## Definition of Done
- Settings -> Accounts lists each installed CLI with accurate **auth status**.
- Adding an account by email + clicking **Sign in** launches that CLI's **own** native
  login (browser/OAuth); on completion the status flips to "Signed in as …" — the app
  never touching a credential.
- A pane that then runs that CLI is authenticated (no manual terminal login).
- The persisted store contains **only** labels/status/timestamps — **no secrets** (verify
  the schema + data).
- Sign out works.
- ADR 0002 upheld: review + grep show no credential collection/storage/injection/proxy.

## Checks that must be green
- `npm run typecheck` -> exit 0
- `npm run build` -> succeeds
- Boundary: `@backend` imports no `electron`; no vendor auth SDKs anywhere.
- **Secret audit**: grep the accounts/settings paths — no `password`/`token`/`apiKey`
  capture or persistence; the persisted schema has no secret fields.
- Functional (env-gated smoke, like `MOGGING_SMOKE`/`MOGGING_AGENT`): Settings renders;
  the status probe returns a real result for the installed `claude`; `startLogin` invokes
  the native flow (assert the login command ran / the flow UI appears) without asserting a
  full browser OAuth in CI.
- Manual on this machine: already-signed-in `claude` shows "Signed in as <user>"; a
  signed-out CLI shows "Not signed in" and Sign in launches its flow.

## Guardrails / non-goals
- **Never broker provider auth (ADR 0002).** No passwords/tokens in our UI or DB; no
  credential injection to bypass a CLI's login; no proxying/pooling/reselling; no
  consent-skipping "silent" auth.
- The email is a label + hint, not a credential — don't imply it authenticates by itself.
- API-key-only CLIs (e.g. Aider, or `GEMINI_API_KEY` usage): v1 does NOT store keys. If key
  convenience is added later, keep keys ONLY in the OS keychain (Electron `safeStorage` /
  OS vault), injected as env at spawn, clearly disclosed — never in our own DB/plaintext.
  Treat as a separate, opt-in decision (see Open questions).
- Keep `@backend` Electron-free; `shell.openExternal` + electron-only bits live in `src/main`.

## Open questions / risks
- Per-CLI status-probe + login commands change over time — keep adapters easy to update;
  prefer official documented commands; never scrape secret files.
- "Automatic in the background" is bounded by provider consent — set expectations that the
  first sign-in needs the user's one-time browser step.
- Non-interactive tokens (e.g. `claude setup-token`) are convenient but are still the
  user's secret held by the CLI, not us — never capture the token value.
- Multi-user machines / profile isolation.

## Roadmap link
Implements `docs/02-mvp-and-roadmap.md` Phase 4: "multi-profile account switching +
usage-limit failover (orchestrating which CLI profile is active — still never brokering
auth)."
