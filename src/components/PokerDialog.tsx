import { useEffect, useRef, type ReactNode } from 'react'
import { useLanguage } from '../battle/i18n'

export function PokerDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const { t } = useLanguage()
  const dialog = useRef<HTMLElement>(null)
  const closeRef = useRef(onClose); closeRef.current = onClose
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const node = dialog.current!
    const focusable = () => [...node.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]')].filter(element => element.getClientRects().length > 0)
    focusable()[0]?.focus()
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return }
      if (event.key !== 'Tab') return
      const items = focusable(); const first = items[0]; const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden'
    node.addEventListener('keydown', key)
    return () => { node.removeEventListener('keydown', key); document.body.style.overflow = overflow; previous?.focus() }
  }, [])
  return <div className="battle-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="battle-modal" ref={dialog} role="dialog" aria-modal="true" aria-label={title}>
      <header className="battle-modal-header"><h2>{title}</h2><button className="battle-close" aria-label={t('关闭', 'Close')} onClick={onClose}>×</button></header>
      <div className="battle-modal-body">{children}</div>
    </section>
  </div>
}
