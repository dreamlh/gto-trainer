import { useEffect, useRef, useState } from 'react'
import { BattleVisualTracker, type BattleVisualEvent } from '../battle/visualEvents'
import type { PokerTableEventView } from '../poker/tableEvents'

interface VisualState {
  handKey: string
  deal: boolean
  boardKeys: Set<string>
  holeKeys: Set<string>
  betKeys: Set<string>
  potValues: Set<number>
  actions: Record<string, { key: string; kind: string }>
  award: BattleVisualEvent['award']
}

/** Keep animation identities stable through polling and consume off-screen events silently. */
export function useBattleVisuals(room: PokerTableEventView | null, active: boolean) {
  const tracker = useRef(new BattleVisualTracker())
  const dealTimer = useRef<ReturnType<typeof setTimeout>>()
  const awardTimer = useRef<ReturnType<typeof setTimeout>>()
  const [visuals, setVisuals] = useState<VisualState | null>(null)
  useEffect(() => {
    const reset = () => { tracker.current.resetContinuity(); setVisuals(null) }
    document.addEventListener('visibilitychange', reset)
    return () => { document.removeEventListener('visibilitychange', reset); clearTimeout(dealTimer.current); clearTimeout(awardTimer.current) }
  }, [])
  useEffect(() => {
    const event = tracker.current.observe(room, active && !document.hidden)
    if (!room || !active || document.hidden) { setVisuals(null); return }
    if (!event) return
    if (event.deal) {
      clearTimeout(dealTimer.current)
      dealTimer.current = setTimeout(() => setVisuals(previous => previous?.handKey === event.handKey ? { ...previous, deal: false } : previous), 1100)
    }
    if (event.award) {
      clearTimeout(awardTimer.current)
      awardTimer.current = setTimeout(() => setVisuals(previous => previous && previous.award?.key === event.award?.key ? { ...previous, award: null } : previous), 1900)
    }
    setVisuals(previous => {
      const old = previous?.handKey === event.handKey ? previous : null
      return {
        handKey: event.handKey,
        deal: event.deal || !!old?.deal,
        boardKeys: new Set([...(old?.boardKeys ?? []), ...event.boardKeys]),
        holeKeys: new Set([...(old?.holeKeys ?? []), ...event.holeKeys]),
        betKeys: new Set([...(old?.betKeys ?? []), ...(room.hand?.players.filter(player => player.streetBet > 0 && (event.deal || event.actions.some(action => action.playerId === player.id && ['call', 'bet', 'raise'].includes(action.kind)))).map(player => `${player.id}:${room.hand!.street}:${player.streetBet}`) ?? [])]),
        potValues: new Set([...(old?.potValues ?? []), ...(event.potChanged && room.hand ? [room.hand.pot] : [])]),
        actions: { ...old?.actions, ...Object.fromEntries(event.actions.map(action => [action.playerId, action])) },
        award: event.award ?? old?.award ?? null,
      }
    })
  }, [room, active])
  const handKey = room?.hand ? `${room.instanceId}:${room.hand.number}` : ''
  return active && !document.hidden && visuals?.handKey === handKey ? visuals : null
}
