import assert from 'node:assert/strict'
import { fullDeck, parseCard, type Card } from '../src/poker/cards'
import { act, chooseBotAction, handView, legalActions, resolveRunouts, startHand, type BattleHand } from '../src/battle/game'
import type { BattleAction } from '../src/battle/types'
import { handStats } from '../src/battle/stats'

let checks = 0
function test(name: string, run: () => void) {
  run()
  checks++
  console.log(`✓ ${name}`)
}
function rng(seed: number) {
  return () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0
    return seed / 0x100000000
  }
}
function cards(text: string): Card[] {
  return text.split(' ').map(text => {
    const card = parseCard(text)
    assert.notEqual(card, null)
    return card!
  })
}
function deckFor(ids: string[], dealer: number, holes: Record<string, string>, board: string): Card[] {
  const dealt = ids.map(id => cards(holes[id]))
  const community = cards(board)
  const known = [...dealt.flat(), ...community]
  assert.equal(new Set(known).size, known.length)
  const rest = fullDeck().filter(card => !known.includes(card))
  const deck: Card[] = []
  for (let round = 0; round < 2; round++) {
    for (let offset = 1; offset <= ids.length; offset++) deck.push(dealt[(dealer + offset) % ids.length][round])
  }
  deck.push(rest.shift()!, ...community.slice(0, 3), rest.shift()!, community[3], rest.shift()!, community[4], ...rest)
  return deck
}
function deckForRunouts(ids: string[], dealer: number, holes: Record<string, string>, boardTexts: string[], prefixLength = 0): Card[] {
  const dealt = ids.map(id => cards(holes[id]))
  const boards = boardTexts.map(cards)
  const prefix = boards[0].slice(0, prefixLength)
  boards.forEach(board => assert.deepEqual(board.slice(0, prefixLength), prefix))
  const known = [...dealt.flat(), ...prefix, ...boards.flatMap(board => board.slice(prefixLength))]
  assert.equal(new Set(known).size, known.length)
  const rest = fullDeck().filter(card => !known.includes(card))
  const deck: Card[] = []
  for (let round = 0; round < 2; round++) {
    for (let offset = 1; offset <= ids.length; offset++) deck.push(dealt[(dealer + offset) % ids.length][round])
  }
  if (prefixLength >= 3) deck.push(rest.shift()!, ...prefix.slice(0, 3))
  if (prefixLength >= 4) deck.push(rest.shift()!, prefix[3])
  for (const board of boards) {
    if (prefixLength === 0) deck.push(rest.shift()!, ...board.slice(0, 3))
    if (prefixLength < 4) deck.push(rest.shift()!, board[3])
    deck.push(rest.shift()!, board[4])
  }
  return [...deck, ...rest]
}
function checkUntil(hand: BattleHand, street: BattleHand['street']) {
  while (hand.street !== street) {
    const legal = legalActions(hand, hand.toAct!)!
    act(hand, hand.toAct!, { kind: legal.canCheck ? 'check' : 'call' })
  }
}
function runoutCardsAreUnique(hand: BattleHand, prefixLength: number) {
  hand.boards.forEach(board => {
    assert.equal(board.length, 5)
    assert.deepEqual(board.slice(0, prefixLength), hand.board.slice(0, prefixLength))
  })
  const dealt = [
    ...hand.players.flatMap(player => player.cards), ...hand.board.slice(0, prefixLength),
    ...hand.boards.flatMap(board => board.slice(prefixLength)),
  ]
  assert.equal(new Set(dealt).size, dealt.length)
}
function passive(hand: BattleHand) {
  for (let steps = 0; !hand.finished; steps++) {
    assert.ok(steps < 100)
    const legal = legalActions(hand, hand.toAct!)!
    act(hand, hand.toAct!, { kind: legal.canCheck ? 'check' : 'call' })
  }
}
function chips(hand: BattleHand) {
  const initial = hand.players.reduce((sum, player) => sum + player.startingStack, 0)
  const actual = hand.players.reduce((sum, player) => sum + player.stack + (hand.finished ? 0 : player.totalBet), 0)
  assert.equal(actual, initial, 'all chips are conserved')
  for (const player of hand.players) {
    assert.ok(player.stack >= 0)
    assert.ok(player.totalBet >= 0)
    assert.equal(player.stack * 2, Math.round(player.stack * 2))
  }
  if (hand.finished) assert.equal(Object.values(hand.delta!).reduce((sum, delta) => sum + delta, 0), 0)
  if (hand.finished && hand.showdown) {
    assert.equal(hand.runResults!.length, hand.boards.length)
    for (const player of hand.players) {
      const awarded = hand.runResults!.reduce((sum, result) => sum + (result.payouts[player.id] ?? 0), 0)
      assert.equal(awarded, player.stack - player.startingStack + player.totalBet, 'per-run awards reconstruct the final bankroll including side pots and refunds')
    }
    hand.runResults!.forEach((result, index) => {
      assert.equal(result.run, index + 1)
      assert.deepEqual(result.board, hand.boards[index])
      assert.deepEqual([...result.winners].sort(), Object.keys(result.payouts).sort())
    })
  }
}

