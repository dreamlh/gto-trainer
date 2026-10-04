import { useEffect, useRef, useState } from 'react'
import { BattleAudioTracker } from '../battle/audioEvents'
import { playBattleSound } from '../battle/audio'
import type { PokerTableEventView } from '../poker/tableEvents'

/** Shared event priorities, deduplication and foreground continuity for both tables. */
export function usePokerAudioEvents(view: PokerTableEventView | null, audible = true) {
  const tracker = useRef(new BattleAudioTracker())
  const timeout = useRef<ReturnType<typeof setTimeout>>()
  const [allin, setAllin] = useState<{ key: string; ids: string[] } | null>(null)
  useEffect(() => {
    const reset = () => { tracker.current.resetContinuity(); setAllin(null) }
    document.addEventListener('visibilitychange', reset)
    return () => { document.removeEventListener('visibilitychange', reset); clearTimeout(timeout.current) }
  }, [])
  useEffect(() => {
    const event = tracker.current.observe(view, audible && !document.hidden)
    if (!view || !audible || document.hidden) { setAllin(null); return }
    if (!event) return
    if (event.allinIds.length) {
      setAllin({ key: event.key, ids: event.allinIds })
      clearTimeout(timeout.current)
      timeout.current = setTimeout(() => setAllin(null), 1500)
    }
    if (event.sound) playBattleSound(event.sound)
  }, [view, audible])
  return audible && !document.hidden ? allin : null
}
