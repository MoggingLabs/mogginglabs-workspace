import { describe, expect, it } from 'vitest'
import { AllChannels } from '@contracts'
import { bodyOf, sourceOf } from './source-body'

// THE ONLY THING BETWEEN THE RENDERER AND ARBITRARY IPC.
//
// The preload exposes one generic bridge, deliberately: adding a feature's channels to
// `AllChannels` auto-permits them, so no per-feature preload edit is needed. What keeps that
// from being "the renderer can call anything" is a single `assertAllowed(channel)` at the top
// of each method.
//
// Delete one of those three calls and every one of the 212 gates still passes. That is the gap
// this file exists to close. src/preload/index.ts imports electron, so it is asserted over
// source — with anchors that throw when they stop matching.

const src = sourceOf('src/preload/index.ts')

describe('every bridge method checks the channel', () => {
  for (const method of ['invoke', 'send', 'on']) {
    it(`${method} calls assertAllowed before touching ipcRenderer`, () => {
      const body = bodyOf(src, `${method}: (channel: string`)
      expect(body, `${method} would reach arbitrary IPC`).toContain('assertAllowed(channel)')
      expect(
        body.indexOf('assertAllowed(channel)'),
        'the check must precede the call it guards'
      ).toBeLessThan(body.indexOf('ipcRenderer.'))
    })
  }
})

describe('the allowlist is the contract, and nothing else', () => {
  it('is built from AllChannels', () => {
    expect(src).toMatch(/const allow = new Set<string>\(AllChannels\)/)
  })

  it('refuses with a nameable error rather than returning undefined', () => {
    const body = bodyOf(src, 'function assertAllowed(channel: string): void')
    expect(body).toMatch(/throw new Error/)
    expect(body).toContain('ipc channel not allowed')
  })

  it('AllChannels is non-empty, so the allowlist is not vacuously permissive', () => {
    // A Set built from an empty list would refuse everything rather than permit everything,
    // but an empty contract still means this gate is watching nothing.
    expect(AllChannels.length).toBeGreaterThan(20)
  })
})

describe('the exposed surface is exactly what is intended', () => {
  // A generic bridge is safe only while its members are enumerable and few. `getPathForFile`
  // is the one deliberate non-channel member: Electron removed `File.path` in v32, so a
  // dropped file exposes nothing but a name and its bytes, and this reads a path the user just
  // handed over by dropping it. It opens no new authority — but a SECOND such member should
  // have to answer for itself.
  it('exposes four members and no more', () => {
    const world = bodyOf(src, "contextBridge.exposeInMainWorld('bridge',")
    const members = [...world.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1])
    expect(members.sort()).toEqual(['getPathForFile', 'invoke', 'on', 'send'])
  })

  it('exposes it on `bridge`, the name the client layer expects', () => {
    expect(src).toContain("exposeInMainWorld('bridge'")
  })

  it('hands back an unsubscriber from `on`', () => {
    // Panes are created and disposed all session long; without this every disposed pane's
    // listeners lived — and ran — forever.
    const body = bodyOf(src, 'on: (channel: string')
    expect(body).toMatch(/return \(\) => ipcRenderer\.removeListener\(channel, listener\)/)
  })
})