test('configured blinds scale forced bets, live entry credit and preflop/postflop minimum raises', () => {
  const hand = startHand(['a', 'b', 'c', 'd'], 0, 1, { bigBlind: 6, smallBlind: 3, postedBlinds: ['c', 'd'] })
  assert.equal(hand.players[1].streetBet, 3)
  assert.equal(hand.players[2].streetBet, 6, 'Big blind is never posted twice')
  assert.equal(hand.players[3].streetBet, 6)
  assert.equal(handView(hand, 'd').bigBlind, 6)
  assert.equal(handView(hand, 'd').smallBlind, 3)
  assert.equal(legalActions(hand, 'd')!.canCheck, true)
  assert.equal(legalActions(hand, 'd')!.minRaiseTo, 12)
  checkUntil(hand, 'flop')
  assert.equal(legalActions(hand, hand.toAct!)!.minRaiseTo, 6)
  passive(hand)
  chips(hand)
  assert.throws(() => startHand(['a', 'b'], 0, 1, { bigBlind: 2, smallBlind: 3 }))
  assert.throws(() => startHand(['a', 'b'], 0, 1, { bigBlind: 0 }))
})

test('blinds above remaining stacks never create or destroy tournament chips', () => {
  const hand = startHand(['a', 'b'], 0, 1, { stacks: { a: 20, b: 5 }, bigBlind: 60, smallBlind: 30, deferRunout: true })
  assert.equal(hand.awaitingRunout, true)
  assert.equal(hand.players[0].stack, 0)
  assert.equal(hand.players[1].stack, 0)
  resolveRunouts(hand, 3)
  assert.equal(handView(hand, 'a').pot, 10)
  assert.equal(hand.history.find(action => action.kind === 'refund')!.amount, 15)
  chips(hand)
})

test('heads-up button posts small blind, acts first preflop and last postflop', () => {
  const hand = startHand(['a', 'b'], 0, 1)
  assert.equal(hand.smallBlindId, 'a')
  assert.equal(hand.bigBlindId, 'b')
  assert.equal(hand.toAct, 'a')
  assert.equal(hand.players[0].stack, 99.5)
  act(hand, 'a', { kind: 'call' })
  assert.equal(hand.toAct, 'b')
  assert.equal(legalActions(hand, 'b')!.canCheck, true)
  act(hand, 'b', { kind: 'check' })
  assert.equal(hand.street, 'flop')
  assert.equal(hand.toAct, 'b')
  assert.equal(hand.board.length, 3)
  passive(hand)
  assert.equal(hand.board.length, 5)
  assert.equal(hand.showdown, true)
  chips(hand)
})

test('entry blind is live credit, never doubles the big blind, and does not count as VPIP', () => {
  const hand = startHand(['a', 'b', 'c', 'd'], 0, 1, { random: rng(871), postedBlinds: ['a', 'a', 'b', 'c'] })
  assert.deepEqual(hand.players.map(p => p.streetBet), [1, 1, 1, 0])
  assert.deepEqual(hand.history.filter(a => a.kind === 'entry-blind').map(a => [a.playerId, a.amount]), [['a', 1], ['b', 0.5]])
  assert.equal(handView(hand, 'a').pot, 3)
  act(hand, 'd', { kind: 'fold' })
  assert.equal(hand.toAct, 'a')
  assert.equal(legalActions(hand, 'a')!.callAmount, 0)
  assert.equal(legalActions(hand, 'a')!.canCheck, true)
  assert.equal(legalActions(hand, 'a')!.minRaiseTo, 2)
  passive(hand)
  for (const id of ['a', 'b', 'c']) {
    assert.equal(handStats(handView(hand, id), id).vpip, 0)
    assert.equal(handStats(handView(hand, id), id).pfr, 0)
  }
  chips(hand)
})

