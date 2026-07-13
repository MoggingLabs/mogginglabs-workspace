import { jsoncCodec } from './jsonc'
import { strictJsonCodec } from './strict-json'
import { tomlCodec } from './toml'
import type { ConfigCodec } from './types'
import { yamlCodec } from './yaml'

export { jsoncCodec, strictJsonCodec, tomlCodec, yamlCodec }
export { runCodecFixtureAssertions } from './fixtures'
export type { ConfigCodec, ConfigRead, JsonValue } from './types'

const CODECS: Readonly<Record<ConfigCodec['kind'], ConfigCodec>> = {
  json: strictJsonCodec,
  jsonc: jsoncCodec,
  toml: tomlCodec,
  yaml: yamlCodec
}

export function codecFor(format: ConfigCodec['kind']): ConfigCodec {
  return CODECS[format]
}
