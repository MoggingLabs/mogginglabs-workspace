# Audit re-validation — MoggingLabs Workspace, main @ 9cd1ac8

Re-validates every finding of docs/research/2026-08-01-full-feature-audit.md against main after it moved 32 commits / 133 files / +13302 -801 from the audit baseline c026463, and audits the new code the first pass could not see.

Method: one re-validation agent per feature area (each re-opened the cited code at HEAD); an adversarial challenger against every fixed/invalid/superseded verdict; 18 new-code hunters over the delta; refutation passes on new critical/high claims; a delta completeness critic.

## Verdict summary

Re-validated 332 findings across 50 areas:

- still-open: 312
- moved-still-open: 14
- invalid: 4
- fixed: 2

Only 2 findings were fixed by the 32 commits; 1 of the 4 invalid verdicts was overturned by its challenger and remains open.

## New findings (code that landed after the baseline)

- **[CRITICAL · regression · confirmed] Stale gen after a daemon heal: the pane's keystrokes are dropped forever**  
  Surface: daemon-protocol-v11 — `src/ui/features/terminal/terminal-pane.ts:529`  
  Evidence: sessionGen is set ONLY from the renderer's own spawn reply. The relay's reconnect replay spawns from MAIN (daemon-relay.ts:284 `next.spawn(id, spec, undefined, replayMode)`) and discards the new gen; gens are minted per DAEMON lifetime (session.ts:1038 `nextGen = 1`), so a restarted daemon renumbers them.  
  Recommendation: After the reconnect replay resolves, push the new gen to the renderer (a gen-refresh IPC the pane applies to sessionGen), or re-stamp in the relay's write/resize handlers from its own authoritative `gens` map.  
  Why: Open A(gen1),B(gen2), close A, reopen at id A (gen3), kill the daemon. Restore mints gens 1,2; output flows again but pane A stamps gen 3, so transport.ts:214/221 drops its every input and resize, with no exit event and no banner.
  Verifier: sessionGen is set only at terminal-pane.ts:529; the relay replay (daemon-relay.ts:284) keeps the new gen in main (:142) and forwards the renderer's stale gen verbatim (:447/:452) into transport.ts:214/221's silent drop. No respawn, no exit (:155 needs a live daemon). Severity high: needs restore gen order to diverge.

- **[CRITICAL · regression · confirmed] Renderer session gen goes stale after daemon restart; input silently refused**  
  Surface: terminal-dims-restore — `src/ui/features/terminal/terminal-pane.ts:529`  
  Evidence: sessionGen is set ONLY in spawnPty's reply (:529), stamped on write (:372) and resize (:721). The reconnect replay re-spawns from MAIN (daemon-relay.ts:284) and no IPC tells the renderer the new gen. Daemon drops mismatches: transport.ts:214 `if (pane && (typeof m.gen !== 'number' || m.gen === pane.gen)) pane.write(...)`.  
  Recommendation: In daemon-relay's write/resize handlers stamp the gen main already tracks (`gens.get(id)` when numeric) instead of forwarding cmd.gen, or push a gen-changed IPC so sessionGen refreshes on every reconnect replay.  
  Why: A fresh daemon restarts nextGen at 1 (session.ts:1038) in row order, so any pane restarted or id-reused before the crash holds a gen never reissued. Baseline was ungated (c026463 transport.ts:210), so the delta caused it.
  Verifier: sessionGen set only at spawn reply (terminal-pane.ts:529); reconnect respawns from main (daemon-relay.ts:284); no gen IPC (channels.ts:6-20); main forwards stale gen (:447,:453); new daemon remints via restore (session.ts:1266, index.ts:79) and ensure keeps it. Pane not dead so restart() (:592) unreachable. Critical.

- **[CRITICAL · bug] persistWindows treats an unreadable HKCU Path as empty and overwrites the user's PATH**  
  Surface: Install engine has zero executed coverage — `src/backend/platform/env-path.ts:383`  
  Evidence: `run()` returns null on any execFile error/timeout and parseRegPath(null) is null (:373). Then `const raw = existing?.value ?? ''` (:383) and `reg add HKCU\Environment /v Path /t <kind> /d next /f` (:389) writes `next` = the new dirs ALONE, /f, no backup.  
  Recommendation: Return the reg exit code from run() and require a successful HKCU query before writing; when the read failed, return {ok:false,error} instead of calling `reg add`. Only a genuine 'value absent' result may write a from-scratch Path.  
  Why: Same failure class the code guards in setup.ts capture() ('empty from a failed command means we do not know'), but the registry read has no such guard on the write path. Trigger: reg.exe blocked by EDR/policy, or the 6s run() timeout.

- **[CRITICAL · bug] Transient `reg query` failure makes persistWindows overwrite the user's whole HKCU PATH**  
  Surface: persistUserPathEntries can wipe HKCU Path — `src/backend/platform/env-path.ts:383`  
  Evidence: run() resolves null for BOTH "absent" and "failed/timed out" (:80-89, timeout 6000). persistWindows does `const raw = existing?.value ?? ''` (:383), builds next from raw+added (:384), then `reg add ... /v Path /d next /f` (:389) which overwrites; broadcastEnvironmentChange (:393) publishes it.  
  Recommendation: Make run() return {ok, code, stdout}; in persistWindows distinguish reg's "value not found" (exit 1) from any other failure/timeout and write nothing on the latter. Read the value back after `reg add` and refuse to broadcast if the pre-read entries are gone.  
  Why: reg.exe is spawned while setup concurrently spawns npm/winget; a 6s timeout, AV interception or spawn failure all yield null. The persisted PATH is then replaced by only the new bin dirs, irreversibly, and pushed to Explorer.

- **[HIGH · bug · confirmed] `npm run rebuild:native` deletes the pinned conpty pair and never re-overlays it**  
  Surface: conpty-v2-and-pin — `scripts/rebuild-native.mjs:71`  
  Evidence: `rmSync(node_modules/<mod>/build, {recursive:true})` wipes build/Release/conpty/*. It then runs install-app-deps (no npm lifecycle, so node-pty's post-install.js never repopulates it), verifies only `.node` files (lines 96-98), and never chains build-node-helper.mjs — the only thing that restores the pin.  
  Recommendation: Append `node scripts/build-node-helper.mjs` after install-app-deps in rebuild-native.mjs, and add build/Release/conpty/conpty.dll to its post-rebuild existence check alongside the .node files.  
  Why: node-pty utils.js:19 resolves build/Release before prebuilds, and src/win/conpty.cc:170-186 derives the dll path from conpty.node's directory — so Electron-side spawnPty then throws "Cannot find conpty.dll".
  Verifier: rebuild-native.mjs:71 wipes build/Release/conpty; @electron/rebuild runs node-gyp only, so node-pty post-install.js never reruns and only build-device-key is chained. electron-builder.yml:66 admits overlayConpty is sole filler; check-conpty-pin.mjs:60 skips absent files. Severity medium: daemon node_deps untouched.

- **[HIGH · gap · confirmed] CONPTYPIN cannot see an ABSENT conpty pair, which useConptyDll made fatal**  
  Surface: conpty-v2-and-pin — `scripts/check-conpty-pin.mjs:63`  
  Evidence: `if (!existsSync(dir)) continue` (line 60) and `if (!existsSync(p)) continue` (line 63) skip anything missing, then line 80 prints `conpty pin OK — ${checked} staged file(s)` with checked possibly 0. The header claims every staged pair byte-matches the vendored one.  
  Recommendation: On win32 require checked > 0 and assert the pair EXISTS wherever a node-pty root exists (fail on node-pty with no conpty/ dir); off win32 print SKIPPED rather than OK, so green never means "nothing inspected".  
  Why: The gate targets the downgrade risk. Under useConptyDll a MISSING dll is a hard spawn throw, not a downgrade — and that is exactly the state the gate skips, so it stays green over the failure it guards.
  Verifier: Lines 60/63 skip absent dir/file; line 80 prints OK with checked=0. conpty.cc:181-186 throws "Cannot find conpty.dll" under pty-host.ts:107. No presence guard: native-preflight checks .node only, helper probe spawns without useConptyDll. Severity medium — absence is loud, caught by CONPTY smoke (qa-smokes.sh:369).

- **[HIGH · behavior-mismatch] MOGGING_CONPTY_V1 kill switch is inert against the live detached daemon**  
  Surface: conpty-v2-and-pin — `src/backend/platform/pty-host.ts:107`  
  Evidence: Lines 91-94 promise "set MOGGING_CONPTY_V1=1 to fall back". The flag is read in the pty-spawning process (the daemon), whose env is captured once at spawn (daemon-client.ts:321 `{...process.env}`); daemon-client.ts:263 returns the EXISTING daemon whenever `existing.build === expected`.  
  Recommendation: Carry the conpty backend choice in the daemon endpoint stamp and retire/respawn when it differs from the app's current choice (same machinery as the build-stamp retire), or send the choice per spawn request.  
  Why: The only documented recovery for a machine where v2 misbehaves does nothing until the user finds and kills the detached daemon by hand, with no log or UI saying the flag was ignored.

- **[HIGH · test-gap · confirmed] No gate types into a pane after a daemon restart, so that regression ships green**  
  Surface: daemon-protocol-v11 — `src/main/smokes/daemonheal-smoke.ts:90`  
  Evidence: DAEMONHEAL runs `startDaemonBackend(() => null)` — no renderer — kills the daemon (line 96) and asserts only that a new endpoint appears and the loss/reconnect lines were journalled. RESTOREDIMS' new gen checks (restoredims-smoke.ts:170-178) drive a raw DaemonClient that stamps the correct gen by construction.  
  Recommendation: Add a renderer-path arm to DAEMONHEAL or SURVIVE: spawn a pane through the IPC handlers, kill the daemon, wait for the heal, then send TerminalChannels.write carrying the pane's ORIGINAL SpawnResult.gen and assert the bytes reach the pty.  
  Why: Each half is proven alone: the daemon refuses a stale gen, the socket heals. Nothing proves the surviving invariant — that a pane still ACCEPTS input after a heal — so the stale-gen failure passes every gate in scripts/qa-smokes.sh.
  Verifier: High stands. DAEMONHEAL:90 spawns no pane, so the replay loop (relay:279) is empty; ROLERACE:51 kills the daemon but never types. Real bug: terminal-pane.ts:529 stamps gen once, the heal respawns from MAIN (relay:284), no channel returns the new gen, relay:447 forwards the stale one, transport.ts:214 drops it.

- **[HIGH · gap · confirmed] Only 2 of the app's pane-write call sites stamp a gen; the late async ones do not**  
  Surface: daemon-protocol-v11 — `src/ui/features/terminal/pane-drop.ts:179`  
  Evidence: insertExplorerPath awaits clipboardEnv() (line 176) then writes ungated: `terminalClient.write({ id: paneId, data: plan.data })`. Same at line 215, at the async pasteFromClipboard (terminal-pane.ts:920), the typeIntoPane port (terminal/index.ts:25), auth-runner.ts:119. Only onData (372) and the fit resize (721) carry gen.  
  Recommendation: Route every renderer write through one helper that stamps the owning pane's sessionGen (expose it via the pane registry for pane-drop, the typeIntoPane port and auth-runner) so the guard covers all senders, not keystrokes only.  
  Why: Drop a file, close the pane during the clipboardEnv IPC hop, let a new pane take the id. The relay tombstone is cleared by the successor's `spawned` and the write has no gen, so the path is typed into the successor session.
  Verifier: Daemon takes gen-less input (transport.ts:214); tombstone clears on successor spawned (daemon-relay.ts:139/446). But auth-runner:119 IS guarded (dispose->forgetPane->whenPaneLive false, auth-runner.ts:66); :25/904 sync; clipboardEnv memoized => drop window ~1 microtask. Real hole: terminal-pane.ts:920. Sev medium.

- **[HIGH · bug · confirmed] RESTOREDIMS PATH strip does not hold on macOS: the gate can launch a real agent**  
  Surface: terminal-dims-restore — `src/main/smokes/restoredims-smoke.ts:97`  
  Evidence: Sets `process.env.PATH = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin:/bin'` and claims the typed 'claude --resume' "resolves to NOTHING — never a real agent on a dev machine". But panes spawn a LOGIN shell on POSIX: session.ts:489 `let args = spec.args ?? (isWin ? [] : ['-l'])`.  
  Recommendation: Neutralize platform-independently: spawn the smoke pane with an explicit non-login shell (spec.args: []), or type a command name that exists on no machine (e.g. 'mogging-restoredims-probe') rather than relying on a stripped PATH surviving profile sourcing.  
  Why: macOS /etc/profile and /etc/zprofile run path_helper, rebuilding PATH from /etc/paths (/usr/local/bin), and ~/.zshrc adds more — so a global `claude` resolves. Windows cmd.exe sources no profile, so the same gate is safe there only.
  Verifier: Confirmed, stronger than stated: session.ts:543 swaps in paneShellLaunch args whose rc files deliberately re-source login profiles (shell.ts:111-114 bash, 164-191 zsh ZDOTDIR->user .zprofile/.zshrc), so path_helper/brew rebuild PATH. No guard; RESTOREDIMS unskipped on the macos-26 sweep. Severity: medium (gate-only).

- **[HIGH · gap · confirmed] RESTOREDIMS gates only the daemon half; the renderer's dims rule has none**  
  Surface: terminal-dims-restore — `src/main/smokes/restoredims-smoke.ts:24`  
  Evidence: The smoke is windowless and drives a hand-built DaemonClient; every dims assertion comes from the daemon protocol. The product-side half of a7e383b is terminal-pane.ts:510 `const measured = proposeGrid(this.term) !== null`, and tests/unit/attach-dims.test.ts covers only specDimsUsable/attachDims.  
  Recommendation: Add a renderer-side assertion (PANEFIT already drives a hidden second workspace) that a pane mounted under display:none records a spawn request with cols/rows absent, via the existing DEV __mogging observation seam.  
  Why: Reverting terminal-pane.ts:510-516 to `cols: this.term.cols` restores the 80x24-resizes-a-surviving-agent bug the commit names, while RESTOREDIMS, REATTACHFIT and PANEFIT all stay green.
  Verifier: Hidden workspaces do mount panes (slots.ts:18, global.css:2233 display:none), proposeGrid nulls, so terminal-pane.ts:510 is the sole product guard; daemon-relay.ts:422 and session.ts:1193 apply invented dims unfiltered. RESTOREDIMS/REATTACHFIT are windowless, PANEFIT checks fit only, no test touches terminal-pane.

- **[HIGH · bug · confirmed] RESTORE_MODE_RESET homes the cursor: the restored shell paints over its own history**  
  Surface: terminal-audit-fixes — `src/backend/features/terminal/pane-shared.ts:61`  
  Evidence: RESTORE_MODE_RESET = '\x1b[?1049l…\x1b[?25h\x1b[r\x1b[m', appended after the replayed history (session.ts:480). In xterm's build: resetMode 1049 → 'activateNormalBuffer(), 1049===e.params[t]&&this.restoreCursor()', and setScrollRegion ('\x1b[r') ends with '_setCursor(0,0)'.  
  Recommendation: Drop the cursor-moving members: use \x1b[?1047l instead of ?1049l, and if the scroll region must be reset, follow \x1b[r with an explicit reposition (\x1b[999;1H\r) so the fresh shell starts below the replayed history.  
  Why: Both ?1049l (restoreCursor to savedX/savedY, default 0,0) and CSI r (_setCursor(0,0)) move the cursor to viewport row 0, so the fresh shell's prompt overwrites the last restored screen.
  Verifier: No guard: session.ts:480 seeds it, daemon-client.ts:536/550 forwards, terminal-pane.ts:343 writes it raw into a fresh xterm 6.0.0, where DECRST 1049 calls restoreCursor (y=0) and CSI r calls _setCursor(0,0). Severity medium, not high: Windows ConPTY's boot frame repaints the viewport anyway (panerestart-smoke.ts:100).

- **[HIGH · regression · confirmed] Reconnect 'suppress' silently discards every byte the pty emitted during the disconnect**  
  Surface: terminal-audit-fixes — `src/main/daemon-relay.ts:278`  
  Evidence: reconnect: `const replayMode = daemonPid === prevPid ? 'suppress' : 'reset'`; daemon-client.ts:527 `if (replay !== 'suppress')` skips onData entirely. At c026463 the same path ran `if (m.scrollback) this.events.onData?.(...)` unconditionally. Disconnects go undetected for HEARTBEAT_STALE_FACTOR 2.5 × 10s (daemon-client.ts:387).  
  Recommendation: Do not drop the ring on a flap: either reset-and-repaint on both branches, or have the daemon return only the bytes appended since the client's last acknowledged ring offset so the gap is delivered exactly once.  
  Why: The ring holds output produced while the socket was down; suppressing the replay means that window is never painted — including mode-exit bytes (?2026l, ?2004l, ?1049l) that leave xterm desynced from the live process.
  Verifier: relay:278 'suppress' -> client:527 skips onData; transport.ts:179-188 shows the spawn reply's ring is the only carrier of gap bytes (subscribe binds future output only). No delta cursor, no UI resync, gen unchanged. Severity: medium, not high — renderer reload/restart replays verbatim (relay:432), a recoverable gap.

- **[HIGH · bug · confirmed] winget can never be found: the Windows runtime step dead-ends**  
  Surface: agent-setup-onboarding — `src/backend/features/agents/setup.ts:287`  
  Evidence: installRuntime does `resolveOnPath('winget')` (setup.ts:287); resolveOnPath decides via statSync().isFile() (env-path.ts:322). Measured on this Win11 box: statSync on WindowsApps\winget.EXE throws EACCES (App Execution Alias) so it returns null, while execFile('winget',['--version']) returns v1.29.280.  
  Recommendation: Do not gate winget/python on a stat. Probe by spawning (`winget --version`, exit 0) or resolve App Execution Aliases explicitly; keep resolveOnPath for real files. Add a test that a WindowsApps alias reads as present.  
  Why: Verified empirically on Windows 11: the alias is unstatable but spawnable. Every user without Node gets 'winget isn't available on this PC', while macOS resolves /opt/homebrew/bin/brew fine.
  Verifier: Traced setup.ts:148->160->287; no guard, only winget ref in repo. Reproduced on Win11/Node24 in two shells: statSync on WindowsApps\winget.exe=EACCES (lstat succeeds, not sandbox), resolveOnPath null, execFile winget --version=v1.29.280. Severity high stands. Also makes usableRuntime (setup.ts:248) dead code.

- **[HIGH · bug · confirmed] Per-pane PATH repair lands in the losing env key on Windows (Path vs PATH)**  
  Surface: agent-setup-onboarding — `src/pty-daemon/session.ts:538`  
  Evidence: daemon-relay.ts:416 ships `{...serviceKeys, PATH: process.env.PATH}` as spec.env, but session.ts:532-539 layers it with a plain spread over `{...process.env}` — on Windows that block carries `Path`, so both keys survive. mergeEnv (env-path.ts:281) is applied only to shellLaunch.env and the MOGGING keys.  
  Recommendation: Build inheritedEnv with mergeEnv(process.env, {AIDER_ANALYTICS_LOG}, extraEnv, spec.env) instead of the object spread at session.ts:532-539, so the overlay's PATH deletes the inherited `Path`.  
  Why: node-pty _parseEnv (terminal.js:176) emits pairs in insertion order with no case folding or dedupe, and Windows resolves the first match — the stale daemon-era `Path`. macOS has one key, so it works there: parity break.
  Verifier: session.ts:532-539 spreads spec.env over {...process.env}; mergeEnv (env-path.ts:281) folds only overlay keys, and shellLaunch.env/extraEnv carry no PATH, so Path+PATH both survive. Verified: node keeps key 'Path' after process.env.PATH=, and a real repo node-pty spawn let stale 'Path' win. High stands.

- **[HIGH · behavior-mismatch · confirmed] aider's one-click install cannot work on macOS: pip refused, step 2 off PATH**  
  Surface: agent-setup-onboarding — `src/backend/features/agents/setup.ts:170`  
  Evidence: Permissions is skipped with 'pip installs into your user site by default' (setup.ts:170), then `python -m pip install aider-install` + `aider-install` run (registry.ts:186-187). pip gets no --user, and brew/system python3 is EXTERNALLY-MANAGED. Step 2 resolves via resolveOnPath (setup.ts:268) with no PATH re-read after step 1.  
  Recommendation: Install into a venv or pipx the app owns (or pass --user), re-run applyLivePathToProcess between install steps, and add pip script dirs (~/Library/Python/*/bin, %APPDATA%\Python\*\Scripts) to wellKnownBinDirs.  
  Why: Windows (winget python, Scripts on the registry PATH) can succeed where macOS hard-fails at the same step, and the permissions note states a pip default that does not exist. (confidence: medium)
  Verifier: No guard: setup.ts:88 and setup-panel.ts:92 offer it on all OSes. Note at setup.ts:170; bare pip at registry.ts:186-187; brew python is PEP 668 (repo CI itself needs --break-system-packages). rememberBinDir(432) is npm-only, so pip's scripts dir never reaches PATH and step 2 fails at setup.ts:268. High stands.

- **[HIGH · bug] Setup permanently edits the user's shell rc for a directory it did not create**  
  Surface: agent-setup-onboarding — `src/backend/features/agents/setup.ts:395`  
  Evidence: The 'already writable, nothing changed' branch still calls rememberBinDir(state, binDir) (setup.ts:393-395) and repairPath persists that list (:451), though createdBinDirs is documented as 'Bin directories this run created' (:429). persistPosix (env-path.ts:420) never checks whether the dir is already on PATH; persistWindows does (:377).  
  Recommendation: Only remember dirs the run actually created (drop rememberBinDir from the writable branch), and give persistPosix the same already-covered check persistWindows has so `added` reflects real writes.  
  Why: An nvm user's prefix bin (~/.nvm/versions/node/vX/bin) gets hard-coded into .zshrc by a click labelled 'Install Claude Code', pinning a node version in every future shell; nothing was broken or created.

- **[HIGH · bug · confirmed] Tier save silently skips the home you are editing if it holds a legacy override**  
  Surface: defaults-tier — `src/backend/features/agent-settings/service.ts:580`  
  Evidence: Fan-out: `const prior = homeRows.find(...); if (prior && prior.tier !== 'compiled') continue // the implicit pin: hands off` (service.ts:579-580). The UI routes EVERY save on an eligible row through setDefault (agent-config.ts:475-495) and toasts `Managed across all N accounts` on ok:true (agent-config.ts:506-511).  
  Recommendation: In setAccountDefault, before fan-out, adopt any legacy (tier-null) override for that settingId+surface at the authoring home by deleting it so fan-out compiles the key; or refuse the save, naming the account-local override.  
  Why: Configure Claude single-account (tier-null user rows), add a Work profile, then edit that key with Applies-to = All accounts: every other home is written, the primary is skipped, success is toasted, and the reload shows the old value.
  Verifier: No guard. set() writes tier-null rows at user/default (only path at 1 account); store keeps tier-null (settings-store 288) so prior matches and service 580 continues without failure, so ok true plus toast. managedBy needs tier compiled (service 253), so no badge. High stands.

- **[HIGH · bug · confirmed] A single network blip kills a device sign-in the user is still approving**  
  Surface: oauth-device-flow — `src/backend/features/integrations/oauth.ts:681`  
  Evidence: tokenRequest returns `{ok:false, reason:'Could not reach …'}` with NO errorCode on a fetch throw (oauth.ts:369-371). pollDeviceToken switches on `attempt.errorCode`; undefined falls to `default:` → `return { ok: false, reason: attempt.reason }` (oauth.ts:681-684), ending the flow.  
  Recommendation: Treat `attempt.errorCode === undefined` (transport failure, no OAuth error body) as retryable: keep looping until grant.expiresAt, optionally after N consecutive failures. Add a DEVICEFLOW lane where the fixture drops the connection mid-poll.  
  Why: The device flow polls for the 1-15 minutes a human spends in the browser — wifi roam, sleep/resume, VPN reconnect or a DNS hiccup in that window is ordinary. RFC 8628 §3.4 only ends polling on a token-endpoint error.
  Verifier: oauth.ts:369-371/379 return no errorCode; pollDeviceToken switch (669) falls to default (681-684), ending the flow. Sole caller connections.ts:591 has no retry and sets state 'error', device undefined (599-609). No fetch retry wrapper, no test coverage. Severity: medium — recoverable restart, no token or security loss.

- **[HIGH · bug] A first-party-client connection dies at first refresh, demanding the paste form**  
  Surface: oauth-device-flow — `src/main/connections.ts:1156`  
  Evidence: doRefresh resolves the client with `const client = loadClient(disco.issuer)` only; it never calls `firstPartyClientFor`. A shipped client is deliberately never persisted (first-party-clients.ts:31-33, gated by D11 `store.saved.length === 0`), so `client` is null → state 'expired', `needsClientId: noDcr ? true : undefined` (:1163-1170).  
  Recommendation: In doRefresh, fall back to `firstPartyClientFor(disco.issuer, process.env)` (same shape as connections.ts:455-461) before declaring 'The client registration is gone', so the never-persist rule and refresh can both hold.  
  Why: Any rung-2 grant carrying a refresh token (GitHub Apps with token expiration, or any provider lit via the documented MOGGING_OAUTH_CLIENT_* override) demotes to 'expired' with 'paste a client ID' — the paperwork this commit removed.

- **[HIGH · bug · confirmed] Payload-less-marker drop types text/plain into the PTY unquoted**  
  Surface: explorer-sync-laws — `src/ui/features/terminal/pane-drop.ts:171`  
  Evidence: insertExplorerPath: `if (!raw) { ... terminalClient.write({ id: paneId, data: ' ' + quotedFallback + ' ' }) }` (:165-175). quotedFallback is `getData('text/plain')` (:136) written verbatim — it never reaches quotePathsForShell, the only thing stripping CONTROL_CHARS (shell-quote.ts:23).  
  Recommendation: Delete the fallback branch — dragstart and drop ship in one renderer, so 'an older drag' cannot occur — or route quotedFallback through quotePathsForShell first. Then flip fileact-smoke.ts:355 to assert the fallback is refused, not typed verbatim.  
  Why: The drop gate is the marker's PRESENCE only; an empty value selects the unquoted branch. Any source that can set a custom dataTransfer type (an in-app <webview> guest, browser/index.ts:356) can hand a pane a newline. (confidence: medium)
  Verifier: pane-drop.ts:171 writes text/plain verbatim, bypassing quotePathsForShell (shell-quote.ts:23,45) and typeIntoPane's stripper (pane-input-port.ts:27-34); daemon-relay.ts:445 only tombstone-checks. Gate blesses it (fileact-smoke.ts:355). Needs empty marker + real user drag. Severity high stands.

- **[HIGH · bug · confirmed] Payload-less drop fallback types the drag's raw text/plain into the pty**  
  Surface: remote-insert-honesty — `src/ui/features/terminal/pane-drop.ts:171`  
  Evidence: The no-payload branch writes `terminalClient.write({ id: paneId, data: ' ' + quotedFallback + ' ' })`; quotedFallback is `getData('text/plain')` (pane-drop.ts:136), never passed through planPaneInsert's quoter nor typeIntoPane, whose CONTROL_CHARS strip (pane-input-port.ts:27-33) is the stated custody line.  
  Recommendation: Route both drop branches through typeIntoPane (or apply the same control-char strip), and refuse a fallback payload matching /[\x00-\x1f\x7f]/. Change remote-smoke's dropRemoteFallbackOk fixture to a CR-bearing payload asserting the CR never reaches the write.  
  Why: A pane accepts a text drop when the private type is merely PRESENT (pane-drop.ts:99). A page in the app's own <webview> (browser/index.ts:356) can set the marker empty and text/plain='\rcurl x|sh\r'; the pane types a CR. (confidence: medium)
  Verifier: terminalClient.write does no strip (terminal.client.ts:43) and daemon-relay.ts:445 only tombstone-checks, so raw text/plain hits the pty. typeIntoPane is never called here; setData(type,'') registers the type, so presence-only accept (pane-drop.ts:99) picks the branch. No guard, no smoke. High stands; not a regression.

- **[HIGH · bug · confirmed] Windows: live-PATH repair never reaches a pane (duplicate Path/PATH, stale wins)**  
  Surface: remote-insert-honesty — `src/pty-daemon/session.ts:538`  
  Evidence: daemon-relay.ts:418 adds `{ PATH: process.env.PATH }` to spec.env; session.ts:532-539 folds it in with a plain spread (`...process.env, ...(spec.env ?? {})`), not mergeEnv (env-path.ts:281-300, which exists to delete case-variant duplicates). On Windows Object.keys(process.env) yields 'Path' (verified here), so both keys survive.  
  Recommendation: Build inheritedEnv with mergeEnv(process.env, {AIDER_ANALYTICS_LOG}, extraEnv, spec.env) instead of the spread, and add a gate arm that spawns a pane after a PATH repair and asserts the pane's own PATH contains the new directory.  
  Why: node-pty emits key=value verbatim in insertion order (terminal.js:176-186, conpty.cc:369-378; no sort/dedupe) and Windows takes the first case-insensitive match — the stale 'Path'. macOS has one 'PATH' key, so the feature works there only.
  Verifier: session.ts:530-538 spreads spec.env ('PATH') over process.env ('Path'); mergeEnv at :548 dedupes only overlay keys (env-path.ts:283 out={...base}), and paneShellLaunch gives no PATH overlay, so both reach node-pty. Reproduced with repo node-pty (v1 and v2 dll): stale Path won. No guard in transport. High stands.

- **[HIGH · behavior-mismatch · confirmed] All-users installs skip customCheckAppRunning: no daemon retire, no details log**  
  Surface: installer-freeze-fixes — `build/installer.nsh:102`  
  Evidence: installSection.nsh:35-37 wraps `!insertmacro CHECK_APP_RUNNING` in `${ifNot} ${UAC_IsInnerInstance}`. Picking "All users" elevates at multiUserUi.nsh:153-160: the outer instance `Quit`s and the elevated INNER instance runs Section "install" — UAC_IsInnerInstance is true there, so customCheckAppRunning never executes.  
  Recommendation: Move the retire + SetDetailsPrint work into a macro also expanded from customInstall (installSection.nsh:84 runs unconditionally), or add a customInit-side retire guarded on $hasPerMachineInstallation, so the per-machine path gets the same treatment.  
  Why: The commit's two headline fixes are dead on a path installer.nsh:171-174 says is deliberately kept. In Program Files the surviving mogging-node.exe lock forces the double-extract fallback and leaves an old-binary daemon serving the new app.
  Verifier: oneClick:false -> installSection.nsh:34-38 else-arm; non-admin "All users" elevates (multiUserUi.nsh:153-159, outer Quits); inner is UAC_IsInnerInstance so allowOnlyOneInstallerInstance.nsh:37 never expands the macro. No guard exists. Severity medium: stale daemon self-heals at next launch (daemon-client.ts:263-296).

- **[HIGH · bug · confirmed] Launch refusals become invisible at the squeeze the same commit added (600px window)**  
  Surface: wizard-redesign — `src/ui/styles/global.css:4773`  
  Evidence: `@container wizard (max-width: 400px) { .path-input .path-input-status { display: none } }` (global.css:4766-4776). tryLaunch's refuse() writes ONLY to that chip: `path.setStatus({kind:'warn',text}); whereSection.scrollIntoView(); path.focus()` (wizard/index.ts:1876-1890) — it never calls showLaunchAlert().  
  Recommendation: Route tryLaunch's refuse() through showLaunchAlert(text) as launch()'s refuse() already does (index.ts:505-509), so a refused Launch always has a visible surface; or drop the display:none and let the chip wrap instead of yielding.  
  Why: minWidth is 600 (main/window.ts:99) and the rail stays at 288px there (dock-budget.ts:34: 288+280=568 ≤ 600), leaving ~312px of wizard content. Clicking Launch on a relative remote path then produces no visible change at all.
  Verifier: Traced: chip hidden at 400px container (global.css:4773, 0-2-0 beats :5564, no @layer); 312px reachable (window.ts:99 + dock-budget.ts:30-33, rail 288). updateChosen (wizard/index.ts:906-931) covers local refusals but NOT remote (:915-918), so :1884 refusal is chip-only. Severity: medium, not high.

- **[HIGH · bug · confirmed] Sign-in banner paints --info as words on an --info tint — 3.9:1 on Nord, below AA**  
  Surface: design-system-css — `src/ui/styles/global.css:3090`  
  Evidence: .pane-signin (3047-3062) fills color-mix(--info 12%, transparent) over .layout-slot's --bg-app; .pane-signin-action (3090) and .pane-signin svg (3064) paint var(--info) at --fs-11. Nord/Solarized never override --info (stays #4da3ff); light stamps #1d63d8.  
  Recommendation: Add a per-theme --info-ink (the precedent --danger-ink sets at global.css:110-118) for .pane-signin-action / svg / -text; keep --info for border and tint only. Add those selectors to a probeContrastAcrossThemes call.  
  Why: Computed with aa-probe's own formula: 3.93 Nord, 4.22 light, 4.66 solarized, 6.34 midnight. It is the CTA of a banner every first-run user sees (agents/index.ts:562 fires it 1200ms after launch).
  Verifier: Traced: banner is a direct .layout-slot child (signin-banner.ts:99); --info overridden only by light (themes.ts:90). Recomputed 3.93 nord / 4.22 light = AA fail; no smoke covers .pane-signin. But gated on result.needsSignIn (agents/index.ts:557), default midnight passes, systemic (2637, 2819). Severity: medium.

- **[HIGH · gap · confirmed] CONPTYPIN prints "conpty pin OK" after checking zero files**  
  Surface: gate-honesty-delta — `scripts/check-conpty-pin.mjs:80`  
  Evidence: :59-63 `if (!existsSync(dir)) continue … if (!existsSync(p)) continue; checked++`; :73 exits only `if (failed)`; :80 logs `conpty pin OK — ${checked} staged file(s)`. Reproduced in a scratch tree with the vendored pin and no staged trees: prints "0 staged file(s)", exit 0.  
  Recommendation: Refuse `checked === 0` on win32 with exit 1 ("no staged conpty pair — the overlay never ran"), and off win32 print `CONPTYPIN SKIPPED (not a windows host)` instead of `OK`, so zero coverage never reads as a byte-match.  
  Why: 77a258a dropped node_modules off win32 but left the pass condition as "nothing mismatched". On linux/macOS sweeps the win32-* trees are absent, so a row in the 207 total certifies green over zero bytes.
  Verifier: No checked===0 guard; run_static (qa-smokes.sh:184) grades on exit code only. Reproduced "conpty pin OK - 0 staged file(s)", exit 0; real on ubuntu/macos sweeps (ci.yml:304,389). Mitigations: :23-26/:38-41 still assert pin + vendored trees, win32 rows check 8 files. Severity: medium, not high.

- **[HIGH · bug · confirmed] MOGGING_OAUTH_CLIENT_* env var repoints a signed build's OAuth client id**  
  Surface: contracts-ipc-delta — `src/contracts/integrations/first-party-clients.ts:88`  
  Evidence: firstPartyClientEnvName builds `MOGGING_OAUTH_CLIENT_${host}`; :105 lets the override win even for issuers with no table row. connections.ts:455 and client-registry.ts:100 pass real process.env, unguarded. check-originpin.mjs bans only /MOGGING_\w*_BASE\b/; prod-artifact's HARNESS_TRIGGERS (:62-84) lacks it.  
  Recommendation: Gate the override behind an unpackaged/dev check at connections.ts:455 and client-registry.ts:100, and add the `MOGGING_OAUTH_CLIENT_` prefix to check-prod-artifact.mjs HARNESS_TRIGGERS so it cannot ship.  
  Why: ADR 0016's law is that no env var repoints what a shipped build talks to. The client id is the identity on the consent screen and the app the grant is issued to; whoever sets the var picks it.
  Verifier: Mechanism real+unguarded: connections.ts:455/:484 pass process.env; boot.ts:161 scrubs only MOGGING_CHANNEL; originpin regex MOGGING_\w*_BASE can't match a dynamic key. But high->LOW: ADR0016 §6 covers ORIGINS not identity; github row clientId:'' = nothing to repoint; documented 14-integrations.md:299; no token exfil.

- **[HIGH · bug] Read-only isolation probe mkdirs .mogging/worktrees in every folder browsed or typed**  
  Surface: Worktree preflight + split git timeouts — `src/backend/features/worktrees/index.ts:87`  
  Evidence: preflightWorktrees ends with `mkdirSync(worktreesRoot(repo), { recursive: true })` (index.ts:87). Called from the wizard's selection subscriber `probeIsolation(origin)` (wizard/index.ts:824); the folder browser fires onSelect on plain NAVIGATION (folder-browser.ts:349 -> wizard/index.ts:787).  
  Recommendation: Probe writability without persisting: mkdtempSync under repo then rmSync, or mkdir then rmdirSync back the levels this call created (rmdir refuses non-empty). If the dir must persist, write .mogging/.gitignore ('*\n') in the same step as createWorktree does.  
  Why: is-inside-work-tree is true for any subdir, so browsing repo/src/ui litters each level; typing litters one per debounce. Nothing removes them, and the probe skips the self-ignoring .gitignore createWorktree pairs with.

- **[HIGH · bug] worktree remove still capped at 15s while add got 600s — slow-repo rollback leaks**  
  Surface: Worktree preflight + split git timeouts — `src/backend/features/worktrees/index.ts:218`  
  Evidence: `const res = await git(repo, args)` for `worktree remove` takes the default QUICK_MS=15_000 (index.ts:22,217-218); only `worktree add` got CHECKOUT_MS=10min (index.ts:140). Wizard rollback calls remove per created worktree (wizard/index.ts:576-583) and says 'needs manual cleanup' on failure (:613,646).  
  Recommendation: Pass CHECKOUT_MS to the `worktree remove` call in removeWorktree (deleting a checkout costs what writing it cost); keep the `status --porcelain` probe on QUICK_MS. After a timed-out remove, follow with a best-effort `git worktree prune`.  
  Why: Trigger: 3 agents on the repo class CHECKOUT_MS names, adds ~90s each, third fails; each rollback remove is killed mid-delete and returns 'error' — half-deleted trees, live registrations and mogging/* branches all stay.

- **[HIGH · behavior-mismatch] PATH persistence diverges: Windows appends what is missing, POSIX prepends unconditionally**  
  Surface: Install engine has zero executed coverage — `src/backend/platform/env-path.ts:435`  
  Evidence: persistWindows filters against the persisted user+machine PATH (:380) and writes nothing when added is empty (:381). persistPosix has no coverage check (persistUserPathEntries filters only by isDir, :368) and rcBlock emits `export PATH="<dir>":"$PATH"` (:415) — a prepend.  
  Recommendation: In persistPosix, reuse loginShellPath() to drop entries already on the shell's PATH before writing, and change rcBlock to append (`export PATH="$PATH":"<dir>"` / `fish_add_path -ga`) so both platforms obey this file's own 'APPEND, never reorder' rule (:30).  
  Why: macOS + Homebrew node hits the writable branch (setup.ts:393) and gets a .zshrc block prepending a dir already on PATH; the same Windows case (%APPDATA%\npm) writes nothing. The prepend also outranks nvm/asdf shims.

- **[HIGH · bug] Aider setup breaks on macOS: brew Python is PEP-668 managed and pip gets no --user**  
  Surface: Install engine has zero executed coverage — `src/backend/features/agents/setup.ts:170`  
  Evidence: macOS runtime step runs `brew install python` (:327). The permissions step is skipped with 'pip installs into your user site by default.' (:170), then the install step runs registry.ts:186 `python -m pip install aider-install` — no --user, no venv. Homebrew Python ships EXTERNALLY-MANAGED and pip refuses.  
  Recommendation: For spec.requires==='python', install into an app-owned venv (python -m venv, then <venv>/bin/pip) and rememberBinDir that venv's bin; or pass --user and stop asserting user-site as pip's default in the permissions note.  
  Why: The same click succeeds on Windows (winget's per-user Python has writable site-packages) and fails on macOS with an exit code whose remedy text ('network or proxy problem', :564) does not describe it. (confidence: medium)

- **[HIGH · behavior-mismatch] macOS live-PATH read uses `zsh -lc`, which never sources .zshrc**  
  Surface: persistUserPathEntries can wipe HKCU Path — `src/backend/platform/env-path.ts:147`  
  Evidence: loginShellPath runs `run(shell, ['-lc', ...])` with `-i` deliberately omitted (:145-147). zsh sources .zshenv/.zprofile/.zlogin when login, .zshrc only when interactive. The header claims it reads the shell "where `.zshrc`/`.profile` actually write" (:24-25), and persistPosix writes to ~/.zshrc (:401).  
  Recommendation: Read PATH with an interactive-login invocation (`-ilc`) for zsh/bash behind the existing timeout, or move the persisted block to ~/.zprofile so the read half and the write half agree on one file.  
  Why: zsh is macOS's default shell and nvm/pyenv/asdf write their exports into .zshrc. The module's stated macOS purpose is not achieved for those, and it cannot observe its own persisted block.

- **[HIGH · behavior-mismatch] Persisted PATH precedence is inverted between Windows (append) and macOS (prepend)**  
  Surface: persistUserPathEntries can wipe HKCU Path — `src/backend/platform/env-path.ts:415`  
  Evidence: persistWindows appends: `[...(raw ? [raw...] : []), ...added].join(';')` (:384). rcBlock emits `export PATH="<dir>":"$PATH"` and `fish_add_path -g` (:415) — both PREPEND. The module's own rule at :29-30 is "APPEND, never reorder … everything learned here lands at the END."  
  Recommendation: Make rcBlock append (`export PATH="$PATH":"<dir>"`, `fish_add_path -ga <dir>`) so the new bin dir gets the same precedence as on Windows — or make persistWindows prepend. Pick one and state it in the module header.  
  Why: After the same one-click setup, a user with an older CLI earlier on PATH runs the NEW binary on macOS and the OLD one on Windows, from identical UI text. Platform divergence is a stated product law.

- **[HIGH · gap] Windows bin dir setup creates (~/.npm-global) is missing from wellKnownBinDirs**  
  Surface: persistUserPathEntries can wipe HKCU Path — `src/backend/platform/env-path.ts:168`  
  Evidence: setup.ts:399/425 creates `join(homedir(), '.npm-global')` and remembers it as the win32 bin dir. The win32 candidate list (:168-182) has appData/npm, nodejs, Git, pnpm, WindowsApps, .bun, .cargo, .local/bin, scoop, Python Launcher — no `.npm-global`. POSIX lists `~/.npm-global/bin` (:192).  
  Recommendation: Add `join(home, '.npm-global')` and `join(home, '.npm-global', 'bin')` to the win32 candidates in wellKnownBinDirs, so the directory this app itself creates is re-derivable at the next boot exactly as it is on macOS.  
  Why: When persistWindows refuses (quote in PATH, :386) or reg add fails (:391) the dir lives only in this process. After restart macOS self-heals from wellKnownBinDirs while Windows reports the freshly installed agent missing again.

- **[HIGH · bug] Partial fan-out failure toasts "Setting was not changed" while the default is live**  
  Surface: Two ADRs both numbered 0022 — `src/backend/features/agent-settings/service.ts:519`  
  Evidence: setAccountDefault persists the row (:507-518) then returns applyAccountDefaults verbatim (:519). One unreachable home sets `failure ??=` (:588) so :629 returns ok:false though other homes were written. UI: `title: result.ok ? savedTitle : 'Setting was not changed'` and `if (result.ok) await load(...)` (agent-config.ts:507-511).  
  Recommendation: Return ok:true plus a per-home warning from applyAccountDefaults when at least one home applied, and in agent-config.ts save() always call load(currentSnapshot.target) after a tier-routed save regardless of result.ok.  
  Why: Two claude accounts, one profile on an unwritable CLAUDE_CONFIG_DIR: an 'All accounts' save writes the reachable homes, persists the default and arms drift-restore, then tells the user nothing happened and leaves a stale panel.

- **[HIGH · behavior-mismatch] Cross-account consent hardcodes "~/.claude"; DEFAULTSUX asserts the false literal**  
  Surface: Two ADRs both numbered 0022 — `src/ui/features/settings/agent-config.ts:428`  
  Evidence: Copy says `including your primary ~/.claude` for claude. The real primary is env-resolved: resolveContext passes `env: process.env` (main/agent-settings.ts:186) and sources.ts:57 honours CLAUDE_CONFIG_DIR. defaultsux-smoke.ts:89 asserts `/primary ~\/\.claude/` while its own primary is <userData>/agent-settings-home/.claude.  
  Recommendation: Carry a display label for the resolved primary home in the snapshot (no raw path, so noPathLeak still holds) and render it in consentCrossAccount; change defaultsux-smoke.ts:89 to assert the copy names the home the smoke actually wrote.  
  Why: ADR 0022's one honesty beat names a path the app may never touch, and the gate guarding that beat pins the wrong string, so the copy cannot be corrected without a gate red. Gate honesty is a product law.

- **[MEDIUM · test-gap] CONPTY gate's v1-fallback bar passes on 100% data loss; no sweep sets the flag**  
  Surface: conpty-v2-and-pin — `src/main/smokes/conpty-smoke.ts:259`  
  Evidence: EXTREME on v1: `census(..., EXTREME_MARKS, onV1 ? EXTREME_MARKS : 0)` then `ok = dupes.length===0 && ordered && maxBlankRun<=2`. STREAM uses lossMax 60 against STREAM_MARKS 50. With zero survivors cOrder is empty ⇒ ordered true, dupes 0, blank 0 ⇒ ok true. qa-smokes.sh never sets MOGGING_CONPTY_V1.  
  Recommendation: Require `found > 0 && found >= count - lossMax` inside census.ok, cap STREAM's v1 ceiling below STREAM_MARKS, and add a CONPTY gate row run with MOGGING_CONPTY_V1=1 so the fallback is actually swept.  
  Why: pty-host.ts:92-94 and the smoke header both claim "both paths stay sweepable". As coded the v1 arm goes green on a pane that emitted nothing, and it is never executed in CI anyway.

- **[MEDIUM · bug] overlayConpty's mapped-DLL fallback throws in the case it exists for**  
  Surface: conpty-v2-and-pin — `scripts/build-node-helper.mjs:92`  
  Evidence: `catch { renameSync(dest, dest+'.stale-'+pid); copyFileSync(src,dest); rmSync(dest+'.stale-'+pid,{force:true}) } // best effort; mapped survives til exit`. Node's `force` suppresses only ENOENT; unlinking a mapped DLL on Windows fails EPERM and rmSync rethrows. overlayConpty runs unwrapped at top level.  
  Recommendation: Wrap the rmSync in try/catch as the comment intends, and sweep pre-existing `*.stale-*` files in the target dir on each overlay so the helper tree stops accumulating shipped copies of conpty.dll.  
  Why: The catch branch is only reached when copyFileSync failed on a mapped file — i.e. a live detached daemon holds conpty.dll, the normal dev state — so `npm install` aborts with EPERM there. (confidence: medium)

- **[MEDIUM · gap] Shipped v2 residual is Windows-only divergence with no gate and no doc**  
  Surface: conpty-v2-and-pin — `src/backend/platform/pty-host.ts:96`  
  Evidence: Lines 96-105 characterize a shipped defect: console-API output typed AFTER a narrow-width crossing "can paint at OFFSET rows over preserved history … Do not chase this as a renderer bug." Every marker family in conpty-smoke.ts is typed BEFORE its crossings (lines 236-241, 247-255).  
  Recommendation: Type a second marker family AFTER the narrow crossing and census both families' row order, bounding the residual with a gate; and state the Windows-only divergence in docs/12-usage.md.  
  Why: Identical Windows/macOS behavior is a product law. The v1-erasure-for-v2-offset trade was deliberate, but nothing measures the residual, so an upstream bump could widen it with every gate green. (confidence: medium)

- **[MEDIUM · gap] Vendored ConPTY binaries have no provenance; the pin gate's truth is circular**  
  Surface: conpty-v2-and-pin — `scripts/check-conpty-pin.mjs:11`  
  Evidence: build/conpty/1.25.260303002/{win10-x64,win10-arm64}/{conpty.dll,OpenConsole.exe} (~2.2MB of third-party executables) are committed with no upstream release URL, no publisher hash and no verification step; no docs/*.md mentions the pin. The gate compares staged bytes against the repo copy only.  
  Recommendation: Record the upstream Windows Terminal tag + per-file sha256 in a manifest beside the vendored tree, verify staged files against THAT, add an Authenticode check on win32, and document the bump path in docs/10-distribution.md.  
  Why: A gate whose reference is a mutable file in the same commit proves consistency, not authenticity: replacing the vendored pair passes by construction, and no written procedure exists for the next bump.

- **[MEDIUM · bug] The relay banks a resize the daemon refuses; the reconnect replay applies it**  
  Surface: daemon-protocol-v11 — `src/main/daemon-relay.ts:452`  
  Evidence: `if (spec) Object.assign(spec, { cols: cmd.cols, rows: cmd.rows })` runs unconditionally BEFORE `client.resize(..., cmd.gen)`. On reconnect that spec is replayed (line 284) and the daemon's ensure path applies it through attachDims (session.ts:1194 `if (dims) existing.resize(...)`), which is not gen-gated.  
  Recommendation: Skip the Object.assign when cmd.gen is present and differs from the relay's own `gens.get(id)`, mirroring the tombstone check one line above, so the replay spec only records dims that were actually applied.  
  Why: A stale-gen resize is refused at the daemon but laundered into the replay spec, so the next connection flap resizes the successor session to exactly the dims the guard refused — the ConPTY smear, deferred by one reconnect. (confidence: medium)

- **[MEDIUM · behavior-mismatch] 'Any second authenticated client' is ungated: absent gen passes, kill is unguarded**  
  Surface: daemon-protocol-v11 — `src/pty-daemon/transport.ts:224`  
  Evidence: `case 'kill': sessions.remove(m.id)` takes no gen and no pane token, while input/resize accept any frame that omits `gen` (214/221). The commit names 'any second authenticated client's' late resize as motivation, and transport.ts:141 states ids are public and the endpoint file is readable by every pane.  
  Recommendation: Gate `kill` on `gen` the same way (optional, present-and-stale refused), and correct the protocol.ts v11 note: the gate is a staleness guard for cooperative senders, not authorization — a hostile second client needs the pane-token binding.  
  Why: A process inside a pane can read MOGGING_DAEMON_ENDPOINT, connect, and send ungated input/resize (accepted by design) or `kill` for any id, destroying a live agent's session. The gate constrains only the client that volunteers a gen.

- **[MEDIUM · gap] A gen-refused input/resize leaves no log, error frame, or telemetry anywhere**  
  Surface: daemon-protocol-v11 — `src/pty-daemon/transport.ts:214`  
  Evidence: `if (pane && (typeof m.gen !== 'number' || m.gen === pane.gen)) pane.write(m.data)` — the else branch is empty. Every other refusal in the switch answers: boundToPane sends `{t:'error', reason:'badpaneauth'}` and logs (146-147); even a failed pty write logs 'further input dropped silently' (session.ts:790).  
  Recommendation: Log a rate-limited `input/resize REFUSED: stale gen <m.gen> != <pane.gen> for pane <id>` and reply `{t:'error', reason:'stalegen', id}`; have DaemonClient journal it via clientLog so the relay surfaces it.  
  Why: A pane gone deaf to typing (the stale-gen case above) produces zero evidence in daemon.log, the client log or telemetry, so a field report is unreproducible and triage is guesswork.

- **[MEDIUM · bug] spawnPty proves 'measured' with proposeGrid but sends xterm's stale grid**  
  Surface: terminal-dims-restore — `src/ui/features/terminal/terminal-pane.ts:510`  
  Evidence: `const measured = proposeGrid(this.term) !== null` then `cols: measured ? this.term.cols : undefined`. The two disagree by design during a burst: scheduleRefit's own doc says "xterm keeps its old grid for the duration" (terminal-pane.ts:688-690), so proposeGrid returns the new grid while term.cols is pre-transition.  
  Recommendation: Read once: `const g = proposeGrid(this.term)` and send `cols: g?.cols, rows: g?.rows` (or applyGrid(term, g) before spawning), so the dims asserted as measured are the measurement itself.  
  Why: A pane created during the 150 ms rail/template transition reaches spawnPty inside the burst, sends the stale grid as authoritative, the daemon types `run` immediately (session.ts:734), and the trailing refit then resizes mid-frame. (confidence: medium)

- **[MEDIUM · gap] Launch grace fires with a client connected, abandoning the invariant for hidden panes**  
  Surface: terminal-dims-restore — `src/pty-daemon/session.ts:757`  
  Evidence: deferLaunch arms an unconditional `setTimeout(() => this.flushPendingLaunch(), LAUNCH_DIMS_GRACE_MS)`; the constant's doc justifies it as "with no app in sight, the resume still types" (session.ts:345-350). Nothing consults this.subs, so an attached-but-hidden pane is treated exactly like a headless daemon.  
  Recommendation: Gate the grace on subscribers: on expiry flush only when this.subs.size === 0, otherwise re-arm. A connected client that has not measured yet is a pane the app will reveal, not an app that never came.  
  Why: On cold restore, a background workspace's panes attach without dims, so the resume types at the persisted guess at 15 s. If window geometry changed, the later reveal resizes mid-frame and ConPTY splices its repaint over the booted TUI. (confidence: medium)

- **[MEDIUM · gap] Persisted grid has no upper clamp: one bad measurement becomes a permanent spawn size**  
  Surface: terminal-dims-restore — `src/backend/features/workspace/session-rows.ts:46`  
  Evidence: asGridDim validates integer + floor only (:46, used at :94-95); gridFor floors but has no ceiling (pane-fit.ts:38-45), and attachDims likewise. restore() now feeds the value into the pty: session.ts:1249-1254 `cols: p.cols, rows: p.rows` reaching spawnPty({ cols: this.cols }) at session.ts:557-560.  
  Recommendation: Clamp at both ends in one place — add a ceiling (e.g. 2000 cols / 1000 rows) to gridFor, asGridDim and specDimsUsable/attachDims — so an implausible measurement is refused rather than persisted and replayed every cold start.  
  Why: A sub-pixel cell width from a font-metrics race makes floor(width/cellWidth) enormous; that grid now persists and re-spawns each boot, and restore()'s per-pane try/catch (session.ts:1284) cannot catch an OOM or hang. (confidence: medium)

- **[MEDIUM · regression] stick() deferral under DEC 2026 removes the jump pill's escape hatch from a stuck frame**  
  Surface: terminal-audit-fixes — `src/ui/features/terminal/pane-anchor.ts:184`  
  Evidence: stick() now returns after pin() when `term.modes.synchronizedOutputMode`; pin→repin also returns on the same flag (line 120). xterm has no DEC 2026 timeout — synchronizedOutput is cleared only by an explicit ?2026l. pane-scrollbar.ts:105 also bails on the flag, so the pill's visibility freezes too.  
  Recommendation: Keep the deferral but add a bounded fallback: if the mode is still set N ms after stick() (or on the pane's process exit), scroll to bottom anyway; clear the wedge by treating an exit/reset as an implicit ?2026l.  
  Why: If the ESU ending a frame is never delivered (process killed mid-frame, or a flap whose replay is now suppressed), the flag stays set forever and both doors back to the stream — jump pill and Shift+End — become no-ops. (confidence: medium)

- **[MEDIUM · bug] Restore seeding trims a persisted tail that was never cut, losing the head of history**  
  Surface: terminal-audit-fixes — `src/pty-daemon/session.ts:480`  
  Evidence: `this.buffer = trimTornStart(restore.scrollback) + RESTORE_MODE_RESET` runs unconditionally. The live ring guards the same helper: pty.service.ts:254 / session.ts:706 use `grown.length > SCROLLBACK_CHARS ? trimTornStart(grown.slice(...)) : grown`. The persist cut is `slice(-PERSISTED_SCROLLBACK_CHARS)` (session-rows.ts:64).  
  Recommendation: Only trim when the persisted tail was actually cut: `restore.scrollback.length >= PERSISTED_SCROLLBACK_CHARS ? trimTornStart(sb) : sb`, and pin the untorn-passthrough case in tests/unit/pane-shared.test.ts.  
  Why: A pane whose whole history fits under the 100k cap is not torn, yet the seed still cuts to the first newline (<400) or first ESC (<4096) — deleting the opening lines of the transcript on every cold restore.

- **[MEDIUM · bug] daemonPid recorded before the connection succeeds, poisoning the flap-vs-death verdict**  
  Surface: terminal-audit-fixes — `src/main/daemon-relay.ts:131`  
  Evidence: makeClient sets `daemonPid = endpoint.pid` at line 131, then `await c.connect()` at line 234 can reject (8s welcome timeout, socket error). reconnect captures `const prevPid = daemonPid` per loop iteration (line 269), so the retry compares the new daemon's pid against itself and picks 'suppress'.  
  Recommendation: Assign daemonPid (or better, endpoint.token, which is regenerated per daemon and immune to pid reuse) only after `await c.connect()` resolves in makeClient, and compare that identity in reconnect.  
  Why: After a real daemon death whose first reconnect attempt fails, the retry sees prevPid === daemonPid and suppresses the replay, so panes keep a dead generation's content over a brand-new shell with no repaint ever. (confidence: medium)

- **[MEDIUM · bug] Replay disposition rides the spawn waiter the timeout deletes; late replies double-paint**  
  Surface: terminal-audit-fixes — `src/main/daemon-client.ts:522`  
  Evidence: The mode is read from `this.spawnWaiters.get(m.id)` (522-526); spawn()'s timer splices the waiter out and deletes the map entry at 620-628. Reconnect calls `next.spawn(id, spec, undefined, replayMode)` (daemon-relay.ts:284) → the 5000ms default. A late `spawned` then finds no waiters → replay undefined → verbatim, unstripped.  
  Recommendation: Store the replay disposition per pane id in a separate map set at send time (cleared on the reply/error), so a spawn that times out or races a renderer-issued spawn still applies the reconnect's verdict.  
  Why: A reconnect spawn answering after 5s (or sharing the id with a renderer spawn, failing the unanimity test) reverts to verbatim: the double-paint returns, and unstripped OSC 52 lands with no renderer grace armed. (confidence: medium)

- **[MEDIUM · test-gap] RESTOREDIMS proves the mode reset by substring only, not by its effect**  
  Surface: terminal-audit-fixes — `src/main/smokes/restoredims-smoke.ts:162`  
  Evidence: `const modeGrounded = capB.includes('\x1b[?1049l') && capB.includes('\x1b[?2004l')` — the gate greps the replayed byte stream and never feeds it to a terminal. No assertion exists on where the cursor lands after RESTORE_MODE_RESET or on what the fresh shell's first output overwrites.  
  Recommendation: Feed the captured replay into a headless xterm in the gate (or a unit test) and assert buffer.active.cursorY lands on the last populated row and that the shell's first prompt appends below the replayed history.  
  Why: The gate certifies the fix that is broken: it passes on a reset string whose ?1049l and CSI r home the cursor, so the invariant it claims to guard — a clean restored repaint — is not what it measures.

- **[MEDIUM · behavior-mismatch] Persisted PATH prepends on POSIX, appends on Windows; rc block drops earlier dirs**  
  Surface: agent-setup-onboarding — `src/backend/platform/env-path.ts:415`  
  Evidence: rcBlock emits `export PATH="dir":"$PATH"` (env-path.ts:415) — a prepend — against the module's own 'APPEND, never reorder' law (:29-30), while persistWindows appends (:384). persistPosix rebuilds the fenced block from only this call's `wanted` (:432-437), so a later run with a different dir removes the earlier one.  
  Recommendation: Emit `export PATH="$PATH":"dir"` (and fish_add_path -a) to match Windows, and merge the dirs already inside the fenced block with `wanted` before rewriting it so earlier entries survive.  
  Why: Same button, opposite resolution order on the two supported platforms; and a second run whose npm prefix moved (nvm version switch) quietly deletes the previously persisted entry.

- **[MEDIUM · gap] No way to cancel a 15-minute install: setupCancel has no UI caller**  
  Surface: agent-setup-onboarding — `src/ui/features/agents/setup-panel.ts:209`  
  Evidence: The running state renders only a spinner + 'Installing…' (setup-panel.ts:206-209); dispose() just unsubscribes (:293-296). AgentChannels.setupCancel exists (channels.ts:73) and is wired in main (agents.ts:198), but grep finds no renderer caller. STEP_TIMEOUT_MS is 15 min per step (setup.ts:51).  
  Recommendation: Add a Cancel control to the running state that invokes AgentChannels.setupCancel(agentId) and surfaces the 'Cancelled.' state; keep dispose() non-cancelling so closing the wizard does not kill a run.  
  Why: A user who clicks Install by mistake, or on a metered connection, has no in-app stop: winget/npm run to completion or to a 15-minute timeout. The backend already exposes the verb.

- **[MEDIUM · bug] applyLivePathToProcess can wipe a directory added while a refresh was in flight**  
  Surface: agent-setup-onboarding — `src/backend/platform/env-path.ts:251`  
  Evidence: refreshLivePath shares an in-flight promise (:218) whose `entries` snapshot process.env.PATH at start (:219); applyLivePathToProcess assigns that whole snapshot back (:251). addToProcessPath clears `cached` but not `inFlight` (:268), and repairPath does addToProcessPath then applyLivePathToProcess back-to-back (setup.ts:449-450).  
  Recommendation: Have addToProcessPath invalidate `inFlight` too, and make applyLivePathToProcess union live.entries with the CURRENT process.env.PATH at assignment time instead of overwriting with the snapshot.  
  Why: Trigger: Settings' repair-PATH IPC (system.ts:79) or boot's refresh still running when setup adds ~/.npm-global; on Windows that dir is not in wellKnownBinDirs, so it is dropped and verify reports 'still isn't on your PATH'. (confidence: medium)

- **[MEDIUM · test-gap] Nothing tests SetupService, resolveOnPath, or the PATH persisters**  
  Surface: agent-setup-onboarding — `tests/unit/env-path.test.ts:3`  
  Evidence: env-path.test.ts imports only pure helpers (parseRegPath, expandWindowsVars, mergeEnv, pathEntries, rcBlock, loginRcFile). No test or smoke imports SetupService, resolveOnPath, persistUserPathEntries or wellKnownBinDirs; smokes assert only that a button exists (agentregistry-smoke.ts:83, homeux-smoke.ts:179).  
  Recommendation: Add unit tests over a fixture PATH for resolveOnPath (PATHEXT order, unstatable alias), persistWindows/persistPosix against a temp HOME/rc, and a SetupService run with an injected spawner asserting step verdicts and remedies.  
  Why: The commit claims 30 new unit tests and updated gates, yet every defect above sits in code no gate executes — a regression in the install decision tree goes green.

- **[MEDIUM · bug] Fan-out fires one `changed` per compiled row, blanking Settings once per row**  
  Surface: defaults-tier — `src/backend/features/agent-settings/service.ts:817`  
  Evidence: reconcileRows emits `this.options.changed?.(item.row.provider, item.target)` per ROW (service.ts:817); applyAccountDefaults reconciles every managed key × every home each run (service.ts:573). The renderer reloads on each event (agent-config.ts:731-734) and load() first does `root.replaceChildren(<spinner>)` (agent-config.ts:294).  
  Recommendation: Have applyAccountDefaults suppress per-row `changed` and emit one provider-level event after reconcileRows returns, and/or debounce the renderer's changed handler (~150ms) so a fan-out burst costs one reload.  
  Why: 6 managed defaults across 4 homes = 24 changed events for one save; each reload blanks the panel to a spinner and re-runs promotable (2 file reads per home): ~25 flickers, ~200 reads. docs/07 perception budget is law.

- **[MEDIUM · gap] Tier-managed keys lose "Restore original"; the captured baseline is deleted on release**  
  Surface: defaults-tier — `src/ui/features/settings/agent-config.ts:574`  
  Evidence: `state.managedBy ? [tier verbs] : state.desired ? [Keep value & release / Restore original]` (agent-config.ts:574-593): a tier row only offers `Stop managing everywhere`, which reaches fan-out's `removeAgentConfigOverride(row)` (service.ts:570), discarding the baselineValue captured at service.ts:593-594.  
  Recommendation: Add a second verb on tier-managed keys ("Stop managing & restore original") that runs release('restore') per home before dropping the compiled rows, or keep the compiled row's baseline in a tombstone so the original value stays recoverable.  
  Why: ADR 0022 claims every lifecycle guarantee incl. baseline restore is inherited. In fact, once a key is tier-routed its pre-default value is captured and then thrown away, with no affordance to get it back.

- **[MEDIUM · behavior-mismatch] Cross-account consent re-prompts on every default save; the code claims once-per-provider**  
  Surface: defaults-tier — `src/ui/features/settings/agent-config.ts:423`  
  Evidence: Comment: 'the FIRST save that reaches across accounts is announced once per provider — after that, `rememberKey` keeps it quiet' (agent-config.ts:423-424). confirm.ts:30 skips only if `sessionSkip.has(key)`, and confirm.ts:45 adds the key only when the user TICKS 'Don't ask again this session' (unchecked by default, confirm.ts:39).  
  Recommendation: Either persist a per-provider 'cross-account consent given' flag in the KV store and show the dialog only on the first cross-account save, or correct the comment and docs/22:83-85 to say every cross-account save is confirmed until the user opts out.  
  Why: docs/22 sells 'First-write consent'. Actual behavior is a modal on every default save and every promote-chip click (agent-config.ts:608) unless a checkbox is found and ticked — the nag the doctrine claims to avoid.

- **[MEDIUM · docs-drift] ADR says a pin adopts a same-primary-key scoped override; __pin__ makes that impossible**  
  Surface: defaults-tier — `docs/adr/0022-shared-account-defaults.md:74`  
  Evidence: ADR 0022:74-76: 'A pin saved on a key that already carries a profile-scoped override adopts that row (same primary key) — the pin subsumes the narrower intent.' But saveAccountDefault stores pins under `PIN_TARGET_PREFIX + row.targetId` (settings-store.ts:504), a different primary key, and fan-out then skips that home (service.ts:580).  
  Recommendation: Rewrite the ADR consequence to state that pins live in the `__pin__:` namespace and a pre-existing scoped override at the same home is an implicit pin fan-out will not touch; pair it with the adoption fix so 'the pin subsumes' becomes true again.  
  Why: The ADR describes behavior the `__pin__:` collision fix reversed (settings-store.ts:467-472). A reviewer reading the ADR would certify today's pin behavior as correct when it is a documented-promise violation.

- **[MEDIUM · bug] Profile removal never re-runs fan-out although the trigger's contract says it does**  
  Surface: defaults-tier — `src/main/profiles.ts:217`  
  Evidence: main/agent-settings.ts:294-296: 'a profile saved, removed, or discovered re-reaches every home for its provider'. ProfileChannels.remove (profiles.ts:207-221) calls removeProfile + removeAgentConfigTarget('profile', id) and returns — no scheduleAccountDefaultsApply, unlike save (profiles.ts:204) and discovery (profiles.ts:167).  
  Recommendation: Call scheduleAccountDefaultsApply(provider) in the remove handler after removeAgentConfigTarget (resolve the provider before removeProfile), so surviving homes recompute against the remaining tier rows.  
  Why: Pin the primary (docs/22:34-36), then delete its pointer-less profile row: the `__pin__:` pin is reaped but the scope-'user' compiled row survives, enforcing the pin's value until an authored edit or restart. (confidence: medium)

- **[MEDIUM · behavior-mismatch] The device-code request omits RFC 8707 `resource` that the poll then sends**  
  Surface: oauth-device-flow — `src/backend/features/integrations/oauth.ts:526`  
  Evidence: requestDeviceCode takes `{endpoint, clientId, scopes, extraParams, now, timeoutMs}` and posts only `client_id` + extras + `scope` (:536-537). pollDeviceToken then posts `...(o.resource ? { resource: o.resource } : {})` (:663), and connections.ts:640 passes `resource` from discovery.  
  Recommendation: Add `resource?: string` to requestDeviceCode's options and set it on the device-authorization body; pass `resource` from beginDeviceFlow (connections.ts:549-554) so both legs carry the same RFC 8707 target.  
  Why: RFC 8707 §2 covers the device authorization request. The module header says 'several servers reject the exchange without it'; an AS binding the target at device-auth time answers the poll with invalid_target. (confidence: medium)

- **[MEDIUM · gap] The gate cited for 'never a client secret here' does not read that file**  
  Surface: oauth-device-flow — `src/contracts/integrations/first-party-clients.ts:70`  
  Evidence: first-party-clients.ts:70 claims 'the CATSCHEMA secret scan enforces it'; docs/14-integrations.md:290 repeats it. check-catalog.mjs:29 sets `DIR = …/integrations/catalog` and scanSecrets runs only over `readdirSync(DIR)` JSON files (:215,:222). first-party-clients.ts is a .ts file outside DIR.  
  Recommendation: Extend check-catalog.mjs to run SECRET_PREFIXES/entropyish over src/contracts/integrations/first-party-clients.ts, plus a mutation-red proving a `ghp_…`/high-entropy literal in a FIRST_PARTY_CLIENTS row goes red.  
  Why: Gate honesty: rule 1 of the shipped-client design is 'NEVER a secret here', and the only enforcement cited never opens the file. D11's `clientSecret === undefined` is a type-level tautology, not a scan.

- **[MEDIUM · bug] A vendor-rejected first-party client strands the card with no paste form**  
  Surface: oauth-device-flow — `src/backend/features/integrations/client-registry.ts:89`  
  Evidence: resolveClient returns the shipped client (rung 2) with `ok: true`, so connections.ts:494's `needsClientId: client.needsClientId` path never runs. On redirect drift onCallback sets only `lastError: redirectDriftAdvice(...)` (connections.ts:721-724), whose first-party branch says 'a bug on our side, not something you can fix here'.  
  Recommendation: When a first-party client fails with redirect drift, set `needsClientId: true` alongside the honest sentence, restoring the paste-form escape hatch that existed at c026463 for the same issuer.  
  Why: Documented trigger (docs/14:299-302): MOGGING_OAUTH_CLIENT_GITHUB_COM set to an app with device flow off → code-flow fallback → GitHub rejects the ephemeral loopback port → dead card, no form, no way forward. (confidence: medium)

- **[MEDIUM · test-gap] FILEACT (f) cannot see the law it gates: one pane, so receiver == focused pane**  
  Surface: explorer-sync-laws — `src/main/smokes/fileact-smoke.ts:135`  
  Evidence: The fixture creates `paneCount: 1` (:135); dropOnPane targets `document.querySelector('#workspace-host .pane-body')` (:322) and asserts `relDropWrites[0] === ' ' + quotedRel + ' '`, where quotedRel is built against the root because 'the pane's cwd IS the root' (:191).  
  Recommendation: Create two panes with different cwds (root and root/src, or a worktree), focus pane A, dispatch the drop on pane B's body, and assert the write is relative to B's cwd and lands on B's id, not A's.  
  Why: With one pane whose cwd equals the explorer root, the old dragstart-side computation and the new drop-side one emit identical bytes — a regression back to getFocusedPane().cwd would still pass this gate.

- **[MEDIUM · bug] The git check-ignore cache does not follow the watcher**  
  Surface: explorer-sync-laws — `src/ui/features/explorer/index.ts:373`  
  Evidence: refreshIgnored skips cached dirs: `[rootPath, ...tree.expandedDirs()].filter((d) => d && !ignoredByDir.has(d))` (:373). The only invalidation is per-batch, `for (const d of dirs) ignoredByDir.delete(d)` in onExplorerChanged (:335) — and a dir mutated while unwatched produces no batch (watch.ts:245-251).  
  Recommendation: In onExpandedChange (:193-197) delete ignoredByDir entries for dirs no longer in [rootPath, ...expandedDirs()] before refreshIgnored, and clear the map in refresh() (:700) since Refresh is now a recovery verb. Assert dimming after re-expand in TREELIVE (h).  
  Why: The stale flag makes the LISTING re-list on expand; ignoredByDir survives. Expand src, collapse, an agent writes src/out.log (gitignored), re-expand: the new row lists but is never dimmed, indefinitely.

- **[MEDIUM · regression] Drag now hands the full absolute local path to any in-app web guest**  
  Surface: explorer-sync-laws — `src/ui/features/explorer/index.ts:553`  
  Evidence: fillDrag now sets `dt.setData('text/plain', quotePathForShell(entry.path, flavor))` (:553). At c026463 that line carried `insertTextFor(entry)` — relative to the focused pane's cwd when the file sat under it (git show 5ce4bdc, -531). The browser dock hosts arbitrary pages as in-DOM <webview> guests (browser/index.ts:356).  
  Recommendation: Add a capture-phase dragover/drop handler on the browser dock's guest viewHost that cancels any drag carrying EXPLORER_DRAG_TYPE (an explorer row is for panes and OS targets, never a remote page), and assert the refusal in a smoke.  
  Why: Dropping a row onto a page in the browser dock (an agent web UI dropzone) now yields C:\Users\<name>\... instead of src/main.ts. A real browser never exposes local paths on a file drop; this drag does, to a remote origin. (confidence: medium)

- **[MEDIUM · bug] Remote bootstrap emits the readiness OSC before entering the requested cwd**  
  Surface: remote-insert-honesty — `src/pty-daemon/session.ts:330`  
  Evidence: READY_OSC_PRINTF (session.ts:330) is commented 'so a bootstrap that exits 72 never claims to be ready', but the `cd "$requested" || … exit 72` lives in the `interactive` script exec'd after it (session.ts:276). The fish branch does the cd first (:310) and emits the OSC second (:313) — both orders in one file.  
  Recommendation: Move READY_OSC_PRINTF out of the outer bootstrap into `interactive`, immediately after the requested-cwd cd succeeds (mirroring the fish branch), so a cwd that is absent on the host fails before anything claims readiness.  
  Why: 39e4b93 made this reachable from the main door: the wizard now ships its remote cwd (controller.ts:502) and never probes it (wizard:1883). One typo → ready fires, the agent command is typed into a shell exiting 72, and is lost.

- **[MEDIUM · test-gap] REMOTE arm 6 skips the relativize bite on win32 — the gate can't fail there**  
  Surface: remote-insert-honesty — `src/main/smokes/remote-smoke.ts:482`  
  Evidence: `if (process.platform !== 'win32') { …biteFrame… }`; on Windows the smoke says 'the bite is the FLAVOR'. But a re-regression of the fixed bug still quotes posix, and with a POSIX remote cwd relativeToDir returns null, so the bytes still equal expectRemote and every arm 6 assertion stays green.  
  Recommendation: On win32, drive the bite through the focus fallback the commit names: give the remote entry no cwd so setFocusedPane falls back to meta.cwd (controller.ts:298, the local repo), then assert send-to-pane still emits the absolute POSIX bytes.  
  Why: The commit says one of the two live triggers was 'on Windows via the meta.cwd focus fallback', yet Windows is exactly the runner where the guarding assertion is inert — the gate cannot go red over what it guards.

- **[MEDIUM · docs-drift] docs/16 still describes the pre-recut drag contract it was edited alongside**  
  Surface: remote-insert-honesty — `docs/16-files.md:237`  
  Evidence: '**Drag** a row: `text/plain` carries the quoted insert, … and a private `application/x-mogging-path` marker gates the pane's drop handler'. Code now sets the marker to the RAW absolute path (explorer/index.ts:552) and text/plain to the ABSOLUTE quoted path (:553), with the insert computed at the drop target (pane-drop.ts:161-181).  
  Recommendation: Rewrite the Drag paragraph: the marker carries the raw absolute path, the drop target computes the insert (remote-first), text/plain is the absolute quoted path for outside targets — and state what the payload-less fallback types.  
  Why: The paragraph's guarantee ('dragging arbitrary selected text out of another app still cannot type itself into your terminal') is now the only stated defence, while the fallback branch types foreign text/plain verbatim.

- **[MEDIUM · regression] createDesktopShortcut:false compiles out the uninstaller's shortcut delete**  
  Surface: installer-freeze-fixes — `electron-builder.yml:209`  
  Evidence: NsisTarget.js:480 sets DO_NOT_CREATE_DESKTOP_SHORTCUT when the policy is NEVER, and uninstaller.nsh:193-195 puts `WinShell::UninstShortcut "$oldDesktopLink"` + `Delete "$oldDesktopLink"` inside `!ifndef DO_NOT_CREATE_DESKTOP_SHORTCUT`. The comment at electron-builder.yml:206-208 asserts "Uninstall is unaffected".  
  Recommendation: Add a `!macro customUnInstall` to build/installer.nsh doing `WinShell::UninstShortcut "$oldDesktopLink"` / `Delete "$oldDesktopLink"` (and $newDesktopLink), and correct the electron-builder.yml:206-208 comment.  
  Why: Trigger: install, tick the new Desktop-shortcut box, uninstall — the .lnk stays, pointing at a removed exe. At c026463 the FRESH_INSTALL default kept that delete compiled in, so the delta introduced it.

- **[MEDIUM · regression] Silent installs (/S, winget) can no longer create a desktop shortcut at all**  
  Surface: installer-freeze-fixes — `electron-builder.yml:209`  
  Evidence: With DO_NOT_CREATE_DESKTOP_SHORTCUT defined, template installer.nsh:216-247 addDesktopLink compiles to nothing. The only remaining creator is Function CreateDesktopShortcut (build/installer.nsh:246), reached solely via MUI_FINISHPAGE_SHOWREADME; installSection.nsh:102-106 shows the silent path runs only doStartApp.  
  Recommendation: Keep createDesktopShortcut at its default (or 'always') and suppress the automatic creation another way, or add an explicit `${if} ${Silent}` CreateShortCut in customInstall so silent installs match the assisted default.  
  Why: docs/10-distribution.md lists winget as a channel and winget drives NSIS with /S; those users and any scripted /S deploy lose a shortcut they got at c026463. The rename branch is gone too, so a productName change orphans the old link.

- **[MEDIUM · gap] The release pipeline never runs the WEIGHT gate it was built for**  
  Surface: installer-freeze-fixes — `.github/workflows/release.yml:229`  
  Evidence: release.yml packages at :210 then runs only `check-fuses.mjs` at :229-235 on dist/<platform>-unpacked before `Upload artifacts`. check-package-weight.mjs appears nowhere in release.yml. :210 also packages with `-c.buildDependenciesFromSource=false`, a node_modules shape no WEIGHT run ever weighs.  
  Recommendation: Add a `Package weight gate` step to release.yml right after the fuse wall gate, reusing the same APP resolution: `MOGGING_WEIGHT_APP="$APP" node scripts/check-package-weight.mjs`, so the bytes that upload are the bytes that were weighed.  
  Why: Gate honesty: the only pipeline producing user-facing bytes is unguarded, and it builds natives differently from every tree the gate does inspect. Debris regrown after the last nightly sweep ships with every gate green.

- **[MEDIUM · gap] WEIGHT cannot see inside app.asar, so several new files: negations are unasserted**  
  Surface: installer-freeze-fixes — `scripts/check-package-weight.mjs:92`  
  Evidence: The scan walks the unpacked directory (`const stack = [appDir]`, :92-105) and counts resources/app.asar as one file. Only asarUnpack'd packages are visible; the negations at electron-builder.yml:50, :79 and :80 target every node_modules package, most of which live inside app.asar. Line :24 claims "this asserts they still bite".  
  Recommendation: Enumerate app.asar entries with @electron/asar listPackage (or read the asar header) and run the same FORBIDDEN predicates plus a file count over those paths; soften the :24 claim to what is actually checked.  
  Why: A future dep that vendors sources, test files or node-addon-api headers into app.asar regrows exactly the debris this gate exists to refuse, and the gate reports green — the failure mode its own docstring says it prevents.

- **[MEDIUM · gap] Daemon image name hard-coded in installer.nsh with no gate tying it to the builder**  
  Surface: installer-freeze-fixes — `build/installer.nsh:117`  
  Evidence: installer.nsh:117 and :137 hard-code "mogging-node.exe"; scripts/build-node-helper.mjs:55 owns `const EXE = PLATFORM === 'win32' ? 'mogging-node.exe' : 'mogging-node'`. installer.nsh:110-111 says "a rename there must land here too", but no script under scripts/ or .github/ references build/installer.nsh at all.  
  Recommendation: Add a static gate that parses EXE from build-node-helper.mjs and fails if build/installer.nsh lacks that literal in both the nsProcess probe and the Win32_Process filter; wire it into scripts/qa-smokes.sh.  
  Why: This is exactly the drift that already happened: ADR 0017 renamed the daemon binary, the sweep silently matched nothing for multiple releases, and every gate stayed green until it was caught by hand on a live install.

- **[MEDIUM · behavior-mismatch] Welcome page promises per-user-only install, then the next page offers All users**  
  Surface: installer-freeze-fixes — `build/installer.nsh:198`  
  Evidence: MUI_WELCOMEPAGE_TEXT states "Nothing is installed for other users of this PC, and no reboot is needed." then "Click Next to choose where it goes." The same file at :171-174 keeps the per-user/all-users radio page, and assistedInstaller.nsh:20 renders it immediately after the welcome page.  
  Recommendation: Drop the per-user sentence from MUI_WELCOMEPAGE_TEXT (or restate it in customPageAfterChangeDir where $installMode is known) and change the closing line to "Click Next to choose who it's for."  
  Why: A user picking 'All users' installs to Program Files for every account, having just read the opposite; the closing line also mislabels the page that follows. The new screen states two things the wizard contradicts.

- **[MEDIUM · bug] Isolate hint sticks on 'Checking…' forever once a remote host is the target**  
  Surface: wizard-redesign — `src/ui/features/wizard/index.ts:1701`  
  Evidence: probeIsolation: `const target = s.remote ? '' : s.cwd.trim()`; it nulls isolatePreflight then `if (!target …) return syncIsolate()` (index.ts:1699-1712). isolationHint(null) returns 'Checking…' whenever `cwd.trim()` is non-empty (index.ts:1725-1726) — and cwd holds the REMOTE path.  
  Recommendation: In isolationHint (or syncIsolate), branch on selection.state().remote first and return a terminal line such as 'Not available on a remote host.' instead of falling through to the null-preflight 'Checking…' state.  
  Why: Choosing a saved SSH host in 'Runs on' and typing /srv/project leaves a disabled checkbox labelled 'Checking…' with no probe in flight and nothing that will ever answer it — a permanently pending control.

- **[MEDIUM · test-gap] Painted placement — the redesign's headline claim — is exercised by no gate**  
  Surface: wizard-redesign — `src/ui/features/wizard/index.ts:1996`  
  Evidence: `w.__mogging.wizardAgents = { slots, assignments, brush, arm, paint, fillAll, clear }` (index.ts:1996-2010) is documented as 'gates arm a real brush, paint real slots' but has zero callers repo-wide. wizardux/wizardfail/wizardiso/wizlayout all seed agents via `openWizard({mix:[…]})` → applyMix, never the brush.  
  Recommendation: Extend WIZARDUX: arm a brush via __mogging.wizardAgents.arm, paint slot 2 by a real pointer sweep on .gp-canvas, launch, then assert workspace.active().assignments[2] is that provider — the slot-order claim the commit rests on.  
  Why: applyMix's first-come expansion is identical to the deleted counts model, so every gate stays green if paintSlot, expandAssignments' slot ordering, or the snap.assignments substitution regressed to counts order.

- **[MEDIUM · bug] Path input's ResizeObserver never disconnects across the normal open/close cycle**  
  Surface: wizard-redesign — `src/ui/components/input.ts:65`  
  Evidence: `const retail = new ResizeObserver(() => { if (!input.isConnected) return retail.disconnect(); … }); retail.observe(input)` (input.ts:65-69), commented 'Self-disconnecting … a leak that grows by one per open.' Hidden views are display:none (global.css:1372-1378) and render() detaches the input via clear(body) (index.ts:741).  
  Recommendation: Return a dispose() from createPathInput that calls retail.disconnect(), and call it from the wizard's render()/leave() beside selection?.dispose() and cdLine?.dispose() — do not rely on a size-change observation for an already-0×0 element.  
  Why: leave() → display:none already reports 0×0; the later detach is not a size CHANGE, so the callback never runs again. Each open/Esc/reopen cycle strands one observer plus its detached input — docs/05 heap is law. (confidence: medium)

- **[MEDIUM · bug] Terminal picker opened by keyboard drops focus to <body> on close**  
  Surface: wizard-redesign — `src/ui/features/wizard/index.ts:1264`  
  Evidence: openSlotPicker calls `openContextMenu({ items, x, y, ariaLabel })` with no returnFocus (index.ts:1264-1269), while the chip's ▾ menu does pass one (index.ts:1316). context-menu's close() is `opts.returnFocus?.focus?.()` (context-menu.ts:78). The tile keydown path reaches it at grid-painter.ts:373.  
  Recommendation: Pass the anchor tile as returnFocus from grid-painter's onPickSlot call (and from openSlotPicker), and after renderAgentControls() re-focus `.gp-region` at the same index, since refreshChips() rebuilds every tile.  
  Why: Tab to a terminal tile, press Enter, choose 'Plain shell' — focus lands on body and the next Tab restarts at the top of the page, so the documented keyboard mirror of the click path is unusable for placement.

- **[MEDIUM · bug] Setup-panel remedy/ready inks miss AA — --danger-weak is never re-tinted per theme**  
  Surface: design-system-css — `src/ui/styles/global.css:7798`  
  Evidence: .agent-setup-step-remedy (7798) is --danger-ink on var(--danger-weak); --danger-weak is rgba(240,85,75,0.14) in :root and no theme in themes.ts overrides it, while --danger-ink does flip. The panel sits on --bg-inset in Home (.firstrun-cli-list:7894) and --bg-elevated in Settings (.prov-item:7857).  
  Recommendation: Give --danger-weak a per-theme value in themes.ts (light: a tint of #c92e25), or drop the fill and keep only the 2px --danger left rule. Same for .agent-setup-ready (7722): take an ink token, not the fill token.  
  Why: Measured: remedy 4.20 light-on-inset, 4.34 nord-on-elevated; .agent-setup-ready 4.49 light-on-inset. Identical defect to the one global.css:110-118 already fixed for .cc-chip.is-failing at 4.45:1.

- **[MEDIUM · test-gap] 877 new CSS lines added five component families and zero AA probe selectors**  
  Surface: design-system-css — `src/main/smokes/wizardux-smoke.ts:150`  
  Evidence: Every `selectors: [...]` passed to probeContrastAcrossThemes (boardux, brainprops, brainux, chromeux, dockux, feedbackux, fileact, homeux, setshell, treegit, uxmilestone) lacks .pane-signin*, .agent-setup*, .conn-device*, .wizard-chip*. aa-probe.ts is byte-identical to c026463; wizardux has no AA arm at all.  
  Recommendation: Add an AA arm to wizardux over ['.wizard-chip','.wizard-chip-count','.wizard-chip.is-armed','.wizard-alert-text']; extend homeux PROBES with the .agent-setup-step-* and .agent-setup-ready inks; probe .pane-signin-text/.pane-signin-action.  
  Why: The two measured AA failures above are exactly what an AA arm catches. The contrast gate did not grow with the surfaces it guards, so it goes green over code it never measured.

- **[MEDIUM · bug] --focus is undefined: three rewritten focus rules draw no outline at all**  
  Surface: design-system-css — `src/ui/styles/global.css:3284`  
  Evidence: `.layout-gutter:focus-visible { outline: var(--ring-w) solid var(--focus) }` (3284) and the .explorer-dock-handle/.browser-dock-handle twin (5995). Grepping --focus across src/ returns only these two usages: no declaration, and themes.ts THEMABLE_TOKENS has no --focus.  
  Recommendation: Declare `--focus: var(--accent)` in the ring-width token block (global.css:96-104), or substitute var(--accent) at both sites. Add a static check that every var(--x) in global.css has a matching declaration.  
  Why: An unresolvable var() makes the shorthand invalid at computed-value time, so outline-style falls back to none. The grid seam (role=separator) and both dock handles show only a tint on keyboard focus.

- **[MEDIUM · bug] Keyboard paint on a grid tile destroys its own focus**  
  Surface: design-system-css — `src/ui/components/grid-painter.ts:367`  
  Evidence: keydown (364-375): `if (opts.brush?.()) return opts.onPaint?.(i)`. wizard/index.ts:1223 paintSlot -> renderAgentControls (1375) -> refreshAgents (1778) -> painter.refreshChips, which is `refreshChips: render` (388); render() does `canvas.innerHTML = ''` (329). No focus capture/restore exists in the file.  
  Recommendation: In render(), record whether canvas.contains(document.activeElement) and the region index before clearing, then re-focus canvas.querySelectorAll('.gp-region')[idx] after the rebuild. Also covers unmerge and post-picker rebuilds.  
  Why: Painting is now the primary action on every tile (at c026463 only merged tiles reacted to Enter), so a keyboard user must Tab in from the top of the wizard for each of up to 16 terminals.

- **[MEDIUM · bug] direction:rtl on .wizard-recent-path corrupts any path ending in a bidi-neutral**  
  Surface: design-system-css — `src/ui/styles/global.css:4710`  
  Evidence: `.wizard-recent-path { direction: rtl; text-align: left }` (4705-4712) applies to the raw value r.cwd (wizard/index.ts:961, `el('span', { class: 'wizard-recent-path', text: r.cwd })`) with no LRM bracketing and no unicode-bidi isolation.  
  Recommendation: Keep the rtl box for the head-ellipsis but neutralize bidi: emit `‎${r.cwd}‎` at wizard/index.ts:961, or wrap the value in an inner span with `unicode-bidi: isolate; direction: ltr`.  
  Why: In an RTL paragraph a trailing Other-Neutral takes paragraph direction and is mirrored. `C:\Users\me\Downloads\repo (1)` renders its `)` as `(` jumped to the visual start — a path the user does not have. (confidence: medium)

- **[MEDIUM · improvement] The new device-flow panel is the one block in the delta written off the token system**  
  Surface: design-system-css — `src/ui/styles/global.css:10235`  
  Evidence: .conn-device (10227-10264) uses `border-radius: var(--radius-md, 8px)` — --radius-md is declared nowhere, so 8px always wins and 8 is off the ramp (--r-sm 6 / --r-md 10) — plus font-size 0.85rem/1.5rem/0.78rem and letter-spacing 0.18em, the only rem/em type literals in all 877 new lines.  
  Recommendation: Swap to var(--r-md), var(--fs-13)/var(--fs-24)/var(--fs-12), var(--track-wide). Extend check-spacing.mjs (or a sibling gate) to flag radius/font-size/letter-spacing literals, which no gate inspects today.  
  Why: check-spacing.mjs only matches ^\s*(padding|margin|gap|row-gap|column-gap), so radius and type literals escape every static gate; the panel's corner and type drift from every other Settings card silently.

- **[MEDIUM · gap] WEIGHT weighs whatever sits in dist/ with no proof this run produced it**  
  Surface: gate-honesty-delta — `scripts/check-package-weight.mjs:40`  
  Evidence: `const appDir = process.env.MOGGING_WEIGHT_APP ?? join(ROOT, UNPACKED ?? 'dist')`, guarded only by `if (!existsSync(appDir))`. qa-smokes.sh:322 runs it after FUSES (:314), but check-fuses.mjs packages only when MOGGING_FUSES_APP is unset (:103-113) and leaves dist/ intact when its packaging execSync throws (:118-121).  
  Recommendation: Require freshness: have check-fuses.mjs write a dist/.packaged-at stamp and make check-package-weight.mjs refuse a stamp older than this process's start time (or compare appDir's newest mtime against out/ and src/).  
  Why: A gate reading a directory it did not create can certify a stale tree. If FUSES fails at packaging, last week's dist/win-unpacked survives and WEIGHT prints "weight OK" for bytes nobody just built — same for MOGGING_GATES=WEIGHT runs. (confidence: medium)

- **[MEDIUM · gap] SURVIVE's dims justification contradicts the app's own dims-less spawn path**  
  Surface: gate-honesty-delta — `src/main/smokes/daemon-survive-smoke.ts:81`  
  Evidence: :80 claims "the app never spawns one of those without a measurement", but daemon-relay.ts:422 builds `{ … cols: req.cols, rows: req.rows … }` straight from the renderer, and restoredims-smoke.ts:139-141 models "a dims-less spawn (unmeasured pane)" whose launch the daemon defers via LAUNCH_DIMS_GRACE_MS (session.ts:757).  
  Recommendation: Fix the comment to say this smoke models a MEASURED pane and RESTOREDIMS owns the unmeasured one, or add a third SURVIVE arm: spawn a second pane dims-less in phase A and assert its grace-typed launch survived in phase B.  
  Why: The fix is right for the red but narrowed the only gate proving survival across a real app quit/relaunch to measured panes. RESTOREDIMS phase C covers grace with a 2000ms override (:204), in one process, never across a restart.

- **[MEDIUM · bug] SURVIVE_A/B keep a 120s sweep budget after the watchdog went 22s → 40s**  
  Surface: gate-honesty-delta — `scripts/qa-smokes.sh:357`  
  Evidence: `run_smoke SURVIVE_A MOGGING_SURVIVE A 120 survive SURVIVE` (:357-358) is unchanged since c026463, while b7fe6e3 raised the smoke's net at daemon-survive-smoke.ts:61 from 22000 to 40000 and added 15s polls at :97 and :148. RESTOREDIMS gets 180 (:364, 90s watchdog); CONPTY gets 180 (:366).  
  Recommendation: Raise both SURVIVE rows to 180 so the sweep's timeout stays above app boot + ensureDaemon + the 40s internal watchdog.  
  Why: The commit that made the smoke wait longer did not widen the window it waits inside. If boot + ensureDaemon exceeds ~80s, `timeout 120` kills the run before out/survive-result.json exists — verdict MISSING, without even a BOOTFAIL label. (confidence: medium)

- **[MEDIUM · gap] The 375-finding audit lands in-repo with no gate reading it**  
  Surface: gate-honesty-delta — `scripts/check-audit.mjs:22`  
  Evidence: `const file = argv… ?? 'prompts/phase-8.5/AUDIT.md'`, and qa-smokes.sh:185 passes no argument. The only repo reference to docs/research/2026-08-01-full-feature-audit.md is an ALLOWED exemption at check-credential-wording.mjs:97. Its own HIGH at :1804 names check-sweep-log.sh:10, whose `git diff c026463..HEAD` is empty.  
  Recommendation: Add `run_static AUDIT2 node scripts/check-audit.mjs docs/research/2026-08-01-full-feature-audit.md` with a resolution/owner column the parser reads, or land a findings ledger gated on "no CONFIRMED finding without a resolution".  
  Why: check-audit.mjs's header calls itself the gate that refuses green while a row is unowned, and 77a258a shipped 47 confirmed findings under a "gate honesty" commit. Nothing routes them: the sweep reports 207/207 green over them.

- **[MEDIUM · gap] first-party-clients.ts claims CATSCHEMA guards it; CATSCHEMA never reads the file**  
  Surface: contracts-ipc-delta — `src/contracts/integrations/first-party-clients.ts:70`  
  Evidence: Line 70 says a client secret here is caught by "the CATSCHEMA secret scan". check-catalog.mjs:29 sets DIR = src/contracts/integrations/catalog and :222 filters f.endsWith('.json'); the .ts file is never opened. No other script greps first-party-clients.  
  Recommendation: Extend check-catalog.mjs's SECRET_PREFIXES/entropy scan to src/contracts/integrations/first-party-clients.ts and fail on any FIRST_PARTY_CLIENTS key outside issuer/clientId/registeredIn/because — or delete the false claim.  
  Why: Gate honesty: the file documents a guard that does not exist, and it is the one place a maintainer is invited to paste vendor console values ("a one-line data change").

- **[MEDIUM · bug] Stale device sign-in code survives restart and is re-shown on the next Connect**  
  Surface: contracts-ipc-delta — `src/main/connections.ts:412`  
  Evidence: connect() sets {state:'connecting', url, lastError: undefined, needsClientId: undefined} — `device` is not reset, though needsClientId is, for this exact class of bug. sweepInterruptedFlows:1593 also keeps it. setState:210 spreads ...base and writeMeta:132 persists the Connection to the KV store.  
  Recommendation: Add `device: undefined` to the setState patches at connections.ts:412 and :1593 so every entry into 'connecting' and every boot sweep clears the code panel, as the DeviceSignIn contract comment promises.  
  Why: Quit mid-flow, reopen (sweep -> 'error', device kept), click Connect: settings/connections.ts:949 renders devicePanel for any 'connecting' card, so an expired code is shown as live.

- **[MEDIUM · behavior-mismatch] WriteCommand.gen promised on every pane write, sent only by the keystroke path**  
  Surface: contracts-ipc-delta — `src/contracts/ipc/terminal.ipc.ts:68`  
  Evidence: SpawnResult.gen says "The pane echoes it on write/resize so a stale sender — a disposed pane's late timer, a reused id's previous occupant — can be REFUSED". Only terminal-pane.ts:372 passes gen; agents.client.ts:28, board/launch.ts:155, auth-runner.ts:119, pane-drop.ts:179 omit it, and transport.ts:214 accepts any gen-less write.  
  Recommendation: Stamp gen inside terminalClient.write from the pane registry (or expose sessionGen via pane-meta) so every write site carries it — above all the timer-deferred ones: agents.client.ts:28, board/launch.ts:155, auth-runner.ts:119.  
  Why: The deferred writes are precisely the ones that outlive their session (offerSignIn fires on a 1200ms timer). Typing a launch command into a recycled id's successor is worse than the resize smear v11 was bumped for.

- **[MEDIUM · bug] Relay rewrites replay dims before the daemon adjudicates the resize gen**  
  Surface: contracts-ipc-delta — `src/main/daemon-relay.ts:452`  
  Evidence: The resize handler runs `if (spec) Object.assign(spec, { cols: cmd.cols, rows: cmd.rows })` unconditionally, then client.resize(..., cmd.gen). The only gen check is pty-daemon/transport.ts:221. daemon-relay.ts:279-286 respawns every pane from that same specs map on reconnect.  
  Recommendation: Track the live gen per pane id in daemon-relay (SpawnResult.gen already arrives there) and skip the Object.assign when cmd.gen is present and mismatched, so a refused resize cannot rewrite the replay spec.  
  Why: A stale resize the daemon correctly drops still poisons the grid a reconnect replay respawns at, reintroducing the wrong-dims respawn that the RESTOREDIMS invariant in this same delta exists to prevent. (confidence: medium)

- **[MEDIUM · bug] Setup's cancel cannot stop a Windows install — the cmd.exe wrapper absorbs the kill**  
  Surface: contracts-ipc-delta — `src/backend/features/agents/setup.ts:116`  
  Evidence: cancel() does `this.children.get(id)?.kill()`; the 15-minute watchdog at :494 does the same. Children come from spawnTool (:484), which for a .cmd wraps in `cmd.exe /d /s /c` (spawn-tool.ts:57) — and resolveOnPath returns npm.cmd on Windows. kill() ends cmd.exe only.  
  Recommendation: Kill the tree on Windows (job object, or `taskkill /PID <pid> /T /F`) in SetupService.cancel and in the exec watchdog; on POSIX spawn detached and process.kill(-pid) so the group dies with it.  
  Why: setup.ts:111 promises "nothing this service started may outlive it" for app quit and the user's Cancel. On Windows the npm install keeps running; macOS behaves differently for the same click.

- **[MEDIUM · bug] worktrees:preflight mkdirs .mogging/worktrees in every repo the wizard points at**  
  Surface: contracts-ipc-delta — `src/backend/features/worktrees/index.ts:87`  
  Evidence: preflightWorktrees ends with mkdirSync(worktreesRoot(repo), { recursive: true }) as its writability probe. wizard/index.ts:1699-1717 probeIsolation runs from the folder-selection subscriber for every browse/recent/cd and after the typing debounce — before any toggle is ticked or Launch pressed.  
  Recommendation: Probe writability non-destructively (accessSync W_OK on the nearest existing ancestor of <repo>/.mogging), or create the root only inside createWorktree; otherwise rmdir it when the preflight was the creator.  
  Why: The contract calls preflight the question asked before the toggle is offered; answering it writes into a user repository the user never asked to modify, once per folder browsed.

- **[MEDIUM · test-gap] SetupService and the toolchain channels ship with no gate or unit coverage**  
  Surface: contracts-ipc-delta — `scripts/qa-smokes.sh:186`  
  Evidence: grep for SetupService / AgentChannels.setup / toolchainStatus / repairPath across tests/unit, scripts/ and src/main/smokes finds nothing; homeux-smoke.ts:179 only queries a '.agent-setup-action .btn' selector. The 32-row static list adds CONPTYPIN, DEVICEFLOW, WEIGHT — no SETUP or TOOLCHAIN row.  
  Recommendation: Add a pure smoke driving SetupService over a fixture spawn seam (already-installed short circuit, runtime-missing remedy, the npm-prefix probe-failure skip at setup.ts:382-389, cancel mid-install) plus a unit test for toolchainStatus with an absent tool.  
  Why: Setup is the first-run path: 639 lines of process spawning behind 5 new IPC channels. The regressions its own comments record (probe '' read as unwritable, EINVAL on npm.cmd) shipped once already.

- **[MEDIUM · bug] Preflight classifies refusals by grepping English git stderr**  
  Surface: Worktree preflight + split git timeouts — `src/backend/features/worktrees/index.ts:72`  
  Evidence: `/not a git repos|does not appear to be a git repos/i.test(inside.error ?? '') ? refuse('not-a-repo') : refuse('unsupported', inside.error)` (index.ts:72-74). git() passes no env (index.ts:36-39) so git inherits the locale; the timeout message built at :46-47 falls in the same branch, and `timedOut` (:44,51) is read by no caller.  
  Recommendation: Stop parsing prose: spawn git with LC_ALL=C/LANG=C (via mergeEnv in platform/env-path) and classify from exit status — 128 from rev-parse --is-inside-work-tree means not-a-repo. Give timedOut its own WorktreePreflightReason.  
  Why: With NLS catalogs (Git for Windows ships them, Apple's git does not) a plain folder becomes 'unsupported' — the contract's dead-end reason — so the wizard shows 'Git refused: fatal: …' (:1740) not the git-init line (:1742). (confidence: medium)

- **[MEDIUM · bug] Remote target pins the isolation hint on 'Checking…' forever**  
  Surface: Worktree preflight + split git timeouts — `src/ui/features/wizard/index.ts:1701`  
  Evidence: `const target = s.remote ? '' : s.cwd.trim()` (1701) makes probeIsolation return at 1706 with isolatePreflight=null and no request sent. isolationHint(null) tests the outer `cwd` at 1725, which the subscriber assigns from s.cwd for remote too (:793), so it falls to `if (!pf) return { text: 'Checking…' }` (1726).  
  Recommendation: In isolationHint, branch on selection.state().remote first and return an explicit line ('Isolation runs on this machine only'), so the permanently disabled checkbox carries an honest reason instead of a check that never lands.  
  Why: Trigger: pick a host in 'Runs on', type a remote cwd. The Options row claims a probe is in flight that can never resolve — the same dishonesty the preflight was introduced to remove, on the one path where isolation cannot apply.

- **[MEDIUM · test-gap] Leak-zero gate cannot fail on the rollback side — no remove fault injection exists**  
  Surface: Worktree preflight + split git timeouts — `src/main/wizard-audit-faults.ts:7`  
  Evidence: WizardAuditFaultConfig exposes worktreeFailAt/worktreeDelayMs for creates (:7-9) but nothing for removes; the remove handler only bumps a counter (src/main/worktrees.ts:41). WIZARDFAIL asserts worktreeRemoveCalls===1 && liveIsolatedAfterPartial.length===0 (wizardfail-smoke.ts:214-220) on a one-README temp repo.  
  Recommendation: Add worktreeRemoveFailAt/worktreeRemoveDelayMs to WizardAuditFaultConfig; assert a refused rollback leaves the worktree LISTED and the wizard really says 'needs manual cleanup'. Add a unit test that removeWorktree uses a checkout-sized timeout.  
  Why: The gate guards 'partial failure leaks nothing' but only the create half can be made to break. The 15s remove timeout and a transient Windows lock during rollback both certify green today, so the assertion is vacuous.

- **[MEDIUM · gap] preflight IPC is an unvalidated arbitrary-directory-creation primitive from the renderer**  
  Surface: Worktree preflight + split git timeouts — `src/main/worktrees.ts:36`  
  Evidence: `ipcMain.handle(WorktreeChannels.preflight, (_e, repo: string) => typeof repo === 'string' && repo ? preflightWorktrees(repo) : …)` forwards any non-empty string, and preflightWorktrees mkdirs `<path>/.mogging/worktrees` (index.ts:87). The remove handler is containment-checked via isManaged (index.ts:212); this one is not.  
  Recommendation: Make preflight genuinely non-mutating (see the mkdir finding), and in the handler reject non-absolute paths and paths that do not already resolve to an existing directory before spawning git.  
  Why: The app renders agent output and hosts a browser dock, so renderer-reachable write primitives matter. A channel documented as 'can this folder be isolated' creates directories anywhere the user can write, with no validation. (confidence: medium)

- **[MEDIUM · bug] Install steps never re-repair PATH between them; Aider's second step is unfindable**  
  Surface: Install engine has zero executed coverage — `src/backend/features/agents/setup.ts:180`  
  Evidence: The install loop (:180-192) resolves each step via resolveStepFile (:265) against the current process PATH and never re-runs applyLivePathToProcess. Aider step 2 is `{file:'aider-install'}` (registry.ts:187); pip's script dir is in neither branch of wellKnownBinDirs (env-path.ts:168-197).  
  Recommendation: Await applyLivePathToProcess() at the top of each install-loop iteration, and add ~/Library/Python/*/bin and %APPDATA%\Python\Python*\Scripts to wellKnownBinDirs so a just-pip-installed console script resolves in the same run.  
  Why: Step 1 succeeds, step 2 resolves null and reports 'Could not find aider-install — close and reopen the app', but a restart cannot help: that directory is on no PATH source this module reads.

- **[MEDIUM · gap] PATH-persistence failures are swallowed; the remedy written never reaches the user**  
  Surface: Install engine has zero executed coverage — `src/backend/features/agents/setup.ts:458`  
  Evidence: repairPath reads only `persisted.ok && persisted.added.length` (:462), otherwise finishes 'done' with 'Visible to this app.' (:464). PersistPathResult.error (env-path.ts:341), carrying 'Add the folder by hand in System › Environment Variables' (:386), is read nowhere in the repo.  
  Recommendation: When persisted.ok is false, append persisted.error to the transcript and set it as the step's note plus remedy — the step may stay 'done' for this app, but must say the user's own terminals were not updated.  
  Why: The user is told setup is complete while their own shell still cannot run the CLI — the 'works inside this window and nowhere else' outcome repairPath's own comment (:441-444) calls worse than not installing.

- **[MEDIUM · test-gap] No gate exercises SetupService, and the class has no seam that would let one exist**  
  Surface: Install engine has zero executed coverage — `src/backend/features/agents/setup.ts:75`  
  Evidence: SetupService imports resolveOnPath/applyLivePathToProcess/persistUserPathEntries/spawnTool/isOnPath as module bindings (:12-16), no injection point. No tests/unit/setup.test.ts exists; env-path.test.ts covers only pure helpers (persistWindows/persistPosix untested). Smokes assert only `.agent-setup-action .btn` aria-labels.  
  Recommendation: Add a constructor deps object ({resolveOnPath, applyLivePath, persistPath, spawn}) defaulting to the real ones, then a pure gate (smoke:setup-pure) driving probe-hit, winget/brew missing, unreadable npm prefix, install non-zero, verify-not-on-PATH.  
  Why: This is the only engine mutating the machine (winget/brew, npm config set prefix, HKCU PATH, rc block) and the 207-gate sweep cannot fail when any of it breaks — gate honesty needs a fake seam here.

- **[MEDIUM · gap] setupCancel is a dead channel: no renderer invokes it, and panel dispose() does not cancel**  
  Surface: Install engine has zero executed coverage — `src/main/agents.ts:198`  
  Evidence: agents.ts:198 registers AgentChannels.setupCancel; the only other reference is contracts/ipc/channels.ts:73 — no invoke anywhere in src/ui. setup-panel.ts dispose() only sets `disposed = true` and unsubscribes (:293-296).  
  Recommendation: Either add a Cancel control to createAgentSetupPanel's running state that invokes AgentChannels.setupCancel, or delete the channel and correct cancel()'s doc comment (setup.ts:111) to say app-quit only.  
  Why: cancel()'s doc claims 'App quitting, or the user backing out'. A user who clicks Install then closes the wizard leaves a run with a 15-minute per-step budget (:51) still spawning winget/npm, with no UI and no way to stop it.

- **[MEDIUM · behavior-mismatch] persistPosix reports dirs as "added" even when it wrote nothing**  
  Surface: persistUserPathEntries can wipe HKCU Path — `src/backend/platform/env-path.ts:440`  
  Evidence: persistPosix guards the write with `if (next !== body)` (:439) but unconditionally returns `{ ok: true, added: [...wanted], target: file }` (:440), never checking whether the dir is already on the shell's PATH. persistWindows computes `covered` and returns `added: []` (:377-381). setup.ts:462 branches on `persisted.added.length`.  
  Recommendation: In persistPosix compute the same coverage check against the resolved login-shell PATH, return only genuinely new dirs in `added`, and return `added: []` when the rc body was already identical.  
  Why: For the identical state "already on your PATH", macOS says "Added to your PATH (~/.zshrc) — your own terminals will see it too" while Windows says "Visible to this app." One is a false claim about the user's environment.

- **[MEDIUM · bug] addToProcessPath clears `cached` but not `inFlight`, so a stale refresh strips the new dir**  
  Surface: persistUserPathEntries can wipe HKCU Path — `src/backend/platform/env-path.ts:268`  
  Evidence: addToProcessPath sets `cached = null` (:268) but leaves `inFlight`; refreshLivePath then returns that existing promise (:218), whose `current` snapshot (:219) predates the mutation, and it assigns `cached = resolved` (:234). applyLivePathToProcess does `process.env.PATH = live.entries.join(delimiter)` (:251), dropping the dir.  
  Recommendation: Have addToProcessPath invalidate `inFlight` too — bump a generation counter the in-flight IIFE checks before assigning `cached`, and re-read — so a refresh begun before the mutation cannot publish a pre-mutation PATH.  
  Why: SetupService.start only refuses a duplicate of the SAME agent (setup.ts:93), so two agents run repairPath (setup.ts:449-450) concurrently; the Settings repair handler (system.ts:79) is a second concurrent entry point. (confidence: medium)

- **[MEDIUM · test-gap] No gate covers the destructive half of env-path: persist* is untested and unseamed**  
  Surface: persistUserPathEntries can wipe HKCU Path — `tests/unit/env-path.test.ts:3`  
  Evidence: The only suite imports expandWindowsVars, loginRcFile, mergeEnv, parseRegPath, pathEntries, rcBlock (:3) — all pure. Nothing exercises persistUserPathEntries, persistWindows, persistPosix or refreshLivePath, and `run` (env-path.ts:80) is module-private with no injection point, so the reg-add branch cannot be driven from a test.  
  Recommendation: Extract the persistWindows decision as a pure exported fn (existingRaw, existingKind, machineRaw, wanted) -> {write|null, kind, added} and pin that a failed read yields write:null; add posix rc round-trip tests over a temp HOME.  
  Why: The branch that can erase a user's persisted PATH has zero coverage and is structurally untestable, so a regression ships green — the gate-honesty law requires a gate that can fail when the thing it guards breaks.

- **[MEDIUM · gap] Profile removal never triggers fan-out; a deleted account's pin stays enforced**  
  Surface: Two ADRs both numbered 0022 — `src/main/profiles.ts:219`  
  Evidence: main/agent-settings.ts:293-296 documents the trigger as 'a profile saved, removed, or discovered'. ProfileChannels.remove (profiles.ts:207-221) calls removeAgentConfigTarget but never scheduleAccountDefaultsApply; the only callers are profiles.ts:167, :204 and startup (agent-settings.ts:442).  
  Recommendation: Call scheduleAccountDefaultsApply(profile.provider) in ProfileChannels.remove right after store.removeAgentConfigTarget('profile', id), and add a profiledefaults-smoke.ts bite that deletes a pinned profile and asserts the home re-inherits.  
  Why: Pin the primary, then delete that pointer-less profile: settings-store.ts:447-451 reaps the pin, but the user-scope compiled row keeps the ex-pin value under enforce, so reconcileAll restores it while the badge reads 'Account default'.

- **[MEDIUM · improvement] Promote scan re-parses every account's config file once per catalog setting**  
  Surface: Two ADRs both numbered 0022 — `src/backend/features/agent-settings/service.ts:700`  
  Evidence: promotableDefaults (:661-716) calls codecFor(...).read(loaded.text, setting.path) per setting per home (:700); jsonc.ts:28-44 does a full parseTree + parse of the whole document each call. 422 claude settings survive the pre-filters, so 3 homes cost ~1266 full parses, synchronous on main, per invocation.  
  Recommendation: Parse each home's document once per surface and read every path off the parsed value (a codec readMany or a parse cache keyed by file text), and limit the scan to the settings currently rendered rather than the whole catalog.  
  Why: load() invokes it (agent-config.ts:296-300) and re-runs on every AgentConfigChannels.changed push (:731-734), which every default save, fan-out and hourly refresh emits, each blanking the panel to a spinner (defaultsux-smoke.ts:100-104).

- **[MEDIUM · test-gap] No DEFAULTS gate drives the production resolveContext or the env-pointer primary home**  
  Surface: Two ADRs both numbered 0022 — `src/main/smokes/profiledefaults-smoke.ts:59`  
  Evidence: PROFILEDEFAULTS (:59-77) and DEFAULTSMILESTONE (defaultsmilestone-smoke.ts:52-68) build AgentSettingsService with a hand-written resolveContext passing `env: {}`. Production passes `process.env` (main/agent-settings.ts:186) and sources.ts:57 resolves the user home as `ctx.profileEnv?.[name] ?? ctx.env?.[name]`.  
  Recommendation: Add a bite that runs fan-out through main's real resolveContext with CLAUDE_CONFIG_DIR poisoned to a profile's home, asserting providerHomes dedupes by resolved file so exactly one compiled row lands per settings.json.  
  Why: The 2026-07-15 lesson (isolatedEnv, agent-settings.ts:137-151) is that an inherited pointer steers writes into a real CLI home. The tier now writes N homes off that same resolution and all four DEFAULTS gates are blind to it.

- **[LOW · bug] verify() certifies 'ready' after a --version that timed out**  
  Surface: agent-setup-onboarding — `src/backend/features/agents/setup.ts:229`  
  Evidence: verify fails only when `!ran.ok && ran.missing` (setup.ts:229); a timedOut result has missing:false, so it falls through to finishStep('verify','done', `${name} is ready…`) at :235 while the transcript says '[gave up after 1 minutes — the command looked stuck]' (:493).  
  Recommendation: Treat ran.timedOut as a verify failure with its own remedy ('the CLI started but never answered --version'), so the step verdict and the transcript cannot contradict each other.  
  Why: A CLI that hangs on first run gives the user a 60-second silence followed by a green 'ready' verdict over a command that was killed — the transcript already says the opposite.

- **[LOW · behavior-mismatch] Promote chip says "All N accounts" using the vote count, not the account count**  
  Surface: defaults-tier — `src/ui/features/settings/agent-config.ts:604`  
  Evidence: Chip label: `All ${suggestion.homes} accounts use ...` (agent-config.ts:604), where homes = `values.length` — only homes where `read.present` was true (service.ts:701,706,714). A home lacking the key never votes, yet the click writes the value into EVERY home via applyAccountDefaults.  
  Recommendation: Render the chip as `${suggestion.homes} of ${accountCount} accounts already use X — make this the default everywhere?`, or drop suggestions whose vote count is below the account count so 'All' is literally true.  
  Why: With 3 accounts where one home never set `model`, the chip claims 'All 2 accounts use claude-fixture-1' and the next dialog says 'all 3 of your accounts' — two counts for one action on the honest-labels surface.

- **[LOW · docs-drift] The device card never renders the expiry countdown its contract promises**  
  Surface: oauth-device-flow — `src/contracts/integrations/connections.ts:168`  
  Evidence: DeviceSignIn.expiresAt is documented '/** Absolute ms — the card counts down, and says so when it lapses. */' (:167-168). devicePanel (src/ui/features/settings/connections.ts:442-470) builds the lede, code, Copy/Open buttons and the URI text and never reads `d.expiresAt`; the 'connecting' case (:943-951) does not either.  
  Recommendation: Either render the remaining minutes (and a 'this code has lapsed' line past expiresAt) in devicePanel, or delete the countdown promise from the DeviceSignIn doc comment so the contract matches the card.  
  Why: The field is carried over IPC and persisted to the KV purely for a UI behaviour that does not exist; a user staring at the code has no way to know how long it stays good.

- **[LOW · docs-drift] docs/14 states a DEVICEFLOW assertion count that does not match the suite**  
  Surface: oauth-device-flow — `docs/14-integrations.md:304`  
  Evidence: docs/14-integrations.md:304 reads '> **Status:** the machinery is in and gated (DEVICEFLOW, 41 assertions).' The b810035 commit message says 44, and `grep -c 'check('` over scripts/device-flow-pure-smoke.ts returns 45 — 44 assertion calls plus the `function check(` definition.  
  Recommendation: Correct docs/14-integrations.md:304 to 44, and prefer deriving the number the way check-gate-count.mjs already derives the sweep size rather than restating it in prose.  
  Why: Finding 40's own lesson in qa-smokes.sh is that every doc restating a gate's size states a different one; this shipped with the drift already present between commit message and doc.

- **[LOW · improvement] Stale listings are marked but never evicted — collapsed dirs pin their children**  
  Surface: explorer-sync-laws — `src/ui/components/file-tree.ts:446`  
  Evidence: markUnwatched only sets `st.stale = true` (:446-450); DirState keeps `children` (:123). The sole eviction is prune(), which drops a dir only when its parent stops listing it (:612-636). A stale dir must re-list on expand anyway (:174), so the kept array serves one repaint.  
  Recommendation: Bound it: keep children for the N most recently collapsed dirs (LRU by collapse order) and null the rest out in markUnwatched, or drop children once nodes.size passes a cap. Add a heap assertion over an expand/collapse loop to FILESMILESTONE.  
  Why: EXPLORER_LIST_CAP is 1000 entries/dir; expanding and collapsing many large dirs pins thousands of entry objects against the 300MB renderer heap cap (docs/05-perf-budget.md:17), unbounded and useless after the next expand.

- **[LOW · docs-drift] docs/16 still specifies the pre-recut drag contract and omits the new sync laws**  
  Surface: explorer-sync-laws — `docs/16-files.md:237`  
  Evidence: docs/16-files.md:237-240: '**Drag** a row: `text/plain` carries the quoted insert ... and a private `application/x-mogging-path` marker gates the pane's drop handler'. Code puts the RAW absolute path in the marker, the quoted ABSOLUTE in text/plain (index.ts:552-554), insert computed at the drop (pane-drop.ts:161-181).  
  Recommendation: Rewrite the Drag paragraph: marker = raw absolute path, text/plain = quoted absolute for outside targets, insert computed by the RECEIVING pane. Add the cache-follows-watcher and reopen-re-arms laws to §3 with their TREELIVE (g)/(h) gate names.  
  Why: §5 reads as this surface's spec, so a reader checking the marker's value against it concludes the code is wrong. §3 likewise never states 'cache lifetime = watch lifetime' or the reopen re-arm the commit landed.

- **[LOW · docs-drift] customCheckAppRunning also expands in the uninstaller, contradicting its safety note**  
  Surface: installer-freeze-fixes — `build/installer.nsh:100`  
  Evidence: installer.nsh:100-101 says "NO `Return` ANYWHERE IN THIS MACRO. It expands inside `Section \"install\"`, not inside a Function". uninstaller.nsh:1-3 is `Function un.checkAppRunning / !insertmacro CHECK_APP_RUNNING / FunctionEnd`, and allowOnlyOneInstallerInstance.nsh:36-38 routes that to customCheckAppRunning.  
  Recommendation: Correct the comment to say the macro expands in BOTH Section "install" and un.checkAppRunning, and note that SetDetailsPrint both (installer.nsh:104) therefore also runs from un.onInit on the uninstall path.  
  Why: The note is load-bearing safety guidance and its justification is false; anyone reasoning from it about where the macro's side effects land (SetDetailsPrint, the $INSTDIR-scoped kill) will see only half the call sites.

- **[LOW · bug] 'Reset grid' leaves the palette chips' counts stale after the pane count changes**  
  Surface: wizard-redesign — `src/ui/features/wizard/index.ts:1018`  
  Evidence: resetBtn: `setGridSpec(uniformSpec(...)); painter.set(gridSpec); refreshAgents()` (index.ts:1015-1019). refreshAgents (index.ts:1778-1801) updates the meter/readout but never renderPalette(); the Shell chip's `n = paneCount - assignedTotal()` and the ▾ menu's `const empty` are computed only inside paletteChip (index.ts:1275, 1295).  
  Recommendation: Call renderAgentControls() instead of refreshAgents() in the Reset-grid handler, matching the painter's own onChange (index.ts:984-989), so the chips' ×N and the 'Fill N empty' label/disabled state follow the new pane count.  
  Why: Merge the top row of a 2×2 (3 terminals), fill them, click Reset grid → the meter says '3 / 4 · 1 empty' while the Shell chip shows no count and every ▾ still offers a disabled 'Fill 0 empty terminals'.

- **[LOW · improvement] Preflight verdict is cached per path with no way to re-ask after the user fixes it**  
  Surface: Worktree preflight + split git timeouts — `src/ui/features/wizard/index.ts:1702`  
  Evidence: `if (target && target === preflightCwd) return syncIsolate() // already asked about this one` (1702). preflightCwd is cleared only by a folder change or by repairToolPath (:1772), which is reachable solely from the 'Find Git' button shown for reason 'no-git' (:1734,1756).  
  Recommendation: Expire the cache on a cheap signal (re-ask when the wizard view regains focus/visibility), or give every refusal a 'Check again' action that clears preflightCwd and re-runs probeIsolation, not only the no-git one.  
  Why: 'no-commits' tells the user to commit first (:1736) and 'not-writable' implies fixing permissions, but doing either in another terminal never re-enables the box — the 'the box lied to me' shape the preflight was added to end.

- **[LOW · docs-drift] Proposed ADR 0022 (connections) shipped as a code map already stale at merge**  
  Surface: Two ADRs both numbered 0022 — `docs/adr/0022-connections-reach-the-terminal.md:1`  
  Evidence: At HEAD its citations miss: connections.ts:417 is a comment, connections.ts:1064 is release prose, wizard/index.ts:1166 is a slot-count helper, daemon-relay.ts:395 is `port: row.port`, oauth.ts:330 is a bare `try {`. Its premise, a 'user-pasted client secret' exchange, was superseded by the device flow in the same commit (b810035).  
  Recommendation: Renumber the file to 0023 (it is still Proposed), replace line-anchored citations with symbol names, and rewrite 'What the user's token actually is' against the RFC 8628 device-flow grant in first-party-clients.ts.  
  Why: The ADR reads as verified forensics and is the design brief for a credential seam; a reader following its anchors lands on unrelated code, and its custody premise no longer matches the shipped connect path.

## Re-validated findings, by area

### terminal-rendering

- **[still-open · high] F1 — Bare Shift keydown yanks a scrolled-up pane to the bottom via anchor.stick()**  
  Now at: `src/ui/features/terminal/pane-anchor.ts:227`  
  Evidence: onKey (225-228) unchanged: `else if (!e.ctrlKey && !e.metaKey && !e.altKey) stick()`. Bare 'Shift' fails the SCROLL_KEYS branch, passes this one, and stick() scrolls to bottom (line 188). The file's only delta change is a DEC-2026 guard inside stick() that defers via pin() — which still lands at the bottom.  
  Recommendation: As originally recommended: early-return in onKey on pure-modifier keys ('Shift','Control','Alt','Meta','CapsLock','NumLock','ScrollLock'); add a bare-Shift keydown dispatch to the smoke's K section.  
  Note: The delta's mid-frame defer makes the yank land one frame later during TUI repaints but does not prevent it. Keyboard scrollback paging and shift-click history selection remain broken.

- **[still-open · medium] F2 — Terminal search promised in docs and shipped as a dependency but never wired**  
  Now at: `docs/01-architecture.md:13`  
  Evidence: docs/01-architecture.md:13 still lists `addon-search` in the current tier; package.json:43 still ships @xterm/addon-search ^0.16.0; repo-wide grep for SearchAddon finds zero imports in src/. No find-in-scrollback UI landed in the delta.  
  Recommendation: As originally recommended: load SearchAddon per pane with a find bar in TerminalPane.handleKey, or drop the dependency and move addon-search to docs/01's 'later' list.  

- **[still-open · medium] F3 — Multi-line paste executes immediately in non-bracketed shells (Windows default shells)**  
  Now at: `src/ui/core/clipboard/clipboard-port.ts:227`  
  Evidence: sanitizePaste (226-229) still converts every \r?\n to CR and wraps only when bracketed. handleNativePaste (terminal-pane.ts:904) and pasteFromClipboard (:920) write straight to the PTY with no newline confirm when bracketedPasteMode is false. The delta's clipboard changes only moved quoting helpers.  
  Recommendation: As originally recommended: when bracketedPasteMode is false and the payload has a newline, one-shot confirm (Windows Terminal model) or at minimum strip the trailing newline.  
  Note: Win/mac divergence stands: cmd/PS5.1 panes run each pasted line instantly while zsh/agent-CLI panes hold it inert — against the parity promise.

- **[still-open · medium] F6 — Scroll-anchor logic has no unit tests; smoke only fires composed synthetic chords**  
  Now at: `src/main/smokes/panescroll-smoke.ts:373`  
  Evidence: The K-section key() helper (372-378) still dispatches single KeyboardEvents with `shiftKey: !!shift` pre-set and never a bare 'Shift' keydown. tests/unit gained 10 new files in the delta but none for pane-anchor (glob *anchor* finds nothing); panescroll-smoke.ts is unchanged since baseline.  
  Recommendation: As originally recommended: extract decide/onKey behind a unit-testable seam; add a smoke step dispatching keydown 'Shift' then 'PageUp' from a scrolled-up viewport, asserting no jump.  
  Note: This gap is why F1 still passes the PANESCROLL gate; under the gate-honesty law the smoke certifies an invariant it never exercises with real key sequences.

- **[still-open · low] F4 — SerializeAddon loaded in every pane but TerminalPane.serialize() has no caller**  
  Now at: `src/ui/features/terminal/terminal-pane.ts:2266`  
  Evidence: serializer constructed at line 99, loaded at 194, serialize() at 2266-2268 (line drifted from 2222 as the file grew). Repo-wide grep for `.serialize()` finds only grid-layout's unrelated layout.serialize() (controller.ts:348); still zero callers.  
  Recommendation: As originally recommended: surface a 'Save transcript…' menu entry, or drop the addon load and method until the snapshot feature lands.  

- **[still-open · low] F5 — docs/05 points at src/main/milestone-smoke.ts; the budget lives in src/main/smokes/**  
  Now at: `docs/05-perf-budget.md:10`  
  Evidence: Line 10 still reads 'Source of truth: `BUDGET` in `src/main/milestone-smoke.ts`'; ls confirms that path does not exist and the BUDGET constant lives at src/main/smokes/milestone-smoke.ts.  
  Recommendation: One-line fix: point docs/05-perf-budget.md:10 at src/main/smokes/milestone-smoke.ts.  

- **[still-open · low] F7 — WebGL retry budget never re-arms while a pane stays visible**  
  Now at: `src/ui/features/terminal/pane-webgl.ts:164`  
  Evidence: Still `const retrying = this.host.isVisible() && this.glLosses <= 3` (line 164); glLosses resets only in onShow (line 87). The delta's change to onContextLoss (transient-loss refit suppression, release(!retrying)) cut the cost per loss but added no decay or focus re-arm.  
  Recommendation: As originally recommended: decay glLosses on a timer (e.g. reset after 60s without a loss) or re-arm one retry on window focus, keeping gl.context_lost telemetry as is.  

### pty-daemon

- **[moved-still-open · high] F1 — Daemon pane close does a bare pty kill, not a process-tree kill**  
  Now at: `src/pty-daemon/session.ts:1026`  
  Evidence: PaneSession.kill() still runs `this.proc.kill()` bare (session.ts:1026); killAll iterates the same path (session.ts:1329-1330). No killPtyTree import anywhere in src/pty-daemon; the in-proc backend still uses killPtyTree (pty.service.ts:353, :368). The delta only added launch-grace-timer cleanup around the kill, never the tree kill.  
  Recommendation: As originally recommended: call killPtyTree from @backend/platform/process-tree in kill() (session.ts:1026), let killAll inherit it; gate asserting a grandchild is dead after daemon-path close.  
  Note: Line drifted 923->1026 (deferred-launch code landed above). Vendored node-pty under useConptyDll (now default) still skips console-list kill, so headless orphaned agents on Windows remain the concrete failure; high stands.

- **[still-open · high] F4 — notify/kill/shutdown accept any pane id from any authed client, unbound**  
  Now at: `src/pty-daemon/transport.ts:227`  
  Evidence: `case 'kill': sessions.remove(m.id)` (transport.ts:224-226); `case 'notify'` calls target?.applyNotify(m.event) with no credential (transport.ts:227-231); `case 'shutdown'` needs only auth (transport.ts:420-423). boundToPane (transport.ts:143) still guards only mail-send/claim/release (:303, :333, :348). bin/mogging.mjs still parses `--pane` for notify (:1192).  
  Recommendation: As originally recommended: route notify/kill through boundToPane with the target's MOGGING_PANE_TOKEN, drop --pane from bin/mogging.mjs notify, app-only secret for house-notify and shutdown.  
  Note: Lines drifted (222->224/227) from the v11 gen-gate blocks. The v11 optional gen field gates staleness, not identity — it does not close forged sibling notify or cross-pane kill.

- **[still-open · medium] F2 — No backpressure: a stalled client grows the daemon heap without bound**  
  Now at: `src/pty-daemon/transport.ts:85`  
  Evidence: `sock.write(encodeMessage(m))` return value still ignored (transport.ts:85); pty chunks still fan out synchronously `for (const s of this.subs) s.send(d)` (session.ts:709). Grep for pause/drain/writableLength/highWaterMark in src/pty-daemon finds only gitContext.drain() (unrelated). The v11 delta touched input/resize gen-gating only.  
  Recommendation: As originally recommended: honor sock.write()'s return, pause pty on false / resume on drain (ref-counted across subscribers), destroy a socket past ~8 MB queued.  
  Note: Fan-out anchor drifted 682->709. Prior verifier's medium stands: client heartbeat (daemon-client.ts:471-490) and close-handler cleanup (transport.ts:462-469) bound the wedged-pipe window to ~25s.

- **[still-open · medium] F3 — Pid-recycling defenses are Windows-only; macOS can wedge the daemon**  
  Now at: `src/pty-daemon/lifecycle.ts:40`  
  Evidence: ownerHoldsLock still reads `if (process.platform !== 'win32') return true` after a bare isAlive check (lifecycle.ts:39-40); pipeAlive remains Windows-only and endpointLive still trusts `isAlive(ep.pid) && pipeAlive(ep.address)` (daemon-client.ts:65). git diff c026463..HEAD shows zero changes to lifecycle.ts, pid.ts, or these daemon-client lines.  
  Recommendation: As originally recommended: add socketAlive(address) net.connect probe treating ENOENT/ECONNREFUSED as dead; use in ownerHoldsLock (same 30s grace) and endpointLive.  
  Note: Prior verifier's downgrade stands (needs SIGKILL plus pid reuse; in-proc fallback self-heals). Still a Win/macOS parity violation under the product laws.

- **[moved-still-open · medium] F5 — createLineFramer has no max frame length and runs pre-authentication**  
  Now at: `src/contracts/daemon/protocol.ts:505`  
  Evidence: createLineFramer still appends every chunk to an unbounded string: `buf += chunk` split only on '\n' (protocol.ts:505-512). The daemon still feeds raw socket data into it pre-auth (transport.ts:458 -> framer at :427); the only bound is the 3s authTimer (transport.ts:90-92); no cap on concurrent unauthenticated connections.  
  Recommendation: As originally recommended: ~1 MB max-frame guard inside createLineFramer signaling the caller; transport destroys the connection when it trips; cap unauthenticated connections.  
  Note: Line drifted 493->505 (v11 comment block above it). Behavior unchanged.

- **[moved-still-open · medium] F6 — connect()'s welcome timeout leaks an authenticated socket into the daemon**  
  Now at: `src/main/daemon-client.ts:445`  
  Evidence: The 8s timer still rejects via settle() without sock.destroy() (daemon-client.ts:445; settle :438-443 only clears the timer); `hello` already sent on 'connect' (:457-465), so the daemon counted the client (transport.ts:437-439). The relay builds a fresh DaemonClient per reconnect attempt (daemon-relay.ts:270, catch :307): each timeout leaks one authed socket.  
  Recommendation: As originally recommended: destroy the socket (and clear this.sock) in the timeout branch and the 'error' arm, or route every non-resolve settle through a dispose path.  
  Note: Line drifted 429->445 (SpawnReplayMode additions). Impact intact: index.ts:111 idle-reaps only at zero clients AND zero panes; inflated otherClients still disarms the stamp-war retire (daemon-client.ts:272-284).

- **[still-open · medium] F7 — Run-root sweep can delete a still-starting older daemon's runtime dir**  
  Now at: `src/main/daemon-sweep.ts:64`  
  Evidence: sweepRunRoot still judges liveness solely by endpoint.json's pid (daemon-sweep.ts:62-68) and rmSync's the dir otherwise (:73-76); daemon.lock is never consulted. The daemon still takes the lock (index.ts:59), restores (:79), and writes endpoint.json only inside listen (:147-153). git diff c026463..HEAD shows no changes to daemon-sweep.ts or index.ts.  
  Recommendation: As originally recommended: also read daemon.lock; keep the dir when that pid is alive or lock mtime is within the 30s startup grace; only 'no endpoint AND no live lock' counts as dead.  

- **[still-open · low] F8 — POSIX socket files are never unlinked (stale-socket cleanup missing)**  
  Now at: `src/pty-daemon/index.ts:101`  
  Evidence: shutdown() still only calls `server.close()` (index.ts:101) immediately before process.exit (:105), after clearEndpoint()/releaseLock() (:93-94) — libuv's close-time unlink never runs; nothing removes the daemon-<pid>.sock path from lifecycle.ts:30. No startup sweep of stale .sock files; daemon-sweep only removes older-version dirs.  
  Recommendation: As originally recommended: unlink the socket path beside clearEndpoint() when platform !== 'win32', plus a startup pass in lifecycle.ts removing daemon-*.sock files whose pid is dead.  

### panes-layout

- **[still-open · medium] F1 — Template apply seeds cwds for dense slots 1..N; real slots can be sparse after a pane move**  
  Now at: `src/ui/features/workspace/controller.ts:1161`  
  Evidence: Line 1161 still reads `this.publishPaneCwds(a.meta)` with no slots arg, so it seeds dense 1..paneCount (481-488) while apply()/applyRegions land on the sparse templateLocals set (grid-layout.ts:359-367, unchanged). Line moved 1156->1161 only due to a 5-line comment added in publishRemotes.  
  Recommendation: As originally recommended: pass the sparse set, e.g. publishPaneCwds(a.meta, a.layout.peekTemplate(count).map(s => s.local)); the peekTemplate result is already computed in the same function.  
  Note: The scrub loop at 1152-1159 already iterates peekTemplate(count) — the correct sparse slot set is computed two lines above the dense call and simply not passed.

- **[still-open · medium] F2 — Entitlement maxPanes cap not enforced on template applies (palette, control API)**  
  Now at: `src/ui/features/workspace/controller.ts:1176`  
  Evidence: requestApplyTemplate (1176-1192) still routes to applyTemplate(n) -> a.layout.apply(n) with no effectiveMaxPanes/refusePaneCap check; apply clamps only to limit() (grid-layout.ts:360). Callers at index.ts:749/753/852/932 (control API + palette) bypass the plan cap, contradicting the 'ONE cap refusal' contract at controller.ts:1203.  
  Recommendation: As originally recommended: clamp n to effectiveMaxPanes(view) in requestApplyTemplate (and requestReorganize's count) and call refusePaneCap when exceeded, before peekTemplate/confirm.  

- **[still-open · medium] F3 — Failed applyRegions leaves meta.paneCount inflated, poisoning the persisted layout**  
  Now at: `src/ui/features/workspace/controller.ts:1160`  
  Evidence: applyResolvedLayout still sets `a.meta.paneCount = count` (1160) before apply() and unconditionally calls onChange() (1164); requestReorganize discards the result via `void view.layout.applyRegions(spec)` (1270), and applyRegions still returns false without touching the tree when templateLocals is short (grid-layout.ts:397).  
  Recommendation: As originally recommended: have the apply callback report success and only set meta.paneCount/seed cwds on success (or re-sync meta.paneCount = a.layout.paneCount after apply()); toast when applyRegions refuses.  

- **[still-open · medium] F4 — Structural tree mutators have zero test coverage (gate and unit tests cover geometry only)**  
  Now at: `src/ui/features/layout/layout-tree.ts:228`  
  Evidence: splitLine (228), removeLeaf (263), swapLeaves (273), moveLeaf (284), moveLeafToRootEdge (294), normalize (148), treeForGrid (207) have no callers in scripts/check-layout-invariants.mjs, tests/unit, or smokes. Existing tests import only geometry (grid-regions: computeLayout/leafIds; pane-capacity: constants).  
  Recommendation: As originally recommended: add tests/unit/layout-tree.test.ts covering splitLine re-equalize, removeLeaf absorb + last-leaf null, moveLeaf/moveLeafToRootEdge shapes, swapLeaves, and normalize's merge/collapse invariants.  
  Note: The delta added ~700 lines of new unit tests (pane-insert, pane-shared, etc.) but none touch layout-tree mutators; gap unchanged.

- **[still-open · low] F5 — Layout README still claims a 16-pane MAX_PANES enforcement that no longer exists**  
  Now at: `src/ui/features/layout/README.md:61`  
  Evidence: README.md:61 still reads 'so 16 panes is the budget edge; `MAX_PANES` enforces it', and layout-tree.ts:541 still says 'ids stay within 1..MAX_PANES forever'. No MAX_PANES constant exists — only ABS_MAX_PANES=32 (src/contracts/domain/pane.ts:30) and MAX_LEAVES=32. Neither file changed since c026463.  
  Recommendation: As originally recommended: update the README perf section and the layout-tree.ts:541 comment to name ABS_MAX_PANES/MAX_LEAVES (32) as the cap, with ~16 as the WebGL-context fallback edge.  

### persistence-restore

- **[still-open · high] F1 — Corrupt app-settings.db permanently bricks workspace persistence (no set-aside recovery)**  
  Now at: `src/main/app-settings.ts:32-36`  
  Evidence: catch block still reads `store = null; storeOpenReason = ...` with no rename-aside/retry; every load throws `storeOpenReason || 'The workspace store is unavailable.'` (line 44). File unchanged since c026463 (git diff --stat shows no delta). Daemon's openSessionStore (pty-daemon/index.ts:37-51) still demonstrates the intended pattern.  
  Recommendation: As originally recommended: on SettingsStore constructor throw, rename app-settings.db (+ -wal/-shm, see F3) to .corrupt-<ts>, retry a fresh open, surface a one-time 'settings were reset' notice.  
  Note: The delta added board/shared-defaults/agent-config state into this same db (settings-store.ts), so one corruption event now bricks even more surface — severity comfortably stays high.

- **[moved-still-open · medium] F2 — Pane row skipped during restore is permanently deleted by the first full persist**  
  Now at: `src/pty-daemon/session.ts:1285-1288`  
  Evidence: catch still only logs: comment reads 'a skipped one is dropped on the next persist — its scrollback was unreachable either way'. persist() (session.ts:1104-1106) still runs storeSynced=false -> savePanes(snapshotAll()) full rewrite, deleting the skipped row within the 2s schedulePersist window.  
  Recommendation: As originally recommended: seed skipped rows into the first full savePanes (inert, like requestedCwd keeps a missing cwd) or drop only after a second failed restore; add a smoke that a spawn-throwing row survives one restart.  
  Note: Code shifted from :1170 to :1285 (dims/restore work above it). The comment now rationalizes the drop, but the trigger is a transient spawn failure, so the loss remains real.

- **[still-open · medium] F3 — Corrupt-store set-aside leaves sessions.db-wal/-shm behind for fresh db to adopt**  
  Now at: `src/pty-daemon/index.ts:42-49`  
  Evidence: Still only `fs.renameSync(dbPath, aside)` (line 44) before `return new SessionStore(dbPath)` (line 49); no handling of dbPath+'-wal' / '-shm'. File unchanged since baseline per git diff --stat.  
  Recommendation: As originally recommended: rename or delete dbPath+'-wal' and dbPath+'-shm' alongside the main file before the fresh open.  

- **[still-open · medium] F6 — No unit test bites on the SQL layer: column lists and migrations are smoke-only**  
  Now at: `src/backend/features/workspace/session-store.ts:21-35`  
  Evidence: grep for SessionStore/SettingsStore/better-sqlite3 under tests/ returns zero matches; tests/unit has only the pure mapping suites. Meanwhile the delta hand-added grid_cols/grid_rows to PANE_COLUMNS (:22), PANE_UPSERT (:24-35), the schema (:59-60) and addColumnIfMissing migrations (:90-97) — exactly the drift class predicted, landed untested.  
  Recommendation: As originally recommended: a vitest suite opening SessionStore on a temp file — pre-migration schema reopen, full PersistedPane (now including cols/rows) round-trip, and savePanes vs applyPaneChanges row-for-row parity.  
  Note: The grid-dims columns added since baseline went through every hand-written list with no unit coverage; the predicted failure mode is now demonstrated live risk, not hypothetical.

- **[moved-still-open · low] F5 — Cold-start restore hard-codes platform:'posix' onto the restored remote spec**  
  Now at: `src/pty-daemon/session.ts:1257`  
  Evidence: Still `remote: p.remote ? { ...p.remote, platform: 'posix', cwd: ... } : undefined`. Still harmless-latent: normalizeRemoteConnection (contracts/domain/remote.ts:72) refuses non-posix, while RemotePaneTarget already types platform as 'posix' | 'windows' (remote.ts:27).  
  Recommendation: As originally recommended: delete the override and let the persisted p.remote.platform ride the spread; the normalizers enforce what is spawnable.  
  Note: Moved from :1143 to :1257 by the dims-restore additions. The remote-insert-honesty delta did not touch this line; the windows dialect is one seam-change away from making this a real cross-dialect bug.

- **[still-open · low] F7 — Docs promise persisted command-block history; no store implements it**  
  Now at: `docs/01-architecture.md:43`  
  Evidence: Lines 42-43 still list 'command-block history' in the Phase-1 SQLite persistence set. sessions.db still has only panes+workspaces tables (session-store.ts:43-68); settings-store.ts gained board-card tables (ADR 0022) but nothing for command blocks.  
  Recommendation: As originally recommended: scope the doc line to 'planned' / drop 'command-block history', or persist block boundaries alongside the pane row if still intended.  

- **[fixed · none] F4 — Persisted scrollback tail cut without trimTornStart — torn escape/surrogate on repaint**  
  Now at: `src/pty-daemon/session.ts:480`  
  Evidence: Fixed by the replay-integrity delta: restore now seeds `this.buffer = trimTornStart(restore.scrollback) + RESTORE_MODE_RESET` (session.ts:480, added since c026463 per git diff). The persist-side slice stays blind (session-rows.ts:64) but restore() is the persisted string's only consumer (in-proc pty.service never restores persisted scrollback), so no torn tail reaches a repaint.  
  Recommendation: Nothing required; optionally also trim at paneToRow (session-rows.ts:64) so the stored row itself is clean for any future consumer.  
  Note: Fix landed at the restore-seed instead of the persist-cut as recommended — strictly better: it also cleans pre-fix rows, and RESTORE_MODE_RESET additionally clears stale terminal modes.
  Challenger: agrees — session.ts:480 trims; only other this.buffer write is the trimmed cap at 706. Sole restore ctor (1264) feeds 480. loadPanes callers: daemon restore, daemon-migrate.ts:116 which re-saves rows (452), re-entering 480. pty.service.ts:118-124 replays only its own trimmed ring; SpawnSpec has no scrollback field; no ui/bin/mcp consumer.

### agent-launcher

- **[still-open · medium] F2 — Setup cancel only observed between steps; killed cmd wrapper orphans npm on Windows**  
  Now at: `src/backend/features/agents/setup.ts:112`  
  Evidence: cancel() (setup.ts:112-118) still only sets the flag and calls `this.children.get(id)?.kill()`. Sole cancelled check in run() is :193; verify() (:214) and exec() (:471) never check it; capture() children (:524) are never registered; kill() hits spawnTool's cmd.exe wrapper (spawn-tool.ts:56), not npm — no killPtyTree/taskkill /T for these children.  
  Note: New tests/unit/spawn-tool.test.ts covers quoting only, not kill semantics. killPtyTree exists (install.ts:87) but SetupService never uses it — the tree-kill pattern is one import away.

- **[still-open · medium] F3 — Session pooling runs synchronous recursive copies on the main process during launch**  
  Now at: `src/main/agents.ts:135`  
  Evidence: The agents:command IPC handler still calls `poolProviderSessions(...)` synchronously before returning the command. src/backend/features/agents/session-pool.ts is unchanged: statSync/copyFileSync/utimesSync per transcript (:76-95), recursive fs.cpSync for claude sidecars (:100-106), 30-day window (:37).  
  Recommendation: As originally recommended: fs.promises with bounded concurrency (or a worker thread) and/or a per-pool byte cap; it is documented best-effort, so completing it off-thread before returning the command keeps semantics.  
  Note: Same code, same call-site line. Main now also relays gen-gated daemon v11 pty traffic, so a long block at failover launch still violates the docs/05 frame-gap budget.

- **[still-open · medium] F4 — Launcher's cmd quoting bypasses the hardened in-repo cmd codec (%VAR% expands)**  
  Now at: `src/backend/features/agents/launch.ts:49`  
  Evidence: cdPrefix still emits `return `cd /d "${cwd}" && ` // cmd.exe` raw, and envPrefix (:68) still emits `set "${k}=${v}" && ` — the 'accepted residual' comment (:6-12) is intact, while quotePathForShell's proven %-splice codec still sits at src/contracts/domain/shell-quote.ts:44. git diff c026463..HEAD shows launch.ts untouched.  
  Note: Windows/macOS parity divergence persists; the measured fix remains one import away as originally stated.

- **[still-open · medium] F5 — buildLaunchCommand's three-dialect quoting has zero unit tests**  
  Now at: `src/backend/features/agents/launch.ts:102`  
  Evidence: grep for buildLaunchCommand/envPrefix/cdPrefix/shellArg across tests/ matches nothing; only non-source references are cwd-smoke.ts and notifyhook-smoke.ts. The delta's new tests (agent-install-spec, spawn-tool, env-path) cover install argv and PATH, not launch quoting.  
  Note: The untested surface grew: buildLaunchCommand now takes LaunchTargetSpec for saved remote hosts (launch.ts:108) and remote-insert honesty routes remote launches through it (agents.ts:71), so the dialect matrix is bigger than at audit time.

- **[still-open · medium] F6 — Claude probe's signed-in marker (.credentials.json) never exists on macOS**  
  Now at: `src/backend/features/agents/logins.ts:54`  
  Evidence: Line 54 still reads `const signedIn = existsSync(join(home, '.credentials.json')) || email !== undefined` with no darwin branch or Keychain check; logins.ts is unchanged since baseline. agents.ts:189 still turns a CHECKED signedIn:false into needsSignIn.  
  Note: Platform-parity violation unchanged: a signed-in macOS user whose .claude.json lacks oauthAccount is offered sign-in; Windows/Linux read the same state correctly.

- **[still-open · low] F1 — InstallService verdict re-detects on a stale process PATH, unlike SetupService**  
  Now at: `src/backend/features/agents/install.ts:98`  
  Evidence: onExit still runs `const installed = isOnPath(adapter.bin)` with no applyLivePathToProcess (the file imports nothing from platform/env-path; git diff c026463..HEAD shows install.ts unchanged). setup.ts:216 does `await applyLivePathToProcess()` before its own verdict.  
  Recommendation: Make onExit async and await applyLivePathToProcess() before the isOnPath verdict (as originally recommended), or retire InstallService onto SetupService's verify so the two verdict paths cannot diverge.  
  Note: Exposure shrank: providers.ts:97-101 shows all UI callers now use SetupService (which repairs PATH first); agents:install stays wired (src/main/agents.ts:192) but only gates drive it, so the false 'failed' bites only that legacy path.

- **[still-open · low] F7 — OpenCode has a sign-in verb but no login probe**  
  Now at: `src/backend/features/agents/logins.ts:91`  
  Evidence: PROBES (logins.ts:91-95) still lists only claude/codex/gemini. The registry (now src/backend/core/agent-clis/registry.ts:216) still gives opencode `signIn: { shell: 'opencode auth login' }`, so probeLogin returns undefined for opencode and agents.ts:189 can never set needsSignIn for it.  
  Note: Registry moved from features/agents to core/agent-clis in the delta; the gap itself is unchanged. discoverLogins (logins.ts:118) also still iterates only the three probed providers.

### agent-state-attention

- **[still-open · medium] F1 — In-proc fallback backend silently loses the whole layer-B verdict channel**  
  Now at: `src/backend/features/terminal/pty.service.ts:156-161`  
  Evidence: In-proc spawn env still sets only MOGGING_PANE_ID/MOGGING_PANE_TOKEN (159-161); MOGGING_DAEMON_ENDPOINT is injected only by the daemon (pty-daemon/index.ts:77); notify-hook.ts:439 still no-ops: `if (!process.env.MOGGING_PANE_ID || !process.env.MOGGING_DAEMON_ENDPOINT) return`. git log c026463..HEAD on these files is empty.  
  Recommendation: as originally recommended: give in-proc a main-hosted notify ingress feeding PtyService trackers, or correct the boot.ts:300 message and docs/21 §2 to state hooks are inactive in-proc  
  Note: Original cited src/backend/boot.ts:300; the unchanged 'work normally' message actually lives at src/main/boot.ts:300. Everything else verified byte-identical since baseline.

- **[still-open · medium] F2 — Subagent tool activity cancels the deferred done, stranding the pane busy**  
  Now at: `src/backend/features/agent-state/activity.ts:255`  
  Evidence: notify('busy') still unconditionally discards the deferred verdict: line 255 `this.deferredDone = false // it is working: whatever it said before, it did not finish` — no pendingSubagents guard. subagentStart/subagentStop (282-299) unchanged; no commits to activity.ts since c026463.  
  Recommendation: as originally recommended: keep deferredDone intact while pendingSubagents > 0, plus an attention-smoke assert that busy-during-fan-out still lets the last subagentStop redeem done  

- **[still-open · low] F3 — OSC introducer aborting a torn OSC is swallowed; next OSC can ring a false bell**  
  Now at: `src/backend/features/agent-state/osc-parser.ts:108-113`  
  Evidence: The pendingEsc-inside-OSC branch (101-113) still recognizes only ST_TAIL and ESC: `// ESC not followed by '\' inside an OSC terminates it (discard); re-arm on ESC.` — OSC_INTRO falls into the discard path, drops to ground, and the next '9;text BEL' scans as ground so BEL fires the raw bell event at line 139. File untouched since baseline.  
  Recommendation: as originally recommended: on OSC_INTRO in that branch start a fresh OSC (inOsc=true, discarding=false, buf=''); add a torn-OSC case to oscOverflowAsserts  

- **[still-open · low] F4 — Webhook bridge never forgets a dead pane; reused id can suppress first needs-you**  
  Now at: `src/main/event-bridge.ts:209-216`  
  Evidence: `const lastState = new Map<number, string>()` (209) is still only ever set (214-215), never deleted; grep confirms no onPaneGoneForBridge exists anywhere. daemon-relay.ts onExit (now 148-155) deletes its own lastStates (151) and calls notePaneGone (154) but never clears the bridge map, so a reused id with prev='attention' fails the edge test at 216.  
  Recommendation: as originally recommended: export onPaneGoneForBridge(paneId) deleting the entry, call it from daemon-relay onExit beside notePaneGone (daemon-relay.ts:154), assert in attention-smoke bridgeAsserts  

- **[still-open · low] F5 — Docs claim oversized-OSC discard at >4 KB; the real cap is ~295 K characters**  
  Now at: `src/backend/features/agent-state/osc-parser.ts:82`  
  Evidence: `const MAX_OSC = PANE_CWD_MAX * 9 + 64` (82) with PANE_CWD_MAX = 32_768 (src/contracts/domain/cwd.ts:10) ≈ 295 K, while docs/21-agent-state-signals.md:125 and the osc-parser.ts:129 comment still say 'vim/tmux OSC 52 clipboard > 4 KB) are discarded'. Neither file changed since baseline.  
  Recommendation: as originally recommended: correct docs/21 §3 (and the osc-parser.ts:129 comment) to the real MAX_OSC bound, or cap non-633 OSC bodies at ~4 KB keeping the large allowance for Mogging 633 cwd dialects  

- **[invalid · none] F6 — Renderer reload double-records a standing done in the completion history**  
  Now at: `src/ui/core/attention/completions.ts:25-35`  
  Evidence: The log (`const log = new Map<PaneId, number[]>()`, completions.ts:25) is module-level renderer state — the same reload that rebuilds the port empty also wipes the history, so the menu can never show the same finish twice. The replay path (terminal-pane.ts:1714-1722 syncState → applyState:1701 → attention-port.ts:91) records exactly ONE entry, re-stamped at reload time.  
  Recommendation: No behavior change needed; optionally soften the completions.ts:27-29 comment to note the dedup holds only within one renderer session  
  Note: Auditor misread the log's lifetime as surviving reload. Residual: the replayed entry is timestamped at reload time, but completions.ts:16-18 already declares the history session-scoped and non-durable; only the 27-29 comment overclaims.

### command-blocks

- **[moved-still-open · high] F1 — Alt+Up/Down block jump is snapped back to bottom by the scroll anchor**  
  Now at: `src/ui/features/terminal/pane-anchor.ts:226 (jump call now terminal-pane.ts:880-882)`  
  Evidence: pane-anchor.ts:226 gesture branch is still `if ((e.shiftKey || e.ctrlKey || e.metaKey) && SCROLL_KEYS.has(e.key))` — Alt chords open no window; blocks.jump scrollToLine -> onScroll outside window -> pin -> repin scrollToBottom (pane-anchor.ts:121-124). Baseline diff on pane-anchor.ts is only +10 lines of DEC 2026 guards; no fix.  
  Recommendation: As originally recommended: add alt-modified ArrowUp/Down to the gesture branch at pane-anchor.ts:226 (noteGesture(k==='ArrowUp')) or release the anchor in terminal-pane.ts:880 before jump; assert in blocks-smoke.  
  Note: Lines drifted (216->226, 836->880) from the +10-line sync-output guards and unrelated pane edits; the defect is byte-identical.

- **[still-open · high] F2 — Promised block search has no user-facing entry point**  
  Now at: `src/ui/features/blocks/block-tracker.ts:149`  
  Evidence: find() (:149-155) is still only reachable via the dev handle findBlocks (terminal-pane.ts:2251-2252), consumed solely by blocks-smoke.ts:31; jumpTo() (:158-162) still has zero callers (settings/index.ts:925 jumpTo is an unrelated local). No palette command, find bar, or menu wiring anywhere; block-tracker.ts unchanged since c026463.  
  Recommendation: As originally recommended: wire a palette command or per-pane find bar calling find()+jumpTo(), and cover it in the smoke.  

- **[still-open · medium] F3 — Timestamps and durations are modeled but never displayed**  
  Now at: `src/ui/features/blocks/block-tracker.ts:128`  
  Evidence: Gutter title at :128 still renders only command + exit; collapsed strip at :201 only command/exit/line-count. startedAt/durationMs (:66,:104-105) are read only by the dev handle (terminal-pane.ts:2242-2249) and emitSessionCapture (:977). No UI change since baseline.  
  Recommendation: As originally recommended: render start time and duration in the gutter title (:128) and collapsed strip (:201).  

- **[moved-still-open · medium] F4 — No replay guard: reattach falsifies timestamps and re-captures blocks to brain drafts**  
  Now at: `src/ui/features/terminal/terminal-pane.ts:970-978 (tracker at block-tracker.ts:66,104)`  
  Evidence: Commit 198ebbd added replay guards only for OSC 52 clipboard (replayCopyGraceUntil, terminal-pane.ts:125,300,558) and the agent-exit 133 grace (:461-481). BlockTracker's 133 handler is untouched: replayed blocks get startedAt=Date.now() (block-tracker.ts:66,104); capturedThrough is a fresh per-life field (:154) so emitSessionCapture re-sends the replayed ladder.  
  Recommendation: Better fix now available: pass the pane's replay window (replayCopyGraceUntil) into BlockTracker and tag blocks completed inside it as replayed (no timestamps, excluded from emitSessionCapture); or persist capturedThrough per pane id.  
  Note: The delta added the exact ingredient a fix needs: the pane now stamps replayCopyGraceUntil at spawn/reattach (:558), a ready-made replay window BlockTracker could consult.

- **[still-open · medium] F5 — Huge outputs trim markers to line -1, leaving ghost blocks with wrong covers and jumps**  
  Now at: `src/ui/features/blocks/block-tracker.ts:190-196`  
  Evidence: block-tracker.ts unchanged since c026463: no isDisposed check or onDispose subscription anywhere. reposition (:192) still computes `const first = b.startMarker.line + 1` (0 for a trimmed marker's -1), jump (:169) filters only `l != null` so -1 passes, jumpTo (:161) clamps -1 to line 0, and list/find keep returning the ghost.  
  Recommendation: As originally recommended: subscribe startMarker.onDispose to prune the block; filter isDisposed in reposition/jump/find.  

- **[moved-still-open · medium] F6 — Alt+Arrow is swallowed even in panes with zero blocks**  
  Now at: `src/ui/features/terminal/terminal-pane.ts:880-882`  
  Evidence: Still unconditional: `if (e.altKey && (k === 'arrowup' || k === 'arrowdown')) { this.blocks?.jump(...); return false }` — the shell never receives ESC[1;3A/B even when jump() (block-tracker.ts:165-173) finds no target.  
  Recommendation: As originally recommended: have jump() return whether it moved and return true (pass to shell) when nothing jumped.  
  Note: Only the line number moved (836->880) from unrelated edits above it.

- **[still-open · medium] F7 — No unit tests for BlockTracker; smoke never exercises jump, cover DOM, or timestamps**  
  Now at: `src/main/smokes/blocks-smoke.ts:20-39`  
  Evidence: blocks-smoke.ts is byte-identical to baseline: asserts count/exits/cmds, the collapsed flag, and findBlocks('1') only — no Alt+Arrow dispatch, no .block-collapsed DOM, no startedAt/durationMs. tests/unit gained 10 new test files since baseline; none touch blocks and no tests/unit/*block* file exists.  
  Recommendation: As originally recommended: add tests/unit/block-tracker.test.ts (exitColor, find, ring cap, readCommand cursor-row slice) and extend the smoke to dispatch Alt+ArrowUp and assert viewport movement + cover render — it would catch F1/F6 directly.  

- **[still-open · low] F8 — Stale src/ui/features/command-blocks dir describes an architecture that does not exist**  
  Now at: `src/ui/features/command-blocks/README.md:4`  
  Evidence: Dir still contains only the README, unchanged since baseline, claiming boundaries are 'detected in `backend/features/agent-state` and delivered over a command-block contract slice'; the shipped implementation is renderer-side OSC parsing in src/ui/features/blocks/block-tracker.ts:49 with no contract slice.  
  Recommendation: As originally recommended: delete the dir or reduce the README to a one-line pointer to src/ui/features/blocks.  

### notify-hooks

- **[still-open · medium] F2 — Gemini/OpenCode per-session generated configs share one fixed file; launches clobber**  
  Now at: `src/main/notify-hook.ts:119-120 and :131`  
  Evidence: Unchanged: `writeGenerated('gemini-system-settings.json', geminiSystemSettings(..., session.runtime))` at :119-125 and `writeGenerated('opencode-tui.json', opencodeTuiConfig(userTui, session.tui))` at :131 still write session-scoped content into fixed shared filenames; each pane's env (GEMINI_CLI_SYSTEM_SETTINGS_PATH / OPENCODE_TUI_CONFIG) points at the same path.  
  Recommendation: As originally recommended: per-launch filename (pane id or nonce suffix) plus stale-file GC on app start; the env var already carries the exact path.  

- **[still-open · medium] F3 — OpenCode tui.json read ignores XDG_CONFIG_HOME, diverging from global wiring**  
  Now at: `src/main/notify-hook.ts:130`  
  Evidence: Still-broken line: `const userTui = readJson(join(homedir(), '.config', 'opencode', 'tui.json'))` — no XDG_CONFIG_HOME check. agent-global-hooks.ts:103-104 still resolves `$XDG_CONFIG_HOME/opencode` first, and its comment at :101-102 still (falsely) claims this is "the same resolution bellLaunchExtras mirrors for tui.json".  
  Recommendation: As originally recommended: extract opencodeDir()'s XDG-aware resolution (agent-global-hooks.ts:103-104) into a shared helper and use it for the userTui read at notify-hook.ts:130.  

- **[still-open · medium] F4 — Manual Codex snippet notify=["mogging","notify"] cannot execute on Windows**  
  Now at: `hooks/codex/config.toml:23`  
  Evidence: Still-broken line: `notify = ["mogging", "notify"]` at hooks/codex/config.toml:23 — on Windows `mogging` is an npm .cmd shim that Codex's shell-less spawn cannot execute. The app-managed global path avoids this (global-hooks.ts:244 codexNotifyValue emits `[ "node", <script> ]`), confirming node-invocation is the known-good pattern the manual snippet lacks.  
  Recommendation: As originally recommended: change the snippet (and README Codex row) to `notify = ["node", "<abs>/bin/mogging.mjs", "notify"]` on Windows or add an explicit .cmd-shim caveat, mirroring codexNotifyValue's node-based form.  

- **[still-open · low] F1 — Codex session hooks never wire on macOS: whitespace guard always trips**  
  Now at: `src/backend/features/agents/notify-hook.ts:297`  
  Evidence: Guard unchanged: `if (!/\s/.test(p)) {` at :297 still skips the `-c hooks.UserPromptSubmit/PostToolUse` overrides for any whitespace path; macOS userData (~/Library/Application Support/...) always has a space. Comment :290-294 documents the skip as deliberate (single shell string can't safely carry quotes through the cmd/sh/PowerShell relay).  
  Recommendation: As originally recommended: copy notify.mjs to a space-free dir (os.tmpdir()) when userData has whitespace and point the session hook there; alternatively rely on/promote the global-hooks path which already handles spaces.  
  Note: Keeping prior verifier's downgrade to low: skip is documented-deliberate, chime+notify (done/OSC 9) still wire per-session, and the global twin (global-hooks.ts:250-258) writes the same hooks with quoted paths and no whitespace limit.

- **[still-open · low] F5 — Toast cooldown conflates tones: green 'finished' suppresses red 'needs input' for 20s**  
  Now at: `src/ui/features/notify/index.ts:68`  
  Evidence: Unchanged: `if (now - (lastToast.get(paneId) ?? 0) < COOLDOWN_MS) return` at :68 gates both tones with one per-pane timestamp before the attention/done branch at :77-78; a done toast still suppresses a subsequent attention toast for 20s.  
  Recommendation: As originally recommended: key the cooldown by (paneId, tone), or let an 'attention' transition bypass a cooldown set by a 'done' toast.  

- **[still-open · low] F6 — mogging notify reads stdin before the pane-env guard; generated twin guards first**  
  Now at: `bin/mogging.mjs:1322-1331`  
  Evidence: Unchanged (only PROTOCOL_VERSION at :25 changed in this file since baseline, so lines hold): `const type = await readStdinType()` at :1323 inside the `event === 'needs-input'` branch still runs before the `if (!paneId || !endpointFile) bail(...)` guard at :1331-1333; the generated script's template still guards env first.  
  Recommendation: As originally recommended: hoist the paneId/endpointFile no-op guard above the stdin read in runNotify to match the generated twin's ordering.  

### worktrees

- **[still-open · high] F3 — No Windows long-path handling: worktree add can fail where the repo is fine**  
  Now at: `src/backend/features/worktrees/index.ts:94`  
  Evidence: worktreesRoot still joins <repo>/.mogging/worktrees (line 94), path built at 134-135; preflightWorktrees (61-91) still checks only git presence, repo-ness, HEAD, and mkdir writability. Grep for longpaths / 'Filename too long' / MAX_PATH across src/ finds nothing.  
  Recommendation: As originally recommended: win32 preflight headroom check against 260 with an actionable core.longpaths hint, and/or run adds with -c core.longpaths=true.  
  Note: Unchanged; a Windows-only failure after a green preflight — platform-divergence law keeps this high.

- **[moved-still-open · medium] F1 — "Remove anyway" after a post-close dirty refusal is a dead code path**  
  Now at: `src/ui/features/terminal/terminal-pane.ts:1990`  
  Evidence: remove(true) still dispatches 'mogging:remove-worktree' on eventHost (terminal-pane.ts:1990-1995; 'Remove anyway' at 2006); sole listener still on the workspace container (controller.ts:326); grid-layout.ts unchanged, so the host is detached after close. Even if delivered, requestClosePane returns false for a missing pane (controller.ts:819).  
  Recommendation: As originally recommended: when the pane is unmounted, invoke WorktreeChannels.remove directly with force:true instead of dispatching on the detached host.  
  Note: Only line drift (1946 to 1990). Keeping prior verifier's corrected severity: fails safe (worktree survives), git CLI workaround exists.

- **[still-open · medium] F2 — Dirty detection fails open when git status errors (1MB maxBuffer, timeout)**  
  Now at: `src/backend/features/worktrees/index.ts:215`  
  Evidence: removeWorktree still: `if (st.ok && st.stdout.trim().length > 0) return { ok: false, reason: 'dirty' }` (index.ts:214-215) so st.ok===false reads as clean; listWorktrees same at line 198; git() options still only {encoding, windowsHide, timeout}, no maxBuffer (index.ts:39).  
  Recommendation: As originally recommended: large maxBuffer in git(); treat status failure as dirty in removeWorktree; mark dirty=true on status failure in listWorktrees.  

- **[still-open · medium] F4 — Timed-out or killed worktree add leaks partial worktree, branch and registration**  
  Now at: `src/backend/features/worktrees/index.ts:141`  
  Evidence: createWorktree still returns `if (!res.ok) return { ok: false, error: res.error }` with no cleanup after a CHECKOUT_MS-killed add (line 140); wizard rollback (wizard/index.ts:574-584,603) only removes creates that returned ok paths; grep confirms no `git worktree prune` or `branch -D` anywhere in src/.  
  Recommendation: As originally recommended: on !res.ok, best-effort `git worktree remove --force`, `git branch -D mogging/<slug>`, and `git worktree prune` before returning the error.  

- **[still-open · medium] F5 — Orphaned worktrees have no in-app inventory or cleanup once their pane is gone**  
  Now at: `src/ui/features/terminal/terminal-pane.ts:1967`  
  Evidence: Removal is still only the pane menu, gated on the pane cwd matching .mogging/worktrees (terminal-pane.ts:1967-1968, now also excluding remote panes); WorktreeChannels.list's only consumer remains the pre-check (line 1973); no cleanup on close/quit — remove calls are controller.ts:422 (pane flow), 1414 (split rollback), wizard rollback only.  
  Recommendation: As originally recommended: a per-project worktrees panel backed by listWorktrees with the guarded remove flow, plus cleanup offer for clean pane-less worktrees on workspace close.  

- **[still-open · medium] F6 — Detached-HEAD launch records literal 'HEAD' as fork base; review base degrades**  
  Now at: `src/backend/features/worktrees/index.ts:137`  
  Evidence: Still records `rev-parse --abbrev-ref HEAD` (line 137) into mogging-base (line 147); git/ and review/ have zero diff since baseline: readManagedBase (repo.ts:238-260) accepts 'HEAD', probe falls back to the default branch (probe.ts:155,226-228), and review's baseFor (review/index.ts:47-58) resolves 'HEAD^{commit}' against the repo's CURRENT, drifting HEAD.  
  Recommendation: As originally recommended: when abbrev-ref returns 'HEAD', write the `git rev-parse HEAD` SHA to mogging-base — it passes readManagedBase validation and pins both probe and review to the exact fork point.  
  Note: Re-check found a second degrading consumer beyond the probe path: review/index.ts baseFor resolves the literal 'HEAD' against the repo's live HEAD, so the review base silently tracks whatever the repo checks out later.

### review-merge-gate

- **[still-open · high] F1 — Redactor misses npm/_authToken, gho_/ghu_/ghs_/ghr_, glpat-, and _-prefixed keys**  
  Now at: `src/backend/features/review/redact.ts:41`  
  Evidence: KV regex is still `\b([A-Za-z][A-Za-z0-9_.-]{0,127})...` — no boundary between `_` and `a`, so `_authToken`/`_password` never match. PATTERNS (redact.ts:10-23) still cover only ghp_/github_pat_. Re-ran the exact current regexes: '_authToken=npm_...', '_password = ...', gho_, ghr_, glpat- all yield 0 redactions. Sole scrub on the diff path (review/index.ts:138).  
  Recommendation: As originally recommended: add \bgh[ousr]_, \bnpm_, \bglpat- patterns; loosen KV key start to (?<![A-Za-z0-9])[A-Za-z_]...; add unit cases.  
  Note: File unchanged since baseline (git diff c026463..HEAD empty). Real credentials still reach the renderer and the copy-hunks clipboard (ui/features/review/index.ts:159-165).

- **[still-open · medium] F2 — Pure file rename can never merge through the gate, with a misleading blocker**  
  Now at: `src/backend/features/review/index.ts:156`  
  Evidence: Line 156 still reads `if (st.binary || hunks.length === 0) nonRendered = true`; diff/numstat calls at index.ts:118-119 still lack --no-renames, so a hunkless rename sets unreviewable=true and src/main/review.ts:50-55 hard-refuses (override cannot pass). numstat rename keys still mismatch parsePatch paths.  
  Recommendation: As originally recommended: pass --no-renames to the numstat and patch git calls in diffWorktree; add a rename case to the review smoke.  
  Note: File unchanged since baseline. UI still labels it 'binary, mode-only, or other non-rendered changes' (ui/features/review/index.ts:150), pushing users to raw git merge around the gate.

- **[still-open · medium] F3 — TOCTOU: destination HEAD can move between staleness check and git merge**  
  Now at: `src/backend/features/review/index.ts:205`  
  Evidence: mergeBranch still checks branch/baseHead/source at index.ts:186-199 then runs `git merge --no-ff` at :205 with no lock; mergeReviewedWorktree (src/main/review.ts:36-68) has no mutex. The post-merge check at :207 only asserts snapshot.head is an ancestor of HEAD — it cannot detect a base that moved after the check, so the race stands.  
  Recommendation: As originally recommended: serialize merges per repoId with an in-process async mutex in mergeReviewedWorktree and re-check HEAD/baseHead inside the critical section.  
  Note: File unchanged since baseline; the ancestor check at :207 predates the audit and does not close this race.

- **[still-open · medium] F4 — Merge IPC rejection leaves the confirm footer stuck with no feedback**  
  Now at: `src/ui/features/review/index.ts:201`  
  Evidence: Still `void (getBridge().invoke(ReviewChannels.merge, {...}) as Promise<ReviewMergeResult>).then((res) => {...})` (lines 201-252) with no .catch and no timeout: a rejected invoke is an unhandled rejection, no toast, footer stuck in typed-confirm state. The diff read above still uses createAsyncGuard (lines 102-123) for exactly this failure mode.  
  Recommendation: As originally recommended: add a .catch showing a danger toast and calling rebuildFooter(), or reuse createAsyncGuard with a timeout as the diff path does.  
  Note: File unchanged since baseline.

- **[still-open · low] F5 — Override word accepted case-insensitively; contract and docs say VERBATIM**  
  Now at: `src/ui/features/review/index.ts:197`  
  Evidence: Line 197 still compares `input.value.trim().toLowerCase() !== confirmWord` and line 204 still sends the lowercased value, so 'OVERRIDE'/'Override' pass. src/contracts/ipc/review.ipc.ts:62 still says the word must be 'override' VERBATIM; the backend check (backend review index.ts:182) is exact.  
  Recommendation: As originally recommended: drop .toLowerCase() from both the comparison (line 197) and the payload (line 204).  
  Note: Both UI and contract files unchanged since baseline.

- **[still-open · low] F6 — Non-ASCII file paths render as '(unknown)' with zeroed stats**  
  Now at: `src/backend/features/review/index.ts:85`  
  Evidence: parsePatch still uses `/^\+\+\+ b\/(.+)$/m` (line 85) and headerMatch (line 86), both failing on quotepath-escaped headers like `+++ "b/caf\303\251.ts"`; git calls at index.ts:118-121 still run without -c core.quotepath=false, so the file shows as '(unknown)' and the escaped numstat key mismatches to +0/-0.  
  Recommendation: As originally recommended: prepend -c core.quotepath=false to the diff/numstat/status/ls-files invocations and unescape quoted diff --git headers as a fallback.  
  Note: File unchanged since baseline. Failure is identical on both platforms, so no platform-divergence escalation.

### board-kanban

- **[still-open · medium] F1 — Task handoff writes raw multi-line/unsanitized text to the PTY**  
  Now at: `src/ui/features/board/launch.ts:155`  
  Evidence: Byte-identical to baseline (empty diff for src/ui/features/board). :114 still `.replace(/\r/g,'')` only; :155 still `bridge.send(TerminalChannels.write, { id: paneId as PaneId, data: prompt + '\r' })`. sanitizePaste (clipboard-port.ts:226) is used only at terminal-pane.ts:904/920; daemon-relay.ts:447 forwards data verbatim. Notes still length-sliced only (main/board.ts:153).  
  Recommendation: As originally recommended (sanitizePaste, or strip C0/ESC and \n->CR, before the final '\r'; BOARDFAIL case for hostile bytes). Better now: also send the pane's gen — transport.ts:214 gates input only when gen is numeric, so this write skips v11's reuse gate.  
  Note: Held at the prior verifier's medium, not the original HIGH: notes with blank lines submitting fragment-by-fragment is common but harmless; injection needs hostile notes plus the queue, off by default and risk-confirmed.

- **[still-open · medium] F3 — Queue spend-record can clobber a concurrent kill-switch flip (board config is LWW)**  
  Now at: `src/ui/features/board/queue.ts:90-93`  
  Evidence: Unchanged. queue.ts:92 still `patch: { config: { queue: { ...queue, launches: [...launches, now] } } }`, carrying tick-time enabled/pausedReason. No CAS at the sink: main/board.ts:426 spreads only the TOP level, so `queue` is replaced wholesale, then :428 updateBoardRow with no revision compare. board-settings.ts:293 `...model.state.board!.config.queue` races identically.  
  Recommendation: Take the atomic-verb option: record the spend in main inside boardTransaction (append timestamp only, never echo enabled/pausedReason). Also merge config one level deeper in patchBoardMeta so the settings Done save cannot carry a stale launches array.  
  Note: Unchanged. Both docs/18 directions stay exposed: a lost `enabled:false` relaunches unattended agents; a clobbered `launches` under-counts an engine-enforced budget. pause() already re-reads, so only one of three writers was patched.

- **[still-open · medium] F4 — Stale pane bindings persist for non-loaded boards; reused pane ids revive dead claims**  
  Now at: `src/ui/features/board/index.ts:242-249`  
  Evidence: Unchanged. Unbind is loaded-board-only: index.ts:243 `const card = model.state.cards.find((c) => c.paneId === paneId)`. No main-side reconcile: the list handler (main/board.ts:466-475) does migrate+autoArchive+listCards only; paneId/workspaceId nulling in main appears only as create defaults (:349-350). Claim check unchanged at board.ts:250 `workspaceIdForPane(holder) !== undefined`.  
  Recommendation: As originally recommended: reconcile in main at board load — clear paneId/workspaceId (keep branch, matching index.ts:248) on any card whose workspaceId is absent from the persisted workspaces list.  
  Note: Unchanged. Still violates docs/18 'a dead pane's claim never blocks anyone'. Chips/liveBusy (queue.ts:47,205) self-correct via paneInstance, but the main-side claim check does not — that is where the wrongful block bites.

- **[invalid · low] F2 — Refused write silently dropped when a newer write supersedes it (shared saveGuard)**  
  Now at: `src/ui/features/board/model.ts:157-162`  
  Evidence: The auditor misread which branch is guarded. Refusal handling is INSIDE the task body: model.ts:157 `if (result.reason === 'conflict')` toast, else toast, then :162 `await reload()`. async-state.ts:72/76 `if (token !== generation) return` runs only after `await withTimeout(task(),...)`, so it skips onSuccess/onError but never task-body code. Drag X then Y: X's refusal still toasts and reloads.  
  Recommendation: Leave the refusal path alone; it is correct. Move both guards' error handling into the task body (try/catch around the invoke, toast + reload there) so a superseded thrown failure still reconciles. Reachable via the maybeFault seam at main/board.ts:484.  
  Note: A narrower defect survives: thrown failures ARE swallowed when superseded. model.ts:166-169 errors only via onError; removeCard (:219-225) is onError-only, so a superseded failed delete leaves the card gone on screen but live in the DB.
  Challenger: **DISAGREES — still open** — Both files byte-identical to c026463. Re-validator only checked the refusal branch; the THROW path is still gen-gated: async-state.ts:76 skips model.ts:166-169 onError (no toast, no reload; card keeps optimistic lane+revision) once a newer patch bumps the shared guard. removeCard model.ts:219-225 is worse: ALL failure handling is in onError.

- **[still-open · low] F5 — Queue self-pause counter is renderer-memory only; poke listener never unsubscribes**  
  Now at: `src/ui/features/board/queue.ts:37`  
  Evidence: Unchanged on both halves. queue.ts:37 `const consecutiveFails = new Map<string, number>()`; :143 pauses at `fails >= 2`, but BoardQueueConfig (contracts/ipc/board.ipc.ts:117-133) still has no fail-count field, so a restart zeroes it while `launches` persists. stop() (:186-189) still only clears the interval, never undoing `bridge.on(BoardChannels.changed, poke)` from :184.  
  Recommendation: As originally recommended: persist the consecutive-fail count in BoardQueueConfig next to launches, and have stop() drop the changed-channel subscription (keep the off-handle bridge.on returns).  
  Note: Unchanged. The leak half is sharper than a listener leak: poke calls tick() unconditionally (:172-178), so a stopped engine can still pull and launch. Low only because nothing calls stop() today (index.ts:260-261 starts it app-wide).

- **[still-open · low] F6 — Queue launches compose the first prompt against the ACTIVE workspace's settings**  
  Now at: `src/ui/features/board/launch.ts:118`  
  Evidence: Unchanged. launch.ts:59-61 resolves the active workspace; :115-119 passes `anchorWorkspaceId: active?.id ?? null` while root is the board's cwd. The queue supplies only the folder (queue.ts:122 `{ cwd: board.projectKey, actor: 'queue' }`) and tick() walks every enabled board. The anchor drives agents/launch.ts:72 orientGet, :79 recallGet, :81-85 recall.  
  Recommendation: As originally recommended: add an optional anchorWorkspaceId to startOnCard; the queue derives it from a workspace whose cwd resolves to board.projectKey (via projectKeyForCwd) and passes null when none resolves, skipping orientation rather than borrowing.  
  Note: Unchanged severity, but worse than borrowed opt-ins: agents/launch.ts:81-85 sends board B's card text as a recall query anchored at workspace A, so one project's task prose reaches another project's brain index.

- **[still-open · low] F7 — Failed legacy migration is latched as done for the whole session**  
  Now at: `src/main/board.ts:77`  
  Evidence: Unchanged. board.ts:77 `migrated = true` still precedes the work; the assigning transaction runs after at :81-87, with no try/finally and no reset. ensureBoardForKey (:99) can itself throw. Every retry entry point then short-circuits on the flag: :125, :234, :323, :470.  
  Recommendation: As originally recommended: set migrated = true only after boardTransaction returns, leaving it false on throw so the next board access retries.  
  Note: Unchanged. Reads as data loss against docs/18's migrate-on-first-touch promise, but rows survive on disk and a restart retries; the trigger is a one-off sqlite failure.

### control-api

- **[still-open · medium] F1 — Deep-link cwd reaches the renderer unvalidated (unbounded, control chars, UNC)**  
  Now at: `src/main/deep-link.ts:31`  
  Evidence: deep-link.ts is byte-identical to baseline (git diff --stat c026463..HEAD is empty). Line 31-32 still `const cwd = u.searchParams.get('cwd')` / `return cwd ? cwd : null`. Line 51 still only `p.cwd.length > 1024` — no control-char, absolute or UNC check. Line 109 forwards raw; consumer controller.ts:1826 openForCwd adds no validation.  
  Recommendation: Better model than the cited remote helper: bin/mogging.mjs:945-954 (runCwd) already does length cap + /[\x00-\x1f\x7f]/ + statSync isDirectory. Port it into one shared helper used by cwdFromUrl (:31) and sanitizeControl (:51), plus isAbsolute and UNC reject.  
  Note: Untouched by the delta. 39e4b93 (remote insert honesty) edited controller.ts but added no local-cwd validation, so the Windows-only UNC/NTLM-probe divergence stands — a parity issue as well as security.

- **[still-open · medium] F2 — Any mistyped verb silently launches the GUI app instead of erroring**  
  Now at: `bin/mogging.mjs:803`  
  Evidence: Only diff to bin/mogging.mjs since baseline is PROTOCOL_VERSION 10->11. Line 62 still `else runOpen(argv)`; runOpen (803-815) still `const dir = resolve(args[0] ?? '.')` then spawns the deep link with no existence check and prints line 814 `mogging: opening workspace for ${dir}`, exit 0. The contrasting check still sits unused at 949-954.  
  Recommendation: as originally recommended — in runOpen gate on statSync(dir).isDirectory() and usage(2) otherwise, reusing bin/mogging.mjs:949-954.  
  Note: Unchanged; still violates docs/06-control-api.md:22 ('2 usage'). Slightly aggravated: the verb list at lines 40-60 grew (map, recall, mail, role, claim, owners, approve, layout, focus, expand...), so more verbs can be mistyped.

- **[still-open · low] F3 — Deep-link validation (sanitizeControl/controlFromUrl/cwdFromUrl) has zero unit tests**  
  Now at: `src/main/deep-link.ts:84`  
  Evidence: grep for sanitizeControl|controlFromUrl|cwdFromUrl across tests/ still returns nothing; grep 'deep-link' in tests/ returns nothing; no file among tests/unit's 34 matches deep|control|link. The delta added 10 new unit test files, none covering this. controlFromUrl (84-94: scheme, hostname, JSON.parse) has no coverage at any level.  
  Recommendation: Narrow to what CONTROL2 does not cover: unit tests for controlFromUrl (wrong scheme, wrong hostname, malformed/missing `c` JSON), cwdFromUrl, and sanitizeControl's oversized-cwd / paneId range / unknown-field-drop. Land them with the F1 shared validator.  
  Note: Lowered from medium: the original evidence overstated it. control2-smoke.ts calls sanitizeControl directly (line 24) and lines 92-97 assert 5 hostile payloads sanitize to null — and that smoke is in the gate (scripts/qa-smokes.sh:373).

- **[moved-still-open · low] F4 — captureTail returns one line fewer than requested when scrollback ends with a newline**  
  Now at: `src/pty-daemon/session.ts:885`  
  Evidence: Logic identical, only relocated 812->883 by session.ts's +145/-21. Line 885 `const lines = this.buffer.split('\n')`, line 886 `return lines.slice(-cap).join('\n')` — no trailing-empty strip. transport.ts:289 passes it through; bin/mogging.mjs:1173 only appends a newline if absent, so --lines 2 on 'a\nb\nc\n' still prints one content line.  
  Recommendation: as originally recommended — at src/pty-daemon/session.ts:885, pop a trailing '' element before slice(-cap).  
  Note: Same defect at a new line number; nothing in the delta (protocol v11, replay-integrity work) touched captureTail.

- **[still-open · low] F5 — `mogging list` output has a REMOTE column the docs do not promise**  
  Now at: `bin/mogging.mjs:1096`  
  Evidence: Code unchanged. runList still builds `remote: p.remoteName ?? ''` (line 1086), width wrm (1093), and prints line 1096 `line('ID', 'SIZE', 'STATE', 'REMOTE', 'TITLE')`. docs/06-control-api.md:11 still documents `ID SIZE STATE TITLE`; git diff --stat c026463..HEAD -- docs/06-control-api.md is empty.  
  Recommendation: Prefer the second option now that remote panes are first-class: add `--json` to list (matching existing owners/approvals JSON modes) AND fix docs/06:11 to `ID SIZE STATE REMOTE TITLE`, noting REMOTE is empty for local panes.  
  Note: Unchanged, but mildly aggravated: remote work landed (remote insert honesty; HEAD cbda0ec turns the REMOTE gate green on Windows), so non-empty REMOTE cells are now a likelier runtime state than at baseline.

- **[still-open · low] F6 — send's pipelined-ping confirmation reports success even when the pty dropped the input**  
  Now at: `src/pty-daemon/transport.ts:214`  
  Evidence: 'input' still un-acked: transport.ts:210-216 `const pane = sessions.get(m.id); if (pane && (typeof m.gen !== 'number' || m.gen === pane.gen)) pane.write(m.data)` — no send({t:'sent'}). That ack exists only for send-key (transport.ts:280; protocol.ts:366). writePty still swallows failures (session.ts:784-793). CLI still exits on pong (bin/mogging.mjs:1127, 1130).  
  Recommendation: As recommended, plus the new path: reply {t:'sent',id,ok} for 'input' at transport.ts:210-216, ok=false for unknown pane, gen mismatch, and failed writePty (return the session.ts:784-793 catch, not log-only); key runSend's exit on that ack, not the pong.  
  Note: Protocol v11 added a THIRD silent-drop path: the gen gate at transport.ts:214 discards input with no reply. runSend (mogging.mjs:1126) is safe only because it omits `gen` — an accidental, undocumented dependency.

### swarm

- **[moved-still-open · medium] F1 — claimsOverlap treats ? and [...] segments as literals, granting overlaps**  
  Now at: `src/contracts/daemon/protocol.ts:189`  
  Evidence: Line byte-identical, shifted 10 lines by the v11 comment: `if (!x.includes('*') && !y.includes('*') && x !== y) return false`. Only `**` (185) and `*` are non-literal. normalizeClaimPattern (165-173) still accepts `?`/`[`. git diff c026463..HEAD on this file shows only the 10->11 bump and the `gen` field.  
  Recommendation: As originally recommended. Cheapest: `const literal = (s) => !/[*?[]/.test(s)` then `if (literal(x) && literal(y) && x !== y) return false` — one edit, keeps conservative-deny. Or reject ?/[ in normalizeClaimPattern so they exit 2.  
  Note: Untouched by the delta. The function's own doc (177-179) promises 'partial wildcards ... all count as overlap', which ?/[ falsify — code contradicts its stated contract, not just the docs.

- **[still-open · medium] F2 — approve from the branch's own checkout records a sign-off that never gates**  
  Now at: `bin/mogging.mjs:476`  
  Evidence: Still `const base = flag('--base') || git(['rev-parse','--abbrev-ref','HEAD'])`; no base===branch or head===baseHead check in runApprove (448-505). The OID gate at 481-484 passes cleanly, line 492 prints 'approved' exit 0. src/main/review.ts:15-27 still compares base/baseHead/mergeBase, so it never matches. Only delta to this file: PROTOCOL_VERSION 10->11.  
  Recommendation: As originally recommended: refuse when base === branch or baseHead === head, naming `--base <destination>`. Use an exit code distinct from 2 so it reads 'nothing was gated' rather than 'could not resolve'.  
  Note: Unchanged. Fails closed for the merge, but the reviewer is told 'approved' with exit 0 — a green signal over a gate that did not actually run (gate honesty).

- **[moved-still-open · medium] F3 — set-role and unapprove lack the v10 pane binding; any agent can demote reviewer**  
  Now at: `src/pty-daemon/transport.ts:319`  
  Evidence: set-role moved 311->319, still `const ok = sessions.has(m.id) && sessions.mailbox.setRole(m.id, m.role)` (320) with no from/token. unapprove moved 400->408, deletes on repoId/branch strings alone (410-414). mail-send (303), claim (333), release (348), approve (378) all still bind. Comment at 363-366 admits it: 'set-role is open to any authenticated client ... a pane can promote itself'.  
  Recommendation: As originally recommended. boundToPane (transport.ts:143) and per-session paneToken already exist, so set-role needs the same three lines as claim/release plus 'a pane sender may only target its own id'; restrict unapprove to '0'/app senders.  
  Note: Unchanged. Not a merge bypass — the real gate is appRoles in src/main/daemon-relay.ts — but a rogue pane can demote the reviewer (approve then exits 6) or wipe sign-offs, halting the review flow at will.

- **[still-open · medium] F4 — Daemon retire/restore silently frees all claimed territory while sessions live**  
  Now at: `src/pty-daemon/ledger.ts:26`  
  Evidence: Claims still only `private claims: Claim[] = []` (26); roles only a Map (mailbox.ts:17). Neither serializes. PaneSession.snapshot() (session.ts:888-908) persists id/cwd/remote/command/scrollback/cols/rows — no claims, roles, approvals. daemon-migrate.ts is gone but the path survives: daemon-client.ts:117-128, whose comment says the fresh spawn 'cold-start restores every pane'.  
  Recommendation: Prefer announce over persist: the ledger is deliberately memory-only, and persisting could resurrect claims for panes that died in the retire. After a cold-start restore push one broadcast mail plus an empty `owners` so agents re-claim.  
  Note: Substance unchanged; only the cited migrate file was rewritten into the stamp-retire flow. Retires are now rarer (otherClients guard, daemon-client.ts:265-289), but an app update still restores panes while every claim vanishes.

- **[still-open · low] F5 — Moved panes contest claims in their birth workspace; UI groups by the real one**  
  Now at: `src/pty-daemon/ledger.ts:19`  
  Evidence: groupOf unchanged (19-22): `Number.isFinite(n) ? String(formulaOrdinalOf(n)) : '0'`, used as the contest filter at line 36. src/contracts/domain/pane.ts:37 warns formulaOrdinalOf is 'the formula's GUESS at birth ordinal. Only meaningful through locatePane'. UI still groups the other way: claims-store.ts:31-35 filters on workspaceIdForPane, rejecting id/100 in its comment.  
  Recommendation: Either have the app push a pane->workspace-ordinal map to the ledger on move (same relay that carries setRole), or re-home a pane's claims on move. Do NOT derive it daemon-side from sessions.workspaces() — that record has no ordinal/paneIds.  
  Note: Unchanged. Correction to the original fix: sessions.workspaces() returns PersistedWorkspace (workspace.ipc.ts:37-42) = id/name/layout/updatedAt only — no ordinal, no paneIds. The daemon cannot self-serve the answer today.

- **[invalid · low] F6 — swarm-smoke reads endpoint via LOCALAPPDATA only; gate said to fail on macOS**  
  Now at: `src/main/smokes/swarm-smoke.ts:40`  
  Evidence: Code is as cited (40-41, used at 84/87), but the macOS failure does not occur: scripts/qa-smokes.sh:135 exports BOTH LOCALAPPDATA and XDG_RUNTIME_DIR to "$iso/local" on every platform, so this path and runtimeDir() (runtime-paths.ts:17-30) resolve identically. boot.ts:161 also deletes MOGGING_CHANNEL under MOGGING_USERDATA, so the segment really is 'v11'.  
  Recommendation: Still worth doing as hygiene, not a platform fix: replace endpointPath() with join(runtimeDir(), 'endpoint.json') importing runtimeDir from '../daemon-client', as gate-smoke.ts:9,129 does. Also removes the silent dev-channel ('dev-v') mismatch.  
  Note: Dropped medium->low: the auditor read the smoke in isolation, missing that the harness exports LOCALAPPDATA on all platforms. The claimed failure would also throw into the catch (165) -> exit 1: a red gate, not a false green.
  Challenger: agrees — Code unchanged (swarm-smoke.ts:40-41) but unreachable: all launchers export LOCALAPPDATA+XDG_RUNTIME_DIR to one dir on every platform (qa-smokes.sh:135, its only launch; run-gate-batch.sh:20; verify SKILL.md:27). ci.yml:203 omits LOCALAPPDATA but runs only MOGGING_SMOKE on ubuntu, never SWARM. boot.ts:161 keeps segment v11.

- **[still-open · low] F7 — No unit tests for claimsOverlap / normalizeClaimPattern / Mailbox invariants**  
  Now at: `src/contracts/daemon/protocol.ts:177`  
  Evidence: Grep of tests/ for claimsOverlap|normalizeClaimPattern|Mailbox|Ledger returns nothing; tests/unit holds 34 files, none swarm. Only coverage is ledger-smoke.ts:62-73 ('src/a/**' vs 'src/b/**' — disjoint literals, so the wildcard branch at 185 never decides) and the ring cap in swarm-smoke.ts:114-150. claimsOverlap (177-191) is a pure export with zero test callers.  
  Recommendation: As recommended, landed with the F1 fix so the ?/[ rows go red first. Cases: literal divergence, prefix containment, '**' either side, partial '*' ('src/a*.ts' vs 'src/ab.ts'), ?/[ either side, plus normalize's traversal/drive-root/trailing-slash rejections.  
  Note: Unchanged, and it is the direct reason F1 survived 32 commits: a table test would have caught 'router?.ts' vs 'router1.ts' immediately, and the smokes structurally cannot — they only exercise clearly-disjoint literals.

- **[still-open · low] F8 — Directed mail to a closed pane is delivered to the slot's next occupant**  
  Now at: `src/pty-daemon/mailbox.ts:41`  
  Evidence: read() unchanged: `(m) => m.id > since && (forPane === undefined || m.to === 'all' || m.to === forPane)` (40-42). MailMessage carries no gen (send stamps id/from/role/to/body/ts, 22-29). Both teardown paths clear role and claims but never the ring: session.ts:1131-1132 (onExit) and 1323-1324 (remove), the latter commented 'pane ids get reused — a role never outlives its pane'.  
  Recommendation: Prefer purge over gen-stamping: add clearMail(paneId) to Mailbox (drop ring entries whose `to` is that id) and call it beside clearRole at session.ts:1131 and 1323. Mirrors the existing pattern, no wire change, cannot leak on a wrong client-supplied gen.  
  Note: Unchanged, and the delta sharpens it: v11 (protocol.ts:13-20, transport.ts:207-226) added gen gating to input/resize precisely because pane ids are reused. Directed mail is now the last id-keyed daemon state with no reuse defence.

### profiles-failover

- **[still-open · high] F1 — Failover relaunch in a daemon-reattached pane types nothing and mislabels the pane**  
  Now at: `src/ui/features/agents/index.ts:468`  
  Evidence: Adopt branch unchanged: `if (resume && wasPaneReattached(paneId)) {` (468) labels, adopts, sets lastLaunch (493) and returns at 494 without launchInto. doFailover still calls launchInPane(...,true,next.id) (684). Mark set at terminal-pane.ts:547, cleared only by forgetPane (liveness-port.ts:88-94) on dispose (terminal-pane.ts:2285).  
  Recommendation: Add an adopt opt-out param to launchInPane and pass false from doFailover; or clear the reattach mark where the agent-gone verdict already lands (index.ts:148-155).  
  Note: index.ts changed only for the sign-in banner; liveness-port.ts untouched. Nothing clears the reattach mark on agent exit. profiles-smoke.ts:109-124 exercises failover only in a fresh pane, so no gate reaches this path.

- **[still-open · high] F2 — Single ^C + fixed 900ms cannot exit double-Ctrl-C CLIs; resume lands in capped agent**  
  Now at: `src/ui/features/agents/index.ts:682`  
  Evidence: Byte-identical to baseline: `getBridge().send(TerminalChannels.write, { id: paneId as PaneId, data: '\x03' })` (682) then `setTimeout(() => { void launchInPane(...true, next.id)... }, 900)` (683-685). No prompt/agent-exit verification. launchInto still sends `command + '\r'` (agents.client.ts:28). settleToShell (smoke-shell.ts:128) is used by three smokes and nothing in production.  
  Recommendation: Use the settleToShell pattern in production: loop ^C until a shell prompt returns or the daemon's agent-gone verdict (index.ts:148) fires, then type. That same guard also closes F1's trigger.  
  Note: Also a 'we type, the user executes' breach: when the CLI survives one ^C the app presses Enter on a chat message into the capped account. The smoke passes only because it drives a fake single-^C gemini and calls settleToShell itself.

- **[moved-still-open · medium] F3 — Secret deny-list at profile save scans the value alone, so KEY-named credentials save**  
  Now at: `src/main/profiles.ts:118`  
  Evidence: Still the bare value: `if (redactSecrets(v).redactions > 0) return null // THE deny-list: secret-shaped -> refused` (118; shifted one line by the ADR-0022 import). Key `k` is only ENV_NAME-shape checked (115). redact.ts unchanged: KV rule needs literal key=value text (redact.ts:41) and keyLooksSecret is consulted only inside that replace (redact.ts:73), so a bare 40-char hex matches nothing.  
  Recommendation: As originally recommended: redactSecrets(`${k}=${v}`), or refuse when keyLooksSecret(k) unless the value matches the HOME_POINTER path grammar.  
  Note: git diff of profiles.ts shows only scheduleAccountDefaultsApply additions. ADR 0022 now fans a saved account's defaults out on every save (profiles.ts:204), so an accepted plaintext credential rides more machinery than at baseline.

- **[still-open · medium] F4 — No production producer of the usage-limit event — automatic failover never triggers**  
  Now at: `src/backend/features/agents/notify-hook.ts:76`  
  Evidence: notify-hook.ts absent from `git diff --stat c026463..HEAD`. notifTypeToEvent (76-106) maps to needs-input/idle-prompt/null with `default: return 'notice'` (104); codexTypeToEvent (40-50) yields done/needs-input/notice. Neither emits 'usage-limit'. Only path remains session.ts:954 -> daemon-relay.ts:205 -> index.ts:125, and the sole callers are profiles-smoke.ts:97,111.  
  Recommendation: Prefer driving onLimit from the usage engine: evaluateThresholds already tracks a fresh 100% lane per profile and attaches a failover suggestion (thresholds.ts:214) — route that alert to the pane, no CLI type guessing.  
  Note: Unchanged. With F1 and F2 the automatic-failover promise (docs/09-swarm.md:86, hooks/README.md:59, index.ts:43) has no live trigger and an unreliable relaunch. Medium stands: the manual toast path still works in a fresh pane.

- **[still-open · medium] F5 — suggestFailover judges siblings by lapsed windows, unlike the alert engine it feeds**  
  Now at: `src/backend/features/usage/thresholds.ts:106`  
  Evidence: `const worstPct = (o: PlanUsageView): number => Math.max(...o.windows.map((w) => w.usedPct))` (106), used by the `worstPct(o) < 50` filter (113) and the sort (117); signature (98-102) still takes no `now`. Ten lines below, evaluateThresholds does the opposite: `if (w.resetsAt && Date.parse(w.resetsAt) <= now) continue` (157). File unchanged since c026463.  
  Recommendation: Thread the `now` evaluateThresholds already holds (thresholds.ts:143) into suggestFailover and drop lapsed windows from worstPct — one call site (214), a two-line change.  
  Note: The file's own line 157 proves lapsed-resetsAt windows reach this code, so worstPct can be pinned high by a window that already reset — suppressing the suggestion exactly when the idle sibling is the best lane.

- **[still-open · medium] F7 — No unit tests for the profiles sanitizer, defaults derivation, or failover engine**  
  Now at: `tests/unit (no profiles.test.ts, no thresholds.test.ts)`  
  Evidence: `ls tests/unit` at HEAD: 34 files, none for profiles or thresholds. Repo-wide grep for sanitizeProfile|deriveProfileDefaults|suggestFailover|evaluateThresholds has no hit under tests/ — only production sites (profiles.ts:94,63; thresholds.ts:98,138), usage/index.ts:26, main/usage.ts:320 and the env-gated smokes (usage-smoke.ts:663-693; profiles-smoke.ts).  
  Recommendation: Two known-failing first cases: profiles.test.ts asserting sanitizeProfile({env:{MY_API_KEY:'<40-hex>'}}) === null (F3), and thresholds.test.ts asserting suggestFailover picks a sibling whose only >=50% window has a past resetsAt (F5).  
  Note: The new tests/unit/account-defaults.test.ts imports agent-settings/account-defaults — a different module. Coverage still sits behind MOGGING_PROFILES/USAGE, so a run without those gates is green over untested custody and failover logic.

- **[still-open · low] F6 — Auto-failover opt-in is in-memory only and silently resets to OFF every app run**  
  Now at: `src/ui/features/agents/index.ts:69`  
  Evidence: `const autoFailover = new Map<string, boolean>()` still in the mount closure (69). Writers: palette toggle (352-353) and DEV shim (721). Reader: `if (wsId && autoFailover.get(wsId))` (693). A repo-wide grep returns exactly these five lines — no settings-store key, no workspace-meta field; the palette title (346) never shows current state.  
  Recommendation: As originally recommended: persist per workspace alongside profileIds (or an app_settings key) and show the state in the palette title / Settings § Profiles.  
  Note: Unchanged. The delta hardened per-slot profile persistence (manifest follows failover, profpersist smoke), sharpening the contrast: the profile survives a restart but the mode that switches it does not.

### remotes-ssh

- **[still-open · high] F1 — Remote-ready latch never resets; restart types into the SSH auth prompt**  
  Now at: `src/ui/features/terminal/terminal-pane.ts:591-606`  
  Evidence: liveness-port.ts is byte-identical to baseline; only forgetPane (:88) drops remoteReady, called just from dispose (:2285). restart() (591) ends at `void this.spawnPty()` (606), resetting neither remoteReadyMarked (112) nor the signal; markDead (948)/onExit (346) drop nothing. when() short-circuits true (liveness-port.ts:46), so agents/index.ts:448 types into the prompt.  
  Recommendation: As originally recommended. Better seam now exists: the spawn reply's session gen (SpawnResult.gen -> this.sessionGen, terminal-pane.ts:529) already marks 'a new session life' — key the remote-ready mark to it so any respawn invalidates it.  
  Note: Unchanged. The delta touched terminal-pane.ts (gen stamping, OSC 52 grace, measured dims) but never the readiness-latch lifecycle. High stands: this is the credential-eating path.

- **[still-open · high] F2 — Stale ready-OSC in restored scrollback defeats the auth gate on daemon cold start**  
  Now at: `src/pty-daemon/session.ts:480 (seed); :901 (snapshot)`  
  Evidence: `this.buffer = trimTornStart(restore.scrollback) + RESTORE_MODE_RESET` (:480); RESTORE_MODE_RESET (pane-shared.ts:61) is DEC-mode grounding only, no OSC scrub. snapshot still emits `scrollback: this.buffer` (:901); session-rows.ts:64 persists a raw 100k slice. Replay rides onData (transport.ts:187,206); probe latches at terminal-pane.ts:327-337; restore suppresses the reattach mark (:547).  
  Recommendation: Better fix now in-tree: copy the replay scrub at daemon-client.ts:534 (OSC 52 stripped on reset replay) plus the pane's replayCopyGraceUntil grace (terminal-pane.ts:558) — strip REMOTE_READY_OSC at snapshot/seed and ignore it inside the replay window.  
  Note: Slightly likelier now: a cold-start restore spawns at the persisted grid and the resume is deferred until dims are confirmed (deferLaunch/confirmDims) — it fires exactly when the replay lands, ssh still at the prompt.

- **[still-open · medium] F3 — Windows-platform SSH hosts are confirmable in Settings but unspawnable everywhere**  
  Now at: `src/main/daemon-relay.ts:386`  
  Evidence: Spawn still refuses non-posix: `raw.platform !== 'posix' || !row || row.platform !== 'posix'` (:386); validator still `if (r.platform !== 'posix') return null` (remote.ts:72). Settings unchanged: `new Option('Windows','windows')` (profiles-hosts.ts:406), shells :414. Wizard filters (wizard/index.ts:1530); specs force posix (session.ts:1257), so session.ts:60-66 is dead.  
  Recommendation: As originally recommended. Note remote-smoke.ts:658 still asserts the Windows command dialect, so keep the dialect builder even if the host option is dropped from Settings.  
  Note: Kept at the prior verifier's corrected medium: a dead-end option in Settings plus a hidden wizard entry, not data loss. No delta work touched remotes.ts or profiles-hosts.ts.

- **[still-open · medium] F4 — ConPTY may swallow the readiness OSC on some Windows builds; smoke hides it**  
  Now at: `src/main/smokes/remote-smoke.ts:88-90, 278-283`  
  Evidence: Comment verbatim unchanged: 'ConPTY does not preserve private OSCs consistently across Windows builds' (:88-90). Marker still injected renderer-side, bypassing the daemon PTY: `wc.send(TerminalChannels.data, { id: base + 2, data })` (:281); `readinessGateOk = authPromptGuardOk && readySeen && !!remoteAgentWrite` (:287). Wait still unbounded (agents/index.ts:448).  
  Recommendation: Reuse the new ctxStep machinery: type `node -e` writing REMOTE_READY_OSC through the shimmed pane and assert agents.remoteReady flips from THAT, not wc.send. Separately bound the wait at agents/index.ts:448 with an explicit 'launch now' confirm.  
  Note: HEAD's ctxStep arms (remote-smoke.ts:395-430) do push private OSC 633 through the real ConPTY pty on Windows — partial counter-evidence — but that is the daemon parser, not xterm; OSC 777 is still never exercised end-to-end.

- **[still-open · medium] F5 — Editing a referenced host's identity silently kills its live SSH session**  
  Now at: `src/main/remotes.ts:79-85; src/pty-daemon/session.ts:1185`  
  Evidence: remotes.ts and profiles-hosts.ts unchanged since baseline (empty diff). Save is sanitizeRemote + quota check then `getSettingsStore()?.saveRemote(remote)` (:79-85) — no referencedBy check; only remove() has one (:90-99). Daemon: `if (existing?.matchesRemote(normalizedSpec.remote))` (:1185) over host/user/port/platform (:806-815); mismatch hits `this.remove(id)` (:1187).  
  Recommendation: As originally recommended. Drive the Settings warning off matchesRemote's exact field set (session.ts:806-815) so the warning trigger and the kill trigger cannot drift apart.  
  Note: Aggravated by the delta: after the forced respawn the resume is typed by the daemon's deferred launch (deferLaunch/LAUNCH_DIMS_GRACE_MS) into a FRESH ssh, so a port edit can also type into the new auth prompt.

- **[still-open · low] F6 — Bootstrap size budget asserted pre-quoting; Windows limit applies post-quoting**  
  Now at: `scripts/remote-bootstrap-pure-smoke.ts:82`  
  Evidence: File unchanged since c026463 (empty diff). Still raw-length only: `assert(bootstrap.length < 30_000, ...)` (:82); gate mirror `bootstrap.length < 30_000 &&` (remote-smoke.ts:134). No quoting model in either smoke. The cited ceiling is still documented at session.ts:508-510 ('Real ssh.exe is spawned directly (CreateProcess, 32 KB)').  
  Recommendation: As originally recommended. Cheaper addition: remote-smoke already reads the shim's verbatim argv file (remote-smoke.ts:305-320) — assert its captured byte length there to pin the real post-quoting size on the actual Windows runner.  
  Note: Latent, not live (~10 KB bootstrap). ConPTY v2 / the vendored node-pty 1.25 pin change neither CreateProcess's 32,767-char limit nor node-pty's backslash-escaping of embedded quotes.

### browser-dock

- **[still-open · high] F2 — No possession grace beat: driving clears the instant each verb finishes**  
  Now at: `src/main/browser-dock.ts:551`  
  Evidence: finish() (547-555) still synchronous: `s.driving = s.activeOperations.size > 0; if (!s.driving) s.lastVerb = null`. grep setTimeout in browser-dock.ts hits only 98/661/786/944, none in this path; grep '1500|grace' returns nothing, yet the helper comment at 559-561 still claims a '1.5 s auto-reset'. Renderer hides instantly: index.ts:1467 `banner.hidden = !a.driving`.  
  Recommendation: As originally recommended (~1.5s timer in finish(), cancelled by a new op, agentStop immediate). Also fix the false comment at browser-dock.ts:559-561. Assert via a real agentAct, not setDrivingForSmoke, which bypasses the path under test.  
  Note: High stands: the Stop button lives inside the strobing banner, so the user's only revocation control is unhittable during a verb sequence. The 559-561 comment actively misleads readers into thinking the grace beat exists.

- **[still-open · medium] F1 — Crash overlay is dead: webview 'crashed' event does not exist in Electron 39**  
  Now at: `src/ui/features/browser/index.ts:421`  
  Evidence: Unchanged: `wv.addEventListener('crashed', () => { if (isActiveGuest(wv)) showCrash() })`. I enumerated every addEventListener overload on `interface WebviewTag` in the installed electron 39.8.10 d.ts: 'render-process-gone' is there, 'crashed' is not. grep showCrash = only the dead listener (422) + its definition (837). No main-side forwarding exists.  
  Recommendation: As originally recommended: use 'render-process-gone' filtered on reason !== 'clean-exit'. Extend the existing errorVisible arm (smokes/browserux-smoke.ts:220) with forcefullyCrashRenderer() so a regression fails the gate.  
  Note: Held at the prior verifier's corrected medium (orig HIGH): a crashed guest is a white rectangle with no Retry, but manual Reload recovers. Zero browser files appear in git diff --name-only c026463..HEAD.

- **[still-open · medium] F3 — did-attach-webview front-run hardening never installs: winGetter() is null at registration**  
  Now at: `src/main/browser-dock.ts:959`  
  Evidence: Unchanged `const host = winGetter()` + `host?.webContents.on('did-attach-webview', ...)`. Boot order re-confirmed at HEAD: `let win = null` (boot.ts:117), registerBrowserDock(() => win) (boot.ts:330), openWindow() — the only assignment — at boot.ts:368. Host is null, optional chain short-circuits. Only surviving harden path is the renderer dom-ready IPC (index.ts:367-370).  
  Recommendation: Better than original: app.on('web-contents-created', wc => { if (wc.getType()==='webview') hardenSession(wc.session) }); delete 959-962. Window-agnostic, survives macOS recreation (boot.ts:201/420), fires earlier; hardenSession is already idempotent.  
  Note: Medium stands. Defense-in-depth, but the attach→dom-ready gap it was meant to close is exactly what docs/13:130-134 promises is closed, and Electron grants permission requests by default with no handler set.

- **[still-open · medium] F4 — Agent-attached possession dot and LRU pin never expire without a new possession push**  
  Now at: `src/main/browser-dock.ts:512`  
  Evidence: pushPossession (512-524) still derives attached lazily at line 522 via agentAttached (157, AGENT_ATTACH_MS 5min at 58); its only callers are beginDriving/finish/setDrivingForSmoke/agentStop — no expiry timer. s.pane is cleared ONLY in agentStop (587), never in finish() (547-555). Renderer mirrors the last push: index.ts:987-989, and pinnedWs is the LRU exemption at index.ts:494.  
  Recommendation: As originally recommended: schedule a setTimeout at lastAgentAct + AGENT_ATTACH_MS in beginDriving that re-calls pushPossession, and clear s.pane in finish() once the window lapses. One per-workspace timer can serve this and F2's grace beat.  
  Note: Medium stands. Two stale states persist: a tab dot claiming a departed driver, and permanent exemption from the GUEST_CAP=3 LRU (index.ts:308,491-497) — so a lapsed attach pins two live guests, a perf cost atop the honesty cost.

- **[still-open · medium] F6 — Unbounded page-driven tab/popup creation can spawn unlimited guest processes**  
  Now at: `src/ui/features/browser/index.ts:533`  
  Evidence: newTab (533-542) caps nothing and appends a fresh <webview> via ensureTabGuest. Page-reachable: main forwards every non-popup window.open (browser-dock.ts:296-303) to index.ts:606-610, which calls newTab unchecked. The only cap, GUEST_CAP=3 (index.ts:308, 491), is an LRU over WORKSPACES not tabs, and skips pinned ones (494). Popups still `action: 'allow'` uncapped (browser-dock.ts:251-263).  
  Recommendation: As originally recommended: cap tabs per (workspace, profile) inside newTab (index.ts:533, e.g. 12) with a toast on overflow, and cap child windows per guest in guestWindowOpenHandler. Cap in newTab so tab_new and the '+' button (index.ts:600) share the guard.  
  Note: Medium stands. Electron ships no popup blocker, so a hostile/buggy page in any live guest can loop window.open into unbounded renderers, blowing docs/05 budgets. F4 worsens it: a stale pin keeps such a workspace resident forever.

- **[still-open · low] F5 — Promised tab-strip/header favicons can never load: renderer CSP blocks remote images**  
  Now at: `src/ui/features/browser/index.ts:578`  
  Evidence: Both sites unchanged, both set a page-reported remote URL on an <img> in the trusted document: tab strip `img.src = t.favicon` (578) with globe fallback (580), header `img.src = fav` (814) with lock fallback (816). Blocked by `img-src 'self' data:` in RENDERER_CSP at src/main/window.ts:16, re-issued as a header on app main-frames (window.ts:43-52).  
  Recommendation: Do NOT widen the CSP — window.ts:16 is pinned byte-for-byte by the LOCKDOWN smoke. Fetch favicons in main on the guest partition and forward data: URLs, or drop the docs/13:78-79,103 promise. Either way make faviconCaptured assert naturalWidth > 0.  
  Note: Low stands, but it is a gate-honesty instance: index.ts:1596-1597 faviconSrc/faviconCaptured read strings, never a decoded image, so browserux-smoke.ts:120/220 goes green while a rendered favicon is impossible.

### usage-metering

- **[still-open · high] F1 — macOS Keychain read speculatively at boot (ADR 0007 / parity violation)**  
  Now at: `src/backend/features/usage/claude-adapter.ts:250`  
  Evidence: Unchanged: `if ((await readKeychain()) !== null) return { ok: true }` in detect()'s darwin branch; readKeychain still shells `security find-generic-password` (31-40). Boot chain intact: boot.ts:366 -> usage.ts:335 -> index.ts:296-298 `schedule(a, Math.min(base, 1500))`; visible=true (162); claude is klass cli-store so isEnabled=true (179-184); poll calls detect (237).  
  Recommendation: as originally recommended — one-time darwin latch so detect() uses only the .credentials.json check until an explicit refresh/popover open  
  Note: Zero changes to claude-adapter.ts or the boot schedule in the delta; ADR 0007:52-54 still says 'never speculatively at boot'. Severity held per prior verifier: high if the macOS ACL prompts, else medium.

- **[still-open · medium] F2 — Gauge auto/merged pick ranks plans by windows[0] only, missing hotter weekly lanes**  
  Now at: `src/ui/features/usage/index.ts:128`  
  Evidence: auto: `if (u.length) return u.slice().sort((a, b) => (b.windows[0]?.usedPct ?? 0) - (a.windows[0]?.usedPct ?? 0))[0]` (128); tie-break repeats it at 111 (`severityRank(a) - severityRank(b) || (b.windows[0]?.usedPct ?? 0) - ...`). Badge still scans all windows: `badge.hidden = !p.windows.some((x) => x.usedPct >= BADGE_PCT)` (219). worstPct rule still at thresholds.ts:106.  
  Recommendation: as originally recommended — rank by Math.max over windows usedPct at both index.ts:111 and index.ts:128, reusing thresholds.ts:106  
  Note: Merged mode is partly insulated: severityRank reads p.pace, which toView derives from the worst window (usage.ts:137-157), so windows[0] only breaks ties there. The auto path at :128 is fully exposed.

- **[still-open · medium] F3 — `mogging usage providers` reports disabled-by-default rows as enabled**  
  Now at: `src/main/usage.ts:549`  
  Evidence: cliProviders still: `enabled: kv?.getSetting(`usage.enabled.${a.id}`) !== '0',` (549). The class-aware statusEnabled (192-198: api-key/cloud-cli/web-session off with no stored setting) is already used by configGet in the same file — `enabled: statusEnabled(id), // the seam's rule, verbatim` (420) — and matches the poller's isEnabled (backend/features/usage/index.ts:179-184).  
  Recommendation: as originally recommended — substitute statusEnabled(a.id) at usage.ts:549  
  Note: Unchanged. The correct rule now sits 130 lines above in the same file (usage.ts:420), making 549 an isolated one-line inconsistency.

- **[still-open · medium] F4 — Live price fetch retries on every cost scan once stale, breaking the at-most-daily bound**  
  Now at: `src/main/usage-prices.ts:69`  
  Evidence: Gates only on a successful cache: `if (this.cached && this.now() - this.cached.at < PRICES_TTL_MS) return` (69); failures still `.catch(() => undefined)` (78), empty parse bails before caching (72). Class holds only `cached`/`fetching` (38-39) — no lastAttemptAt, and `fetching` blocks only concurrent retries. current() always calls refresh() (50), reached per provider per scan at usage.ts:514.  
  Recommendation: as originally recommended — persist lastAttemptAt beside the cache under KV_KEY 'usage.prices.modelsdev' and gate refresh() on a negative-result TTL so restarts do not reset the bound  
  Note: Unchanged; FETCH_TIMEOUT_MS still 8000 (usage-prices.ts:37), so each repeat costs up to 8s on a blocked machine.

- **[still-open · low] F5 — Outage relabel mutes plan-level pace but per-window verdict lines still render**  
  Now at: `src/main/usage.ts:260`  
  Evidence: enrich() still strips only the plan pace: `...(relabeled !== p && view.pace ? { ...view, pace: undefined } : view),` (260); the windows map below rewrites only resetText (261-266), so each per-window PaceView toView attached (`return { ...w, pace: view }`, 155) survives. Popover renders them unconditionally: `if (w.pace) row.append(...)` (ui/features/usage/index.ts:631-640).  
  Recommendation: as originally recommended — in the outage branch at usage.ts:260 also map windows to `{ ...w, pace: undefined }`  
  Note: Unchanged.

- **[still-open · low] F6 — setKey/clearKey accept arbitrary provider ids, storing orphan ciphertext on a typo**  
  Now at: `src/main/usage.ts:448`  
  Evidence: keySet validates type only: `if (!p || typeof p.providerId !== 'string') return { ok: false, reason: 'bad request' }` (449), then writes usage.enabled=1 (457); keyClear (461-462) and webReadSet (469-471) are equally id-agnostic. CLI setKey checks only `!provider || !value` (89). configurable() (432-433) is applied ONLY at configSet (436); keySetPlaintext (usage-keys.ts:33) never checks the id.  
  Recommendation: as originally recommended — apply configurable(id) at usage.ts:449 (IPC keySet), :88 (CLI setKey), :462 (keyClear) and :470 (webReadSet), returning { ok: false, reason: 'unknown provider id' }  
  Note: Unchanged. Custody is fine — the value is still vault-encrypted before rest (usage-keys.ts:33-45) — so this stays an honesty/orphan-state gap, not an ADR 0008/0014 breach.

- **[still-open · low] F7 — `mogging usage refresh` always waits the full 10s when Codex is the freshest source**  
  Now at: `bin/mogging.mjs:383`  
  Evidence: The wait still reads the honest-age field: `const fresh = plans.some((p) => p.fetchedAt >= started)` (383, in the `for (;;)` at 380, 10s cap at 384), while readCodex still stamps the rollout mtime — `fetchedAt: roll.mtime,` (backend/features/usage/classes/cli-store.ts:118) — which precedes `started` by construction. usage.refresh/usage.list expose no attempt counter (usage.ts:78-86).  
  Recommendation: as originally recommended — surface the per-provider counters the service already keeps (s.fetches / s.lastAttempt, backend/features/usage/index.ts:217-218) through usage.refresh or usage.list and wait on those  
  Note: The only bin/mogging.mjs change since c026463 is PROTOCOL_VERSION 10 -> 11 (line 25). Scope re-confirmed: `some` lets any real-fetch provider end the wait, so the stall is limited to Codex-only / all-mtime-stamped setups.

### vault-custody

- **[still-open · medium] F1 — keySetEnvRef reports ok when the settings store is absent (dropped write reads as save)**  
  Now at: `src/main/usage-keys.ts:61`  
  Evidence: Lines 61-64 verbatim: `const kv = getSettingsStore()`; `kv?.setSetting(KV_ENVREF(providerId), envRef)`; `kv?.setSetting(KV_CIPHER(providerId), '')`; `return { ok: true }`. git diff c026463..HEAD on this file is EMPTY; sibling guard still at :45-47. Event-bridge half intact: saveList :54 uses `getSettingsStore()?.setSetting`, saveWebhook returns ok at :133.  
  Recommendation: As originally recommended, plus brain.ts:537. Cheapest form: a shared kvSetOrRefuse(key,value) beside vaultStore (vault.ts:57-72), which already has exactly this null-store refusal, used by all three env-ref slots.  
  Note: Same class also at brain.ts:537-541 (embedKeySetEnvRef); `git show c026463:src/main/brain.ts` proves it predates the delta, so it is an unlisted third instance, not new. Severity unchanged.

- **[still-open · medium] F2 — vaultEncrypt is not exception-safe: a keychain-denied throw escapes the refusal path**  
  Now at: `src/main/vault.ts:41`  
  Evidence: Verbatim: :40 `if (!vaultAvailable()) return null`, :41 `return safeStorage.encryptString(plaintext).toString('base64')` — no try/catch, while vaultDecrypt directly below (:46-52) still wraps decryptString. git diff c026463..HEAD -- src/main/vault.ts is EMPTY.  
  Recommendation: As originally recommended. Better now: put the try/catch inside vaultStore at vault.ts:64 so encrypt+write is one boolean — fixes account.ts:327-328, connections.ts:235/346 and entitlements.ts:383 without touching each caller.  
  Note: Radius widened: vaultEncrypt now also backs the OAuth refresh token + DPoP PEM (account.ts:327-328), grants/clients (connections.ts:235,346) and entitlements (:383). Held MEDIUM: trigger still needs a post-isEncryptionAvailable denial.

- **[still-open · medium] F5 — Credential-wording gate never scans src/main, where user-facing refusal strings live**  
  Now at: `scripts/check-credential-wording.mjs:164`  
  Evidence: Scanned set at :163-167 is still walk(src/ui,'.ts') + walk(docs,'.md') + README.md — no src/main, no bin/. The delta's ONLY change to this file is a +10-line ALLOWED entry at :96-101 pinning the audit doc that reported this very finding; scope untouched. Header comment :32 still asserts the narrow scope.  
  Note: Still a gap, not a breach: the 17 DENIED patterns over src/main+backend+bin give 6 hits, 4 comments and 2 narrowly-true reasons (credential-core.ts:152,178). Held MEDIUM — new main-side OAuth/wizard copy shipped ungated.

- **[still-open · medium] F6 — Vault primitives have zero unit tests; invariants live only in env-gated smokes**  
  Now at: `src/main/vault.ts:57`  
  Evidence: tests/unit still has 34 files and none touch the vault: `grep -rn 'main/vault|service-keys|usage-keys' tests/` returns nothing. Coverage remains the env-gated smokes at scripts/qa-smokes.sh:411 (SECRETFORMS) and :460 (VAULTKEYS), both run with a live settings store and so never reach the null-store branch at vault.ts:68-69.  
  Note: Raised LOW->MEDIUM: the vault KV helpers now also carry the OAuth refresh token and DPoP key (account.ts:327-328,385), grants/clients (connections.ts:235,346) and the entitlements JWT (:383) — session lifecycle rides untested branches.

- **[still-open · low] F3 — Webhook env-ref slot skips the secret-shaped deny-list every other env-ref slot applies**  
  Now at: `src/main/event-bridge.ts:108`  
  Evidence: Line 108 is still the only validation: `if (!/^[A-Z][A-Z0-9_]{2,64}$/.test(ref)) return { ok: false, reason: 'env-ref must be a NAME like N8N_WEBHOOK_URL' }`, then persisted plaintext via :129/:54. event-bridge.ts imports (lines 1-8) contain no redactSecrets at all. usage-keys.ts:60 and brain.ts:534 still run it. An AKIA-prefixed key id still passes.  
  Note: File byte-identical to baseline; no new env-ref slot landed. Stays LOW (needs an all-uppercase secret pasted into the ref field) but grep confirms it is the only custody env-ref slot without redactSecrets.

- **[still-open · low] F4 — Pointer grammar diverges across consumers ({2,40} vs {2,64}); set/clear asymmetric**  
  Now at: `src/main/service-keys.ts:18`  
  Evidence: Grammar split live: {2,64} at service-keys.ts:18, ref matcher :93, event-bridge.ts:108; {2,40} at usage-keys.ts:16, brain.ts:383, profiles.ts:31, contract profiles.ipc.ts:18. Asymmetry live: serviceKeySet strips `${...}` at :46-49, but serviceKeyClear:71 is only `String(nameRaw ?? '').trim()` — set-then-clear via `${NAME}` leaves the ciphertext, and clear returns void.  
  Note: No consolidation in the delta; now 3 sites plus the contract at {2,40} vs 3 at {2,64}. Stays LOW: the silent-clear path needs the accepted ${NAME} form passed to clear and no current UI does that.

### mcp-registration

- **[still-open · high] F1 — Linked-worktree git exclude writes a path git never reads; plan file leaks**  
  Now at: `src/main/tool-plan.ts:171`  
  Evidence: File byte-identical to baseline (git diff c026463..HEAD empty). Line 171 `if (!isAbsolute(gitDir)) gitDir = join(cwd, gitDir)` then 173 `const infoDir = join(gitDir, 'info')` — no commondir step. `grep -rn commondir src/` hits only git/repo.ts:104. Smoke case (d) at toolplan-smoke.ts:206-215 still does a plain `git init -q`, so it can't reach the linked case.  
  Recommendation: Better fix now available: reuse `readGitLayout()` at src/backend/features/git/repo.ts:85-113, which already resolves the gitdir pointer AND `commondir`; append to join(layout.commonDir,'info','exclude'). Add a `git worktree add` fixture to smoke (d).  
  Note: Severity holds. Reinforced: the delta added a linked-worktree preflight feature (tests/unit/worktree-preflight.test.ts), so scoped launches inside .mogging/worktrees/* are more common now, not less.

- **[still-open · medium] F2 — Tool-plan rollback restores files without CAS; can clobber a concurrent edit**  
  Now at: `src/main/tool-plan.ts:108`  
  Evidence: Unchanged. Line 108 is still `await configMutationCoordinator.mutate({ file: prior.path, transform: () => prior.content })` with no expectedHash, while the forward write passes `expectedHash: snapshot.hash` (line 140). The `before` entry pushed at line 137 stores only {path,existed,content} — no hash is kept to CAS on. Catch at 146-149 routes a 'changed-under-us' refusal straight into rollback().  
  Recommendation: As originally recommended: retain the post-write hash on each `before` entry, pass it as expectedHash in rollback, and on CAS refusal skip the restore and log rather than overwrite bytes we did not write.  
  Note: Unchanged. Rollback still takes no backup of its own, so the destroyed external edit is unrecoverable, unlike mcp-manager's ensureBackup path.

- **[still-open · medium] F3 — resolveCliHomes ignores CLAUDE_CONFIG_DIR while honoring Codex/Gemini pointers**  
  Now at: `src/main/mcp-manager.ts:74`  
  Evidence: Unchanged: line 74 `const home = homedir()` feeds the return at 75-79, where only codexDir (77, CODEX_HOME) and geminiDir (78, GEMINI_CONFIG_DIR/GEMINI_CLI_HOME) read pointers. writers/claude.ts:37 still `join(homes.home, '.claude.json')`. Elsewhere CLAUDE_CONFIG_DIR IS the Claude pointer: agent-clis/registry.ts:113, usage/homes.ts:13, agent-settings/sources.ts:213.  
  Recommendation: As originally recommended: add an explicit claudeDir = process.env.CLAUDE_CONFIG_DIR || home (sandbox branch at 67-73 stays authoritative). Also update docs/14's dialect table, which names pointers for Codex/Gemini and none for Claude.  
  Note: Medium holds, with a stronger trigger: the app itself sets this env for profile launches (agents/global-hooks.ts:32, agents/session-pool.ts:13), so apply reports ok into a ~/.claude.json the launched CLI never reads.

- **[still-open · medium] F4 — mcp-manager writes Codex/Gemini configs outside the shared mutation coordinator**  
  Now at: `src/main/mcp-manager.ts:298`  
  Evidence: Both paths bypass the coordinator: mgrApply 297-298 `ensureBackup(file, current)` / `writeAtomic(file, next, current)`; mgrRemoveFrom 362-363 identical. `grep -n configMutationCoordinator src/main/mcp-manager.ts` returns nothing. Window intact: fileMatchesExpected (176) then renameSync (177). Coordinator still says 'All provider writers must share this instance' (mutation-coordinator.ts:72-74).  
  Recommendation: As originally recommended. Note the coordinator also does BOM-preserving decode/encode (mutation-coordinator.ts:54-58, 100), so routing these writes through it closes F5 as well — worth landing as one change.  
  Note: Unchanged. tool-plan.ts:136-145 writes the same files through the coordinator, so two uncoordinated CAS paths on config.toml / settings.json coexist in one process.

- **[still-open · low] F5 — UTF-8 BOM in a CLI config fails registration with a raw JSON parse error**  
  Now at: `src/backend/features/integrations/writers/json-dialect.ts:27`  
  Evidence: Line 27 is still `parsed = JSON.parse(text) as unknown`; the only recovery is the JSONC sentence at 32-35, and a BOM matches neither looksLikeJsonc (line 21) nor any strip, so the raw SyntaxError rethrows. readIfExists (188-195) reads utf8 without stripping, surfacing via mcp-manager.ts:305 'could not update ...'. The coordinator strips at mutation-coordinator.ts:54-58.  
  Recommendation: Prefer the F4 fix (route mcp-manager writes through configMutationCoordinator, which already handles the BOM). If deferred, strip a leading BOM in parseConfig and re-prepend in stringifyConfig.  
  Note: Unchanged Windows-leaning parity gap. Additionally isManagedScopedJson (json-dialect.ts:108-115) returns false on a BOM file, so a BOM also turns a scoped tool-plan launch into a refusal.

- **[still-open · low] F6 — Docs drift: backup keying and boot-time house-entry rewrite undocumented**  
  Now at: `docs/14-integrations.md:478`  
  Evidence: docs/14 changed (+91/-15) but not here: 478 still reads 'backs up once per file per session before its first write'. Code keys by content hash: mcp-manager.ts:110 backedUp map, 114 BACKUP_KEEP=10, 143 `if (backedUp.get(file) === hash) return undefined`. Boot write unconditional: refreshManagedHouseRuntime() at 521 calls mgrApply at 328, vs docs/14:63 'never a write without your click'.  
  Recommendation: As originally recommended: fix docs/14:476-479 to say backups are per distinct content (10 kept), and name refreshManagedHouseRuntime as the single boot-time exception to 'never a write without your click'.  
  Note: Unchanged. The docs/14 rewrite in this delta touched other sections and left both drifts, so this is live drift, not a stale citation.

- **[still-open · low] F7 — Writer splice edge cases have no unit tests, only env-gated smokes**  
  Now at: `src/backend/features/integrations/writers/codex.ts:70`  
  Evidence: tests/unit has 33 files, 11 new since baseline (env-path, spawn-tool, worktree-preflight, ...) — none cover the writers. The only integrations import is provider-catalog.test.ts:10-11 (catalog->preset projection only). Untested invariants still live: keysOrphanedAfter codex.ts:70-77, foreign-table refusal codex.ts:96-98, JSONC refusal json-dialect.ts:32-35.  
  Recommendation: As originally recommended: add tests/unit/mcp-writers.test.ts covering upsert/remove/readCanonical/isManagedScoped for all three dialects (CRLF, blank line in block, foreign twin, JSONC, array mcpServers, BOM) plus applyState and validateServerEntry refusals.  
  Note: Unchanged, but sharper as a gate-honesty concern: F1 shows the toolplan smoke passing on a fixture that structurally cannot reach the broken path — exactly the coarseness this finding predicted.

### mogging-mcp-server

- **[still-open · medium] F2 — Initialize-time grant resolve that loses the 2s race never emits tools/list_changed**  
  Now at: `bin/mogging-mcp.mjs:773`  
  Evidence: Only change to this file since c026463 is PROTOCOL 10->11 (:33). :773 still `await Promise.race([refreshGrant(false), new Promise((r) => setTimeout(r, 2000))]).catch(() => {})` before reply. applyGrantSet :82 still `if (changed && emitChange)`. refreshGrant call sites are only :134 (grantChanged, true) and :773 — nothing else re-emits after initialize.  
  Recommendation: As originally recommended: set a `replied` flag when the initialize response is sent and pass emitChange = replied to the still-running refreshGrant, instead of hardcoding false.  
  Note: Unchanged. handleWriteCall (:686-711) does a live per-call grant re-check so a blind direct call still works; damage is a tools/list that under-reports for the session — exactly what a compliant client obeys.

- **[still-open · medium] F3 — docs/14 Direction 2 stale: 'six writes' vs 'eleven write tools' vs 18 shipped**  
  Now at: `docs/14-integrations.md:193`  
  Evidence: docs/14 gained 91 lines but every hunk is after :214 (both OAuth device-flow). :193 still 'The eleven / **write** tools are the boundary'; :343 still "A grant of `'all'` makes the six writes appear in". Table 171-190 still has no brain/memory rows (grep for replace_symbol_body, create_memory in docs/14 -> nothing). bin/mcp-catalog.json still ships 18 access:'write' of 57 tools.  
  Recommendation: As originally recommended, now cheap to make drift-proof: the catalog is data (src/contracts/integrations/mcp-catalog.json), so generate the Direction 2 write rows from it in the docs check rather than hand-counting in prose at :193 and :343.  
  Note: Second stale sentence moved (baseline :280 -> :343, pushed by the OAuth insert); cited :193 is byte-identical. grant-store.ts:135-137 already states the truth in code, so only the doc hides the on-disk symbol and .memory/ writes.

- **[still-open · low] F1 — Receipt frames honored without grant check: trail entries and pings forgeable**  
  Now at: `src/main/mcp-endpoint.ts:451`  
  Evidence: File untouched since baseline (git log c026463..HEAD -- src/main/mcp-endpoint.ts is empty). :450-452 still `if (msg.t === 'receipt') { if (boundPane) handleReceipt(...) }`. handleReceipt :238 still uses `resolveGrantedWriteTools(by).workspaceId ?? ''` only for the trail row, never `.writeTools.includes(tool)` as a gate; targetPane still from `msg.pane` (:229) driving notify (:234).  
  Recommendation: Better than gating inside handleReceipt: board/brain writes already pass through this endpoint's own handlers (:246+), so record trail/attention there. For daemon-dispatched writes, gate on resolveGrantedWriteTools(boundPane).writeTools.  
  Note: Holds at the prior verifier's LOW, not the original HIGH: `by` is server-derived after verifyPaneToken (:427-435) and trail.ts:54 drops unattributable rows, so forgery is confined to the forger's own workspace.

- **[still-open · low] F4 — PANE_ID without PANE_TOKEN silently degrades to paneless with a misleading refusal**  
  Now at: `bin/mogging-mcp.mjs:115`  
  Evidence: connectApp (110-125) still sends `hello: pane && paneToken ? { pane, paneToken } : {}` at :115, so PANE_ID alone yields a paneless hello and grant.get returns []. handleWriteCall still branches on paneIdentity() alone (:687) and refuses at :704-708 with '"<tool>" requires the workspace integrations grant — write tools are OFF for this workspace (default)' — the missing pane token is never named.  
  Recommendation: As originally recommended: when paneIdentity() is set but MOGGING_PANE_TOKEN is absent, word both refreshGrant's empty set and the handleWriteCall refusal to name the missing pane token rather than the workspace grant.  
  Note: Unchanged; fail-closed is still correct, only the diagnostic misdirects. One-click agent setup + live PATH landed this window, making hand-launched MCP processes marginally more likely, but not enough to raise severity.

- **[still-open · low] F5 — Status poller visibility is one global flag flipped by any window's hide/minimize**  
  Now at: `src/main/mcp-status.ts:119`  
  Evidence: No commits touch this file since c026463. :119-124 still `app.on('browser-window-created', (_e, w) => { w.on('hide', () => setStatusVisible(false)); w.on('minimize', () => setStatusVisible(false)); w.on('show', ...true); w.on('restore', ...true) })`. winGetter is captured at :116 but never compared to the event window; `visible` stays a module-level boolean read at :110.  
  Recommendation: As originally recommended, and the ingredient is already there: winGetter is stored at :116, so gate the handlers with `if (w !== winGetter?.()) return`, or count visible windows instead of a boolean.  
  Note: Unchanged. Added angle: minimize/restore event ordering differs between Windows and macOS, so a last-writer-wins flag fed by every window is also a latent platform-divergence source, not just a stale-status bug.

- **[still-open · low] F6 — No unit tests for grant store or server-side catalog/arg validation**  
  Now at: `src/backend/features/integrations/grant-store.ts:139`  
  Evidence: grantedWriteToolNames still at :139 (file untouched), readGrant migration :95-107, clearGrant :123-132, argsProblem at bin/mogging-mcp.mjs:229-241. tests/unit holds 34 files; grep for grantedWriteToolNames|argsProblem|readGrant|clearGrant across tests/ matches nothing. Receipt coverage is smoke-only and positive-only (mcpwrite-smoke.ts:205-220, integmilestone-smoke.ts:305-315).  
  Recommendation: As originally recommended: unit-test grantedWriteToolNames filtering, readGrant migration + clearGrant reuse-safety over a fake GrantKv, and argsProblem's branches; add the negative smoke that an ungranted receipt records nothing.  
  Note: Unchanged in substance, sharper after the delta: F1's path is the only defense-relevant one here with zero coverage either way, and the shared-defaults tier (ADR 0022) raises the odds of a grant sanitization regression.

### event-bridge

- **[moved-still-open · high] F1 — `mogging notify --message` never fires the `notify` bridge event in production**  
  Now at: `src/pty-daemon/transport.ts:231`  
  Evidence: Shifted 223->231 by v11 edits, defect intact: `target?.applyNotify(m.event)` drops m.message though protocol.ts:283 carries it. session.ts:928 feeds only the tracker. daemon-relay.ts:161 -> event-bridge.ts:224 emits 'needs-you' only. Grep emitBridgeEvent: production = board.ts:305, services.ts:59, :224, :242 (Test). Every 'notify' emit is a smoke.  
  Recommendation: As originally recommended, and cheaper than assumed: the notify frame already carries `message?` (protocol.ts:283). Only the relay push and a paneHasAgent-gated emitBridgeEvent('notify', { workspace, pane, note }) are missing.  
  Note: transport/session changed only for gen-gating and remote cwd; event-bridge.ts is byte-identical to c026463. docs/14:470-471 still promises notify 'rings the flow' and the Test button still makes it look wired.

- **[still-open · medium] F2 — env-ref webhook URLs bypass the URL-safety policy entirely at delivery**  
  Now at: `src/main/event-bridge.ts:169`  
  Evidence: emitBridgeEvent:169 `const url = resolveUrl(w.id)` -> :179 `deliverWebhook(url, payload, ...)`, no policy check. resolveUrl:80 returns `process.env[w.envRef] ?? null` raw. urlAllowed has exactly two hits in src/: its definition (bridge.ts:62) and the pasted-URL save branch (event-bridge.ts:112). The env-ref branch (:106-110) only regex-tests the NAME.  
  Recommendation: As originally recommended, with one nuance: check the freshly resolved value inside the queued task, not at enqueue (env can change), and reuse the trail shape at :188 (source 'bridge', outcome 'refused', label only).  
  Note: File unchanged since baseline. No new gate covers it: evbridge-smoke.ts configures only pasted URLs (lines 43/55/93), never an env-ref, so a further regression here fails nothing.

- **[still-open · medium] F3 — Vault-held webhook URL is decrypted on every list render and health repaint**  
  Now at: `src/main/event-bridge.ts:60`  
  Evidence: urlMask:58-67 still calls `const url = resolveUrl(w.id)` just to compute `${new URL(url).host}/...`; resolveUrl:81 returns `vaultLoad(KV_URLCIPHER(id))`, and vault.ts:76-79 does a real `vaultDecrypt(cipher)`, not a cached read. views():72-73 maps every webhook through urlMask on the webhookList IPC (:237) and on pushViews (:147), which fires after every delivery (:190).  
  Recommendation: As originally recommended: persist a non-secret `host` on StoredWebhook at the single write point (:129) and build urlMask from it. Add a backfill for rows saved before the field existed (decrypt once, then store).  
  Note: Unchanged since baseline. Still contradicts the file's own doctrine at :76 ('Resolve the URL for delivery ONLY'). Held at medium: custody hygiene plus syscall load, not a leak.

- **[still-open · medium] F4 — Pure delivery engine has zero unit tests - backoff, 4xx no-retry, URL classes untested**  
  Now at: `src/backend/features/integrations/bridge.ts:80`  
  Evidence: deliverWebhook:80-92 still takes fetchFn/sleep/maxAttempts for injection. grep -rl for deliverWebhook|classifyWebhookUrl|urlAllowed|buildBridgeEvent|webhookReceives across tests/ returns zero files; tests/unit holds 34 files, none for bridge/webhook. Untested: 4xx early return :109, 200*2**i backoff :114, RFC1918/link-local/.local table :48-59.  
  Recommendation: As originally recommended, plus one new case: evbridge-smoke.ts:93 saves http://192.0.2.1/hook (TEST-NET-1, not RFC1918) so classifyWebhookUrl returns 'invalid' and that save is refused - a classify table test would expose that dead leg.  
  Note: bridge.ts is byte-identical to baseline; the delta added no tests here.

- **[still-open · low] F5 — Bridge's lastState never cleared on pane exit - reused pane id can swallow needs-you**  
  Now at: `src/main/event-bridge.ts:209`  
  Evidence: `const lastState = new Map<number, string>()` at :209 is written only by onPaneStateForBridge:214 - no delete anywhere in the file. daemon-relay.ts onExit:148-155 clears specs, lastStates, livePaneIds, cwdRevisions and calls `notePaneGone(Number(id))` (:154) but never touches the bridge map. Id reuse is explicit at daemon-relay.ts:109 ('a split takes the lowest free slot').  
  Recommendation: As originally recommended, plus a gate fix: export paneGoneForBridge(paneId), call it beside notePaneGone at daemon-relay.ts:154, and drop the 'idle' at attention-smoke.ts:570 so a latched id reused by a new agent pane must still emit.  
  Note: Unchanged since baseline. The gate that looks like it covers this does not: attention-smoke.ts:569-571 calls notePaneGone(1) then feeds 'idle' BEFORE 'attention', so the intervening idle resets prev and the latch case is never exercised.

- **[still-open · low] F6 — Test button sends first-checked event with a fabricated shape, not the documented notify**  
  Now at: `src/main/event-bridge.ts:242`  
  Evidence: `if (w) emitBridgeEvent(w.events[0] ?? 'notify', { workspace: w.workspaceId ?? 'test', note: 'Test event from MoggingLabs Workspace' })` - unchanged. A card-moved-only webhook gets event 'card-moved' carrying `note`, a field production card-moved never sends (board.ts:305 emits `{ workspace, card }` only), and with no `card` field, which production always sends.  
  Recommendation: Prefer the docs-matching option: always emit 'notify' from webhookTest (docs/14:468-469 promises exactly that) and use w.workspaceId instead of the invented 'test' id; buildBridgeEvent already tolerates the minimal shape.  
  Note: Unchanged since baseline. Sharper than first written up: the test payload not only adds `note`, it OMITS `card`, so a flow pinned to the test run breaks on the first real card-moved rather than just seeing an extra field.

### service-adapters-github

- **[still-open · high] F1 — Merge/close/review while the app is closed never fires notify or board rules**  
  Now at: `src/backend/features/integrations/services/engine.ts:163`  
  Evidence: Still `if (!prev) return null // first fetch is not a transition`. No status persisted: saveLinks writes only links (services.ts:35-37), boot is `engine.setLinks(loadLinks())` (services.ts:135), addLink seeds `{ link, backoff: 0 }` (engine.ts:70), ServiceLink has no lastState field (contracts/integrations/services.ts:27-36). Post-restart prev is undefined.  
  Recommendation: As originally recommended — persist lastState+lastReviewDecision in KV_LINKS and seed LinkRuntime.status at engine.ts:70; no change to transitionLabel needed.  
  Note: Untouched by the delta (no diff in engine.ts/services.ts since c026463); severity unchanged.

- **[still-open · medium] F2 — No in-flight guard: concurrent ticks duplicate gh fetches and can double-fire transitions**  
  Now at: `src/backend/features/integrations/services/engine.ts:114`  
  Evidence: LinkRuntime is still `{ link, status?, timer?, backoff }` (engine.ts:19-24) — no inFlight flag. `refresh(linkId) { void this.tick(linkId) }` (engine.ts:86-88) and tick (103-112) never clear the pending timer before awaiting; the clear is in reschedule (96) after the fetch resolves. fetchOnce still captures `const prev = rt.status` at entry (116), so both calls compute the same label (142).  
  Recommendation: Add `inFlight` to LinkRuntime, early-return in tick when set; also drop the redundant `engine.refresh(...)` after `engine.setLinks(...)` at services.ts:87-88 and 108-109.  
  Note: Related duplicate: linkCardDirect/setLink call setLinks then refresh (services.ts:87-88, 108-109) and setLinks→addLink already ticks, so every new link fires two concurrent first fetches.

- **[still-open · medium] F3 — A throw from the notify/rules sink corrupts a fresh status to stale and inflates backoff**  
  Now at: `src/backend/features/integrations/services/engine.ts:142`  
  Evidence: `if (label) this.deps.onTransition(rt.link, label)` is still the last statement inside fetchOnce's try (130-142); the catch (143-149) doubles backoff and overwrites the fresh status with `{ ...prev, health: 'stale', reason }`. services.ts:55-64 still calls getCard, notify, emitBridgeEvent and transitionRules?.() with no try/catch, despite its comment at services.ts:61.  
  Recommendation: Move the onTransition call below fetchOnce's try/catch/finally so rt.status is settled first, AND wrap the body of services.ts onTransition in try/catch so its own comment at services.ts:61 becomes true.  
  Note: Evidence correction: applyCardPatch returns `{ ok:false, reason:'invalid' }` on a missing store (board.ts:232-233); the auditor cited ensureBoardForKey's throw (board.ts:98). The structural defect stands.

- **[still-open · medium] F4 — Unbounded concurrent gh spawns at boot/import; detect spawns `gh --version` every fetch**  
  Now at: `src/backend/features/integrations/services/github.ts:58`  
  Evidence: detect() is uncached — `execFile(GH, ['--version'], { timeout: 4000, windowsHide: true }, ...)` (github.ts:58-60) — and fetchOnce awaits it every tick (engine.ts:122) before the `gh pr view` at github.ts:82. Boot still fans out with no pool: services.ts:135 → addLink → `void this.tick(link.id)` per link (engine.ts:71). ghImport still mints up to 50 cards (github-board.ts:92).  
  Recommendation: Cache detect() behind a ~5min TTL in createGitHubAdapter (module-local `{ at, result }` in github.ts), stagger initial ticks in addLink with the existing jitter, and remove the duplicate refresh noted in F2.  
  Note: Import burst is worse than scored: linkCardDirect ticks twice per card (setLinks+refresh, services.ts:87-88) × 2 spawns = ~4N, so a 50-issue import can burst ~200 gh processes. Still medium (perf/rate, not correctness).

- **[still-open · medium] F5 — Links on archived/Done cards poll gh forever; no retirement path except manual unlink**  
  Now at: `src/main/services.ts:113`  
  Evidence: removeLink (services.ts:113-118) is reachable only from the linkRemove IPC (services.ts:139) and the renderer unlink button (ui/features/board/index.ts:70); grep for removeLink/retireLink finds no archive caller. autoArchive (board.ts:396-412) stamps archivedAt, touches no link. applyTransitionRules skips archived cards (github-board.ts:215) while cadence timers stay alive (engine.ts:93-101).  
  Recommendation: As originally recommended — export retireLinkForCard(cardId) and call it from the archive patch path (board.ts:290) and autoArchive (board.ts:407), re-adding on restore. Interim: skip scheduling in reschedule for archived cards.  
  Note: Unchanged since baseline. The asymmetry is explicit in code: github-board.ts:215 knows an archived card is inert, yet the engine feeding it is never told.

- **[still-open · medium] F6 — Fixture 'fake' adapter ships registered in the production engine, selectable over IPC**  
  Now at: `src/main/services.ts:123`  
  Evidence: `adapters: { github: createGitHubAdapter(), fake: createFakeAdapter() }` (services.ts:123) is still unconditional — no harness/env gate. setLink still trusts the renderer: `service: p?.service ?? 'github'` (services.ts:105), with the linkSet IPC passing the raw payload through (services.ts:138). createFakeAdapter still returns fabricated 'approved'/'merged' fixtures (fake.ts:10-20).  
  Recommendation: Gate the fake registration on boardGhWorld() the way linkService already is (github-board.ts:53), and reject unknown service ids in setLink before services.ts:105. Also fix the now-false comment at contracts/integrations/services.ts:29.  
  Note: The gate exists for board-minted links only — github-board.ts:53 `linkService = () => boardGhWorld()?.linkService ?? 'github'`, armed only by boardgh-smoke.ts:53 — so the pattern is present but unapplied to the engine registry and setLink.

- **[still-open · low] F7 — Rate-limited first fetch claims 'showing last good' when no last good exists**  
  Now at: `src/backend/features/integrations/services/github.ts:112`  
  Evidence: ghReason still returns the stale-implying copy unconditionally: `if (/rate limit|api rate/.test(s)) return 'GitHub rate limit — showing last good'` (github.ts:112). The engine's no-prev branch forwards it as an error: `{ linkId: rt.link.id, health: 'error', fetchedAt: Date.now(), reason }` (engine.ts:149), so a first-ever rate-limited fetch asserts a re-serve that never happened.  
  Recommendation: As originally recommended — return 'GitHub rate limit — try again shortly' from github.ts:112 and let the engine's stale branch (engine.ts:148), which alone knows prev exists, own the 'showing last good' phrasing.  
  Note: Line shifted 113→112 (github.ts is byte-identical to baseline; the original cite was one line off). Same defect, same function; severity unchanged.

- **[still-open · low] F8 — The transition-to-notify wiring in main has no gate: smokes bypass services.onTransition**  
  Now at: `src/main/services.ts:55`  
  Evidence: services.ts onTransition (55-64) is still called only by the engine built in registerServices (services.ts:125); no smoke reaches it. boardgh-smoke.ts:189 and :197 still call `githubBoardDebug.applyTransitionRules(...)` directly, skipping the card lookup, paneId notify and review-changed emission; integ-smoke.ts:30-32 and :80 still build standalone engines with stub onTransition callbacks.  
  Recommendation: Better than the original: export `servicesDebug = { onTransition }` (mirroring githubBoardDebug, github-board.ts:243) and pass it as the engine's onTransition at integmilestone-smoke.ts:424 — the existing assertions then gate the real glue, no new fixture.  
  Note: Auditor missed integmilestone-smoke.ts:419-441 (f), which asserts pane attention + review-changed — but its onTransition at :424-429 is a hand-copied duplicate of services.ts:56-59, so the real sink still never runs and can drift silently.

### connections-oauth

- **[still-open · high] F1 — Offline heartbeat demotes valid grants to 'expired', rings attention, never rejoins sweep**  
  Now at: `src/main/connections.ts:1402`  
  Evidence: verifyOne:1402 `if (!token && meta.authKind !== 'local')` still records 'unauthorized' + `state: 'expired'` (1406-1414). doRefresh:1185 still writes `state: 'expired'` on ANY failure; 1153 writes 'error' when offline discovery fails. Sweep still `.filter((c) => c.state === 'connected')` (1557). The c026463..HEAD diff touches only the device-flow and cancelConnect hunks.  
  Recommendation: As originally recommended. Also classify doRefresh's discovery-failure branch (1152-1155) with isNetworkDownMessage (reachability.ts:40) — it is the more common offline path and currently writes 'error'.  
  Note: Unchanged severity. The delta shipped the device route, so more cards rest on app-held grants. RefreshCoordinator (credential-core.ts:123-185) has no offline branch either.

- **[still-open · medium] F2 — Concurrent connect() race: superseded flow leaks server; stale timer kills live flow**  
  Now at: `src/main/connections.ts:500`  
  Evidence: abandonFlow() still at 405; `pending = {...}` still at 500, now behind four awaits (418 discover, 463 beginDeviceFlow, 478 startLoopback, 484 resolveClient), overwriting with no re-check and no close of the loser's loop.server. Timer still identity-blind: `setTimeout(() => { setState(...'error'); endFlow() }, 5*60_000)` (512-515); endFlow (275-284) acts on whatever `pending` is.  
  Note: Same severity, wider window: the device branch (453-474) adds another await before line 500, and a rival flow can now sit in the separate pendingDevice slot (568) — new A-device/B-code interleavings on the same seam.

- **[still-open · medium] F4 — Main-side flow lifecycle (supersede, timer, cancel ordering) has no automated coverage**  
  Now at: `src/main/connections.ts:254`  
  Evidence: PendingFlow (254-268), connect (383-530), beginDeviceFlow (540-654), onCallback (656-763): no test drives the interleavings. connections-pure-smoke.ts imports only @backend/@contracts (53,60); new device-flow-pure-smoke.ts likewise (37-38). tests/unit: 34 files, none for connections. Sole main importer: src/main/smokes/connlive-smoke.ts:9, unchanged, one cancelConnect (185).  
  Recommendation: As originally recommended, now larger: extract BOTH slots (pending and pendingDevice) into one Electron-free lifecycle module with injected timer/server/poll effects, and assert cross-shape interleavings (device superseded by code and vice versa).  
  Note: 'Exercised by no test' is slightly overstated — CONNLIVE does call connect/cancelConnect for real. The substantive claim (no coverage of supersede/timer/cancel ordering, where F2/F3 live) holds exactly.

- **[still-open · low] F3 — clearClient mid-flight guard covers code flow but not a device poll at the same issuer**  
  Now at: `src/main/connections.ts:1051`  
  Evidence: clearClient still guards only `if (pending && pending.metadata.issuer === issuer)` (1051-1053). pendingDevice is still `{ serviceId: string; cancelled: boolean } | null` (292) — no issuer — and is never consulted here. The poll (590-651) still commits `userClient: client.source === 'user'` (649). The delta's only edit nearby was cancelConnect's new device branch (1078-1082).  
  Recommendation: As originally recommended; cheapest form: widen the slot at 292 to `{ serviceId; issuer; cancelled }` (metadata.issuer is in hand at 563/572/646) and add `if (pendingDevice?.issuer === issuer) abandonFlow(...)` beside the guard at 1051.  
  Note: Still latent (only github-mcp.json declares a device endpoint), but the delta shipped the device route, so the path is now reachable in production rather than dead code. Low stands.

- **[still-open · low] F5 — Boot sweep demotes interrupted flows without clearing the stale `device` panel from meta**  
  Now at: `src/main/connections.ts:1593`  
  Evidence: Unchanged: `setState(id, { state: 'error', lastError: 'The sign-in was interrupted (the app closed mid-flow). Try again.' })` — no `device: undefined`. Every other demotion clears it: 312, 563, 605-608, 613-617, 1080, and 1090, the last added by this very delta for exactly this reason.  
  Note: More reachable now: `device` (written at 577) never existed before the device route shipped. Still low — the UI renders devicePanel only while 'connecting'.

- **[still-open · low] F6 — Live check's hardcoded GitHub scope list claims to match the app but can drift**  
  Now at: `scripts/device-flow-live-check.ts:42`  
  Evidence: Present as written (whole file is new in this delta, +158). 40-42: comment 'the same list the app asks for' over `const SCOPES = ['repo','read:org','read:user','user:email','gist','workflow']`, used at 76 and at 80 in `requestDeviceCode({ ..., scopes: SCOPES })`. The app still derives scopes at runtime: connections.ts:446 pickScopes(disco.resourceScopes, metadata); pickScopes at oauth.ts:289-296.  
  Note: Severity unchanged. Dev-only manual check (npm run check:device-flow-live), not a gate, so gate-honesty is not implicated — but the comment asserts an equality nothing enforces.

### explorer-files

- **[still-open · high] F2 — Dock closed before first git:filesChange leaks the repo registration; git polls on**  
  Now at: `src/ui/features/explorer/index.ts:584`  
  Evidence: Still `if (gitRoot) gitFilesUnwatch(gitRoot)` (:584), and gitRoot is assigned only in onGitFiles (`gitRoot = e.root`, :401) after main's first spawn (monitor.ts:124). Registration now also happens on the new rearm path (:617) besides :678; closing inside that window leaves the root in fileRoots (monitor.ts:121) with the 2.5s interval alive (monitor.ts:246, :338).  
  Recommendation: Cheaper than proposed: main already resolves cwd->root (monitor.ts:129), so store `gitWatched = nextRoot` beside each gitFilesWatch (:617, :678) and unwatch by it in dropGit. Assert 0 spawns after a fast close plus live decorations after reopen in TREEGIT.  
  Note: Raised from the verifier's medium: it does NOT self-heal. lastFiles clears only in unwatchFiles (monitor.ts:131) and refreshFiles is change-only (:322), so reopen's emit is suppressed, gitRoot stays '' and decorations stay dead all session.

- **[still-open · medium] F1 — setShowHidden clears stale on unwatched dirs, resurrecting ghost listings**  
  Now at: `src/ui/components/file-tree.ts:653 (+trigger :701)`  
  Evidence: Unchanged: `st.stale = false // just re-listed: whatever this held, it is fresh again` (:653) fires for ANY re-listed dir, before the sig check; setShowHidden still feeds all of them: `await applyChanged([...nodes.keys()])` (:701). ensureLoaded still skips a non-stale dir (:174). markUnwatched (:446-448) runs only from toggle (:455) and setExpanded (:680), never after setShowHidden.  
  Recommendation: As originally recommended, now a one-liner: at :653 (and :196) write `st.stale = !(dir === rootPath || expanded.has(dir))`. Add collapse + toggle-hidden + re-expand to TREELIVE.  
  Note: Kept at the prior verifier's medium, not the original high: the ghost survives until the dir is expanded and then changes or Refresh runs (refresh() re-lists root+expandedDirs, index.ts:705). Idle dir = wrong listing indefinitely.

- **[still-open · medium] F3 — Virtualization drops keyboard focus to body when the focused row scrolls out**  
  Now at: `src/ui/components/file-tree.ts:307`  
  Evidence: renderWindow untouched by the delta: after `clear(body)` (:283) the out-of-window branch only moves the tabindex — `if (active < first || active >= first + count) { const firstRow = body.querySelector('.ft-row'); if (firstRow instanceof HTMLElement) firstRow.tabIndex = 0 }` (:307-309); `.focus()` sits only in the else (:310-312). The scroller has no tabIndex (:157) yet owns keydown (:481).  
  Recommendation: As originally recommended: in the out-of-window branch, when hadFocus, call firstRow.focus({ preventScroll: true }) (it already holds tabIndex 0), or give the scroller tabIndex -1 and focus it.  
  Note: Unchanged by the delta; plain wheel-scrolling after clicking a row reaches it, and an APG tree losing focus to body is an accessibility defect.

- **[still-open · medium] F4 — refreshIgnored's ignoreBusy guard silently drops invalidations with no re-run**  
  Now at: `src/ui/features/explorer/index.ts:372`  
  Evidence: Unchanged: `if (!gitRoot || !open || ignoreBusy) return` (:372) is still a bare skip; dirs are snapshotted before the sequential await loop (:373) and ignoreBusy is cleared in the finally (:384) with no re-check. Racing callers lose their work: the batch path after `ignoredByDir.delete(d)` (:335-336), onExpandedChange (:196), onGitFiles (:406), and the new rearm path (:619).  
  Recommendation: As originally recommended (ignorePending flag; after the loop re-run over dirs still missing from ignoredByDir) — one boolean, and it covers the new :619 caller too.  
  Note: Slightly worse post-delta: the reopen rearm at index.ts:619 is a fourth droppable caller, so a reopen during a live pass leaves the restored tree undimmed until an unrelated event.

- **[still-open · medium] F5 — Zero unit tests for the Electron-free explorer core; guarantees ride gated smokes**  
  Now at: `src/backend/features/explorer/watch.ts:34 (no test in tests/unit)`  
  Evidence: watch.ts:34-35 still claims 'Electron-free on purpose... testable without booting an app' (list.ts:24 likewise). The delta added 9 unit files and none import the explorer core: grepping tests/unit for explorer|file-tree|createFileTree|listExplorer|createExplorerWatcher matches only pane-insert.test.ts (the shared insert planner). Coverage remains the gated smokes (qa-smokes.sh:645-646).  
  Recommendation: As originally recommended, plus a createFileTree unit with a stub list asserting the stale invariant across collapse -> setShowHidden -> re-expand (F1) and that a superseded flight releases st.loading (the :191 claim).  
  Note: More pointed post-delta: 5ce4bdc shipped a whole new state machine (stale flag, flight-slot release, rearm door) on smoke coverage alone — F1, F2 and F4 all sit in exactly what a unit would pin.

- **[still-open · low] F6 — Rapid workspace switch mid-load clobbers the interrupted workspace's memory**  
  Now at: `src/ui/features/explorer/index.ts:624`  
  Evidence: root() still saves blind: `saveMemory() // remember where we were before we leave` (:624) runs while wsId/rootPath name the PREVIOUS workspace, and saveMemory only checks they are non-empty (:456-458). reset() clears `expanded` before the `await tree.setRoot` at :660 (file-tree.ts:565-569), and :661/:666/:668 abort before the restore at :662-670. No settled flag exists.  
  Recommendation: As originally recommended (settled flag after the restore block; saveMemory no-ops for an unsettled generation). Add an expandedDirs assertion for the interrupted workspace to explorerrace-smoke.ts instead of a new smoke.  
  Note: The new explorerrace-smoke.ts drives this exact timing (delayed src listing, fast switch back) but asserts only rootPath/rowNames/gitRoot/handles, so it walks straight past the memory clobber.

- **[still-open · low] F7 — Worktree-deleted files never show the promised D/strikethrough row, even in lens**  
  Now at: `src/ui/components/file-tree.ts:245 (docs/16-files.md:163)`  
  Evidence: Rows still come only from readdir entries: `const kids = filter ? all.filter((e) => filter?.has(e.path)) : all` over `st.children ?? []` (:245-246) — the lens narrows, never synthesizes; lensSets/applyLens only build a path Set plus ancestors (index.ts:412-431). docs/16-files.md:163 still reads '| deleted | D | ... | name struck through |'; the delta only edited that doc's insert paragraph.  
  Recommendation: As originally recommended. Cheapest honest fix: amend docs/16 to say deletions surface via folder tint and chip count only; synthetic meta rows are the richer option, and delegation already refuses missing paths (index.ts:467).  
  Note: Unchanged. The chip still counts gitFiles.length (index.ts:390), so it can exceed the rows the lens can show; folder tint does propagate (rebuildDecorations :356-359), so a deletion is not wholly invisible.

### agent-settings-editor

- **[still-open · medium] F1 — Hourly interval reconciles/polls provider files, contradicting docs' no-interval promise**  
  Now at: `src/main/agent-settings.ts:460`  
  Evidence: Unchanged: `catalogTimer = setInterval(() => { void refreshInstalledCatalogs(true)... }, 60 * 60 * 1_000)` (460-462). Callback force-probes 5 versions (448), then ungated `await settings?.reconcileAll()` (452) + emitChanged for all 5 (453). catalog-service.ts:124 still retries stale catalogs hourly. docs/17:102 'No interval polls provider files.' — doc unchanged since baseline.  
  Recommendation: As originally recommended. Better: reuse the delta's own debounced event-driven trigger scheduleApplyAccountDefaults (service.ts:638) in place of the wall-clock interval, and add daily backoff to isDue (catalog-service.ts:123).  
  Note: Stays at the prior verifier's corrected medium. Delta widens it: reconcileAll (service.ts:381-383, filters only ownership==='enforce') now also walks ADR 0022 tier:'compiled' rows fanned across every home.

- **[still-open · medium] F2 — Baseline capture not hash-linked to the write; restore can revert to a stale value**  
  Now at: `src/backend/features/agent-settings/service.ts:300`  
  Evidence: set() still captures via a standalone read whose hash is discarded: `const current = await this.coordinator.read(source.file)` (300), codec read (301), persisted 323-324. reconcileRows does its own read (777) and uses `expectedHash: before.hash` (794). No hash continuity. release() restores the unlinked row.baselineValue (367-368).  
  Recommendation: Better than the original, now that two capture sites exist: derive the baseline inside coordinator.mutate's transform from `current` (the CAS-verified snapshot) and persist it only after mutate resolves — fixes 296-310 and 581-603 at once.  
  Note: Delta duplicated the pattern into the ADR 0022 fan-out: applyAccountDefaults reads its own baseline at service.ts:591-594, reconciles at 627. That path runs automatically across every home, so stale baselines can land with no user action.

- **[still-open · medium] F3 — AgentConfigSource.candidates never populated; OpenCode writes fragment user config**  
  Now at: `src/backend/features/agent-settings/sources.ts:245`  
  Evidence: sources.ts byte-identical to baseline. `candidates` still has no producer — only the type (43), spec field (191), fileSource passthrough (197-198), consumers (364, 378). OpenCode user runtime still 3 sources: `['config.json','opencode.json','opencode.jsonc'].entries()` (245-247); selectAgentConfigSource's `[...sources].reverse().find(...)` (376) always picks opencode.jsonc.  
  Recommendation: as originally recommended  
  Note: Unchanged by the delta, slightly worse in practice: applyAccountDefaults writes through the same selectAgentConfigSource (service.ts:586), so account-defaults also land in a newly created opencode.jsonc.

- **[still-open · medium] F4 — Drift computed in snapshot() never persisted; overview can say synced while drifted**  
  Now at: `src/backend/features/agent-settings/service.ts:186`  
  Evidence: providers() still rolls up the stored column: `const sync = this.rollup(rows.map((row) => row.status))` (186); row.status changes only in saveStatus/reconcileRows (739, 764, 808-816). settingState computes live drift at 940 (894 for codex) and never writes it back — no repository write in snapshot() (202-273). computeSyncState still skips the drift branch via `&& !selectedSourceErrored` (146).  
  Recommendation: as originally recommended  
  Note: Unchanged by the delta, but the rollup at 185 lists rows without a tier filter, so drift on an ADR 0022 compiled account-default is equally invisible in the overview until a reconcile.

- **[still-open · low] F5 — mergeValues deep-merges objects for providers whose merge mode is 'replace'**  
  Now at: `src/backend/features/agent-settings/service.ts:122`  
  Evidence: mergeValues (114-132) still takes only boolean concatArrays and recurses into any two plain objects: `out[key] = mergeValues(out[key], value, concatArrays)` (128). Sole call site passes only the concat flag: `mergeValues(effectiveValue, read.value, loaded.source.merge === 'deep-concat-arrays')` (924). Aider still declares merge:'replace' (sources.ts:236,239,241).  
  Recommendation: as originally recommended  
  Note: No change; the ADR 0022 rewrite of service.ts did not touch mergeValues or its call site.

- **[still-open · low] F6 — No unit tests for ConfigMutationCoordinator CAS/atomicity or secret-name heuristics**  
  Now at: `src/backend/core/config-files/mutation-coordinator.ts:111`  
  Evidence: config-files/ untouched since baseline; the uncovered CAS re-read is still `if (latest.hash !== current.hash) throw new ConfigMutationError('changed-under-us', ...)` (111-114); symlink handling still 131-146. tests/unit has no mutation-coordinator.test.ts or validation.test.ts; grep for ConfigMutationCoordinator|secretShapedName across tests/ and src/main/smokes returns nothing.  
  Recommendation: As originally recommended, plus a case the delta makes cheap: enqueue several concurrent mutate() calls for the SAME file (the shape applyAccountDefaults produces across homes) and assert serialized ordering with no lost update.  
  Note: Delta added 8 unit tests, none here: account-defaults.test.ts imports only managedKeys/resolveDefault. Gap guards more now — fan-out drives many more concurrent mutate() calls and the secret heuristic gained 3 call sites (595, 709, 712).

### accounts-entitlements

- **[still-open · high] F1 — Transient vault decrypt failure destroys the session: refresh clears the grant on !rt**  
  Now at: `src/main/account.ts:592`  
  Evidence: `if (!rt || !key) { clearSession() }` at :592-595, after `const rt = vaultLoad(VAULT_REFRESH)` (:582). clearSession wipes both slots (:385-386). vault.ts:46-52 still returns null on any decrypt throw; vaultHas was true at :566, so !rt = decrypt failed. Key-store errors (:586-590) and AS outages (:605) keep the session; rt does not. Zero commits touch this file since c026463.  
  Recommendation: As originally recommended - split the condition at :592 so an rt-decrypt failure returns null (session kept, ciphertext retained) and only `!key` reaches clearSession(). The copied-vault case still ends cleanly via invalid_grant at :606.  
  Note: Unchanged by the delta. High holds: the two neighbouring branches in the same function make the omission starker - chip trouble and AS trouble keep the session, only a keychain/DPAPI blip destroys it.

- **[still-open · medium] F2 — Cached entitlement is not bound to the account - another user inherits Pro through grace**  
  Now at: `src/main/entitlements.ts:272`  
  Evidence: entitlementsSnapshot (:272) gates only on buildTampered (:275), claims.revoked (:279), deviceMismatch (:280), graceStateOf (:281-282). accountId is parsed at :182, returned at :189, and grep finds it nowhere else but activationWatermarkForSmoke (:473) - never compared to a session. clearOnLogout (:404) is logout-only; doFetch returns false on non-2xx (:366).  
  Recommendation: As originally recommended - compare the new session subject to cached claims.accountId in refreshOnLogin and drop the cache on mismatch; the cacheEpoch bump at :421 is a natural home. Leave pre-07 claims (no accountId) on the anon device-mismatch path.  
  Note: Unchanged by the delta. account.ts clearSession (:606 path) still leaves VAULT_CACHE intact. Medium holds - needs the two-users-on-one-machine sequence plus a failed entitle fetch for user B.

- **[still-open · medium] F3 — Background-refresh staleness keys off exp only; long-exp claim coasts to grace cliff**  
  Now at: `src/main/entitlements.ts:397`  
  Evidence: `const staleish = !entry || graceStateOf(entry) !== 'fresh' || entry.claims.exp * 1000 - now() < 6 * 3_600_000` at :397 - no fetchedAt-age term. graceStateOf answers 'fresh' for any `t < claims.exp * 1000` (:224) regardless of anchor age, and fetchedAt only advances on a successful doFetch cache write (:380-384). An exp beyond GRACE_MS means zero refetches until 6h before exp.  
  Recommendation: As originally recommended - add a fetchedAt-age disjunct at :397, e.g. `|| now() - entry.fetchedAt > GRACE_MS / 2`, so the anchor advances on online machines independently of the issuer's exp choice.  
  Note: Unchanged by the delta. Medium holds: an issuer-dependent latent cliff, not a defect on well-behaved TTLs.

- **[still-open · medium] F4 — Wound-back-clock grace branch and engine invariants have zero unit tests**  
  Now at: `src/main/entitlements.ts:220`  
  Evidence: `if (entry.fetchedAt - t > 86_400_000) return 'expired'` at :220, proven only by the comment at :215-219. tests/unit has 34 files; grep for graceStateOf|verifyEntitlementJwt|entitlementsSnapshot|fetchedAt across tests/ returns none. account-defaults.test.ts is ADR 0022 agent settings. entitle-smoke only advances the clock (:156, :169); no smoke winds it back.  
  Recommendation: As originally recommended. Note graceStateOf and verifyEntitlementJwt are module-private, but the clock seam already exists as setEntitleClockForSmoke (entitle-smoke.ts:92) - widen that export or drive the invariants through entitlementsSnapshot.  
  Note: Unchanged, but starker: the delta added ~25 test/smoke files (+2528 lines, whole new suites) while this security-relevant invariant still has no test at any level. Medium holds - a proof gap, not a live defect.

- **[still-open · low] F5 — Login over an existing session can keep the previous user's identity claims**  
  Now at: `src/main/account.ts:320`  
  Evidence: persistGrant: `if (claims?.email !== undefined) store?.setSetting(KV_EMAIL, claims.email)` (:330-331). Login still reaches it with undefined claims: only `!v.ok && v.why === 'invalid'` fails (:523), while verifyIdToken returns why:'unreachable' at :278, :282 and :286 - all fall through to persistGrant (:536). clearSession blanks both KVs (:388-389) but runs only if persistGrant fails (:537).  
  Recommendation: As originally recommended - on the authorization-code path only, blank KV_EMAIL/KV_PLAN before persistGrant at :536 when verified claims are absent; leave doRefresh's claims-stand behavior (:610-617) alone.  
  Note: Unchanged by the delta. Low holds - display-only misidentification in Settings, no entitlement or custody consequence.

- **[still-open · low] F6 — docs/19-accounts.md heading numbers itself as chapter 18**  
  Now at: `docs/19-accounts.md:1`  
  Evidence: Line 1 at HEAD still reads `# 18 - Accounts, entitlements & hardening` while the filename is 19-accounts.md. git log c026463..HEAD -- docs/19-accounts.md returns zero commits.  
  Recommendation: As originally recommended - change the H1 to '# 19 - Accounts, entitlements & hardening' and grep docs/ for '18 -' cross-references to this chapter.  
  Note: Unchanged by the delta. Low holds.

### brain

- **[still-open · high] F1 — Lockfile changes via head moves or cold-start reconcile never re-resolve library truth**  
  Now at: `src/backend/features/brain/freshness.ts:411`  
  Evidence: Brain backend byte-identical to baseline (git diff --stat c026463..HEAD on it is empty). onHeadMove still ends at :411 with `if (memoryPaths.length) for (const cb of this.memorySubs) cb(state.root, memoryPaths)` — no isLockfile collection, no lockSubs, though isLockfile is at :67 and fires at :346. attachRoot still only `if (reconcile) this.scheduleMemoryRescan(root)` (index.ts:960).  
  Recommendation: as originally recommended — push isLockfile(rel) paths into a lockPaths array in onHeadMove's loop and fire lockSubs exactly as freshness.ts:346 does; add scheduleLibraryResolve(root) beside scheduleMemoryRescan at index.ts:960.  
  Note: Severity unchanged; delta touched neither file. Both triggers (branch switch, app-closed lockfile edit) remain open — list_libraries/get_library_docs serve stale versions with no dirty flag.

- **[still-open · medium] F2 — Sessions still alive at app quit never land a session draft**  
  Now at: `src/ui/features/terminal/terminal-pane.ts:970`  
  Evidence: emitSessionCapture (970-983) still has exactly two callers: markDead :955 and dispose :2272. grep for beforeunload|pagehide across src/ui and src/main yields nothing brain-related. boot.ts:430-444 before-quit calls flushTelemetry/stopMcpEndpoint/disposeBrain/disposeGit — never asks the renderer to capture. The +64-line terminal-pane delta adds no line mentioning capture, quit, or unload.  
  Recommendation: Prefer the main-side mirror: mirror the OSC-133 block ladder in main (brain-capture.ts:274 already owns redaction and signal) so quit-time capture runs before boot.ts:430's disposeBrain() with no renderer round-trip to await.  
  Note: Severity unchanged. Ordering hazard now explicit: boot.ts:430's before-quit calls disposeBrain() synchronously, so any renderer-round-trip flush would race the closing of the very db handles it needs.

- **[still-open · medium] F3 — One unit test file covers a ~9k-line feature; pure invariants untested outside smokes**  
  Now at: `tests/unit/brain-libraries.test.ts:1`  
  Evidence: tests/unit now holds 34 files (delta added 8: account-defaults, env-path, pane-insert, spawn-tool, worktree-preflight, etc.), but only one brain test remains — brain-libraries.test.ts, still importing just resolveLibraries. grep -rln for replaceMemoryBody|parseMemoryText|applyIndent|eolOfLine|parseMemoryFilter over tests/ and src/main/smokes/ returns zero hits.  
  Recommendation: as originally recommended — the eight test files added in this delta (e.g. tests/unit/relative-to-dir.test.ts) are the working pattern to copy for writes.ts splice (LF/CRLF/terminator-less EOF) and memory.ts round-trips.  
  Note: Severity unchanged, but the gap is more conspicuous: the delta added eight unit-test files for other areas while the brain's byte-splice and memory-parse invariants stayed at zero vitest coverage.

- **[still-open · low] F4 — Docs' closed refusal-reason enum does not match the code's actual reason set**  
  Now at: `docs/20-brain.md:136`  
  Evidence: docs/20:135-137 still claims a closed 9-value enum. Code still emits 7 more across 11 sites: 'unknown-node' (serve.ts:206, 424; writes.ts:228), 'too-deep' (serve.ts:338, 347, 357), 'no-map' (serve.ts:472), 'unknown-library' (serve.ts:534), 'unknown-memory' (serve.ts:759, 765, 837), 'wrong-checkout' (writes.ts:234), 'no-brain' (recall.ts:163). BrainRefusalReason (brain.ipc.ts:65) still holds 4.  
  Recommendation: Prefer centralizing over patching docs: export one BrainServeRefusalReason union beside BrainRefusalReason (brain.ipc.ts:65), type the refuse() helpers in serve.ts/writes.ts/recall.ts against it, and have docs/20 §3 cite the type.  
  Note: Severity unchanged. The delta's only docs/20 edit was the gate count at line 315 (199→207); it added gates but none over the enum's closedness, so the claim stays unenforced by both types and gates.

- **[still-open · low] F5 — A fresh worker (V8 isolate + sqlite open + WASM parser init) is spawned per drain**  
  Now at: `src/backend/features/brain/index.ts:1049`  
  Evidence: All three paths still spawn-and-terminate per op: `new Worker(this.opts.workerFile, ...)` at index.ts:1010 (runBuild), :1049 (runDelta), :1088 (runLibraries), each with a finish closure doing `void worker.terminate()`. Every postMessage is `{ id: 1, ... }` — one message per isolate. BRAIN_DRAIN_QUIET_MS still 750 (freshness.ts:28), used by armDrain (freshness.ts:422).  
  Recommendation: as originally recommended — one lazily-created persistent worker per BrainService, terminated in dispose(), dispatching build/delta/libraries over the id-keyed protocol currently hardcoded to id:1; runExclusive already serializes ops.  
  Note: Severity unchanged. The delta altered neither drain cadence nor worker lifetime; the ConPTY v2 / multi-pane work raises the ambient load this overhead competes with but does not change the finding itself.

- **[still-open · low] F6 — Usage counters and eviction counts contradict the 'db is disposable' stance**  
  Now at: `src/backend/features/brain/store.ts:653`  
  Evidence: store.ts unchanged: bumpMemoryUsage :653-660, memoryUsageRows :663-667, bumpDraftEvictions :627-634. Both tables live only in the derived db (schema.ts:174, :177). docs/20:75 still says the db "is deletable and rebuildable at any moment", :77 names `.memory/` as "the one deliberate exception"; :224 promises every eviction "never silent". index.ts:1141-1148 still recommends delete+rebuild.  
  Recommendation: as originally recommended — amend docs/20 §1's "one deliberate exception" sentence (line 77) to name usage/eviction counters as a second, lossy exception, and show a generation-reset note in the Brain view's usage table after a db recreation.  
  Note: Severity unchanged. Re-reading sharpens it: docs/20:77 enumerates the exception set as exactly one item, so the counters are not merely undocumented but positively excluded by a closed claim.

### context-monitor

- **[still-open · medium] F1 — Relay pin never set when the sink names the already-locked file**  
  Now at: `src/backend/features/context/monitor.ts:334`  
  Evidence: Line 334 unchanged: `if (sink && sink.transcriptPath && sink.mtimeMs >= this.floorFor(t) && sink.transcriptPath !== t.file) {`. lock() (line 318) is the ONLY writer of `t.pinned = true`, and that `!== t.file` conjunct is its only door. Heuristic lock at 352-356 passes pinned=false; a later sink naming that same file takes the skipped branch, so pinned stays false for the lock's life.  
  Recommendation: As originally recommended: at 334 split the condition so `sink.transcriptPath === t.file && !t.pinned` sets t.pinned = true in place (no re-lock, no gate reset); add a unit test that such a pane becomes takeover-immune once its sink confirms.  
  Note: Unchanged. Real exposure: the heuristically-locked pane still loses to takeover (208 `!owner.pinned`) and mtime migration (354) despite its relay confirming identity; sessionFor() (142) feeds ADR-0013 resume from that lock.

- **[still-open · medium] F2 — aiderLogPath lacks the channel/version segment — dev and installed builds collide**  
  Now at: `src/backend/features/context/providers.ts:25`  
  Evidence: Line 25 still `join(os.tmpdir(), `mogging-aider-${os.userInfo().username}`, `${paneId}.jsonl`)` — no runtimeSegment, while readers.ts:185 has `mogging-ctx-${username}-${runtimeSegment(channelFromEnv())}`. Both injectors use the segment-less path (pty-daemon/session.ts:536, pty.service.ts:145). remove() at monitor.ts:154 unlinks only contextSinkPath.  
  Recommendation: As originally recommended: add runtimeSegment(channelFromEnv()) to the aider dir name, and add fs.unlinkSync(aiderLogPath(paneId)) beside the sink unlink at monitor.ts:154 with the same try/catch.  
  Note: Severity unchanged. Both halves re-verified independently; the file has not moved and the claude-sink fix it should mirror is one file away in the same directory.

- **[still-open · medium] F3 — OpenCode emits a dead previous session's numbers as a real reading**  
  Now at: `src/backend/features/context/monitor.ts:430`  
  Evidence: Lines 430-432 still `if (t.provider === 'opencode') { const r = readOpencodeUsage(t.home, t.cwd); if (!r) return` — null is the only rejection; the emit at 435-444 sets no approx and no time test. Aider one branch up keeps its guard at 414: `if (!r || r.mtimeMs < this.floorFor(t)) return`. Reader still time-blind (providers.ts:99, 146) and returns no timestamp (160-164).  
  Recommendation: Better than the original: have readOpencodeUsage select the chosen message's time_created (both SQL variants already order by it) and return it as mtimeMs, so line 432 reuses the aider one-liner verbatim: `if (!r || r.mtimeMs < this.floorFor(t)) return`.  
  Note: Unchanged. The contract it breaks is still stated in the renderer: src/ui/features/context/index.ts:73-75 sets 'pending' — "never a made-up 0%" — yet an opencode relaunch in a repo with history shows the dead session's percent unflagged.

- **[still-open · medium] F4 — Aider/opencode bypass the stat gate: sync reads and SQLite opens on main every tick**  
  Now at: `src/backend/features/context/monitor.ts:412`  
  Evidence: Aider (412) and opencode (430) branches both return before the gate at 449 (`if (!statChanged) return`). readAiderUsage (providers.ts:30-39) stats then unconditionally readTail; readers.ts:32 `TAIL_BYTES = 256 * 1024`. readOpencodeUsage (providers.ts:136-137) still does `new Database(...)` + 200-row SESSIONS_SQL per pane per 2.5s tick, on main (src/main/context.ts:110).  
  Recommendation: Gate on state already held: stat aiderLogPath against t.lastMtimeMs/t.lastSize (unused on this path) before readTail — that mtime also serves F3; stat opencode.db and -wal before opening SQLite; early-return before candidates() at 352 for both.  
  Note: Severity unchanged (docs/05 main-thread law). One sub-claim is smaller than stated: candidates() at 352 does route these into the codex branch, but codexDayDirs walks <home>/sessions, absent there — one failed readdir, not a scan.

- **[still-open · low] F5 — Learned claude windows are global per model id — one 1M session poisons 200K panes**  
  Now at: `src/backend/features/context/window.ts:61`  
  Evidence: window.ts:56 still `const LEARNED_WINDOWS = new Map<string, number>()` — module-global, model-id keyed, no home, no TTL. learnClaudeWindow (61-66) is last-writer-wins (`LEARNED_WINDOWS.set(modelId, windowTokens)` + bare alias at 65); claudeWindowForModel (73-74) prefers it over the table. Teaching site passes no home: monitor.ts:393 `learnClaudeWindow(sink.model, sink.windowTokens)`.  
  Recommendation: As originally recommended: key LEARNED_WINDOWS by `${home}|${modelId}` — monitor.ts already carries the resolved home, so the call at 393 only needs t.home added — and record the cross-profile caveat in the window.ts:45-55 comment.  
  Note: Unchanged (low). window.ts:48-51 itself documents the ambiguity that makes it reachable (a transcript says claude-opus-4-8 at both 200K and 1M), but it needs two profiles on one model with different windows.

- **[still-open · low] F6 — No docs entry for the context gauge — spec lives only in contract comments**  
  Now at: `docs/07-perception-budget.md:1`  
  Evidence: docs/ now holds 00-22 + RELEASING/adr/assets/research; grep for `context gauge|ContextMonitor|used_percentage|statusline` over docs/ matches exactly one file — docs/research/2026-08-01-full-feature-audit.md, this audit's own output (line 1253 `## context-monitor`). docs/07 is still GL/perception; docs/21:1-30 names only agent-state code as its record.  
  Recommendation: Add docs/23-context-gauge.md (NOT 22 — now shared-defaults) or a docs/21 section: per-provider sources, formula-parity (codex 12K reserve, gemini unclamped), pending/approx semantics, and the sink path derivation (username + runtimeSegment + pane id).  
  Note: Unchanged. Delta that matters: docs/22 is now 22-shared-defaults.md (ADR 0022), so the proposed 22-context-gauge.md would collide. The audit landing in docs/research/ does not close this — snapshots, not contract.

### updater-distribution

- **[still-open · high] F2 — Re-running Release for an old tag force-marks it --latest, regressing the feed**  
  Now at: `.github/workflows/release.yml:332`  
  Evidence: release.yml is unchanged since c026463 (absent from diff --stat). Line 332 is still unconditional: `gh release edit "$TAG" --draft=false --latest`. The preceding loop (:325-331) only checks the three feed files exist — no semver comparison anywhere in the file. The arbitrary-tag dispatch input is still at :10-15.  
  Recommendation: As originally recommended: before :332 resolve the newest published semver via `gh release list` and pass `--latest=false` when $TAG is not it; note the guard in docs/10's publish-after-assets section.  
  Note: Unchanged. Still the highest-impact item here: one dispatch re-run against an old tag repoints /releases/latest for every install; prerelease users downgrade.

- **[still-open · medium] F1 — Windows updates are not signature-verified; docs claim tampered builds are rejected**  
  Now at: `electron-builder.yml:156 / src/main/updater.ts:21`  
  Evidence: win: block (156-168) still only target/artifactName/extraResources; repo-wide grep for publisherName|verifyUpdateCodeSignature hits ONLY the audit doc. Claims intact: updater.ts:21 "verifies the update's signature, so an unsigned/tampered build is rejected", docs/10-distribution.md:87-88, docs/RELEASING.md:38-39. verify-signing-readiness.mjs asserts nothing about it.  
  Recommendation: As originally recommended: correct the three claim sites to "sha512-checked against the HTTPS feed until signing lands", pin win.publisherName, and assert it in verify-signing-readiness.mjs (today it prints only a platform header, :32).  
  Note: Held at the verifier's corrected medium. docs/10 WAS edited in the delta (gate count, v0.17.0 bumps) but the signature sentence at :87-88 was left untouched — file-changed is not fixed.

- **[still-open · medium] F3 — Background check clobbers phase 'ready', defeating the graceful pre-install daemon retire**  
  Now at: `src/main/updater.ts:387`  
  Evidence: updater.ts is byte-identical to baseline. :387 still `autoUpdater.on('checking-for-update', () => push({ phase: 'checking', error: undefined }))` — unguarded. Offline failure still settles to idle at :212. Consumers still gate on phase: before-quit :330 `if (retiredForInstall || last.phase !== 'ready') return`, restart :301 `if (last.phase !== 'ready') return`. No downloaded flag exists.  
  Recommendation: As originally recommended: latch `updateDownloaded` on 'update-downloaded' and gate :301 and :330 on it instead of last.phase, so a later failed background check cannot retract readiness.  
  Note: Unchanged. Stakes slightly higher: the hard-kill fallback this race drops into is installer.nsh's retire, which was rewritten in the delta and found broken live twice (see F5).

- **[still-open · medium] F4 — Draft-demotion guard misses partially-fed premature publishes**  
  Now at: `.github/workflows/release.yml:50`  
  Evidence: Unchanged file. ensure-release still counts (:49 `FEED=$(gh release view ... select(startswith("latest"))] | length')`) and demotes only at :50 `if [ "$DRAFT" = "false" ] && [ "$FEED" = "0" ]; then`, while publish still iterates the explicit list (:326 `for feed in latest.yml latest-mac.yml latest-linux.yml`). FEED=1 (win leg only) leaves a live release mac/linux 404 against.  
  Recommendation: As originally recommended: replace the count test at :49-50 with the same explicit three-file loop the publish job uses, demoting when ANY is missing. Sharing the list via a step output would stop the two guards drifting again.  
  Note: Unchanged. The guard still contradicts the publish-after-assets law spelled out in its own comment block at :42-48, which cites the v0.16.0 outage.

- **[still-open · medium] F6 — No test covers the phase-gated restart/quit install paths**  
  Now at: `src/main/updater.ts:293 (handler), :301 / :330 (untested guards)`  
  Evidence: tests/unit still has no updater test (nearest is agent-install-spec.test.ts). src/main/smokes has only updatefail-smoke.ts / updateoffline-smoke.ts, wired at scripts/qa-smokes.sh:407-408, both check-outcome classification; :127 is FIRSTRUN's fake feed. Nothing drives phase to 'ready'. Handler at :293, guards at :301 and :330 unchanged.  
  Recommendation: As recommended, sharpened: extract the (phase, retiredForInstall, installOnQuit) decision behind :301/:330 into a pure function and unit-test it, AND add an UPDATEREADY gate driving the fixture feed to 'ready' — the same gate covers F3's clobber race.  
  Note: Code unchanged; the delta corroborates it — the fallback these paths protect shipped broken and was caught only by hand-observation (2026-07-31, 2026-08-01). Gate-honesty: green gates over a wholly unexercised ready/retire path.

- **[still-open · low] F5 — Daemon-retire PowerShell breaks on $ in install path and over-matches sibling dirs**  
  Now at: `build/installer.nsh:137`  
  Evidence: installer.nsh was rewritten (+197: nsProcess fast path, pages, a WOW64 Get-Process->Win32_Process fix) but the bad comparison survived verbatim at :137: `$$_.ExecutablePath.StartsWith(\"$INSTDIR\", [System.StringComparison]::OrdinalIgnoreCase)`. $INSTDIR is still NSIS-interpolated into a PS double-quoted string, and still has no trailing separator. No MOG_INSTDIR handoff exists (grep).  
  Recommendation: Better fix now available: customInit already uses System::Call SetEnvironmentVariable, so publish $INSTDIR + trailing backslash as MOG_INSTDIR and compare `$$env:MOG_INSTDIR` at :137 — kills interpolation and the sibling over-match in one edit.  
  Note: Low held, but confidence is higher: this retire is NEW code (baseline had no step 3) and its own comments log it no-op'ing live twice — :47-56 and :126-133. Same silent-no-op class; only symptom is the double-extract fallback.

- **[still-open · low] F7 — winget installer manifest lacks AppsAndFeaturesEntries for upgrade correlation**  
  Now at: `scripts/update-manifests.mjs:71 (Installers block at :80-83)`  
  Evidence: update-manifests.mjs unchanged. Installer template from :71 still emits only InstallerLocale/InstallerType: nullsoft/Scope/UpgradeBehavior plus Architecture/InstallerUrl/InstallerSha256 (:80-83) — no AppsAndFeaturesEntries. Generated packaging/winget/MoggingLabs.Workspace.installer.yaml confirms it. Publisher/PackageName live only in the locale manifest, which winget does not use for ARP matching.  
  Recommendation: As originally recommended: add AppsAndFeaturesEntries (DisplayName "MoggingLabs Workspace", Publisher "MoggingLabs", DisplayVersion ${version}) to the template at :71 and regenerate — the manifest needs a v0.17.0 refresh regardless.  
  Note: Unchanged. The checked-in manifest is now stale at PackageVersion 0.16.0 while docs/10 was bumped to v0.17.0 in the delta, so a regeneration is due anyway.

### wizard-first-run

- **[still-open · medium] F2 — First-run checklist completion collapse/toast is unreachable in production**  
  Now at: `src/ui/features/home/firstrun.ts:209`  
  Evidence: Collapse+toast still only in refresh(): `if (rows.every((r) => r.done || r.optional)) { setDismissed(); … showToast({title:'Setup complete'…}) }` (209-217). Callers remain Home-only (home/index.ts:286-293). view-port.ts:42 `if (view === 'home' && hasWorkspaces) view = 'grid'` unchanged, and wsDone = workspaces.length > 0 (firstrun.ts:160). No workspace-count subscription in the c026463..HEAD diff.  
  Recommendation: firstrun.ts already imports workspace-info-port, which exports onWorkspacesChange (line 65) — subscribe there and refresh() on 0->1 regardless of view; then have FIRSTRUN assert through that subscription, not the DEV handle.  
  Note: Unchanged severity; gate-honesty angle now explicit: firstrun-smoke.ts:62-64 creates a workspace then calls the DEV-only `__mogging.firstrun.refresh()` (home/index.ts:296-303) to certify a flip production never triggers.

- **[still-open · medium] F3 — Checked isolation is silently dropped on any folder change**  
  Now at: `src/ui/features/wizard/index.ts:1751`  
  Evidence: syncIsolate() still resets intent: `if (!usable) isolate = false; ... setChecked(isolate && usable)` (1748-1753). probeIsolation() still nulls the verdict per folder change (1704-1705), fired from the selection subscriber on every emit (824). Only intent state is `let isolate = false` (154), written solely by the checkbox onChange (1509-1511); no wantIsolate exists.  
  Recommendation: As originally recommended: add wantIsolate in the checkbox onChange (1509), re-apply as `isolate = wantIsolate && usable` in syncIsolate(), and explain an unisolatable new folder via isolationHint() (1724) instead of silently unchecking.  
  Note: Unchanged. One narrow trigger stays closed: `if (target && target === preflightCwd) return syncIsolate()` (1702) stops same-folder re-emits clearing the box — but a real folder change, the finding's trigger, still does.

- **[still-open · low] F1 — Successful launch never disposes wizard resources (leave() skipped)**  
  Now at: `src/ui/features/wizard/index.ts:662`  
  Evidence: Still `if (activeView() === 'wizard') leave()` (662); leave() (258-265) is the only disposer. Guard still false: opener -> controller.openFromTemplate (controller.ts:1867) -> create's `this.switch(meta.id)` (370-371) -> `if (opts.reveal !== false) setActiveView('grid')` (768), all inside the awaited call. Leaked panels keep `getBridge().on(AgentChannels.setupChanged)` (setup-panel.ts:262).  
  Recommendation: Extract disposeWizard() (openGeneration++, selection/cdLine/setupPanels dispose, launching=false), call it unconditionally at index.ts:662, and keep `if (activeView() === 'wizard') goBack()` as the only guarded part.  
  Note: Down from MEDIUM: next open() re-disposes (269, 739-740, 1392) so at most one generation leaks, and currentOpen() (237-238) fences late callbacks. Residue: stale setupChanged listener, detached-DOM writes, `launching` left true.

- **[still-open · low] F4 — docs/02 says the 8.5 wizard has 'no cd bar' but a cd line shipped and takes focus**  
  Now at: `docs/02-mvp-and-roadmap.md:142`  
  Evidence: Bullet byte-identical: 'pickable by **click** through a real browser (breadcrumb + repo badges), no `cd` bar.' (140-142); `git log c026463..HEAD -- docs/02-mvp-and-roadmap.md` is empty. Product contradicts it: createCdLine import (index.ts:49), cdLine built at 858, open() focuses it first — `(cdLine ? cdLine.input.focus() : path.focus())` (320). WIZCD gate at scripts/qa-smokes.sh:617.  
  Recommendation: As originally recommended: amend docs/02-mvp-and-roadmap.md:142 to record the reinstated cd-only line (Tab completion, cd/chdir only) alongside click-to-pick, note it takes initial focus, and cite the WIZCD gate.  
  Note: Line drifted 140 -> 142 from edits above; sentence unchanged. The revamp commits (883fbc6, 6f16fcc) strengthened the cd line rather than removing it, so the doc is further from the product than at audit time.

- **[still-open · low] F5 — Folder browser reports a failed listDir IPC as 'That folder isn't there'**  
  Now at: `src/ui/components/folder-browser.ts:337`  
  Evidence: Unchanged catch: `res = { ok: false, reason: 'missing', path: dir } // the channel itself failed` (336-338); REFUSALS.missing is still "That folder isn't there" / 'It may have been moved or renamed…' (55), painted at 208. path-selection.ts:106-108 still maps the same fault to `reason: 'unavailable'` ('The filesystem service did not answer.', 60-63). No commits touched this file.  
  Recommendation: As originally recommended: change folder-browser.ts:337 to `reason: 'unavailable'` so both wizard routes describe an IPC failure the same, honest way.  
  Note: Untouched by the 32-commit delta in every respect.

- **[still-open · low] F6 — Preset save/delete IPC failures are swallowed with no feedback**  
  Now at: `src/ui/features/wizard/index.ts:1611`  
  Evidence: savePreset still: `void wizardClient.savePreset(preset).then(() => { presets = [...presets, preset]; renderPresets(); … })` (1611-1615), no .catch; removePreset the same (1669-1672). The client does not absorb it — bare `getBridge().invoke(TemplateChannels.save/remove, …)` (wizard.client.ts:28-31) — while neighbouring wizard IPC catches (336, 772-774, 1717).  
  Recommendation: As originally recommended: add .catch() to both calls that leaves the in-memory presets list untouched and surfaces a toast ('Could not save preset — try again' / 'Could not delete preset').  
  Note: Unchanged by the delta. Bounded to presets (no credential or launch path), so LOW stands; the unhandled rejection remains a second silent symptom.

### shortcuts

- **[still-open · medium] F1 — Palette, explorer, rail and settings chords still skip the shortcutsBlocked guard**  
  Now at: `src/ui/features/palette/index.ts:216 (+explorer:775, app-shell:127, settings:1058)`  
  Evidence: git diff c026463..HEAD on palette/app-shell/settings is EMPTY; grep shortcutsBlocked in all four = NONE. palette:216 `if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k')`, capture true at :226. explorer moved 764->772-782, unchanged at :775; app-shell:127; settings:1058 (`e.key === ','`). context.ts:83 still calls it the guard every raw listener owes.  
  Recommendation: As originally recommended: add `if (shortcutsBlocked(e.target)) return` to the four capture listeners (palette keeps its Escape branch above it); fold in settings:1046. Negative KBGLOBAL rows fired from the rail rename field (controller.ts:681) prove it.  
  Note: Prior verifier said low-medium; delta changes nothing. Kept at band top for the one real trap: Ctrl+K over a .modal-overlay opens the palette atop a blocking dialog. A 5th unguarded listener exists: settings:1046 (Ctrl+F), bubble-phase.

- **[still-open · medium] F2 — Plain Ctrl+T and Ctrl+K stolen from terminals before xterm sees them**  
  Now at: `src/ui/features/workspace/index.ts:708 (and palette/index.ts:216)`  
  Evidence: workspace/index.ts unchanged. :708 `if (k === 't' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); newWorkspace() }`, capture true at :732. context.ts:33-35/:53 still exempts the xterm proxy, so it fires with a pane focused. palette:216 same for Ctrl+K. Opposite rule still stated at app-shell.ts:122-123 and explorer/index.ts:770-771.  
  Recommendation: Treat as a product call: either let plain Ctrl+T/K fall through when e.target.closest('.xterm') — the Shift-required rule app-shell:122 already states — or keep them and document them. Either way reconcile both comments and kbglobal-smoke.ts:52.  
  Note: The HIGH rested on platform divergence that is still wrong: isModKey (shortcuts.ts:15) is ctrlKey||metaKey everywhere, so it is stolen on macOS too. Real hosted-TUI conflict, but deliberate and gate-asserted at kbglobal-smoke.ts:52.

- **[still-open · medium] F3 — Half the global chords match e.key, half e.code — layout-dependent dead shortcuts**  
  Now at: `src/ui/features/workspace/index.ts:690 and :726`  
  Evidence: Unchanged: :690 `const k = e.key.toLowerCase()` feeds :708 't', :712 'd', :716 'enter', :720 '='/'+', :726 `} else if (!e.shiftKey && k >= '1' && k <= '9') {`. Layout-independent half unchanged: board:280 KeyG, brain:68 KeyM, browser:1086 KeyU; explorer's 'e' merely moved to :775. kbglobal-smoke.ts:43-45 admits it sends both key and code, so it is blind here.  
  Recommendation: As originally recommended (standardize on e.code). Better: reuse browser/index.ts:1105-1107's code-or-key idiom for Equal, and add a KBGLOBAL row sending a mismatched pair (key '&' with code 'Digit1') so the gate can actually go red.  
  Note: Unchanged. browser/index.ts:1105-1107 already models the right idiom (`e.code === 'Equal' || e.key === '+' || e.key === '='`) — copy it rather than invent a second dual-spelling.

- **[still-open · medium] F4 — SHORTCUTS sheet omits scrollback, block jump, Insert chords and rail keys**  
  Now at: `src/ui/core/commands/shortcuts.ts:29-83`  
  Evidence: shortcuts.ts unchanged; SHORTCUTS at :29-83 still holds only Navigation/Workspaces/Panes/Clipboard/Tools. Omitted handlers all live, some moved: Shift+PageUp/Down/Home/End now terminal-pane.ts:867-877, Alt+Up/Down :880-883, Ctrl+Insert :802, Shift+Insert :829; F2/Delete/Alt+Arrow workspace/controller.ts:612-622; dock keys browser/index.ts:1100-1107.  
  Recommendation: As originally recommended. One addition the delta makes cheap: Shift+End now routes through anchor.stick() (the jump pill's own call), so label it 'Back to the live output', not 'Scroll to bottom' — no longer the same behavior.  
  Note: Slightly worse in kind: terminal-pane.ts:860-866 now carries an extended rationale for Shift+End ('RE-ARM the follow ... one behavior with two doors'), so a load-bearing designed key is documented only in a source comment.

- **[still-open · medium] F6 — No unit tests for the guard predicates; KBGLOBAL never presses Ctrl+K / Shift+E / Shift+B**  
  Now at: `src/main/smokes/kbglobal-smoke.ts:46-57`  
  Evidence: Unchanged; CHORDS at :46-57 is exactly Ctrl+Shift+D/Enter, Ctrl+Alt+Right, Ctrl+Shift+G, Ctrl+Shift+U, Ctrl+T, Ctrl+1, Ctrl+2, F2, Escape — no Ctrl+K, Ctrl+Shift+E, Ctrl+Shift+B. The delta added 10 unit tests, none on shortcuts: grep 'shortcutsBlocked|isEditableTarget|isModKey|SHORTCUTS' over tests/ = 0 hits, no command-context test in tests/unit.  
  Recommendation: As originally recommended, plus: since kbglobal-smoke.ts:43-45 admits it synthesizes both key and code, the new jsdom tests/unit/command-context.test.ts should also assert each matcher against a disagreeing key/code pair (F3) — the CDP smoke cannot.  
  Note: Now provably load-bearing: F1/F2/F3/F5 all survived a 133-file delta untouched, and the three chords no gate presses are exactly F1's three unguarded listeners — the gate cannot go red on any of them.

- **[still-open · low] F5 — isModKey treats the Windows key as the app modifier on Windows/Linux**  
  Now at: `src/ui/core/commands/shortcuts.ts:15`  
  Evidence: Unchanged: :14-16 `export function isModKey(e: KeyboardEvent): boolean { return e.ctrlKey || e.metaKey }`. The rule it breaks got stronger in a changed file: terminal-pane.ts:793-795 'on Windows metaKey is the WINDOWS key ... must not be eaten' -> `const cmd = IS_MAC && e.metaKey`, IS_MAC at :79. Reachable: workspace/index.ts:689 then :699-706, so Win+Alt+Arrow moves pane focus.  
  Recommendation: As originally recommended, and the constant now exists: lift IS_MAC from terminal-pane.ts:79 into a shared module, make isModKey `e.ctrlKey || (IS_MAC && e.metaKey)`, and point the five longhand copies at it — fixing isModKey alone is insufficient.  
  Note: Severity holds. shortcuts.ts:5-6 actively documents the wrong behavior as intended ('the handlers accept on every platform via ctrlKey/metaKey'), so the comment must change with the predicate.

### telemetry

- **[still-open · high] F1 — Product analytics events sent to Sentry when user consented only to error reporting**  
  Now at: `src/main/telemetry.ts:38`  
  Evidence: Files byte-identical to baseline (git diff c026463..HEAD empty). telemetry.ts:38 `for (const a of adapters) a.captureEvent(event)`; sentry-telemetry.ts:44 `Sentry.captureMessage(event.name, { level: 'info', extra: event.props })`. applyConsent pushes sentry on errorReporting alone (71-77). IPC handler 143-146 and renderer 52-54 still unguarded.  
  Recommendation: As originally recommended; cheapest correct form is now clear: make the Sentry adapter's captureEvent a no-op mirroring posthog-telemetry.ts:31-33, so each adapter owns one consent lane and composite() needs no kind tagging.  
  Note: Unchanged. Renderer comment at telemetry.ts:53 asserts 'main routes to PostHog only while product analytics is consented' — main does no such check, which is why this survived the delta unnoticed.

- **[still-open · high] F2 — Crash reports carry absolute paths with the OS username; beforeSend scrub too narrow**  
  Now at: `src/main/sentry-telemetry.ts:31`  
  Evidence: Unchanged; still 3 deletes only: 31-37 `delete e.server_name; delete e.user; delete e.request`. No exception.values[].value or frame abs_path normalization. Raw errors flow via telemetry.ts:34-36 to captureException (41). Live sites: boot.ts:305, boot.ts:370, daemon-relay.ts:354, fatal.ts:44, updater.ts:286/317, agents/install.ts:74, pty.service.ts:292.  
  Recommendation: As originally recommended. Put the fix in beforeSend (main), not call sites: renderer events auto-forward to the main SDK, so one main-side scrubber covers both processes and cannot be forgotten by a new call site.  
  Note: Unchanged. The delta widened exposure: one-click agent setup added agents/install.ts:74 captureError(op:'install-spawn') — spawn/ENOENT messages are exactly the ones carrying a full user-profile path, on both platforms.

- **[still-open · high] F3 — ADR-mandated beforeBreadcrumb scrubber missing; console/http breadcrumbs unscrubbed**  
  Now at: `src/main/sentry-telemetry.ts:26`  
  Evidence: grep -rn 'beforeBreadcrumb|integrations:' src/main src/renderer returns zero hits in either init (only unrelated MCP channels in smokes). Main init 26-38 has beforeSend only; renderer/telemetry.ts:31 is bare `Sentry.init({ sendDefaultPii: false })`. ADR 0005 lines 36-37 still say the adapter MUST set beforeBreadcrumb and drop console breadcrumbs. @sentry/electron pinned ^7.15.0.  
  Recommendation: As originally recommended, now with a demonstrable trigger: add beforeBreadcrumb to both inits (drop category 'console', strip http/fetch url+data), plus a unit test asserting the boot.ts:267 PATH-repair warning breadcrumb is dropped.  
  Note: Unchanged, but the delta made it concrete: boot.ts:267 now console.warns '[env] PATH repaired — the launch environment was missing ' + dirs — a console breadcrumb of absolute paths attached to every opted-in error event.

- **[still-open · medium] F4 — Revoking analytics consent still sends one final PostHog network flush**  
  Now at: `src/main/telemetry.ts:95`  
  Evidence: Unchanged: telemetry.ts:94-97 `} else if (posthog) { void posthog.shutdown() // flush + stop — nothing sent after revoke`. posthog-telemetry.ts:55-57 awaits client.shutdown(), draining the flushAt:10 / flushInterval:15000 queue (21-25) over the network post-revoke. Header claim at telemetry.ts:20-21 still contradicts the code it describes.  
  Recommendation: Better than the original: posthog-node 5.39.2 exposes `disable(): Promise<void>` (node_modules/posthog-node/dist/client.d.ts:199, 'opt-out'). Call it on revoke instead of shutdown, verifying it does not itself drain the queue; then fix both comments.  
  Note: Unchanged. Bounded to already-consented-era events, at most one buffered batch, one POST — but it is still a false kill-switch claim on a privacy-facing toggle.

- **[still-open · medium] F5 — Zero tests or gate smokes for the opt-in/off-by-default privacy invariant**  
  Now at: `src/main/telemetry.ts:52`  
  Evidence: grep -rli 'telemetry|posthog|sentry' tests/ (34 files) hits only provider-catalog.test.ts:76-79, an MCP catalog entry named 'posthog' — unrelated. No telemetry smoke in src/main/smokes; qa-smokes.sh's only hit (518) is the piracy-telemetry comment. Untested: defaults-off settings-store.ts:872-873, DNT at telemetry.ts:54, sanitizeEvent 104-120, applyConsent 64-100.  
  Recommendation: As originally recommended, but sequence it FIRST, before F1/F3 are fixed, so the tests go red then green. One assertion per finding: sentry-only composite drops captureEvent; synthetic ENOENT event contains no homedir; console breadcrumb dropped.  
  Note: Held at medium, but the delta sharpens it: 32 commits landed explicit gate-honesty fixes elsewhere, yet the 'fully offline forever' invariant still has no gate. F1 and F3 are exactly what a five-line test would have caught.

- **[still-open · low] F6 — before-quit flush is fire-and-forget, so tail analytics events are routinely dropped**  
  Now at: `src/main/boot.ts:431`  
  Evidence: Same line despite boot.ts being the one file the delta touched: 430-431 `app.on('before-quit', () => { void flushTelemetry()`, then the synchronous teardown chain. No preventDefault, no await; flushTelemetry (telemetry.ts:155-159) awaits flush(1500) but nobody awaits it. PostHog still flushAt:10/15000. The delta's boot.ts edit (PATH repair, ~250-267) left this handler untouched.  
  Recommendation: As originally recommended. Lowest priority — and best done AFTER F1, since today the un-awaited flush is the main thing limiting how many mis-routed analytics events actually reach Sentry on quit.  
  Note: Unchanged. Drops data rather than leaking it, and only for opted-in users; purely a data-quality issue for short launch-and-quit sessions.

### ipc-preload-contracts

- **[still-open · medium] F1 — Brain libfetch env vars re-open the origin bypass ADR 0016 banned**  
  Now at: `src/main/libfetch.ts:29`  
  Evidence: File byte-identical to baseline. :29 `process.env.MOGGING_BRAIN_REGISTRY_NPM || 'https://registry.npmjs.org'`, :30 same for PyPI. allowedBase(:33-42) accepts ANY https, no isPackaged gate. Both gates still blind: check-originpin.mjs:69 regex needs `_BASE`; check-prod-artifact.mjs HARNESS_TRIGGERS :62-84 lists only the four `_BASE` names. boot.ts:161 scrubs only MOGGING_CHANNEL.  
  Recommendation: As originally recommended: add npm+pypi to ORIGINS (origins.ts pins exactly one URL today, :20), delete both env reads, pass baseUrl at braindocs-smoke.ts:217. Widen check-originpin.mjs:69 to any MOGGING_* read defaulted to an http(s) literal.  
  Note: Held at the prior verifier's corrected medium: needs local env control plus per-workspace distill consent, default OFF (libfetch.ts:6-8). Nothing in the 32-commit delta touched this file or either gate.

- **[still-open · medium] F2 — Zero sender validation on every ipcMain registration**  
  Now at: `src/main/electron-context.ts:14`  
  Evidence: Diff vs baseline empty. :14 `ipcMain.handle(channel, (_e, payload) => handler(payload))`, :17 the same for `on` — event discarded both times. Direct registrations unchanged: account.ts:762, agent-settings.ts:330 `(_event, raw: unknown)`, agents.ts:54. Grep `senderFrame|fromTrustedFrame` across all of src/ returns zero matches.  
  Note: Unchanged. The delta added MORE direct registrations (agent-global-hooks.ts:217-227, one-click setup agents.ts:192-197), widening the unvalidated surface; compensating CSP/webview controls are intact, so net impact is level.

- **[still-open · medium] F3 — origins.ts is not the sole origin table; ORIGINPIN checks only one direction**  
  Now at: `scripts/check-originpin.mjs:100`  
  Evidence: Gate unchanged: :100-108 still only `for (const url of pinnedUrls) if (body.includes(url))` — origins.ts→elsewhere only. origins.ts:20 pins ONE url. Still outside the table: posthog-telemetry.ts:22 'https://us.i.posthog.com', usage-prices.ts:12 'https://models.dev/api.json', libfetch.ts:29-30, plus claude-adapter.ts:22 and cli-store.ts:135-136.  
  Recommendation: Move the four house origins into ORIGINS. Declare src/contracts/usage/index.ts:312-354 as the sanctioned second table via a commented ALLOWED-OUTSIDE list, then fail on any https literal in src/main or src/backend/features absent from both.  
  Note: Same defect, broader than scoped: usage/status adds more provider endpoints outside the table. Those ride the user's own credential, so a fix should separate house origins from provider endpoints rather than sweep in every literal.

- **[still-open · medium] F4 — Nothing tests that the preload allowlist actually refuses an unlisted channel**  
  Now at: `src/preload/index.ts:17`  
  Evidence: Diff vs baseline empty. :17 is still the whole boundary: `if (!allow.has(channel)) throw new Error("ipc channel not allowed: " + channel)`. lockdown-smoke.ts:7-22 still lists only CSP, inertness, dock, openExternal; its only bridge use is the positive :116. check-channels.mjs stops at 'all spread into AllChannels' (:44,:50) and never loads the preload.  
  Recommendation: As originally recommended, and cheap: lockdown-smoke.ts already has the ES() harness and emitter, so the arm is ~10 lines — invoke+send on 'mogging:not-a-channel' must both reject with 'ipc channel not allowed', plus the bridge-keys assert.  
  Note: Unchanged, and a gate-honesty exposure: the sweep gates the LIST, never the ENFORCEMENT, so deleting assertAllowed from `send` leaves every gate green.

- **[still-open · medium] F5 — No compile-time channel-to-payload binding; AllChannels erases its literal union**  
  Now at: `src/contracts/ipc/channels.ts:494`  
  Evidence: channels.ts changed (+23/-3, new brain draft/distill channels ~:485-491) but the defect line is untouched: :494 `export const AllChannels: readonly string[] = [`. bridge.ts:5-7 still `invoke(channel: string, payload?: unknown): Promise<unknown>`; terminal.client.ts:29-30 casts `as Promise<SpawnResult>` against daemon-relay.ts:379 (moved from :432). No IpcMap anywhere in src/contracts.  
  Note: The delta widened scope, not kind: six new brain channels (drafts/draftGet/draftPromote/draftDiscard/distillGet/distillSet) landed with payload shapes documented only in comments.

- **[still-open · medium] F6 — Terminal event fan-out is O(panes) across the context bridge, unmeasured by the perf gate**  
  Now at: `src/preload/index.ts:14`  
  Evidence: preload unchanged: :10-13 comment on one listener per terminal channel per pane, :14 `ipcRenderer.setMaxListeners(0)`. terminal.client.ts:67-74 still subscribes globally; terminal-pane.ts:326 still filters `if (e.id === this.id && !this.disposed) {`. Cap is real — pane.ts:30 `export const ABS_MAX_PANES = 32` — while the only IPC proof is multipane-smoke.ts:13 `const N = 8`.  
  Recommendation: Broaden the fix: add a generic preload `onPane(channel, paneId, cb)` backed by a Map so one ipcRenderer listener routes by id, and migrate every `paneId === this.id` site in terminal-pane.ts onto it. Raise multipane-smoke N from 8 toward ABS_MAX_PANES=32.  
  Note: terminal-pane.ts gained more per-pane global subscriptions filtered identically (:1030,:1130,:1156,:1472,:1707,:1751,:1754), so the same O(panes) crossing now spans role/context/chip/label/git channels too.

- **[still-open · low] F7 — docs/01 names the preload surface window.pty; the shipped surface is window.bridge**  
  Now at: `docs/01-architecture.md:18`  
  Evidence: Diff vs baseline empty. :16-18 still read 'All privileged ops go over typed IPC through the preload's single `window.pty` surface.' Shipped surface is src/preload/index.ts:20 `contextBridge.exposeInMainWorld('bridge', {…})`, with the non-channel member getPathForFile at :43.  
  Note: Unchanged, and it compounds F5: bridge.ts:5-7 is unknown-in/unknown-out, so the same sentence is wrong about both the surface NAME and the claim that the IPC is typed.

### security-hardening

- **[still-open · high] F1 — Env var can repoint a shipped build's brain registry origin**  
  Now at: `src/main/libfetch.ts:29`  
  Evidence: libfetch.ts identical to baseline. :29 `process.env.MOGGING_BRAIN_REGISTRY_NPM || 'https://registry.npmjs.org'`, :30 the _PY twin, :40 `if (url.protocol === 'https:') return true` — any https host passes. origins.ts:20 pins only the MCP registry. check-originpin.mjs:69 still `/process\.env\.MOGGING_\w*_BASE\b/`.  
  Recommendation: As originally recommended: add npmRegistry/pypi rows to origins.ts, delete both env reads, pass baseUrl from brain.ts, widen check-originpin.mjs:69 to `MOGGING_\w*(BASE|REGISTRY|ORIGIN|ENDPOINT|URL)\b`.  
  Note: Delta touched none of libfetch.ts, origins.ts, check-originpin.mjs. Severity unchanged: fetched text lands in agent context; ADR 0016 §6 forbids env-readable origins.

- **[still-open · medium] F2 — Remote-supplied OAuth authorize endpoint reaches openExternal unvalidated**  
  Now at: `src/main/connections.ts:518`  
  Evidence: :518 still `await shell.openExternal(buildAuthorizeUrl({ metadata, ... }))`. oauth.ts:211 returns on presence alone: `if (meta?.authorization_endpoint && meta.token_endpoint) return meta`. oauth.ts:307 `new URL(o.metadata.authorization_endpoint)` keeps any scheme. connections.ts:353 validConnectionUrl still guards only the pasted URL.  
  Recommendation: Better fix now: the predicate already exists at provider-catalog-data.ts:98-99. Extract a shared httpsOrLoopbackEndpoint() and apply at oauth.ts:211 (all three endpoints), re-assert at buildAuthorizeUrl:307. Goldens for `ms-msdt:` + UNC.  
  Note: The :585 half stays invalid, better cited: device endpoint is catalog-pinned at provider-catalog-data.ts:98-99 (`url.startsWith('https://')`), sole consumer connections.ts:453. Live trigger is a hostile self-hosted MCP server.

- **[still-open · medium] F3 — FUSES tamper proof has no negative control; darwin accepts any death**  
  Now at: `scripts/check-fuses.mjs:228`  
  Evidence: File unchanged since c026463. :228 `tamper.bit = died && (named || process.platform === 'darwin')` — any nonzero darwin exit reads as the fuse biting. No grep hit for baseline/untampered: the binary is never launched before the byte-40 flip at :206-207. The `named` stderr requirement (:227) stays win32-only.  
  Recommendation: As originally recommended: launch the untampered binary first with the same env/timeout, require it NOT die, store as tamper.baseline, fail 'does not launch cleanly even untampered' — only then accept a darwin death as the refusal.  
  Note: Original evidence misquoted slightly: :225-226 do carry a `timedOut` term (predates baseline), so a timeout-killed boot no longer reads as death. The missing baseline launch and blanket darwin acceptance are intact.

- **[still-open · medium] F4 — Nav guard treats every file:// URL on the machine as the app origin**  
  Now at: `src/main/window.ts:64`  
  Evidence: window.ts unchanged. :64 `url.startsWith('file:') || url === 'about:blank' || (!!devOrigin && url.startsWith(devOrigin))`, used by the will-navigate/will-redirect deny at :67-75. Same hole in the CSP-header twin at :46. Production still loads file:// at :212 `void win.loadFile(join(__dirname, '../renderer/index.html'))`.  
  Recommendation: As originally recommended: gate file: on `pathToFileURL(join(__dirname,'../renderer')).href` prefixing the URL, make the dev branch `new URL(url).origin === devOrigin`, apply both to isAppDoc at :44-46, extract isAppUrl for goldens.  
  Note: No change in the delta; hosted agent CLIs write local HTML constantly and the dev branch is still prefix-matched (localhost:5173.evil.tld). Severity unchanged.

- **[still-open · medium] F5 — mogging:// deep links run destructive verbs with no cwd validation**  
  Now at: `src/main/deep-link.ts:32`  
  Evidence: deep-link.ts unchanged. cwdFromUrl :27-36 ends :32 `return cwd ? cwd : null` — no absolute/exists/isDirectory/length check. sanitizeControl :70-73 caps 1024 chars only. Renderer acts unprompted: ui/features/workspace/index.ts:748 openForCwd, :762 `if (cmd.paneId) controller.closePaneById(cmd.paneId)`. setAsDefaultProtocolClient at :145-149.  
  Recommendation: As originally recommended: require cwd absolute, <=1024 chars, existsSync+isDirectory in cwdFromUrl and sanitizeControl before delivery; drop close-pane from the OS protocol association; add deep-link goldens.  
  Note: No change in the delta; `ls tests/unit | grep -c deep-link` = 0. A UNC cwd spawns shells against an SMB path on Windows only — platform divergence atop the destructive-verb gap.

- **[still-open · medium] F6 — macOS branch of runtime-isolation never checks the real runtime base**  
  Now at: `src/main/runtime-isolation.ts:59`  
  Evidence: File unchanged. Non-win32 refuses only two states: :51-57 XDG_RUNTIME_DIR unset, and :59 `if (platform === 'linux' && /^\/run\/user\//.test(runtime))`. No darwin check against the real base, which runtime-paths.ts:20 defines as `process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), 'Library', 'Application Support')`. win32 :36-48 does the equivalent.  
  Recommendation: As originally recommended: in the non-win32 branch refuse when canonicalized XDG_RUNTIME_DIR equals join(homedir,'Library','Application Support'), beside the /run/user check; add that darwin golden to the unit test.  
  Note: No change in the delta. Platform divergence: XDG_RUNTIME_DIR="$HOME/Library/Application Support" still passes on macOS, lands on the real run/v<N> tree and retires the installed daemon — what Windows is protected from.

- **[still-open · medium] F7 — grantFileProtocolExtraPrivileges absent from the 'exact' fuse wall**  
  Now at: `electron-builder.yml:147`  
  Evidence: electron-builder.yml gained +62 lines, none in the wall: electronFuses at :122 still declares exactly six keys ending :147 `onlyLoadAppFromAsar: true`. check-fuses.mjs EXPECTED :59-66 carries the same six (ending :65 OnlyLoadAppFromAsar); the loop at :138 iterates `Object.entries(EXPECTED)` only, so indices 6-8 copied into `wall` (:133-136) are never asserted.  
  Recommendation: As originally recommended: add `grantFileProtocolExtraPrivileges: false` to electronFuses and to EXPECTED, re-run LOCKDOWN to confirm boot, and make the check-fuses loop iterate every index present in `wire`.  
  Note: No change in the delta. Compounds F4 — production loads from file:// (window.ts:212) with a permissive nav guard, while the gate header claims 'EXACTLY the fuse wall'. Also a gate-honesty violation.

- **[still-open · low] F8 — Hardening comments cite the wrong ADR and the wrong docs file**  
  Now at: `scripts/qa-smokes.sh:308`  
  Evidence: :308 `# FUSES: ADR 0015 §hardening`, plus :323 and :433 — adr/0015 is board-github-write-back. :309-310 still says 'runAsNode ON until step 09' above a gate whose EXPECTED (check-fuses.mjs:59) is RunAsNode DISABLE. docs/18 cited at check-fuses.mjs:34, native-preflight.ts:89/:92, entitlements.ts:38, qa-smokes.sh:324; §honest limits is docs/19-accounts.md:55.  
  Recommendation: As originally recommended: retitle the qa-smokes.sh comments to 'ADR 0016 §hardening' with runAsNode OFF, repoint the five docs/18 citations to docs/19-accounts.md, fix adr/0016:174's label, extend check-docs-refs.mjs to match number to filename.  
  Note: No change in the delta; one extra stale site the original missed (qa-smokes.sh:324). check-docs-refs.mjs still passes because 18-board.md exists. adr/0016:174 still reads `See [docs/18](../19-accounts.md)`.

### error-resilience

- **[still-open · medium] F1 — Daemon sets sessions.db aside on ANY open failure, not just corruption**  
  Now at: `src/pty-daemon/index.ts:44`  
  Evidence: index.ts unchanged since c026463 (absent from git diff --stat). Lines 38-50 still: catch(e){ log('SESSION STORE OPEN FAILED'...); const aside = `${dbPath}.corrupt-...`; fs.renameSync(dbPath, aside) } with no error-shape test. grep of session-store.ts for corrupt/SQLITE_CORRUPT/NOTADB/malformed returns nothing.  
  Recommendation: As originally recommended: gate the rename on a corruption-shaped error (SQLITE_CORRUPT / SQLITE_NOTADB / 'malformed' / 'file is not a database') and rethrow everything else.  
  Note: Held at the prior verifier's corrected medium: data is set aside, not destroyed; the lock case self-guards (rename also fails, swallowed :46-48). Real triggers remain disk-full / permission splits during migration DDL.

- **[still-open · medium] F2 — Helper-ABI natives never preflighted; broken helper node-pty degrades every boot**  
  Now at: `src/main/native-preflight.ts:68`  
  Evidence: assertNativeModules still resolves only the Electron tree: require.resolve(`${mod}/package.json`) -> build/Release (:37) then require(addon) (:68). git log c026463..HEAD -- native-preflight.ts node-helper.ts native-require.ts: no commits. helperRuntime() still only existsSync(join(dir, HELPER_EXE)) (node-helper.ts:109-115). boot.ts:321-323 still the generic banner, no daemon.log tail.  
  Recommendation: Cheapest version now: have scripts/build-node-helper.mjs write an ABI stamp beside node_deps and compare it in helperRuntime(), avoiding a child-process launch on the boot path; plus the daemon.log tail in the degraded message.  
  Note: Untouched by the delta despite ADR 0017 work elsewhere. The new PATH repair (boot.ts:263-266) runs before assertNativeModules and does not touch helper natives.

- **[still-open · medium] F3 — Daemon spawn handler has no try/catch — a pty spawn throw becomes a blind 5s timeout**  
  Now at: `src/pty-daemon/transport.ts:175`  
  Evidence: git diff c026463..HEAD -- transport.ts touches only 'input'/'resize' gen-gating. The spawn closure is still `const spawn = (): void => { if (sock.destroyed) return; const { pane, existed } = sessions.ensure(m.id, spec)` (:173-175), unguarded through the reply/subscribe block; a throw still lands in the log-and-keep-serving handler at src/pty-daemon/index.ts:71 with no error frame.  
  Recommendation: As originally recommended: try/catch the ensure/reply/subscribe body and send({ t:'error', id:m.id, reason }); the client's spawn waiter already rejects on an error frame.  
  Note: The neighbouring 'badremote' send at :160 proves the error-frame channel works; only the throw path misses it. The new MOGGING_DAEMON_SPAWN_DELAY_MS seam (:194-195) runs spawn from a setTimeout, widening the gap.

- **[still-open · medium] F4 — Window opens only after daemon migrate+start — ~25 s of app with no UI**  
  Now at: `src/main/boot.ts:368`  
  Evidence: openWindow() is still at boot.ts:368, after `await startDaemonBackend(liveWebContents)` (:303) and the register* block (:326-366). No splash: window.ts:105 still `show: false`, and openWindow call sites are only boot.ts:187/201/368/420. boot.ts:227-228 still states '~25 s of boot away (daemon migrate + start + feature registration)'.  
  Recommendation: Open the window right after registerRuntimeHealth (boot.ts:284) — that now also covers the new PATH-repair wait, not just the daemon wait — and let the health banner narrate the rest.  
  Note: Slightly worse: the new PATH repair adds `await Promise.race([applyLivePathToProcess(), 4000ms])` at boot.ts:263-266 ahead of it. registerRuntimeHealth is still early (:284), so its health state still has no renderer.

- **[still-open · medium] F5 — fatal() frames every lifetime crash as a boot failure and offers no relaunch**  
  Now at: `src/main/fatal.ts:51`  
  Evidence: fatal.ts unchanged since c026463. installFatalHandlers still routes both channels for the app's whole lifetime (:62-63); fatal() still hardcodes dialog.showErrorBox('MoggingLabs Workspace failed to start', text) (:51), still tags captureError(..., { feature: 'boot', op, ... }) (:44), and ends at app.exit(1) (:56). No app.relaunch() anywhere in the file.  
  Recommendation: As originally recommended: a `booted` flag set in openWindow(); post-boot fatals take a 'crashed' title, a distinct telemetry op, and app.relaunch() before app.exit(1).  
  Note: The delta strengthened daemon survival (protocol v11, reconnect replay modes), which makes the missing relaunch path more valuable: sessions demonstrably survive the crash the user is told is a failure to start.

- **[still-open · low] F6 — Pre-ready fatal errors are silent in packaged builds — showErrorBox guard too strict**  
  Now at: `src/main/fatal.ts:49`  
  Evidence: Still `if (!headless && app.isReady()) { try { dialog.showErrorBox(...) } catch {} }` at fatal.ts:49-55; file unchanged since baseline. installFatalHandlers is still called before whenReady (boot.ts:233).  
  Recommendation: As originally recommended: drop the app.isReady() conjunct, keep !headless — the existing try/catch already covers a no-display host.  
  Note: Lowered from medium: the reachable pre-ready window is narrow (single-instance lock + installDeepLinkListeners, boot.ts:225-231); installCliRuntime's fatal() runs inside whenReady. Still a one-condition fix.

- **[still-open · low] F7 — ensureDaemon leaks the daemon.log fd on every spawn attempt**  
  Now at: `src/main/daemon-client.ts:313`  
  Evidence: `const logFd = fs.openSync(daemonSpawnLogPath(), 'a')` still at :313, passed to `stdio: ['ignore', logFd, logFd]` at :327; grep closeSync|logFd over the file matches only those two lines — no close on any path, including the throw at :336. The file was edited in the delta (replay modes), so this is current code.  
  Recommendation: As originally recommended: fs.closeSync(logFd) in a try/finally around spawn() — the detached child holds its own duplicate.  
  Note: Unchanged. The Windows half is sharper (lingering open handles on daemon.log block rotation/deletion), a parity-law smell even though the leak itself is cross-platform.

- **[still-open · low] F8 — async-state.ts (finding-39 policy) has zero unit tests**  
  Now at: `src/ui/core/async/async-state.ts:134`  
  Evidence: tests/unit holds 34 files, none matching async; grep for createAsyncGuard|describeAsyncError|async-state across tests/ and src/main/smokes matches exactly one file, src/main/smokes/asyncstate-smoke.ts. The untested rules are still there: IPC_NOISE at :118-124 and `const unreadable = !raw || raw.length > 140 || IPC_NOISE.some((re) => re.test(raw))` at :134.  
  Recommendation: As originally recommended: tests/unit/async-state.test.ts for each IPC_NOISE pattern, IPC_WRAPPER stripping, the >140-char fallback, stale-generation suppression, and timeoutMs.  
  Note: The delta added surfaces that all route failures here (wizard redesign, one-click agent setup, OAuth device flow), so the drift surface grew while coverage stayed zero; the slow gate smoke is still the only guard.

### ci-workflows

- **[still-open · high] F1 — BOOTFAIL gates certify green on linux/macos nightly sweeps**  
  Now at: `scripts/check-sweep-log.sh:10`  
  Evidence: File untouched since c026463. Line 10 still `grep -cE ' (FAIL|MISSING)$'` — cannot match a row `NAME BOOTFAIL`, so :14 prints ALL GATES PASS. Verdict still set at qa-smokes.sh:143 `v="BOOTFAIL"`. ci.yml:305 `' | tee sweep.log` and :389 still lack `shell: bash`, so default `bash -e` (no pipefail) eats qa-smokes' exit 1 (:660); only windows sets it (ci.yml:461).  
  Recommendation: As originally recommended: make check-sweep-log.sh:10 `grep -cvE ' PASS$'` over the rows after SWEEP RESULTS (mirroring qa-smokes.sh:653), and add `shell: bash` to the linux (ci.yml:299) and macos (ci.yml:387) Full-sweep steps.  
  Note: Unchanged. Violates gate honesty (a gate that never ran certifies green) and win/mac parity. The ci.yml delta was only 199->207 comment bumps plus two weight-gate steps — nothing touched this.

- **[still-open · medium] F2 — Release artifacts are never weighed — the WEIGHT gate's 'last stop' is manual-only**  
  Now at: `.github/workflows/release.yml:229`  
  Evidence: release.yml untouched since c026463; grep for check-package-weight in it returns nothing. It still runs only the fuse gate (:229-235) then uploads (:239-245). WEIGHT exists only at ci.yml:223-224 (linux-boot) and ci.yml:538-542, the latter behind `if: ... inputs.signing_dryrun == true` (ci.yml:484). ci.yml:537 still calls that 'the last stop before a release'.  
  Recommendation: Insert a 'Package weight gate' at release.yml:236, copying that job's three-branch APP resolution (release.yml:232-234, better than signing-dryrun's two-branch one) with MOGGING_WEIGHT_APP. Soften ci.yml:537 to point at release.yml.  
  Note: The delta added WEIGHT in two new places (ci.yml:223-224 per-push linux, :538-542 dispatch) but not the release path. Linux is now shape-covered per push; Windows NSIS and macOS release artifacts still ship unweighed. Medium stands.

- **[still-open · medium] F3 — CI cache key omits prune-helper-deps.mjs, serving stale helper trees**  
  Now at: `.github/workflows/ci.yml:183`  
  Evidence: All four nm-cache keys are identical and still omit it — ci.yml:183, :273, :367, :443 hash only package-lock.json, build-node-helper.mjs, build-device-key.mjs, binding.gyp and device-key/src/**, suffix -e36. prune-helper-deps.mjs is live: build-node-helper.mjs:46 imports pruneHelperDeps. `build/node-helper` is in the cached path (:181) and the rebuild is skipped on hit (:188).  
  Recommendation: Add 'scripts/prune-helper-deps.mjs' to hashFiles() in all FOUR blocks (ci.yml:183, 273, 367, 443 — the macos copy at 367 was not in the original list) and bump -e36 to -e37.  
  Note: Unchanged. The key's own comment (ci.yml:176-178) still promises 'a source edit can never serve a stale artifact' — false for the one file deciding what ships in build/node-helper, which WEIGHT (ci.yml:224) then reads off the cache.

- **[still-open · medium] F4 — kill-devservers on macOS/Linux SIGKILLs any process whose argv names the repo**  
  Now at: `scripts/kill-devservers.mjs:76`  
  Evidence: File unchanged since c026463. POSIX snapshot still keeps any ps row merely containing the repo path (:72 `.filter((l) => l.includes(repo) && ...)`) and :76 still defaults the unrecognized to electron: `... : cmd.includes('esbuild') ? 'esbuild.exe' : 'electron.exe'`, which TIERS kills at :45 unless argv has 'daemon.js'. Windows still filters by exe name first (:53).  
  Recommendation: As originally recommended: in the POSIX branch require the executable to resolve under `<repo>/node_modules` (electron/esbuild) or args to contain 'electron-vite', instead of defaulting unknown repo-path rows to 'electron.exe' at line 76.  
  Note: Severity unchanged; blast radius grew — the sweep is now 207 gates (qa-smokes.sh:12) and kill_devserver runs after each of ~175 boot smokes (:161). The SAFETY comment at :26-28 claims a node_modules constraint the POSIX code never applies.

- **[still-open · medium] F5 — No per-push app-boot gate on Windows/macOS — only Linux boots per push**  
  Now at: `.github/workflows/ci.yml:150`  
  Evidence: Jobs at HEAD: verify(36), linux-boot(150), linux-sweep(230), macos-sweep(328), windows-sweep(412), signing-dryrun(482), manifests-winget(547), manifests-brew(568) — no windows-boot/macos-boot. Only linux-boot boots per push: SMOKE :194-205, electron-builder --linux :211, fuse :217, weight :224. The 3-OS verify matrix (:36-145) stops at typecheck/lint/unit/static + build + bytecode.  
  Recommendation: Add a windows-boot job mirroring linux-boot's cheap slice (cache + rebuild + MOGGING_SMOKE boot + electron-builder --dir + fuse/weight), `if: github.event_name == 'push'` if PR cost matters. Every run step needs `shell: bash` (ci.yml:410, 516-518).  
  Note: The delta widened the gap: a37ff5e added the per-push weight gate to linux-boot only (:223-224), so Windows — whose NSIS double-write is WEIGHT's stated motivation (:220-222) — has no per-push packaging gate at all.

- **[still-open · low] F7 — WEIGHT gate run as a subset without FUSES fails on environment, not product**  
  Now at: `scripts/check-package-weight.mjs:40`  
  Evidence: qa-smokes.sh:315 still says WEIGHT reads 'the tree FUSES just packaged'; FUSES (:314) and WEIGHT (:322) are independent run_static rows. should_run() (:113-116) is a plain membership `case`, no implication. check-package-weight.mjs:40-44 is still `if (!existsSync(appDir)) { ... process.exit(1) }`, which run_static (:180) records as `RESULTS+=("$name FAIL")`. ci.yml:14-17 still allows any subset.  
  Recommendation: Prefer the qa-smokes side now the message exists: make should_run() have WEIGHT imply FUSES under MOGGING_GATES (the both-or-neither rule at qa-smokes.sh:109-111), and extend the check-package-weight.mjs:42 pointer to name FUSES.  
  Note: Half of option (b) exists — :41-42 says 'nothing to weigh' with a pointer — but it names `npm run dist:*`/MOGGING_WEIGHT_APP, never FUSES, and still exits 1, so the sweep logs red on environment. The stale-local-dist half is untouched.

- **[fixed · none] F6 — The 'uncommitted ci.yml diff' is a superseded stash; popping it regresses prose**  
  Now at: `.github/workflows/ci.yml:7`  
  Evidence: The stash is gone: `git stash list` prints nothing and `git log -g refs/stash` errors 'ambiguous argument refs/stash: unknown revision' — the ref does not exist. `git status --porcelain` and `git diff -- .github/workflows/ci.yml` are both empty. Prose is consistent: ci.yml:7/149/226/404 all say 207, qa-smokes.sh:12 derives '207 gates: 32 static + 175 app-boot'.  
  Recommendation: No action. The stash is unrecoverable, so any wanted RESTOREDIMS ordering must be re-derived from a37ff5e/b7fe6e3.  
  Note: Fixed on the ref's absence, not on the file changing — refs/stash no longer resolves, so it cannot be popped. Nothing unique lost: the WEIGHT gates landed at ci.yml:223-224/538-542 and the prune rules as prune-helper-deps.mjs, via a37ff5e.
  Challenger: agrees — HEAD cbda0ec: no refs/stash file or reflog; `git stash pop` returns "No stash entries found"; tree clean, one worktree. Only surviving '201-gate' text is the audit doc (docs/research/2026-08-01-full-feature-audit.md:1878). ci.yml:7/149/226/404 all say 207; check-gate-count.mjs exits 0 "207 gates, 13 claims agree". Pop path unreachable.

### cli-ux

- **[still-open · medium] F1 — Typo'd verb silently cold-starts the app as a deep-link, exit 0**  
  Now at: `bin/mogging.mjs:62`  
  Evidence: Line 62 still `else runOpen(argv)`. runOpen:804 `const dir = resolve(args[0] ?? '.')`, spawns the deep link (805-813), prints 'mogging: opening workspace for '+dir (814) — no statSync. runCwd:950 still guards `if (!statSync(cwd).isDirectory()) throw` -> exit 2. git diff c026463..HEAD -- bin/mogging.mjs is one hunk: PROTOCOL_VERSION 10->11.  
  Recommendation: as originally recommended — statSync the resolved dir in runOpen; on ENOENT print 'unknown command or missing directory <arg>' to stderr and exit 2, keeping bare `mogging` / `mogging .` working.  
  Note: Held; bin/ untouched by the delta. Note the F3 interaction: the command docs/09 gives remote operators (`mogging endpoint --path`) is itself unrecognized, so F1 is what makes F3 launch an app.

- **[still-open · medium] F2 — Global --dev filter strips the token from send/mail/recall payloads**  
  Now at: `bin/mogging.mjs:32`  
  Evidence: L32 `const CHANNEL = process.argv.includes('--dev') || process.env.MOGGING_CHANNEL === 'dev' ? 'dev' : 'prod'`; L36 `const argv = process.argv.slice(2).filter((a) => a !== '--dev')`. runSend (1113-1133) has no `--` terminator (1115 filters --no-enter, 1117 joins). runRecall still drops a literal '--' at L251 `.filter((a) => a !== '--')`. runMailSend 637-665 likewise.  
  Recommendation: as originally recommended — scan only the verb+flags region for `--dev`, and honor a `--` terminator in runSend/runMailSend/runRecall (stop stripping literal '--' at L251). Extend the terminator to `--no-enter` too.  
  Note: Held. Same class also hits --no-enter: L1115 filters it from anywhere in argv, so that literal can never be typed. Protocol v11's gen is optional on the input frame (protocol.ts:274), so this stays pure arg-parsing.

- **[still-open · medium] F3 — `mogging endpoint --path` documented but not implemented**  
  Now at: `docs/09-swarm.md:113`  
  Evidence: docs/09-swarm.md:113 still `ssh -R /tmp/mogging.sock:$(mogging endpoint --path) host`. Dispatch (bin/mogging.mjs:39-62) still has no `endpoint` verb; grep of bin/mogging.mjs finds only comments plus internal helpers endpointFilePath() (821-824) and readEndpoint() (826). git diff c026463..HEAD -- docs/09-swarm.md is empty. The doc's command falls through L62 to runOpen.  
  Recommendation: Add an `endpoint` verb printing endpointFilePath() for `--path` (socket address from readEndpoint() for the bare form), exit 3 when absent — ~6 lines on existing helpers. Else fix docs:113 to the MOGGING_DAEMON_ENDPOINT form on line 114.  
  Note: Held. The value the verb would print already exists: endpointFilePath() at bin/mogging.mjs:821 returns MOGGING_DAEMON_ENDPOINT or runFile(RUN_SEGMENT,'endpoint.json').

- **[still-open · medium] F4 — `mogging list` omits the ROLE column; docs/06 column list also stale**  
  Now at: `bin/mogging.mjs:1082`  
  Evidence: runList's mapper (1082-1088) still builds only {id,size,state,remote,title}; L1096 prints line('ID','SIZE','STATE','REMOTE','TITLE'). PaneInfo.role still on the welcome payload at src/contracts/daemon/protocol.ts:248. docs/09-swarm.md:11 still says roles 'enrich `mogging list`'; docs/06-control-api.md:11 still says 'ID SIZE STATE TITLE'. Both docs byte-identical to baseline.  
  Recommendation: as originally recommended — add `role: p.role ?? ''` to the mapper at 1082-1088, widen the w()/line() helpers (1089-1097), and update docs/06-control-api.md:11 to `ID SIZE STATE ROLE REMOTE TITLE`.  
  Note: Held. Purely a rendering gap — sibling verbs already render role: runOwners:617 `c.role`, runMailRead:688 `msg.role`.

- **[still-open · low] F5 — `mogging approve` exits 6 when the pane token env is merely missing**  
  Now at: `bin/mogging.mjs:453`  
  Evidence: runApprove 452-456 unchanged: `const token = process.env.MOGGING_PANE_TOKEN` then `if (!token) { ...'pane credential missing'...; process.exit(6) }`. paneTokenOrUsage() at 546-553 still exits 2 for the identical condition, used by runClaim:559 and runMailSend:650. docs/09-swarm.md:159 still defines 6 as 'not the reviewer'; 6 stays correct for the daemon frame at 495-497.  
  Recommendation: as originally recommended — replace lines 452-456 with `const token = paneTokenOrUsage()` so a missing credential exits 2, leaving 6 for the daemon's notreviewer frame already handled at 495-497.  
  Note: Held at low. Confirmed the two pane-bound verb families still disagree on the same env condition; fix is a one-line substitution.

- **[still-open · low] F6 — owners/approvals/mail-read/role drop daemon error frames -> timeout exit 3**  
  Now at: `bin/mogging.mjs:610`  
  Evidence: All four unchanged: runOwners:610 `if (m.t !== 'owners') return`; runApprovals:514 `if (m.t !== 'approvals') return`; runMailRead:681 `if (m.t !== 'mail') return`; runRole:705-711 handles only 'role-set', no error branch. The precedent comment survives at 1100-1101 and runList:1102-1106 is still the only read verb with the error guard.  
  Recommendation: Prefer the structural fix: give withDaemon a default so any `{t:'error'}` frame unconsumed by the verb's onMessage prints 'rejected (<reason>)' and finishes 1 — that also retires runList's bespoke guard at 1102-1106.  
  Note: Held at low — still latent (no daemon error path for these reads). Protocol v11 gen-gating (protocol.ts:274) widens the future rejection surface slightly, not enough to raise severity.

- **[still-open · low] F7 — `mogging --help` prints usage to stderr with exit 0**  
  Now at: `bin/mogging.mjs:65`  
  Evidence: usage(code) at 64-83 still opens with `process.stderr.write(` on L65 unconditionally, and L61 `else if (cmd === '--help' || cmd === '-h' || cmd === 'help') usage(0)` still routes the success path through it. `mogging --help | grep send` still yields nothing on stdout.  
  Recommendation: as originally recommended — in usage(code) write to process.stdout when code === 0, stderr otherwise; add tests/unit/cli-args.test.ts driving bin/mogging.mjs dispatch and filters, covering F1, F2 and F7 in one file.  
  Note: Held. The second half of the recommendation is also unmet: tests/unit holds 34 test files and none covers bin/mogging.mjs arg parsing, so F1, F2 and F7 remain untested.

### window-chrome-clipboard

- **[still-open · high] F1 — CRLF read-back breaks remove's clipboard-clear promise and duplicates entries on Windows**  
  Now at: `src/main/clipboard.ts:371`  
  Evidence: git diff c026463..HEAD -- src/main/clipboard.ts is EMPTY. Still raw: :371 `} else if (gone.text && readClipboardText() === gone.text) {`; poll :235 `if (text && text !== lastText) {`; dedupe :173 `... === key)`. sameText is still declared INSIDE the write handler (:295) and used only at :296. Promise live at settings/clipboard.ts:106. clipboard-smoke.ts: zero CRLF/multi-line cases.  
  Recommendation: As originally recommended: hoist sameText (:295) to module scope, apply at :371, :235, :172-173. Add the multi-line Windows case to CLIPBOARD — that arm also settles the read-back question empirically.  
  Note: Unchanged. Rests on Windows reading LF-written text back as CRLF — asserted in the repo's own write-path comment (:289-294), never proven, which is exactly why the missing smoke arm matters.

- **[still-open · medium] F2 — restore and writeEntry skip the write verification the write path was hardened with**  
  Now at: `src/main/clipboard.ts:346`  
  Evidence: File unchanged. write still verifies at :296 `if (text && !sameText(clipboard.readText(), text)) throw ...`. restore does not: :343 writeClipboardImage(img) / :346 writeClipboardText(entry.text), then re-dates at :350-351. writeEntry bare at :308 and :314. writeClipboardText (:85-88) throws only on the injected test fault. settings/clipboard.ts:96-98 toasts 'Copied', no catch.  
  Note: Unchanged. restoreEntry (clipboard-port.ts:177) is a bare invoke, so with main never rejecting, the success toast always fires and history reorders while the clipboard is untouched.

- **[still-open · medium] F3 — Destructive confirms are session-silenceable via rememberKey, against the 8.5 promise**  
  Now at: `src/ui/components/confirm.ts:30`  
  Evidence: confirm.ts unchanged. :30 `if (opts.rememberKey && sessionSkip.has(opts.rememberKey)) return Promise.resolve(true)` — unconditioned on danger; checkbox at :39 likewise. agent-config.ts:465-466 still passes `danger: true` with `rememberKey` on the permission-bypass confirm. Promise at docs/02:147 and docs/11:358. Invariant still convention-only (controller.ts:1032).  
  Note: Severity holds; reach grew. ADR 0022 added a SECOND rememberKey confirm at agent-config.ts:426-431 (consentCrossAccount) — correctly non-danger, so it is proof that blanket rememberKey removal is wrong and a danger-gate is right.

- **[still-open · medium] F4 — F11 is dead while the browser dock guest holds focus**  
  Now at: `src/main/browser-dock.ts:334`  
  Evidence: browser-dock.ts and window.ts both unchanged. Guest relay still bails first: :334-335 `const mod = input.control || input.meta` / `if (!mod) return`; allow-list at :337-341 is Ctrl/Cmd-only (KeyU/E/B/K/F/L/zoom), no F11. Repo-wide grep for F11|setFullScreen|togglefullscreen: the only keyboard handler is window.ts:182-185 on the HOST webContents, which never fires for guest input.  
  Recommendation: As originally recommended, but prefer the guestChord relay variant: browser-dock.ts:329-331 states 'the DECISION stays in the renderer (no shortcut logic here)', so a raw setFullScreen here would contradict the comment directly above it.  
  Note: Unchanged. Literal dead gap against 'event-driven F11 with zero dead gap' (docs/02:81): open the dock, click into the page, press F11 — nothing on Windows/Linux.

- **[still-open · medium] F5 — Packaged macOS has no keyboard fullscreen toggle while Windows/Linux get F11**  
  Now at: `src/main/menu.ts:32`  
  Evidence: menu.ts unchanged. Packaged darwin template still `...(app.isPackaged ? [] : [{ role: 'viewMenu' as const }])` at :32 — viewMenu is the only carrier of togglefullscreen/Ctrl+Cmd+F; windowMenu (:33) carries minimize/zoom/front. Repo-wide grep: no `togglefullscreen` role anywhere in src/. window.ts:182 still gates F11 to `process.platform !== 'darwin'`.  
  Recommendation: As originally recommended: add { role: 'togglefullscreen' } to the packaged darwin template. Given menu.ts's stated no-dev-affordances-when-packaged policy, append it inside the existing windowMenu rather than reintroduce a View menu.  
  Note: Held at medium, not raised, with one caveat unsettleable from source: AppKit auto-inserts 'Enter Full Screen' only where a View menu exists, and a user could bind it system-wide. The app-side template gap is verified true either way.

- **[still-open · medium] F6 — sanitizePaste's paste-jacking defense has zero test coverage**  
  Now at: `src/ui/core/clipboard/clipboard-port.ts:226`  
  Evidence: Intact and untested: :226-229 `const body = text.replace(END_SENTINEL_RE, '').replace(/\r?\n/g, CR)`; parseOsc52 at :268-290. tests/unit holds 34 files, none clipboard/paste/OSC — grep for sanitizePaste|parseOsc52 across src/ and tests/ hits only clipboard-port.ts and terminal-pane.ts, never a test. clipboard-smoke.ts still returns 0 for 201|sanitize|bracket.  
  Recommendation: As originally recommended (tests/unit/clipboard-paste.test.ts: embedded ESC[201~, CRLF and lone \n -> CR, bracketed on/off, parseOsc52 read-'?'/empty/>1MB/bad-base64/UTF-8). F1 needs CRLF cases too — land both on one fixture.  
  Note: Line moved 236 -> 226 only because the delta deleted quoteDroppedPaths/quoteWithFlavor earlier in the file (+3/-13); the body is untouched. That refactor with no gate behind the security half is mild evidence FOR the finding.

- **[still-open · low] F7 — History broadcast reships every image data URL to every window on each change**  
  Now at: `src/main/clipboard.ts:103`  
  Evidence: Unchanged. toWire strips only text — :103-105 `return { ...e, text: '' }` — and broadcast ships the whole ring to every window on every record/remove/restore/clear (:107-112). The `history` handler at :327 uses the same toWire. Bounds as cited: CLIPBOARD_MAX_ENTRY_BYTES = 256*1024 at contracts/ipc/clipboard.ipc.ts:103, CLIPBOARD_HISTORY_LIMIT = 100 at :99.  
  Recommendation: As originally recommended. Cheapest shape: extend toWire to blank imageDataUrl exactly as it blanks text — already the single choke point for both the broadcast and the history handler (:327) — plus a per-id thumbnail fetch mirroring restore-by-id.  
  Note: Low stands. recordImage downscales oversize images to a 240px thumbnail before recording (:200-211), so the worst case is bounded at ~100 x 256KB per window per change — a standing docs/05 tax, not a correctness bug.

### home-updates-ui

- **[still-open · medium] F1 — Updater push() can hard-exit the app when a state push lands on a destroyed webContents**  
  Now at: `src/main/updater.ts:55`  
  Evidence: `git diff c026463..HEAD -- src/main/updater.ts` is EMPTY. Line 55 still: `getWin?.()?.webContents.send(UpdateChannels.state, last)` — window null-check only, no isDestroyed(). Chain intact: boot.ts:394 and :404 wire raw `initAutoUpdate(() => win)`, not the guarded `liveWebContents()` at boot.ts:209-212; fatal.ts:62 uncaughtException -> fatal.ts:56 `app.exit(1)`.  
  Recommendation: Better than the original per-callsite guard: retype initAutoUpdate's param as `() => WebContents | null` and pass boot.ts's existing `liveWebContents` at :394/:404, so push() becomes `liveWebContents()?.send(...)` — one shared guard.  
  Note: Held at the prior verifier's medium, not the original HIGH: needs a download in flight at the exact ms of window destroy. Nothing in the 32-commit delta widened or narrowed that window.

- **[still-open · medium] F2 — Rail row and ready toast never seed from stateGet; pending update invisible after reopen**  
  Now at: `src/ui/features/updates/index.ts:90`  
  Evidence: `git diff c026463..HEAD -- src/ui/features/updates` is EMPTY. mount() still only does `bridge.on(UpdateChannels.state, ...)` (line 90); grepping `stateGet` finds renderer callers ONLY at settings/updates.ts:120 plus three smokes. Main still holds it for late subscribers (updater.ts:49 `let last`, served at :247), and boot.ts:419-421 still recreates the window on macOS 'activate'.  
  Recommendation: As originally recommended: extract the bridge.on body into onState(s), then add `void bridge.invoke(UpdateChannels.stateGet, undefined).then((s) => onState(s as UpdateState))` at mount. settings/updates.ts:118-120 is the exact pattern to copy.  
  Note: The delta added boot.ts:399 claiming 'the renderer's update UX calls both the moment it mounts' — only half true: Settings pulls, the rail/dot/toast feature does not. The stale comment hides the gap rather than closing it.

- **[still-open · medium] F3 — No changelog / "What's new" surfacing anywhere in the update UX**  
  Now at: `src/ui/features/updates/index.ts:111`  
  Evidence: Ready toast (index.ts:111-131) still offers only `v${s.version} is ready` + Restart now / Later. Settings § Updates (settings/updates.ts:126-141) renders version/status/last-checked only. No CHANGELOG.md at root, no scripts/gen-changelog.mjs, no releaseNotes on UpdateState (contracts/ipc/update.ipc.ts:11). phase-launch/CHECKLIST.md:179-183 still unchecked.  
  Recommendation: Interim, since no pipeline exists: add a 'What's new' link on the ready toast and in the Settings status row pointing at the GitHub release tag for s.version — no new contract field, swappable for changelog.json when phase-launch/21 lands.  
  Note: Untouched by the delta; planned-but-unlanded work, not a regression. Still a real honesty cost: the user is asked to restart with zero information about what the update contains.

- **[still-open · low] F4 — Titlebar dot appears during every 'checking' phase claiming "Downloading an update…"**  
  Now at: `src/ui/features/updates/index.ts:96`  
  Evidence: Unchanged. Line 96: `const downloading = s.phase === 'checking' || s.phase === 'available' || s.phase === 'downloading'`, feeding `dot.hidden = !downloading` (line 97). The tooltip is set once at line 37 (`dot.title = 'Downloading an update…'`) and rewritten only inside the `s.phase === 'downloading'` branch (line 101). The comment at line 35 still says 'visible only mid-download'.  
  Recommendation: Prefer a phase-aware title over dropping the phase: `dot.title = s.phase === 'checking' ? 'Checking for updates…' : 'Downloading an update…'`, so the quiet check keeps a presence without claiming a download.  
  Note: Unchanged. One correction: the auditor quoted the condition as `'checking' || 'available' || ...`; the real line repeats `s.phase ===` on each arm, so it is not an always-truthy bug — only 'checking' being in the set while the title lies.

- **[still-open · low] F5 — firstrun.ts header claims copy-only, never-installs; card ships one-click installers**  
  Now at: `src/ui/features/home/firstrun.ts:15`  
  Evidence: firstrun.ts changed (+34/-28) but the doc-comment hunk is absent from the diff. Lines 15-17 still say 'NEVER installs anything, runs no elevated command... offers copy buttons only (the user installs — ADR 0002).' Lines 141-155 now build `createAgentSetupPanel({agentId: m.id, ...})` per missing CLI and append `panel.action` (Install). phase-6/06 Guardrails repeat the never-installs rule.  
  Recommendation: Rewrite the 12-21 header to match what ships (shared non-elevated one-click setup panel; setup.ts refuses sudo; never brokers auth per ADR 0002) and amend the phase-6/06 guardrail bullet, hoisting the rationale already at lines 132-140.  
  Note: The delta sharpened the drift: the new comment at firstrun.ts:132-140 argues at length that installing IS correct and ADR 0002 concerns auth — contradicting the header eight lines above. Two opposing directives now sit in one file.

- **[still-open · low] F6 — "Setup complete" toast fires on boot for users whose checklist was never shown**  
  Now at: `src/ui/features/home/firstrun.ts:209`  
  Evidence: Branch untouched by the delta. Line 209 still `if (rows.every((r) => r.done || r.optional)) {`, then setDismissed() and, guarded only by per-instance `completedToasted` (line 86), `showToast({tone:'success', title:'Setup complete'...})` at line 215. Sole precondition: isDismissed() false at line 198 — a renderer localStorage key — while main-side stores deciding `done` survive it.  
  Recommendation: As originally recommended: set a wasIncomplete flag in the render path (lines 219-227) and gate line 212 on `wasIncomplete && !completedToasted`; otherwise call setDismissed() silently.  
  Note: Unchanged. `completedToasted` only de-dupes within a session; it does not encode 'the card was ever incomplete', so it does not touch this trigger path.

### a11y

- **[still-open · high] F1 — Collapsed rail leaves every workspace-switch button with an empty accessible name**  
  Now at: `src/ui/features/workspace/controller.ts:550`  
  Evidence: Still nameless: `activate.className = 'ws-tab-activate'` (551), `activate.append(iconEl, label)` (561); only name is `label.textContent = meta.name` (560). grep aria-label in file returns just :580 (close btn), :664 (rename input). global.css:1979 `.rail-collapsed .ws-label` -> `display: none` (1983); :1961 same for auto-collapsed.  
  Recommendation: Prefer the second original option: swap `display: none` on `.ws-label` (global.css:1979/:1961) for the .sr-only recipe. Fixes collapsed naming in one place and cannot drift out of sync with rename (controller.ts:674).  
  Note: Code and severity unchanged; the baseline diff of controller.ts is one unrelated remote-cwd hunk at :499. Auto-collapse means the user need not opt in to reach the broken state.

- **[still-open · high] F3 — Terminal content has no screen-reader path: xterm screenReaderMode never enabled**  
  Now at: `src/ui/features/terminal/terminal-pane.ts:170`  
  Evidence: `new Terminal({...})` (170-193) sets fontFamily, fontSize, lineHeight, cursorBlink, allowProposedApi, scrollback, macOptionClickForcesSelection, theme -- no screenReaderMode. `grep -rn screenReaderMode src/` returns zero hits repo-wide. The baseline diff of this file is +64/-11 (ConPTY/windowsPty ordering) with no line matching aria|screen|label|role.  
  Note: Holds. The delta arguably widens the gap: ConPTY v2 and replay-integrity work invested heavily in pane content correctness while that content stays unexposed to AT. Silent identically on both platforms, so no divergence.

- **[still-open · medium] F2 — Active-workspace state (aria-current) sits on the wrapper div, not the focusable button**  
  Now at: `src/ui/features/workspace/controller.ts:749`  
  Evidence: switch() still stamps the wrapper: `if (on) v.tab.setAttribute('aria-current', 'true')` / `else v.tab.removeAttribute('aria-current')` (749-750). v.tab is the plain `div.workspace-tab` (541-542, deliberately not role=button per the 537-540 comment). grep aria-current returns only 749/750; nothing sets it on `activate`.  
  Note: Unchanged. Now provably compounds F1: the click path forces `activate.focus({ preventScroll: true })` (controller.ts:606), so the focused element has neither name nor state.

- **[still-open · medium] F4 — Assertive live-region channel is dead code; refusals and danger toasts are all polite**  
  Now at: `src/ui/components/toast.ts:103`  
  Evidence: Still `el('div', { class: ..., role: 'status' }, [` (toast.ts:103); tone reaches only class + icon. Host is polite too (`'aria-live': 'polite'`, :44). `danger: 'alert'` (:32) is a TONE_ICON IconName, not a role. announce(msg, assertive=false) (live-region.ts:25) still has exactly two callers, both omitting the flag: usage/index.ts:245, controller.ts:996.  
  Note: Unchanged; TOAST_DEFAULT_MS still 6000 (toast.ts:21). Custody exposure grew: the delta added OAuth device flow and shared-defaults, both surfacing save-time refusals that reach AT only via the polite queue.

- **[still-open · low] F5 — Modal entry focus can land on a disabled control and silently focus nothing**  
  Now at: `src/ui/components/modal.ts:127`  
  Evidence: Unchanged: `panel.querySelector<HTMLElement>('input, select, textarea, button:not(.modal-close)') ??` (127) -> `.modal-close` (128) -> `panel` (129) -> `entry.focus()` (130), with no [disabled] filter. overlay-trap.ts FOCUSABLE (18-25) already spells out `button:not([disabled])` etc. trapOverlay(panel) runs first at modal.ts:120, so a no-op focus strands focus in the inerted shell.  
  Note: Stays low (needs a modal whose first control opens disabled), but the trigger surface grew: the wizard redesign and one-click agent setup are step-gated UIs where a disabled primary on entry is normal.

- **[still-open · low] F6 — A11YMODAL gate never exercises nested traps -- the refcounted inert path is untested**  
  Now at: `src/main/smokes/a11ymodal-smoke.ts:95`  
  Evidence: `git diff --stat c026463..HEAD` shows the file byte-identical to baseline. Three single-level scenarios only: 'modal' (95-155), 'palette' (157-212), tab/close DOM check (222-229); verdict `pass: modalOk && paletteOk && tabOk` (:286). Inert asserts are one-trap (:109, :152, :184, :192). overlay-trap.ts still holds the untested refcount (:54, :90-93).  
  Note: Low as a defect but a live gate-honesty exposure: a refcount regression at overlay-trap.ts:90-96 would un-inert the shell under an open wizard with A11YMODAL green. The wizard redesign raises the odds of confirm-over-wizard.

- **[still-open · low] F7 — docs/11 cites the AA probe and setshell smoke at paths that do not exist**  
  Now at: `docs/11-design-system.md:12`  
  Evidence: docs/11:12 still says the math lives in `src/main/setshell-smoke.ts` and :28 says 8.5/06 lifts the probe into `src/main/aa-probe.ts`. `ls` on both -> 'No such file or directory'; the real files are src/main/smokes/setshell-smoke.ts and src/main/smokes/aa-probe.ts. `git diff --stat c026463..HEAD -- docs/11-design-system.md` reports no change.  
  Recommendation: Fix both citations to src/main/smokes/... Then extend scripts/check-docs-refs.mjs with a second pass over backticked tokens matching /^(src|scripts|docs|bin)\/\S+\.(ts|mjs|md|css)$/, existsSync'd alongside the LINK pass at :39-47.  
  Note: Unchanged. The original fix idea is not actionable as written: check-docs-refs.mjs matches only markdown links (LINK regex, :35), has no path list, and is blind to backticked paths by design.

### deps-hygiene

- **[still-open · high] F1 — Helper natives ship with unpinned, integrity-unchecked transitive deps**  
  Now at: `scripts/build-node-helper.mjs:243`  
  Evidence: Line 243 byte-identical: `const NPM_ARGS = ['install','--no-audit','--no-fund','--no-package-lock','--omit=dev']`. :225 pins only NATIVE_DEPS. New prune-helper-deps.mjs:26 `HELPER_RUNTIME_DEPS = ['node-pty','better-sqlite3','bindings','file-uri-to-path']` — the unlocked transitives are explicitly kept and shipped.  
  Recommendation: Better fix now: the helper package.json is generated (:218-230) and the ship-list enumerated (prune-helper-deps.mjs:26). Emit all four with resolved+integrity from the root lockfile, commit a helper lock, and switch NPM_ARGS to `ci`.  
  Note: Unchanged severity; delta sharpened it. prune-helper-deps.mjs:16-26 documents bindings->file-uri-to-path as load-bearing in the shipped tree. The new WEIGHT gate asserts size/shape, never provenance.

- **[still-open · medium] F2 — npm install fails on Windows after an Electron ABI bump (stale build/ tree)**  
  Now at: `package.json:14`  
  Evidence: postinstall unchanged: `"postinstall": "electron-builder install-app-deps && node scripts/build-device-key.mjs && node scripts/build-node-helper.mjs"` — no ABI stamp, no build/ clear. rebuild-native.mjs untouched since c026463; WinError 183 header at :5-13, manual clear loop at :65-80. electron-builder.yml:5 still `buildDependenciesFromSource: true`.  
  Recommendation: As originally recommended: stamp the Electron ABI beside node_modules and rm -rf the two build/ dirs when it differs, before install-app-deps. Reuse rebuild-native.mjs:65-80, including its EBUSY 'close the app' message.  
  Note: Unchanged. Still a Windows/macOS workflow divergence, latent only because no Electron major landed (still ^39.8.10). Couples to F5: the bump F5 asks for springs this trap on every Windows dev's plain `npm install`.

- **[still-open · medium] F3 — No CVE surveillance: no npm audit gate, no update automation**  
  Now at: `scripts/qa-smokes.sh:218`  
  Evidence: Cited line unchanged: `run_static NPMCONFIG node scripts/check-npm-config.mjs`; WEIGHT still :322. grep for 'npm audit|audit-level|dependabot|renovate' over scripts/ .github/ package.json returns nothing (check-audit.mjs is a markdown gate over AUDIT.md, header :2). .github/ holds only actions/ and workflows/. qa-smokes.sh:12 claims 207 gates / 32 static; none checks vulns.  
  Recommendation: As originally recommended (scripts/check-vulns.mjs wired into qa-smokes.sh, or .github/dependabot.yml). check-npm-config.mjs:62 already sanctions `audit` as an .npmrc key, so the new gate would not fight NPMCONFIG.  
  Note: Unchanged severity, wider blind spot: static gates grew 30->32 and the shipped tree gained a vendored conpty.dll/OpenConsole.exe pair (build/conpty/1.25.260303002/) — more third-party binary, still no CVE mechanism.

- **[still-open · medium] F4 — Pinned Node helper download verified only against same-origin SHASUMS**  
  Now at: `scripts/build-node-helper.mjs:165`  
  Evidence: fetchPinnedNode() unchanged: :165-168 downloads the archive and SHASUMS256.txt from NODE_DIST (nodejs.org/dist/v24.15.0, :49) in one Promise.all, and :176 compares the two to each other. No sha256 constant near HELPER_NODE_VERSION (:48); no signature check of SHASUMS256.txt.  
  Recommendation: As originally recommended: commit the expected per-platform sha256 next to HELPER_NODE_VERSION (:48) and compare against those constants, keeping the fetched SHASUMS as a secondary cross-check. The pin moves rarely, so the constant is cheap.  
  Note: Unchanged. Worth noting :205-208 (if the builder's own node IS the pin, copy process.execPath) means machines on 24.15.0 never hit the network — narrowing, not closing, since release builders on other Node versions still download.

- **[still-open · medium] F5 — Electron ^39.8.10 pin outside the upstream security-support window**  
  Now at: `package.json:62`  
  Evidence: Still `"electron": "^39.8.10",`; lockfile resolves 39.8.10 (its only delta since baseline is 0.16.0->0.17.0). No electron bump in the 32-commit delta; grep for 'support window|EOL|end-of-life' over docs/ and docs/adr/ returns nothing. Repo-internal dating: conpty pin 1.25.260303002 (:78) and a 2026-08-01 mac weigh-in (check-package-weight.mjs:49) against a ~Oct-2025 Electron 39 line.  
  Recommendation: As originally recommended, plus one the delta enables: check-conpty-pin.mjs is a natural home for a companion assertion — fail the sweep when the installed Electron major falls more than 2 behind a committed supported-floor constant.  
  Note: Case is stronger: major Windows-backend work landed (ConPTY v2, vendored 1.25 pin, check-conpty-pin.mjs) without touching the Electron major. Raise to high only once electronjs.org confirms 39 is past EOL.

- **[still-open · low] F6 — Zero-new-deps discipline is folklore: no ADR owns it, no gate pins the dep list**  
  Now at: `package.json:41`  
  Evidence: `"dependencies": {` at :41 still lists exactly 14 runtime deps with nothing asserting that. grep 'dependencies' over scripts/*.mjs finds only build-node-helper.mjs:225 (the helper's own manifest). ADR 0004 unchanged (59 lines; only 'depend' hit is :50, about package walls). No dep-policy ADR landed. Discipline still prose-only, e.g. docs/16-files.md:49.  
  Recommendation: As originally recommended. The delta supplies a better template than check-npm-config.mjs: prune-helper-deps.mjs:16-26 is exactly the allow-list-with-per-entry-reasoning shape a runtime-dep allowlist gate should copy.  
  Note: Unchanged. Incidental: two distinct ADRs now both carry number 0022 (0022-connections-reach-the-terminal.md, 0022-shared-account-defaults.md) — out of scope but the same unowned-numbering class.

- **[still-open · low] F7 — No engines field despite a Node-version-sensitive toolchain**  
  Now at: `package.json:57`  
  Evidence: `grep -n engines package.json` returns nothing — field still absent; :57 is still `"devDependencies": {`. No root .npmrc exists, while check-npm-config.mjs:63 still pre-sanctions 'engine-strict' in ALLOWED. ci.yml pins `node-version: '22'` at :48, :159, :244, :341; build-node-helper.mjs:48 pins 24.15.0; :244-245 cites Node-24 DEP0190.  
  Recommendation: As originally recommended: add "engines": { "node": ">=22.12" } plus a root .npmrc with engine-strict=true. Safe — engine-strict is already in check-npm-config.mjs's ALLOWED set (:63), so NPMCONFIG stays green.  
  Note: Unchanged. Scope widened slightly: ci.yml went from one to four Node-22 setup steps in the delta, so more places assume a Node floor that is still nowhere declared machine-readably.

### docs-drift

- **[still-open · medium] F1 — docs/02 still marks Phase 0 as '*current*' twelve shipped phases later**  
  Now at: `docs/02-mvp-and-roadmap.md:17`  
  Evidence: :17 still reads `### Phase 0 — Parity spike (1–2 wks) · *current*`; :21 still ends `(Implemented as the current single-pane app.)`. Phase 1 (:23) and Phase 2 (:32) still have no marker while Phases 3+ carry ✅. `git diff c026463..HEAD -- docs/02-mvp-and-roadmap.md` is empty. README.md:53 still says all phases through 12 shipped.  
  Recommendation: as originally recommended  
  Note: Untouched by the delta. Sharper now: README.md:164-166 marks Phase 0/1/2 ✅ itself, while the file it calls the 'Full plan' says Phase 0 is current.

- **[still-open · medium] F2 — 'Codified as ADR 0009' cites an ADR that does not exist, and 0009 is reserved twice**  
  Now at: `docs/02-mvp-and-roadmap.md:165`  
  Evidence: :165 still present tense: `...start sharper. Codified as ADR 0009:`. `ls docs/adr/` at HEAD still jumps 0008→0010. docs/research/2026-07-third-party-integrations.md:123,128,203 still reserve 0009 for 'service keys as pointers'. prompts/phase-11/README.md:50 and prompts/phase-12/README.md:72 still cite `docs/15-loops.md` + ADR 0009; that doc does not exist.  
  Recommendation: as originally recommended, plus reword docs/02:456 ("ADR 0009's law 1") in the same pass — it asserts the same nonexistent record.  
  Note: A second present-tense citation the original missed: docs/02:456 ('ADR 0009's law 1'). The delta's real ADR 0022 collision (F4) is the predicted collision already happening.

- **[still-open · medium] F3 — ADR labels in docs/02 accounts pack point at differently-numbered ADR files**  
  Now at: `docs/02-mvp-and-roadmap.md:315`  
  Evidence: :315 still `built stance-first (ADR [0015](../adr/0016-accounts-and-entitlements.md) wrote the`; :331 still `[0016](../adr/0017-split-node-runtime.md)) that moved the daemon/MCP/CLI`. Both targets exist so DOCSREFS stays green. docs/adr/0015-board-github-write-back.md is the real 0015; README.md:178 cites the pair correctly as 0016/0017.  
  Recommendation: as originally recommended; the optional check-docs-refs.mjs extension (link text /ADR \[?(\d{4})/ must agree with the target filename digits) would also flag F4's ambiguity for free.  
  Note: No diff to docs/02 since c026463, and no label-vs-filename check was added — check-docs-refs.mjs at HEAD still only existsSync's the target (:45).

- **[still-open · medium] F4 — Two different ADRs both carry the number 0022**  
  Now at: `docs/adr/0022-shared-account-defaults.md:1`  
  Evidence: Both exist at HEAD: 0022-connections-reach-the-terminal.md:1 `# ADR 0022 — Connections reach the terminal…` (proposed) and 0022-shared-account-defaults.md:1 `# ADR 0022 — Shared account defaults` (Accepted). `git diff --stat c026463..HEAD -- docs/adr/` shows BOTH as new files (+304, +83) — the delta created the collision. `ls scripts/` shows no ADR-numbering gate.  
  Recommendation: Rename 0022-connections-reach-the-terminal.md → 0023 and fix its H1 — it has zero inbound citations, so it is the free rename. Add the filename-prefix uniqueness assert inside check-docs-refs.mjs rather than a new script, so it rides an existing gate.  
  Note: Now load-bearing, not theoretical: the accepted 0022 is cited by docs/22-shared-defaults.md:6 and ~14 code sites (settings-store.ts:45,205,285,458; agent-settings.ts:294,370,438) all saying bare 'ADR 0022'.

- **[still-open · medium] F5 — DOCSREFS gate never scans README.md or prompts/**, and prompts cite a missing doc**  
  Now at: `scripts/check-docs-refs.mjs:30`  
  Evidence: :30 is still `const docs = walk('docs')`, the only scanned root; file is byte-identical to baseline. I re-ran the script's own regex+existsSync over README at HEAD: 22 relative links, 0 broken — still a gap, not a live break. docs/15-loops.md still absent while prompts/phase-9/07-loops-milestone.md:2,19,43, phase-9/README.md:45, phase-11/README.md:50, phase-12/README.md:72 cite it.  
  Recommendation: as originally recommended — add README.md and a prompts/ walk; since docs/15-loops.md stays absent, the six citations must be reworded as future work in the same commit or the gate lands red.  
  Note: One more citer than originally reported (prompts/phase-12/README.md:72). Gate-honesty holds: DOCSREFS prints 'every relative link resolves' with README and all prompt packs outside its blast radius.

- **[still-open · medium] F6 — docs/06 'Control API' verb table documents 9 of the CLI's 21 verbs**  
  Now at: `docs/06-control-api.md:11`  
  Evidence: The table (:11-19, file is 98 lines) still lists exactly nine rows: list/send/send-key/capture/cwd/map/recall/`[<dir>]`/notify. bin/mogging.mjs:39-60 still dispatches 21 verbs incl. open/layout/focus/expand/close-pane. grep for layout|close-pane|expand|focus in docs/06 hits only :18 (deep-link row) and :53 (socket 'hello'). README.md:83 still shows `mogging open … --panes 4`.  
  Recommendation: as originally recommended; a durable upgrade is a static check that every `cmd === '<verb>'` branch in bin/mogging.mjs appears in the docs/06 table or an explicit pointer line — same list-vs-list family as check-gates.mjs.  
  Note: Unchanged by the delta. The usage() banner at bin/mogging.mjs:64-77 is now the only complete enumeration, so `mogging --help` beats the doc that calls itself the scripting reference.

- **[still-open · low] F7 — docs/05 points the budget source-of-truth at a moved file path**  
  Now at: `docs/05-perf-budget.md:10`  
  Evidence: :10 still reads ``Source of truth: `BUDGET` in `src/main/milestone-smoke.ts`.`` — `ls src/main/milestone-smoke.ts` → No such file; the real one is src/main/smokes/milestone-smoke.ts with `export const BUDGET = {` at :32. The table at docs/05:14-18 still matches (16 / 150ms / 30fps / 300MB / 12).  
  Recommendation: Fix all three spans to src/main/smokes/… (docs/05:10, docs/11:12, docs/14:85). DOCSREFS cannot see backtick spans; extending it to resolve backticked paths starting src/ or scripts/ would close the class.  
  Note: The suggested grep pays off: same class is stale twice more — docs/11-design-system.md:12 cites src/main/setshell-smoke.ts and docs/14-integrations.md:85 cites src/main/integmilestone-smoke.ts; both live under src/main/smokes/.

- **[still-open · low] F8 — README project tree says 'adr/ decision records (0001–0004)' — 23 ADR files exist**  
  Now at: `README.md:157`  
  Evidence: :157 still reads `  adr/                          decision records (0001–0004)`. `ls docs/adr/` returns 23 files through 0022 (incl. 0007a/0007b and the two colliding 0022s). README's own roadmap cites ADR 0014 (:176), 0015 (:179), 0016/0017 (:178), 0018 (:180). The sole README delta since c026463 is the 199→207 gate bump at :53.  
  Recommendation: Use the evergreen `adr/   decision records` with no range rather than bumping to (0001–0022) — the range has already drifted twice and no gate can see it.  
  Note: Understates by 23 files now (delta added two ADRs), and will drift again on every ADR landed.

### workspace-tabs-switching-and-per-workspace-themes

- **[still-open · medium] F1 — Drag-reorder diverges rail order from logical order during pending close**  
  Now at: `src/ui/features/workspace/controller.ts:719`  
  Evidence: finish() unchanged: filter `(id) => this.views.has(id)` (718) then `if (next.length === this.order.length) this.order = next` (719). softClose:1051 removes the id from order but only sets `view.tab.hidden = true` (1052); views/DOM keep it until close():1114-1117. So next.length = order.length+1 and 719 skips, after dragover:710 insertBefore already moved it.  
  Recommendation: As originally recommended: at controller.ts:718 filter with `this.views.has(id) && !this.pendingClose.has(id)` and compare against that, or revert the dragover DOM move when the count check fails.  
  Note: Delta never touched wireReorder. Confirmed permanent, not transient: the only tab insertions are 317, 649, 710 — nothing re-renders the rail from this.order, so the DOM stays the divergent truth.

- **[still-open · medium] F2 — Ctrl+1..9 workspace switching dead on layouts with shifted digits**  
  Now at: `src/ui/features/workspace/index.ts:726`  
  Evidence: index.ts is byte-identical to c026463. Line 726 still reads `} else if (!e.shiftKey && k >= '1' && k <= '9') {` with `controller.switchByIndex(Number(k) - 1)` at 729, k from e.key. AZERTY/Czech unshifted Ctrl+digit reports '&','é',…; Shift is excluded. Promise still advertised at src/ui/core/commands/shortcuts.ts:45 and src/ui/features/home/index.ts:122.  
  Recommendation: Mirror the e.code+e.key pattern the repo already uses in src/ui/features/browser/index.ts:1105-1107 (`e.code === 'Digit0' || e.key === '0'`): match Digit1..9 and Numpad1..9 at index.ts:726, keeping the e.key test as fallback.  
  Note: Unchanged. Not a platform-divergence finding (breaks identically on Windows and macOS) — it violates the advertised core-navigation shortcut instead.

- **[still-open · medium] F3 — openForCwd duplicates workspaces on Windows: strict path equality**  
  Now at: `src/ui/features/workspace/controller.ts:1828`  
  Evidence: openForCwd (1826) still matches `if (v.meta.cwd && v.meta.cwd === cwd) {` (1828) — shifted 5 lines only by the unrelated publishRemotes edit at 494. Delivery path unfolded too: src/main/deep-link.ts:109 and src/main/boot.ts:379 forward the raw cwd. Backend rule unchanged at src/backend/features/workspace/project-identity.ts:14-15.  
  Recommendation: Better fix now available: export the delta-added `pathKeyOf` (src/contracts/domain/cwd.ts:16, currently module-private) and compare pathKeyOf(v.meta.cwd) === pathKeyOf(cwd). It is renderer-safe, covers separators + win32 fold, and is already unit-tested.  
  Note: Severity unchanged, inconsistency now wider: the delta added a renderer-safe folding rule for the explorer (src/contracts/domain/cwd.ts:16-19), so a third subsystem folds while the workspace matcher still does not.

- **[still-open · medium] F4 — Debounced persist has no quit-time flush; last 400ms of changes lost**  
  Now at: `src/ui/features/workspace/index.ts:391`  
  Evidence: index.ts unchanged: `const persist = debounce(async () => {...}, 400)` (362-391), fed at 388, 436, 446, 458, 465, 473, 484, 736 (theme), 919. Grep over src/ui and src/main finds no beforeunload/pagehide. main's before-quit (src/main/boot.ts:430-444) flushes telemetry/MCP/brain/backend but never requests a final buildState; only writer is app-settings.ts:47.  
  Recommendation: As originally recommended: invoke the debounced body immediately from a pagehide/beforeunload listener (guarded by restoring || persistencePaused), or capture a final buildState in main's before-quit at boot.ts:430 before disposeAppSettings().  
  Note: Untouched by the delta. Loss stays bounded to ≤400ms of metadata, so this sits at the low end of medium — kept there because it directly erodes the restore-on-relaunch promise.

- **[still-open · medium] F5 — Color-allocation model (nextColor/resolveColors) has zero test coverage**  
  Now at: `src/ui/features/workspace/model.ts:87`  
  Evidence: model.ts byte-identical to baseline: nextColor:87-96, isWorkspaceColor:101-103, resolveColors:118-136 all unchanged. Repo-wide grep for nextColor|resolveColors|isWorkspaceColor (minus node_modules) returns only the 3 sources and call sites controller.ts:523-524, index.ts:499, index.ts:883 — zero hits under tests/ or src/main/smokes/.  
  Recommendation: As originally recommended: add tests/unit/workspace-colors.test.ts for first-free allocation, least-worn reuse past 12, retired-hex (#b5d21b) re-allocation, duplicate repair keeping the first claimant, and resolveColors' no-eviction property.  
  Note: Unchanged. Slightly aggravated: the delta added 8 unit test files, none touching the color model, so it is now the conspicuous untested pure module in this feature.

- **[still-open · low] F6 — publishRoles seeds roles for slots the restored layout no longer has**  
  Now at: `src/ui/features/workspace/controller.ts:465`  
  Evidence: publishRoles (447-474) unchanged: line 465 `if (role && granted.has(i)) setPaneRole(paneIdForSlot(meta, i + 1) as PaneId, role)` plus the daemon publish at 467-473; `granted` (450-456) is an entitlement cap only, no liveness test. launchLineup still guards: `const live = new Set<number>(view.layout.paneIds())` (1902) / `live.has(paneId)` (1906).  
  Recommendation: Cheaper than originally described: create() already computes the real sparse slot set at controller.ts:276 (`restoredTree ? leafIds(restoredTree) : undefined`). Pass it into publishRoles(meta, slots) at the :368 call and skip non-live slots.  
  Note: Unchanged by the delta. Stays low: the ghost role is metadata (pane-meta/daemon row plus one capped grant) and never types into a pane, so the we-type/user-executes law is untouched.

- **[still-open · low] F7 — Docs drift: 'docs/02 Phase-1/05' missing; README misplaces themes.ts**  
  Now at: `src/ui/features/workspace/README.md:16`  
  Evidence: README.md byte-identical to baseline. Line 3 still cites '(Phase-1/05)' while docs/ holds only flat 00-22 plus adr/assets/research — no Phase-1 dir. Line 16 still lists '`themes.ts` — the theme set', but it lives at src/ui/core/theme/themes.ts (index.ts:20-21 merely imports it). Line 19 still credits index.ts with the 'theme picker'.  
  Recommendation: As originally recommended, plus line 19: point themes.ts at src/ui/core/theme/, move the picker credit to features/settings/theme-picker.ts, and re-point the line-3 Phase-1/05 pointer at a doc that exists (e.g. docs/11-design-system.md) or drop it.  
  Note: Unchanged. Add the line-19 error to the original claim: the picker is src/ui/features/settings/theme-picker.ts, built at settings/index.ts:96 and mounted at :549 — same drift, three lines down from the cited one.

### connection-stdio-bridge-into-agent-clis-adr-0014

- **[still-open · critical] F1 — Connection launcher redirects to the house MCP server inside every pane**  
  Now at: `src/main/cli-runtime.ts:153`  
  Evidence: File byte-identical to c026463. Line 153 still emits the literal "const paneTarget = join(runRoot, segment, 'bin', 'mogging-mcp.mjs')"; line 197 still feeds connectionEntry through the same generator. Trigger intact: pty-daemon/index.ts:77 injects MOGGING_DAEMON_ENDPOINT, pane-env.ts:36 inherits it, runtimeDir()='run/v11' so segment='v11' matches.  
  Recommendation: As originally recommended: use basename(current) in stableMcpLauncherSource. Required even if F3's shape change lands, since command=executable args=[connectionEntry,...] still routes through this same launcher.  
  Note: Unchanged. The v11 bump does not alter the redirect (any vN matches). bin/mogging-mcp.mjs still has no --connection handling, so the flag is silently ignored.

- **[still-open · critical] F2 — Protocol bump strands every connection entry on a swept, version-pinned shim path**  
  Now at: `src/main/cli-runtime.ts:203`  
  Evidence: Line 203 still pins the shim under runtimeDir()/bin. daemon-sweep.ts:76 still `fs.rmSync(dir, {recursive:true,force:true,...})` on older vN. Repair is house-only: mcp-manager.ts:323 hashKey(writer.cli,'mogging'), :325 readCanonical(current,'mogging'). boot.ts:244 calls installCliRuntime() with no connection re-registration after it.  
  Recommendation: Best fix: adopt F3's shape - command=runtime.executable, args=[runtime.connectionEntry,'--connection',id]. connectionEntry already lives in the version-neutral run/mcp dir, closing F2+F3 at once. Add a migration for v10 entries.  
  Note: Raised from HIGH: fb72bef bumped DAEMON_PROTOCOL_VERSION 10->11 (contracts/daemon/protocol.ts:38), so this release actually strands existing entries on the swept run/v10 path; drift compares to the stale canonical.

- **[still-open · high] F3 — Windows registers a .cmd as the MCP command while the house server avoids it**  
  Now at: `src/main/connections.ts:1266`  
  Evidence: registerConnectionServer survived the +191-line device-flow diff untouched: line 1266 still `command: runtime.connectionShim,` with args ['--connection', serviceId]; cli-runtime.ts:203 makes that a .cmd on win32. houseServerEntry keeps the other shape (mcp-manager.ts:93-94). No 'cmd /c' or cmd.exe wrapping in mcp-manager.ts or integrations/registry.ts.  
  Recommendation: As originally recommended, now better justified: register command=runtime.executable, args=[runtime.connectionEntry,'--connection',id]. Same change closes F2. Delete the stale ELECTRON_RUN_AS_NODE comment at connections.ts:1259-1260.  
  Note: Unchanged. The comment at connections.ts:1259-1260 ('The shim sets ELECTRON_RUN_AS_NODE itself') is now false - ADR 0017 removed it, cliShimSource sets nothing. The shim's last stated reason to exist is gone.

- **[still-open · high] F5 — Gate never exercises the real spawn chain shim to launcher to bridge**  
  Now at: `scripts/connections-pure-smoke.ts:369`  
  Evidence: File unchanged; line 369 still spawns process.execPath on bin/mogging-connection.mjs from the repo - not runtime.connectionShim - with only MOGGING_BROWSER_ENDPOINT in env. toolplan-smoke.ts:66-85 still builds launcher fixtures only from mogging-mcp.mjs, so the assertion passes because both names coincide. None of the 10 smokes added in the delta reference connectionShim.  
  Recommendation: As originally recommended: execute runtime.connectionShim end-to-end against a fixture endpoint, with and without MOGGING_DAEMON_ENDPOINT set, asserting the bridge answers in both cases.  
  Note: Raised from MEDIUM on gate honesty: the delta shipped a protocol bump (making F2 live) plus 10 new gates through the same green board, while the composition agents execute stayed untested.

- **[still-open · medium] F4 — connection.rpc ignores the workspace tool plan the ADR calls the real boundary**  
  Now at: `src/main/mcp-endpoint.ts:164`  
  Evidence: Line 164 is still the only check: `if (!/^[a-z0-9_-]{1,64}$/i.test(connection)) return { ok: false, reason: 'unknown connection' }`. boundPane feeds only the REST branch's writeGranted (179); the MCP proxy branch from 184 has no plan check. workspaceIdForPane is imported (9) and used at 332, not here. Lines 412-417 auth a paneless client; dispatch at 545 passes boundPane=undefined through.  
  Recommendation: Enforce plan membership for pane-bound sessions via workspaceIdForPane, mirroring the fail-closed shape at mcp-endpoint.ts:297. Drop the ADR 0022 credential.get reference - no credential handler exists at HEAD. Document the paneless case.  
  Note: Code unchanged. The delta's ADR 0021 REST branch widened what rides this entry point but does gate writes. Docs tension confirmed: adr/0014:161 calls the plan the real boundary; adr/0014:167 accepts endpoint-file reach.

- **[still-open · low] F6 — The '0600 endpoint file' boundary is POSIX-only; Windows relies on inherited ACLs**  
  Now at: `src/main/mcp-endpoint.ts:596`  
  Evidence: Unchanged: `fs.writeFileSync(endpointFile(), JSON.stringify({version: PROTOCOL, address, token}), { mode: 0o600 })` - a no-op mode on win32. The dir side matches: runtime-paths.ts:79-84 and cli-runtime.ts:175-178 chmod only when platform !== 'win32'. Docs unamended: adr/0014:129,167 and adr/0022-connections-reach-the-terminal:28,196,231 still say 'the 0600 endpoint file'.  
  Recommendation: As originally recommended. The cheap half - amending the five doc lines to say the Windows boundary is the %LOCALAPPDATA% profile ACL - is worth doing now; check-credential-wording.mjs can pin the wording.  
  Note: Unchanged. The delta did not widen this file's reach - the ADR 0022 credential helper is still unimplemented at HEAD - so the original LOW holds.

### curated-rest-tool-bridge-adr-0020-0021

- **[still-open · high] F1 — Stripe's declared cursor pagination unimplemented: silent one-page answers**  
  Now at: `src/backend/features/integrations/rest-bridge.ts:275`  
  Evidence: Line 275 still `const next = ...(page).next`, 276 `if (typeof next !== 'string' || !next) break`. cursorParam/pageParam appear nowhere in rest-bridge.ts. stripe.json:67,80,93,105 still declare {"cursorParam":"starting_after"}; Stripe sends has_more, no next, so the loop breaks at once and line 297 sets morePages=false. git log c026463..HEAD on this file is empty.  
  Recommendation: As recommended: implement cursorParam (re-request starting_after=last id while has_more) and pageParam; minimally set morePages=true when a declared grammar can't be followed. Add a {data,has_more:true} fixture to restexec-pure-smoke.ts.  
  Note: posthog.json's pageParam is equally unread but PostHog does send a next URL, so those work by accident; Stripe's 4 tools are the real break. restexec-pure-smoke.ts:60-66 fixtures only next-URL pages, so the gate is blind.

- **[still-open · medium] F2 — connectionConfig never plumbed at the production seam**  
  Now at: `src/main/mcp-endpoint.ts:176`  
  Evidence: 176-180 still `handleRestBridgeRpc(payload, { entry: rest.entry, token: rest.token, writeGranted: resolveWriteAllGranted(boundPane) })` — no connectionConfig. connections.ts:1216-1227 restBridgeUpstream still returns only {entry, token}. Repo grep for connectionConfig hits no store/UI/main file. rest-bridge.ts:229 passes `{}`, so resolveEndpoint (159-169) refuses every ${KEY}.  
  Recommendation: Better: make check-catalog.mjs REFUSE ${...} in a restTools endpoint until the runtime path exists (invert the :258/:264 selftest to an expected-error case), then build persist/return/pass. Closes the honesty gap now.  
  Note: Title overstates: grep shows NO shipped restTools endpoint contains ${...}; the four connectionConfig rows (gitlab/make/n8n/sentry) declare it on methods and ship zero restTools. Live break exists only in the check-catalog selftest.

- **[still-open · medium] F3 — RESTMILESTONE smoke rebuilds the bridge service instead of exercising handleConnectionRpc**  
  Now at: `src/main/smokes/restmilestone-smoke.ts:249`  
  Evidence: 249-254 still `const svc = (writeGranted, disable = false) => ({ entry: upstream.entry, token: upstream.token, writeGranted, ... })`, with assertions calling handleRestBridgeRpc directly at 256 and 267. handleConnectionRpc is still a non-exported `async function` at mcp-endpoint.ts:159 with its only caller at line 545, so no smoke can route a frame through it.  
  Recommendation: As recommended: export handleConnectionRpc, or a buildRestBridgeService(rest, boundPane) helper used by both, and drive the milestone assertions through it so a dropped field fails the gate.  
  Note: Partial credit: entry/token come from the real restBridgeUpstream (line 247) and the grant from real resolveWriteAllGranted (258). Untested: the svc construction, the id regex (:165), restBridgeStats (:174-181), proxy fall-through.

- **[still-open · low] F4 — Key verification probe ignores restAuth carriage; query-auth rows can never connect**  
  Now at: `src/backend/features/integrations/credential-core.ts:226`  
  Evidence: Line 226 still hardcodes `authorization: `${o.authScheme ?? 'Bearer'} ${key}``; the options type (218) accepts only {authScheme,timeoutMs,fetchFn} — no header name, no query param. connections.ts:870-871 still passes only `{ authScheme: scheme }`. executeRestTool (rest-bridge.ts:239-245) meanwhile honours arbitrary auth.header and auth.in==='query'.  
  Recommendation: Take the cheap half first: have check-catalog.mjs refuse any restAuth shape the probe cannot prove (non-header or non-Authorization), with a selftest. Thread the full RestAuthSpec into runVerificationProbe when a query-auth provider is actually curated.  
  Note: Lowered from medium: every shipped row is {in:header, header:Authorization} (cf-bindings:44, cf-dns-analytics:43, cf-graphql:43, posthog:57, stripe:43). Zero users can hit it; it fires only on the same future data-PR path as F2.

- **[still-open · low] F5 — readOnly:true non-GET tools bypass the write grant on curator say-so**  
  Now at: `src/backend/features/integrations/rest-bridge.ts:220`  
  Evidence: Gate still `if (tool.readOnly === false && !svc.writeGranted && !svc._testDisableWriteGate)` at 220, so readOnly:true skips it. check-catalog.mjs:186-188 still only errors when a non-GET omits an explicit boolean — never checks the claim. cf-graphql.json:67-74 still ships "method":"POST" with "readOnly": true. grep for readOnlyRationale across src and scripts returns nothing.  
  Recommendation: As recommended: add a RESTSCHEMA rule requiring readOnlyRationale (or provenance URL) on any readOnly:true non-GET tool, plus a selftest that a bare readOnly:true POST is refused.  
  Note: Unchanged by the delta. The one shipped instance stays defensible (CF GraphQL analytics is query-only), so the exposure is that a single data PR can repeal the write grant for a real mutation with no executor-side review.

- **[still-open · low] F6 — Retry and pagination abandon unconsumed response bodies**  
  Now at: `src/backend/features/integrations/rest-bridge.ts:201`  
  Evidence: fetchWithRetry 200-205 unchanged: `let res = await doFetch(...)`, then on a retryable !ok it sleeps and does `res = await doFetch(...)` — the first Response's body is never read or cancelled. Pagination still does `if (!res.ok) break` at line 289 with the same unread body. No body?.cancel() or drain exists anywhere in the file.  
  Recommendation: As recommended: `void res.body?.cancel()` on the abandoned Response immediately before the retry refetch at rest-bridge.ts:203 and before the break at line 289.  
  Note: Unchanged. Bounded as originally reasoned (one retry; MAX_PAGES-capped loop), but it is a connection hold in the long-lived main process that serves every pane's MCP endpoint — worth the two-line fix.

### per-pane-git-branch-dirty-chip-pipeline

- **[still-open · high] F4 — Gate smoke records the OSC-7 chip-retarget result but never asserts it**  
  Now at: `src/main/smokes/git-smoke.ts:250`  
  Evidence: Three hits only: computed at :228 `const oscRetargeted = !!retarget && retarget.branch === 'osc-branch'`, :229, reported :339-340. The pass expression :250-313 ends at `directChip.title.includes('(linked)')`. Authority half is dead: :220 emits `'file://host/' + repo2...` and osc-parser.ts:64 `if (authority && authority !== 'localhost' && authority !== local) return null`.  
  Recommendation: Fix the URI before asserting: emit authority-free `'file://' + repo2...` (git-feature-pure-smoke.ts:168 proves that form is accepted), then add oscRetargeted and a latency bound to the pass expression. Asserting alone would make GIT permanently red.  
  Note: RAISED medium->high. Not a plain test gap: the leg is dead-on-arrival (rejected authority) AND unasserted, so GIT certifies green over a leg that cannot run — the gate-honesty law.

- **[still-open · medium] F1 — Probe inherits GIT_DIR/GIT_WORK_TREE, letting env redirect every chip**  
  Now at: `src/backend/features/git/probe.ts:20`  
  Evidence: Verbatim unchanged: `execFile('git', args, { timeout: 5000, maxBuffer: 8*1024*1024, windowsHide: true }, ...)` — no env, so GIT_DIR overrides `-C root`. src/main/git.ts:40 spawn also has only { windowsHide: true }. grep for GIT_DIR/GIT_WORK_TREE across src+scripts hits smokes only. git diff c026463..HEAD of both files: empty.  
  Recommendation: As recommended, but do not copy the smokes: one shared gitEnv() in probe.ts deleting GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE/GIT_COMMON_DIR/GIT_NAMESPACE and setting GIT_TERMINAL_PROMPT=0, passed from run(), main/git.ts:40, and the smokes.  
  Note: Severity unchanged. Correction: the smokes cited as the model (git-smoke.ts:29, git-feature-pure-smoke.ts:14) spread ...process.env and only ADD GIT_TERMINAL_PROMPT; they never delete GIT_DIR, so no precedent exists to mirror.

- **[still-open · medium] F2 — Tick subscriber keyed by raw root gets files=null when root is inside a larger repo**  
  Now at: `src/backend/features/git/monitor.ts:288`  
  Evidence: Still `const wantFiles = this.fileRoots.has(root) || this.tickSubs.has(this.foldRoot(root))` with root=findRepoRoot(cwd) (:280), while subscribeTick keys by the RAW root (:149). Tick delivers files=null at :351. Consumer confirmed dead: freshness.ts:295 `if (p.status && p.files && p.status.available)` fails and :297 `else if (!p.status)` also fails — no batch, no sweep.  
  Note: Severity unchanged. Second trigger the original missed: probeRepo memoizes per root in the tick cache (:282) and panes refresh before subscribers (:337 vs :343), so a subscriber on the repo root also gets files=null when a pane wins.

- **[still-open · medium] F3 — Synchronous fs walks repeat on the main process every tick; unbounded on slow drives**  
  Now at: `src/backend/features/git/monitor.ts:280`  
  Evidence: probeRepo still opens `const root = findRepoRoot(cwd)`; findRepoRoot is still sync — realpathSync.native + statSync then a 256-round lstatSync/readGitLayout walk (repo.ts:24-45). probeGitFull repeats it (probe.ts:431) plus readGitLayout (probe.ts:436, 3-4 statSync each, repo.ts:85-110). syncMetadataWatches adds one findRepoRoot per cwd and per tickSub (:186, :190).  
  Recommendation: As recommended, plus a cheap first slice: move readManagedBase/baseRefFor below the divergence-cache check at probe.ts:205 (pure reorder), then add the cwd->(root,layout) memo invalidated on metadata wake / probe error / setCwd.  
  Note: Unchanged. Worse than reported: probe.ts:202 readManagedBase(root) runs BEFORE the divergence-cache check at probe.ts:205, and it calls readGitLayout again (repo.ts:239) — so a cache hit does not spare the fs work.

- **[still-open · low] F5 — unwatchFiles leaks registration, keeping the poll alive, when the repo root was deleted**  
  Now at: `src/backend/features/git/monitor.ts:129`  
  Evidence: Unchanged: `const root = findRepoRoot(cwd) ?? cwd` at :129, versus watchFiles storing fileRoots.add(root) from findRepoRoot(cwd) (:119-121). Deleted worktree -> findRepoRoot returns null (realpathSync throws, repo.ts:24-26) -> key is raw cwd -> the dead root stays -> stopIfIdle bails on `this.fileRoots.size > 0` (:252). No cwd->root map exists.  
  Note: Unchanged. The leak needs no subdirectory cwd: the fallback returns raw cwd without path.resolve while findRepoRoot returns the resolved form (repo.ts:15). Cost is the live interval plus F3's fs walk on a dead path; no git spawn (:281).

- **[still-open · low] F6 — Porcelain-v2 parsers have no unit tests; all coverage rides live-git smokes**  
  Now at: `src/backend/features/git/probe.ts:375`  
  Evidence: tests/unit now has 34 files (10 added since baseline); `ls tests/unit | grep -iE 'git|porcelain'` returns nothing. parseStatusV2 (:250), unquotePath (:331), parseStatusFiles (:375) are exported, but the sole external importer is scripts/git-feature-pure-smoke.ts:7, which imports only GitMonitor and probeGitFull and drives real git on fixtures.  
  Note: Unchanged; if anything understated. Grepping the gated pure smoke (qa-smokes.sh:253, GITPURE) for GIT_FILES_CAP/truncat/rename/conflict/unborn/detached returns nothing — no fixture covers truncation, renames, conflicts, or quoted paths.

- **[invalid · none] F7 — The Phase-2/03 spec cited across the feature does not exist in docs/**  
  Now at: `prompts/phase-2/03-per-pane-git.md:1`  
  Evidence: The spec exists: prompts/phase-2/03-per-pane-git.md, 35 lines, '# 03 — Per-pane git status (read-only)', naming the exact files the comments sit in (src/backend/features/git/**, src/contracts/ipc/git.ipc.ts, ui/features/git), with Goal/Steps/Files/Definition of Done. The repo has prompts/phase-0..phase-12; 'Phase-2/03' is a prompts/ path, not docs/. The auditor searched only docs/.  
  Recommendation: Restore nothing. If the behavioral contract is wanted as a reviewable promise, add the four unwritten laws (remote-pane dormancy, 2.5s tick + one spawn per worktree, watch lifecycle, degrade-to-HEAD) to an existing docs file, not the phase prompt.  
  Note: Downgraded low->none: the premise is wrong, nothing is drifting. Small residual: the file is a build brief — grepping it for remote/poll/2.5/degrade/watch hits one line ('fs watch or poll'), so cadence and degrade semantics are unwritten.
  Challenger: agrees — Phase-N/MM is a repo-wide convention for prompts/phase-N/MM-*.md (20+ phases cited in src; Phase-4/04, Phase-8/09, Phase-2/04 resolve). prompts/phase-2/03-per-pane-git.md exists, git-tracked, not ignored, titled 03 Per-pane git status (read-only), names src/backend/features/git, git.ipc.ts, ui/features/git. docs/ has no phase dirs.

### shared-account-defaults-tier-adr-0022

- **[still-open · medium] F1 — Per-provider rollout allowlist (DEFAULTS_PROVIDERS) is enforced only in the renderer**  
  Now at: `src/main/agent-settings.ts:381`  
  Evidence: setDefault still gates only on `!isAgentCliId(request.provider)` (381-384); clearDefault (400-402) and promotable (411) too. DEFAULTS_PROVIDERS exists only at src/ui/.../agent-config.ts:40. setAccountDefault's sole gate is catalog+scopes (service.ts:485), and the bundled catalog has 352 codex / 196 gemini / 366 opencode account-writable settings.  
  Recommendation: As originally recommended. Prefer guarding setAccountDefault/applyAccountDefaults directly: scheduleApplyAccountDefaults (agent-settings.ts:442, profiles.ts:204) also enters the fan-out without passing the IPC handlers.  
  Note: Severity unchanged. Renderer-origin IPC only, so defense-in-depth rather than high; the catalog census shows the uncertified TOML/YAML blast radius is real, not theoretical.

- **[still-open · medium] F2 — Debounced fan-out racing a direct apply yields spurious 'changed-under-us' errors**  
  Now at: `src/backend/features/agent-settings/service.ts:519`  
  Evidence: `const applied = await this.applyAccountDefaults(provider)` (519; same at 536) never consults applyTimers; scheduleApply clears only its own timer (639-640). Hash read outside the queue (777) then `expectedHash: before.hash` (794) -> mutation-coordinator.ts:89 throws -> saveStatus(row,'error') (823) and ok:false toasts (agent-config.ts:506).  
  Recommendation: As originally recommended: serialize applyAccountDefaults per provider behind an in-flight chain, and clearTimeout+delete the provider's applyTimers entry in setAccountDefault/clearAccountDefault before applying directly.  
  Note: Unchanged. applyTimers appears only at service.ts:164/173/174/639/642/652 — no in-flight promise chain was added in the delta.

- **[still-open · medium] F3 — Failed debounced adoption is swallowed with no retry, despite a comment claiming one**  
  Now at: `src/backend/features/agent-settings/service.ts:644`  
  Evidence: `.then((result) => { if (result.ok) this.options.changed?.(provider) }).catch(() => {})` (644-649) drops ok:false, catch empty. No retry exists: baseline-read failures `continue` without saving a row (588-589, 599-601); reconcileAll (381-383) only reconciles existing rows; the hourly pass calls `await settings?.reconcileAll()` only (src/main/agent-settings.ts:452).  
  Recommendation: As originally recommended. Cheapest complementary fix: in refreshInstalledCatalogs (src/main/agent-settings.ts:452) also call applyAccountDefaults for each provider with authored tiers, so the hourly pass heals a missed adoption.  
  Note: Unchanged. The adoption smoke (profiledefaults-smoke.ts:185-189) exercises only the happy path, so no gate would catch a silent non-adoption.

- **[still-open · medium] F4 — 'On drift: Apply once' selector renders but is silently ignored on tier-routed saves**  
  Now at: `src/ui/features/settings/agent-config.ts:475`  
  Evidence: The ownership select is built for every writable row (402-405) and rendered unconditionally as `el('span',{text:'On drift:'})` + select (563), beside 'Applies to:' (562). Both tier branches post to setDefault with no ownership field (475-484, 486-495); service.ts:509 hardcodes `ownership: 'enforce',`. savedTitle derived from the select (474) is overwritten at 485/495.  
  Recommendation: As originally recommended. Cheapest correct edit: make lines 562-563 conditional — when `applies` is non-null render a fixed 'Keep in sync' hint instead of the select, so tier-managed keys never offer 'Apply once'.  
  Note: Unchanged — honest-labels doctrine (docs/22:78-80): a visible control offering 'Apply once' that always produces a forever-enforced row, with zero observable effect.

- **[still-open · low] F5 — Consent announces 'all N accounts' even when fan-out skips unsupported homes**  
  Now at: `src/ui/features/settings/agent-config.ts:428`  
  Evidence: accountCount is still an unfiltered home count (411) and the copy asserts it verbatim: `...across all ${accountCount} of your ${currentSnapshot.providerName} accounts...` (428). Eligibility still needs only one scope (414). Fan-out still skips: `if (!setting || !setting.scopes.includes(requiredScope)) continue` (service.ts:577-578).  
  Recommendation: as originally recommended — filter the count by setting.scopes when composing the consent message, or tighten defaultsEligible at agent-config.ts:414 to require both 'user' and 'profile'.  
  Note: Unchanged. The message line drifted 427->428 inside the same confirmDialog block — same defect, not a move.

- **[still-open · low] F6 — A profile pointer aimed at the primary's home creates dueling compiled rows in one file**  
  Now at: `src/backend/features/agent-settings/service.ts:444`  
  Evidence: providerHomes pushes the user home (454-458) then every pointered profile (461-467) with no resolved-path dedupe; `pointered` only tests the env key is non-empty (450-451). profiles.ts:83 checks siblings only, explicit env skips derivation (73), sanitizeProfile (109-121) never resolves the path. Both rows then group on one file key (766-772), last transform wins (797-801).  
  Recommendation: As originally recommended; prefer the providerHomes dedupe by resolved source file, since it also heals pointers written before any guard existed. Refusing the save in sanitizeProfile (src/main/profiles.ts) is a good second wall.  
  Note: Unchanged. Needs a hand-authored CLAUDE_CONFIG_DIR=~/.claude, so low — but once hit, one row reports 'drifted' forever and every reconcile rewrites the file.

- **[still-open · low] F7 — No test exercises pinning the PRIMARY home, an explicit doc doctrine**  
  Now at: `src/main/smokes/profiledefaults-smoke.ts:131`  
  Evidence: Line 131 still pins the pointer profile (`...'pin', PROFILE_A`), cleared at 200 with the same id. PRIMARY ('login-claude', 32) is only saved (46) and identity-asserted (111); the single primary snapshot assert expects `managedBy === 'account-default'` (144). defaultsmilestone-smoke.ts:90 pins 'ms-work' (also pointered); account-defaults.test.ts is pure resolveDefault/managedKeys.  
  Recommendation: As originally recommended. Add the bite after step 4 and route it through the IPC handler's tierProfileId path (src/main/agent-settings.ts:374-377) if the smoke can reach it — that resolution is the wholly untested half.  
  Note: Unchanged, plus a gate-honesty edge: the smoke reports `primaryFullMember: true` (line 226) on the identity assert at 111 alone, while the wiring it serves — a 'profile' pin compiling into a 'user' row — never runs.

### winget-homebrew-install-manifests

- **[still-open · high] F1 — Release re-run --clobber invalidates pinned manifest hashes; no gate detects it**  
  Now at: `.github/workflows/release.yml:245`  
  Evidence: git diff c026463..HEAD -- release.yml packaging/ is EMPTY. Line 245 still `gh release upload "$TAG" "${FILES[@]}" --clobber`; dispatch still open (line 12); ensure-release still demotes only when `[ "$DRAFT" = "false" ] && [ "$FEED" = "0" ]` (lines 50-53). Post-upload steps check asset NAMES only. grep InstallerSha256 repo-wide hits only ci.yml + update-manifests.mjs.  
  Note: Delta added check-package-weight.mjs (ci.yml:219, 536) — guards bundle contents, not hashes. Severity held: manifests still unsubmitted (docs/10:13), so impact is a bad copy-paste PR, as originally rated.

- **[still-open · medium] F2 — CI manifest validation never verifies pinned sha256/URL against the published release**  
  Now at: `.github/workflows/ci.yml:564`  
  Evidence: ci.yml:564-566 still only `winget validate --manifest packaging/winget`; ci.yml:579-580 still only `brew style packaging/homebrew/Casks/mogginglabs-workspace.rb`. Both keep the dispatch/cron guard verbatim at lines 549 and 570; no packaging/** path filter on push/pull_request. Neither fetches InstallerUrl or the cask url. ci.yml delta = package-weight steps + 199→207 comment edits only.  
  Recommendation: As recommended, plus a cheap first step the 0.16.0/0.17.0 skew now justifies: assert pinned manifest version == package.json version and fail otherwise. Catches skipped-step drift with no network; curl+sha256 layers on top.  
  Note: Delta gave live proof: package.json:3 is 0.17.0 and docs/10:156 says `gh release download v0.17.0`, yet installer.yaml:4 and cask:3 still pin 0.16.0 — RELEASING.md step 4 was skipped, CI stayed green.

- **[still-open · medium] F3 — Winget manifest lacks ProductCode/AppsAndFeaturesEntries for a self-updating NSIS app**  
  Now at: `packaging/winget/MoggingLabs.Workspace.installer.yaml:9`  
  Evidence: Installers block unchanged: lines 9-12 are `Installers:` / `  - Architecture: x64` / `    InstallerUrl: …/v0.16.0/MoggingLabs-Workspace-0.16.0-win-x64.exe` / `    InstallerSha256: A6EC…ADB0`. No ProductCode, no AppsAndFeaturesEntries. The emitting template (update-manifests.mjs:80-85) is unchanged. docs/10:12 still lists Windows auto-update as the live electron-updater feed.  
  Note: Unchanged by the delta. The manifest still pins 0.16.0 while the app is 0.17.0, so the ARP-correlation gap is already one minor version wide in practice.

- **[still-open · medium] F4 — Cask auto_updates true while the mac updater is inert unsigned — tap users stranded**  
  Now at: `packaging/homebrew/Casks/mogginglabs-workspace.rb:11`  
  Evidence: Cask line 11 is still `  auto_updates true`, emitted unconditionally by update-manifests.mjs:128 in caskTail (unchanged). docs/10:12 still reads macOS auto-update 'feed wired, **inert until signed** — Squirrel.Mac refuses unsigned updates' and line 11 still 'Signed today: no … cert pending'. No livecheck stanza added. brew upgrade still skips the cask; in-app updater still refuses.  
  Note: Unchanged by the delta. The Windows/macOS split is real platform divergence — Windows users update via the feed, mac tap users update via neither path — which holds this at medium rather than low.

- **[still-open · medium] F5 — RELEASING.md instructs hand-publishing the draft and still promises mac-x64**  
  Now at: `docs/RELEASING.md:13`  
  Evidence: git diff c026463..HEAD -- docs/RELEASING.md is empty. Line 3 still promises installers for `win-x64`, `mac-arm64`, `mac-x64`. Lines 12-14 still say 'curate the body … and **publish** it'. This contradicts release.yml:305-309 ('Humans never flip --draft=false by hand') and the publish job's `gh release edit "$TAG" --draft=false --latest` at release.yml:332.  
  Note: Delta sharpens it: docs/10:62 was edited only to move the x64 goalpost ('deferred as of v0.17.0', was v0.16.0) while RELEASING.md:3 still promises mac-x64 — the two docs drifted further apart, not closer.

- **[still-open · low] F6 — No test covers update-manifests.mjs despite a shipped URL-derivation regression**  
  Now at: `scripts/update-manifests.mjs:149`  
  Evidence: grep for update-manifests/winget/cask across tests/, src/main/smokes/, scripts/qa-smokes.sh returns zero hits at HEAD. All the untested munging is intact: version regex line 38, multi-version refusal 41-44, line 149 caskUrl doing `.replaceAll(' ', '.').replace(version, '#{version}')`, the #{arch} swap at 161, and the dual-arch vs arm-only branches at 150/165.  
  Note: Unchanged by the delta. Note line 149's `.replace(version, '#{version}')` is an unanchored first-occurrence replace on the filename — order-dependent, exactly the silent breakage a fixture snapshot pins.

### perf-and-perception-budgets-vs-shipped-smokes

- **[still-open · high] F1 — Echo-latency gate fails open: echo breakage passes MOGGING_PERCEPTION**  
  Now at: `src/main/smokes/perception-smoke.ts:167`  
  Evidence: File byte-identical to baseline. Line 167 still `(echoMedian === -1 || echoMedian <= B.echoMs) &&`. Inits -1 (123), set only under `if (pane1)` (125); all samples can resolve -1 via `setTimeout(() => res(-1), 1500)` (111), then `if (dt > 0) samples.push` (115) leaves it empty, med = -1 (128) -> PASS. Leak intact: `bridge.on('terminal:data', handler)` (110), no off.  
  Recommendation: As originally recommended: require `pane1 && echoSamples.length >= 4 && echoMedian >= 0 && echoMedian <= B.echoMs`, and call `bridge.off('terminal:data', handler)` in both the handler and the 1500ms timeout so stale pane-1 bytes cannot seed a fast best-of-6.  
  Note: Checked if the delta worsened it: v11 gen-gates input but transport.ts:214 accepts genless and daemon-relay.ts:447 forwards undefined gen, so the raw write still lands. Reachability unchanged; held high.

- **[still-open · high] F2 — docs/07 '0 frames >100ms under 16-agent torrent' asserted by no smoke**  
  Now at: `src/main/smokes/milestone-smoke.ts:168`  
  Evidence: File unchanged. `longFrames100: gaps.filter((g) => g > 100).length` still computed at line 82 and returned in `stress` (187), but budgetOk (168-172) checks only maxGapMs/avgFps/heap/idle and longFrames100 is absent from `pass` (173-182). PERCEPTION's torrent is still 8 panes / 2s (perception-smoke.ts:150 `p.id <= 8`, 159 `sleep(2000)`).  
  Recommendation: As originally recommended: add `stress.longFrames100 === 0` to budgetOk with the threshold via softGapMs(100) so soft CI relaxes it loudly. Baseline headroom (0 long frames on both recorded runs) is unchanged, so it lands green today.  
  Note: More load-bearing now: ConPTY v2, protocol v11 and replay/restore work all land inside the 16-pane torrent window nothing gates. docs/05:36 records it as 'frames > 100ms | 0 | 0 | (reported)' -- measured, never enforced.

- **[still-open · medium] F3 — Board view-toggle budget silently skipped if the button selector drifts**  
  Now at: `src/main/smokes/perception-smoke.ts:165`  
  Evidence: File unchanged. Line 165 still `(homeMax === -1 || homeMax <= B.actionMs) &&`, fed by line 84 `homeTimes.length ? Math.max.apply(null, homeTimes) : -1` and the `if (homeBtn)` guard at 78 -- a null querySelector at 76 leaves the loop unrun and the clause vacuously true. The drift comment at 72-75 ('Was the Home toggle') is still there.  
  Recommendation: Better fix now: 13 other smokes hardcode the same Board selector (board:161, boardv2:158, uxmilestone:264, gallery:1081, shot:439...), mostly silent `?.click()`. Hoist one throwing helper into smokes/kit.ts. Minimum stays the original `homeTimes.length === 4`.  
  Note: The selector currently resolves: titlebar.ts:79-84 builds IconButton({label:'Board'}), dom.ts:45 stamps aria-label, appended to .titlebar-right at titlebar.ts:101. Latent fail-open, not a currently-blind gate -- so medium, not raised.

- **[still-open · medium] F4 — Cold-start <=1000ms budget line has no enforcement anywhere**  
  Now at: `docs/07-perception-budget.md:29`  
  Evidence: docs/07 unchanged. Line 29 still declares '| Cold start -> interactive UI (packaged) | 1000 ms | <= 1000 ms | <= 500 ms |' in the hard table, while Enforcement (54-65) names only PERCEPTION, FLICKER, MILESTONE -- none measures startup. Repo grep still finds no startup-to-interactive timing (only brain reconcile, deep-link argv, heartbeat warmup, daemon restore).  
  Recommendation: As originally recommended: add a startup smoke (main stamps app-ready -> renderer first double-rAF paint, assert <=1000ms packaged, report-only in dev), or move the row to an explicit 'tracked manually, not asserted' section of docs/07.  
  Note: None of the five smokes added since baseline (defaultsmilestone, defaultstore, defaultsux, profiledefaults, restoredims) times startup, yet one-click agent setup, live PATH and the wizard redesign all added boot-path work.

- **[still-open · medium] F5 — docs/05 + docs/07 still describe the GL release-on-hide the product repealed**  
  Now at: `docs/05-perf-budget.md:48`  
  Evidence: Both docs unchanged. docs/05:48-51 still says the observer 'releases it when its workspace is hidden (display:none)'; docs/05:40 tabulates 'Hidden panes released GL | 16/16 | = 16'; docs/07:63 'a hidden workspace must still release all its contexts'. Code: pane-webgl.ts:135 `if (!this.host.isVisible() && glAttached.size > glBudget()) this.release()`, glBudget default 16 (line 34).  
  Recommendation: As originally recommended: rewrite docs/05:46-51 and the :40 baseline row, plus docs/07:41-43 and the FLICKER bullet at :63, to describe pressure-driven warm-keep (glBudget 16, evict-hidden-at-acquire, release only over cap, __moggingGlBudget=0 dev override).  
  Note: Path correction: the file is now src/ui/features/terminal/pane-webgl.ts. It changed +21/-5 but only on the context-loss path (release(notifyRendererChanged)); warm-keep untouched. flicker-smoke.ts:248 still asserts warmKept === 8.

- **[still-open · low] F6 — BUDGET provenance drift: wrong path, undocumented CI relaxation, stale comment**  
  Now at: `docs/05-perf-budget.md:10`  
  Evidence: All three sub-claims intact. docs/05:10 still 'Source of truth: `BUDGET` in `src/main/milestone-smoke.ts`' -- no such file (real: src/main/smokes/). The table (15-16) states 150ms / 30fps unconditionally while smoke-shell.ts:191-201 (softGapMs x4) and 203-210 (softFps /3) relax both under MOGGING_CI_GPU=soft. milestone-smoke.ts:35 still says soft 'relaxes ONLY this' while line 38 is `softFps(30)`.  
  Recommendation: As originally recommended, plus one line: fix the docs/05:10 path; note that MOGGING_CI_GPU=soft loudly relaxes gap (x4) and fps (/3) on software-GL CI only; correct the milestone-smoke.ts:35 comment; add the softEchoMs (x3) exception to docs/07's echo row.  
  Note: smoke-shell.ts is byte-identical to baseline. One point the original missed: softEchoMs (smoke-shell.ts:221, x3) also relaxes the docs/07:25 60ms echo row on soft CI, undocumented -- same drift class, same edit. Stays low.

### local-endpoint-token-custody-and-lifecycle

- **[still-open · high] F1 — No pre-auth timeout or buffer cap: unauthenticated sockets can hold main hostage**  
  Now at: `src/main/mcp-endpoint.ts:394`  
  Evidence: Handler L384-392 still has no auth timer; L394 is still `buf += chunk` uncapped. The only unauth destroy, L442-445 `if (!authed) { sock.destroy(); return }`, sits inside the `while ((i = buf.indexOf('\n')) >= 0)` loop (L396), so a newline-free stream never reaches it. Daemon reference unchanged: src/pty-daemon/transport.ts:90-92 `setTimeout(() => { if (!authed) sock.destroy() }, 3000)`.  
  Recommendation: As originally recommended; copy src/pty-daemon/transport.ts:90-92 verbatim (clear on welcome at L416/L438) plus a `if (buf.length > 262144) return sock.destroy()` after L394 — that sibling is the in-repo reference.  
  Note: mcp-endpoint.ts has zero diff vs c026463 — the 32-commit delta never touched this file. Severity unchanged: no-token local heap exhaustion of main (docs/05 heap budget) against a documented ~3s unauth-drop promise.

- **[still-open · high] F2 — connection.rpc MCP-proxy path attaches OAuth tokens with no grant or pane gate**  
  Now at: `src/main/mcp-endpoint.ts:196`  
  Evidence: REST route still gates on L179 `writeGranted: resolveWriteAllGranted(boundPane)`; the MCP-proxy fallthrough L184-219 uses `boundPane` nowhere — L196-200 `mcpFetch(upstream.url, payload, { token: upstream.token, ... })` forwards verbatim with the decrypted OAuth token, retried at L204-208. Paneless hello still auths on the file token alone (L412-417).  
  Recommendation: As originally recommended. Cheapest current form: hoist `const writeGranted = resolveWriteAllGranted(boundPane)` above L171 and on the proxy branch refuse `method === 'tools/call' && !writeGranted` with the L186-189 reason shape.  
  Note: Zero diff in the file; bin/mogging-connection.mjs:56 still says 'The MCP proxy path never reads it.' Blast radius grew — OAuth device flow landed (oauth.ts +262, ADR 0022), so more services sit behind this ungated path.

- **[still-open · medium] F3 — browser-control.json has no pid; crash-stale file and swallowed listen error mislead**  
  Now at: `src/main/mcp-endpoint.ts:596`  
  Evidence: L596 still writes three fields: `JSON.stringify({ version: PROTOCOL, address, token })` — no pid, non-atomic, swallowed by L597-599. L591-593 is still an empty `server.on('error', () => {})`. startMcpEndpoint L370-382 unlinks only the socket (L379), never the endpoint file. Contrast intact: daemon-client.ts:64-65 `endpointLive` checks `isAlive(ep.pid) && pipeAlive(ep.address)`.  
  Recommendation: As originally recommended.  
  Note: Unchanged. Bin clients still cannot distinguish a crash-stale file from a live one; the 'app is not running' misreport path is intact.

- **[still-open · medium] F4 — 0600 mode is a no-op on Windows; pipe never SID-restricted as ADR 0006 promises**  
  Now at: `src/backend/platform/runtime-paths.ts:42`  
  Evidence: ensureRuntimeDir still tightens POSIX-only: L42-48 `if (process.platform !== 'win32') { try { fs.chmodSync(dir, 0o700) } catch {} }` — no ACL branch, no icacls in the repo. mcp-endpoint.ts:596 `{ mode: 0o600 }` stays a no-op on win32, and socketAddress (mcp-endpoint.ts:57-60) still creates the pipe from a bare path string with no security descriptor. File is byte-identical to baseline.  
  Recommendation: As originally recommended. The doc half is now the cheaper half: amending docs/06 + ADR 0006 to state the actual Windows mechanism closes the docs-drift/gate-honesty part independently of the icacls work.  
  Note: Unchanged, and a live platform-parity violation: on Windows the trust-root token rests solely on inherited %LOCALAPPDATA% ACLs while macOS gets a real 0700 dir. Docs still overclaim a SID-restricted pipe.

- **[still-open · medium] F5 — stopMcpEndpoint leaves authed sockets serving; token never invalidated**  
  Now at: `src/main/mcp-endpoint.ts:603`  
  Evidence: stopMcpEndpoint unchanged at L603-615: `server?.close()`, `server = null`, `fs.unlinkSync(endpointFile())`. No iteration of `authedSocks` (declared L113, filled L415/L437, drained only by the per-socket close handler L576) and no reset of the module-level `token` (L112). net.Server.close() still refuses only NEW connections.  
  Recommendation: As originally recommended — a ~4-line fix that also shrinks F2's blast radius, so land it alongside F2.  
  Note: Unchanged. Still bounded by stop riding before-quit, but slightly more load-bearing now: what a surviving socket keeps is the ungated OAuth proxy path (F2), which now reaches more services after the device-flow work.

- **[still-open · medium] F7 — No test coverage for endpoint auth handshake, rotation, or stale-file lifecycle**  
  Now at: `src/main/smokes/mcp-smoke.ts:244`  
  Evidence: grep of tests/ for mcp-endpoint|browser-control|endpoint-client and for startMcpEndpoint|verifyPaneToken|paneToken both return nothing. Only custody assertion remains mcp-smoke.ts:244-260 token hygiene (`!allFrames.includes(appEp.token)`). Wrong-token refusal (L407-410), double-hello (`authPending || authed`, L407), paneToken rejection (L419-434), pre-auth destroy (L442-445) all unasserted.  
  Recommendation: As originally recommended, plus one case the delta justifies: assert a newline-free pre-auth write is dropped within ~3s. It fails today and becomes the regression lock for the F1 fix.  
  Note: More conspicuous now: the delta added 25 test files / +2528 lines under tests/ while the trust-root handshake still has none. Gate honesty: deleting the `msg.token !== token` compare at L407 would leave the whole suite green.

- **[still-open · low] F6 — macOS socket not chmod 0600 (daemon's is); crashed runs leak .sock files**  
  Now at: `src/main/mcp-endpoint.ts:594`  
  Evidence: The listen callback L594-600 still does only the endpoint-file write — no `fs.chmodSync(address, 0o600)`. The daemon still does it at src/pty-daemon/index.ts:138. Cleanup L379 `if (process.platform !== 'win32' && fs.existsSync(address)) fs.unlinkSync(address)` is pid-scoped (address embeds process.pid, L60); grep for readdirSync/isAlive in mcp-endpoint.ts returns nothing — no stale-sock sweep.  
  Recommendation: As originally recommended.  
  Note: Unchanged. Exposure still mitigated by the 0700 parent dir (runtime-paths.ts:44), which keeps this low; the sibling-endpoint divergence and macOS-only crash residue are the substance.

## Re-validated findings — gapfill areas

### agent-web-consent

- **[still-open · high] F1 — Deleted workspace's browser-drive consent resurrects for a reused workspace id**  
  Now at: `src/main/app-settings.ts:68 · src/main/browser-dock.ts:154`  
  Evidence: The `gone` loop still runs only clearGrant + removeAgentConfigTarget (app-settings.ts:68-73). clearGrant (grant-store.ts:125-134) touches only `integrations.grant.<id>`; kvLegacyConsent (grant-store.ts:56) is read-only. Gate unchanged at browser-dock.ts:154: consentFor reads getSetting(kvConsent(wsId)) === '1', used by agentAct via sessionForCtx (650).  
  Recommendation: In the `gone` loop clear browser.agentControl.<id>, browser.profile.<id>, browser.lastUrl.<id> and the workspace trail file alongside clearGrant.  
  Note: Trap: readGrant's legacy migration (grant-store.ts:101) would re-open web:'public' from a surviving consent row if the grant row were deleted.

- **[still-open · medium] F2 — Acts on the preview profile never land in the persistent trail**  
  Now at: `src/main/browser-dock.ts:674`  
  Evidence: `if (prof !== 'agent-web' || !ACT_VERBS.includes(v.verb)) return null` is still gateAct's first statement (line 674). Grep confirms the file's only recordTrail calls are 387 (origin-change), 639 (confirm), 678 (refused), 692 (ok) — all in gateAct/confirm. agentAct writes no trail entry, so acts under web:'public' produce zero JSONL.  
  Recommendation: Record preview-profile ACT verbs after the gate (verb + origin, outcome 'ok'), or amend docs/14 to scope the persistent trail to the signed-in profile.  
  Note: beginDriving (line 526) feeds only the volatile in-memory activity list, not recordTrail.

- **[still-open · medium] F3 — Web trail entries omit the acting pane, so web acts are not attributable**  
  Now at: `src/main/browser-dock.ts:673`  
  Evidence: Signature unchanged: `function gateAct(v, wc, wsId, prof)` (line 673) — no pane param, and the call site passes none: `gateAct(v, wc, sess.wsId, sess.profile)` (line 716) though ctx?.pane is in scope and reaches beginDriving (line 714). Neither recordTrail call (678, 692) nor origin-change (387) sets `pane`. TrailEntry.pane still exists (trail.ts:23).  
  Recommendation: Thread ctx?.pane into gateAct and set `pane` on the ok/refused entries and on the origin-change entry when a possession is live.  
  Note: MCP writes still record pane, so the asymmetry with mcp-endpoint.ts persists.

- **[still-open · medium] F4 — Trail records 'ok' before the act executes; 'confirmed' never applied to acts**  
  Now at: `src/main/browser-dock.ts:692`  
  Evidence: `recordTrail({ ... verb: v.verb, target: origin, outcome: 'ok' })` at line 692 still precedes `return null`; the verb runs afterwards in agentAct's switch, where click/type/select still return {ok:false,reason:'badtarget'} (lines 751/756/761) or throw. The only 'confirmed' outcome is the separate confirm entry at line 639 — no act entry carries it.  
  Recommendation: Record the act entry after the verb resolves with its real outcome, and use 'confirmed' for the first successful act following confirmPendingActOrigin.  
  Note: Contract still documents 'confirmed' = performed after confirm (contracts/integrations/trail.ts:15).

- **[still-open · medium] F5 — Sensitive-origin blocklist misses most major banks/brokerages**  
  Now at: `src/contracts/integrations/grant.ts:71`  
  Evidence: SENSITIVE_ORIGIN_PATTERNS (lines 71-79) unchanged: 'bank', 'chase.com', 'wellsfargo', 'paypal', 'venmo', 'coinbase', 'stripe.com', 'mail.google', 'gmail', 'outlook', 'mail.', 'proton.me', '.gov', 'irs.gov', 'ssa.gov', 'icloud.com', 'appleid.apple.com'. isSensitiveOrigin (line 80) is substring includes, so citi.com, fidelity.com, schwab.com, capitalone.com, robinhood.com pass.  
  Recommendation: Add the major US/UK financial host fragments to the list and pin them with a unit test enumerating expected-blocked origins.  
  Note: 'bank' does catch bankofamerica.com; the gap is non-'bank'-named institutions.

- **[still-open · medium] F6 — TOCTOU between origin gate and executeJavaScript lets an act run on an ungranted origin**  
  Now at: `src/main/browser-dock.ts:675`  
  Evidence: gateAct still resolves the origin once at dispatch: `const origin = v.verb === 'navigate' ? originOf(...) : originOf(wc.getURL())` (line 675). Execution happens later via `const run = (js) => wc.executeJavaScript(js, true)` (line 703) at lines 752/757/762/768. browser-page-scripts.ts carries no origin assertion, and nothing re-reads wc.getURL() before run().  
  Recommendation: Re-check grant + blocklist against wc.getURL() immediately before run(), or prefix injected scripts with a location.origin assertion that bails on mismatch.  
  Note: Window is narrow (page-initiated navigation committing between gate and inject) but it is exactly the boundary the per-origin grant holds.

- **[still-open · medium] F7 — Zero unit tests for grant sanitization, blocklist, and trail ring invariants**  
  Now at: `tests/unit/ (no grant-store/trail test) · grant-store.ts:63`  
  Evidence: tests/unit lists 34 files, none covering grants or the trail; grep for 'grant-store|sanitizeGrant|isBlockedActOrigin|normalizeActOrigin|browser-origin' across tests/ returns no hits. sanitizeGrant (grant-store.ts:63), the 200-origin cap (line 85), clearGrant's no-del fallback (line 133) and the ring caps (trail.ts:36-37) stay covered only by env-gated smokes.  
  Recommendation: Add tests/unit/grant-store.test.ts and trail-store.test.ts covering sanitizeGrant coercions, blocked-origin refusal, the 200-origin cap, ring/byte caps, torn lines, and normalizeBrowserOrigin drift.  
  Note: The 32-commit window added unit tests in other areas but none here.

### templates

- **[still-open · high] F1 — Template save persists custom: commands with no secret-shape refusal**  
  Now at: `src/backend/features/workspace/settings-store.ts:898 (was :777); src/main/templates.ts:30`  
  Evidence: saveTemplate still stores the mix verbatim: `.run(t.id, t.name, JSON.stringify(t.mix))` (settings-store.ts:903). valueLooksSecret (same file, line 48) is still called only from the agent-config path at line 497. Save handler unchanged: `ipcMain.handle(TemplateChannels.save, (_e, t) => getSettingsStore()?.saveTemplate(t))`.  
  Recommendation: Run redactSecrets/valueLooksSecret over each mix entry's provider string and the template name in saveTemplate (or registerTemplates) and refuse with the same typed refusal agent-settings uses.  
  Note: File grew ~121 lines since baseline, but the 06b template block is byte-identical; only line numbers shifted.

- **[still-open · medium] F2 — Saved presets silently lose their pane count (shell slots dropped)**  
  Now at: `src/ui/features/wizard/index.ts:1599-1616 (savePreset)`  
  Evidence: savePreset still builds mix from roster + custom only; no shell entry is pushed, while the name is `${...} agents · ${paneCount} panes` (line 1600). applyMix still derives the grid from flat.length + shell entries: `const shells = mix.filter((m) => m.provider === 'shell')...` then `if (total > paneCount) setGridSpec(...)` (lines 430-432).  
  Recommendation: Append { provider: 'shell', count: paneCount - agentTotal } in savePreset — applyMix (line 430) already counts shell entries, so apply restores the saved grid size.  
  Note: The launch path (index.ts:525) DOES push the shell remainder; only preset-save omits it, confirming the inconsistency.

- **[still-open · medium] F3 — templates:save accepts unvalidated payloads; malformed mixes break the wizard**  
  Now at: `src/main/templates.ts:30; src/backend/features/workspace/settings-store.ts:893-895`  
  Evidence: Handler unchanged (no shape check). loadTemplates still filters only on presence: `.filter((t): t is ProviderMixTemplate => t.mix !== undefined)` (line 895); parseJsonCell (workspace-rows.ts:16) returns any parsed JSON, so an object/number mix survives and reaches `p.mix.filter(...)` at wizard/index.ts:1629.  
  Recommendation: Validate id/name/mix shape in registerTemplates (reject 'preset-' ids, require array of {provider:string,count:finite}); harden the loadTemplates filter to Array.isArray(t.mix).  
  Note: src/main/templates.ts has zero diff since baseline c026463.

- **[still-open · medium] F4 — Machine pane budget enforced only in the wizard UI, not at the template open seam**  
  Now at: `src/ui/core/workspace/open-service.ts:49-52; src/ui/features/workspace/controller.ts:1848`  
  Evidence: openWorkspaceFromTemplate guards only the tool-plan invariant then calls the opener; controller.openFromTemplate (now :1848, was :1843) opens any spec.paneCount with no capacity comparison. effectiveMaxPanes/refusePaneCap (controller.ts:1199-1212) gate split/reorganize only; panesElsewhere is read solely by wizard/index.ts:1060.  
  Recommendation: Compare live pane total + spec.paneCount against machinePaneBudget(machineSpec()) in openFromTemplate or the opener at workspace/index.ts:488, and refuse or toast-warn, mirroring the wizard's budget copy.  
  Note: board/launch.ts:86 still calls the seam with paneCount 1 per card launch, unguarded.

- **[still-open · low] F5 — Curated grid list duplicated between backend resolve and UI layout, synced by comment**  
  Now at: `src/backend/features/templates/resolve.ts:5; src/ui/features/layout/templates.ts:19`  
  Evidence: resolve.ts:4-5 still reads `// (Kept in sync with the layout feature's TEMPLATE_COUNTS.)` / `const GRIDS = [1, 2, 4, 6, 8, 9, 12, 16]`; layout/templates.ts:19 declares the same literal as TEMPLATE_COUNTS. No shared contracts constant, no crosscheck test; a third copy sits in src/main/smokes/chromeux-smoke.ts:928.  
  Recommendation: Move the curated counts into src/contracts (beside ABS_MAX_PANES) and import in resolve.ts + layout/templates.ts; assert TEMPLATES' keys equal the shared list in a unit test.  
  Note: resolve.ts is unchanged since baseline.

- **[still-open · low] F6 — Built-in PRESETS served to no consumer; comments claim a Home launcher that does not exist**  
  Now at: `src/main/templates.ts:13; src/ui/features/wizard/index.ts:355-359`  
  Evidence: templates.ts:13 still comments "Home's presets, failable on demand". The only TemplateChannels.list caller is wizard.client.ts:26, and wizard/index.ts:359 still runs `presets = (p ?? []).filter((preset) => !preset.id.startsWith('preset-'))` under a comment claiming Home + asyncstate consume it. home/index.ts:94 only calls openWizard().  
  Recommendation: Surface the built-ins in a real UI or delete PRESETS plus the list-side merge; correct both comments; add a provider-mix-templates doc section.  
  Note: Docs still silent: only docs/research/2026-08-01-full-feature-audit.md mentions 06b/provider-mix. PRESETS still ships 4 unused mixes.

- **[still-open · low] F7 — No tests for template persistence or IPC handlers; only resolveLayout is covered**  
  Now at: `tests/unit/resolve-layout.test.ts:1-43 (34 files in tests/unit)`  
  Evidence: grep for saveTemplate/loadTemplates/removeTemplate across tests/ returns zero hits. resolve-layout.test.ts imports resolveLayout directly from src/backend/features/templates/resolve, so the templates:resolve handler's array-vs-{mix,exact} branching (templates.ts:26-27) stays untested. 11 new unit suites landed since baseline, none template-related.  
  Recommendation: Add a SettingsStore template suite (temp-file DB: save/overwrite/remove/load order, non-array and unparseable mix cells) plus a handler-level test for both resolve request dialects.  
  Note: resolve-layout.test.ts itself has no commits since c026463.

### palette-commands

- **[still-open · medium] F1 — Palette runs commands beneath a blocking modal; modalOpen still dead**  
  Now at: `src/ui/features/palette/index.ts:216-219, 179-190`  
  Evidence: Ctrl+K handler still `if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') { ... toggle(!openState) }` — no isBlockingModalOpen(). toggle(true) (:98-118) has no modal check; run() (:182) only `if (availability(cmd) !== true) return`. Grep modalOpen: only context.ts:19/69 define it, zero readers.  
  Recommendation: Early-return in toggle(true) when isBlockingModalOpen(), or make availability() refuse by default on ctx.modalOpen with an opt-in; else delete the dead field.  
  Note: Palette z-index 150 > modal 100, so it opens visibly above the dialog — not an invisible keystroke, hence medium.

- **[still-open · medium] F2 — Shift+Tab moves real focus onto a palette option row**  
  Now at: `src/ui/core/a11y/overlay-trap.ts:19 and :72-74`  
  Evidence: FOCUSABLE still contains `'button:not([disabled])'` (:19) with no tabindex exclusion; focusables() (:37-41) filters only hidden/offsetParent. Palette options are visible `button`s with `tabIndex: -1` (palette/index.ts:160), so they enter items[]. At the input: `else if (e.shiftKey && active === first) { e.preventDefault(); last.focus() }`.  
  Recommendation: Filter elements whose tabindex is '-1' out of focusables() so the input is both first and last; add a unit test with tabindex=-1 buttons.  
  Note: No overlay-trap test exists in tests/unit (34 files, none matching).

- **[still-open · medium] F3 — Ctrl+K matched via e.key, dead on non-Latin layouts**  
  Now at: `src/ui/features/palette/index.ts:216`  
  Evidence: `if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k')` unchanged, while brain/index.ts:68 uses `e.code === 'KeyM'`, board/index.ts:280 `e.code === 'KeyG'`, browser/index.ts:1102-1103 `e.code === 'KeyF'/'KeyL'`. Sweep targets unchanged too: app-shell.ts:127 ('b'), explorer/index.ts:775 ('e'), explorer:252 ('c').  
  Recommendation: Switch palette/index.ts:216 to `e.code === 'KeyK'` keeping modifier checks; sweep app-shell.ts:127 and explorer/index.ts:252,775 in the same change.  
  Note: Explorer chord moved 767 -> 775; still e.key-based.

- **[still-open · medium] F4 — Hint rank/icon maps cover 6 of 16 registered hint categories**  
  Now at: `src/ui/features/palette/index.ts:31-34, 123`  
  Evidence: HINT_PRI still `{ Workspace, Board, Integrations, App, Trust, Appearance }` (:31); HINT_ICON the same six (:32); fallbacks rank 2 / 'chevron-right' (:33-34). ctxRank (:123) is still `inWs && c.hint === 'Workspace' ? 1 : 0`. Registered hints also include Agent, Profiles, Pane, Layout, Explorer, Browser, Worktree, Updates, Notifications, Help.  
  Recommendation: Extend HINT_PRI/HINT_ICON to all 16 hints, add Pane/Layout/Agent to the in-grid ctxRank boost, and DEV-warn on a registered hint missing from the maps.  
  Note: Pane/Layout verbs at workspace/index.ts:806-851 still sort below 'Open integrations' on the empty query.

- **[still-open · medium] F7 — Zero unit tests for score(), the command registry, or availability**  
  Now at: `tests/unit (34 files); src/ui/core/commands/command-port.ts:50-64`  
  Evidence: Grep for palette|command-port|availability|score over tests/ returns no files. tests/unit now has 34 test files, none covering the palette. runCommand()'s refusal-toast path (command-port.ts:54-58) is untested and score() is still module-private (not exported) at palette/index.ts:15.  
  Recommendation: Add tests/unit/command-port.test.ts (runCommand hit/miss/refusal, setCommands republish) and export score() for golden ordering tests incl. the empty-query rank.  

- **[still-open · low] F5 — Rail toggle has a shortcut and titlebar button but no palette command**  
  Now at: `src/ui/shell/app-shell.ts:124-134`  
  Evidence: app-shell.ts binds Ctrl+Shift+B calling toggleRail() (:127-130) and shortcuts.ts:77 documents it, but grep for 'rail:toggle' across src returns nothing and app-shell.ts makes no setCommands() call. Explorer (explorer/index.ts:785) and browser (browser/index.ts:1117) dock toggles both register commands.  
  Recommendation: Register a 'rail:toggle' command (hint 'App', kbd 'Ctrl+Shift+B') from app-shell.ts calling toggleRail(), matching the explorer pattern.  

- **[still-open · low] F6 — Matcher scores out-of-order multi-word queries as zero**  
  Now at: `src/ui/features/palette/index.ts:15-28`  
  Evidence: score() unchanged: `const t = cmd.title.toLowerCase()` then prefix/word-start/substring, then a strict in-order subsequence returning 0 on the first miss (:24). The query is not tokenized (:121 `input.value.trim().toLowerCase()`), and cmd.hint / cmd.id are never searched.  
  Recommendation: Split the query on whitespace, require every token to match title+hint (prefix/word-start/substring, summed); keep single-token subsequence as fallback tier.  

- **[still-open · low] F8 — docs/11 contains no behavioral spec for the palette**  
  Now at: `docs/11-design-system.md:100, 411, 727`  
  Evidence: Palette still appears only as a --scrim consumer (:100 'the ONLY overlay film (palette + modal)'), a z-index rung (:411 'palette (150) and toasts (200)'), and an icon-table row (:727). No section covers registry coverage, matching, availability/refusal, or the keyboard contract; those remain code comments (palette/index.ts:45-49, 70-71; context.ts:4-15).  
  Recommendation: Add a palette/commands section to docs/11 stating the registry model, availability/refusal contract, empty-query rank intent, and the one-tab-stop keyboard contract.  

### settings-ui

- **[still-open · medium] F1 — Attention re-opens a hand-collapsed card on every signal**  
  Now at: `src/ui/components/collapsible-card.ts:129`  
  Evidence: Unchanged: `if (!open && opts.attentionOpens !== false) setOpen(true, { persist: false })` — only guard is !open, no transition latch. Feeders intact: usage.ts:735 in renderOverview, called from the UsageChannels.changed push at usage.ts:748-751; integrations.ts:1171 `onSignal((id, sig) => cards[id]?.setAttention(sig.chip))`, no dedupe.  
  Recommendation: Latch in setAttention: auto-open only on the null->non-null transition, reset when attention clears. Extend setusage-smoke: collapse Providers on a hot snapshot, assert a second changed push leaves it collapsed.  
  Note: Prior verifier's medium (UX-only) severity stands; the chip always renders, only the fold is forced.

- **[still-open · medium] F2 — Settings search (S5) has zero automated coverage**  
  Now at: `src/ui/features/settings/index.ts:884-985`  
  Evidence: Repo-wide grep for 'settings-search' outside index.ts hits only global.css:3681-3715; src/main/smokes/setshell-smoke.ts has no 'search' match; tests/ none. Fragile rules intact: index rebuilt on a session's first keystroke (l.950), Enter clicks first hit (l.981-984), fold opened before scroll (l.931-934).  
  Recommendation: Add setshell-smoke asserts: query a knob in a folded Usage card, assert .settings-search-hit, press Enter, assert tab shown, fold open, flash. Unit-pin the indexed class names.  
  Note: The walk at l.897-918 depends on 6 class names; a rename breaks search silently.

- **[still-open · medium] F3 — Search jump persists the fold; twin focus path does not**  
  Now at: `src/ui/features/settings/index.ts:933`  
  Evidence: jumpTo still does `fold.querySelector<HTMLButtonElement>('.cc-toggle')?.click()`, and collapsible-card.ts:120 is `toggle.onclick = () => setOpen(!open) // a hand-toggle always persists`. Twin path unchanged at integrations.ts:1115 `card.setOpen(true, { persist: false })`.  
  Recommendation: Expose a non-persisting external open (data-collapsible id -> handle registry, or a 'cc:open' CustomEvent handled with persist:false) and use it in jumpTo instead of clicking .cc-toggle.  
  Note: No 'cc:open' listener exists anywhere in the repo; the two machine-open paths still disagree.

- **[still-open · low] F4 — Search hits go stale mid-session as indexed nodes detach**  
  Now at: `src/ui/features/settings/index.ts:950`  
  Evidence: `if (!lastQuery) buildSearchIndex() // fresh walk per search session` unchanged; buildSearchIndex (l.897-918) stores direct element refs. Repaints still detach them: usage.ts:748-756 replaceChildren on plansTable (l.305) and grid (l.192); integrations render() rebuilds .toggle-row (integrations.ts:600,696) and .field-group (l.447-453) nodes.  
  Recommendation: Re-resolve the target at click time (tab id + stable selector), or rebuild the index on every input event — the ~80-node walk fits the docs/07 budget.  
  Note: Usage grid rows carry no indexed class, so the sharpest repro is an integrations toggle-row hit after a render(), not a usage row.

- **[still-open · low] F5 — Usage hot attention is color-only — no text or ARIA**  
  Now at: `src/ui/features/settings/usage.ts:693-702`  
  Evidence: computeAttention's hot branch is still bare: l.695-699 build `usage-track usage-track-row` + `usage-fill is-hot` at width 100% with no text and no aria-label; only the error branch appends a labelled pill (l.701 text 'error'). Integrations chips still carry words (integrations.ts:59).  
  Recommendation: Give the hot track an accessible name in computeAttention — a visually-hidden span or aria-label='usage above 90%' on the .usage-attn box — mirroring the integrations attnChip pattern.  
  Note: The always-visible Providers header announces nothing to a screen reader when a plan is hot.

- **[still-open · low] F6 — Shell docstrings drifted: 'NINE tabs' / '13 tabs' vs 14 sections**  
  Now at: `src/ui/features/settings/index.ts:78 and :886`  
  Evidence: l.78 still reads 'a left TAB rail of NINE tabs'; l.885-886 still reads '~80 across 13 tabs'. NAV_GROUPS (l.37-42) lists 14 ids (3+5+3+3) and the sections array defines 14 (ids at l.537,563,592,602,613,630,639,653,679,755,777,790,798,810).  
  Recommendation: Make the comments count-free ('NAV_GROUPS is the source of truth') or update them to 14; also fix l.34 'Nine flat rows say only there are nine'.  
  Note: l.34 is a third drift site the original finding did not list.

### theme-design-system

- **[still-open · medium] F1 — Documented color-literal grep gate is unwired and stale**  
  Now at: `docs/11-design-system.md:845; src/ui/styles/global.css:659,7240-7247`  
  Evidence: docs:844 still says 'all must return empty'; the awk '$1 > 152' grep at :845 returns 47 hits at HEAD (token blocks end ~global.css:283). No check-color-literals.mjs; grep 'color-literal' over *.sh/*.yml/*.mjs is empty. Strays live: 659 'color: #fff;', 7039/7042 lane hexes, 7240-7247 board dots, 3225/8422 raw shadows.  
  Recommendation: Add scripts/check-color-literals.mjs whitelisting token sections by banner, wire as run_static in qa-smokes.sh, then tokenize board/lane hues and shadows.  
  Note: Severity medium per prior verifier; docs claim unchanged and still false.

- **[still-open · medium] F2 — Phantom --surface-2 token in CSS; docs cite --surface-1/3, --text-dim**  
  Now at: `src/ui/styles/global.css:10909 (also :9858)`  
  Evidence: 10909 still reads 'background: var(--surface-2, rgba(128, 128, 128, 0.06));'. grep for '--surface-1:|--surface-2:|--surface-3:|--text-dim:' across src/ returns nothing. docs/11:758 still specs '--surface-3 base', :767 '--text-dim border', :768 '--surface-1 ring'. A second phantom landed at 9858: 'color: var(--text-dim, var(--text-mid));'.  
  Recommendation: Point 10909 and 9858 at real tokens (--bg-elevated / --text-mid) and correct docs/11:758-768 to --border/--bg-elevated/--muted.  
  Note: Slightly worse than reported: a second phantom var now exists at global.css:9858.

- **[still-open · medium] F3 — Spacing gate: one-line rules escape; malformed --max disables the freeze**  
  Now at: `scripts/check-spacing.mjs:19 and :41-43`  
  Evidence: Line 19 unchanged: /^\s*(padding|margin|gap|row-gap|column-gap)[a-z-]*\s*:/ is line-start anchored, so '.x { padding: 20px; }' is never tested. Line 41 args.indexOf('--max') still misses '--max=N' (max stays null, no gate); bare '--max' gives NaN and line 63 'violations.length > NaN' is false. qa-smokes.sh:186 still passes '--max 0'.  
  Recommendation: Strip selector prefixes before the SPACING test, accept --max=N, and exit non-zero when --max is present but its value is not finite.  
  Note: Both holes byte-for-byte unchanged from the audit baseline.

- **[still-open · medium] F4 — aa-probe leaves renderer frozen and theme unrestored if a step throws**  
  Now at: `src/main/smokes/aa-probe.ts:111-128`  
  Evidence: Line 111 still injects freeze() with no try/finally around the theme loop at 114-125; restore (127) and thaw (128) run only after a clean pass, so any rejection skips both. Rounding hazard intact: measure() rounds at line 70 and line 123 compares that rounded value to AA_TEXT.  
  Recommendation: Wrap the theme loop in try/finally with restore+thaw in finally; compare the unrounded ratio to AA_TEXT and round only for the report.  
  Note: No guard added; function body unchanged apart from surrounding context.

- **[still-open · low] F5 — docs/11 rail spec contradicts shipped CSS; stale ramp comment in model.ts**  
  Now at: `docs/11-design-system.md:196,215; src/ui/features/workspace/model.ts:45`  
  Evidence: docs:215 still says overflow 'fades via an alpha mask-image'; global.css:1699 is 'text-overflow: ellipsis;' under a 2026-07-10 comment reversing the mask. docs:196 still says the bar floats '1px off the outline', insets '= the corner radius'; global.css:1789-1791 has 'left: 0;' and calc(var(--r-md) - 2px). model.ts:45 still says '54% toward black'.  
  Recommendation: Rewrite docs/11:196 and :215 to the shipped ellipsis/left:0/r-md-2px treatments; restate model.ts:45 via --ws-ink-mix (46% toward --text-hi on light).  
  Note: Line numbers shifted (214-215 to 196/215; 44-46 to 45); the stale text is identical.

- **[still-open · low] F6 — Solarized terminal foreground diverges from chrome --text-hi**  
  Now at: `src/ui/core/theme/themes.ts:176 (chrome value at :164)`  
  Evidence: themes.ts:6-9 still promises a terminal theme 'derived from the same values, so panes always match chrome'. Solarized chrome sets '--text-hi': '#eee8d5' (line 164) but terminalFrom is hand-passed '#e4ddc8' (line 176). Nord passes matching #eceff4 (chrome :137, terminal :148); midnight/light pass their whole chrome object (:117, :124). No comment explains the gap.  
  Recommendation: Pass '#eee8d5' to terminalFrom for solarized, or add a comment stating the deliberate dimming and mirror it in docs/11's theme section.  
  Note: Unchanged; solarized is the only theme that hand-forks its terminal foreground.

### qa-gates-integrity

- **[still-open · high] F1 — BOOTFAIL verdicts pass CI green on linux/macos**  
  Now at: `scripts/check-sweep-log.sh:10 · .github/workflows/ci.yml:305,389`  
  Evidence: Line 10 unchanged: BAD=$(sed -n '/SWEEP RESULTS/,$p' "$LOG" | grep -cE ' (FAIL|MISSING)$' || true) — 'BOOTFAIL' has T before FAIL so never matches. qa-smokes.sh:143 still sets v="BOOTFAIL". ci.yml linux (305 '| tee sweep.log') and macos (389) still have no `shell: bash`; only windows (452-467) does.  
  Recommendation: Change grep to ' (FAIL|MISSING|BOOTFAIL)$' (or count lines not ending ' PASS') and add `shell: bash` / `set -o pipefail` to the linux+macos sweep steps.  
  Note: No commit since c026463 touched check-sweep-log.sh's regex.

- **[still-open · medium] F2 — Gate registry one-directional: dispatches with no sweep row**  
  Now at: `scripts/check-gates.mjs:47-48 · src/main/index.dev.ts:510,524`  
  Evidence: check-gates.mjs still only filters sweep gates: `undispatched = gates.filter(...)` / `unlisted = gates.filter(...)` — nothing walks index.dev.ts back to qa-smokes.sh. index.dev.ts:510 `if (process.env.MOGGING_AGENT)` and :524 `else if (process.env.MOGGING_WORKSPACE)` still have no `run_smoke` row (grep of qa-smokes.sh returns none).  
  Recommendation: Add the reverse check to check-gates.mjs: every MOGGING_* dispatch in index.dev.ts needs a run_smoke row or an explicit declared allowlist entry (SHOT, GALLERY, AGENT, WORKSPACE).  
  Note: No new script does the reverse check; scripts/ list confirms only check-gates.mjs and check-prod-artifact.mjs read index.dev.ts.

- **[still-open · medium] F3 — Sweep job timeouts cannot host the ~4h sweep**  
  Now at: `.github/workflows/ci.yml:7,238,334,418`  
  Evidence: ci.yml:7 still reads 'Full 207-gate sweeps are heavy (~4h each)'; linux timeout-minutes: 120 (238), macos 120 (334), windows 150 (418). Summing the run_smoke timeout column now gives 39,180s (~10.9h) across 176 rows — worse than the audited 39,120s. check-sweep-log.sh still asserts no expected gate count.  
  Recommendation: Raise timeout-minutes on the three sweep jobs past measured full-sweep duration (or correct ci.yml:7), and make check-sweep-log.sh assert the results block holds the full derived gate count.  
  Note: Gate count grew since the audit; the mismatch widened rather than closed.

- **[still-open · medium] F4 — softEchoMs contradicts both soft-CI honesty statements**  
  Now at: `src/main/smokes/smoke-shell.ts:189,221-222 · scripts/qa-smokes.sh:10`  
  Evidence: smoke-shell.ts:189 still states 'Echo-latency/heap/correctness claims are never relaxed'; qa-smokes.sh:10 still says soft 'relaxes ONLY frame-gap budgets'. softEchoMs (221) still gates on platform-agnostic `if (process.env.MOGGING_CI_GPU !== 'soft') return desktopMs` (222) — no process.platform==='win32' scope, so linux/macos soft sweeps get 60→180ms.  
  Recommendation: Scope softEchoMs to process.platform==='win32' (its stated virtualized-PTY justification) and correct the smoke-shell.ts:189 docstring plus the qa-smokes.sh:10 header.  
  Note: softEchoMs's own docstring (212-220) explains the Windows VM rationale but the code applies it everywhere.

- **[still-open · medium] F5 — PRODMILESTONE discards 16-pane wait, floors panes across workspaces**  
  Now at: `src/main/smokes/prodmilestone-smoke.ts:399,425,429`  
  Evidence: 399: `await waitUntil(async () => Number(await ES(...paneCount()...)) === 16, 20000, 400)` — return value still discarded, not ANDed into pass. 425 still `livePanes: (m.panes || []).length` (all workspaces) and 429 still `&& phaseB.livePanes >= 12` as the only backstop, while the torrent filter `p.id > b && p.id <= b + 16` is used only for the writer set.  
  Recommendation: Capture the waitUntil boolean into a named flag ANDed into pass, and report/floor livePanes on the torrent workspace's pane range only (or require exactly 16 and record the measured count).  
  Note: budgetsHold feeds the final pass at line 473 and the result JSON at 509.

- **[still-open · low] F6 — harness-install isSmoke uses the abandoned any-MOGGING_* denylist**  
  Now at: `src/main/harness-install.ts:65-69`  
  Evidence: Line 68 unchanged in shape: `const isSmoke = Object.keys(process.env).some((k) => k.startsWith('MOGGING_') && !SELF_SET_ENV.has(k))`, with SELF_SET_ENV = new Set(['MOGGING_CHANNEL', 'MOGGING_CLI']) at 65. index.dev.ts still keeps the SMOKE_ENV allowlist (217-218) that replaced exactly this heuristic; nothing shares it with usageWorld().  
  Recommendation: Export SMOKE_ENV (or pass it into installHarnessPorts) and derive isSmoke from the allowlist, so knob vars like MOGGING_INPROC keep real adapters in a dev session.  
  Note: MOGGING_INPROC=1 npm run dev still lands in the empty usage world.
