# ADR 0001 — Electron over Tauri

- **Status:** Accepted (2026-07-01)
- **Context:** We need real PTYs and consistent, high-performance rendering of many
  streaming agent panes on **both Windows and macOS**. Rendering reliability is our
  explicit wedge.

## Decision

Use **Electron + xterm.js (WebGL addon) + node-pty**, with the core logic in a
platform-agnostic TypeScript "engine" package decoupled from Electron.

## Rationale

- **One engine on both OSes.** Electron ships one Chromium build on Windows and macOS,
  so the WebGL terminal renderer is tuned once and behaves identically. **Tauri uses the
  *system* WebView — Chromium-based WebView2 on Windows vs. WebKit WKWebView on macOS** —
  two divergent engines, two sets of render/perf/clipboard/font quirks. This is almost
  certainly the root of BridgeSpace's documented multi-month terminal-render/freeze
  history. Electron removes our single biggest source of parity bugs.
- **Most battle-tested terminal-in-a-webview stack in existence.** VS Code's integrated
  terminal is Electron + xterm.js + node-pty. xterm.js is maintained by the VS Code team;
  node-pty (Microsoft) wraps **ConPTY on Windows and forkpty on Unix** behind one JS API.
- **Turnkey PTY.** node-pty gives "real PTY on Win + Mac from one codebase" with no extra
  plumbing. In Tauri we'd wire Rust `portable-pty` over IPC — viable, but more work on
  top of the WebView-divergence tax.
- **Ecosystem & hiring:** far more terminal/PTY prior art (VS Code, Hyper, Theia) and JS
  talent.

## Consequences / trade-offs

- Electron costs ~100–150 MB binaries and higher RAM than Tauri. Acceptable for a
  heavyweight multi-agent dev tool; footprint is not our priority.
- **Hedge:** keep the engine (PTY host, OSC parser, session store, orchestration) as a
  platform-agnostic TS package so it is headless-unit-testable and could be re-hosted in
  Tauri or a native shell later without a rewrite.

## When we'd revisit
If minimal footprint became the top priority, or if a future native GPU renderer
(e.g. libghostty, which cmux uses) proved necessary for perf that WebGL xterm can't hit.
