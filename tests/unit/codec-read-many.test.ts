import { describe, expect, it } from 'vitest'
import { readManyFrom } from '@backend/features/agent-settings/codecs/common'
import { codecFor, jsoncCodec, strictJsonCodec, tomlCodec, yamlCodec } from '@backend/features/agent-settings/codecs'
import type { ConfigCodec, JsonValue } from '@backend/features/agent-settings/codecs'

// N PATHS, ONE DOCUMENT PARSE.
//
// Every codec's `read` is `readJsonPath(parse(text), path)`, so asking for N settings
// re-parsed the whole file N times. `promotableDefaults` did exactly that, nested two loops
// deep: for the claude catalog that is 422 surviving settings per home per surface, each a
// full parse of the document, on every `changed` event. The cost was charged per SETTING when
// the unit of work is a DOCUMENT.
//
// The risk in fixing it is a second implementation that answers differently from `read`. It is
// derived once (readManyFrom) rather than written four times, and the first block below pins
// the equivalence for every dialect regardless.

const DOCS: Array<{ codec: ConfigCodec; name: string; text: string }> = [
  {
    codec: jsoncCodec,
    name: 'jsonc',
    text: '{\n  // a comment\n  "a": 1,\n  "nested": { "b": [1, 2], "c": null },\n  "s": "x"\n}\n'
  },
  { codec: strictJsonCodec, name: 'json', text: '{"a":1,"nested":{"b":[1,2],"c":null},"s":"x"}' },
  { codec: yamlCodec, name: 'yaml', text: 'a: 1\nnested:\n  b:\n    - 1\n    - 2\n  c: null\ns: x\n' },
  { codec: tomlCodec, name: 'toml', text: 'a = 1\ns = "x"\n\n[nested]\nb = [1, 2]\n' }
]

const PATHS: ReadonlyArray<readonly string[]> = [
  ['a'],
  ['nested', 'b'],
  ['nested', 'c'],
  ['s'],
  ['missing'],
  ['nested', 'missing'],
  ['a'] // repeated on purpose: N paths need not be distinct
]

describe('readMany agrees with read, for every dialect', () => {
  for (const { codec, name, text } of DOCS) {
    it(`${name}: readMany(text, paths) === paths.map(read)`, () => {
      expect(codec.readMany(text, PATHS)).toEqual(PATHS.map((path) => codec.read(text, path)))
    })

    it(`${name}: a null document is absent for every path`, () => {
      expect(codec.readMany(null, PATHS)).toEqual(PATHS.map(() => ({ present: false })))
    })

    it(`${name}: no paths yields no reads`, () => {
      expect(codec.readMany(text, [])).toEqual([])
    })

    it(`${name}: a malformed document throws, exactly as read does`, () => {
      // The caller catches at the DOCUMENT level — "a malformed home cannot vote". Silently
      // returning absent here would make an unparseable file look like an empty one, which is
      // the permissive-branch bug this whole programme is about.
      const broken = name === 'toml' ? '= = =\n' : '{{{not valid'
      expect(() => codec.readMany(broken, PATHS)).toThrow()
      expect(() => codec.read(broken, PATHS[0])).toThrow()
    })
  }

  it('every registered codec implements it', () => {
    for (const kind of ['json', 'jsonc', 'yaml', 'toml'] as const) {
      expect(typeof codecFor(kind).readMany, kind).toBe('function')
    }
  })
})

describe('readManyFrom parses ONCE', () => {
  // The whole point. Asserted directly on the derivation, because a per-codec test cannot see
  // how many times a module-private parse ran.
  const doc = '{"a":1,"b":2,"c":3}'
  const counting = (): { parse: (text: string) => JsonValue; count: () => number } => {
    let n = 0
    return {
      parse: (text: string) => {
        n++
        return JSON.parse(text) as JsonValue
      },
      count: () => n
    }
  }

  it('parses once for many paths', () => {
    const { parse, count } = counting()
    const out = readManyFrom(parse, doc, [['a'], ['b'], ['c'], ['a'], ['nope']])
    expect(count()).toBe(1)
    expect(out.map((r) => r.value)).toEqual([1, 2, 3, 1, undefined])
  })

  it('does not parse at all when there is nothing to read', () => {
    const { parse, count } = counting()
    expect(readManyFrom(parse, doc, [])).toEqual([])
    expect(count()).toBe(0)
  })

  it('does not parse a null document', () => {
    const { parse, count } = counting()
    expect(readManyFrom(parse, null, [['a']])).toEqual([{ present: false }])
    expect(count()).toBe(0)
  })

  it('rejects an unsafe path before parsing anything', () => {
    const { parse, count } = counting()
    expect(() => readManyFrom(parse, doc, [['a'], ['__proto__']])).toThrow()
    expect(count(), 'path validation must precede the parse').toBe(0)
  })
})