test('2–9 players and each rotated button produce correct blinds and action order', () => {
  for (let count = 2; count <= 9; count++) {
    const ids = Array.from({ length: count }, (_, index) => `p${index}`)
    for (let dealer = 0; dealer < count; dealer++) {
      const hand = startHand(ids, dealer, dealer + 1, { random: rng(count * 10 + dealer) })
      assert.equal(hand.smallBlindId, ids[(dealer + (count === 2 ? 0 : 1)) % count])
      assert.equal(hand.bigBlindId, ids[(dealer + (count === 2 ? 1 : 2)) % count])
      assert.equal(hand.toAct, ids[(dealer + (count === 2 ? 0 : 3)) % count])
      while (hand.street === 'preflop') {
        const legal = legalActions(hand, hand.toAct!)!
        act(hand, hand.toAct!, { kind: legal.canCheck ? 'check' : 'call' })
      }
      assert.equal(hand.toAct, ids[(dealer + 1) % count])
      passive(hand)
      chips(hand)
    }
  }
  assert.throws(() => startHand(['a'], 0, 1))
  assert.throws(() => startHand(['a', 'a'], 0, 1))
})

test('invalid, out-of-turn, fractional, and undersized actions leave state unchanged', () => {
  const hand = startHand(['a', 'b', 'c'], 0, 1, { random: rng(1) })
  const before = JSON.stringify(hand)
  assert.throws(() => act(hand, 'b', { kind: 'call' }))
  assert.throws(() => act(hand, 'a', { kind: 'check' }))
  for (const to of [1, 1.5, 2.1, 100.5, NaN, Infinity]) assert.throws(() => act(hand, 'a', { kind: 'raise', to }))
  assert.throws(() => act(hand, 'a', { kind: 'unknown' } as unknown as BattleAction))
  assert.equal(JSON.stringify(hand), before)
  act(hand, 'a', { kind: 'raise', to: 3 })
  assert.equal(legalActions(hand, 'b')!.minRaiseTo, 5)
  act(hand, 'b', { kind: 'raise', to: 8 })
  assert.equal(legalActions(hand, 'c')!.minRaiseTo, 13)
  passive(hand)
  chips(hand)
})

test('fold ends immediately, returns uncalled chips, and does not reveal winner cards', () => {
  const hand = startHand(['a', 'b'], 0, 1, { random: rng(3) })
  act(hand, 'a', { kind: 'fold' })
  assert.equal(hand.finished, true)
  assert.equal(hand.showdown, false)
  assert.deepEqual(hand.delta, { a: -0.5, b: 0.5 })
  assert.equal(handView(hand, 'a').pot, 1)
  assert.equal(handView(hand, 'a').players[1].cards, null)
  assert.equal(hand.history.at(-1)!.kind, 'refund')
  chips(hand)
})

test('all-in ties split the pot without losing any chips', () => {
  const ids = ['a', 'b', 'c']
  const deck = deckFor(ids, 0, { a: '2h 3h', b: '4d 5d', c: '6c 7c' }, 'Ts Js Qs Ks As')
  const hand = startHand(ids, 0, 1, { deck })
  act(hand, 'a', { kind: 'raise', to: 100 })
  act(hand, 'b', { kind: 'call' })
  assert.equal(legalActions(hand, 'c')!.minRaiseTo, null)
  act(hand, 'c', { kind: 'call' })
  assert.equal(hand.finished, true)
  assert.equal(hand.showdown, true)
  assert.deepEqual(hand.delta, { a: 0, b: 0, c: 0 })
  assert.equal(handView(hand, 'observer').players.filter(player => player.cards).length, 3)
  chips(hand)
})

test('all-in overbet refund and side pots award only eligible hands', () => {
  const ids = ['a', 'b', 'c']
  const deck = deckFor(ids, 0, { a: 'Qc Qd', b: 'Ah Ad', c: 'Kc Kd' }, '2s 4h 7d 9c Js')
  const hand = startHand(ids, 0, 1, { deck, stacks: { a: 100, b: 20, c: 50 } })
  act(hand, 'a', { kind: 'raise', to: 100 })
  act(hand, 'b', { kind: 'call' })
  act(hand, 'c', { kind: 'call' })
  assert.deepEqual(hand.delta, { a: -50, b: 40, c: 10 })
  assert.equal(handView(hand, 'a').pot, 120)
  assert.equal(hand.players[0].stack, 50)
  assert.equal(hand.history.find(action => action.kind === 'refund')!.amount, 50)
  chips(hand)
})

