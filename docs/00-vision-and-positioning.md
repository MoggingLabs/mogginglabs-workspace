# 00 · Vision & Positioning

## What we're building

A desktop app that **runs, arranges, and coordinates many parallel AI coding-agent
CLIs** (Claude Code, OpenAI Codex, Gemini CLI, Aider, OpenCode, …) in a fast
multi-pane terminal with persistent workspaces. It **hosts the official first-party
CLIs as real PTY subprocesses**; each CLI authenticates the user's own account.

It is a custom rival to BridgeMind's **BridgeSpace** — an "Agentic Development
Environment" — rebuilt on the axes where the category is weakest.

## Target user

Developers (and teams) running one-to-many coding agents in parallel, especially
**Windows-primary and mixed Windows/macOS shops** underserved by macOS-only tools
(cmux, Conductor, Sculptor). Enterprise/.NET/Unity/fintech/gamedev skew.

## The wedge (verified — see 03-research-synthesis)

Two early assumptions were **wrong** and are corrected here:

1. **Platform breadth is NOT the wedge.** BridgeSpace already ships macOS + Windows + Linux.
2. **"Pure BYOK vs their credits" is NOT the wedge.** BridgeSpace *also* does BYO agent
   auth ("Connect Accounts" + an "API Keys" tab); its paid credits fund only its own
   first-party assistant/voice, not the coding agents.

The real, defensible wedge is the intersection:

- **(a) Rendering reliability under many agents.** BridgeSpace runs on Tauri — two
  divergent WebView engines (WebView2/Windows, WKWebView/macOS) — and its changelog
  shows a multi-month history of terminal-freeze/render bugs. We ship **one Chromium
  engine on both OSes** (Electron) and make "16 agents streaming, nothing freezes,
  identical on Win + Mac" a demoable guarantee.
- **(b) Free / open / local / no account.** BridgeSpace charges $16–80/mo and requires
  a BridgeMind account even though you bring your own agent auth. We are free,
  local-first, no account.
- **(c) Strict neutrality.** We never push our own model/agent (Warp and coder/mux do).
- **(d) Scriptability.** A documented socket + `mogging send/send-key/list` control API
  (à la tmux/cmux) — automatable and CI-friendly.
- **(e) Non-copyleft license.** cmux is GPL-3.0; coder/mux and claude-squad are AGPL-3.0.
  A permissive/source-available posture is itself a selling point.

**One-line positioning:** *Your keys, your CLIs — no subscription to us. Rock-solid on
Windows and Mac.*

## Core principle (non-negotiable)

**We never broker provider auth.** Users run their own CLIs under their own
subscriptions/keys; we only orchestrate which CLI/profile/env is active. No provider
credentials are ever stored, proxied, or metered by us. This is both the product ethic
and the legal/ToS de-risker. See [ADR 0002](adr/0002-never-broker-provider-auth.md).

## Non-goals (for now)

- No hosted/cloud backend, no credits, no account system.
- No brokering or reselling of AI subscriptions.
- Not chasing BridgeSpace's entire surface at once (editor, browser, voice, swarm,
  memory). Nail the organizer core first; layer the rest.
