import { useEffect, useId, useRef, useState } from 'react'
import { APP_THEMES, setAppTheme, useAppTheme } from '../appTheme'
import { useLanguage } from '../battle/i18n'

/** Header control: a palette button that opens the theme list. */
export function ThemePicker() {
  const { language, t } = useLanguage()
  const theme = useAppTheme()
  const [open, setOpen] = useState(false)
  const container = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const popupId = useId()
  useEffect(() => {
    if (!open) return
    const outside = (event: Event) => { if (!container.current?.contains(event.target as Node)) setOpen(false) }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus() }
      else if (['ArrowDown', 'ArrowUp'].includes(event.key) && container.current?.contains(event.target as Node)) {
        event.preventDefault()
        const options = [...container.current.querySelectorAll<HTMLButtonElement>('.theme-option')]
        const at = options.indexOf(document.activeElement as HTMLButtonElement)
        options[(at + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus()
      }
    }
    container.current?.querySelector<HTMLButtonElement>('.theme-option[aria-pressed="true"]')?.focus()
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  const label = t('配色主题', 'Colour theme')
  return <div className="theme-picker" ref={container}>
    <button type="button" ref={trigger} className="theme-picker-trigger" aria-label={label} title={label}
      aria-expanded={open} aria-controls={popupId} aria-haspopup="dialog" onClick={() => setOpen(value => !value)}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M8 1.75a6.25 6.25 0 1 0 0 12.5c.9 0 1.4-.55 1.4-1.25 0-.9-.75-1.2-.75-2 0-.75.6-1.25 1.4-1.25h1.45a2.75 2.75 0 0 0 2.75-2.75C14.25 4.1 11.45 1.75 8 1.75Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        <circle cx="4.9" cy="7.3" r="1" fill="currentColor" /><circle cx="7.2" cy="4.6" r="1" fill="currentColor" /><circle cx="10.5" cy="5.1" r="1" fill="currentColor" />
      </svg>
    </button>
    {open && <div id={popupId} className="theme-popover" role="dialog" aria-label={label}>
      <h3>{label}</h3>
      <div className="theme-options" role="group" aria-label={label}>
        {APP_THEMES.map(option => <button type="button" key={option.id} className="theme-option" data-theme={option.id}
          aria-pressed={theme === option.id} onClick={() => setAppTheme(option.id)}>
          <span className="theme-swatch" aria-hidden="true"><i /><b /></span>
          <span className="theme-option-text">
            <strong>{language === 'zh' ? option.zh : option.en}</strong>
            <small>{language === 'zh' ? option.noteZh : option.noteEn}</small>
          </span>
          <span className="theme-option-check" aria-hidden="true" />
        </button>)}
      </div>
      <p>{t('牌局动作、花色和输赢颜色在各主题中保持一致。', 'Action, suit and win/loss colours stay the same in every theme.')}</p>
    </div>}
  </div>
}