test('odd half-bb in a split pot goes clockwise from the button; folded cards stay hidden', () => {
  const ids = ['a', 'b', 'c']
  const deck = deckFor(ids, 0, { a: '2h 3h', b: '4d 5d', c: '6c 7c' }, 'Ts Js Qs Ks As')
  const hand = startHand(ids, 0, 1, { deck })
  act(hand, 'a', { kind: 'raise', to: 2 })
  act(hand, 'b', { kind: 'fold' })
  act(hand, 'c', { kind: 'call' })
  passive(hand)
  assert.deepEqual(hand.delta, { a: 0, b: -0.5, c: 0.5 })
  assert.equal(handView(hand, 'a').players[1].cards, null)
  assert.ok(handView(hand, 'a').players[2].cards)
  chips(hand)
})

test('one short all-in does not reopen raising for a prior bettor or caller', () => {
  const hand = startHand(['a', 'b', 'c', 'd'], 1, 1, { random: rng(2), stacks: { c: 14 } })
  act(hand, 'a', { kind: 'raise', to: 10 })
  act(hand, 'b', { kind: 'call' })
  assert.equal(legalActions(hand, 'c')!.minRaiseTo, 14)
  act(hand, 'c', { kind: 'raise', to: 14 })
  assert.equal(legalActions(hand, 'd')!.minRaiseTo, 23)
  act(hand, 'd', { kind: 'call' })
  assert.equal(legalActions(hand, 'a')!.minRaiseTo, null)
  assert.throws(() => act(hand, 'a', { kind: 'raise', to: 23 }))
  act(hand, 'a', { kind: 'call' })
  assert.equal(legalActions(hand, 'b')!.minRaiseTo, null)
  passive(hand)
  chips(hand)
})

test('multiple short all-ins reopen only for players facing a full cumulative raise', () => {
  const hand = startHand(['a', 'b', 'c', 'd', 'e'], 2, 1, { random: rng(2), stacks: { c: 14, e: 19 } })
  act(hand, 'a', { kind: 'raise', to: 10 })
  act(hand, 'b', { kind: 'call' })
  act(hand, 'c', { kind: 'raise', to: 14 })
  act(hand, 'd', { kind: 'call' })
  act(hand, 'e', { kind: 'raise', to: 19 })
  assert.equal(legalActions(hand, 'a')!.minRaiseTo, 28)
  act(hand, 'a', { kind: 'call' })
  assert.equal(legalActions(hand, 'b')!.minRaiseTo, 28)
  act(hand, 'b', { kind: 'call' })
  assert.equal(legalActions(hand, 'd')!.minRaiseTo, null)
  passive(hand)
  chips(hand)
})

test('short opening all-in requires a full minimum raise on top, not a completion', () => {
  const hand = startHand(['a', 'b', 'c', 'd'], 0, 1, { random: rng(21), stacks: { b: 1.5 } })
  while (hand.street === 'preflop') {
    const legal = legalActions(hand, hand.toAct!)!
    act(hand, hand.toAct!, { kind: legal.canCheck ? 'check' : 'call' })
  }
  assert.equal(hand.toAct, 'b')
  assert.equal(legalActions(hand, 'b')!.minRaiseTo, 0.5)
  act(hand, 'b', { kind: 'raise', to: 0.5 })
  assert.equal(legalActions(hand, 'c')!.minRaiseTo, 1.5)
  assert.throws(() => act(hand, 'c', { kind: 'raise', to: 1 }))
  passive(hand)
  chips(hand)
})

test('matched heads-up short blind automatically runs out without a spurious fold decision', () => {
  const hand = startHand(['a', 'b'], 0, 1, { random: rng(34), stacks: { b: 0.5 } })
  assert.equal(hand.finished, true)
  assert.equal(hand.showdown, true)
  assert.equal(handView(hand, 'a').pot, 1)
  chips(hand)
})

