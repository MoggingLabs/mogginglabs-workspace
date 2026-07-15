import type { ITheme } from '@xterm/xterm'
import { ShellChannels } from '@contracts'
import { getBridge } from '../ipc/bridge'
import { setTerminalTheme } from './theme-port'

/**
 * A theme = overrides for the NEUTRAL design tokens (surfaces, borders, text) + a
 * matching xterm terminal theme derived from the same values, so panes always match
 * chrome. The brand-orange accent, semantic colors, and the type/space/motion scale
 * stay constant across themes (defined once in global.css :root) — the app reads as
 * *us* on every palette. "System" resolves to Light/Midnight from the OS scheme and
 * live-updates when it flips.
 */
export interface AppTheme {
  id: string
  name: string
  mode: 'dark' | 'light' | 'system'
  chrome: Record<string, string>
  terminal: ITheme
}

/** Derive an xterm theme from a chrome's surface/text tokens (+ brand selection). */
function terminalFrom(chrome: Record<string, string>, cursor: string): ITheme {
  return {
    background: chrome['--bg-app'],
    foreground: chrome['--text-hi'],
    cursor,
    cursorAccent: chrome['--bg-app'],
    selectionBackground: 'rgba(253, 141, 3, 0.28)' // brand selection everywhere
  }
}

/**
 * `--ws-ink-mix` — how much of a workspace's identity accent survives into its ink.
 *
 * The rail paints identity ink ON an identity tint: same hue above and below, so the only
 * contrast is lightness, and the tint drags the background TOWARD the ink. How far it drags
 * depends on the theme's own surface — which is why "dark" is not one answer. Midnight's
 * rail sits on #15171c and a vivid accent clears AA on it outright; Nord's sits on #353c4a,
 * where violet measured 2.9:1 (and 4.0:1 even on the BARE surface). A theme with a light
 * "dark" surface has to pull its ink away from the accent to stay legible.
 *
 * So each theme states how much accent its own surfaces can carry, and `--ws-ink` mixes the
 * rest of the way toward that theme's `--text-hi` — up on dark, down on light. This is the
 * ramp's existing light-mode trick ("vividness lives in accent/tint/glow, readability in
 * ink/edge"), generalized from one mode to every theme. Solved, not guessed: these are the
 * LARGEST values (= most vivid ink) that hold 4.5:1 on every surface the rail paints ink on,
 * for all 12 identity colors. The accent itself never moves — bars, borders, tints and glows
 * stay as vivid as they ever were.
 */
const MIDNIGHT_CHROME: Record<string, string> = {
  '--bg-app': '#0c0d0f',
  '--bg-surface': '#15171c',
  '--bg-elevated': '#1f2228',
  '--bg-inset': '#060709',
  '--border': '#2a2d34',
  '--border-strong': '#3b3f48',
  '--text-hi': '#f4f5f7',
  '--text-mid': '#a9aeb6',
  '--text-lo': '#868d97',
  '--ws-ink-mix': '100%' // the accent IS the ink — midnight's surfaces carry it whole
}

const LIGHT_CHROME: Record<string, string> = {
  '--bg-app': '#f2f4f7',
  '--bg-surface': '#fbfcfe',
  '--bg-elevated': '#ffffff',
  '--bg-inset': '#e7eaef',
  '--border': '#d9dde4',
  '--border-strong': '#b7bec9',
  '--text-hi': '#15171b',
  '--text-mid': '#4b515b',
  '--text-lo': '#60656e',
  // On light surfaces orange must darken past brand-700 to hold AA as text/icon ink
  // (#9c5300 = 5.8:1 on white, 4.8:1 on inset). Text ON accent fills stays the
  // :root #201200 (7.8:1) — the old warm near-white was 2.3:1.
  '--accent-ink': '#9c5300',
  // Semantic inks darken on light to hold AA as text (all ≥4.5:1 on white; the
  // dark-theme values measure 1.9–3.4:1 there). Fills (gutters, dots) still pass 3:1.
  '--success': '#147a3c',
  '--danger': '#c92e25',
  // Danger-as-text ink (8.5/01; darkened past the fill in 8.5/09). On light the
  // fill red (#c92e25) reads as ink on plain surfaces (5.24:1) but only 4.46:1 on
  // an inset — and .cc-chip.is-failing renders danger-ink on the tinted
  // --danger-weak fill, which 8.5/09's milestone (e) measured at 4.45:1. Ink now
  // darkens past the fill (like the dark themes' fa9b92 != fill split) so
  // danger-as-words clears AA on both plain and tinted grounds: ~4.87:1 on the chip.
  '--danger-ink': '#c02820',
  '--warning': '#8a5c09',
  '--info': '#1d63d8',
  // The semantic fills above DARKENED for light, so text on them must lighten: white reads
  // 5.4:1 on both, where the dark theme's #201200 measured 3.4:1. The rail's alert counts are
  // the only text-on-semantic-fill in the app, and they were unreadable here.
  '--semantic-contrast': '#ffffff',
  // Identity ink darkens toward --text-hi on light (was a flat 54% toward pure black, which
  // missed the icon CHIP: --bg-inset #e7eaef is darker than the white the ramp was measured
  // on, and lime's ink read 4.25:1 there).
  '--ws-ink-mix': '46%',
  '--shadow-1': '0 1px 2px rgba(21, 23, 27, 0.08)',
  '--shadow-2': '0 8px 24px rgba(21, 23, 27, 0.12)',
  '--shadow-3': '0 24px 64px rgba(21, 23, 27, 0.18)'
}

