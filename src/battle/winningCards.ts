import type { Card } from '../poker/cards'
import { evaluate } from '../poker/evaluator'
import type { PokerTableEventView } from '../poker/tableEvents'

export interface WinningFive {
  playerId: string
  cards: Card[]
  category: number
  score: number
}

export interface WinningCards {
  board: Set<Card>
  hole: Map<string, Set<Card>>
  hands: WinningFive[]
}

const validCard = (card: Card) => Number.isInteger(card) && card >= 0 && card < 52

/** Equivalent combinations prefer playing more public board cards, then higher card codes. */
function bestFive(board: readonly Card[], hole: readonly Card[]): Card[] {
  const cards = [...board, ...hole].sort((a, b) => b - a)
  const publicCards = new Set(board)
  let best: Card[] = [], bestScore = -1, bestPublic = -1
  for (let a = 0; a < cards.length - 4; a++) {
    for (let b = a + 1; b < cards.length - 3; b++) {
      for (let c = b + 1; c < cards.length - 2; c++) {
        for (let d = c + 1; d < cards.length - 1; d++) {
          for (let e = d + 1; e < cards.length; e++) {
            const candidate = [cards[a], cards[b], cards[c], cards[d], cards[e]]
            const score = evaluate(candidate)
            const count = candidate.filter(card => publicCards.has(card)).length
            if (score > bestScore || score === bestScore && count > bestPublic) {
              best = candidate; bestScore = score; bestPublic = count
            }
          }
        }
      }
    }
  }
  return best
}

/** Highlight only a published run's winners using fully visible hole cards. */
export function winningCards(room: PokerTableEventView, boardIndex = 0): WinningCards {
  const output: WinningCards = { board: new Set(), hole: new Map(), hands: [] }
  const hand = room.hand
  if (!hand?.showdown || room.settlementAt != null || !Number.isInteger(boardIndex) || boardIndex < 0) return output
  if (!room.runoutPlayback && (!hand.finished || hand.delta === null)) return output
  const result = (room.runoutPlayback?.completedResults ?? hand.runResults ?? []).find(run => run.run === boardIndex + 1)
  const board = result?.board
  if (!result || board?.length !== 5 || !board.every(validCard) || new Set(board).size !== 5) return output
  const winners = new Set([...result.winners, ...Object.keys(result.payouts).filter(id => result.payouts[id] > 0)])
  for (const player of hand.players) {
    if (!winners.has(player.id) || player.folded || !player.cards || player.cards.some(card => card === null)) continue
    const hole = player.cards as [Card, Card]
    // Incomplete/malformed public data cannot reveal or invent a private best hand.
    if (!hole.every(validCard) || new Set([...board, ...hole]).size !== 7) continue
    const cards = bestFive(board, hole)
    const selected = new Set(cards)
    for (const card of board) if (selected.has(card)) output.board.add(card)
    output.hole.set(player.id, new Set(hole.filter(card => selected.has(card))))
    const score = evaluate(cards)
    output.hands.push({ playerId: player.id, cards, score, category: score >>> 24 })
  }
  return output
}
