import assert from 'node:assert/strict'
import { normalizeDecisionRecord } from '../src/game/decisionQuality'
import { TrainerSession, type DecisionRecord, type HandRecord, type SessionSnapshot } from '../src/game/session'
import { newHand } from '../src/game/engine'
import { comboIndex, parseCard } from '../src/poker/cards'
import { buildPostflopTree, type PostDecision } from '../src/solver/postflop/tree'
import { POSTFLOP_PRESETS } from '../src/solver/config'
import type { WorkerNode } from '../src/workers/workerClient'
import { saveHand, listHands } from '../src/db/handStore'

const legacy: DecisionRecord = {
  street: 'turn', pos: 'UTG1', labels: ['过牌', '下注 25.3', '全下 81.6'],
  kinds: ['check', 'bet', 'bet'], freqs: [0, 0, 0], evs: [0, 0, 0],
  chosen: 2, evLoss: 0, score: 100, verdict: 'optimal',
}
const unavailable = normalizeDecisionRecord(legacy)
assert.equal(unavailable.verdict, 'unavailable')
assert.deepEqual(unavailable.freqs, [])
assert.equal(unavailable.evs, null)
assert.equal(unavailable.evLoss, null)
assert.equal(unavailable.score, null)
assert.equal(legacy.verdict, 'optimal', 'normalization must not mutate saved history')

for (const freqs of [[], [1], [0.1, 0.1, 0.1], [-0.1, 0.5, 0.6], [NaN, 0, 1], [Infinity, 0, 0]]) {
  assert.equal(normalizeDecisionRecord({ ...legacy, freqs }).verdict, 'unavailable')
}
const zeroEv = normalizeDecisionRecord({ ...legacy, freqs: [.25, .25, .5] })
assert.equal(zeroEv.verdict, 'optimal', 'real zero EVs with valid probabilities are allowed')
assert.equal(zeroEv.evLoss, 0)
assert.deepEqual(zeroEv.evs, [0, 0, 0])
for (const evs of [null, [], [0, 1], [0, NaN, 1], [0, Infinity, 1]]) {
  const result = normalizeDecisionRecord({ ...legacy, freqs: [.8, .2, 0], evs })
  assert.equal(result.evs, null)
  assert.equal(result.evLoss, null)
  assert.equal(result.verdict, 'wrong', 'missing EV uses real strategy, not a zero-loss verdict')
}
const drift = normalizeDecisionRecord({ ...legacy, freqs: [.1, .2, .70000001], evs: [2, 3, 4] })
assert.ok(Math.abs(drift.freqs.reduce((a, b) => a + b, 0) - 1) < 1e-12)
assert.equal(drift.score, 100)
assert.equal(drift.evLoss, 0)
assert.equal(normalizeDecisionRecord({ ...legacy, chosen: 3, freqs: [.1, .2, .7] }).verdict, 'unavailable')

// Exercise the real session's recording boundary against worker-style arrays.
const board = 'Td 6s Ts 2d'.split(' ').map(card => parseCard(card)!)
const engine = newHand(2)
engine.street = 'turn'; engine.board = board
engine.players[0].cards = [parseCard('As')!, parseCard('Tc')!]
const tree = buildPostflopTree({ street: 'turn', board, pot: 38.3, stack: 81.6, preset: POSTFLOP_PRESETS.trainer })
const node = tree.decisionNodes.find(item => item.actor === 1 && item.actions.some(action => action.kind === 'check'))!
assert.ok(node)
const session = new TrainerSession()
const state = session as unknown as {
  engine: typeof engine; postNodes: Map<number, WorkerNode>
  update: (patch: Partial<SessionSnapshot>) => void
  recordPostflopDecision: (node: PostDecision, chosen: number) => void
}
state.engine = engine
state.update({ heroSeat: 0 })
const row = new Float32Array(1326 * node.actions.length)
state.postNodes = new Map([[node.id, { ...node, strategy: row, ev: row.slice() }]])
state.recordPostflopDecision(node, 0)
assert.equal(session.getSnapshot().lastDecision?.verdict, 'unavailable')
state.postNodes.clear()
state.recordPostflopDecision(node, 0)
assert.deepEqual(session.getSnapshot().lastDecision?.freqs, [], 'missing nodes must not fabricate uniform strategy')
const combo = comboIndex(...engine.players[0].cards)
row[combo * node.actions.length] = 1
state.postNodes.set(node.id, { ...node, strategy: row, ev: new Float32Array(row.length).fill(NaN) })
state.recordPostflopDecision(node, 0)
assert.equal(session.getSnapshot().lastDecision?.verdict, 'optimal')
assert.equal(session.getSnapshot().lastDecision?.evLoss, null)
session.stop()

// Existing saved records receive the same correction without changing results.
const hand: HandRecord = {
  id: 'legacy-zero-feedback', ts: 1, tableSize: 2, heroSeat: 0, heroPos: 'BTN',
  heroCards: engine.players[0].cards, board, actions: [], decisions: [legacy],
  result: { deltaBB: 101.5, heroFolded: false, wentToShowdown: true, multiwayCutoff: false, revealed: [] },
}
await saveHand(hand)
const [loaded] = await listHands(1, 1)
assert.equal(loaded.decisions[0].verdict, 'unavailable')
assert.equal(loaded.result.deltaBB, 101.5)
assert.equal(hand.decisions[0].verdict, 'optimal')
console.log('Trainer feedback passed: unsupported/missing rows, valid zero EV, invalid EV, session recording, and legacy history.')
