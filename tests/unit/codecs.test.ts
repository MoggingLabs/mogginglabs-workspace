import { describe, expect, it } from 'vitest'
import { runCodecFixtureAssertions } from '@backend/features/agent-settings/codecs/fixtures'

// The codec fixture pack is already assertion-shaped (node:assert, framework-free, by
// design — the AGENTSETTINGS gate calls it inside a booted app). Here it runs headless:
// BOM/EOL/comment preservation, duplicate-key and prototype-pollution refusals, across
// all four dialects.
describe('agent-settings codecs', () => {
  it('passes the golden fixture assertions', () => {
    expect(() => runCodecFixtureAssertions()).not.toThrow()
  })
})
