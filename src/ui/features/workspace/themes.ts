import type { ITheme } from '@xterm/xterm'
import { setTerminalTheme } from '../../core/theme/theme-port'

/** A theme = app-chrome CSS variables + a matching xterm terminal theme. */
export interface AppTheme {
  id: string
  name: string
  chrome: Record<string, string>
  terminal: ITheme
}

export const THEMES: AppTheme[] = [
  {
    id: 'midnight',
    name: 'Midnight',
    chrome: { '--bg': '#0a0a0a', '--panel': '#121212', '--border': 'rgba(255,255,255,0.08)', '--text': '#e6e6e6', '--muted': 'rgba(255,255,255,0.45)', '--accent': '#4ade80', '--warn': '#fbbf24' },
    terminal: { background: '#0a0a0a', foreground: '#e6e6e6', cursor: '#e6e6e6', selectionBackground: 'rgba(74,222,128,0.3)' }
  },
  {
    id: 'nord',
    name: 'Nord',
    chrome: { '--bg': '#2e3440', '--panel': '#3b4252', '--border': 'rgba(255,255,255,0.10)', '--text': '#eceff4', '--muted': 'rgba(236,239,244,0.55)', '--accent': '#88c0d0', '--warn': '#ebcb8b' },
    terminal: { background: '#2e3440', foreground: '#eceff4', cursor: '#88c0d0', selectionBackground: 'rgba(136,192,208,0.3)' }
  },
  {
    id: 'solarized',
    name: 'Solarized',
    chrome: { '--bg': '#002b36', '--panel': '#073642', '--border': 'rgba(255,255,255,0.10)', '--text': '#93a1a1', '--muted': 'rgba(147,161,161,0.6)', '--accent': '#268bd2', '--warn': '#b58900' },
    terminal: { background: '#002b36', foreground: '#93a1a1', cursor: '#268bd2', selectionBackground: 'rgba(38,139,210,0.3)' }
  },
  {
    id: 'amber',
    name: 'Amber',
    chrome: { '--bg': '#1a1206', '--panel': '#241a0a', '--border': 'rgba(251,191,36,0.14)', '--text': '#f5deb3', '--muted': 'rgba(245,222,179,0.5)', '--accent': '#fb923c', '--warn': '#fbbf24' },
    terminal: { background: '#1a1206', foreground: '#f5deb3', cursor: '#fb923c', selectionBackground: 'rgba(251,146,60,0.3)' }
  }
]

export const DEFAULT_THEME_ID = 'midnight'

/** Apply a theme (chrome CSS vars + broadcast the terminal theme). Returns the resolved id. */
export function applyTheme(id: string): string {
  const theme = THEMES.find((t) => t.id === id) ?? THEMES[0]
  const root = document.documentElement
  for (const [key, value] of Object.entries(theme.chrome)) root.style.setProperty(key, value)
  setTerminalTheme(theme.terminal)
  return theme.id
}
