/**
 * Calm motion (Settings § Appearance): the in-app twin of the OS "reduce motion"
 * preference. When on, `:root` carries `.motion-calm` and global.css swaps the moving
 * accents — the pane attention pulse, the rail's infinite indicator pulses, the reset
 * confetti — for the same gentle fades the `prefers-reduced-motion` media query applies
 * (MOTION-01: never kill a state signal dead, becalm it). A ui-core port so settings
 * (the knob) and the shell (boot application) stay decoupled.
 *
 * localStorage, not the settings DB: purely a renderer paint preference, same tier as
 * the rail's collapsed state (`mogging.railCollapsed` in app-shell.ts).
 */
const KEY = 'mogging.calmMotion'
const CLASS = 'motion-calm'

export function calmMotion(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

/**
 * The scroll behavior to use, honouring calm motion.
 *
 * `.motion-calm`'s whole reach is CSS — animation-duration / iteration-count /
 * transition-duration clamps (global.css) — and a scroll driven by the `behavior: 'smooth'`
 * OPTION is neither an animation nor a transition, so no class can reach it. The in-app
 * switch is documented as the twin of the OS reduce-motion preference; for smooth scrolling
 * it had no twin at all. Every scrollIntoView/scrollTo in the renderer goes through this,
 * and check-reduced-motion.mjs (the MOTION gate) fails any that does not.
 */
export function scrollBehavior(): ScrollBehavior {
  if (calmMotion()) return 'auto'
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
  } catch {
    return 'smooth'
  }
}

export function setCalmMotion(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '')
  } catch {
    /* storage unavailable — applies for this session only */
  }
  applyCalmMotion()
}

/** Stamp (or clear) the root class from the persisted value — called once at shell boot,
 *  and by setCalmMotion so the toggle applies live. */
export function applyCalmMotion(): void {
  document.documentElement.classList.toggle(CLASS, calmMotion())
}
