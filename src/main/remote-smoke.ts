import { app, type BrowserWindow } from 'electron'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { runtimeDir } from './daemon-client'
import { getDaemonClient } from './daemon-relay'
import { SessionStore, SettingsStore } from '@backend/features/workspace'
import type { SpawnSpec } from '@contracts'
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

// A batch (win) / sh (posix) script: print the argv marker, then hand over to an
// interactive local shell so the pane behaves like a real ssh session.
const SHIM_SRC =
  process.platform === 'win32'
    ? '@echo %*>"%~f0.argv"\r\n@echo SSH_SHIM argv=%*\r\n@if defined MOGGING_DAEMON_ENDPOINT (echo SSH_ENV_ENDPOINT=LEAK) else (echo SSH_ENV_ENDPOINT=clean)\r\n@if defined MOGGING_BROWSER_ENDPOINT (echo SSH_ENV_BROWSER=LEAK) else (echo SSH_ENV_BROWSER=clean)\r\n@if defined MOGGING_PANE_ID (echo SSH_ENV_ID=LEAK) else (echo SSH_ENV_ID=clean)\r\n@if defined MOGGING_PANE_TOKEN (echo SSH_ENV_TOKEN=LEAK) else (echo SSH_ENV_TOKEN=clean)\r\n@%COMSPEC%\r\n'
    : '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$0.argv"\necho "SSH_SHIM argv=$@"\nif [ "${MOGGING_DAEMON_ENDPOINT+x}" = x ]; then echo SSH_ENV_ENDPOINT=LEAK; else echo SSH_ENV_ENDPOINT=clean; fi\nif [ "${MOGGING_BROWSER_ENDPOINT+x}" = x ]; then echo SSH_ENV_BROWSER=LEAK; else echo SSH_ENV_BROWSER=clean; fi\nif [ "${MOGGING_PANE_ID+x}" = x ]; then echo SSH_ENV_ID=LEAK; else echo SSH_ENV_ID=clean; fi\nif [ "${MOGGING_PANE_TOKEN+x}" = x ]; then echo SSH_ENV_TOKEN=LEAK; else echo SSH_ENV_TOKEN=clean; fi\nexec ${SHELL:-/bin/sh}\n'

