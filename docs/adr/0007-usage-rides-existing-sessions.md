# ADR 0007 — Usage meters ride the sessions the CLIs already own

- **Status:** accepted (Phase 7/01, 2026-07-06)
- **Extends:** ADR 0002 (never broker provider auth) · companion to ADR 0005
  (telemetry: ids/booleans only)

## Context

The app orchestrates subscription-metered agent CLIs all day; Phase 7 adds
usage meters (session/weekly windows, pace verdicts). Every design that
shows usage needs a provider token — and every path to a token except one
violates the product's identity ("your keys, your CLIs — we broker
nothing"). The one path that doesn't: the CLIs the user already runs have
already stored their own sessions, in their own homes, with the user's own
consent. The reference menu-bar app proves account switching works with
pure POINTERS — no credential ever moves.

## Decision

1. **Usage adapters read the token/session the provider's OWN CLI already
   stores** — the credential file (or OS keychain entry) under that CLI's
   config home. The token is held **in memory for the one usage request**
   and then dropped.
2. **A profile (Phase-4 pointer set) selects WHICH config home is read**
   (e.g. `CLAUDE_CONFIG_DIR=~/.claude-work`). Switching accounts = reading
   a different home. Credentials never move, copy, or transform.
3. **Adapters read KNOWN per-CLI locations only** — a per-OS path table.
   No filesystem crawling, no guessing, no scanning for token-shaped files.
4. **Explicitly forbidden, forever:**
   - caching a token beyond the single request (no memoization, no
     "session" object holding it);
   - writing to ANY CLI's store, ever, for any reason;
   - logging, displaying, copying, or transporting a token — it may not
     appear in errors, result JSONs, IPC payloads, or dev tooling output;
   - usage VALUES in telemetry (ADR 0005 companion): plan names, percents,
     reset times, and account identifiers never leave the machine — events
     carry counts and booleans only.
5. **Degradation is labeled, not thrown**: no CLI → `unconfigured`;
   logged-out or expired → `error` with a human `reason`. The UI renders
   states; adapters never surface exceptions.
6. **Smokes never touch a real adapter.** Under any usage smoke env the
   registry holds ONLY the FAKE adapter (fixtures); zero network is
   structural. Real adapters are dev-verified manually and recorded in the
   books.

## Consequences

- The app needs no OAuth flow, no keychain writes, no secret storage —
  the attack surface a usage feature usually adds simply doesn't exist.
- Provider endpoint/shape drift degrades a meter to `error` with a reason
  — it can never corrupt a session (we only ever READ).
- macOS reads the CLI's Keychain entry via `security(1)` on explicit
  refresh only (a read of the CLI's own store, the same boundary) — never
  speculatively at boot, so the user's first Keychain prompt has context.
- The daemon protocol stays at v3: usage lives in the app backend; panes
  carry zero new wire surface.
