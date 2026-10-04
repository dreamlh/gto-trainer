import assert from 'node:assert/strict'
import { trainerTableEvents } from '../src/game/trainerTableEvents'
import { BattleVisualTracker } from '../src/battle/visualEvents'
import { BattleAudioTracker } from '../src/battle/audioEvents'
import { battleTensionKey } from '../src/battle/tensionMusic'
import { playerShowdownLabel } from '../src/battle/presentation'
import { newHand, applyAction } from '../src/game/engine'
import type { SessionSnapshot } from '../src/game/session'

const t = (zh: string, _en: string) => zh
const snap: SessionSnapshot = { version: 0, phase: 'idle', engine: null, heroSeat: 0, toActSeat: 1, heroActions: [], decisions: [], lastDecision: null, result: null, solveProgress: null, error: '', preflopOnly: false, tableSize: 2 }
const visual = new BattleVisualTracker(), audio = new BattleAudioTracker()
visual.observe(trainerTableEvents(snap, false)); audio.observe(trainerTableEvents(snap, false))
snap.engine = newHand(2); snap.phase = 'bot-thinking'
let view = trainerTableEvents(snap, false)
assert.equal(visual.observe(view)?.deal, true)
assert.equal(audio.observe(view)?.sound, 'deal')
assert.equal(visual.observe(view), null)
const before = JSON.stringify(snap.engine)
trainerTableEvents(snap, true)
assert.equal(JSON.stringify(snap.engine), before, 'Presentation cannot mutate engine chips or cards')
applyAction(snap.engine, 1, 'raise', 4)
const changed = trainerTableEvents(snap, false)
assert.equal(view.hand!.players[1].streetBet, 1, 'Previous public snapshots are detached from the mutable engine')
assert.equal(visual.observe(changed)?.actions[0].kind, 'raise')
assert.equal(audio.observe(changed)?.sound, 'raise')
snap.toActSeat = 0
view = trainerTableEvents(snap, false)
assert.equal(audio.observe(view)?.sound, 'turn')
applyAction(snap.engine, 0, 'raise', 100)
view = trainerTableEvents(snap, false)
assert.equal(audio.observe(view)?.sound, 'allin')
assert.ok(battleTensionKey({ ...view, nextHandAt: null, runoutVote: null }))

// A real settled pot awards chips before opponents choose to reveal their rank.
snap.engine = newHand(2)
snap.engine.street = 'river'; snap.engine.board = [0, 5, 10, 24, 29]
snap.engine.players[0].cards = [48, 49]; snap.engine.players[1].cards = [44, 45]
for (const player of snap.engine.players) { player.invested = 10; player.streetBase = 10 }
snap.phase = 'hero-turn'; snap.result = null
visual.observe(trainerTableEvents(snap, false)); audio.observe(trainerTableEvents(snap, false))
snap.phase = 'hand-done'; snap.result = { deltaBB: 10, heroFolded: false, wentToShowdown: true, multiwayCutoff: false, revealed: [{ seat: 1, cards: [44, 45] }] }
view = trainerTableEvents(snap, false)
assert.deepEqual(visual.observe(view)?.award?.winnerIds, ['hero'])
assert.equal(audio.observe(view)?.sound, 'win')
assert.equal(view.hand!.players[0].stack, 110)
assert.equal(view.hand!.players[1].stack, 90)
assert.equal(playerShowdownLabel(view.hand, 'hero', view.hand!.board, t), '一对')
assert.equal(playerShowdownLabel(view.hand, 'seat-1', view.hand!.board, t), null, 'Even automatic showdown data cannot disclose the opponent rank before Show cards')
assert.equal(battleTensionKey({ ...view, nextHandAt: null, runoutVote: null }), null)
view = trainerTableEvents(snap, true)
assert.equal(playerShowdownLabel(view.hand, 'seat-1', view.hand!.board, t), '一对')
assert.equal(visual.observe(view)?.award, null, 'Showing cards does not replay the pot award')
assert.equal(audio.observe(view), null, 'Showing cards does not replay settlement audio')
assert.equal(visual.observe(view), null)

// Board-playing ties award both seats, regardless of zero net delta.
snap.engine = newHand(2); snap.engine.street = 'river'; snap.engine.board = [32, 36, 40, 44, 48]
snap.engine.players[0].cards = [0, 5]; snap.engine.players[1].cards = [10, 15]
for (const player of snap.engine.players) { player.invested = 10; player.streetBase = 10 }
snap.result = null
visual.observe(trainerTableEvents(snap, false)); audio.observe(trainerTableEvents(snap, false))
snap.result = { deltaBB: 0, heroFolded: false, wentToShowdown: true, multiwayCutoff: false, revealed: [] }
view = trainerTableEvents(snap, false)
assert.deepEqual(visual.observe(view)?.award?.winnerIds, ['hero', 'seat-1'])
assert.equal(audio.observe(view)?.sound, 'result')

// Stopping at the flop for decision feedback cannot invent a pot recipient.
snap.engine = newHand(6); snap.heroSeat = 5; snap.result = null
visual.observe(trainerTableEvents(snap, false))
snap.result = { deltaBB: null, heroFolded: false, wentToShowdown: false, multiwayCutoff: true, revealed: [] }
view = trainerTableEvents(snap, false)
assert.equal(visual.observe(view)?.award ?? null, null)
assert.deepEqual(view.hand!.runResults, [])
console.log('Trainer events passed: shared deal/bet/turn/all-in/results, private ranks, copied snapshots, payout recipients, ties, reveal deduplication and cutoff semantics.')
