import assert from 'node:assert/strict'
import { BattleVisualTracker } from '../src/battle/visualEvents'
import type { HandView, RoomView, RunoutResult } from '../src/battle/types'

function hand(number = 1): HandView {
  return {
    number, street: 'preflop', board: [], boards: [[]], pot: 1.5,
    dealerId: 'hero', smallBlindId: 'hero', bigBlindId: 'other', toAct: 'hero',
    players: ['hero', 'other', 'third'].map(id => ({ id, cards: null, stack: 100, invested: 0, streetBet: 0, folded: false, allin: false })),
    legal: null, finished: false, showdown: false, awaitingRunout: false, runCount: 1, delta: null, runResults: [], history: [],
  }
}
function room(): RoomView {
  return { instanceId: 'room-instance', selfId: 'hero', hand: hand(), runoutPlayback: null } as RoomView
}
function board(view: RoomView, cards: number[], index = 0): void {
  view.hand!.board = [...cards]
  view.hand!.boards[index] = [...cards]
  if (view.runoutPlayback) view.runoutPlayback.revealedCount = cards.length
}
function result(run: number, cards: number[], payouts: Record<string, number>): RunoutResult {
  return { run, board: [...cards], winners: Object.keys(payouts), payouts }
}

const view = room(), tracker = new BattleVisualTracker()
assert.equal(tracker.observe(view), null, 'Opening an existing hand only establishes continuity')
assert.equal(tracker.observe(view), null, 'Identical polls do not replay effects')
view.hand = hand(2)
let event = tracker.observe(view)!
assert.equal(event.deal, true)
assert.equal(event.potChanged, true, 'A new hand starts a fresh pot even if the blind amount is unchanged')
assert.deepEqual(event.holeKeys, [], 'A new deal does not also flip its newly dealt hole cards')
assert.equal(event.handKey, 'room-instance:2')
assert.deepEqual(event.boardKeys, [])
assert.equal(tracker.observe(view), null)
view.hand.history.push(
  { playerId: 'hero', street: 'preflop', kind: 'small-blind', amount: .5 },
  { playerId: 'hero', street: 'preflop', kind: 'raise', amount: 3 },
  { playerId: 'other', street: 'preflop', kind: 'call', amount: 2 },
  { playerId: 'hero', street: 'preflop', kind: 'refund', amount: 1 },
)
event = tracker.observe(view)!
assert.deepEqual(event.actions, [
  { playerId: 'hero', kind: 'raise', key: 'room-instance:2:action:1' },
  { playerId: 'other', kind: 'call', key: 'room-instance:2:action:2' },
])
assert.equal(tracker.observe(view), null)
board(view, [0, 1, 2])
assert.deepEqual(tracker.observe(view)!.boardKeys, ['0:0:0', '0:1:1', '0:2:2'])
board(view, [0, 1, 2, 3])
assert.deepEqual(tracker.observe(view)!.boardKeys, ['0:3:3'])
assert.equal(tracker.observe(view), null)

// River revelation and settlement may arrive in the same poll; both survive.
board(view, [0, 1, 2, 3, 4])
view.hand.finished = true; view.hand.showdown = true
view.hand.runResults = [result(1, view.hand.board, { hero: 20, other: 80 })]
view.hand.delta = { hero: -30, other: 30, third: 0 }
event = tracker.observe(view)!
assert.deepEqual(event.boardKeys, ['0:4:4'])
assert.deepEqual(event.award, { key: 'room-instance:2:run:1', winnerIds: ['hero', 'other'] }, 'All side-pot winners receive an award even with negative net delta')
assert.equal(tracker.observe(view), null)

view.hand = hand(3); tracker.observe(view)
view.hand.players[1].folded = true; view.hand.players[2].folded = true
view.hand.finished = true; view.hand.delta = { hero: .5, other: -.5, third: 0 }
assert.deepEqual(tracker.observe(view)!.award, { key: 'room-instance:3:settled', winnerIds: ['hero'] }, 'An uncontested pot belongs to the surviving hand')
assert.equal(tracker.observe(view), null)

