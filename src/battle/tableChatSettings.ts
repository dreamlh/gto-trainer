import { useSyncExternalStore } from 'react'
const KEY = 'gto.battle.tableChat'
const EVENT = 'gto-table-chat-setting'
let fallback = true
let memoryOverride: boolean | undefined
export function tableChatEnabled(): boolean {
  if (memoryOverride !== undefined) return memoryOverride
  try { const value = localStorage.getItem(KEY); return value === null ? fallback : value !== 'off' } catch { return fallback }
}
export function setTableChatEnabled(enabled: boolean): void {
  fallback = enabled
  try { localStorage.setItem(KEY, enabled ? 'on' : 'off'); memoryOverride = undefined } catch { memoryOverride = enabled }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVENT))
}
function subscribe(listener: () => void) {
  const storage = (event: StorageEvent) => { if (event.key === KEY || event.key === null) { memoryOverride = undefined; listener() } }
  window.addEventListener(EVENT, listener); window.addEventListener('storage', storage)
  return () => { window.removeEventListener(EVENT, listener); window.removeEventListener('storage', storage) }
}
export function useTableChatEnabled() { return useSyncExternalStore(subscribe, tableChatEnabled, () => true) }
