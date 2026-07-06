<p align="center">
  <img src="assets/logo.png" alt="MoggingLabs Workspace" width="240" />
</p>

# MoggingLabs Workspace

> A neutral, reliable, cross-platform organizer for AI coding-agent CLIs.
> **Your keys, your CLIs — no subscription to us. Rock-solid on Windows and Mac.**

MoggingLabs Workspace is a desktop app that runs and coordinates many parallel
AI coding-agent CLIs (Claude Code, OpenAI Codex, Gemini CLI, Aider, OpenCode, …)
in a fast multi-pane terminal with persistent workspaces. It **hosts the official
first-party CLIs as real PTY subprocesses** — each CLI authenticates *your* own
account (subscription or API key). The app **never brokers provider auth** and
takes **no cut of your AI usage**.

It is, in effect, a custom rival to BridgeMind's **BridgeSpace** — built on the
axes where the category is weakest: rendering reliability under many agents,
neutrality, scriptability, an open/local/no-account posture, and a non-copyleft
license.

## Why this exists (the wedge)

The strongest tools in this space each leave a hole:

- **cmux** — best agent-awareness UX, but **macOS-only**.
- **Warp** — polished + cross-platform, but **closed** and pushing **its own** AI agent.
- **tmux** — the persistence/scripting gold standard, but **no native Windows, no GUI, no agent-awareness**.
- **coder/mux** — cross-platform, but it's **its own AGPL agent**, not a neutral host.
- **BridgeSpace** — covers the most surface, but is **closed, $16–80/mo + account required**, and its changelog shows a **multi-month history of terminal-rendering/freeze bugs** (it's built on Tauri's *two* divergent WebView engines).

**Our lane:** the most reliable, identical-on-Windows-and-macOS, **neutral**,
**scriptable** organizer of first-party agent CLIs — free, local-first, and
non-AGPL. See [`docs/00-vision-and-positioning.md`](docs/00-vision-and-positioning.md).

## Tech stack

**Electron + xterm.js (WebGL) + node-pty**, with a persistent PTY-host process and
a platform-agnostic TypeScript engine. This is VS Code's exact terminal stack, and
— unlike Tauri — ships **one Chromium engine on both OSes**, so the terminal
renderer is tuned once and behaves identically everywhere. See
[ADR 0001](docs/adr/0001-electron-over-tauri.md).

## Quickstart

> **Status: Phase 6 (product-ready) shipped — v0.4.0** — three-platform parity
> (the same 34-gate `qa-smokes.sh` green on Windows, Linux, AND macOS CI), a
> toggleable **browser dock** that agents can drive via a first-party MCP server,
> per-slot **profile persistence**, a live **first-run checklist** + one-click
> **update UX**, and signing readiness + winget/homebrew manifests. Closed by the
> `MOGGING_PRODUCT` milestone: an installer-fresh machine reaches a working swarm
> beside a live browser preview in one asserted flow, budgets intact. Per-OS
> numbers in `prompts/phase-6/README.md`.

```bash
npm install        # builds native modules (node-pty). See note below.
npm run dev        # launch the app in dev mode
```

### Five minutes to your first agent workspace

The app guides this itself — Home shows a live **"Get set up"** checklist on
first run. The path:

1. **Install an agent CLI.** The checklist detects Claude Code, Codex, Gemini,
   Aider, and OpenCode on your PATH and shows the provider's own install
   one-liner with a copy button for any that are missing — e.g.
   `npm install -g @anthropic-ai/claude-code`. (We never install for you; the
   CLI is yours and self-authenticates — ADR 0002.)
2. **Open the app** and hit **New workspace** (`Ctrl/⌘+T`) — pick a folder and
   an agent lineup in the wizard.
3. That's it — you're in a working multi-pane agent workspace. The checklist
   ticks itself off as you go and never returns once done or dismissed.

Packaged builds keep themselves current: a new release downloads in the
background and offers a one-click **Restart now** (or ignore it — it installs
on next launch). See [`docs/10-distribution.md`](docs/10-distribution.md).

### The orchestration loop, scripted (only `mogging …` + the app)

