# ADR 0011 — Agent CLI configuration control plane

- **Status:** Accepted (2026-07-12)
- **Scope:** Claude Code, Codex, Gemini CLI, Aider, and OpenCode

## Context

Workspace can launch five independently installed agent CLIs, but their settings still live
behind five file formats, different precedence rules, and provider-specific commands. The
existing Agent CLIs page only detects and installs executables. Users cannot see which value is
active, change a setting without learning a config dialect, or keep an app-selected value in sync.

This is not one generic preferences file:

- Claude Code uses JSON settings at user, shared-project, project-local, transient, and managed
  scopes. Scalars override while many arrays merge.
- Codex uses layered TOML, separate profile files, project restrictions, and managed
  `requirements.toml` constraints.
- Gemini CLI uses comment-tolerant JSON at system-default, user, project, and system-override
  layers, with field-specific merge rules.
- Aider derives its YAML keys from CLI options and loads only home, Git-root, and current-directory
  files, in that order. Intermediate directories are not configuration layers. Environment
  variables and flags take precedence.
- OpenCode merges runtime JSON/JSONC and a separate TUI JSON/JSONC through remote, global, custom,
  project, discovered config-directory, inline, and managed layers. Project files and discovered
  `.opencode` directories retain their distinct upstream traversal orders.

The application already composes provider configuration at launch for context reporting,
notifications, and workspace MCP plans. A second independent settings writer would make the UI
report one value while the launched CLI receives another.

ADR 0002 remains a hard boundary: provider authentication is owned by the CLI. Credential values
must not be read into the renderer, persisted as ordinary settings, logged, or included in
telemetry.

## Decision

Build one provider-neutral control plane with provider-specific source resolvers and codecs.
The app presents settings and values, never raw config files.

### 1. Canonical provider registry

One backend-core registry owns the canonical provider id, executable, version probe, install
metadata, config capabilities, supported scopes, catalog sources, and launch-overlay strategy.
Launcher detection and settings coverage derive from that registry. Adding a launchable provider
without an explicit config capability (or an explicit unsupported reason) fails a static gate.

### 2. Honest scopes, not a false common denominator

The contract models these scopes:

- `session` — only the next app-launched CLI process;
- `project` — the provider's shared project layer;
- `local` — a private project layer where the provider actually supports one;
- `profile` — a named account/config-home pointer where supported;
- `user` — the current user's provider-wide layer;
- `system-default` and `system-policy` — machine/admin layers.

The UI labels `user` as “All projects” where that is the provider's natural wording. Admin,
remote, registry/MDM, environment, and CLI layers are observable when safe but read-only unless
the provider explicitly exposes a non-elevated supported write API. The app never silently
elevates to edit a system policy.

### 3. Desired state with reversible ownership

Desired settings live in a dedicated SQLite table, keyed by provider, scope, target, surface, and
setting path. Each row records:

- the operation (`set` or enforced `unset`) and optional desired JSON value;
- ownership mode (`once` or `enforce`);
- the value/presence found when the app first claimed the key (the baseline);
- catalog/version metadata;
- the last applied value/hash, status, error, and timestamps.

No row means “inherit/observe.” An `unset` intent is different: it actively keeps the selected
layer free of that key. `once` applies a validated set/unset edit and releases ownership.
`enforce` makes the app the source of truth for that key. Stopping management offers two honest
operations: keep the current value, or restore the recorded baseline. It never guesses that
deleting a key is equivalent to restoring the user's previous state.

The SQLite row is written as pending before the file transaction. A crash can therefore leave a
reconcilable pending row, not a silently lost user choice. Reconciliation is idempotent.

### 4. One-layer, syntax-aware edits

The service resolves and edits exactly the selected source layer. It never serializes a merged
effective configuration back into one file.

- JSON/JSONC uses targeted syntax-tree edits. JSONC providers preserve comments and trailing
  commas; strict-JSON providers refuse those constructs before writing.
- YAML uses a round-trip document model that preserves comments and ordering.
- TOML uses a concrete-syntax-tree/range edit: replace an existing value in place, insert a key
  in its real table, and validate the complete result. A general object serializer is forbidden.
- Provider-native observation APIs are preferred where they resolve otherwise opaque behavior.
  Codex app-server supplies authoritative effective values, origins, disabled project layers, and
  requirements; surgical file mutation retains Workspace's shared CAS/atomic-write guarantees.

Every write is size-bounded, schema-validated, optimistic-concurrency checked, serialized per
real target file, written through a same-directory temporary file, fsynced, and atomically
renamed. Existing symlinks are followed deliberately so the link itself is not replaced. Unknown
keys and unrelated bytes remain untouched. Recovery is the per-setting baseline plus the atomic
old-or-new file guarantee—not a persistent full-file copy that could duplicate provider secrets.

### 5. Current value, desired value, and effective value are separate facts

The UI receives a redacted snapshot, not file contents or paths. A row can show:

