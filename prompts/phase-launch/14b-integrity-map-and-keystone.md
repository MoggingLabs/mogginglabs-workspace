The fuse wall is real and already bites: `check-fuses.mjs` proves
`EnableEmbeddedAsarIntegrityValidation` + `OnlyLoadAppFromAsar` are burned
in and that a one-byte edit inside `app.asar` makes the binary exit FATAL.
But that wall has three documented holes, and none is written down where a
decision-maker would see it: it is **inert on Linux**; the
**outside-the-asar set** (node-pty, better-sqlite3, `bin/**`,
`out/main/daemon.js` + chunks, the node-helper) is covered by the SIGNATURE
alone; and **the signature is the operator's deferred step** — integrity
validates the asar against a hash embedded in a binary that, unsigned,
anyone can re-embed. Map it honestly, shrink it where it is free.

## Steps
1. **The protection matrix** (`docs/23-threat-model.md`): every shipped
   artifact × what actually covers it (asar integrity · main-process
   bytecode · the relocated decision from 14a · code signature · nothing) ×
   per-OS (win/mac/linux). One row per artifact — the outside-the-asar set
   named individually, never as "and some natives". This table is the
   answer to "how hard is it really", so it may not round up.
2. **State the keystone**: asar integrity is hash-vs-binary, so **without a
   signature it is friction, not a wall** — an attacker who edits the
   binary re-embeds the hash. Record that signing (the ONE money item) is
   what converts the wall from evidence into enforcement, and that until it
   lands every integrity claim in docs/UI must read as tamper-EVIDENT, not
   tamper-proof.
3. **Linux, plainly**: the fuse is set but Electron does not enforce it
   there, so Linux rests on bytecode + 14a's relocated decision alone.
   docs/19's per-OS custody table gains the row; no copy anywhere may imply
   three-OS parity on integrity.
4. **Shrink the uncovered surface at $0**: audit what genuinely must live
   outside the asar (ABI-bound natives, the spawned helper, `bin/**` shims)
   and move anything that need not; confirm `OnlyLoadAppFromAsar` leaves no
   alternate load path, and that swapping the helper or a `bin/` shim
   cannot bypass the main-process decision — if it can, that is an S1 for
   14a to close, not a note here.
5. **INTEGRITYMAP static gate** (`scripts/check-integrity-map.mjs`,
   qa-smokes row): fails if a shipped artifact has no matrix row, if a row
   claims a cover the fuse/bytecode/signature state does not support, or if
   any doc/UI string calls an unsigned build tamper-proof. Verdict
   `out/integritymap-result.json`.

## Files
- `docs/23-threat-model.md` (the matrix) · `docs/19` (honest limits) ·
  `docs/18` (per-OS custody) · `scripts/check-integrity-map.mjs` ·
  `scripts/qa-smokes.sh` · `electron-builder.yml` (only if the outside-asar
  set shrinks) · `CHECKLIST.md` (mark 14b)

## Definition of Done
- Every shipped artifact has a matrix row naming its real cover per OS; the
  outside-the-asar set is enumerated by name, not summarised.
- The signing keystone is stated wherever integrity is claimed; no doc or
  UI string calls an unsigned build tamper-proof (INTEGRITYMAP bites on
  one).
- Linux's inert-integrity row exists in docs/18 + docs/19; no copy implies
  parity.
- Swapping the helper or a `bin/` shim cannot bypass the 14a decision —
  proven, or filed S1 against 14a.

## Checks that must be green
- `npm run typecheck` → 0; build ok; static battery; INTEGRITYMAP; FUSES +
  BYTECODE + WATERMARK + the tamper gate; PLAINGATE (14a); gate-count
  re-derived.

## Guardrails
- Honesty over theatre (ADR 0016 §5): this step ADDS no wall. It maps what
  exists and names what is missing — a matrix that flatters the product is
  the failure mode.
- $0 — no new control that costs money or adds a dependency; signing stays
  the operator's step, named and costed.
- Never claim a control Claude did not verify on that OS; an unrun OS is
  PENDING-operator with the dispatch named.
