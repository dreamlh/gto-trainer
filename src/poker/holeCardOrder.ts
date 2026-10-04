import { rankOf, type Card } from './cards'

/** Keep protocol indices intact for selective reveals; sort only known pairs. */
export function holeCardOrder(cards: readonly (Card | null)[] | null | undefined): number[] {
  if (!cards || cards.length !== 2 || cards.some(card => card === null)) return [0, 1]
  return rankOf(cards[0]!) >= rankOf(cards[1]!) ? [0, 1] : [1, 0]
}
