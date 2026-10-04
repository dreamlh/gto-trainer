import type { CSSProperties, ReactNode } from 'react'

/** Shared seat face: cards, exact stack, position badge and action status. */
export function PokerSeatContent({ cards, cardsClassName = '', name, stack, unit = 'BB', position, positionTitle, dealer, status, statusTitle, statusClassName = '', winnerLabel }: {
  cards: ReactNode
  cardsClassName?: string
  name: string
  stack: string
  unit?: string
  position: string
  positionTitle?: string
  dealer: boolean
  status: ReactNode
  statusTitle?: string
  statusClassName?: string
  winnerLabel?: string
}) {
  return <>
    <div className={`battle-seat-cards ${cardsClassName}`}>{cards}</div>
    <div className="battle-seat-box" data-winner-label={winnerLabel}>
      <div className="battle-seat-name"><span className="battle-seat-player-name" title={name}>{name}</span></div>
      <div className="battle-seat-chips">
        <strong><span className="battle-stack-value" style={{ '--stack-length': stack.length } as CSSProperties}>{stack}</span><small>{unit}</small></strong>
        {position && <span className={`battle-position${dealer ? ' battle-position-button' : ''}`} title={positionTitle ?? position}>{position.replace(' / ', '/')}</span>}
      </div>
    </div>
    <div className="battle-seat-footer"><span className={`battle-seat-status ${statusClassName}`} title={statusTitle}>{status}</span></div>
  </>
}
