/**
 * The repo's WCAG contrast probe (Phase-8.5/06 — extracted from 8.5/04's
 * setshell-smoke, where it was born inline). It runs IN THE RENDERER via
 * executeJavaScript: sRGB linearization, relative luminance, and REAL alpha
 * compositing up the ancestor chain (an rgba() fill measured against
 * `transparent` would score as pure black — the nav's active fill is
 * `--accent-weak`, an rgba()).
 *
 * It also OWNS the transition freeze, which is the whole reason it is a shared
 * module and not a copy-paste. A transition mid-flight hands `getComputedStyle`
 * an INTERMEDIATE colour: `setTheme` swaps `--accent-ink` / `--accent-weak` and
 * `.settings-nav-item` animates both, so under sweep load the probe once read
 * 1.72:1 where the settled value is 4.71:1 — same DOM, a frame of the fade.
 * `probeContrastAcrossThemes` freezes every transition/animation, measures every
 * theme, then thaws: a caller cannot forget what it never had to remember.
 * SETSHELL and HOMEUX import it today; 07/07b/08/08b/09 reuse it.
 */

export const AA_TEXT = 4.5

/**
 * The probe body, injected into an IIFE in the renderer. Defines
 * `measure(sel) -> ratio|null`, `freeze()`, and `thaw()`. Kept as a string (not a
 * bundled module) because it must run in the renderer's document, and the smokes
 * drive the renderer over `executeJavaScript`, not an import graph.
 */
export const AA_PROBE_JS = `
  /**
   * Colour strings, into 0-255 channels (+ optional alpha).
   *
   * Chromium serializes a resolved color-mix() as \`color(srgb 0.96 0.71 0.31 / 0.5)\` — the
   * components are 0..1 FLOATS, not 0..255. The naive number-scrape read those as ~black,
   * which silently mis-measures every mixed colour: an ink reads as near-black, and a
   * translucent color-mix BACKGROUND poisons the whole composite (bgOf walks ancestors).
   * The stylesheet uses color-mix in dozens of places, so this is scaled explicitly.
   * Found by TREEGIT (11/05), whose selected-row inks are mixed toward --text-hi.
   */
  const parse = (c) => {
    const m = /^color\\(\\s*srgb\\s+([^)]+)\\)/.exec(c)
    if (m) {
      const [head, tail] = m[1].split('/')
      const rgb = (head.match(/[\\d.]+/g) || []).map(Number).map((v) => v * 255)
      const a = tail ? Number((tail.match(/[\\d.]+/g) || ['1'])[0]) : undefined
      return a === undefined ? rgb : [rgb[0], rgb[1], rgb[2], a]
    }
    return (c.match(/[\\d.]+/g) || []).map(Number)
  }
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  const over = (fg, bg) => { const a = fg[3] === undefined ? 1 : fg[3]; return [0,1,2].map((i) => fg[i] * a + bg[i] * (1 - a)) }
  /** Real background: walk up compositing every translucent layer onto the one below. */
  const bgOf = (node) => {
    const stack = []
    for (let n = node; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor)
      if (c.length && (c[3] === undefined || c[3] > 0)) stack.push(c)
      if (c.length && (c[3] === undefined || c[3] === 1)) break
    }
    if (!stack.length) return [0, 0, 0]
    let base = stack[stack.length - 1].slice(0, 3)
    for (let i = stack.length - 2; i >= 0; i--) base = over(stack[i], base)
    return base
  }
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
  const measure = (sel) => {
    const node = document.querySelector(sel)
    if (!node) return null
    const bg = bgOf(node)
    const fg = parse(getComputedStyle(node).color)
    return Math.round(ratio(over(fg, bg), bg) * 100) / 100
  }
  const freeze = () => {
    if (document.getElementById('aa-freeze')) return
    const st = document.createElement('style')
    st.id = 'aa-freeze'
    st.textContent = '*, *::before, *::after { transition: none !important; animation: none !important }'
    document.head.append(st)
  }
  const thaw = () => document.getElementById('aa-freeze')?.remove()
`

export interface AaProbeResult {
  /** { theme: { selector: ratio | null } }. */
  contrast: Record<string, Record<string, number | null>>
  /** "theme selector = ratio" for every measured pair below AA_TEXT. */
  failures: string[]
  /** Selectors that were null in EVERY theme — a rotted hook the check would else pass on nothing. */
  missing: string[]
  /** The lowest measured ratio across all themes (diagnostic), or null if nothing measured. */
  worst: number | null
}

/**
 * Freeze transitions, measure every selector against AA in every theme, thaw, then
 * restore the original theme. The freeze/thaw is OWNED here — the caller only names
 * selectors. Requires `window.__mogging.setTheme` (present in DEV/smoke builds).
 */
export async function probeContrastAcrossThemes(opts: {
  es: <T = unknown>(js: string) => Promise<T>
  sleep: (ms: number) => Promise<void>
  selectors: string[]
  themes?: string[]
  restore?: string
  settleMs?: number
}): Promise<AaProbeResult> {
  const { es, sleep, selectors } = opts
  const themes = opts.themes ?? ['midnight', 'light', 'nord', 'solarized']
  const restore = opts.restore ?? 'midnight'
  const settleMs = opts.settleMs ?? 300

  await es(`(() => {${AA_PROBE_JS} freeze() })()`) // measure the settled colour, never a fade frame
  const contrast: Record<string, Record<string, number | null>> = {}
  const failures: string[] = []
  for (const t of themes) {
    await es(`window.__mogging.setTheme(${JSON.stringify(t)})`)
    await sleep(settleMs)
    contrast[t] = await es<Record<string, number | null>>(`(() => {${AA_PROBE_JS}
      const out = {}
      for (const sel of ${JSON.stringify(selectors)}) out[sel] = measure(sel)
      return out
    })()`)
    for (const [sel, r] of Object.entries(contrast[t])) {
      if (r != null && r < AA_TEXT) failures.push(`${t} ${sel} = ${r}`)
    }
  }
  const missing = selectors.filter((sel) => themes.every((t) => contrast[t][sel] == null))
  await es(`window.__mogging.setTheme(${JSON.stringify(restore)})`)
  await es(`(() => {${AA_PROBE_JS} thaw() })()`)

  const all = Object.values(contrast).flatMap((m) => Object.values(m).filter((v): v is number => v != null))
  return { contrast, failures, missing, worst: all.length ? Math.min(...all) : null }
}