- the value in the selected layer;
- the app's desired value, if managed;
- the effective value and winning source when it can be resolved safely;
- a managed constraint or higher-precedence override;
- drift, validation, restart/next-session state, and catalog stability.

Unknown remote state is reported as unknown rather than inferred. For providers without an
authoritative resolver, effective values are explicitly described as observable local layers and
do not claim to include opaque organization/MDM policy or external launch flags. Secret settings are
catalogued so coverage remains honest, but their values are never read or returned. Provider auth
settings remain provider-managed or accept only a safe environment/keychain reference where an
existing Workspace vault contract explicitly supports it.

### 6. Reconciliation and launch composition

Enforced rows reconcile:

1. asynchronously after the settings store opens;
2. immediately after a settings mutation;
3. for the selected provider/profile/project before an agent launch command is returned.

An execution target is explicit. Local configuration is never read or written for an SSH pane;
remote settings remain unsupported/read-only until a remote adapter exists.

Boot work is stale-while-revalidate and never blocks the first window. The launch path waits only
for the relevant target and has a bounded timeout. Failures do not launch with a falsely reported
state: the command response carries a typed warning, and the settings UI receives the same status.

All transient settings share one launch-overlay composer with Workspace's existing context,
notification, and MCP owners. Internal keys needed for pane correctness are visible as
“Workspace-managed” and cannot be contradicted by a second writer. Provider precedence is
preserved: admin policy remains above user/session choices.

### 7. Versioned, self-updating catalog

The shipped application contains a validated last-known-good catalog. Catalog entries carry type,
enum/default when published, canonical category, description, supported scopes, activation
semantics when published, sensitivity, stability, source URL, and provider surface.

Catalog generation consumes only allowlisted primary sources and the published Claude SchemaStore
schema mirror:

- Claude Code's published SchemaStore settings schema plus documented semantic overlays;
- Codex's generated config schema plus the complete config/requirements reference;
- Gemini CLI's generated settings schema;
- Aider's official all-options sample and option reference, compiled together, with guarded
  numeric/repeatable semantics from the current upstream argument parser;
- OpenCode's runtime and TUI schemas.

At runtime, a background service refreshes a provider when the executable path/version changes,
after an install/update completes, or when the cached source is older than 24 hours. Downloads are
HTTPS/host allowlisted, time/size bounded, schema validated, treated strictly as data, and written
only to a last-known-good cache after a complete validation pass. A failed refresh keeps the prior
catalog. New catalog data cannot select a filesystem target or executable.

CI runs the same compiler/semantic validator against the bundled catalog. Runtime refresh is the
daily update path; a failed refresh never replaces the validated bundled/cache floor.
An installed Aider version change triggers refresh, but upstream-main/current-doc inputs remain
marked non-exact. The catalog does not imply that those bytes came from the installed wheel.

### 8. UI information architecture

Settings → Agent CLIs keeps the fast availability overview. Selecting a CLI opens its settings
workspace with:

- provider identity, installed version, catalog freshness, and sync health;
- a scope selector using only scopes that provider supports;
- search plus category navigation;
- stability badges for Experimental and Deprecated settings;
- compact rows showing effective value/provenance and an inline type-appropriate editor;
- typed scalar controls, line-oriented list controls, and a schema-validated JSON value editor for
  nested structures—never a provider-file editor;
- explicit Apply once / Keep synced / Restore previous actions;
- a prominent danger treatment and confirmation for permission-bypass modes.

Only the selected provider/category is rendered. Filtering is local over an IPC snapshot; schema
refresh and file reconciliation stay off the renderer's hot path.

## Consequences

- The feature is larger than a settings form: it owns catalog generation, file transactions,
  precedence resolution, launch composition, persistence, and UI.
- Provider differences remain isolated behind adapters instead of leaking conditionals through the
  renderer.
- Existing hand-edited config remains first-class. The app can manage selected keys without
  claiming the whole file.
- “Always synced” is explicit and reversible, not an unconditional boot-time clobber.
- System policies and credentials stay outside ordinary app ownership.

## Required gates

1. Provider/catalog coverage and schema-classification static gate.
2. Golden codec fixtures for absent/malformed files, JSONC, YAML comments, TOML tables, CRLF/BOM,
   unknown keys, hostile values, concurrent edits, atomic replacement, and byte preservation.
   Existing symlinks are followed deliberately; a dedicated symlink mutation fixture is tracked
   as release hardening rather than claimed as current gate coverage.
3. Two-phase persistence/restart smoke proving baseline capture and boot reconciliation.
4. Scope/precedence smoke for all five providers.
5. Launch-composition smoke proving settings, notification/context overlays, and MCP plans agree.
6. Settings UI/a11y smoke including search, category/scope navigation, danger confirmation, drift,
   and an empty/offline catalog.
7. Full typecheck, build, static gates, and the existing cross-platform smoke sweep.