const runView = room(), runs = new BattleVisualTracker()
// End-of-hand revelation precedes payout by two seconds. Only payout celebrates.
const pendingView = room(), pendingTracker = new BattleVisualTracker()
pendingTracker.observe(pendingView)
pendingView.hand!.players[1].folded = true; pendingView.hand!.players[2].folded = true
pendingView.hand!.finished = true; pendingView.settlementAt = 2000
assert.equal(pendingTracker.observe(pendingView)?.award ?? null, null, 'No uncontested winner animation during the reveal window')
pendingView.hand!.players[1].cards = [9, null]
assert.deepEqual(pendingTracker.observe(pendingView)!.holeKeys, ['other:0:9'], 'Voluntary reveals still animate during the settlement pause')
pendingView.settlementAt = null; pendingView.hand!.delta = { hero: 1, other: -1, third: 0 }
assert.deepEqual(pendingTracker.observe(pendingView)!.award?.winnerIds, ['hero'], 'Settlement emits the previously withheld award')
assert.equal(pendingTracker.observe(pendingView), null, 'The finished hand cannot award twice')

board(runView, [10, 11, 12]); runs.observe(runView)
runView.hand!.showdown = true; runView.hand!.runCount = 2
runView.runoutPlayback = { boardIndex: 0, revealedCount: 3, phase: 'dealing', completedResults: [], nextRevealAt: 100 }
assert.equal(runs.observe(runView), null, 'Entering runout playback does not redeal the existing flop')
board(runView, [10, 11, 12, 13])
assert.deepEqual(runs.observe(runView)!.boardKeys, ['0:3:13'])
board(runView, [10, 11, 12, 13, 14])
runView.runoutPlayback.phase = 'result'
runView.runoutPlayback.completedResults.push(result(1, runView.hand!.board, { hero: 50 }))
event = runs.observe(runView)!
assert.deepEqual(event.boardKeys, ['0:4:14'])
assert.deepEqual(event.award!.winnerIds, ['hero'])
assert.equal(runs.observe(runView), null)
runView.runoutPlayback.boardIndex = 1; runView.runoutPlayback.phase = 'dealing'
board(runView, [10, 11, 12], 1)
assert.equal(runs.observe(runView), null, 'A shared prefix on another run is already public')
board(runView, [10, 11, 12, 15], 1)
assert.deepEqual(runs.observe(runView)!.boardKeys, ['1:3:15'])
board(runView, [10, 11, 12, 15, 16], 1)
runView.runoutPlayback.phase = 'result'
runView.runoutPlayback.completedResults.push(result(2, runView.hand!.board, { other: 25, third: 25 }))
event = runs.observe(runView)!
assert.deepEqual(event.boardKeys, ['1:4:16'])
assert.deepEqual(event.award, { key: 'room-instance:1:run:2', winnerIds: ['other', 'third'] })
runView.hand!.runResults = structuredClone(runView.runoutPlayback.completedResults)
runView.runoutPlayback = null; runView.hand!.finished = true
runView.hand!.board = [...runView.hand!.boards[0]] // Resolved server hand points to its first board.
assert.equal(runs.observe(runView), null, 'Final settlement neither redeals nor re-awards the last run')
assert.equal(runs.observe(runView), null, 'Review controls are not tracker inputs and cannot replay a result')

const skippedView = room(), skipped = new BattleVisualTracker()
board(skippedView, [20, 21, 22, 23, 24]); skipped.observe(skippedView)
skippedView.runoutPlayback = { boardIndex: 1, revealedCount: 4, phase: 'dealing', completedResults: [result(1, skippedView.hand!.board, { hero: 50 })], nextRevealAt: 200 }
board(skippedView, [20, 21, 22, 25], 1)
assert.deepEqual(skipped.observe(skippedView)!.boardKeys, ['1:3:25'], 'A missed prefix-only poll does not animate the shared cards')

