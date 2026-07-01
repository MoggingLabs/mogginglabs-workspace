#!/usr/bin/env node
// `mogging .` (or `mogging <dir>`) — opens/focuses a MoggingLabs Workspace for a directory.
// It launches the registered `mogging://` deep link, which the app handles: a running instance
// focuses + opens a workspace for the dir (single-instance); otherwise the app starts on it.
// Auth is never touched here (ADR 0002) — the app just hosts CLIs that self-authenticate.
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const dir = resolve(process.argv[2] ?? '.')
const url = `mogging://open?cwd=${encodeURIComponent(dir)}`

const platform = process.platform
if (platform === 'win32') {
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
} else if (platform === 'darwin') {
  spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
} else {
  spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
}

process.stdout.write(`mogging: opening workspace for ${dir}\n`)
