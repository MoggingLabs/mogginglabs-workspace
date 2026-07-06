# 12 · Usage meters

> Seeded in Phase 7/11 with the CLI reference; 7/13 grows this into the full
> usage doc (the five adapter classes, the CodexBar parity map, and the
> provider authoring guide). Until then: `docs/adr/0007*.md` hold the auth
> stance, `docs/research/2026-07-codexbar-parity.md` the parity map, and
> `prompts/phase-7/IMPLEMENTATION.md` the per-step mechanics.

## The `mogging usage` CLI (7/11)

Usage is scriptable and CI-readable through the `mogging` CLI. The verbs are
CLIENTS of the **existing token-authed app endpoint** (Phase-6/05b's local
socket — the one that already carries browser control): one more request
type on the same handshake, **no new listener, no daemon change** (the PTY
daemon protocol stays at v3, untouched). The endpoint file is 0600 and
per-user; nothing listens on TCP.

| Verb | What it does |
|---|---|
| `mogging usage [--json]` | The current snapshot — one line per (provider, plan): windows with `usedPct` + reset line, the pace verdict, health. `--json` emits the same enriched `PlanUsage[]` the popover renders. |
| `mogging usage cost [--provider <id\|all>] [--json]` | The 7/07 LOCAL cost scan (known log dirs only, offline): per-day spend + tokens + total. The `codexbar cost` analog. |
| `mogging usage providers [--json]` | Catalog rows with enabled state, key presence (kind only — never a value), and current health. Read-only. |
| `mogging usage refresh [--provider <id>]` | Pokes the poller, waits (bounded) for the next snapshot, prints it. |
| `mogging usage set-key --provider <id> --stdin` | Stores an API key via ADR 0007.a: piped on **stdin** (never argv, never echoed), one authed frame, OS-vault ciphertext, WRITE-ONLY. |
| `mogging usage clear-key --provider <id>` | Removes a stored key. |

There is deliberately **no `get-key`** verb — a stored key can be replaced
or cleared, never read back (the same structural no-getter as the IPC
surface). Exit codes follow the CLI's house semantics: `0` ok · `1`
rejected · `2` usage error · `3` app not running · `4` auth refused.

**One formatter, everywhere**: verdict lines come from the 7/02 pace
formatter and reset lines from the 7/10 reset formatter — the CLI prints
both verbatim, so `mogging usage` and the titlebar popover always agree,
word for word. The CLI emits no telemetry (ADR 0005).
