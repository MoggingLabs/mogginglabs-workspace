import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// THE AGENT-BROWSING AUDIT TRAIL, AND THE ORIGIN IT NAMES.
//
// browser-dock.ts imports electron, so these are structural assertions over its source,
// anchored on brace-matched function bodies. Each row states a property the trail must have
// for it to be evidence rather than decoration.

const src = readFileSync(resolve(import.meta.dirname, '../../src/main/browser-dock.ts'), 'utf8')

const bodyOf = (signature: string): string => {
  const start = src.indexOf(signature)
  expect(start, `${signature} not found`).toBeGreaterThan(-1)
  // The BODY's opening brace, which is the first one followed by a newline. A plain
  // `indexOf('{')` latches onto braces in the signature itself — `ctx?: { pane?: string }`,
  // or gateAct's `{ gated: false } | …` return type — and then brace-matches the wrong span.
  let i = src.indexOf('{\n', start)
  let depth = 0
  const from = i
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(from, i + 1)
  }
  throw new Error(`unbalanced braces after ${signature}`)
}

describe('the trail records what happened, not what was permitted', () => {
  // `gateAct` wrote `outcome: 'ok'` and returned null — the audit record was written BEFORE
  // the verb ran. The verb could then return `badtarget`, or throw into the catch, with 'ok'
  // already on disk. The gate knows whether an act was PERMITTED; only the caller knows
  // whether it WORKED.
  it('the gate no longer claims success', () => {
    expect(bodyOf('function gateAct('), "gateAct must not write an 'ok' row").not.toMatch(/outcome: 'ok'/)
  })

  it('the caller records once the outcome is known', () => {
    const wrapper = bodyOf('export async function agentAct(')
    expect(wrapper).toContain('recordTrail(')
    expect(wrapper, 'the outcome must be derived from the result').toMatch(/outcome: result\.ok \? 'ok' : 'refused'/)
  })

  it('a failure carries its reason', () => {
    expect(bodyOf('export async function agentAct(')).toMatch(/result\.ok \? \{\} : \{ reason: result\.reason \}/)
  })

  // `ctx?.pane` was in scope at the call site and never threaded, so every act row read as if
  // the workspace itself had acted — with no way to tell which agent did it.
  it('every act row names the pane that asked', () => {
    expect(bodyOf('export async function agentAct(')).toMatch(/pane: ctx\.pane/)
    expect(bodyOf('function gateAct('), 'refusals need attribution too').toMatch(/\{ pane \}/)
  })

  it('gateAct takes the pane', () => {
    expect(src).toMatch(/function gateAct\([\s\S]{0,300}?pane\?: string/)
  })
})

describe('the origin is re-checked at the moment of injection', () => {
  // The origin was resolved once, before the verb ran, and nothing re-read it between the gate
  // and `executeJavaScript` — so a page-initiated navigation committing in that window ran the
  // script in the NEW origin's document, with its cookies, under a grant naming the old one.
  const run = (() => {
    const at = src.indexOf('const run = async (js: string)')
    expect(at, 'the injection door moved — re-anchor rather than delete').toBeGreaterThan(-1)
    return src.slice(at, src.indexOf('\n  }', at))
  })()

  it('re-reads the live URL before injecting', () => {
    expect(run).toMatch(/originOf\(wc\.getURL\(\)\)/)
  })

  it('refuses rather than running against the new page', () => {
    expect(run).toMatch(/!==\s*gated\.origin\) throw/)
  })

  it('guards the ONE door every injection goes through', () => {
    // If some verb calls executeJavaScript directly, it bypasses the check.
    // Any verb in the act path that calls executeJavaScript directly bypasses the check.
    // dockPageEval is excluded on purpose: it is a smoke-only seam (only src/main/smokes/*
    // imports it), so it carries no grant to violate.
    const act = src.slice(src.indexOf('async function runAgentAct('), src.indexOf('export function dockPageEval'))
    expect(
      [...act.matchAll(/executeJavaScript\(/g)],
      'inside the act path, executeJavaScript must be reached only via run()'
    ).toHaveLength(1)
    expect(run).toContain('wc.executeJavaScript(')
  })
})
