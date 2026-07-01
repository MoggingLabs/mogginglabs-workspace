# `ui/features/workspace` — workspace tabs, themes, launcher

Color-coded **workspace tabs** (Phase-1/05). Each tab = a project directory + its own pane
layout (from 04). New / close / switch (`Ctrl/Cmd+T`, `Ctrl/Cmd+1..9`), a theme picker, and
restore-on-relaunch.

- `model.ts` — `WorkspaceMeta` (id, name, color, cwd, ordinal, paneCount). `ordinal * 100` is
  the base pane id, so a workspace's pane ids are unique + stable across restarts.
- `controller.ts` — `WorkspaceController`: one tab + container + `GridLayout` per workspace.
  Switching is show/hide (panes keep streaming); closing disposes a layout (clears its slots).
- `themes.ts` — the theme set (chrome CSS vars + xterm theme); `applyTheme` broadcasts the
  terminal theme via the ui-core theme port.
- `workspace.client.ts` — IPC: load/save app state; receive `mogging://` open-cwd events.
- `index.ts` — the `UiFeature`: tab bar, layout toolbar, theme picker, keyboard, persist
  (debounced) + restore.

## Decoupling (guardrail)
Never imports `terminal`. Panes arrive via the **slots port** (`@ui/core/layout/slots`); the
active terminal theme is broadcast via the **theme port** (`@ui/core/theme/theme-port`). App
state persists via `@contracts` `WorkspaceChannels` → main's `SettingsStore` (same better-sqlite3
mechanism as 03), in a **main-owned db** separate from the daemon's sessions.

## `mogging .` launcher
`bin/mogging.mjs` opens `mogging://open?cwd=<abs dir>`; main registers the protocol + single
instance (`src/main/deep-link.ts`) and forwards the cwd to this feature, which focuses an
existing workspace for that dir or creates one. **No auth is ever brokered** (ADR 0002).

## Persistence (ADR 0002)
Persists METADATA only — name/color/cwd/ordinal/paneCount + active tab + theme id. Never any
credential; the terminal scrollback/sessions live in the daemon's store, not here.
