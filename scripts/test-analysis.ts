import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { bundleFromArtifact } from '../src/solver/preflop/api'
import { scenarioFromBundle } from '../src/analysis/scenarios'
import { CLASS_COMBOS, compatibleRanges, maskRange, rangeSummary, setClass, textRange } from '../src/analysis/ranges'
import { battleContext, inferBattleRanges, orderedPlayers, solverBlock, trainingContext, type BattleReplayRecord } from '../src/analysis/replay'
import { recordsFromRoom, retainReplays } from '../src/db/replayStore'
import { comboIndex, handIndex, parseCard } from '../src/poker/cards'
import type { RoomView } from '../src/battle/types'
import type { HandRecord } from '../src/game/session'

const bundles = Array.from({ length: 8 }, (_, i) => bundleFromArtifact(gunzipSync(readFileSync(new URL(`../public/solutions/preflop-${i + 2}p-100bb.bin.gz`, import.meta.url)))))
let scenarios = 0
for (const bundle of bundles) for (const raises of [1,2,3] as const) {
  const scenario = scenarioFromBundle(bundle, { n: bundle.n, opener: 'BTN', defender: 'BB', raises })
  assert(scenario, `${bundle.n} players, ${raises} raises`)
  assert.deepEqual(scenario.positions, ['BB', 'BTN'])
  assert(scenario.stack > 0 && scenario.stack < 100)
  assert(scenario.ranges.every(r => r.weights.length === 1326 && r.weights.some(w => w > 0)))
  if (raises === 1) assert.equal(scenario.pot, bundle.n === 2 ? 5 : 5.5)
  scenarios++
}
const bundle = bundles[4]
const selection = { n: 6, opener: 'BTN' as const, defender: 'BB' as const, raises: 2 as const }
const scenario = scenarioFromBundle(bundle, selection)!
// Check a real 3bet path: BTN's range includes BOTH its original raise and later call.
let node = bundle.tree.root
while (node.type === 'decision' && bundle.tree.positions[node.actor] !== 'BTN') node = node.children[node.actions.findIndex(a => a.kind === 'fold')]
assert(node.type === 'decision')
const opened = node, raise = opened.actions.findIndex(a => a.kind === 'raise')
node = opened.children[raise]
while (node.type === 'decision' && bundle.tree.positions[node.actor] !== 'BB') node = node.children[node.actions.findIndex(a => a.kind === 'fold')]
assert(node.type === 'decision')
node = node.children[node.actions.findIndex(a => a.kind === 'raise')]
assert(node.type === 'decision' && bundle.tree.positions[node.actor] === 'BTN')
const call = node.actions.findIndex(a => a.kind === 'call')
for (let h = 0; h < 169; h++) {
  const expected = bundle.freq.get(opened.id)![h * opened.actions.length + raise] * bundle.freq.get(node.id)![h * node.actions.length + call]
  assert(Math.abs(scenario.ranges[1].weights[CLASS_COMBOS[h][0]] - expected) < 1e-7)
}

const as = parseCard('As')!, ks = parseCard('Ks')!, qs = parseCard('Qs')!
const specific = textRange('AKs, AsKs:0.25, AhKh:0')
assert.equal(specific.weights[comboIndex(as, ks)], .25)
assert.equal(specific.weights[comboIndex(parseCard('Ah')!, parseCard('Kh')!)], 0)
assert.equal(specific.weights[comboIndex(parseCard('Ad')!, parseCard('Kd')!)], 1)
assert.throws(() => textRange('AsAs'))
assert.throws(() => textRange('AKs:0.3junk'))
const suited = textRange('AKs:0.5')
suited.weights[comboIndex(as, ks)] = .1
const edited = setClass(suited, handIndex('QQ'), .25)
assert.equal(edited.weights[comboIndex(as, ks)], suited.weights[comboIndex(as, ks)])
assert.equal(maskRange(edited, [as])[comboIndex(as, ks)], 0)
assert.equal(edited.weights[comboIndex(as, ks)], suited.weights[comboIndex(as, ks)], 'masking must not mutate imported weights')
assert.equal(rangeSummary(textRange('AA'), [as]).count, 3)
const one = new Float32Array(1326), conflict = new Float32Array(1326)
one[comboIndex(as, ks)] = 1; conflict[comboIndex(as, qs)] = 1
assert.equal(compatibleRanges(one, conflict), false)
assert.equal(compatibleRanges(one, textRange('QQ').weights), true)

