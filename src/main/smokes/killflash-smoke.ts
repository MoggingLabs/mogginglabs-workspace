import { app, type BrowserWindow } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runtimeDir } from '../daemon-client'

// Env-gated pane-teardown quiet smoke (MOGGING_KILLFLASH). Closing a 16-pane workspace
// once flashed 16 terminal windows across the desktop the moment the undo grace lapsed:
// the daemon is console-less BY DESIGN (detached — its job-object escape and its
// pane-console independence), and node-pty's ConPTY kill() forks one console-list agent
// per pane with no windowsHide, so Windows allocated each fork a brand-new VISIBLE
// console (a full Windows Terminal window under the Win11 default-terminal handoff).
// The fix is the daemon's process-level invariant (@backend/platform/windowless-children):
// every child_process entry point in the daemon forces windowsHide. This gate holds it:
//
//   1. DETERMINISTIC — the daemon owns NO console (AttachConsole fails with
//      ERROR_INVALID_HANDLE). Guards `detached` staying on the daemon spawn: losing it
//      would put the daemon in libuv's kill-on-job-close job (dies with the app — the
//      SURVIVE regression) and is also the precondition the flash class grows from.
//   2. BEHAVIORAL — a real 16-pane workspace close, undo grace lapsing, the full kill
//      storm — while a Win32 EnumWindows watcher polls ~12ms for console-class windows
//      (ConsoleWindowClass + Windows Terminal's CASCADIA_HOSTING_WINDOW_CLASS) that
//      ever turn VISIBLE. Invisible ones are expected artifacts (CREATE_NO_WINDOW
//      keeps a headless conhost whose hidden window EnumWindows still sees); a visible
//      one is the regression. Caveat: assumes WT's default windowingBehavior (new
//      window per session, a new HWND) — the canonical gate machines' default.
//
// Win32-only by nature: the invariant under test IS Windows console allocation.

const PROBE_PS1 = String.raw`
param([int]$TargetPid)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class KfProbe {
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
}
'@
$null = [KfProbe]::FreeConsole()
$ok = [KfProbe]::AttachConsole([uint32]$TargetPid)
$err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
$h = [KfProbe]::GetConsoleWindow()
[pscustomobject]@{ attached = [bool]$ok; err = $(if ($ok) { 0 } else { $err }); hwnd = $h.ToInt64() } | ConvertTo-Json -Compress
`

const WATCH_PS1 = String.raw`
param([string]$OutFile, [int]$DurationMs = 14000)
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class KfWatch {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  public static List<string> ConsoleWindows() {
    var found = new List<string>();
    EnumWindows((h, l) => {
      var sb = new StringBuilder(256);
      GetClassName(h, sb, 256);
      var cls = sb.ToString();
      if (cls == "ConsoleWindowClass" || cls == "CASCADIA_HOSTING_WINDOW_CLASS") {
        uint pid; GetWindowThreadProcessId(h, out pid);
        found.Add(h.ToInt64() + "|" + cls + "|" + pid + "|" + (IsWindowVisible(h) ? 1 : 0));
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
  $baseline = @{}
  foreach ($w in [KfWatch]::ConsoleWindows()) { $baseline[($w.Split('|')[0])] = $true }
  $tracked = @{}
  $ticks = 0
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $DurationMs) {
    $ticks++
    foreach ($w in [KfWatch]::ConsoleWindows()) {
      $parts = $w.Split('|')
      $vis = ($parts[3] -eq '1')
      if ($baseline.ContainsKey($parts[0])) { continue }
      if ($tracked.ContainsKey($parts[0])) {
        if ($vis) { $tracked[$parts[0]].everVisible = $true }
      } else {
        $owner = ''
        try { $owner = (Get-Process -Id ([int]$parts[2]) -ErrorAction Stop).ProcessName } catch {}
        $tracked[$parts[0]] = [pscustomobject]@{
          hwnd = [long]$parts[0]; firstMs = $sw.ElapsedMilliseconds; cls = $parts[1]
          pid = [int]$parts[2]; owner = $owner; everVisible = $vis
        }
      }
    }
    Start-Sleep -Milliseconds 12
  }
  [pscustomobject]@{ ok = $true; ticks = $ticks; baselineCount = $baseline.Count
    entries = @($tracked.Values | Sort-Object firstMs) } | ConvertTo-Json -Depth 4 | Out-File $OutFile -Encoding utf8
} catch {
  [pscustomobject]@{ ok = $false; error = "$_" } | ConvertTo-Json | Out-File $OutFile -Encoding utf8
}
`

interface WatchEntry {
  hwnd: number
  firstMs: number
  cls: string
  pid: number
  owner: string
  everVisible: boolean
}