test('public snapshots never expose deck or opponents before showdown and cannot mutate state', () => {
  const hand = startHand(['a', 'b', 'c'], 0, 1, { random: rng(4) })
  const view = handView(hand, 'a')
  assert.equal('deck' in view, false)
  assert.equal('deckPosition' in view, false)
  assert.deepEqual(view.players.map(player => player.cards === null), [false, true, true])
  assert.equal(handView(hand, 'outsider').players.every(player => player.cards === null), true)
  assert.equal(handView(hand, 'b').legal, null)
  view.players[0].cards![0] = -1
  view.history[0].amount = -1
  view.board.push(-1)
  assert.notEqual(hand.players[0].cards[0], -1)
  assert.notEqual(hand.history[0].amount, -1)
  assert.equal(hand.board.length, 0)
})

test('bot decisions depend only on its own cards, public cards and public bets', () => {
  const hand = startHand(['a', 'b', 'c'], 0, 1, { random: rng(71) })
  while (hand.street === 'preflop') {
    const legal = legalActions(hand, hand.toAct!)!
    act(hand, hand.toAct!, { kind: legal.canCheck ? 'check' : 'call' })
  }
  const changed = JSON.parse(JSON.stringify(hand)) as BattleHand
  changed.players.filter(player => player.id !== changed.toAct).forEach(player => { player.cards = [50, 51] })
  changed.deck.reverse()
  assert.deepEqual(chooseBotAction(hand, rng(198)), chooseBotAction(changed, rng(198)))
})

test('all-in runout waits for the final call, then splits main and side pots across independent boards', () => {
  const ids = ['a', 'b', 'c']
  const boards = ['2s 4h 7d 9c Js', 'Qh 3c 6d 8s Ts']
  const deck = deckForRunouts(ids, 0, { a: 'Qc Qd', b: 'Ah Ad', c: 'Kc Kd' }, boards)
  const hand = startHand(ids, 0, 1, { deck, stacks: { a: 100, b: 20, c: 50 }, deferRunout: true })
  const before = JSON.stringify(hand)
  assert.throws(() => resolveRunouts(hand, 2))
  assert.equal(JSON.stringify(hand), before)
  act(hand, 'a', { kind: 'raise', to: 100 })
  act(hand, 'b', { kind: 'call' })
  assert.equal(hand.awaitingRunout, false)
  assert.equal(hand.toAct, 'c')
  act(hand, 'c', { kind: 'call' })
  assert.equal(hand.awaitingRunout, true)
  assert.equal(hand.finished, false)
  assert.equal(hand.toAct, null)
  assert.deepEqual(hand.pending, [])
  assert.deepEqual(handView(hand, 'observer').boards, [[]])
  assert.ok(handView(hand, 'observer').players.every(player => player.cards === null))
  const paused = JSON.stringify(hand)
  assert.throws(() => resolveRunouts(hand, 4 as 1))
  assert.equal(JSON.stringify(hand), paused)
  resolveRunouts(hand, 2)
  assert.deepEqual(hand.boards, boards.map(cards))
  assert.equal(hand.runCount, 2)
  assert.equal(hand.finished, true)
  assert.equal(hand.awaitingRunout, false)
  assert.deepEqual(hand.delta, { a: 10, b: 10, c: -20 })
  assert.equal(hand.history.find(action => action.kind === 'refund')!.amount, 50)
  assert.equal(handView(hand, 'observer').pot, 120)
  assert.deepEqual(hand.runResults!.map(result => result.payouts), [{ b: 30, c: 30 }, { a: 60 }])
  runoutCardsAreUnique(hand, 0)
  chips(hand)
  const completed = JSON.stringify(hand)
  assert.throws(() => resolveRunouts(hand, 1))
  assert.equal(JSON.stringify(hand), completed)
})

test('three runouts can award a different winner on each board', () => {
  const ids = ['a', 'b', 'c']
  const boards = ['2c 3h 7d 9s Js', 'Kh 2s 4h 6d Ts', 'Qh 3c 5h 8d Tc']
  const deck = deckForRunouts(ids, 0, { a: 'Ac Ad', b: 'Kc Kd', c: 'Qc Qd' }, boards)
  const hand = startHand(ids, 0, 1, { deck, stacks: { a: 2.5, b: 2.5, c: 2.5 }, deferRunout: true })
  act(hand, 'a', { kind: 'raise', to: 2.5 })
  act(hand, 'b', { kind: 'call' })
  act(hand, 'c', { kind: 'call' })
  resolveRunouts(hand, 3)
  assert.deepEqual(hand.boards, boards.map(cards))
  assert.deepEqual(hand.delta, { a: 0, b: 0, c: 0 })
  assert.deepEqual(hand.runResults!.map(result => result.winners), [['a'], ['b'], ['c']])
  runoutCardsAreUnique(hand, 0)
  chips(hand)
})

