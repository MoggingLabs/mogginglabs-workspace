/** Where a UI feature is allowed to render itself. */
export interface ShellContext {
  /** Main content region right of the rail (views: Home, workspace grids). */
  content: HTMLElement
  /** The left vertical rail (the workspace feature fills it). */
  rail: HTMLElement
  /** Left titlebar slot, after the brand (layout picker, chips). */
  titlebarLeft: HTMLElement
  /** Dead-center titlebar cell — the command box lives here (Phase-5/04). */
  titlebarCenter: HTMLElement
  /** Right titlebar slot (chips, indicators, launchers). */
  titlebarRight: HTMLElement
}

/** A self-contained UI feature. */
export interface UiFeature {
  readonly name: string
  mount(ctx: ShellContext): void
}

const features: UiFeature[] = []

export function registerFeature(feature: UiFeature): void {
  features.push(feature)
}

export function mountFeatures(ctx: ShellContext): void {
  for (const feature of features) feature.mount(ctx)
}