const hiddenView = room(), hidden = new BattleVisualTracker()
hidden.observe(hiddenView)
hiddenView.hand = hand(2)
assert.equal(hidden.observe(hiddenView, false), null, 'Hidden/inactive updates are consumed silently')
board(hiddenView, [30, 31, 32])
assert.equal(hidden.observe(hiddenView, true), null, 'The first restored snapshot suppresses accumulated changes')
board(hiddenView, [30, 31, 32, 33])
assert.deepEqual(hidden.observe(hiddenView)!.boardKeys, ['0:3:33'], 'New live events resume after continuity is restored')
hidden.resetContinuity()
board(hiddenView, [30, 31, 32, 33, 34])
hiddenView.hand.finished = true; hiddenView.hand.showdown = true
hiddenView.hand.runResults = [result(1, hiddenView.hand.board, { hero: 10 })]
assert.equal(hidden.observe(hiddenView), null, 'Reconnect snapshots establish a baseline instead of replaying a stale award')
assert.equal(hidden.observe(hiddenView), null)
hiddenView.hand = hand(3)
assert.equal(hidden.observe(hiddenView)!.deal, true)
hiddenView.instanceId = 'replacement'; hiddenView.hand = hand(4)
assert.equal(hidden.observe(hiddenView), null, 'A replacement room starts new continuity')
hiddenView.selfId = 'other'; hiddenView.hand = hand(5)
assert.equal(hidden.observe(hiddenView), null, 'A changed viewer identity starts new continuity')
hidden.observe(null)
assert.equal(hidden.observe(hiddenView), null, 'Leaving then rejoining never replays the existing hand')

const waitingView = room(), waiting = new BattleVisualTracker()
waitingView.hand = null; waiting.observe(waitingView)
waitingView.hand = hand()
assert.equal(waiting.observe(waitingView)!.deal, true, 'Starting from an observed waiting table deals the first hand')

const publicView = room(), reveals = new BattleVisualTracker()
publicView.hand!.players[0].cards = [0, 1]
publicView.hand!.players[1].cards = [2, null]
publicView.hand!.pot = 30
assert.equal(reveals.observe(publicView), null, 'An existing public card and pot are a silent baseline')
publicView.hand!.history.push({ playerId: 'other', street: 'flop', kind: 'check', amount: 0 })
event = reveals.observe(publicView)!
assert.equal(event.potChanged, false, 'Checking does not pulse an unchanged pot')
assert.deepEqual(event.holeKeys, [], 'A later check cannot flip preexisting public cards')
publicView.hand!.players[1].cards![1] = 3
event = reveals.observe(publicView)!
assert.deepEqual(event.holeKeys, ['other:1:3'], 'Only the newly exposed hole card flips')
assert.equal(event.potChanged, false)
assert.equal(reveals.observe(publicView), null, 'Repeated public cards do not flip again')
publicView.hand!.pot = 40
event = reveals.observe(publicView)!
assert.equal(event.potChanged, true, 'An observed numeric pot change gets its own animation event')
assert.deepEqual(event.holeKeys, [])
reveals.resetContinuity()
publicView.hand!.players[2].cards = [4, null]
publicView.hand!.pot = 50
assert.equal(reveals.observe(publicView), null, 'Reconnect consumes revealed cards and pot changes silently')
publicView.hand!.history.push({ playerId: 'other', street: 'flop', kind: 'check', amount: 0 })
event = reveals.observe(publicView)!
assert.equal(event.potChanged, false)
assert.deepEqual(event.holeKeys, [], 'Cards exposed during reconnect stay silent on the next live action')
publicView.hand!.players[2].cards![1] = 5
assert.deepEqual(reveals.observe(publicView)!.holeKeys, ['third:1:5'])
publicView.hand = hand(2)
publicView.hand.players[0].cards = [6, 7]
publicView.hand.players[1].cards = [8, 9]
assert.deepEqual(reveals.observe(publicView)!.holeKeys, [], 'Dealt cards use the deal effect instead of a redundant reveal')

console.log('Battle visuals: live deals/actions, selective pot/card changes, side-pot and split-pot winners, uncontested awards, sequential runouts, hidden/reconnect continuity and duplicate suppression passed.')
