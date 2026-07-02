import { app, type BrowserWindow } from 'electron'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

// A batch (win) / sh (posix) script: print the argv marker, then hand over to an
// interactive local shell so the pane behaves like a real ssh session.
const SHIM_SRC =
  process.platform === 'win32'
    ? '@echo SSH_SHIM argv=%*\r\n@%COMSPEC%\r\n'
    : '#!/bin/sh\necho "SSH_SHIM argv=$@"\nexec ${SHELL:-/bin/sh}\n'

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
      await sleep(1500)

      // Saved host (pointers only) -> mixed workspace: slot 1 local repo, slot 2 remote.
      const saved = await ES<boolean>(
        `window.bridge.invoke('remotes:save', ${JSON.stringify({ id: 'h1', name: 'buildbox', host: 'build.example', user: 'dev', port: 2222 })})`
      )
      await ES(
        `window.__mogging.workspace.create({ name: 'Mix', cwd: ${JSON.stringify(repo)}, paneCount: 2, remotes: [null, { hostId: 'h1', name: 'buildbox' }] })`
      )
      await sleep(4000)
      const base = ((await ES('window.__mogging.workspace.active()')) as { ordinal: number }).ordinal * 100

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
      let buf2 = ''
      for (let i = 0; i < 24 && !argvOk; i++) {
        buf2 = await bufferText(base + 2)
        const flat = buf2.replace(/[\r\n]/g, '')
        argvOk = flat.includes('SSH_SHIM') && flat.includes('-tt') && flat.includes('2222') && flat.includes('dev@build.example')
        if (!argvOk) await sleep(500)
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
      const listOk = /REMOTE/.test(listOut) && /buildbox/.test(listOut)

      // 5) exit of the shimmed ssh = pane exit
      await ES(`window.bridge.send('terminal:write', { id: ${base + 2}, data: 'exit\\r' })`)
      let exitOk = false
      for (let i = 0; i < 24 && !exitOk; i++) {
        exitOk = (await bufferText(base + 2)).includes('process exited')
        if (!exitOk) await sleep(500)
      }

      const pass = saved === true && argvOk && chipOk && gitOk && listOk && exitOk
      result = {
        pass,
        saved,
        argvOk,
        chipOk,
        chips,
        gitOk,
        listOk,
        exitOk,
        buf2Tail: buf2.slice(-500),
        listOut: listOut.slice(0, 400)
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
