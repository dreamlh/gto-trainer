import type { CSSProperties } from 'react'
import '../battle/atmosphere.css'

export function PokerAllInEffect({ eventKey, name }: { eventKey: string; name: string }) {
  return <div className="battle-allin-effect" key={eventKey} aria-hidden="true">
    <div className="battle-allin-chips">{Array.from({ length: 6 }, (_, index) => <i key={index} style={{ '--chip-index': index } as CSSProperties} />)}</div>
    <div className="battle-allin-label"><strong>ALL IN</strong>{name && <span>{name}</span>}</div>
  </div>
}
