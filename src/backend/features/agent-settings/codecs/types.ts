export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export interface ConfigRead {
  present: boolean
  value?: JsonValue
}

export interface ConfigCodec {
  readonly kind: 'json' | 'jsonc' | 'yaml' | 'toml'
  read(text: string | null, path: readonly string[]): ConfigRead
  /** N paths, ONE document parse. Same answers as calling read() N times, by construction —
   *  see readManyFrom in ./common. */
  readMany(text: string | null, paths: readonly (readonly string[])[]): ConfigRead[]
  set(text: string | null, path: readonly string[], value: JsonValue): string
  remove(text: string, path: readonly string[]): string
  validate(text: string): void
}