const positions = ['UTG','HJ','CO','BTN','SB','BB']
const action = (playerId: string, kind: string, amount = 0, street = 'preflop') => ({ playerId, kind, amount, street })
const record: BattleReplayRecord = { id: 'r', instanceId: 'room', heroId: 'BTN', savedAt: 1,
  hand: { number: 1, finishedAt: 1, bigBlind: 1, smallBlind: .5, board: [0,5,10,15,20], boards: [[0,5,10,15,20]],
    players: positions.map(position => ({ id: position, name: position, position, bot: false })), myCards: [as,ks], delta: {}, showdown: true, runResults: [],
    replay: { version: 1, mode: 'cash', startingStacks: Object.fromEntries(positions.map(p => [p,100])) },
    history: [action('SB','small-blind',.5),action('BB','big-blind',1),action('UTG','fold'),action('HJ','fold'),action('CO','fold'),action('BTN','raise',2.5),action('SB','fold'),action('BB','call',1.5),
      action('BB','check',0,'flop'),action('BTN','raise',2,'flop'),action('BB','call',2,'flop'),action('BB','raise',6,'turn'),action('BTN','call',6,'turn')] } }
const flop = battleContext(record, 'flop')
assert.deepEqual(flop.board, [0,5,10]); assert.equal(flop.pot, 5.5); assert.equal(solverBlock(flop), null)
assert.deepEqual(orderedPlayers(flop).map(p => p.id), ['BB','BTN'])
assert.equal(orderedPlayers(flop)[0].stack, 97.5)
const inferred = inferBattleRanges(flop, record, bundle)
assert.equal(inferred.players.find(p => p.id === 'BTN')!.range.source, 'inferred')
const turn = battleContext(record, 'turn'), river = battleContext(record, 'river')
assert.equal(turn.pot, 9.5); assert.equal(river.pot, 21.5)
assert.equal(orderedPlayers(river)[0].stack, 89.5); assert.deepEqual(turn.board, [0,5,10,15]); assert.equal(turn.rangeUnconditioned, true)
const tournament = structuredClone(record)
tournament.hand.bigBlind = 2; tournament.hand.smallBlind = 1; tournament.hand.replay!.mode = 'tournament'
for (const p of positions) tournament.hand.replay!.startingStacks[p] *= 2
for (const a of tournament.hand.history) a.amount *= 2
assert.equal(battleContext(tournament, 'river').pot, river.pot)
assert.equal(orderedPlayers(battleContext(tournament, 'river'))[0].stack, 89.5)
const custom = structuredClone(record); custom.hand.history.find(a => a.kind === 'raise')!.amount = 7
assert.equal(inferBattleRanges(battleContext(custom, 'flop'), custom, bundle).players.find(p => p.id === 'BTN')!.range.source, 'unset')
const older = structuredClone(record); delete older.hand.replay
assert.equal(solverBlock(battleContext(older, 'flop')), 'missing')
const multiway = structuredClone(flop); multiway.players[0].folded = false; multiway.players[0].stack = 0
assert.equal(solverBlock(multiway), 'multiway', 'third-party all-in interest is not ordinary heads-up')
const allin = structuredClone(flop); allin.players.find(p => p.id === 'BB')!.stack = 0
assert.equal(solverBlock(allin), 'allin')
const hu = structuredClone(record)
hu.hand.players = hu.hand.players.filter(p => ['BTN','BB'].includes(p.id)); hu.hand.players[0].position = 'BTN / SB'
hu.hand.history = [action('BTN','small-blind',.5),action('BB','big-blind',1),action('BTN','raise',2.5),action('BB','call',1.5)]
assert.deepEqual(orderedPlayers(battleContext(hu, 'flop')).map(p => p.id), ['BB','BTN'])
assert.equal(inferBattleRanges(battleContext(hu,'flop'),hu,bundles[0]).players[0].range.source, 'inferred')
const runs = structuredClone(record); runs.hand.boards.push([0,5,10,18,23])
assert.deepEqual(battleContext(runs,'turn',1).board, [0,5,10,18])
const training = { id:'t',tableSize:2,heroSeat:0,heroPos:'BTN',heroCards:[as,ks],board:[0,5,10,15,20],actions:[],decisions:[],result:{},ts:1,
  replay:[{version:1,street:'flop',board:[0,5,10],pot:5,stack:97.5,seats:[1,0],ranges:[one,suited.weights]}] } as HandRecord
assert.equal(trainingContext(training,'flop').players[0].range.weights[comboIndex(as,ks)], suited.weights[comboIndex(as,ks)])
assert.equal(solverBlock(trainingContext(training,'turn')), 'missing')
const room = { instanceId:'room',selfId:'BTN',handHistory:[record.hand] } as RoomView
const saved = recordsFromRoom({ ...room, token:'secret' } as RoomView)
assert(!JSON.stringify(saved).includes('secret'))
assert.equal(recordsFromRoom({...room,selfId:'observer'}).length,0)
const many = Array.from({length:1005},(_,i)=>({...record,id:String(i),hand:{...record.hand,number:i+1,finishedAt:i+1}}))
assert.equal(retainReplays([...many,...many]).length,1000)
assert.equal(retainReplays(many).at(-1)!.hand.number,6)
console.log(`Analysis passed: ${scenarios} real scenarios, cumulative reach, combo weights/blockers, exact inference, street reconstruction, BB conversion, HU/multiway/all-in gates, legacy records, runouts and bounded privacy-safe storage.`)
