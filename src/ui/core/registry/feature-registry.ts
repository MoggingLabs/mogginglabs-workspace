/** Where a UI feature is allowed to render itself. */
export interface ShellContext {
  /** Main content region right of the rail (views: Home, workspace grids). */
  content: HTMLElement
  /** The left vertical rail (the workspace feature fills it). */
  rail: HTMLElement
  /** Leading feature slot in the RIGHT cluster — NOT after the brand (the brand cell is
   *  logo/name/version only). Features mount triggers here (the layout picker is today's
   *  tenant). It sits ahead of titlebarRight and the fixed view/rail/settings controls;
   *  titlebar.ts declares that left→right order. */
  titlebarLeft: HTMLElement
  /** Dead-center titlebar cell — the command box lives here (Phase-5/04). */
  titlebarCenter: HTMLElement
  /** Trailing feature slot in the RIGHT cluster (indicators, launchers) — mounts after
   *  titlebarLeft, before the fixed controls. */
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
