import { app } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LinkStatus, ServiceAdapter, ServiceLink } from '@contracts'
import { ServiceEngine, createFakeAdapter, parseServiceLink, transitionLabel } from '@backend/features/integrations'

// Env-gated service-links smoke (MOGGING_INTEG, Phase-8/12). FAKE world only —
// ZERO network. Proves the seam: link parse, per-fixture snapshot shape, stale-
// after-error (last good re-served), the review TRANSITION firing the pane
// notify, the poller pausing while hidden, and unlinking stopping the poll.

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const link = (id: string, ref: string): ServiceLink => ({ id, service: 'fake', cardId: `c-${id}`, kind: 'pr', ref, cadence: '5m' })

export async function runIntegSmoke(): Promise<void> {
  let result: Record<string, unknown> = { pass: false }
  try {
    // ── link parse: URL, shorthand, reject ──────────────────────────────────
    const p1 = parseServiceLink('https://github.com/acme/web/pull/12')
    const p2 = parseServiceLink('acme/web#34')
    const p3 = parseServiceLink('https://github.com/acme/web/issues/9')
    const p4 = parseServiceLink('just some text')
    const parseOk =
      p1?.ref === 'acme/web#12' && p1?.kind === 'pr' && p2?.ref === 'acme/web#34' && p3?.kind === 'issue' && p4 === null

    // ── per-fixture snapshot shape (the FAKE vocabulary) ────────────────────
    const transitions: string[] = []
    let pushes = 0
    const engine = new ServiceEngine({
      adapters: { fake: createFakeAdapter() },
      onPush: () => pushes++,
      onTransition: (_l, label) => transitions.push(label),
      jitter: () => 0
    })
    engine.setLinks([link('a', 'acme/green#1'), link('b', 'acme/failing#2'), link('c', 'acme/error#3'), link('d', 'acme/merged#4')])
    await sleep(60)
    const byId = (id: string): LinkStatus | undefined => engine.snapshot().statuses.find((s) => s.linkId === id)
    const fixtureOk =
      byId('a')?.checks === 'passing' &&
      byId('a')?.health === 'fresh' &&
      byId('b')?.checks === 'failing' &&
      byId('c')?.health === 'error' && // no prior good -> error
      byId('d')?.state === 'merged'

    // ── stale-after-error: a link that WAS fresh, then the adapter throws,
    //    re-serves last good as STALE (keeps the old fetchedAt). ─────────────
    let mode: 'ok' | 'throw' = 'ok'
    const flaky: ServiceAdapter = {
      id: 'fake',
      async detect() {
        return { ok: true }
      },
      async fetch(l: ServiceLink) {
        if (mode === 'throw') throw new Error('rate limited')
        return { linkId: l.id, health: 'fresh', fetchedAt: Date.now(), state: 'open', reviewDecision: 'review-required', checks: 'passing', title: 'ok' }
      }
    }
    const e2 = new ServiceEngine({ adapters: { fake: flaky }, onPush: () => {}, onTransition: () => {}, jitter: () => 0 })
    e2.setLinks([link('s', 'acme/x#1')])
    await sleep(30)
    const goodAt = e2.statusFor('s')?.fetchedAt
    mode = 'throw'
    e2.refresh('s')
    await sleep(30)
    const staleStatus = e2.statusFor('s')
    const staleOk = staleStatus?.health === 'stale' && staleStatus?.fetchedAt === goodAt && staleStatus?.checks === 'passing'

    // ── review TRANSITION -> notify label (review-required -> changes-requested)
    let decision: 'REVIEW_REQUIRED' | 'CHANGES_REQUESTED' = 'REVIEW_REQUIRED'
    const flip: ServiceAdapter = {
      id: 'fake',
      async detect() {
        return { ok: true }
      },
      async fetch(l: ServiceLink) {
        return { linkId: l.id, health: 'fresh', fetchedAt: Date.now(), state: 'open', reviewDecision: decision === 'CHANGES_REQUESTED' ? 'changes-requested' : 'review-required', checks: 'passing' }
      }
    }
    const tHits: string[] = []
    const e3 = new ServiceEngine({ adapters: { fake: flip }, onPush: () => {}, onTransition: (_l, label) => tHits.push(label), jitter: () => 0 })
    e3.setLinks([{ ...link('t', 'acme/web#123'), kind: 'pr' }])
    await sleep(30) // first fetch: not a transition
    decision = 'CHANGES_REQUESTED'
    e3.refresh('t')
    await sleep(30)
    const transitionOk = tHits.length === 1 && tHits[0] === 'PR #123: changes requested'
    // the pure label fn also rejects a first-fetch as a transition
    const firstNotTransition = transitionLabel(link('z', 'a/b#1'), undefined, { linkId: 'z', health: 'fresh', fetchedAt: 0, reviewDecision: 'approved' }) === null

    // ── poller pauses while hidden (a refresh does not fetch) ────────────────
    const beforeAt = e2.statusFor('s')?.fetchedAt
    mode = 'ok'
    e2.setVisible(false)
    e2.refresh('s')
    await sleep(30)
    const pausedOk = e2.statusFor('s')?.fetchedAt === beforeAt // unchanged: hidden
    e2.setVisible(true)
    e2.refresh('s')
    await sleep(30)
    const resumeOk = e2.statusFor('s')?.health === 'fresh'

    // ── unlinking stops the poll (removed from the snapshot) ─────────────────
    e2.removeLink('s')
    const unlinkOk = e2.snapshot().statuses.length === 0

    const pass = parseOk && fixtureOk && staleOk && transitionOk && firstNotTransition && pausedOk && resumeOk && unlinkOk && pushes > 0
    result = { pass, parseOk, fixtureOk, staleOk, transitionOk, firstNotTransition, pausedOk, resumeOk, unlinkOk }
  } catch (e) {
    result = { pass: false, error: String(e) }
  }
  try {
    writeFileSync(join(app.getAppPath(), 'out', 'integ-result.json'), JSON.stringify(result, null, 2))
  } catch {
    /* best effort */
  }
  app.exit(result.pass ? 0 : 1)
}
