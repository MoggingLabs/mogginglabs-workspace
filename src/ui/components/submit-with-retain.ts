/**
 * submitWithRetain — the ONE submit path for a form that carries a SECRET
 * (audit finding 35).
 *
 * Four forms in this app accept a secret: the service-key vault, an add-server env
 * literal, a usage provider key, a webhook URL. Every one of them made the same
 * mistake, in the same shape — `input.value = ''` ABOVE the `await`:
 *
 *     keyInput.value = ''                       // "the value leaves the DOM"
 *     const r = await bridge.invoke(…)          // …and when this REFUSES?
 *     if (!r.ok) note.textContent = r.reason    // the reason is shown to an empty field
 *
 * A key is pasted ONCE — that is the whole promise of a paste-once vault: after the
 * paste, nothing else on this machine still has it. So clearing before the round trip
 * means a refusal (an env NAME that fails the regex, a settings store not yet up, a
 * locked OS keychain, a webhook host that needs the LAN ack) DESTROYS what the user
 * pasted. They cannot retype what they can no longer see.
 *
 * The rule, in one line: a secret leaves the DOM only once the round trip says it is
 * safe somewhere else. Everything below is that rule.
 *
 * Note what those forms already got right, and only for the field that didn't matter:
 * each one clears its adjacent NON-secret input inside `if (r.ok)`. The correct
 * sequencing was two lines away, in the same handler, in every case.
 */
export interface SubmitWithRetainOpts<T extends { ok: boolean; reason?: string }> {
  /** Disabled + aria-busy for the whole round trip — this is the double-submit guard. */
  trigger: HTMLButtonElement
  /** SECRET-bearing inputs: retained on failure, cleared + scrubbed ONLY on success. */
  retainFields: HTMLInputElement[]
  /** Non-secret inputs (a name, a label, an id): cleared on success, as they already were. */
  clearFields?: HTMLInputElement[]
  /** Where the refusal lands. Cleared while in flight, so a stale reason never reads as this attempt's verdict. */
  errorEl?: HTMLElement
  /** The round trip. Anything it THROWS is treated exactly like `{ ok: false }`. */
  submit: () => Promise<T>
  onSuccess?: (r: T) => void | Promise<void>
  /**
   * Compensation for anything the submit already committed before it failed. The
   * add-server form vaults env literals one at a time on its way to `serversSave`;
   * when the save then refuses, this is the only thing that can un-orphan them.
   */
  onFailure?: (r: T | { ok: false; error: unknown }) => void | Promise<void>
}

/** Empty a secret-bearing field, leaving nothing behind that still answers with the secret. */
export function scrubFields(...fields: HTMLInputElement[]): void {
  for (const field of fields) {
    if (!field) continue
    // Overwrite BEFORE emptying. A bare `value = ''` leaves the typed string as the node's
    // last edit state — one Ctrl+Z in the field can bring a pasted key back verbatim. The
    // overwrite makes that recoverable state harmless. (The JS string itself is immutable
    // and beyond our reach; what we CAN promise is that no DOM node still answers with it.)
    if (field.value) field.value = '•'.repeat(Math.min(field.value.length, 64))
    field.value = ''
    // A `hidden` form is display-toggled, never destroyed. The add-server form kept a pasted
    // literal alive in its input for the whole session — including after a SUCCESSFUL save —
    // and re-showed it, verbatim, on the next open. Reset the default too, so a re-open (or
    // a form.reset()) starts genuinely empty.
    field.defaultValue = ''
  }
}

export async function submitWithRetain<T extends { ok: boolean; reason?: string }>(
  opts: SubmitWithRetainOpts<T>
): Promise<boolean> {
  const { trigger, errorEl } = opts
  // SYNCHRONOUS, before the first await. The browser will not dispatch a click to a disabled
  // button, so the second of two fast clicks never reaches us: one paste, one vault write.
  // The re-entry check covers the paths a real click never took (a handler invoked directly,
  // an Enter key wired to the same function).
  if (trigger.disabled) return false
  trigger.disabled = true
  trigger.setAttribute('aria-busy', 'true')
  if (errorEl) {
    errorEl.textContent = ''
    errorEl.hidden = true
  }
  const fail = (reason: string): void => {
    if (!errorEl) return
    errorEl.textContent = reason
    errorEl.hidden = false
  }
  try {
    let result: T
    try {
      result = await opts.submit()
    } catch (error) {
      // A THROW carries the same contract as a refusal: the secret stays in the field. A dead
      // IPC transport is precisely the moment a user must not lose a key they can't re-paste.
      fail(error instanceof Error ? error.message : String(error))
      await opts.onFailure?.({ ok: false, error })
      return false
    }
    if (!result.ok) {
      // RETAIN. The field keeps its value so the user can fix the NAME (or tick the ack, or
      // wait for the store) and submit again — without re-pasting a key they may not still have.
      fail(result.reason ?? 'refused')
      await opts.onFailure?.(result)
      return false
    }
    // The ONE branch allowed to destroy what the user typed: the value is ciphertext somewhere
    // else now. Secrets scrubbed first, then the plain fields that were always cleared here.
    scrubFields(...opts.retainFields, ...(opts.clearFields ?? []))
    await opts.onSuccess?.(result)
    return true
  } finally {
    // A success often re-renders the block that owns this button (usage rebuilds the whole
    // provider row), leaving `trigger` detached. Re-enabling a dead node is pointless — the
    // guard says so out loud. What matters is that a LIVE button always comes back enabled:
    // a Save stuck disabled after a refusal would be its own way of losing the secret.
    if (trigger.isConnected) {
      trigger.disabled = false
      trigger.removeAttribute('aria-busy')
    }
  }
}
