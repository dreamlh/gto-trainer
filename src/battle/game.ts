import { fullDeck, rankOf, suitOf, type Card } from '../poker/cards'
import { evaluate } from '../poker/evaluator'
import type { BattleAction, HandView, LegalActions, RunoutResult } from './types'

interface BattlePlayer {
  id: string
  cards: [Card, Card]
  stack: number
  startingStack: number
  totalBet: number
  streetBet: number
  folded: boolean
}

/** Server-only state. Always send handView(), never serialize this to a client. */
export interface BattleHand {
  bigBlind?: number
  smallBlind?: number
  number: number
  players: BattlePlayer[]
  dealerIndex: number
  smallBlindId: string
  bigBlindId: string
  street: HandView['street']
  board: Card[]
  boards: Card[][]
  runCount: number
  awaitingRunout: boolean
  deferRunout: boolean
  deck: Card[]
  deckPosition: number
  currentBet: number
  lastFullRaise: number
  pending: string[]
  actedAtBet: Record<string, number | null>
  toAct: string | null
  finished: boolean
  showdown: boolean
  delta: Record<string, number> | null
  history: HandView['history']
  runResults?: RunoutResult[]
}

interface HandOptions {
  bigBlind?: number
  smallBlind?: number
  /** New seats electing to post a live big blind before this hand. */
  postedBlinds?: string[]
  random?: () => number
  /** Remaining stacks carried forward from the preceding hand. */
  stacks?: Record<string, number>
  /** Pause an incomplete all-in board so the room can collect runout votes. */
  deferRunout?: boolean
  /** A complete deck in deal order, for deterministic tests. */
  deck?: Card[]
}

function secureRandom(): number {
  const value = new Uint32Array(1)
  crypto.getRandomValues(value)
  return value[0] / 0x100000000
}

function shuffle(cards: Card[], random: () => number): Card[] {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[cards[i], cards[j]] = [cards[j], cards[i]]
  }
  return cards
}

const halfChips = (value: number) => Number.isFinite(value) && Number.isInteger(value * 2)
const live = (hand: BattleHand) => hand.players.filter(player => !player.folded)
const actionable = (hand: BattleHand) => live(hand).filter(player => player.stack > 0)
const pot = (hand: BattleHand) => hand.players.reduce((sum, player) => sum + player.totalBet, 0)

function pay(player: BattlePlayer, amount: number): void {
  const paid = Math.min(amount, player.stack)
  player.stack -= paid
  player.streetBet += paid
  player.totalBet += paid
}

function nextPlayer(hand: BattleHand, after: number, ids: string[]): string | null {
  for (let step = 1; step <= hand.players.length; step++) {
    const player = hand.players[(after + step) % hand.players.length]
    if (ids.includes(player.id)) return player.id
  }
  return null
}