export function runKillFlashSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 120000)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const emit = (o: object): void => {
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'killflash-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }
  const psFile = (name: string, body: string): string => {
    const p = join(app.getPath('temp'), name)
    writeFileSync(p, body)
    return p
  }
  const runPs = (args: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args],
        { windowsHide: true, timeout: 30000, encoding: 'utf8' },
        (err, stdout) => (err ? reject(err) : resolve(stdout))
      )
    })

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    const probePath = psFile('killflash-probe.ps1', PROBE_PS1)
    const watchPath = psFile('killflash-watch.ps1', WATCH_PS1)
    const watchOut = join(app.getPath('temp'), 'killflash-watch.json')
    try {
      if (process.platform !== 'win32') {
        emit({ pass: true, skipped: 'win32-only: the invariant under test is Windows console allocation' })
        app.exit(0)
        return
      }
      await sleep(2500)

      // 0 ── The daemon must be there (this gate is about the daemon world; the in-proc
      // fallback would silently test nothing) and must own NO console (assertion 1).
      const epPath = join(runtimeDir(), 'endpoint.json')
      if (!existsSync(epPath)) throw new Error('no daemon endpoint — in-proc fallback? this gate needs the daemon')
      const daemonPid = (JSON.parse(readFileSync(epPath, 'utf8')) as { pid: number }).pid
      const probe = JSON.parse(await runPs(['-File', probePath, '-TargetPid', String(daemonPid)])) as {
        attached: boolean
        err: number
      }
      // ERROR_INVALID_HANDLE (6) = live process, no console: exactly right. Attaching at
      // all means the daemon grew a console (detached dropped? that daemon dies with the
      // app); any other errno means the probe never proved anything.
      const daemonConsoleless = !probe.attached && probe.err === 6

      // 1 ── The worst case the bug shipped with: sixteen real panes.
      await ES('window.__mogging.workspace.create({ name: "KillFlash", paneCount: 16 })')
      await sleep(6000)
      const meta = await ES<{ id: string }>('window.__mogging.workspace.active()')
      const panesUp = (await ES<number>('window.__mogging.layout.paneCount()')) === 16

      // 2 ── Watch from BEFORE the close click through grace + kill storm + WT spawn
      // latency (~1s per window in the repro). The watcher self-exits after DurationMs.
      try {
        rmSync(watchOut, { force: true })
      } catch {
        /* stale file only */
      }
      const watchLog = join(app.getPath('temp'), 'killflash-watch.log')
      const logFd = openSync(watchLog, 'a')
      let watcherExit: number | string | null = null
      const watcher = spawn(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', watchPath, '-OutFile', watchOut, '-DurationMs', '14000'],
        { windowsHide: true, stdio: ['ignore', logFd, logFd] }
      )
      watcher.on('exit', (code, sig) => {
        watcherExit = code ?? String(sig)
      })
      watcher.on('error', (e) => {
        watcherExit = String(e)
      })
      await sleep(800)

      await ES(`(document.querySelector('.workspace-tab[data-ws-id="${meta.id}"] .ws-close')?.click(), 1)`)
      await sleep(400)
      // Fresh shells may or may not still read as live work — take either branch.
      await ES(`(document.querySelector('.modal .btn--danger')?.click(), 1)`)
      await sleep(700)
      const undoToast = await ES<boolean>(`!!document.querySelector('.toast-action')`)
      await sleep(6000) // the 5s undo grace lapses in here: dispose -> 16 pty kills
      const disposed = (await ES<number>('window.__mogging.workspace.count()')) === 0

      // Let the watcher run out its window (kills fired above; WT windows straggle).
      await sleep(8500)
      try {
        watcher.kill()
      } catch {
        /* already exited */
      }
      if (!existsSync(watchOut)) {
        const log = existsSync(watchLog) ? readFileSync(watchLog, 'utf8').slice(-1500) : '(no log)'
        throw new Error(`watcher wrote nothing (exit=${watcherExit}): ${log}`)
      }
      // PS 5.1's Out-File utf8 writes a BOM; JSON.parse rejects it.
      const watch = JSON.parse(readFileSync(watchOut, 'utf8').replace(/^\uFEFF/, '')) as {
        ok: boolean
        ticks?: number
        entries?: WatchEntry[]
        error?: string
      }
      if (!watch.ok) throw new Error(`watcher failed: ${watch.error}`)
      const entries = watch.entries ?? []
      const visibleFlashes = entries.filter((e) => e.everVisible)
      const noVisibleConsoleWindows = visibleFlashes.length === 0

      const pass = daemonConsoleless && panesUp && undoToast && disposed && noVisibleConsoleWindows
      result = {
        pass,
        daemonPid,
        daemonConsoleless,
        probe,
        panesUp,
        undoToast,
        disposed,
        noVisibleConsoleWindows,
        visibleFlashes,
        watcherTicks: watch.ticks,
        allNewConsoleWindows: entries
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    } finally {
      try {
        rmSync(probePath, { force: true })
        rmSync(watchPath, { force: true })
      } catch {
        /* best effort */
      }
    }
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 2500))
  else setTimeout(() => void run(), 2500)
}
