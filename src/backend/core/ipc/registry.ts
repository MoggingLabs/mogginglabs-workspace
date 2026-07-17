// Electron-free contracts for wiring backend features. Features depend on THIS,
// never on Electron directly — so the whole backend is unit-testable headless and
// can move into a standalone pty-host process later (see docs/adr/0003). The
// Electron implementation of BackendContext lives in the app layer
// (src/main/electron-context.ts), which is the only place that imports 'electron'.

// `any`, deliberately, in both defaults: these are VARIANCE ERASERS, not laziness.
// BackendContext.handle takes a bare `InvokeHandler`, and a feature's concretely
// typed handler ((payload: SavePayload) => …) is only assignable to it when the
// payload parameter erases — `unknown` there would reject every typed handler at
// its registration site (parameter contravariance), which is the same reason the
// TS stdlib types callback parameters as `any` in erased positions.
/* eslint-disable @typescript-eslint/no-explicit-any */
export type InvokeHandler<TPayload = any, TResult = any> = (
  payload: TPayload
) => TResult | Promise<TResult>

export type CommandHandler<TPayload = any> = (payload: TPayload) => void
/* eslint-enable @typescript-eslint/no-explicit-any */

/** The capabilities a feature is handed at registration time. */
export interface BackendContext {
  /** Register a request/response handler (maps to ipcMain.handle). */
  handle(channel: string, handler: InvokeHandler): void
  /** Register a fire-and-forget command handler (maps to ipcMain.on). */
  on(channel: string, handler: CommandHandler): void
  /** Emit an event to the UI (maps to webContents.send). */
  emit(channel: string, payload: unknown): void
}

/** A self-contained backend feature, composed by the bootstrap. */
export interface FeatureModule {
  readonly name: string
  register(ctx: BackendContext): void
  dispose?(): void
}