export function startHand(
  playerIds: string[], dealerIndex: number, number: number, options: HandOptions = {},
): BattleHand {
  if (playerIds.length < 2 || playerIds.length > 9 || new Set(playerIds).size !== playerIds.length
    || playerIds.some(id => !id || ['__proto__', 'constructor', 'prototype'].includes(id))) {
    throw new Error('每手需要 2–9 位不同的玩家')
  }
  if (!Number.isInteger(dealerIndex) || dealerIndex < 0 || dealerIndex >= playerIds.length) {
    throw new Error('庄家位置无效')
  }
  const deck = options.deck ? [...options.deck] : shuffle(fullDeck(), options.random ?? secureRandom)
  if (deck.length !== 52 || new Set(deck).size !== 52 || deck.some(card => !Number.isInteger(card) || card < 0 || card > 51)) {
    throw new Error('牌堆无效')
  }
  const players = playerIds.map(id => {
    const stack = options.stacks?.[id] ?? 100
    if (!halfChips(stack) || stack <= 0) throw new Error('筹码必须是正数且以 0.5bb 为单位')
    return { id, cards: [0, 0] as [Card, Card], stack, startingStack: stack, totalBet: 0, streetBet: 0, folded: false }
  })
  const bigBlind = options.bigBlind ?? 1, smallBlind = options.smallBlind ?? bigBlind / 2
  if (!halfChips(bigBlind) || !halfChips(smallBlind) || smallBlind <= 0 || bigBlind < smallBlind) throw new Error('盲注必须为正数且以 0.5 为单位，小盲不能超过大盲')
  const smallBlindIndex = playerIds.length === 2 ? dealerIndex : (dealerIndex + 1) % players.length
  const bigBlindIndex = (smallBlindIndex + 1) % players.length
  const hand: BattleHand = {
    number, players, dealerIndex, bigBlind, smallBlind,
    smallBlindId: players[smallBlindIndex].id, bigBlindId: players[bigBlindIndex].id,
    street: 'preflop', board: [], boards: [], runCount: 1,
    awaitingRunout: false, deferRunout: options.deferRunout ?? false, deck, deckPosition: 0,
    currentBet: bigBlind, lastFullRaise: bigBlind, pending: [], actedAtBet: {}, toAct: null,
    finished: false, showdown: false, delta: null, history: [],
  }
  hand.boards = [hand.board]
  // Deal one card at a time, starting to the left of the button.
  for (let card = 0; card < 2; card++) {
    for (let offset = 1; offset <= players.length; offset++) {
      players[(dealerIndex + offset) % players.length].cards[card] = deck[hand.deckPosition++]
    }
  }
  pay(players[smallBlindIndex], smallBlind)
  pay(players[bigBlindIndex], bigBlind)
  hand.history.push(
    { playerId: hand.smallBlindId, street: 'preflop', kind: 'small-blind', amount: players[smallBlindIndex].streetBet, allin: players[smallBlindIndex].stack === 0 },
    { playerId: hand.bigBlindId, street: 'preflop', kind: 'big-blind', amount: players[bigBlindIndex].streetBet, allin: players[bigBlindIndex].stack === 0 },
  )
  for (const id of new Set(options.postedBlinds ?? [])) {
    const player = players.find(p => p.id === id)
    if (!player) throw new Error('自愿盲注玩家不在本手')
    const amount = Math.min(player.stack, Math.max(0, bigBlind - player.streetBet))
    if (amount > 0) {
      pay(player, amount)
      hand.history.push({ playerId: id, street: 'preflop', kind: 'entry-blind', amount, allin: player.stack === 0 })
    }
  }
  hand.pending = actionable(hand).map(player => player.id)
  players.forEach(player => { hand.actedAtBet[player.id] = null })
  advance(hand, bigBlindIndex)
  return hand
}

export function legalActions(hand: BattleHand, playerId: string): LegalActions | null {
  if (hand.finished || hand.toAct !== playerId) return null
  const player = hand.players.find(candidate => candidate.id === playerId)
  if (!player || player.folded || player.stack <= 0) return null
  const callAmount = Math.min(player.stack, Math.max(0, hand.currentBet - player.streetBet))
  const maxRaiseTo = player.streetBet + player.stack
  const previousAction = hand.actedAtBet[playerId]
  // Several short all-ins can cumulatively reopen action for an earlier caller.
  const reopened = previousAction === null || hand.currentBet - previousAction >= hand.lastFullRaise
  const opponentCanCall = actionable(hand).some(candidate => candidate.id !== playerId)
  const canRaise = reopened && opponentCanCall && maxRaiseTo > hand.currentBet
  return {
    canFold: true,
    canCheck: callAmount === 0,
    callAmount,
    minRaiseTo: canRaise ? Math.min(maxRaiseTo, hand.currentBet + hand.lastFullRaise) : null,
    maxRaiseTo,
  }
}

