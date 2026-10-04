import type { ReactNode } from 'react'
import type { Card } from '../poker/cards'
import { RANK_CHARS, SUIT_SYMBOLS, rankOf, suitOf } from '../poker/cards'
import { useLanguage } from '../battle/i18n'
import { CardFace } from './CardFace'
import './poker-hole-card.css'

export interface PokerHoleCardProps {
  card: Card | null
  index: number
  back: ReactNode
  publiclyShown?: boolean
  winning?: boolean
}

/** Keep this component mounted by hand/seat/index, never by the revealed value. */
export function PokerHoleCard({ card, index, back, publiclyShown = false, winning = false }: PokerHoleCardProps) {
  const { t } = useLanguage()
  const faceUp = card !== null
  const label = faceUp ? `${RANK_CHARS[rankOf(card)]}${SUIT_SYMBOLS[suitOf(card)]}` : t('未亮底牌', 'Face-down hole card')
  const shown = faceUp && publiclyShown
  const winningCard = faceUp && winning
  const description = [label, shown && t('已亮牌', 'Shown to the table'), winningCard && t('获胜五张牌', 'Winning five cards')].filter(Boolean).join(' · ')
  return <span className={`poker-hole-card${index % 2 ? ' poker-hole-card-second' : ''}${shown ? ' is-publicly-shown' : ''}${winningCard ? ' is-winning' : ''}`} data-face={faceUp ? 'up' : 'down'} role="img" aria-label={description} title={winningCard ? t('获胜五张牌之一', 'Part of the winning five') : shown ? t('已向全桌亮牌', 'Shown to the whole table') : undefined}>
    <span className={`poker-hole-flipper${faceUp ? ' is-face-up' : ''}`}>
      <span className="poker-hole-back" aria-hidden="true">{back}</span>
      <span className="poker-hole-front" aria-hidden={!faceUp}>
        {faceUp ? <CardFace card={card} /> : <span className="card-face card-md poker-hole-placeholder" aria-hidden="true" />}
      </span>
    </span>
  </span>
}
