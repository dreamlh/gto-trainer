import assert from 'node:assert/strict'
import { parseCard } from '../src/poker/cards'
import { holeCardOrder } from '../src/poker/holeCardOrder'
import { evaluate } from '../src/poker/evaluator'
import { winningCards } from '../src/battle/winningCards'
import type { RoomView } from '../src/battle/types'

const cards = (text: string) => text.split(' ').map(card => parseCard(card)!)
const hole = (text: string) => cards(text) as [number, number]
function room(board: string, players: Record<string, string>, winners = Object.keys(players)): RoomView {
  return {
    settlementAt: null, runoutPlayback: null,
    hand: {
      number: 1, finished: true, showdown: true, board: cards(board), boards: [cards(board)],
      players: Object.entries(players).map(([id, hand]) => ({ id, cards: hole(hand), folded: false })),
      delta: Object.fromEntries(Object.keys(players).map(id => [id, 0])),
      runResults: [{ run: 1, board: cards(board), winners, payouts: Object.fromEntries(winners.map(id => [id, 10])) }],
    },
  } as RoomView
}
const sorted = (values: Iterable<number>) => [...values].sort((a, b) => a - b)

{
  const view = room('As Kd Qh 7c 2s', { winner: 'Ah Ac', loser: 'Kh Ks' }, ['winner'])
  const highlights = winningCards(view)
  assert.deepEqual(sorted(highlights.board), sorted(cards('As Kd Qh')))
  assert.deepEqual(sorted(highlights.hole.get('winner')!), sorted(cards('Ah Ac')))
  assert.equal(highlights.hole.has('loser'), false)
  assert.equal(highlights.hands[0].cards.length, 5)
  assert.equal(highlights.hands[0].score, evaluate([...view.hand!.board, ...hole('Ah Ac')]))
}
{
  const view = room('Ts Js Qs Ks As', { a: '2h 3d', b: '4c 5h' })
  const highlights = winningCards(view)
  assert.equal(highlights.board.size, 5, 'A shared royal flush plays the board')
  assert.equal(highlights.hole.get('a')!.size, 0)
  assert.equal(highlights.hole.get('b')!.size, 0)
  assert.equal(highlights.hands.length, 2, 'Both split-pot winners are represented independently')
}
{
  const view = room('As Kd Qh Jc Ts', { hero: 'Ah 2c' })
  const first = winningCards(view)
  assert.equal(first.board.size, 5, 'An equivalent hole ace does not replace the board ace')
  assert.equal(first.hole.get('hero')!.size, 0)
  view.hand!.players[0].cards!.reverse()
  view.hand!.runResults![0].board.reverse()
  assert.deepEqual(winningCards(view).hands, first.hands, 'Equivalent combinations are stable under display sorting')
}
{
  const view = room('As 2d 3h 4c Ks', { hero: '5h Qd' })
  const highlights = winningCards(view)
  assert.deepEqual(sorted(highlights.hands[0].cards), sorted(cards('As 2d 3h 4c 5h')), 'Wheel straights use ace low correctly')
}
{
  const view = room('As 2s 7s 8s Kd', { hero: 'Qs 3s' })
  const highlights = winningCards(view)
  assert.deepEqual(sorted(highlights.hands[0].cards), sorted(cards('As Qs 8s 7s 3s')), 'Six suited cards reduce to the strongest five')
}
{
  const view = room('As Kd Qh 7c 2s', { main: 'Ah Ac', side: 'Kh Ks' })
  view.hand!.delta = { main: 30, side: -20 }
  const highlights = winningCards(view)
  assert.deepEqual(highlights.hands.map(hand => hand.playerId), ['main', 'side'], 'Side-pot awards are winners even when net delta is negative')
  assert.ok(highlights.hands.every(hand => hand.cards.length === 5))
}
{
  const view = room('As Kd Qh 7c 2s', { hero: 'Ah Ac' })
  for (const hidden of [null, [parseCard('Ah'), null]]) {
    view.hand!.players[0].cards = hidden as [number | null, number | null] | null
    assert.equal(winningCards(view).hands.length, 0, 'Hidden or partially shown hole cards cannot expose an inferred winning hand')
    assert.equal(winningCards(view).board.size, 0)
  }
}
{
  const view = room('As Kd Qh 7c 2s', { hero: 'Ah Ac' })
  view.settlementAt = 100
  assert.equal(winningCards(view).hands.length, 0, 'The two-second settlement window never leaks the winner')
  view.settlementAt = null; view.hand!.finished = false
  assert.equal(winningCards(view).hands.length, 0, 'Unpublished active-hand results cannot highlight')
  view.hand!.finished = true; view.hand!.showdown = false
  assert.equal(winningCards(view).hands.length, 0, 'Uncontested pots have no winning-five showdown')
}
{
  const view = room('As Kd Qh 7c 2s', { a: 'Ah Ac', b: 'Kh Ks' }, ['a'])
  const second = { run: 2, board: cards('2h 3d 4c Kc 8s'), winners: ['b'], payouts: { b: 10 } }
  view.hand!.runResults!.push(second)
  view.hand!.finished = false
  view.runoutPlayback = { boardIndex: 1, revealedCount: 5, phase: 'settling', completedResults: [view.hand!.runResults![0]], nextRevealAt: 100 }
  assert.equal(winningCards(view, 1).hands.length, 0, 'Only completed public run results are considered, even if private data accidentally contains later results')
  assert.deepEqual(winningCards(view, 0).hands.map(hand => hand.playerId), ['a'])
  view.runoutPlayback.phase = 'result'; view.runoutPlayback.completedResults.push(second)
  assert.deepEqual(winningCards(view, 1).hands.map(hand => hand.playerId), ['b'], 'Reviewing another published run selects its own winners and board')
  assert.equal(winningCards(view, 2).hands.length, 0)
}

console.log('Winning-five checks passed: best-five ranks, deterministic ties, side pots, run selection and private/settling suppression.')

// Display sorting must preserve the original selective-reveal protocol indices.
const original = hole('2s Ah')
assert.deepEqual(holeCardOrder(original), [1, 0])
assert.deepEqual(holeCardOrder(hole('Ac 3h')), [0, 1])
assert.deepEqual(holeCardOrder(hole('As Ah')), [0, 1])
assert.deepEqual(holeCardOrder([original[0], null]), [0, 1], 'One revealed card must not move or reveal ordering of a hidden card')
assert.deepEqual(holeCardOrder([null, original[1]]), [0, 1])
assert.deepEqual(holeCardOrder(null), [0, 1])
assert.deepEqual(holeCardOrder(original).filter(index => [1].includes(index)), [1], 'Sorted left card reveals original index 1')
assert.deepEqual(original, hole('2s Ah'), 'Sorting never mutates server order')
console.log('Hole-card order: descending ranks, equal ranks, private partial cards and original reveal indices passed.')