export function act(hand: BattleHand, playerId: string, action: BattleAction): void {
  const legal = legalActions(hand, playerId)
  if (!legal) throw new Error('现在不是你的行动轮次')
  if (!action || typeof action !== 'object') throw new Error('无效行动')
  const playerIndex = hand.players.findIndex(player => player.id === playerId)
  const player = hand.players[playerIndex]
  let amount = 0
  // Validate the entire action before mutating state.
  switch (action.kind) {
    case 'fold': break
    case 'check': if (!legal.canCheck) throw new Error('有未跟注的下注，不能过牌'); break
    case 'call': if (legal.callAmount <= 0) throw new Error('当前无需跟注，请过牌'); break
    case 'raise':
      if (legal.minRaiseTo === null || !halfChips(action.to) || action.to < legal.minRaiseTo || action.to > legal.maxRaiseTo) {
        throw new Error('加注金额无效，或本轮加注权尚未重新开放')
      }
      break
    default: throw new Error('无效行动')
  }
  hand.pending = hand.pending.filter(id => id !== playerId)
  if (action.kind === 'fold') player.folded = true
  if (action.kind === 'call') {
    amount = legal.callAmount
    pay(player, amount)
  }
  if (action.kind === 'raise') {
    const raiseBy = action.to - hand.currentBet
    amount = action.to
    pay(player, action.to - player.streetBet)
    if (raiseBy >= hand.lastFullRaise) hand.lastFullRaise = raiseBy
    hand.currentBet = action.to
    hand.pending = actionable(hand).filter(candidate => candidate.id !== playerId && candidate.streetBet < hand.currentBet).map(candidate => candidate.id)
  }
  hand.actedAtBet[playerId] = hand.currentBet
  hand.history.push({ playerId, street: hand.street, kind: action.kind, amount, allin: player.stack === 0 && action.kind !== 'fold' })
  advance(hand, playerIndex)
}

function nextStreet(hand: BattleHand): void {
  const streets = ['preflop', 'flop', 'turn', 'river'] as const
  hand.street = streets[streets.indexOf(hand.street) + 1]
  // Burn a card before each community-card deal.
  hand.deckPosition++
  const count = hand.street === 'flop' ? 3 : 1
  for (let i = 0; i < count; i++) hand.board.push(hand.deck[hand.deckPosition++])
  hand.boards = [hand.board]
  hand.currentBet = 0
  hand.lastFullRaise = hand.bigBlind ?? 1
  hand.players.forEach(player => {
    player.streetBet = 0
    hand.actedAtBet[player.id] = null
  })
  hand.pending = actionable(hand).map(player => player.id)
}

function advance(hand: BattleHand, after: number): void {
  if (live(hand).length === 1) {
    settle(hand, false)
    return
  }
  const actors = actionable(hand)
  hand.pending = hand.pending.filter(id => actors.some(player => player.id === id))
  if (actors.length <= 1) {
    const actor = actors[0]
    // A short all-in blind does not require an extra decision from a lone
    // opponent who has already matched every actual contribution.
    const actualBet = Math.max(...live(hand).map(player => player.streetBet))
    if (actor && actor.streetBet < actualBet && hand.pending.includes(actor.id)) {
      hand.toAct = actor.id
      return
    }
    if (hand.street !== 'river' && hand.deferRunout) {
      hand.awaitingRunout = true
      hand.toAct = null
      hand.pending = []
      return
    }
    while (hand.street !== 'river') nextStreet(hand)
    settle(hand, true)
    return
  }
  if (hand.pending.length === 0) {
    if (hand.street === 'river') {
      settle(hand, true)
      return
    }
    nextStreet(hand)
    hand.toAct = nextPlayer(hand, hand.dealerIndex, hand.pending)
    return
  }
  hand.toAct = nextPlayer(hand, after, hand.pending)
}

/** Deal each remaining board from the same deck, keeping the exposed prefix. */
export function resolveRunouts(hand: BattleHand, count: 1 | 2 | 3): void {
  if (!Number.isInteger(count) || count < 1 || count > 3) throw new Error('发牌次数必须为 1、2 或 3')
  if (hand.finished || !hand.awaitingRunout || hand.board.length >= 5) throw new Error('当前不需要选择发牌次数')
  const prefix = [...hand.board]
  const cardsPerRun = prefix.length === 0 ? 8 : prefix.length === 3 ? 4 : prefix.length === 4 ? 2 : 0
  if (!cardsPerRun || hand.deckPosition + cardsPerRun * count > hand.deck.length) throw new Error('剩余牌数不足')
  const boards: Card[][] = []
  for (let run = 0; run < count; run++) {
    const board = [...prefix]
    while (board.length < 5) {
      hand.deckPosition++ // Burn separately before each remaining street.
      const drawn = board.length === 0 ? 3 : 1
      for (let index = 0; index < drawn; index++) board.push(hand.deck[hand.deckPosition++])
    }
    boards.push(board)
  }
  hand.boards = boards
  hand.board = boards[0]
  hand.runCount = count
  hand.street = 'river'
  settle(hand, true)
}

