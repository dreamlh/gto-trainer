import assert from 'node:assert/strict'
import { act, handView, startHand } from '../src/battle/game'
import { emptyStats } from '../src/battle/stats'
import { canPostBlind, canRebuy, canShowCards, showCardsCommand, showCardsDeadline } from '../src/battle/actionAvailability'
import type { RoomView } from '../src/battle/types'

const now = 1_000_000
function roomFixture(): RoomView {
  const hand = startHand(['A', 'B'], 0, 7)
  act(hand, 'A', { kind: 'fold' })
  return {
    code: 'TEST', instanceId: 'room-instance', revision: 1, actionRevision: 1, hostId: 'A', selfId: 'A', capacity: 2, initialStack: 100,
    players: ['A', 'B'].map((id, seat) => ({ id, name: id, bot: false, connected: true, score: 0,
      seat, pendingSeat: null, stack: 100, sittingOut: false, timeCards: 0, stats: emptyStats(), shareWithSpectators: false, entryStatus: 'ready' })),
    hand: handView(hand, 'A'), actionDeadline: null, nextHandAt: now + 5_000, settlementAt: null, started: true,
    seats: ['A', 'B'], reservations: [null, null], runoutVote: null, chat: [], canFastForward: false, nextTimeCardAt: now + 60_000,
    revealed: {}, isSpectator: false, seatRequests: [], mode: 'cash', tournament: null,
  }
}

const pending = roomFixture()
pending.hand!.delta = null
pending.nextHandAt = null
pending.settlementAt = now + 2_000
assert.equal(canShowCards(pending, now), true)
assert.equal(canShowCards(pending, now + 1_999), true)
assert.equal(canShowCards(pending, now + 2_000), true, 'a completed hand remains revealable when a settlement snapshot is late')
assert.deepEqual(showCardsCommand(pending, pending.instanceId, 7, [0], now + 2_000), { type: 'show', cards: [0], handNumber: 7 })
assert.deepEqual(showCardsCommand(pending, pending.instanceId, 7, [0], now + 1_999), { type: 'show', cards: [0], handNumber: 7 })
assert.equal(showCardsDeadline(pending), null, 'payout timing does not close the same-hand reveal window')

const finished = roomFixture()
assert.equal(canShowCards(finished, now + 4_999), true)
assert.equal(canShowCards(finished, now + 5_000), false, 'expired next-hand countdown hides stale show controls before polling catches up')
assert.equal(showCardsCommand(finished, finished.instanceId, 7, [0], now + 5_000), null)
finished.nextHandAt = null
assert.equal(canShowCards(finished, now + 100_000), true, 'a paused table can show the same completed hand without an arbitrary timeout')
finished.revealed.A = [0]
const before = JSON.stringify(finished)
assert.deepEqual(showCardsCommand(finished, finished.instanceId, 7, [0, 1], now), { type: 'show', cards: [1], handNumber: 7 })
assert.equal(showCardsCommand(finished, finished.instanceId, 7, [0], now), null)
assert.equal(showCardsCommand(finished, finished.instanceId, 7, [2], now), null)
assert.equal(showCardsCommand(finished, 'old-room-instance', 7, [1], now), null)
assert.equal(showCardsCommand(finished, finished.instanceId, 6, [1], now), null)
assert.equal(JSON.stringify(finished), before, 'availability checks and command construction never alter room snapshots')
finished.hand!.number = 8
assert.equal(showCardsCommand(finished, finished.instanceId, 7, [1], now), null, 'an old button callback cannot reveal the next hand')
finished.revealed.A = [0, 1]
assert.equal(canShowCards(finished, now), false)

const playback = roomFixture()
playback.hand!.finished = false
playback.hand!.delta = null
playback.nextHandAt = null
playback.settlementAt = now + 2_000
playback.runoutPlayback = { boardIndex: 0, revealedCount: 5, phase: 'settling', completedResults: [], nextRevealAt: now + 2_000 }
assert.equal(canShowCards(playback, now), true, 'folded players may voluntarily table their own cards during a runout payout pause')
assert.equal(canShowCards(playback, now + 2_000), true, 'same-hand reveal remains safe across a run result transition')
playback.runoutPlayback.phase = 'result'
playback.settlementAt = null
assert.equal(canShowCards(playback, now), true)
playback.hand!.players[0].folded = false
assert.equal(canShowCards(playback, now), false, 'automatically tabled active cards need no reveal controls')
playback.hand!.players[0].folded = true
playback.runoutPlayback.phase = 'dealing'
assert.equal(canShowCards(playback, now), false)
playback.hand!.finished = true
playback.isSpectator = true
assert.equal(canShowCards(playback, now), false)
playback.isSpectator = false
playback.hand!.players[0].cards = null
assert.equal(canShowCards(playback, now), false)

