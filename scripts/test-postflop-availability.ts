import assert from 'node:assert/strict'
import { RangeTracker } from '../src/game/rangeTracker'
import { comboIndex, handIndex, parseCard, type Card } from '../src/poker/cards'
import { solvePostflop } from '../src/solver/postflop/cfr'
import { buildPostflopTree, type PostDecision } from '../src/solver/postflop/tree'
import type { PostflopPreset } from '../src/solver/config'

const cards = (value: string): Card[] => value.split(' ').map((card) => parseCard(card)!)
const combo = (value: string): number => {
  const [a, b] = cards(value)
  return comboIndex(a, b)
}
const singleCombo = (value: string): Float32Array => {
  const range = new Float32Array(1326)
  range[combo(value)] = 1
  return range
}
const preset: PostflopPreset = {
  betSizes: [0.66],
  raiseSizes: [],
  maxRaisesPerStreet: 0,
  iterations: { river: 12, turn: 12, flop: 12 },
  contBetSizes: [0.66],
  runoutSample: 12,
}
const row = (values: Float32Array, hand: number, actions: number): number[] =>
  Array.from(values.slice(hand * actions, (hand + 1) * actions))

// A zero-probability preflop deviation removes ATo from the tracked range. The
// actual dealt hand still exists, but no later solver row was computed for it.
{
  const board = cards('Td 6s Ts 2d')
  const tracker = new RangeTracker(2)
  const preflopStrategy = new Float32Array(169 * 2)
  for (let hand = 0; hand < 169; hand++) preflopStrategy[hand * 2] = 1
  preflopStrategy[handIndex('AKs') * 2] = 0
  preflopStrategy[handIndex('AKs') * 2 + 1] = 1
  tracker.applyPreflop(1, preflopStrategy, 2, 1)
  const ip = tracker.toCombos(1, board)
  const hero = combo('As Tc')
  assert.equal(ip[hero], 0)

  const tree = buildPostflopTree({ street: 'turn', board, pot: 38.3, stack: 81.6, preset })
  const solution = await solvePostflop(tree, singleCombo('Qc Qs'), ip)
  const node = (tree.root as PostDecision).children[0] as PostDecision
  assert.equal(node.actor, 1)
  assert.deepEqual(node.actions.map((action) => action.amount), [0, 25.3, 81.6])
  const A = node.actions.length
  assert.deepEqual(row(solution.avgStrategy.get(node.id)!, hero, A), [0, 0, 0])
  assert.ok(row(solution.evByAction.get(node.id)!, hero, A).every(Number.isNaN))

  const supported = combo('As Ks')
  const frequencies = row(solution.avgStrategy.get(node.id)!, supported, A)
  assert.ok(Math.abs(frequencies.reduce((sum, value) => sum + value, 0) - 1) < 1e-6)
  assert.ok(row(solution.evByAction.get(node.id)!, supported, A).every(Number.isFinite))
  console.log('✓ Off-range ATo retains unavailable EV; supported combos have normalized strategy and finite EV')
}

// Folding before investing on this street is a real 0 BB EV and must remain
// distinguishable from an uncomputed or undefined value.
{
  const board = cards('2c 3d 4h 7s 9c')
  const tree = buildPostflopTree({ street: 'river', board, pot: 10, stack: 10, preset })
  const solution = await solvePostflop(tree, singleCombo('Qs Qh'), singleCombo('As Ac'))
  const root = tree.root as PostDecision
  const facingBet = root.children[root.actions.findIndex((action) => action.kind === 'bet')] as PostDecision
  const A = facingBet.actions.length
  const hand = combo('As Ac')
  const values = row(solution.evByAction.get(facingBet.id)!, hand, A)
  assert.ok(values.every(Number.isFinite))
  assert.equal(Math.abs(values[facingBet.actions.findIndex((action) => action.kind === 'fold')]), 0)
  console.log('✓ Legitimate fold EV of 0 BB remains a finite value')
}

// Both input ranges are nonempty, but their only combos share a card. There is
// no compatible opponent for either hand, so conditional EV is unavailable.
{
  const board = cards('2c 3d 4h 7s 9c')
  const tree = buildPostflopTree({ street: 'river', board, pot: 10, stack: 10, preset })
  const solution = await solvePostflop(tree, singleCombo('As Ks'), singleCombo('As Qs'))
  const root = tree.root as PostDecision
  const values = row(solution.evByAction.get(root.id)!, combo('As Ks'), root.actions.length)
  assert.ok(values.every(Number.isNaN))
  console.log('✓ No compatible opponent range leaves conditional EV unavailable')
}

// An empty opponent range prunes entire evaluation branches. Their untouched
// arrays must retain the same missing marker as unsupported hand rows.
{
  const board = cards('2c 3d 4h 7s 9c')
  const tree = buildPostflopTree({ street: 'river', board, pot: 10, stack: 10, preset })
  const solution = await solvePostflop(tree, new Float32Array(1326), singleCombo('As Ac'))
  const node = (tree.root as PostDecision).children[0] as PostDecision
  assert.ok(row(solution.evByAction.get(node.id)!, combo('As Ac'), node.actions.length).every(Number.isNaN))
  console.log('✓ Pruned evaluation nodes retain unavailable EV')
}