function settle(hand: BattleHand, showdown: boolean): void {
  // Return uncalled chips before constructing pots, including an all-in overbet.
  const byInvestment = [...hand.players].sort((a, b) => b.totalBet - a.totalBet)
  const refund = byInvestment[0].totalBet - byInvestment[1].totalBet
  if (refund > 0) {
    const player = byInvestment[0]
    player.totalBet -= refund
    player.streetBet = Math.max(0, player.streetBet - refund)
    player.stack += refund
    hand.history.push({ playerId: player.id, street: hand.street, kind: 'refund', amount: refund })
  }
  if (!showdown) {
    live(hand)[0].stack += pot(hand)
  } else {
    const boards = hand.boards?.length ? hand.boards : [hand.board]
    hand.runResults = boards.map((board, index) => ({ run: index + 1, board: [...board], winners: [], payouts: {} }))
    const scores = boards.map(board => new Map(live(hand).map(player => [player.id, evaluate([...player.cards, ...board])])))
    // A folded contribution adds dead money; it does not create another side pot.
    // This matters when assigning a pot's odd chips across multiple boards.
    const levels = [...new Set(live(hand).map(player => player.totalBet).filter(amount => amount > 0))].sort((a, b) => a - b)
    let previousLevel = 0
    for (const level of levels) {
      const eligible = live(hand).filter(player => player.totalBet >= level)
      const chips = Math.round(hand.players.reduce((sum, player) => sum + Math.max(0, Math.min(player.totalBet, level) - previousLevel), 0) * 2)
      previousLevel = level
      if (eligible.length === 0) throw new Error('结算失败：底池没有合资格玩家')
      scores.forEach((boardScores, boardIndex) => {
        // Split every pot separately. An odd half-bb is assigned to the earliest board.
        const boardChips = Math.floor(chips / boards.length) + (boardIndex < chips % boards.length ? 1 : 0)
        const best = Math.max(...eligible.map(player => boardScores.get(player.id)!))
        const winners = eligible.filter(player => boardScores.get(player.id) === best)
        // Tied winners receive odd half-bb clockwise from the button.
        winners.sort((a, b) => {
          const distance = (player: BattlePlayer) => (hand.players.indexOf(player) - hand.dealerIndex - 1 + hand.players.length) % hand.players.length
          return distance(a) - distance(b)
        })
        const share = Math.floor(boardChips / winners.length)
        const remainder = boardChips % winners.length
        winners.forEach((player, index) => {
          const award = (share + (index < remainder ? 1 : 0)) / 2
          player.stack += award
          if (award > 0) {
            const result = hand.runResults![boardIndex]
            result.payouts[player.id] = (result.payouts[player.id] ?? 0) + award
            if (!result.winners.includes(player.id)) result.winners.push(player.id)
          }
        })
      })
    }
  }
  hand.finished = true
  hand.awaitingRunout = false
  hand.showdown = showdown
  hand.toAct = null
  hand.pending = []
  hand.delta = Object.fromEntries(hand.players.map(player => [player.id, player.stack - player.startingStack]))
}