test('shared flop runouts split true main/side pots and assign tied odd half-bb deterministically', () => {
  const ids = ['a', 'b', 'c', 'd']
  const boards = ['2s 2h 2d 2c Kc', '2s 2h 2d 3c 3h', '2s 2h 2d 4c 4h']
  const deck = deckForRunouts(ids, 2, { a: 'Ac Ad', b: 'Ah As', c: 'Qc Qd', d: 'Jc Jd' }, boards, 3)
  const hand = startHand(ids, 2, 1, { deck, stacks: { a: 10, b: 4.5, c: 3, d: 100 }, deferRunout: true })
  act(hand, 'b', { kind: 'call' })
  act(hand, 'c', { kind: 'call' })
  act(hand, 'd', { kind: 'fold' })
  act(hand, 'a', { kind: 'check' })
  assert.equal(hand.street, 'flop')
  act(hand, 'a', { kind: 'check' })
  act(hand, 'b', { kind: 'raise', to: 3.5 })
  act(hand, 'c', { kind: 'call' })
  act(hand, 'a', { kind: 'call' })
  assert.equal(hand.awaitingRunout, true)
  resolveRunouts(hand, 3)
  // Main pot 9.5bb: 3.5/3/3; side pot 3bb: 1/1/1. A wins the tied odd chip.
  assert.deepEqual(hand.delta, { a: 2, b: 1.5, c: -3, d: -0.5 })
  assert.equal(handView(hand, 'observer').pot, 12.5)
  runoutCardsAreUnique(hand, 3)
  chips(hand)
})

test('turn runouts preserve the four exposed cards after server-state serialization', () => {
  const ids = ['a', 'b']
  const boards = ['2c 3d 7h 9s Jh', '2c 3d 7h 9s Kh', '2c 3d 7h 9s Qh']
  const deck = deckForRunouts(ids, 0, { a: 'Ac Ad', b: 'Kc Kd' }, boards, 4)
  let hand = startHand(ids, 0, 1, { deck, deferRunout: true })
  checkUntil(hand, 'flop')
  hand = JSON.parse(JSON.stringify(hand)) as BattleHand
  checkUntil(hand, 'turn')
  assert.deepEqual(handView(hand, 'a').boards, [boards.map(cards)[0].slice(0, 4)])
  act(hand, 'b', { kind: 'raise', to: 99 })
  act(hand, 'a', { kind: 'call' })
  hand = JSON.parse(JSON.stringify(hand)) as BattleHand
  resolveRunouts(hand, 3)
  assert.deepEqual(hand.boards, boards.map(cards))
  // 400 half-bb split as 134/133/133: A wins boards 1 and 3, B board 2.
  assert.deepEqual(hand.delta, { a: 33.5, b: -33.5 })
  runoutCardsAreUnique(hand, 4)
  const view = handView(hand, 'observer')
  view.boards[1][4] = -1
  assert.notEqual(hand.boards[1][4], -1)
  chips(hand)
})

test('river all-ins settle immediately, while a matched short blind can select a runout', () => {
  const hand = startHand(['a', 'b'], 0, 1, { random: rng(501), deferRunout: true })
  checkUntil(hand, 'river')
  act(hand, 'b', { kind: 'raise', to: 99 })
  act(hand, 'a', { kind: 'call' })
  assert.equal(hand.finished, true)
  assert.equal(hand.awaitingRunout, false)
  assert.equal(hand.runCount, 1)
  chips(hand)
  const short = startHand(['a', 'b'], 0, 1, { random: rng(502), stacks: { b: 0.5 }, deferRunout: true })
  assert.equal(short.awaitingRunout, true)
  resolveRunouts(short, 1)
  assert.equal(short.finished, true)
  assert.equal(handView(short, 'observer').pot, 1)
  chips(short)
})

