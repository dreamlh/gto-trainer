import { evaluate } from '../poker/evaluator'
import type { Card } from '../poker/cards'
import { POSITIONS_BY_SIZE } from '../solver/config'
import type { HandView, RoomPlayer, RoomView } from './types'

type Translate = (zh: string, en: string) => string
export interface BattleResultSummary { label: string; detail: string }

/** Keep the final dock summary independent of the board selected for review. */
export function battleResultSummary(room: Pick<RoomView, 'hand' | 'settlementAt' | 'runoutPlayback' | 'players' | 'mode' | 'tournament'>, t: Translate): BattleResultSummary | null {
  const hand = room.hand
  if (!hand || room.settlementAt != null) return null
  const champion = room.mode === 'tournament' && room.tournament?.status === 'finished'
    ? room.players.find(player => player.id === room.tournament!.winnerId) : undefined
  if (champion) return { label: t('冠军', 'Champion'), detail: playerDisplayName(champion, t) }

  const final = hand.finished && hand.delta !== null && !room.runoutPlayback
  const playback = room.runoutPlayback
  const run = playback?.phase === 'result'
    ? playback.completedResults.find(result => result.run === playback.boardIndex + 1)
    : final ? hand.runResults?.[0] : undefined
  const results = final && hand.runCount > 1 ? hand.runResults ?? [] : run ? [run] : []
  // Payouts are chips won from pots, not net profit; the dock header shows net delta.
  const totals = new Map<string, number>()
  for (const result of results) for (const [id, amount] of Object.entries(result.payouts)) {
    if (amount > 0) totals.set(id, (totals.get(id) ?? 0) + amount)
  }
  if (!totals.size) return null
  const unit = room.mode === 'tournament' ? t('筹码', 'chips') : 'BB'
  return {
    label: final && hand.runCount > 1 ? t('合计获胜', 'Total won')
      : hand.runCount > 1 && run ? t(`第 ${run.run} 次获胜`, `Run ${run.run} winner`) : t('获胜', 'Winner'),
    detail: [...totals].map(([id, amount]) => `${playerDisplayName(room.players.find(player => player.id === id) ?? { name: id, bot: false }, t)} +${Number(amount.toFixed(2)).toLocaleString('en-GB')} ${unit}`).join(' · '),
  }
}

/** Bot identities remain stable while their display names follow the UI language. */
export function playerDisplayName(player: Pick<RoomPlayer, 'bot' | 'name'>, t: Translate): string {
  if (!player.bot) return player.name
  const number = player.name.match(/(?:电脑|Computer|Bot)\s*(\d+)$/i)?.[1]
  return number ? t(`电脑 ${number}`, `Bot ${number}`) : t('电脑', 'Bot')
}

/** Keep the most recent voluntary action visible for this betting round. */
export function bettingActionName(history: HandView['history'], index: number, t: Translate): string {
  const action = history[index]
  const names: Record<string, [string, string]> = {
    fold: ['弃牌', 'Fold'], check: ['过牌', 'Check'], call: ['跟注', 'Call'],
    'small-blind': ['小盲', 'Small blind'], 'big-blind': ['大盲', 'Big blind'],
    small_blind: ['小盲', 'Small blind'], big_blind: ['大盲', 'Big blind'],
    'entry-blind': ['入桌盲注', 'Entry blind'], blind: ['盲注', 'Blind'],
    refund: ['退回未跟注筹码', 'Uncalled return'], timeout: ['超时', 'Timeout'], allin: ['全下', 'All-in'],
  }
  if (action.kind !== 'raise' && action.kind !== 'bet') return names[action.kind] ? t(...names[action.kind]) : action.kind
  const raises = history.slice(0, index + 1).filter(entry => entry.street === action.street && ['raise', 'bet'].includes(entry.kind)).length
  if (action.street === 'preflop' && raises >= 2) return `${raises + 1}-bet`
  if (action.street !== 'preflop' && raises >= 3) return `${raises}-bet`
  return action.kind === 'bet' || action.street !== 'preflop' && raises === 1 ? t('下注', 'Bet') : t('加注', 'Raise')
}

export function playerActionLabel(hand: HandView | null, playerId: string, t: Translate): string | null {
  if (!hand) return null
  const round = hand.history.filter(action => action.street === hand.street)
  let index = -1
  round.forEach((action, i) => { if (action.playerId === playerId && ['fold', 'check', 'call', 'raise', 'bet'].includes(action.kind)) index = i })
  if (index < 0) return null
  const action = round[index]
  const amount = Number(action.amount.toFixed(2)).toLocaleString('en-GB')
  const label = `${bettingActionName(round, index, t)}${action.amount > 0 ? ` ${amount}` : ''}`
  return hand.players.find(player => player.id === playerId)?.allin && action.kind !== 'fold'
    ? `${label} · ${t('全下', 'All-in')}` : label
}

/** Positions belong to the original dealt lineup, including players who folded. */
export function handPosition(hand: HandView | null, playerId: string): string | null {
  if (!hand) return null
  const index = hand.players.findIndex(player => player.id === playerId)
  const dealer = hand.players.findIndex(player => player.id === hand.dealerId)
  const positions = POSITIONS_BY_SIZE[hand.players.length]
  if (index < 0 || dealer < 0 || !positions) return null
  if (hand.players.length === 2) return playerId === hand.dealerId ? 'BTN / SB' : 'BB'
  const position = positions[(index - dealer + positions.indexOf('BTN') + positions.length) % positions.length]
  return position === 'UTG1' ? 'UTG+1' : position === 'UTG2' ? 'UTG+2' : position
}

const SHOWDOWN_CATEGORIES: [string, string][] = [
  ['高牌', 'High card'], ['一对', 'One pair'], ['两对', 'Two pair'], ['三条', 'Three of a kind'],
  ['顺子', 'Straight'], ['同花', 'Flush'], ['葫芦', 'Full house'], ['四条', 'Four of a kind'], ['同花顺', 'Straight flush'],
]

/** Rank only a completed, currently displayed run using cards already public to this viewer. */
export function playerShowdownLabel(hand: HandView | null, playerId: string, completedBoard: readonly Card[] | null, t: Translate): string | null {
  if (!hand?.showdown || completedBoard?.length !== 5) return null
  const player = hand.players.find(member => member.id === playerId)
  if (!player || player.folded || !player.cards || player.cards[0] === null || player.cards[1] === null) return null
  const score = evaluate([...player.cards as [Card, Card], ...completedBoard])
  const category = score >>> 24
  if (category === 8 && (score & 0xffffff) === 12) return t('皇家同花顺', 'Royal flush')
  return SHOWDOWN_CATEGORIES[category] ? t(...SHOWDOWN_CATEGORIES[category]) : null
}
