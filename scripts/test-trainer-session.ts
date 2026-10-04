import assert from 'node:assert/strict'
import { TrainerSession, type SessionSnapshot } from '../src/game/session'
import { newHand, applyAction } from '../src/game/engine'
import { RangeTracker } from '../src/game/rangeTracker'
import { buildPostflopTree } from '../src/solver/postflop/tree'
import { POSTFLOP_PRESETS } from '../src/solver/config'
import { trainerHistoryActions, trainerAction } from '../src/game/trainerPresentation'

// Supply deterministic solver output through the real worker protocol. Session
// navigation, bot delays, action accounting and decision records remain real.
class SolverWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null
  postMessage(message: { type: string; id: number; spec: { street: 'flop' | 'turn' | 'river'; board: number[]; pot: number; stack: number } }) {
    if (message.type !== 'solve') return
    const tree = buildPostflopTree({ ...message.spec, preset: POSTFLOP_PRESETS.trainer })
    const nodes = tree.decisionNodes.map(node => {
      const count = node.actions.length
      const chosen = Math.max(0, node.actions.findIndex(action => action.kind === 'bet' || action.kind === 'call'))
      const strategy = new Float32Array(1326 * count), ev = new Float32Array(strategy.length)
      for (let combo = 0; combo < 1326; combo++) strategy[combo * count + chosen] = 1
      return { ...node, strategy: strategy.buffer, ev: ev.buffer }
    })
    queueMicrotask(() => this.onmessage?.({ data: { type: 'done', id: message.id, nodes, exploitability: 0, iterations: 1 } }))
  }
}
Object.assign(globalThis, { Worker: SolverWorker })
const session = new TrainerSession()
const state = session as unknown as {
  engine: ReturnType<typeof newHand>; tracker: RangeTracker; pfNode: unknown; generation: number
  update: (patch: Partial<SessionSnapshot>) => void; process: (generation: number) => Promise<void>
}
const engine = newHand(2)
applyAction(engine, 0, 'raise', 5.8); applyAction(engine, 1, 'call', 5.8)
state.engine = engine; state.tracker = new RangeTracker(2); state.generation = 1
state.pfNode = { type: 'terminal', id: 1, kind: 'flop', pot: 11.6, invested: [5.8, 5.8], active: [0, 1], publicPath: '', forcedFolds: [] }
state.update({ heroSeat: 0, phase: 'bot-thinking', preflopOnly: false, tableSize: 2 })
await state.process(1)

const waitFor = (street: string, phase: string) => new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(() => { unsubscribe(); reject(new Error(`Timed out at ${street} ${phase}`)) }, 4000)
  const changed = () => {
    const snap = session.getSnapshot()
    if (snap.engine?.street === street && snap.phase === phase) { clearTimeout(timeout); unsubscribe(); resolve() }
  }
  const unsubscribe = session.subscribe(changed)
  changed()
})
for (const street of ['flop', 'turn', 'river']) {
  await waitFor(street, 'hero-turn')
  // Allow any stale bot continuation enough time to run and expose the race.
  await new Promise(resolve => setTimeout(resolve, 650))
  const snap = session.getSnapshot()
  assert.equal(engine.history.filter(action => action.street === street).length, 1, `${street}: exactly one opponent action after solving`)
  assert.equal(engine.history.at(-1)!.kind, 'bet')
  assert.deepEqual(snap.heroActions.map(action => action.kind), ['fold', 'call', 'raise'], `${street}: facing a bet cannot offer check / bet`)
  const call = snap.heroActions.findIndex(action => action.kind === 'call')
  const due = engine.players[1].invested - engine.players[0].invested
  assert.equal(snap.heroActions[call].label, `跟注 ${Number(due.toFixed(1))}`)
  session.heroAct(call)
  const record = session.getSnapshot().lastDecision!
  assert.equal(record.kinds[record.chosen], 'call')
  assert.equal(trainerAction(record.labels[record.chosen], 'zh'), `跟注 ${Number(due.toFixed(1))} BB`)
  const history = trainerHistoryActions(engine).filter(action => action.street === street)
  assert.equal(history.length, 2)
  assert.equal(history[1].kind, 'call'); assert.equal(Number(history[1].amount!.toFixed(1)), Number(due.toFixed(1)))
}
await waitFor('river', 'hand-done')
assert.equal(session.getSnapshot().result?.wentToShowdown, true)
session.stop()
console.log('Trainer session passed: one process per street, preflop → flop → turn → river navigation, correct call actions and amounts, records and showdown.')