const cash = roomFixture()
cash.players[0].stack = 0
assert.equal(canRebuy(cash, now), true, 'a settled busted participant can rebuy')
cash.hand!.finished = false
assert.equal(canRebuy(cash, now), false, 'folding does not authorize a rebuy during the same live hand')
cash.hand!.finished = true
cash.hand!.delta = null
cash.settlementAt = now + 2_000
assert.equal(canRebuy(cash, now), false, 'finished=true during the payout pause does not authorize a rebuy')
assert.equal(canRebuy(cash, now + 2_000), false, 'wait for the settled snapshot rather than guessing the payout')
cash.hand = null
cash.settlementAt = null
assert.equal(canRebuy(cash, now), true, 'the no-hand dock can offer a cash rebuy')
cash.hand = handView(startHand(['B', 'C'], 0, 8), 'A')
cash.isSpectator = true
assert.equal(canRebuy(cash, now), true, 'an out-of-chips spectator outside the live hand can rebuy under the existing room policy')
cash.players[0].stack = 1
assert.equal(canRebuy(cash, now), false)
cash.players[0].stack = 0
cash.players[0].leaving = true
assert.equal(canRebuy(cash, now), false)

const tournament = roomFixture()
tournament.mode = 'tournament'
tournament.players[0].stack = 0
tournament.players[0].tournamentStatus = 'rebuy'
tournament.tournament = { status: 'running', registrationRaises: 3, registrationOpen: true, registrationClosesAt: now + 1_000,
  level: 1, smallBlind: .5, bigBlind: 1, nextLevelAt: now + 10_000, startedAt: now - 60_000,
  winnerId: null, blindIntervalMinutes: 10, entrantIds: ['A', 'B'], rankings: [] }
assert.equal(canRebuy(tournament, now + 999), true)
assert.equal(canRebuy(tournament, now + 1_000), false, 'registration cutoff blocks stale UI rebuy clicks at the exact deadline')
for (const status of ['active', 'eliminated', 'forfeited', 'winner', 'spectator'] as const) {
  tournament.players[0].tournamentStatus = status
  assert.equal(canRebuy(tournament, now), false, `${status} is not an eligible tournament rebuy state`)
}
tournament.players[0].tournamentStatus = 'rebuy'
tournament.tournament.registrationOpen = false
assert.equal(canRebuy(tournament, now), false)
tournament.tournament.registrationOpen = true
tournament.tournament.status = 'finished'
assert.equal(canRebuy(tournament, now), false)

const entry = roomFixture()
assert.equal(canPostBlind(entry), false, 'a ready player does not post an extra entry blind')
entry.players[0].entryStatus = 'waiting'
assert.equal(canPostBlind(entry), true)
entry.players[0].seat = null
entry.players[0].pendingSeat = 1
assert.equal(canPostBlind(entry), true, 'a reserved cash seat may arrange its entry blind for the next hand')
entry.players[0].pendingSeat = null
assert.equal(canPostBlind(entry), false, 'standing without a reservation cannot post')
entry.players[0].seat = 0
entry.players[0].stack = 0
assert.equal(canPostBlind(entry), false)
entry.players[0].stack = 100
entry.players[0].entryStatus = 'post'
assert.equal(canPostBlind(entry), false, 'a queued post cannot be submitted twice')
entry.players[0].entryStatus = 'waiting'
entry.mode = 'tournament'
assert.equal(canPostBlind(entry), false, 'tournaments never offer cash entry blinds')
entry.mode = 'cash'
entry.players[0].leaving = true
assert.equal(canPostBlind(entry), false)

console.log('Battle action availability: late settlement snapshots, next-hand/registration deadlines, stale identity guards, partial reveals, runout phases, cash/tournament rebuy and entry-blind eligibility passed.')
