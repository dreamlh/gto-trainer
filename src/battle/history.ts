import type { ArchivedHandView, HandView } from './types'

export const HISTORY_STREETS = ['preflop', 'flop', 'turn', 'river'] as const
const BOARD_LENGTH = { preflop: 0, flop: 3, turn: 4, river: 5 }

/** Use only boards already exposed by the server, including partially revealed runouts. */
export function historySections(hand: Pick<HandView | ArchivedHandView, 'history' | 'board' | 'boards'>) {
  const boards = hand.boards.length ? hand.boards : [hand.board]
  return HISTORY_STREETS.flatMap(street => {
    const actions = hand.history.flatMap((action, index) => action.street === street ? [{ action, index }] : [])
    const visibleBoards = street === 'preflop' ? [] : boards.flatMap((board, index) => board.length >= BOARD_LENGTH[street]
      ? [{ run: index + 1, cards: board.slice(0, BOARD_LENGTH[street]) }] : [])
    return actions.length || visibleBoards.length || street === 'preflop' ? [{ street, actions, boards: visibleBoards }] : []
  })
}
