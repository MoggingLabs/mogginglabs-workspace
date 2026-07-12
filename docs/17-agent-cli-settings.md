# 17 · Agent CLI settings

Settings → Agent CLIs is the control plane for configuration owned by Claude Code, Codex,
Gemini CLI, Aider, and OpenCode. It exposes human-readable settings and structured controls while
the provider adapter reads and updates the correct layer in the background.

The non-negotiable architecture and safety rules live in
[ADR 0011](adr/0011-agent-cli-configuration-control-plane.md).

## What the user can control

- See the installed CLI version and when its catalog was last refreshed.
- Select a real provider scope: this launch, this project, private project settings, a named
  profile, all projects for the user, or an observable system/admin layer.
- Search every stable documented setting and browse it by provider category.
- See the selected-layer value separately from the effective value and its winning source. Codex
  uses its app-server as the authority; other providers label results as observable local layers
  when organization/MDM or external launch state cannot be inspected.
- Apply a value once or keep it enforced by Workspace.
- Stop managing a key while either keeping its current value or restoring the value that existed
  before Workspace claimed it.
- See drift, a higher-precedence override, a managed restriction, a deprecated/experimental flag,
  or a restart/next-session requirement without opening the provider file.

Credential values are not part of this surface. They remain owned by provider authentication and
the existing write-only vault contracts (ADR 0002).

## Provider sources

| CLI | User layer | Project layer | Other layers/catalog |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/settings.json` | `.claude/settings.json`, `.claude/settings.local.json` | transient `--settings`, managed base/drop-ins; published SchemaStore settings schema |
| Codex | `$CODEX_HOME/config.toml` | trusted `.codex/config.toml` layers | app-server-resolved origins/requirements, system config; generated config schema |
| Gemini CLI | `~/.gemini/settings.json` | `.gemini/settings.json` | system defaults/override; generated settings schema |
| Aider | `~/.aider.conf.yml` | Git-root, then current-directory `.aider.conf.yml` (no intermediate directories) | environment/CLI overrides; official option reference and all-options sample, both compiled on refresh |
| OpenCode | XDG `opencode/config.json`, then `opencode.json`, then `opencode.jsonc`; `tui.json`, then `tui.jsonc` | project files root-to-CWD; discovered `.opencode` directories in provider loader order | remote, custom file/directory, inline runtime, and managed runtime layers; separate runtime and TUI schemas |

OpenCode's current runtime loader stops project-file and `.opencode` discovery at the worktree.
Its separate TUI loader currently walks parent `tui.json(c)` files and `.opencode` directories to
the filesystem root. Workspace preserves those distinct boundaries and applies each chain in the
same order as the provider.

Official research sources:

- Claude Code: <https://code.claude.com/docs/en/settings> and
  <https://code.claude.com/docs/en/permissions>
- Codex: <https://developers.openai.com/codex/config-reference/> and
  <https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json>
- Gemini CLI: <https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md>
  and <https://raw.githubusercontent.com/google-gemini/gemini-cli/main/schemas/settings.schema.json>
- Aider: <https://aider.chat/docs/config/options.html> and
  <https://github.com/Aider-AI/aider/blob/main/aider/website/assets/sample.aider.conf.yml>.
  Numeric and repeatable-option semantics are checked against Aider's current parser declarations
  in <https://github.com/Aider-AI/aider/blob/main/aider/args.py>.
- OpenCode: <https://opencode.ai/docs/config>, <https://opencode.ai/config.json>, and
  <https://opencode.ai/tui.json>. Exact compatibility-file and directory ordering follows the
  current upstream loaders in
  <https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/config/config.ts>,
  <https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/config/paths.ts>, and
  <https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/config/tui.ts>.

## Permission-bypass truth

Claude Code's durable bypass default is a real settings value, not a broad allow-list imitation:

```json
{
  "permissions": {
    "defaultMode": "bypassPermissions",
    "skipDangerousModePermissionPrompt": true
  }
}
```

The two controls remain separate in the UI. A managed
`permissions.disableBypassPermissionsMode: "disable"` is shown as the effective block. Shared
project settings cannot suppress the dangerous-mode warning, so the UI disables that invalid
scope instead of writing a value the CLI ignores.

Gemini's YOLO mode is not represented as a durable setting because the provider does not support
one. It is a session launch choice (`--yolo` / `--approval-mode=yolo`) and can be prohibited by
policy. The UI must not claim persistence the CLI does not provide.

Aider's upstream sample is an option inventory, not a type schema: some numeric entries use
placeholder or boolean-looking examples. The compiler therefore combines it with the official
option reference and guarded parser semantics. The `config` option is shown as a session-only,
non-durable selector because it chooses which file Aider loads; it is never written into a managed
config file. These upstream-main/current-doc sources are not labelled as exact matches for the
installed wheel version.

## Synchronization lifecycle

The bundled catalog and last-known-good cache make the page instant and offline-safe. A background
refresh checks official sources at most daily and whenever the installed executable/version
changes. File reconciliation is separate from catalog refresh:

- application open: reconcile enforced rows in the background;
- setting save: reconcile the affected row immediately;
- agent launch: reconcile only the relevant provider/profile/project, then compose one transient
  overlay with Workspace's existing context, notification, and MCP configuration.

No interval polls provider files. Reads happen on page entry, explicit refresh, and the lifecycle
points above.

Workspace's “Profile” scope is an isolated account/config home (`CODEX_HOME`,
`CLAUDE_CONFIG_DIR`, or `GEMINI_CLI_HOME`). Codex native `--profile name` files are a distinct
provider concept; app-server reports one when the launched Codex process selects it, but this
screen does not conflate it with account-home profiles.
