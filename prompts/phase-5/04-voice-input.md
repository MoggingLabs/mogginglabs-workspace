Hands on keyboard is optional: **push-to-talk into the focused pane**. Hold a key,
speak, review the transcript, Enter sends it to the agent. LOCAL-FIRST and consent-
explicit: audio never leaves the machine, transcripts go only where the user aims.

## Steps
1. **Capture + STT seam** (`src/ui/features/voice/` + `src/backend/features/stt/`):
   renderer captures mic audio (getUserMedia) ONLY while push-to-talk is held and
   ONLY after a per-session consent prompt (first use each app run: a modal stating
   exactly what happens — local capture, local transcription, nothing stored).
   Transcription behind ONE seam `transcribe(wavBuffer): Promise<string>` with two
   backends chosen in Settings: `system` (Windows: PowerShell System.Speech dictation
   is unreliable — prefer the WebSpeech API where Chromium supports it locally; TEST
   and document which engines are truly offline per OS) and `whisper-cli` (BYO: the
   user points Settings at a local whisper.cpp/faster-whisper executable — we
   execFile it with the wav, arg array, never install or download models ourselves).
   If neither is configured → the voice command explains how, and does nothing else.
2. **The flow**: global chord (default `Ctrl+Shift+Space`, Settings-remappable within
   our existing chord constraints) → overlay chip on the focused pane ("listening…",
   level meter) → release → transcribe → an INLINE REVIEW popover anchored to the
   pane: editable text, [Send ⏎] [Discard Esc]. Send = one `terminal:write` of the
   text (no auto-Enter unless the user hits Enter in the popover — sending a newline
   to an agent is an ACTION, the user takes it).
3. **Settings § Voice**: engine picker (`off` default / system / whisper CLI path
   textbox with an execFile probe button), chord display, and the consent copy.
   The whisper path is a POINTER (profiles rules): validated shape, never a secret.
4. **Budgets**: capture + transcription must not touch the hot path — transcribe in
   `@backend` (main) off the renderer thread; PERCEPTION re-runs green.
5. **Smoke** (`MOGGING_VOICE`): no real mic — a fake STT backend
   (`MOGGING_STT_FAKE=<text>` env makes `transcribe()` return it): isolated boot →
   consent modal asserted + accepted (DOM) → chord keydown/keyup dispatched → review
   popover shows the fake transcript → edit it → Send → the pane buffer contains the
   edited text and NOT the unedited one → Discard path leaves the buffer untouched →
   with engine `off`, the chord produces the explainer toast, never capture.

## Files
- `src/ui/features/voice/` (+ overlay/popover CSS) · `src/backend/features/stt/` ·
  `src/main/stt.ts` + channels (`stt:transcribe`, `stt:probe`) · Settings § Voice ·
  `src/main/voice-smoke.ts` · `scripts/qa-smokes.sh`

## Definition of Done
- Hold-to-talk → reviewed transcript → focused pane, on a locally-configured engine;
  engine `off` by default; consent gate provably precedes any capture.
- PERCEPTION unchanged; the overlay adds zero idle cost (event-driven only).

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- `MOGGING_VOICE` green isolated; PERCEPTION + SMOKE still green.

## Guardrails
- LOCAL-FIRST is absolute: no cloud STT, no audio written to disk, no transcript in
  telemetry/logs/state — the transcript's ONLY destination is the pane the user
  aimed at, after review. Counts/booleans (`voice_used`, engine kind) are fine.
- Mic access only while the chord is held; the indicator must be unmissable.
- BYO engine (ADR 0002 spirit): we point at the user's whisper binary; we never
  download, bundle, or update models.