export const THEMES: AppTheme[] = [
  {
    id: 'system',
    name: 'System',
    mode: 'system',
    chrome: {}, // resolved to Light/Midnight at apply time
    terminal: terminalFrom(MIDNIGHT_CHROME, '#fd8d03')
  },
  {
    id: 'midnight',
    name: 'Midnight',
    mode: 'dark',
    chrome: MIDNIGHT_CHROME,
    terminal: terminalFrom(MIDNIGHT_CHROME, '#fd8d03')
  },
  {
    id: 'light',
    name: 'Light',
    mode: 'light',
    chrome: LIGHT_CHROME,
    terminal: terminalFrom(LIGHT_CHROME, '#e07a00')
  },
  {
    id: 'nord',
    name: 'Nord',
    mode: 'dark',
    chrome: {
      '--bg-app': '#2e3440',
      '--bg-surface': '#353c4a',
      '--bg-elevated': '#3b4252',
      '--bg-inset': '#272d38',
      '--border': '#434c5e',
      '--border-strong': '#4c566a',
      '--text-hi': '#eceff4',
      '--text-mid': '#c3cad6',
      '--text-lo': '#a6aebf', // ≥4.5:1 on nord elevated (#8b93a5 was 3.3:1)
      // Nord's rail sits on #353c4a — the lightest "dark" surface in the app. A vivid accent
      // is not text-grade on it (violet: 4.0:1 bare, 2.9:1 on the selected chip), so the ink
      // gives up a third of its accent to --text-hi. 68% is the most it can keep.
      '--ws-ink-mix': '68%'
    },
    terminal: terminalFrom(
      {
        '--bg-app': '#2e3440',
        '--text-hi': '#eceff4'
      },
      '#fd8d03'
    )
  },
  {
    id: 'solarized',
    name: 'Solarized',
    mode: 'dark',
    chrome: {
      '--bg-app': '#002b36',
      '--bg-surface': '#073642',
      '--bg-elevated': '#0a4150',
      '--bg-inset': '#00232c',
      '--border': '#0e4a59',
      '--border-strong': '#1a5e6e',
      '--text-hi': '#eee8d5',
      // Was #a3b1b1 — the weakest --text-mid of the four themes (5.87:1 on its own rail).
      // Neutral text that RIDES an identity tint has less than that: the selected tab's pane
      // count measured 4.44:1 under a bright cyan wash. Lifted to 6.94:1 bare / 5.26:1 tinted,
      // the same AA-over-fidelity call --text-lo below already made for this theme.
      '--text-mid': '#b3c0c0',
      '--text-lo': '#93abab', // ≥4.5:1 on solarized elevated (#758a8a was 3.1:1)
      '--ws-ink-mix': '86%' // deeper surface than nord's, so the ink keeps more of its accent
    },
    terminal: terminalFrom(
      {
        '--bg-app': '#002b36',
        '--text-hi': '#e4ddc8'
      },
      '#fd8d03'
    )
  }
]

export const DEFAULT_THEME_ID = 'midnight'

/** Union of every token any theme may write — cleared on switch so themes never leak. */
const THEMABLE_TOKENS = Array.from(new Set(THEMES.flatMap((t) => Object.keys(t.chrome))))

let systemMq: MediaQueryList | null = null
let systemListener: (() => void) | null = null

function resolveSystem(theme: AppTheme): AppTheme {
  if (theme.mode !== 'system') return theme
  const light =
    typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches
  return THEMES.find((t) => t.id === (light ? 'light' : DEFAULT_THEME_ID)) ?? THEMES[1]
}

function writeTheme(theme: AppTheme): void {
  const concrete = resolveSystem(theme)
  const root = document.documentElement
  for (const token of THEMABLE_TOKENS) root.style.removeProperty(token)
  for (const [token, value] of Object.entries(concrete.chrome)) {
    root.style.setProperty(token, value)
  }
  root.setAttribute('data-theme-mode', concrete.mode) // pins first-paint fallback off
  setTerminalTheme(concrete.terminal)

  // Keep the native window-control overlay on the SAME surface as the top bar — the
  // min/max/close buttons must read as part of the single bar, every theme.
  // Best-effort: a no-op on macOS or outside the bridge.
  try {
    void getBridge().invoke(ShellChannels.titlebarOverlay, {
      color: concrete.chrome['--bg-surface'] ?? '#141518',
      symbolColor: concrete.chrome['--text-mid'] ?? '#a9aeb6'
    })
  } catch {
    /* bridge unavailable (tests) — chrome tint is cosmetic */
  }
}

/**
 * Apply a theme: write its tokens + broadcast the derived terminal theme. Returns the
 * *chosen* id (e.g. "system"), which is what persists — so the preference, not the
 * resolution, survives restarts.
 */
export function applyTheme(id: string): string {
  const theme =
    THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_THEME_ID) ?? THEMES[0]

  if (systemMq && systemListener) systemMq.removeEventListener('change', systemListener)
  systemMq = null
  systemListener = null

  writeTheme(theme)

  if (theme.mode === 'system' && typeof matchMedia === 'function') {
    systemMq = matchMedia('(prefers-color-scheme: light)')
    systemListener = () => writeTheme(theme)
    systemMq.addEventListener('change', systemListener)
  }

  return theme.id
}
