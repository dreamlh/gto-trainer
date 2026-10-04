import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useLanguage } from '../battle/i18n'
import '../battle/stats.css'

export function StatsHistoryToolbar({ title, disabled, onClear }: {
  title: string; disabled: boolean; onClear: () => void
}) {
  const { t } = useLanguage()
  return <div className="stats-history-toolbar">
    <h2>{title}</h2>
    <button type="button" className="stats-history-clear" disabled={disabled} onClick={onClear}>{t('清空历史', 'Clear history')}</button>
  </div>
}

export function ClearHistoryDialog({ title, description, busy = false, error, onConfirm, onClose, fallbackFocus }: {
  title: string; description: string; busy?: boolean; error?: string
  onConfirm: () => void; onClose: () => void; fallbackFocus: () => void
}) {
  const { t } = useLanguage()
  const dialog = useRef<HTMLDialogElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    dialog.current?.showModal()
    cancel.current?.focus()
    return () => {
      dialog.current?.close()
      if (previousFocus?.isConnected && !previousFocus.matches(':disabled')) previousFocus.focus()
      else fallbackFocus()
    }
  }, [])
  return createPortal(<dialog ref={dialog} className="stats-history-dialog" aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={busy} onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <h2 id={titleId}>{title}</h2>
    <p id={descriptionId}>{description}</p>
    {error && <p className="input-error" role="alert">{error}</p>}
    <div className="stats-history-dialog-actions">
      <button ref={cancel} type="button" disabled={busy} onClick={onClose}>{t('取消', 'Cancel')}</button>
      <button type="button" className="stats-history-confirm" disabled={busy} onClick={onConfirm}>{busy ? t('清空中…', 'Clearing…') : t('确认清空', 'Clear history')}</button>
    </div>
  </dialog>, document.body)
}
