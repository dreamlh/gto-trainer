import { useSyncExternalStore } from 'react'

/** Colour themes; the palettes themselves live in themes.css. */
export const APP_THEMES = [
  { id: 'felt', zh: '墨绿', en: 'Green felt', noteZh: '经典绿桌布，鼠尾草绿高光', noteEn: 'Classic green cloth, sage highlights' },
  { id: 'midnight', zh: '午夜蓝', en: 'Midnight', noteZh: '深蓝桌布，黄铜色高光', noteEn: 'Navy cloth, brass highlights' },
  { id: 'bordeaux', zh: '勃艮第', en: 'Bordeaux', noteZh: '酒红丝绒，香槟金高光', noteEn: 'Wine velvet, champagne highlights' },
  { id: 'graphite', zh: '石墨', en: 'Graphite', noteZh: '中性灰界面，冰蓝高光，绿桌布', noteEn: 'Charcoal room, ice-blue highlights, green cloth' },
  { id: 'dusk', zh: '暮紫', en: 'Dusk', noteZh: '暗紫色调，玫瑰粉高光', noteEn: 'Violet dusk, rose highlights' },
] as const
export type AppThemeId = typeof APP_THEMES[number]['id']

// Also read by the pre-paint script in index.html; keep the key in sync.
const STORAGE_KEY = 'gto.theme'
const DEFAULT_THEME: AppThemeId = 'felt'
const listeners = new Set<() => void>()
const valid = (value: unknown): AppThemeId => APP_THEMES.find(theme => theme.id === value)?.id ?? DEFAULT_THEME

let current: AppThemeId = (() => {
  try { return valid(localStorage.getItem(STORAGE_KEY)) } catch { return DEFAULT_THEME }
})()

function apply(theme: AppThemeId) {
  if (typeof document === 'undefined') return
  if (theme === DEFAULT_THEME) delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme
}
apply(current)

export function getAppTheme(): AppThemeId { return current }

export function setAppTheme(theme: AppThemeId) {
  current = valid(theme)
  apply(current)
  try { localStorage.setItem(STORAGE_KEY, current) } catch { /* The theme still applies for this visit. */ }
  listeners.forEach(listener => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.key !== STORAGE_KEY && event.key !== null) return
  current = valid(event.key === null ? null : event.newValue)
  apply(current)
  listeners.forEach(listener => listener())
})

export function useAppTheme(): AppThemeId {
  return useSyncExternalStore(subscribe, getAppTheme, getAppTheme)
}
