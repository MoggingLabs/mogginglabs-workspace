import { describe, expect, it } from 'vitest'
import { bodyWithoutComments, sourceOf } from './source-body'

// THE GENERATED FILES MUST NOT BE REWRITTEN ON EVERY LAUNCH.
//
// Four files were written unconditionally per agent launch (claude's --settings
// overlay; gemini's system settings; opencode's tui.json and notify plugin) plus two
// full content re-reads (the context relay, the notify script) — pure restatement of
// bytes that were already correct, on the critical path of every pane the user opens.
//
// Both files import electron (`app.getPath`), so the WIRING is asserted over source —
// the same fallback pane-life.test.ts uses, with anchors that throw when they stop
// matching. What the gates prove (NOTIFYHOOK, notifyparity, ctxaccuracy boot the app
// and assert the generated files actually work) this file cannot; what this file
// prevents is a future edit quietly deleting a guard and restoring the per-launch
// write storm, which every gate would still pass.

describe('claudeStatuslineArgs writes only what is not already there', () => {
  const src = sourceOf('src/main/context.ts')
  const body = bodyWithoutComments(src, 'export function claudeStatuslineArgs(')

  it('skips the settings write when this run already wrote that digest and the file exists', () => {
    // The name IS the content (sha256 digest), so a digest hit + existsSync is proof.
    expect(body).toMatch(/writtenSettingsDigests\.has\(digest\)/)
    expect(body).toMatch(/existsSync\(settings\)/)
    expect(body, 'a skipped write must not be remembered as done').toMatch(
      /writtenSettingsDigests\.add\(digest\)/
    )
  })

  it('content-verifies the relay once per run, then existence-checks it', () => {
    expect(body).toMatch(/relayVerified/)
    expect(body).toMatch(/existsSync\(statuslineRelayFile\)/)
    expect(body, 'the first launch of a run must still compare RELAY_SOURCE bytes').toMatch(
      /readRelay\(statuslineRelayFile\) !== RELAY_SOURCE/
    )
  })

  it('creates the directory once per run', () => {
    expect(body).toMatch(/relayDirReady/)
  })

  it('re-arms both verifications when a write fails', () => {
    // The catch is the honesty valve: a run that failed to write must not carry a
    // "verified" flag into the next launch.
    expect(body).toMatch(/relayVerified = false/)
    expect(body).toMatch(/relayDirReady = false/)
  })
})

describe('the notify-hook generators write only on change', () => {
  const src = sourceOf('src/main/notify-hook.ts')

  it('notifyHookPath content-verifies once per run, then existence-checks', () => {
    const body = bodyWithoutComments(src, 'export function notifyHookPath(')
    expect(body).toMatch(/scriptVerified/)
    expect(body).toMatch(/existsSync\(file\)/)
    expect(body, 'the first launch of a run must still compare the source bytes').toMatch(
      /readGeneratedBytes\(file\) !== NOTIFY_HOOK_SOURCE/
    )
    expect(body, 'a failed write must re-arm the verify').toMatch(/scriptVerified = false/)
  })

  it('writeGenerated compares before writing and never memoizes a failure', () => {
    const body = bodyWithoutComments(src, 'function writeGenerated(')
    expect(body, 'the fast path is memo hit + file present').toMatch(
      /generatedMemo\.get\(name\) === content && existsSync\(file\)/
    )
    expect(body, 'a memo miss must re-read and compare, not blind-write').toMatch(
      /readGeneratedBytes\(file\) !== content/
    )
    expect(body).toMatch(/generatedMemo\.set\(name, content\)/)
    expect(body, 'a failed write must drop the memo entry').toMatch(/generatedMemo\.delete\(name\)/)
  })
})
