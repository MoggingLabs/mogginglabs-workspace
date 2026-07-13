import assert from 'node:assert/strict'
import { jsoncCodec } from './jsonc'
import { strictJsonCodec } from './strict-json'
import { tomlCodec } from './toml'
import { yamlCodec } from './yaml'

/** Focused golden assertions; callable from a smoke entrypoint without a test framework. */
export function runCodecFixtureAssertions(): void {
  const jsonc = '\uFEFF{\r\n  // foreign comment\r\n  "keep": true,\r\n  "nested": { "value": 1, },\r\n}\r\n'
  const jsoncSet = jsoncCodec.set(jsonc, ['nested', 'value'], 2)
  assert.equal(jsoncSet.replace('2', '1'), jsonc)
  assert.equal(jsoncCodec.read(jsoncSet, ['nested', 'value']).value, 2)
  const jsoncAdded = jsoncCodec.set(jsoncSet, ['nested', 'added'], ['x'])
  assert.match(jsoncAdded, /\/\/ foreign comment/)
  assert.match(jsoncAdded, /\r\n/)
  assert.equal(jsoncAdded.startsWith('\uFEFF'), true)
  assert.equal(jsoncCodec.remove(jsoncAdded, ['nested', 'added']).includes('"added"'), false)
  assert.throws(() => jsoncCodec.validate('{"a": 1, "a": 2}'), /duplicate key/)
  assert.throws(() => jsoncCodec.set(null, ['__proto__'], true), /unsafe prototype/)
  assert.throws(() => jsoncCodec.set(null, ['x'], Number.NaN), /non-finite/)
  const strictJson = '{\n  "foreign": true,\n  "nested": { "value": 1 }\n}\n'
  const strictSet = strictJsonCodec.set(strictJson, ['nested', 'value'], 2)
  assert.equal(strictJsonCodec.read(strictSet, ['nested', 'value']).value, 2)
  assert.match(strictSet, /"foreign": true/)
  assert.throws(() => strictJsonCodec.validate('{ // comment\n"x": 1\n}'), /Comments and trailing commas/)
  assert.throws(() => strictJsonCodec.validate('{"x": 1,}'), /Comments and trailing commas/)

  const yaml = '\uFEFF# foreign comment\r\nkeep: yes-as-a-string\r\nnested:\r\n  value: 1\r\n'
  const yamlSet = yamlCodec.set(yaml, ['nested', 'value'], 2)
  assert.equal(yamlSet.startsWith('\uFEFF# foreign comment\r\n'), true)
  assert.equal(yamlCodec.read(yamlSet, ['nested', 'value']).value, 2)
  assert.equal(yamlCodec.read(yamlSet, ['keep']).value, 'yes-as-a-string')
  const yamlAdded = yamlCodec.set(yamlSet, ['nested', 'added'], { ok: true })
  assert.equal(yamlCodec.remove(yamlAdded, ['nested', 'added']).includes('added:'), false)
  const yamlAlias = 'base: &base\n  x: 1\ncopy: *base\nforeign: true\n'
  assert.equal(yamlCodec.set(yamlAlias, ['foreign'], false), yamlAlias.replace('true', 'false'))
  assert.throws(() => yamlCodec.set(yamlAlias, ['copy', 'x'], 2), /alias/)
  yamlCodec.validate('value: .nan\n')
  assert.throws(() => yamlCodec.validate('1: value\n'), /non-string mapping key/)
  assert.throws(() => yamlCodec.validate('a: 1\na: 2\n'), /unique|duplicate/i)

  const toml = '\uFEFF# foreign heading\r\ntop = "untouched"\r\n\r\n[model]\r\nname = "old" # keep inline\r\nother = 1\r\n\r\n[foreign]\r\nvalue = true\r\n'
  const tomlSet = tomlCodec.set(toml, ['model', 'name'], 'new')
  assert.equal(tomlSet, toml.replace('"old"', '"new"'))
  assert.equal(tomlCodec.read(tomlSet, ['model', 'name']).value, 'new')
  const tomlAdded = tomlCodec.set(tomlSet, ['model', 'options', 'level'], 3)
  assert.match(tomlAdded, /other = 1\r\noptions\.level = 3\r\n\r\n\[foreign\]/)
  assert.match(tomlAdded, /# foreign heading/)
  const tomlTop = tomlCodec.set(tomlAdded, ['new top'], true)
  assert.match(tomlTop, /"new top" = true\r\n\[model\]/)
  const tomlRemoved = tomlCodec.remove(tomlTop, ['model', 'other'])
  assert.equal(tomlRemoved.includes('other = 1'), false)
  assert.match(tomlRemoved, /name = "new" # keep inline/)
  assert.match(tomlRemoved, /\[foreign\]\r\nvalue = true/)

  const inline = 'cfg = { first = 1, second = { keep = true } } # tail\n'
  const inlineAdded = tomlCodec.set(inline, ['cfg', 'second', 'added'], ['x', 2])
  assert.equal(inlineAdded, 'cfg = { first = 1, second = { keep = true, added = ["x", 2] } } # tail\n')
  const inlineRemoved = tomlCodec.remove(inlineAdded, ['cfg', 'second', 'keep'])
  assert.equal(inlineRemoved, 'cfg = { first = 1, second = { added = ["x", 2] } } # tail\n')
  const emptyInline = tomlCodec.set('cfg = {}\n', ['cfg', 'x', 'y'], { ok: true })
  assert.equal(emptyInline, 'cfg = { x.y = { ok = true } }\n')
  const emptyTable = tomlCodec.set('[empty] # table note\n# next note\n[next]\nx = 1\n', ['empty', 'x'], 1)
  assert.equal(emptyTable, '[empty] # table note\nx = 1\n# next note\n[next]\nx = 1\n')
  const inlineFirstRemoved = tomlCodec.remove('cfg = { first = 1, second = 2 }\n', ['cfg', 'first'])
  assert.equal(inlineFirstRemoved, 'cfg = { second = 2 }\n')
  const arrayTables = '[[items]]\nname = "one"\n[[items]]\nname = "two"\n'
  assert.equal(JSON.stringify(tomlCodec.read(arrayTables, ['items']).value), JSON.stringify([
    { name: 'one' },
    { name: 'two' }
  ]))
  assert.throws(() => tomlCodec.set(arrayTables, ['items', 'name'], 'bad'), /non-table/)

  assert.throws(() => tomlCodec.set(null, ['x'], null), /cannot represent JSON null/)
  const foreignToml = 'when = 1979-05-27T07:32:00Z\nlarge = 9223372036854775807\nvalue = nan\neditable = true\n'
  assert.equal(tomlCodec.set(foreignToml, ['editable'], false), foreignToml.replace('editable = true', 'editable = false'))
  tomlCodec.validate(foreignToml)
  assert.throws(() => tomlCodec.validate('"__proto__" = 1\n'), /unsafe prototype/)
  assert.throws(() => tomlCodec.validate('[broken\n'), /Invalid TOML/)
}
