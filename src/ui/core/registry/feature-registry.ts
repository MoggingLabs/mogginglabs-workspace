/** Where a UI feature is allowed to render itself. */
export interface ShellContext {
  /** Main content host (panes, layout). */
  content: HTMLElement
  /** Right-hand slot in the titlebar (chips, indicators). */
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
