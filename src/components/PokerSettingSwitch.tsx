import type { ReactNode } from 'react'
import '../battle/room-settings.css'

export function PokerSettingSwitch({ children, checked, disabled = false, onChange, className = '' }: {
  children: ReactNode; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void; className?: string
}) {
  return <label className={`brs-share ${className}`}><span>{children}</span><input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} /></label>
}
