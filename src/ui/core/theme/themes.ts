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

const MIDNIGHT_CHROME: Record<string, string> = {
  '--bg-app': '#0c0d0f',
  '--bg-surface': '#141518',
  '--bg-elevated': '#1b1d21',
  '--bg-inset': '#08090b',
  '--border': '#26282d',
  '--border-strong': '#34373d',
  '--text-hi': '#f4f5f7',
  '--text-mid': '#a9aeb6',
  '--text-lo': '#7c828b'
}

const LIGHT_CHROME: Record<string, string> = {
  '--bg-app': '#f6f7f9',
  '--bg-surface': '#ffffff',
  '--bg-elevated': '#ffffff',
  '--bg-inset': '#eceef2',
  '--border': '#dfe2e8',
  '--border-strong': '#c6ccd5',
  '--text-hi': '#15171b',
  '--text-mid': '#4b515b',
  '--text-lo': '#666b74',
  // On light surfaces orange must darken past brand-700 to hold AA as text/icon ink
  // (#a55800 ≈ 5.2:1 on white), and the on-accent text flips to a warm near-white.
  '--accent-ink': '#a55800',
  '--accent-contrast': '#fff8ee',
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
      '--text-lo': '#8b93a5'
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
      '--text-mid': '#a3b1b1',
      '--text-lo': '#758a8a'
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