test('voluntary reveal exposes only selected cards after the hand; bots can show folded cards', () => {
  const hand = startHand(['a', 'b'], 0, 1, { random: rng(601) })
  const early = handView(hand, 'observer', { a: [0], b: [0, 1] }, ['a', 'b'])
  assert.ok(early.players.every(player => player.cards === null))
  act(hand, 'a', { kind: 'fold' })
  const one = handView(hand, 'observer', { a: [0], b: [1] })
  assert.deepEqual(one.players[0].cards, [hand.players[0].cards[0], null])
  assert.deepEqual(one.players[1].cards, [null, hand.players[1].cards[1]])
  const bot = handView(hand, 'observer', {}, ['a'])
  assert.deepEqual(bot.players[0].cards, hand.players[0].cards)
  assert.equal(bot.players[1].cards, null)
  assert.equal(handView(hand, 'observer', { a: [2, -1] }).players[0].cards, null)
  assert.deepEqual(handView(hand, 'observer', { b: [0, 1] }).players[1].cards, hand.players[1].cards)
  const mandatory = startHand(['a', 'b'], 0, 1, { random: rng(602) })
  passive(mandatory)
  assert.ok(handView(mandatory, 'observer', { a: [0] }).players.every(player => player.cards?.every(card => card !== null)))
})

test('2–9 player all-ins support all run counts with unique cards and conserve unequal stacks', () => {
  for (let seed = 1; seed <= 750; seed++) {
    const random = rng(seed + 10000)
    const count = 2 + seed % 8
    const ids = Array.from({ length: count }, (_, index) => `p${index}`)
    const stacks = Object.fromEntries(ids.map(id => [id, 1 + Math.floor(random() * 80) / 2]))
    const hand = startHand(ids, seed % count, seed, { random, stacks, deferRunout: true })
    while (!hand.awaitingRunout && !hand.finished) {
      const legal = legalActions(hand, hand.toAct!)!
      act(hand, hand.toAct!, legal.minRaiseTo !== null ? { kind: 'raise', to: legal.maxRaiseTo } : { kind: legal.canCheck ? 'check' : 'call' })
      chips(hand)
    }
    assert.equal(hand.awaitingRunout, true)
    const prefixLength = hand.board.length
    resolveRunouts(hand, (1 + seed % 3) as 1 | 2 | 3)
    runoutCardsAreUnique(hand, prefixLength)
    chips(hand)
  }
})

test('2,500 randomized hands preserve chips, legal turn order, privacy and finish', () => {
  for (let seed = 1; seed <= 2500; seed++) {
    const random = rng(seed)
    const count = 2 + Math.floor(random() * 8)
    const ids = Array.from({ length: count }, (_, index) => `p${index}`)
    const stacks = Object.fromEntries(ids.map(id => [id, 0.5 + Math.floor(random() * 200) / 2]))
    const hand = startHand(ids, Math.floor(random() * count), seed, { random, stacks })
    chips(hand)
    for (let steps = 0; !hand.finished; steps++) {
      assert.ok(steps < 2000, `hand ${seed} did not complete`)
      assert.ok(hand.toAct)
      const legal = legalActions(hand, hand.toAct!)!
      assert.ok(legal)
      const roll = random()
      let action: BattleAction
      if (roll < 0.1) action = { kind: 'fold' }
      else if (roll < 0.45 && legal.minRaiseTo !== null) {
        const steps = (legal.maxRaiseTo - legal.minRaiseTo) * 2
        action = { kind: 'raise', to: legal.minRaiseTo + Math.floor(random() * (steps + 1)) / 2 }
      } else action = { kind: legal.canCheck ? 'check' : 'call' }
      act(hand, hand.toAct!, action)
      chips(hand)
      const view = handView(hand, ids[0])
      if (!hand.finished) assert.ok(view.players.slice(1).every(player => player.cards === null))
      assert.equal(new Set([...hand.players.flatMap(player => player.cards), ...hand.board]).size, count * 2 + hand.board.length)
    }
  }
})

test('heuristic bots complete 100 entire mixed-size tables legally', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const random = rng(9000 + seed)
    const ids = Array.from({ length: 2 + seed % 8 }, (_, index) => `p${index}`)
    const hand = startHand(ids, seed % ids.length, seed, { random })
    for (let steps = 0; !hand.finished; steps++) {
      assert.ok(steps < 2000)
      act(hand, hand.toAct!, chooseBotAction(hand, random))
      chips(hand)
    }
  }
})

console.log(`\n${checks} battle engine tests passed.`)
