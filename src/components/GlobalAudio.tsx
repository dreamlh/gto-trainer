import { useEffect, useId, useRef, useState } from 'react'
import { attachGlobalAudioLifecycle, unlockBattleAudio, updateBattleAudioSettings } from '../battle/audio'
import { useLanguage } from '../battle/i18n'
import { BattleAudioSettings, SpeakerIcon, useAudioSettings } from './BattleAtmosphere'
import type { BattleTurnState } from '../battle/audioEvents'

/** One persistent audio owner and settings entry point for every app page. */
export function GlobalAudio() {
  const { t } = useLanguage()
  const settings = useAudioSettings()
  const [open, setOpen] = useState(false)
  const container = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const popupId = useId()
  useEffect(() => attachGlobalAudioLifecycle(), [])
  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false) }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); trigger.current?.focus() }
    }
    const onFocus = (event: FocusEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    document.addEventListener('focusin', onFocus)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('focusin', onFocus)
    }
  }, [open])
  return <div className="app-audio-control" ref={container}>
    <button type="button" className={`battle-audio-toggle${settings.muted ? ' is-muted' : ''}`}
      aria-label={settings.muted ? t('开启声音', 'Unmute sound') : t('静音', 'Mute sound')}
      title={settings.muted ? t('开启声音', 'Unmute sound') : t('静音', 'Mute sound')}
      onClick={() => { updateBattleAudioSettings({ muted: !settings.muted }); unlockBattleAudio() }}>
      <SpeakerIcon muted={settings.muted} />
    </button>
    <button type="button" ref={trigger} className="app-audio-settings-trigger"
      aria-label={t('声音设置', 'Sound settings')} title={t('声音设置', 'Sound settings')}
      aria-expanded={open} aria-controls={popupId} aria-haspopup="dialog" onClick={() => setOpen(value => !value)}>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
    {open && <div id={popupId} className="app-audio-popover" role="dialog" aria-label={t('声音设置', 'Sound settings')}>
      <BattleAudioSettings />
    </div>}
  </div>
}

/** Inline in the header: no overlay, forced page switch or notification permission. */
export function BattleTurnNotice({ turn, onReturn }: { turn: BattleTurnState | null; onReturn: () => void }) {
  const { t } = useLanguage()
  const [now, setNow] = useState(Date.now)
  const deadline = turn?.deadline ?? null
  useEffect(() => {
    if (deadline === null) return
    setNow(Date.now())
    const interval = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(interval)
  }, [deadline])
  if (!turn) return null
  const remaining = deadline === null ? null : Math.max(0, Math.ceil((deadline - now) / 1000))
  return <div className="app-turn-notice" role="status" aria-live="polite">
    <span className="app-turn-notice-dot" aria-hidden="true" />
    <strong>{t('轮到你', 'Your turn')}</strong>
    <span className="app-turn-remaining" aria-hidden="true">{remaining === null ? t('不限时', 'Unlimited') : t(`剩余 ${remaining}s`, `${remaining}s left`)}</span>
    <button type="button" onClick={onReturn}>{t('回到牌桌', 'Return to table')} <span aria-hidden="true">↗</span></button>
  </div>
}
