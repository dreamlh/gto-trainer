import { RANK_CHARS, SUIT_SYMBOLS, rankOf, suitOf, type Card } from '../poker/cards'

// 四色牌面：黑桃深灰 红桃红 方块蓝 梅花绿
const SUIT_COLORS = ['#1b2330', '#d64545', '#3b78d6', '#3f9e5f']

export function CardFace({ card, size = 'md' }: { card: Card; size?: 'md' | 'lg' }) {
  const r = rankOf(card)
  const s = suitOf(card)
  return (
    <div className={`card-face card-${size}`} style={{ color: SUIT_COLORS[s] }}>
      <span className="card-rank">{RANK_CHARS[r]}</span>
      <span className="card-suit">{SUIT_SYMBOLS[s]}</span>
    </div>
  )
}
