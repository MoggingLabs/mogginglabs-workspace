# ADR 0007.a — API keys at rest: paste once, OS-vault ciphertext, write-only

- **Status:** accepted (Phase 7/05, 2026-07-06)
- **Companion to:** ADR 0007 (usage rides existing sessions) · ADR 0002
  lineage (never broker provider auth) · decided by the owner 2026-07-06

## Context

Some usage providers have no CLI to ride — only an API key (OpenRouter,
DeepSeek, ElevenLabs, …). The reference app (CodexBar) stores pasted keys in
a plaintext config file with tight permissions. We want the same one-paste
ease with a stricter at-rest story, and ADR 0007's "no secret storage"
stance needs a deliberate, bounded amendment to allow it.

## Decision

1. **The headline path is paste-once.** The user pastes a key ONCE; Electron
   `safeStorage` encrypts it immediately (OS-keychain-backed: Windows DPAPI,
   macOS Keychain, Linux libsecret). Only the CIPHERTEXT persists, in the
   settings KV. The plaintext never touches disk, logs, or telemetry.
2. **Write-only, structurally.** A saved key can be REPLACED or DELETED —
   never viewed again. The IPC/endpoint surface is `set` (plaintext in,
   encrypted immediately, never echoed back), `clear`, and a PRESENCE
   boolean. **No channel returning plaintext exists** — the guarantee is
   the absence of the channel, not discipline around it. Not in settings
   export, not in debug output, not in a smoke result.
3. **Decrypt happens backend-side, in memory, per request** — the one
   bounded usage call — then the plaintext is dropped (the ADR 0007 token
   rule, applied to our own store).
4. **Never plaintext at rest.** If `safeStorage.isEncryptionAvailable()` is
   false (a Linux box without a keyring), storage is REFUSED with the
   env-ref path offered — never a silent downgrade to a plaintext file.
5. **Env-ref pointers remain the power path.** `${OPENROUTER_KEY}` — the
   name persists, the value resolves at request time from the environment.
   A secret-shaped LITERAL in an env-ref slot is refused at save (the same
   deny-list heuristic profiles use).

## Divergence from the reference app, stated

CodexBar writes keys to a config file and can show them again; we hold
OS-vault ciphertext and never show a key back. Slightly stricter, equally
easy at paste time — and a machine-theft or backup-sync scenario leaks
nothing readable.

## Consequences

- The app CAN obtain a stored key's plaintext on-device (that is what makes
  paste-once easy) — but only the usage-fetch path does, in memory, and no
  renderer or wire surface can request it.
- Losing the OS vault (new machine, OS reinstall) loses stored keys — by
  design; the user re-pastes. Keys are cheap to rotate; plaintext backups
  are not.
- The smoke asserts the pasted plaintext is ABSENT from the settings DB
  bytes and that no getter channel exists in the allowlist.
