import { describe, expect, it } from 'vitest'
// Straight to the module (see the note in notify-session-start.test.ts): the root
// backend barrel pulls in native-dependent code this test never touches.
import { compositeTelemetry } from '@backend/core/telemetry/composite'
import type { Telemetry, TelemetryEvent, TelemetryProps } from '@contracts'

// THE CONSENT LEAK, pinned.
//
// Settings offers two independent permissions — error reporting and product analytics —
// and defaults both OFF. The composition root honoured them when it CHOSE which adapters
// to build, then discarded them when it CALLED them: every method was fanned out to every
// active adapter. So with error reporting ON and analytics OFF, the Sentry adapter — whose
// captureEvent is Sentry.captureMessage(name, { level: 'info', extra: props }) — received
// and uploaded every product event: agent.launched with its provider, wizard and browser
// usage, app.launched. The user was told analytics were off. They were being sent.
//
// The fix routes by permission at the composite, so an adapter cannot violate consent by
// behaving: the call never reaches it.

/** Records what each vendor was actually asked to send. */
function spy(name: string, log: string[]): Telemetry {
  return {
    init: () => undefined,
    captureError: () => log.push(`${name}:error`),
    captureEvent: (_e: TelemetryEvent) => log.push(`${name}:event`),
    addBreadcrumb: () => log.push(`${name}:crumb`),
    setContext: (_k: string, _v: TelemetryProps) => log.push(`${name}:context`),
    flush: async () => undefined
  }
}

const EVENT: TelemetryEvent = { name: 'agent.launched', props: { provider: 'claude' } }

describe('compositeTelemetry', () => {
  it('does NOT send product events to an error-only adapter', () => {
    const log: string[] = []
    const sentry = spy('sentry', log)
    compositeTelemetry([sentry], []).captureEvent(EVENT)
    expect(log).toEqual([]) // the leak: this used to be ['sentry:event']
  })

  it('does NOT send errors to an analytics-only adapter', () => {
    const log: string[] = []
    compositeTelemetry([], [spy('posthog', log)]).captureError(new Error('boom'))
    expect(log).toEqual([])
  })

  it('still delivers each call to the adapter that IS permitted', () => {
    const log: string[] = []
    const t = compositeTelemetry([spy('sentry', log)], [spy('posthog', log)])
    t.captureError(new Error('boom'))
    t.captureEvent(EVENT)
    expect(log).toEqual(['sentry:error', 'posthog:event'])
  })

  it('treats breadcrumbs as crash context, not analytics', () => {
    const log: string[] = []
    compositeTelemetry([spy('sentry', log)], [spy('posthog', log)]).addBreadcrumb({ category: 'ui', message: 'clicked' })
    expect(log).toEqual(['sentry:crumb'])
  })

  it('with analytics consent alone, an error never reaches a vendor', () => {
    // The exact inverse of the shipped bug, and the shape a DO_NOT_TRACK user relies on.
    const log: string[] = []
    const t = compositeTelemetry([], [spy('posthog', log)])
    t.captureError(new Error('boom'))
    t.addBreadcrumb({ category: 'ui', message: 'clicked' })
    expect(log).toEqual([])
  })

  it('sends nothing at all when neither consent is given', () => {
    const log: string[] = []
    const t = compositeTelemetry([], [])
    t.captureError(new Error('boom'))
    t.captureEvent(EVENT)
    t.addBreadcrumb({ category: 'ui', message: 'clicked' })
    expect(log).toEqual([])
  })

  it('never double-sends to an adapter that holds both permissions', () => {
    const log: string[] = []
    const both = spy('both', log)
    const t = compositeTelemetry([both], [both])
    t.setContext('app', { version: '1' })
    void t.flush()
    expect(log).toEqual(['both:context'])
  })
})