```sh
mogging open ~/my-project --panes 4   # open the app on your repo (cold or running)
mogging list                          # see the fleet
mogging send 101 "claude"             # drive a pane… or use the Board (Ctrl+Shift+G):
                                      # New card -> ⋯ -> "Start Claude Code on this…"
                                      # -> isolated worktree pane, task = first prompt
mogging capture 101 --lines 40        # read scrollback from a script
# agent hooks fire `mogging notify --event needs-input` -> the card + rail light up
# pane ⋯ -> Review changes… -> redacted diff -> type "merge" -> landed
```

Details: [`docs/08-orchestration.md`](docs/08-orchestration.md) ·
[`docs/06-control-api.md`](docs/06-control-api.md) ·
perf + perception budgets: [`docs/05`](docs/05-perf-budget.md) / [`docs/07`](docs/07-perception-budget.md).

**Native modules — compiled from source (no prebuilts).** The app uses `node-pty` and
`better-sqlite3`, built against the exact Node/Electron ABI via `.npmrc` (`build_from_source=true`)
plus `buildDependenciesFromSource: true` in `electron-builder.yml` (the `postinstall` runs
`electron-builder install-app-deps`). So **`npm install` requires a C++ toolchain:**
- **Windows:** VS 2022 **C++ Build Tools** (VCTools workload) + **`node-gyp` ≥ 13** (devDep —
  older node-gyp fails the MSBuild step on VS 2022 / Node 24) + Python with **`setuptools`**
  (`pip install setuptools`, since Python ≥ 3.12 dropped `distutils`). Install the compiler:
  `winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"`.
- **macOS:** Xcode Command Line Tools.
- **Linux (Debian/Ubuntu):** `sudo apt install build-essential python3 python3-setuptools`
  (Fedora: `sudo dnf install @development-tools python3-setuptools`). Headless smokes
  need `xvfb`. Packaging: `npx electron-builder --linux` (AppImage + deb).

Native modules are `asarUnpack`ed for packaging. See [ADR 0001](docs/adr/0001-electron-over-tauri.md).

## Project structure

```
src/
  contracts/   Shared seam — domain types + typed IPC contract (depends on nothing)
  backend/     ALL Node-side logic; Electron-free. → core/ platform/ features/
  ui/          ALL renderer logic; never imports backend. → core/ shell/ features/
  main/        App-wiring: window + compose backend over an Electron context
  preload/     App-wiring: the generic, contracts-allowlisted window.bridge
  renderer/    App-wiring: renderer bootstrap that mounts @ui
  pty-host/    (Phase 1) dedicated persistent backend process
docs/
  00-vision-and-positioning.md
  01-architecture.md            tech tiers (Electron + xterm.js + node-pty)
  02-mvp-and-roadmap.md
  03-research-synthesis.md      full competitive + open-source research report
  04-adding-a-feature.md        the parallel-work playbook
  adr/                          decision records (0001–0004)
```

**Layer boundaries** (aliases `@contracts` / `@backend` / `@ui`): `contracts`
depends on nothing; `backend` and `ui` depend only on `contracts` and never on each
other; `main`/`preload`/`renderer` are the only composition root. See
[ADR 0004](docs/adr/0004-layered-feature-sliced-architecture.md).

## Roadmap (short form)

- **Phase 0** ✅ — Parity spike: one live agent PTY pane, identical on Win + Mac.
- **Phase 1** ✅ — MVP core: multi-pane grid, workspaces, detached PTY daemon, SQLite restore.
- **Phase 2** ✅ — Agent awareness: OSC state detection, command blocks, per-pane git, 16-agent perf budget.
- **Phase 3** ✅ — Orchestration: control API, worktree isolation, pre-ship review, Kanban board, end-to-end milestone.
- **Phase 4** ✅ — Swarm core: mailbox + roles, ownership ledger, reviewer gate, profiles + failover, SSH panes, Linux target.
- **Phase 5** ✅ — UI/UX excellence: AA-measured token system + vivid workspace identity, icon family, window-chrome fixes, full-app views, 14px terminal comfort (receipts: `prompts/phase-5/REPORT.md`).
- **Phase 6** — Product-ready: full Linux/macOS parity sweeps, browser pane, first-run + updates, v0.4.0. *(next; voice: undecided, own pack later)*

Full plan: [`docs/02-mvp-and-roadmap.md`](docs/02-mvp-and-roadmap.md).

## License

Proprietary / all rights reserved (experiment stage). Final license TBD —
deliberately **non-AGPL**; a permissive/source-available posture is a competitive
selling point. See [`LICENSE`](LICENSE).