export function runRemoteSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 150000) // safety net
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const cliPath = join(app.getAppPath(), 'bin', 'mogging.mjs')

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
        `window.bridge.invoke('remotes:save', ${JSON.stringify({ id: 'h1', name: 'buildbox', host: 'build.example', user: 'dev', port: 2222, platform: 'posix' })})`
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
      const missingPlatformRejected = !(await ES<boolean>(
        `window.bridge.invoke('remotes:save', ${JSON.stringify({ id: 'h-unknown', name: 'unknownbox', host: 'unknown.example' })})`
      ))
      const unsupportedPlatformRejected = !(await ES<boolean>(
        `window.bridge.invoke('remotes:save', ${JSON.stringify({ id: 'h-windows', name: 'windowsbox', host: 'windows.example', platform: 'windows' })})`
      ))
      const leadingDashTargetRejected = !(await ES<boolean>(
        `window.bridge.invoke('remotes:save', ${JSON.stringify({ id: 'h-option', name: 'optionbox', host: '--proxy-command', platform: 'posix' })})`
      ))
      const leadingDashUserRejected = !(await ES<boolean>(
        `window.bridge.invoke('remotes:save', ${JSON.stringify({ id: 'h-user-option', name: 'useroptionbox', host: 'build.example', platform: 'posix', user: '-root' })})`
      ))
      const platformConfirmed = await ES<boolean>(
        `window.bridge.invoke('remotes:list').then((rows) => rows.some((row) => row.id === 'h1' && row.platform === 'posix') && !rows.some((row) => row.id === 'h-windows'))`
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
      await ES(
        `window.__mogging.workspace.create({ name: 'Mix', cwd: ${JSON.stringify(repo)}, paneCount: 2, remotes: [null, { hostId: 'h1', name: 'buildbox', cwd: ${JSON.stringify(remoteCwd)} }] })`
      )
      await sleep(4000)
      const active = (await ES('window.__mogging.workspace.active()')) as {
        ordinal: number
        remotes?: Array<{ cwd?: string } | null>
      }
      const base = active.ordinal * 100
      const manifestCwdOk = active.remotes?.[1]?.cwd === remoteCwd

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

      // 1) shim argv: -tt, -p 2222, dev@build.example (WRAP-SAFE: the pane is ~55
      // cols, so long argv lines wrap — match on the de-newlined text)
      let argvOk = false
      let remoteCapabilityEnvClean = false
      let buf2 = ''
      for (let i = 0; i < 24 && !(argvOk && remoteCapabilityEnvClean); i++) {
        buf2 = await bufferText(base + 2)
        const flat = buf2.replace(/[\r\n]/g, '')
        argvOk = flat.includes('SSH_SHIM') && flat.includes('-tt') && flat.includes('2222') && flat.includes('dev@build.example')
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

      // SSH banners and password/host-key prompts are output, but not a ready remote shell.
      // This shim never emits the bootstrap prompt frame. Keep the launch queued beyond the
      // former 15s cutoff, type nothing into auth, then prove a real readiness event releases it.
      await ES(`(() => { window.__remoteDelayedLaunch = window.__mogging.agents.launchIn(${base + 2}, 'custom:echo REMOTE_AGENT_SENTINEL', ${JSON.stringify(remoteCwd)}); return true })()`)
      await sleep(16_000)
      const authPromptGuardOk = !(await bufferText(base + 2)).includes('REMOTE_AGENT_SENTINEL')
      await ES(`window.__mogging.agents.markRemoteReady(${base + 2}); window.__remoteDelayedLaunch`)
      let delayedReadyLaunchOk = false
      for (let i = 0; i < 20 && !delayedReadyLaunchOk; i++) {
        delayedReadyLaunchOk = (await bufferText(base + 2)).includes('REMOTE_AGENT_SENTINEL')
        if (!delayedReadyLaunchOk) await sleep(250)
      }


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

      // 5) exit of the shimmed ssh = pane exit
      await ES(`window.bridge.send('terminal:write', { id: ${base + 2}, data: 'exit\\r' })`)
      let exitOk = false
      for (let i = 0; i < 24 && !exitOk; i++) {
        exitOk = (await bufferText(base + 2)).includes('process exited')
        if (!exitOk) await sleep(500)
      }

      const pass =
        saved === true &&
        remoteMonitorPackaged &&
        remoteBootstrapParses &&
        ipv6Saved &&
        ipv6Spawned &&
        ipv6ArgvOk &&
        legacyPlatformUnconfirmed &&
        missingPlatformRejected &&
        unsupportedPlatformRejected &&
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
        authPromptGuardOk &&
        delayedReadyLaunchOk &&
        arbitraryRemoteContextOk &&
        argvOk &&
        chipOk &&
        gitOk &&
        listOk &&
        remoteRestoreOk &&
        gitAfterRestartOk &&
        exitOk
      result = {
        pass,
        saved,
        remoteMonitorPackaged,
        remoteBootstrapParses,
        ipv6Saved,
        ipv6Spawned,
        ipv6ArgvOk,
        legacyPlatformUnconfirmed,
        missingPlatformRejected,
        unsupportedPlatformRejected,
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
        delayedReadyLaunchOk,
        arbitraryRemoteContextOk,
        remoteContextEvents,
        argvOk,
        chipOk,
        chips,
        gitOk,
        listOk,
        remoteRestoreOk,
        gitAfterRestartOk,
        firstDaemonPid,
        secondDaemonPid,
        exitOk,
        buf2Tail: buf2.slice(-500),
        listOut: listOut.slice(0, 400),
        listAfterRestart: listAfterRestart.slice(0, 400)
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
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