export function handView(
  hand: BattleHand, viewerPlayerId: string, revealed: Record<string, number[]> = {}, autoShowIds: string[] = [],
): HandView {
  return {
    bigBlind: hand.bigBlind ?? 1, smallBlind: hand.smallBlind ?? 0.5,
    number: hand.number, street: hand.street, board: [...hand.board], pot: pot(hand),
    boards: (hand.boards?.length ? hand.boards : [hand.board]).map(board => [...board]),
    awaitingRunout: hand.awaitingRunout ?? false, runCount: hand.runCount ?? 1,
    dealerId: hand.players[hand.dealerIndex].id, smallBlindId: hand.smallBlindId, bigBlindId: hand.bigBlindId,
    toAct: hand.toAct, pendingPlayerIds: [...hand.pending], finished: hand.finished, showdown: hand.showdown,
    delta: hand.delta ? { ...hand.delta } : null,
    runResults: hand.runResults?.map(result => ({ ...result, board: [...result.board], winners: [...result.winners], payouts: { ...result.payouts } })),
    players: hand.players.map(player => ({
      id: player.id,
      cards: player.id === viewerPlayerId || (hand.finished && ((hand.showdown && !player.folded) || autoShowIds.includes(player.id)))
        ? [...player.cards] as [Card, Card]
        : hand.finished && revealed[player.id]?.some(index => index === 0 || index === 1)
          ? player.cards.map((card, index) => revealed[player.id].includes(index) ? card : null) as [Card | null, Card | null]
          : null,
      stack: player.stack, invested: player.totalBet, streetBet: player.streetBet,
      folded: player.folded, allin: player.stack === 0,
    })),
    legal: legalActions(hand, viewerPlayerId),
    history: hand.history.map(action => ({ ...action })),
  }
}

/** A heuristic practice opponent, not a GTO solver. It never reads opponents' cards or the live deck. */
export function chooseBotAction(hand: BattleHand, random: () => number = secureRandom): BattleAction {
  if (!hand.toAct) throw new Error('当前没有待行动玩家')
  const player = hand.players.find(candidate => candidate.id === hand.toAct)!
  const legal = legalActions(hand, player.id)!
  const opponents = live(hand).length - 1
  let strength: number
  if (hand.street === 'preflop') {
    const high = Math.max(rankOf(player.cards[0]), rankOf(player.cards[1]))
    const low = Math.min(rankOf(player.cards[0]), rankOf(player.cards[1]))
    strength = high === low
      ? 0.54 + high / 28
      : 0.18 + high / 38 + low / 80 + (suitOf(player.cards[0]) === suitOf(player.cards[1]) ? 0.07 : 0)
        + (high - low <= 2 ? 0.05 : 0)
  } else {
    // Sample unknown cards from the bot's information set, including folded cards.
    const known = new Set([...player.cards, ...hand.board])
    const unknown = fullDeck().filter(card => !known.has(card))
    let equity = 0
    const samples = 48
    for (let sample = 0; sample < samples; sample++) {
      const draw = shuffle([...unknown], random)
      const board = [...hand.board]
      while (board.length < 5) board.push(draw.pop()!)
      const score = evaluate([...player.cards, ...board])
      let ties = 1
      let won = true
      for (let opponent = 0; opponent < opponents; opponent++) {
        const theirs = evaluate([draw.pop()!, draw.pop()!, ...board])
        if (theirs > score) won = false
        if (theirs === score) ties++
      }
      if (won) equity += 1 / ties
    }
    strength = equity / samples
  }
  const odds = legal.callAmount / Math.max(0.5, pot(hand) + legal.callAmount)
  const roll = random()
  const aggressive = strength > (hand.street === 'preflop' ? 0.73 : 0.64) || (legal.canCheck && roll < 0.08)
  if (legal.minRaiseTo !== null && aggressive && roll < 0.68) {
    const target = hand.street === 'preflop'
      ? Math.max(3 * (hand.bigBlind ?? 1), hand.currentBet * 2.5)
      : hand.currentBet + Math.max(hand.bigBlind ?? 1, (pot(hand) + legal.callAmount) * 0.6)
    return { kind: 'raise', to: Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, Math.round(target * 2) / 2)) }
  }
  if (legal.canCheck) return { kind: 'check' }
  const margin = hand.street === 'preflop' && legal.callAmount > 10 * (hand.bigBlind ?? 1) ? 0.2 : 0.06
  return strength + (roll - 0.5) * 0.12 < odds + margin ? { kind: 'fold' } : { kind: 'call' }
}
