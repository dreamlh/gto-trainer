import type { Card } from '../poker/cards'
import { evaluate } from '../poker/evaluator'
import type { Position } from '../poker/ranges'
import { POSITIONS_BY_SIZE } from '../solver/config'

// 纯筹码/发牌/摊牌引擎。下注合法性由 solver 树驱动（session 层），
// 引擎不重复实现下注规则——树上没有的动作不存在。

export type GameStreet = 'preflop' | 'flop' | 'turn' | 'river'

export interface EnginePlayer {
  seat: number
  cards: [Card, Card]
  invested: number // 累计投入（bb）
  streetBase: number // 本街开始时的累计投入（当前街下注 = invested - streetBase）
  folded: boolean
  allin: boolean
}

export interface EngineState {
  n: number
  positions: Position[]
  stack: number // 起始筹码
  street: GameStreet
  board: Card[]
  deck: Card[]
  deckPtr: number
  players: EnginePlayer[]
  history: { street: GameStreet; seat: number; kind: string; to: number }[]
}

export function shuffledDeck(): Card[] {
  const d: Card[] = []
  for (let i = 0; i < 52; i++) d.push(i)
  for (let i = 51; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0
    const t = d[i]
    d[i] = d[j]
    d[j] = t
  }
  return d
}

export function newHand(n: number, stack = 100): EngineState {
  const positions = POSITIONS_BY_SIZE[n]
  if (!positions) throw new Error(`不支持人数 ${n}`)
  const deck = shuffledDeck()
  const players: EnginePlayer[] = []
  for (let i = 0; i < n; i++) {
    players.push({
      seat: i,
      cards: [deck[i * 2], deck[i * 2 + 1]],
      invested: 0,
      streetBase: 0,
      folded: false,
      allin: false,
    })
  }
  const sbSeat = n === 2 ? 0 : positions.indexOf('SB')
  const bbSeat = positions.indexOf('BB')
  players[sbSeat].invested = 0.5
  players[bbSeat].invested = 1
  return {
    n,
    positions,
    stack,
    street: 'preflop',
    board: [],
    deck,
    deckPtr: n * 2,
    players,
    history: [],
  }
}

export function pot(st: EngineState): number {
  return st.players.reduce((a, p) => a + p.invested, 0)
}

export function activeSeats(st: EngineState): number[] {
  return st.players.filter((p) => !p.folded).map((p) => p.seat)
}

// 应用一个动作（to = 累计投入目标；fold 不变）
export function applyAction(st: EngineState, seat: number, kind: string, to: number): void {
  const p = st.players[seat]
  if (kind === 'fold') {
    p.folded = true
  } else if (kind !== 'check') {
    p.invested = to
    if (to >= st.stack - 0.001) p.allin = true
  }
  st.history.push({ street: st.street, seat, kind, to })
}

// 进入下一街并发牌
export function advanceStreet(st: EngineState): void {
  for (const p of st.players) p.streetBase = p.invested
  if (st.street === 'preflop') {
    st.board.push(st.deck[st.deckPtr++], st.deck[st.deckPtr++], st.deck[st.deckPtr++])
    st.street = 'flop'
  } else if (st.street === 'flop') {
    st.board.push(st.deck[st.deckPtr++])
    st.street = 'turn'
  } else if (st.street === 'turn') {
    st.board.push(st.deck[st.deckPtr++])
    st.street = 'river'
  }
}

// 发满公共牌（全下 runout）
export function runOutBoard(st: EngineState): void {
  while (st.board.length < 5) st.board.push(st.deck[st.deckPtr++])
}

// 摊牌：返回每个未弃玩家的赢得份额（bb）。等筹码无边池。
export function showdown(st: EngineState): Map<number, number> {
  const act = st.players.filter((p) => !p.folded)
  const totalPot = pot(st)
  const scores = act.map((p) => ({
    seat: p.seat,
    score: evaluate([p.cards[0], p.cards[1], ...st.board]),
  }))
  const best = Math.max(...scores.map((s) => s.score))
  const winners = scores.filter((s) => s.score === best)
  const out = new Map<number, number>()
  for (const p of act) out.set(p.seat, 0)
  for (const w of winners) out.set(w.seat, totalPot / winners.length)
  return out
}

// 结算：每人净胜负（bb）
export function settle(st: EngineState, winnings: Map<number, number>): Map<number, number> {
  const out = new Map<number, number>()
  for (const p of st.players) {
    out.set(p.seat, (winnings.get(p.seat) ?? 0) - p.invested)
  }
  return out
}
