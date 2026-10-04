import { useCallback, useEffect, useState } from 'react'
import type { Language } from './types'

const KEY = 'gto.language'
const EVENT = 'gto-language-change'
let currentLanguage: Language | null = null

export function getLanguage(): Language {
  if (currentLanguage) return currentLanguage
  try { currentLanguage = localStorage.getItem(KEY) === 'en' ? 'en' : 'zh' } catch { currentLanguage = 'zh' }
  return currentLanguage
}

export function setLanguage(language: Language): void {
  currentLanguage = language
  try { localStorage.setItem(KEY, language) } catch { /* Language still works for this tab. */ }
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'
  window.dispatchEvent(new Event(EVENT))
}

export function useLanguage() {
  const [language, update] = useState<Language>(getLanguage)
  const translate = useCallback((zh: string, en: string) => language === 'zh' ? zh : en, [language])
  useEffect(() => {
    const sync = () => {
      const next = getLanguage()
      document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en'
      update(next)
    }
    const syncStorage = (event: StorageEvent) => {
      if (event.key === KEY) {
        currentLanguage = event.newValue === 'en' ? 'en' : 'zh'
        sync()
      }
    }
    sync()
    window.addEventListener(EVENT, sync)
    window.addEventListener('storage', syncStorage)
    return () => {
      window.removeEventListener(EVENT, sync)
      window.removeEventListener('storage', syncStorage)
    }
  }, [])
  return { language, setLanguage, t: translate }
}
