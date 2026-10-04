import type { HandView, PlayerStats } from './types'

export function emptyStats(): PlayerStats {
  return {
    hands: 0, vpip: 0, pfr: 0, threeBet: 0, threeBetOpportunities: 0,
    cbet: 0, cbetOpportunities: 0, sawFlop: 0, showdowns: 0, showdownWins: 0,
    betsRaises: 0, calls: 0, netBB: 0,
  }
}

export function addStats(a: PlayerStats, b: PlayerStats): PlayerStats {
  const result = emptyStats()
  for (const key of Object.keys(result) as (keyof PlayerStats)[]) result[key] = a[key] + b[key]
  return result
}

/** One settled hand. Counts use action opportunities, not the number of bets faced. */
export function handStats(hand: HandView, playerId: string): PlayerStats {
  const result = emptyStats()
  const player = hand.players.find(candidate => candidate.id === playerId)
  if (!hand.finished || !player || !hand.delta) return result
  result.hands = 1
  result.netBB = (hand.delta[playerId] ?? 0) / (hand.bigBlind ?? 1)
  let raises = 0
  let lastPreflopAggressor: string | null = null
  let foldedPreflop = false
  for (const action of hand.history.filter(action => action.street === 'preflop')) {
    const decision = ['fold', 'check', 'call', 'raise'].includes(action.kind)
    if (action.playerId === playerId && decision) {
      if (action.kind === 'call' || action.kind === 'raise') result.vpip = 1
      if (action.kind === 'raise') result.pfr = 1
      if (action.kind === 'fold') foldedPreflop = true
      if (raises === 1 && lastPreflopAggressor !== playerId && !result.threeBetOpportunities) {
        result.threeBetOpportunities = 1
        if (action.kind === 'raise') result.threeBet = 1
      }
    }
    if (action.kind === 'raise') {
      raises++
      lastPreflopAggressor = action.playerId
    }
  }
  let flopBet = false
  let actedOnFlop = false
  for (const action of hand.history.filter(action => action.street !== 'preflop')) {
    const decision = ['fold', 'check', 'call', 'raise'].includes(action.kind)
    if (action.playerId === playerId && decision) {
      if (action.kind === 'raise') result.betsRaises++
      if (action.kind === 'call') result.calls++
      if (action.street === 'flop' && !actedOnFlop) {
        if (lastPreflopAggressor === playerId && !flopBet) {
          result.cbetOpportunities = 1
          result.cbet = action.kind === 'raise' ? 1 : 0
        }
        actedOnFlop = true
      }
    }
    if (action.street === 'flop' && action.kind === 'raise') flopBet = true
  }
  // All-in players still see the flop even when no one can act on it.
  result.sawFlop = hand.board.length >= 3 && !foldedPreflop ? 1 : 0
  result.showdowns = result.sawFlop && hand.showdown && !player.folded ? 1 : 0
  // Receiving any part of a contested pot counts, including ties and side pots.
  result.showdownWins = result.showdowns && (hand.delta[playerId] ?? 0) + player.invested > 0 ? 1 : 0
  return result
}
