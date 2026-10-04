import type { CSSProperties } from 'react'
import type { BattleVisualAward } from '../battle/visualEvents'
import { tableSeatLayout } from '../poker/tableLayout'
import '../battle/effects.css'

export function PokerPayoutEffect({ capacity, viewOrigin, players, award }: {
  capacity: number; viewOrigin: number; players: { id: string; seat?: number | null }[]; award: BattleVisualAward | null
}) {
  if (!award) return null
  return <div key={award.key} className="battle-payout-effects" aria-hidden="true">
    {award.winnerIds.map(id => {
      const seat = players.find(player => player.id === id)?.seat
      if (seat == null) return null
      const layout = tableSeatLayout(capacity, (seat - viewOrigin + capacity) % capacity)
      return <div key={id} style={{ '--winner-x': `${layout.x}%`, '--winner-y': `${layout.y}%` } as CSSProperties}>
        {[0, 1, 2].map(index => <i className="battle-payout-flight" key={index} style={{ '--chip-index': index } as CSSProperties} />)}
        <span className="battle-winner-ring" />
        {Array.from({ length: 8 }, (_, index) => <i className="battle-winner-spark" key={`spark-${index}`} style={{ '--spark-angle': `${index * 45}deg` } as CSSProperties} />)}
      </div>
    })}
  </div>
}
