import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveLibraries } from '../../src/backend/features/brain/libraries'

// Version truth (ADR 0018 step 08): the lockfile parsers, pinned by fixture.
// Each format's fixture is minimal but real-shaped; determinism and honesty
// (ranges AS ranges, pinned:false) are the claims under test.

const roots: string[] = []
const makeRoot = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'mog-libtest-'))
  roots.push(root)
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const byName = (deps: ReturnType<typeof resolveLibraries>, name: string) => deps.find((d) => d.name === name)

describe('resolveLibraries', () => {
  it('package-lock v3: top-level pins, direct from the manifest, nested copies skipped', () => {
    const root = makeRoot({
      'package.json': JSON.stringify({ dependencies: { 'acme-lib': '^1.0.0' }, devDependencies: { '@scope/tool': '~2.0.0' } }),
      'package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'fixture' },
          'node_modules/acme-lib': { version: '1.2.3' },
          'node_modules/@scope/tool': { version: '2.0.1' },
          'node_modules/transitive-x': { version: '0.9.0' },
          'node_modules/acme-lib/node_modules/nested-copy': { version: '5.0.0' }
        }
      })
    })
    const deps = resolveLibraries(root)
    expect(byName(deps, 'acme-lib')).toMatchObject({ ecosystem: 'npm', version: '1.2.3', pinned: true, direct: true, installed: false })
    expect(byName(deps, '@scope/tool')).toMatchObject({ version: '2.0.1', pinned: true, direct: true })
    expect(byName(deps, 'transitive-x')).toMatchObject({ pinned: true, direct: false })
    expect(byName(deps, 'nested-copy')).toBeUndefined()
    // Direct rows sort ahead of transitives.
    expect(deps.findIndex((d) => d.name === 'acme-lib')).toBeLessThan(deps.findIndex((d) => d.name === 'transitive-x'))
  })

  it('package-lock v1: the dependencies map still pins', () => {
    const root = makeRoot({
      'package.json': JSON.stringify({ dependencies: { old: '^1.0.0' } }),
      'package-lock.json': JSON.stringify({ lockfileVersion: 1, dependencies: { old: { version: '1.4.0' } } })
    })
    expect(byName(resolveLibraries(root), 'old')).toMatchObject({ version: '1.4.0', pinned: true, direct: true })
  })

  it('manifest-only: the range is reported AS the range, pinned:false', () => {
    const root = makeRoot({ 'package.json': JSON.stringify({ dependencies: { loose: '^3.1.0' } }) })
    expect(byName(resolveLibraries(root), 'loose')).toMatchObject({ version: '^3.1.0', pinned: false, direct: true, installed: false })
  })

  it('pnpm-lock v6: importer deps are direct; packages fill in transitives', () => {
    const root = makeRoot({
      'pnpm-lock.yaml': [
        "lockfileVersion: '6.0'",
        'importers:',
        '  .:',
        '    dependencies:',
        '      acme-lib:',
        "        specifier: ^1.0.0",
        "        version: 1.2.3(peer@2.0.0)",
        'packages:',
        '  /transitive-y@4.5.6:',
        '    resolution: { integrity: sha512-x }',
        '  /@scope/deep@0.1.2(peer@1.0.0):',
        '    resolution: { integrity: sha512-y }'
      ].join('\n')
    })
    const deps = resolveLibraries(root)
    expect(byName(deps, 'acme-lib')).toMatchObject({ version: '1.2.3', pinned: true, direct: true })
    expect(byName(deps, 'transitive-y')).toMatchObject({ version: '4.5.6', direct: false })
    expect(byName(deps, '@scope/deep')).toMatchObject({ version: '0.1.2', direct: false })
  })

  it('yarn.lock classic AND berry both resolve', () => {
    const classic = makeRoot({
      'package.json': JSON.stringify({ dependencies: { 'left-pad': '^1.0.0' } }),
      'yarn.lock': ['# yarn lockfile v1', '', '"left-pad@^1.0.0", "left-pad@^1.1.0":', '  version "1.3.0"', ''].join('\n')
    })
    expect(byName(resolveLibraries(classic), 'left-pad')).toMatchObject({ version: '1.3.0', pinned: true, direct: true })
    const berry = makeRoot({
      'package.json': JSON.stringify({ dependencies: { '@scope/pkg': '^2.0.0' } }),
      'yarn.lock': ['__metadata:', '  version: 8', '', '"@scope/pkg@npm:^2.0.0":', '  version: 2.3.4', ''].join('\n')
    })
    expect(byName(resolveLibraries(berry), '@scope/pkg')).toMatchObject({ version: '2.3.4', pinned: true, direct: true })
  })

  it('requirements.txt: == pins, anything else is an honest range, extras stripped', () => {
    const root = makeRoot({
      'requirements.txt': ['# comment', 'fake-py==2.0.0', 'loosepkg>=1.0', 'bare', 'withextras[socks]==3.1.4', '-r other.txt'].join('\n')
    })
    const deps = resolveLibraries(root)
    expect(byName(deps, 'fake-py')).toMatchObject({ ecosystem: 'py', version: '2.0.0', pinned: true, direct: true })
    expect(byName(deps, 'loosepkg')).toMatchObject({ version: '>=1.0', pinned: false })
    expect(byName(deps, 'bare')).toMatchObject({ version: '', pinned: false })
    expect(byName(deps, 'withextras')).toMatchObject({ version: '3.1.4', pinned: true })
  })

  it('poetry.lock + pyproject: exact pins, direct only where the manifest says', () => {
    const root = makeRoot({
      'pyproject.toml': ['[tool.poetry.dependencies]', 'python = "^3.11"', 'requests = "^2.31"'].join('\n'),
      'poetry.lock': [
        '[[package]]', 'name = "requests"', 'version = "2.31.0"', '',
        '[[package]]', 'name = "urllib3"', 'version = "2.2.1"'
      ].join('\n')
    })
    const deps = resolveLibraries(root)
    expect(byName(deps, 'requests')).toMatchObject({ version: '2.31.0', pinned: true, direct: true })
    expect(byName(deps, 'urllib3')).toMatchObject({ pinned: true, direct: false })
  })

  it('uv.lock + PEP 621 dependencies array', () => {
    const root = makeRoot({
      'pyproject.toml': ['[project]', 'dependencies = [', '  "httpx>=0.27",', ']'].join('\n'),
      'uv.lock': ['[[package]]', 'name = "httpx"', 'version = "0.27.2"'].join('\n')
    })
    expect(byName(resolveLibraries(root), 'httpx')).toMatchObject({ version: '0.27.2', pinned: true, direct: true })
  })

  it('go.mod: require blocks, // indirect marks transitives', () => {
    const root = makeRoot({
      'go.mod': [
        'module example.com/fixture', '', 'go 1.22', '',
        'require (', '\tgithub.com/direct/dep v1.5.0', '\tgolang.org/x/deep v0.20.0 // indirect', ')',
        'require github.com/single/line v2.0.0'
      ].join('\n')
    })
    const deps = resolveLibraries(root)
    expect(byName(deps, 'github.com/direct/dep')).toMatchObject({ ecosystem: 'go', version: 'v1.5.0', pinned: true, direct: true })
    expect(byName(deps, 'golang.org/x/deep')).toMatchObject({ direct: false })
    expect(byName(deps, 'github.com/single/line')).toMatchObject({ version: 'v2.0.0', direct: true })
  })

  it('Cargo.lock + Cargo.toml: pins with direct from the manifest sections', () => {
    const root = makeRoot({
      'Cargo.toml': ['[package]', 'name = "fixture"', '', '[dependencies]', 'serde = { version = "1" }'].join('\n'),
      'Cargo.lock': [
        '[[package]]', 'name = "serde"', 'version = "1.0.200"', '',
        '[[package]]', 'name = "itoa"', 'version = "1.0.11"'
      ].join('\n')
    })
    const deps = resolveLibraries(root)
    expect(byName(deps, 'serde')).toMatchObject({ ecosystem: 'cargo', version: '1.0.200', pinned: true, direct: true })
    expect(byName(deps, 'itoa')).toMatchObject({ direct: false })
  })

  it('installed truth: node_modules and dist-info stamp the disk, pin-match required', () => {
    const root = makeRoot({
      'package.json': JSON.stringify({ dependencies: { 'acme-lib': '^1.0.0', 'ghost-lib': '^9.0.0' } }),
      'package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        packages: {
          'node_modules/acme-lib': { version: '1.2.3' },
          'node_modules/ghost-lib': { version: '9.9.9' }
        }
      }),
      'node_modules/acme-lib/package.json': JSON.stringify({ name: 'acme-lib', version: '1.2.3' }),
      'requirements.txt': 'fake-py==2.0.0\n',
      '.venv/Lib/site-packages/fake_py-2.0.0.dist-info/METADATA': 'Name: fake-py\n'
    })
    const deps = resolveLibraries(root)
    expect(byName(deps, 'acme-lib')).toMatchObject({ installed: true, installedVersion: '1.2.3' })
    expect(byName(deps, 'ghost-lib')).toMatchObject({ installed: false, installedVersion: '' })
    expect(byName(deps, 'fake-py')).toMatchObject({ installed: true, installedVersion: '2.0.0' })
  })

  it('hostile names never become paths: listed as keys, never installed', () => {
    const root = makeRoot({
      'package.json': JSON.stringify({ dependencies: { '../../evil': '^1.0.0' } })
    })
    const evil = byName(resolveLibraries(root), '../../evil')
    expect(evil).toMatchObject({ pinned: false, installed: false, installedVersion: '' })
  })

  it('is deterministic: same bytes, same rows, same order', () => {
    const files = {
      'package.json': JSON.stringify({ dependencies: { b: '^1.0.0', a: '^1.0.0' } }),
      'requirements.txt': 'z==1.0.0\ny==2.0.0\n'
    }
    const one = resolveLibraries(makeRoot(files))
    const two = resolveLibraries(makeRoot(files))
    expect(JSON.stringify(one)).toBe(JSON.stringify(two))
  })
})
