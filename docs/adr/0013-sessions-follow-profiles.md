# ADR 0013 — Sessions follow profiles

- **Status:** Accepted (2026-07-15)
- **Context:** A Phase-4 profile is a separate CLI config home (`CLAUDE_CONFIG_DIR`,
  `CODEX_HOME`, `GEMINI_CLI_HOME`) — the providers' own sanctioned way to run several
  accounts on one machine (Claude Code's docs offer nothing else: no account switcher,
  no data-dir/config-dir split, and `CLAUDE_CODE_OAUTH_TOKEN` is a token value, not a
  selector). But every CLI keeps its session transcripts *inside* that home, so each
  profile is a private session silo. The user's whole reason to hold multiple
  subscriptions is to cycle them as usage windows cap — and at exactly that moment the
  failover relaunch typed `--resume` into a home with nothing to resume. The manual
  escape (log out, log back in as the other account in the shared default home) proves
  the transcripts themselves are account-agnostic; it is also the friction this ADR
  removes.

## Decision

**Before every local agent launch, the launch home is fed the launch cwd's sessions
from the provider's other known homes** (`session-pool.ts`, invoked by the
`agents:command` handler). Whole files, copied byte-for-byte at each CLI's documented
location (claude `projects/<munged-cwd>/`, codex `sessions/YYYY/MM/DD/`, gemini
`tmp/<slug>/chats/`), newer-wins by preserved mtime, bounded to the CLI's own 30-day
retention. A resume launch that names its pane additionally resumes the pane's **exact
session by id** (`--resume <id>` / `codex resume <id>`), read from the context
monitor's locked log — a usage-limit failover continues the conversation under the
next subscription instead of opening a picker.

## Rationale

- **It stays on the providers' rails.** Separate homes per account is the documented
  multi-account mechanism; the documented session *paths* and the CLIs' own resume
  flags are the only interfaces used. Transcript *content* is never parsed or
  rewritten (the docs call the line format internal).
- **ADR 0002 is untouched.** Session logs are conversation data. Credentials
  (`.credentials.json`, `auth.json`, `oauth_creds.json`) live in the same homes and
  are structurally outside the copy set — the poolers enumerate session files only.
  Claude's `projects/<dir>/memory/` is also excluded: one account's auto-memory never
  splices into another's.
- **ADR 0007 rule 3 holds.** Sources are the provider's default home plus saved
  profile homes — known locations, never a crawl.
- **Every launch, not just resume launches.** The "new workspace on the fresh
  subscription" flow starts the CLI *fresh* and then `/resume`s inside it; pooling
  only on `--resume` launches would miss exactly that path.

## Consequences

- Cross-account resume is **proven but undocumented** behavior (the logout/login test
  is the existence proof). If a provider ever binds transcripts to accounts
  server-side, pooled sessions stop resuming there — the pooling itself is inert data
  and degrades to nothing worse than today.
- Transcripts duplicate across homes (bounded by the 30-day window). The CLIs' own
  retention grooming cleans each home independently.
- A session copied mid-write may carry a cut final line; the CLIs already tolerate
  that in their crash paths, and the next pool heals it (the source mtime moved).
- Pooling is a **courtesy, never a gate**: any filesystem failure is swallowed
  per-file and the launch proceeds — a broken pool degrades to the pre-ADR behavior,
  never to a refused launch.
- The on-disk layouts are the providers' internals-adjacent surface; a layout move in
  a future CLI version is absorbed in `session-pool.ts` (same contract as the context
  readers next door).
