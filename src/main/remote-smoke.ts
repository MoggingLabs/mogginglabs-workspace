import { app, ipcMain, type BrowserWindow } from 'electron'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { getSettingsStore } from './app-settings'
import { runtimeDir } from './daemon-client'
import { getDaemonClient } from './daemon-relay'
import { SessionStore, SettingsStore } from '@backend/features/workspace'
import {
  REMOTE_READY_OSC,
  TerminalChannels,
  type AgentCommandResult,
  type RemoteRemoveResult,
  type SpawnSpec
} from '@contracts'
import { remoteBootstrapCommand } from '../pty-daemon/session'

// Env-gated remote-pane smoke (MOGGING_REMOTE, Phase-4/05). No real network: the
// daemon spawns the MOGGING_SSH_SHIM script (set by main BEFORE the daemon started;
// the file is written here, lazily read at pane spawn) instead of `ssh`. Asserts:
//   1. the ssh argv carried -tt / -p <port> / user@host (arg ARRAY, no shell)
//   2. the remote pane wears the host-name chip; the local pane does not
//   3. HONESTY: the local pane gets its git chip; the remote pane does NOT
//   4. `mogging list` shows the REMOTE column with the host name
//   5. exit of the (shimmed) ssh process = pane exit
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'mogging-remote-'))
  git(repo, ['init'])
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repo, ['config', 'user.email', 'smoke@mogging.test'])
  git(repo, ['config', 'user.name', 'Mogging Smoke'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(repo, 'README.md'), 'local side\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'init'])
  return repo
}

function nodeEvalCommand(source: string): string {
  const encoded = Buffer.from(source, 'utf8').toString('base64')
  return `node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`
}

function remoteBootstrapSyntaxOk(command: string): boolean {
  const shell =
    process.platform === 'win32'
      ? [
          join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
          join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', 'bash.exe'),
          'C:\\Program Files\\Git\\usr\\bin\\bash.exe'
        ].find((candidate) => existsSync(candidate))
      : '/bin/sh'
  if (!shell || !existsSync(shell)) return false
  try {
    // Read the script from stdin. Git Bash truncates long direct `-c` arguments near 8 KiB,
    // while native ssh transports this command intact to the remote POSIX shell.
    execFileSync(shell, ['-n'], { input: command, timeout: 15_000, windowsHide: true })
    return true
  } catch {
    return false
  }
}

// A PowerShell (win) / sh (posix) script standing in for `ssh`. It records its argv VERBATIM to
// a file (the argv/IPv6/target-quoting assertions read that file, not the pane: the one remote
// command is now the full POSIX bootstrap, ~10 KB, which would flood the pane's buffer and get
// truncated), prints a short marker into the pane, reports whether ANY pane capability leaked
// into the remote child's env — and then DELAYS, the way a real ssh does while it authenticates,
// before handing over to an interactive local shell. The delay is load-bearing: it is the window
// in which nothing may be typed at the pane. The smoke injects the readiness data event
// explicitly afterwards, because ConPTY does not preserve private OSCs consistently across
// Windows builds.
//
// PowerShell, not a .cmd batch: cmd's command line caps at 8191 characters and the bootstrap is
// bigger than that, so the batch shim died with "The command line is too long" before running a
// single line. Real `ssh.exe` is spawned directly (32 KB CreateProcess limit) and never hit it.
const SHIM_SRC =
  process.platform === 'win32'
    ? [
        '[IO.File]::WriteAllText("$PSCommandPath.argv", ($args -join "`n"))',
        "Write-Host 'SSH_SHIM argv captured'",
        "foreach ($pair in @(@('MOGGING_DAEMON_ENDPOINT','ENDPOINT'), @('MOGGING_BROWSER_ENDPOINT','BROWSER'), @('MOGGING_PANE_ID','ID'), @('MOGGING_PANE_TOKEN','TOKEN'))) {",
        '  $state = if (Test-Path ("env:" + $pair[0])) { "LEAK" } else { "clean" }',
        '  Write-Host ("SSH_ENV_" + $pair[1] + "=" + $state)',
        '}',
        'Start-Sleep -Seconds 2',
        '& $env:ComSpec',
        ''
      ].join('\r\n')
    : '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$0.argv"\necho "SSH_SHIM argv captured"\nif [ "${MOGGING_DAEMON_ENDPOINT+x}" = x ]; then echo SSH_ENV_ENDPOINT=LEAK; else echo SSH_ENV_ENDPOINT=clean; fi\nif [ "${MOGGING_BROWSER_ENDPOINT+x}" = x ]; then echo SSH_ENV_BROWSER=LEAK; else echo SSH_ENV_BROWSER=clean; fi\nif [ "${MOGGING_PANE_ID+x}" = x ]; then echo SSH_ENV_ID=LEAK; else echo SSH_ENV_ID=clean; fi\nif [ "${MOGGING_PANE_TOKEN+x}" = x ]; then echo SSH_ENV_TOKEN=LEAK; else echo SSH_ENV_TOKEN=clean; fi\nsleep 2\nexec ${SHELL:-/bin/sh}\n'

export function runRemoteSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 240000) // safety net (16s readiness hold + daemon restart + reload)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const cliPath = join(app.getAppPath(), 'bin', 'mogging.mjs')
  const rendererWrites: { id: number; data: string; at: number }[] = []
  const onRendererWrite = (_event: unknown, payload: { id?: number; data?: string }): void => {
    rendererWrites.push({ id: Number(payload?.id), data: String(payload?.data ?? ''), at: Date.now() })
  }
  ipcMain.on(TerminalChannels.write, onRendererWrite)

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      // The daemon inherited MOGGING_SSH_SHIM (main set it pre-daemon); write it NOW.
      const shimPath = process.env.MOGGING_SSH_SHIM ?? ''
      if (!shimPath) throw new Error('MOGGING_SSH_SHIM unset')
      writeFileSync(shimPath, SHIM_SRC)

      const repo = makeRepo()
      const remoteCwd = "/srv/work trees/O'Reilly"
      const bootstrap = remoteBootstrapCommand(remoteCwd)
      const remoteMonitorPackaged =
        bootstrap.length < 30_000 &&
        bootstrap.includes('.context-monitor') &&
        bootstrap.includes('GIT_TRACE_SETUP') &&
        bootstrap.includes('MoggingGitCwdRaw') &&
        bootstrap.includes('MoggingProcessCwdRaw')
      const remoteBootstrapParses = remoteBootstrapSyntaxOk(bootstrap)
      await sleep(1500)

      // A pre-platform settings db must remain explicitly unconfirmed after schema
      // migration; reading it must not silently reinterpret the host as POSIX.
      const legacyDir = mkdtempSync(join(tmpdir(), 'mogging-remote-legacy-'))
      const legacyDbPath = join(legacyDir, 'settings.db')
      const legacyDb = new Database(legacyDbPath)
      legacyDb.exec(`
        CREATE TABLE app_remotes (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL,
          user TEXT, port INTEGER, identity_hint TEXT
        );
        INSERT INTO app_remotes (id, name, host) VALUES ('legacy', 'legacybox', 'legacy.example');
      `)
      legacyDb.close()
      const legacyStore = new SettingsStore(legacyDbPath)
      const legacyHost = legacyStore.listRemotes().find((row) => row.id === 'legacy')
      legacyStore.close()
      const legacyPlatformUnconfirmed = !!legacyHost && legacyHost.platform === undefined

      const corruptStore = new SessionStore(join(legacyDir, 'corrupt-sessions.db'))
      corruptStore.savePanes([
        {
          id: 'corrupt-remote',
          workspaceId: 'default',
          cwd: '',
          remote: { name: 'optionbox', host: '--proxy-command', platform: 'posix' },
          scrollback: '',
          updatedAt: Date.now()
        }
      ])
      const corruptPersistedRemoteRejected = corruptStore.loadPanes().length === 0
      corruptStore.close()

      // Saved host (pointers only) -> mixed workspace: slot 1 local repo, slot 2 remote.
      const saved = await ES<boolean>(
        `window.bridge.invoke('remotes:save', ${JSON.stringify({ id: 'h1', name: 'buildbox', host: 'build.example', user: 'dev', port: 2222, platform: 'posix', shell: 'bash' })})`
      )
      const ipv6Saved = await ES<boolean>(
        `window.bridge.invoke('remotes:save', ${JSON.stringify({ id: 'h-ipv6', name: 'ipv6box', host: '2001:db8::10', platform: 'posix' })})`
      )
      const ipv6ArgvPath = `${shimPath}.argv`
      rmSync(ipv6ArgvPath, { force: true })
      const ipv6Spawned = await getDaemonClient()!
        .spawn('99004', { remote: { name: 'ipv6box', host: '2001:db8::10', platform: 'posix' } })
        .then(
          () => true,
          () => false
        )
      let ipv6ArgvOk = false
      for (let i = 0; i < 20 && !ipv6ArgvOk; i++) {
        if (existsSync(ipv6ArgvPath)) {
          const captured = readFileSync(ipv6ArgvPath, 'utf8')
          ipv6ArgvOk = captured.includes('-tt') && captured.includes('2001:db8::10')
        }
        if (!ipv6ArgvOk) await sleep(100)
      }
      getDaemonClient()?.kill('99004')
      // `platform` is a COMMAND DIALECT, not a connection capability (src/main/remotes.ts: an
      // omitted platform means posix; 'windows' is a supported dialect whose launch commands are
      // built with PowerShell quoting — asserted below as crossOsCommandsOk). A saved host with no
      // platform, or with platform 'windows', is therefore legitimately ACCEPTED. What is still
      // refused is anything that could become an ssh OPTION rather than a target:
      const leadingDashTargetRejected = !(await ES<boolean>(
        `window.bridge.invoke('remotes:save', ${JSON.stringify({ id: 'h-option', name: 'optionbox', host: '--proxy-command', platform: 'posix' })})`
      ))
      const leadingDashUserRejected = !(await ES<boolean>(
        `window.bridge.invoke('remotes:save', ${JSON.stringify({ id: 'h-user-option', name: 'useroptionbox', host: 'build.example', platform: 'posix', user: '-root' })})`
      ))
      const platformConfirmed = await ES<boolean>(
        `window.bridge.invoke('remotes:list').then((rows) => rows.some((row) => row.id === 'h1' && row.platform === 'posix'))`
      )
      const localProfilePath = 'C:\\Users\\local-only\\.codex-work'
      const localProfileSaved = await ES<boolean>(
        `window.bridge.invoke('profiles:save', ${JSON.stringify({ id: 'remote-local-profile', name: 'Local only', provider: 'codex', email: '', env: { CODEX_HOME: localProfilePath }, order: 0 })})`
      )
      const remoteProfileResult = await ES<{ ok: boolean; command?: string }>(
        `window.bridge.invoke('agents:command', ${JSON.stringify({ agentId: 'codex', cwd: '/srv/remote project', profileId: 'remote-local-profile', remote: true })})`
      )
      const remoteProfileCommand = remoteProfileResult.ok ? remoteProfileResult.command : undefined
      const remoteProfileEnvSuppressed =
        typeof remoteProfileCommand === 'string' &&
        remoteProfileCommand.includes("cd '/srv/remote project' && codex") &&
        !remoteProfileCommand.includes('CODEX_HOME') &&
        !remoteProfileCommand.includes(localProfilePath)
      const missingHostRejected = await ES<boolean>(
        `window.bridge.invoke('terminal:spawn', { id: 99001, cwd: ${JSON.stringify(repo)}, cols: 80, rows: 24, remoteHostId: 'missing-host' }).then(() => false, () => true)`
      )
      const invalidRemoteCwdRejected = await ES<boolean>(
        `window.bridge.invoke('terminal:spawn', { id: 99002, cwd: ${JSON.stringify(repo)}, cols: 80, rows: 24, remoteHostId: 'h1', remoteCwd: 'C:\\local-path' }).then(() => false, () => true)`
      )
      const directInvalidTargetRejected = await getDaemonClient()!
        .spawn('99003', {
          remote: { name: 'optionbox', host: '--proxy-command', platform: 'posix' }
        } as SpawnSpec)
        .then(
          () => false,
          () => true
        )
      // The remote workspace opens through the RESOLVED-SPEC service the Launch button uses
      // (templates.openRemote), not the low-level workspace.create helper: that is the path that
      // carries the per-pane TARGET cwd AND launches the slot's CLI — which is what the readiness
      // gate below is about. The manifest still records the remote's target cwd.
      await ES(
        `window.__mogging.templates.openRemote({ name: 'Mix', cwd: ${JSON.stringify(repo)}, assignments: ['shell', 'codex'], paneCwds: [null, ${JSON.stringify(remoteCwd)}], remotes: [null, { hostId: 'h1', name: 'buildbox', cwd: ${JSON.stringify(remoteCwd)} }] })`
      )
      await sleep(1400)
      const active = (await ES('window.__mogging.workspace.active()')) as {
        ordinal: number
        remotes?: Array<{ cwd?: string } | null>
      }
      const base = active.ordinal * 100
      const manifestCwdOk = active.remotes?.[1]?.cwd === remoteCwd

      // THE READINESS GATE. ssh output is not a ready remote shell: banners, MOTDs and
      // password/host-key prompts all arrive as bytes. The slot's agent command must not be typed
      // until the remote bootstrap's readiness marker arrives — and it must NOT be released by a
      // timeout either (this shim, like slow auth, stays silent for seconds). So: nothing typed at
      // spawn; nothing typed 16 s later (well past the former 15 s cutoff); and then the REAL
      // readiness OSC — delivered in three cuts, since a data event can split an escape sequence
      // anywhere — releases it through the terminal pane's own OSC handler.
      const typedIntoAuthPrompt = rendererWrites.some((write) => write.id === base + 2 && /codex/.test(write.data))
      await sleep(16_000)
      const authPromptGuardOk =
        !typedIntoAuthPrompt && !rendererWrites.some((write) => write.id === base + 2 && /codex/.test(write.data))
      const cuts = [REMOTE_READY_OSC.slice(0, 5), REMOTE_READY_OSC.slice(5, 19), REMOTE_READY_OSC.slice(19)]
      for (const data of cuts) {
        wc.send(TerminalChannels.data, { id: base + 2, data })
        await sleep(20)
      }
      await sleep(80)
      const readySeen = await ES<boolean>(`window.__mogging.agents.remoteReady(${base + 2})`)
      await sleep(3000)
      const remoteAgentWrite = rendererWrites.find((write) => write.id === base + 2 && /codex/.test(write.data))
      const readinessGateOk = authPromptGuardOk && readySeen && !!remoteAgentWrite

      const bufferText = (id: number): Promise<string> =>
        ES<string>(
          `(() => {
            const p = (window.__mogging.panes || []).find((x) => x.id === ${id})
            if (!p) return ''
            const b = p.term.buffer.active
            let s = ''
            for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) s += l.translateToString(true) + '\\n' }
            return s
          })()`
        )

      // 1) shim argv: -tt, -p 2222, dev@build.example, and ONE remote command — the product's own
      // bootstrap, byte for byte. The expectation is BUILT from remoteBootstrapCommand rather than
      // spelled out here: a smoke that re-types the bootstrap only asserts that someone once typed
      // it the same way twice. What is spelled out is the contract the dispatcher owes on top of
      // main's bootstrap — the readiness OSC, without which an agent launch waits forever.
      // Read from the shim's argv FILE, not the pane: the bootstrap is ~10 KB and would be wrapped
      // and scrolled out of a 55-column buffer.
      const argvPath = `${shimPath}.argv`
      let argvOk = false
      let remoteCapabilityEnvClean = false
      let buf2 = ''
      let capturedArgv = ''
      for (let i = 0; i < 24 && !(argvOk && remoteCapabilityEnvClean); i++) {
        buf2 = await bufferText(base + 2)
        capturedArgv = existsSync(argvPath) ? readFileSync(argvPath, 'utf8').replace(/^﻿/, '') : ''
        argvOk =
          buf2.includes('SSH_SHIM') &&
          capturedArgv.includes('-tt') &&
          capturedArgv.includes('\n-p\n2222\n') &&
          capturedArgv.includes('dev@build.example') &&
          capturedArgv.includes(bootstrap) &&
          bootstrap.includes('mogging-remote-ready') &&
          // exactly one remote command: everything after the target IS the bootstrap
          // (the posix shim terminates each argv line, so compare without the trailing newline)
          capturedArgv.trimEnd().endsWith(bootstrap)
        remoteCapabilityEnvClean =
          ['ENDPOINT', 'BROWSER', 'ID', 'TOKEN'].every((key) => buf2.includes(`SSH_ENV_${key}=clean`)) &&
          !buf2.includes('=LEAK')
        if (!(argvOk && remoteCapabilityEnvClean)) await sleep(500)
      }

      // 2) chips: remote pane wears the host name; local pane has NO remote chip
      const chips = (await ES(
        `(() => {
          const q = (id, sel) => document.querySelector('.layout-slot[data-pane-id="' + id + '"] ' + sel)
          const r = q(${base + 2}, '.pane-remote')
          return {
            remoteChip: r ? r.textContent : null,
            localHasRemoteChip: !!q(${base + 1}, '.pane-remote')
          }
        })()`
      )) as { remoteChip: string | null; localHasRemoteChip: boolean }
      const chipOk = chips.remoteChip === 'buildbox' && !chips.localHasRemoteChip

      // A saved-host rename changes display metadata, not SSH connection identity. Re-ensuring
      // the pane must attach to the live session and update its daemon label, never kill it.
      const renameSaved = await ES<boolean>(
        `window.bridge.invoke('remotes:save', ${JSON.stringify({ id: 'h1', name: 'buildbox-renamed', host: 'build.example', user: 'dev', port: 2222, platform: 'posix' })})`
      )
      const renameReattached = await ES<{ existing?: boolean }>(
        `window.bridge.invoke('terminal:spawn', { id: ${base + 2}, cols: 80, rows: 24, remoteHostId: 'h1', remoteCwd: ${JSON.stringify(remoteCwd)} })`
      ).then((reply) => reply.existing === true)
      await sleep(500)

      // An arbitrary remote CLI has no MCP/adapter contract. The remote bootstrap therefore
      // reports the tty foreground process cwd. Prove the daemon accepts it only while a
      // submitted command owns the pane, and rejects a delayed frame after a real prompt.
      await ES(`window.__remoteContextEvents=[]; window.bridge.on('terminal:cwd', (e) => { if (e.id === ${base + 2}) window.__remoteContextEvents.push(e) }); true`)
      const initialPrompt = `\x1b]633;P;MoggingPromptCwdRaw=${remoteCwd}\x1b\\`
      await ES(`window.bridge.send('terminal:write', { id: ${base + 2}, data: ${JSON.stringify(nodeEvalCommand(`process.stdout.write(${JSON.stringify(initialPrompt)})`) + '\r')} })`)
      await sleep(500)
      const opaqueCwd = '/srv/opaque-worktree'
      const opaqueFrame = `\x1b]633;P;MoggingProcessCwdRaw=4242;${opaqueCwd}\x1b\\`
      await ES(`window.bridge.send('terminal:write', { id: ${base + 2}, data: ${JSON.stringify(nodeEvalCommand(`process.stdout.write(${JSON.stringify(opaqueFrame)})`) + '\r')} })`)
      await sleep(500)
      const gitObservedCwd = '/srv/git-selected-worktree'
      const gitFrame = `\x1b]633;P;MoggingGitCwdRaw=${gitObservedCwd}\x1b\\`
      await ES(`window.bridge.send('terminal:write', { id: ${base + 2}, data: ${JSON.stringify(nodeEvalCommand(`process.stdout.write(${JSON.stringify(gitFrame)})`) + '\r')} })`)
      await sleep(500)
      const staleFrame = '\x1b]633;P;MoggingProcessCwdRaw=4343;/srv/stale-background\x1b\\'
      const staleSource = [
        `process.stdout.write(${JSON.stringify(initialPrompt)})`,
        `setTimeout(()=>process.stdout.write(${JSON.stringify(staleFrame)}),200)`,
        'setTimeout(()=>{},400)'
      ].join(';')
      await ES(`window.bridge.send('terminal:write', { id: ${base + 2}, data: ${JSON.stringify(nodeEvalCommand(staleSource) + '\r')} })`)
      await sleep(800)
      const remoteContextEvents = await ES<Array<{ cwd: string; source: string; locality: string }>>(
        'window.__remoteContextEvents'
      )
      const lastRemoteContext = remoteContextEvents.at(-1)
      const arbitraryRemoteContextOk =
        remoteContextEvents.some((e) => e.cwd === opaqueCwd && e.source === 'process' && e.locality === 'remote') &&
        remoteContextEvents.some((e) => e.cwd === gitObservedCwd && e.source === 'process' && e.locality === 'remote') &&
        !remoteContextEvents.some((e) => e.cwd === '/srv/stale-background') &&
        lastRemoteContext?.cwd === remoteCwd && lastRemoteContext.source === 'shell'

      // 3) honesty: local pane's git chip appears (repo cwd); remote pane's never does
      let gitOk = false
      for (let i = 0; i < 30 && !gitOk; i++) {
        gitOk = (await ES(
          `(() => {
            const q = (id) => document.querySelector('.layout-slot[data-pane-id="' + id + '"] .pane-git')
            const l = q(${base + 1})
            const r = q(${base + 2})
            return !!(l && l.classList.contains('has-git')) && !(r && r.classList.contains('has-git'))
          })()`
        )) as boolean
        if (!gitOk) await sleep(500)
      }

      // 4) `mogging list` shows the REMOTE column
      const listOut = await new Promise<string>((resolveCli) => {
        execFile(
          process.execPath,
          [cliPath, 'list'],
          { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 15000, windowsHide: true },
          (_err, stdout) => resolveCli(String(stdout))
        )
      })
      const listOk = /REMOTE/.test(listOut) && /buildbox-renamed/.test(listOut)
      const persistedReader = new SessionStore(join(runtimeDir(), 'sessions.db'))
      const persistedPane = persistedReader.loadPanes().find((p) => p.id === String(base + 2))
      const persistedRemote = persistedPane?.remote
      persistedReader.close()
      const persistedCwdOk =
        persistedPane?.cwd === '' && persistedRemote?.cwd === remoteCwd && persistedRemote.platform === 'posix' &&
        persistedRemote.name === 'buildbox-renamed'

      // Cold daemon restore must retain the SSH spec. If persistence drops it, the fresh daemon
      // creates a local shell first and the reconnecting app's later remote spec is ignored.
      const endpointFile = join(runtimeDir(), 'endpoint.json')
      const endpointPid = (): number | null => {
        try {
          return Number((JSON.parse(readFileSync(endpointFile, 'utf8')) as { pid?: number }).pid) || null
        } catch {
          return null
        }
      }
      const firstDaemonPid = endpointPid()
      getDaemonClient()?.shutdown()
      let secondDaemonPid: number | null = null
      for (let i = 0; i < 80; i++) {
        await sleep(250)
        const pid = existsSync(endpointFile) ? endpointPid() : null
        if (pid && pid !== firstDaemonPid) {
          secondDaemonPid = pid
          break
        }
      }
      await sleep(2500)
      const listAfterRestart = await new Promise<string>((resolveCli) => {
        execFile(
          process.execPath,
          [cliPath, 'list'],
          { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 15000, windowsHide: true },
          (_err, stdout) => resolveCli(String(stdout))
        )
      })
      const remoteRestoreOk =
        !!firstDaemonPid && !!secondDaemonPid && /REMOTE/.test(listAfterRestart) && /buildbox-renamed/.test(listAfterRestart)
      let gitAfterRestartOk = false
      for (let i = 0; i < 20 && !gitAfterRestartOk; i++) {
        gitAfterRestartOk = (await ES(
          `!document.querySelector('.layout-slot[data-pane-id="${base + 2}"] .pane-git.has-git')`
        )) as boolean
        if (!gitAfterRestartOk) await sleep(250)
      }

      // Launch commands use the TARGET dialect, not the OS running the app.
      const posixBuilt = await ES<AgentCommandResult>(
        `window.bridge.invoke('agents:command', { agentId: 'codex', cwd: '/srv/remote project', remoteHostId: 'h1' })`
      )
      const posixCommand = posixBuilt.command ?? ''
      const savedWindows = await ES<boolean>(
        `window.bridge.invoke('remotes:save', ${JSON.stringify({ id: 'hwin', name: 'winbox', host: 'win.example', platform: 'windows', shell: 'powershell' })})`
      )
      const windowsCwd = "D:\\Repo O'Hare"
      const windowsBuilt = await ES<AgentCommandResult>(
        `window.bridge.invoke('agents:command', { agentId: 'codex', cwd: ${JSON.stringify(windowsCwd)}, remoteHostId: 'hwin' })`
      )
      const windowsCommand = windowsBuilt.command ?? ''
      const removedWindows = (await ES(`window.bridge.invoke('remotes:remove', 'hwin')`)) as RemoteRemoveResult
      const crossOsCommandsOk =
        posixBuilt.ok && windowsBuilt.ok &&
        /cd '\/srv\/remote project' && codex/.test(posixCommand) &&
        windowsCommand.includes("Set-Location 'D:\\Repo O''Hare' -ErrorAction Stop; codex") &&
        savedWindows && removedWindows.ok

      // 5) exit of the shimmed ssh = pane exit
      await ES(`window.bridge.send('terminal:write', { id: ${base + 2}, data: 'exit\\r' })`)
      let exitOk = false
      for (let i = 0; i < 24 && !exitOk; i++) {
        exitOk = (await bufferText(base + 2)).includes('process exited')
        if (!exitOk) await sleep(500)
      }

      // A referenced host cannot be deleted through the product. This keeps
      // saved remote panes resolvable instead of converting them to local.
      const blockedDelete = (await ES(
        `window.bridge.invoke('remotes:remove', 'h1')`
      )) as RemoteRemoveResult
      const referencedDeleteBlocked = !blockedDelete.ok && blockedDelete.referencedBy?.includes('Mix') === true

      // Simulate a stale reference left by an older build/manual DB edit, then
      // reload the renderer so the saved workspace takes the real restore path.
      // Main must reject spawn before a local shell or local service-key env is
      // constructed, while the UI keeps the remote chip and explains the fault.
      getSettingsStore()?.removeRemote('h1')
      const loaded = new Promise<void>((resolve) => wc.once('did-finish-load', () => resolve()))
      wc.reload()
      await loaded
      await sleep(4500)
      const staleRestore = (await ES(
        `(() => {
          const slot = document.querySelector('.layout-slot[data-pane-id="${base + 2}"]')
          const pane = (window.__mogging.panes || []).find((item) => item.id === ${base + 2})
          let text = ''
          if (pane) {
            const b = pane.term.buffer.active
            for (let i = 0; i < b.length; i++) { const line = b.getLine(i); if (line) text += line.translateToString(true) + '\\n' }
          }
          return {
            chip: slot?.querySelector('.pane-remote')?.textContent || '',
            text,
            failed: slot?.querySelector('.pane-state')?.getAttribute('title') || ''
          }
        })()`
      )) as { chip: string; text: string; failed: string }
      const staleFlat = staleRestore.text.replace(/[\r\n]/g, '')
      const staleRestoreRefused =
        /^buildbox(-renamed)?$/.test(staleRestore.chip) &&
        /terminal failed to start/i.test(staleFlat) &&
        /no longer exists|not started locally/i.test(staleFlat) &&
        !/SSH_SHIM/.test(staleFlat)

      const pass =
        saved === true &&
        remoteMonitorPackaged &&
        remoteBootstrapParses &&
        ipv6Saved &&
        ipv6Spawned &&
        ipv6ArgvOk &&
        legacyPlatformUnconfirmed &&
        leadingDashTargetRejected &&
        leadingDashUserRejected &&
        platformConfirmed &&
        localProfileSaved &&
        remoteProfileEnvSuppressed &&
        missingHostRejected &&
        invalidRemoteCwdRejected &&
        directInvalidTargetRejected &&
        corruptPersistedRemoteRejected &&
        manifestCwdOk &&
        persistedCwdOk &&
        remoteCapabilityEnvClean &&
        renameSaved &&
        renameReattached &&
        readinessGateOk &&
        arbitraryRemoteContextOk &&
        argvOk &&
        chipOk &&
        gitOk &&
        listOk &&
        remoteRestoreOk &&
        gitAfterRestartOk &&
        crossOsCommandsOk &&
        exitOk &&
        referencedDeleteBlocked &&
        staleRestoreRefused
      result = {
        pass,
        saved,
        remoteMonitorPackaged,
        remoteBootstrapParses,
        ipv6Saved,
        ipv6Spawned,
        ipv6ArgvOk,
        legacyPlatformUnconfirmed,
        leadingDashTargetRejected,
        leadingDashUserRejected,
        platformConfirmed,
        localProfileSaved,
        remoteProfileEnvSuppressed,
        missingHostRejected,
        invalidRemoteCwdRejected,
        directInvalidTargetRejected,
        corruptPersistedRemoteRejected,
        manifestCwdOk,
        persistedCwdOk,
        remoteCapabilityEnvClean,
        renameSaved,
        renameReattached,
        authPromptGuardOk,
        arbitraryRemoteContextOk,
        remoteContextEvents,
        argvOk,
        readinessGateOk,
        readySeen,
        typedIntoAuthPrompt,
        remoteAgentWrite,
        chipOk,
        chips,
        gitOk,
        listOk,
        crossOsCommandsOk,
        posixCommand,
        windowsCommand,
        remoteRestoreOk,
        gitAfterRestartOk,
        firstDaemonPid,
        secondDaemonPid,
        exitOk,
        referencedDeleteBlocked,
        blockedDelete,
        staleRestoreRefused,
        staleRestore,
        buf2Tail: buf2.slice(-500),
        listOut: listOut.slice(0, 400),
        listAfterRestart: listAfterRestart.slice(0, 400)
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    ipcMain.off(TerminalChannels.write, onRendererWrite)
    try {
      writeFileSync(join(process.cwd(), 'out', 'remote-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(run, 2500))
  else setTimeout(run, 2500)
}
