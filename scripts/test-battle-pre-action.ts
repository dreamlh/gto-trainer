import assert from 'node:assert/strict'
import { BattlePreActionController, currentPreAction, preActionAvailability, type BattlePreAction } from '../src/battle/preAction'
import { act, handView, startHand, type BattleHand } from '../src/battle/game'
import type { HandView, RoomView } from '../src/battle/types'

function room(): RoomView {
  const hand: HandView = {
    number: 8, street: 'preflop', board: [], boards: [[]], pot: 1.5,
    dealerId: 'hero', smallBlindId: 'hero', bigBlindId: 'other', toAct: 'other',
    pendingPlayerIds: ['hero', 'other'],
    players: ['hero', 'other'].map(id => ({ id, cards: null, stack: 99, invested: 1, streetBet: 1, folded: false, allin: false })),
    legal: null, finished: false, showdown: false, awaitingRunout: false, runCount: 1, delta: null, history: [],
  }
  return {
    instanceId: 'instance-a', selfId: 'hero', hand, actionRevision: 14, isSpectator: false,
    players: [{ id: 'hero', bot: false, seat: 0, sittingOut: false, leaving: false, stack: 99 }],
    runoutVote: null, runoutPlayback: null, settlementAt: null,
  } as RoomView
}
function ownTurn(view: RoomView, canCheck = true, canFold = true): void {
  view.hand!.toAct = view.selfId
  view.hand!.legal = { canCheck, canFold, callAmount: canCheck ? 0 : 8, minRaiseTo: 16, maxRaiseTo: 100 }
  view.actionRevision++
}
function selected(action: BattlePreAction = 'fold') {
  const view = room(), controller = new BattlePreActionController()
  controller.toggle(view, action)
  assert.equal(controller.selection?.action, action)
  return { view, controller }
}
function roomFromHand(hand: BattleHand, selfId: string): RoomView {
  const view = room(), member = view.players[0]
  view.selfId = selfId
  view.hand = handView(hand, selfId)
  view.players = hand.players.map((player, seat) => ({ ...member, id: player.id, seat, stack: player.stack }))
  return view
}

{
  const hand = startHand(['button', 'small', 'hero'], 0, 8)
  const view = roomFromHand(hand, 'hero')
  assert.equal(hand.toAct, 'button')
  assert.deepEqual(view.hand!.pendingPlayerIds, hand.pending)
  assert.equal(preActionAvailability(view).canSelect, true, 'An unacted big blind still owes a decision')
  assert.equal(preActionAvailability(view).canCheck, true, 'Posting the big blind does not count as checking')
  view.hand!.pendingPlayerIds!.push('not-a-player')
  assert(!hand.pending.includes('not-a-player'), 'Public pending IDs are a copy, not server-state aliases')
  act(hand, 'button', { kind: 'call' })
  assert.equal(preActionAvailability(roomFromHand(hand, 'hero')).canCheck, true, 'Calls preserve the big blind option')
}
{
  const hand = startHand(['hero', 'small', 'big'], 0, 8)
  act(hand, 'hero', { kind: 'call' })
  const complete = roomFromHand(hand, 'hero')
  complete.hand!.history = []
  assert.equal(complete.hand!.players[0].streetBet, 1)
  assert.equal(preActionAvailability(complete).active, false, 'A completed call has no further decision even without action history')
  const { controller } = selected('check')
  assert.equal(controller.take(complete, true), null)
  assert.equal(controller.selection, null, 'Completing the street decision cancels a stale selection even while busy')
  controller.toggle(complete, 'fold')
  assert.equal(controller.selection, null, 'No preselection is offered after matching and leaving the queue')
  act(hand, 'small', { kind: 'raise', to: 3 })
  const response = roomFromHand(hand, 'hero')
  assert.equal(hand.toAct, 'big')
  assert.equal(preActionAvailability(response).canSelect, true, 'A later full raise returns the caller to the queue')
  assert.equal(preActionAvailability(response).canFold, true)
  assert.equal(preActionAvailability(response).canCheck, false)
  act(hand, 'big', { kind: 'call' })
  act(hand, 'hero', { kind: 'call' })
  const nextStreet = roomFromHand(hand, 'hero')
  assert.equal(hand.street, 'flop')
  assert.equal(hand.toAct, 'small')
  assert.equal(preActionAvailability(nextStreet).canSelect, true, 'A new street creates a new pending decision')
  assert.equal(preActionAvailability(nextStreet).canCheck, true)
  assert.equal(controller.take(nextStreet, false), null, 'A cancelled old selection does not return with the new street')
}
{
  const hand = startHand(['button', 'small', 'hero'], 0, 8)
  act(hand, 'button', { kind: 'call' })
  act(hand, 'small', { kind: 'call' })
  act(hand, 'hero', { kind: 'check' })
  act(hand, 'small', { kind: 'check' })
  act(hand, 'hero', { kind: 'check' })
  assert.equal(hand.street, 'flop')
  assert.equal(hand.toAct, 'button')
  assert.equal(preActionAvailability(roomFromHand(hand, 'hero')).active, false, 'A checked player cannot preselect while the last opponent decides')
  const checkedAround = structuredClone(hand)
  act(checkedAround, 'button', { kind: 'check' })
  assert.equal(checkedAround.street, 'turn')
  assert.equal(preActionAvailability(roomFromHand(checkedAround, 'hero')).canCheck, true, 'Checks around restore eligibility on the next street')
  act(hand, 'button', { kind: 'raise', to: 2 })
  const facingBet = preActionAvailability(roomFromHand(hand, 'hero'))
  assert.equal(hand.toAct, 'small')
  assert.equal(facingBet.canSelect, true, 'A later bet requires the previously checked player to respond')
  assert.equal(facingBet.canFold, true)
  assert.equal(facingBet.canCheck, false)
}
{
  const hand = startHand(['hero', 'short', 'other', 'first'], 0, 8, { stacks: { hero: 100, short: 13, other: 100, first: 100 } })
  const controller = new BattlePreActionController()
  controller.toggle(roomFromHand(hand, 'hero'), 'fold')
  act(hand, 'first', { kind: 'call' })
  act(hand, 'hero', { kind: 'raise', to: 10 })
  const raised = roomFromHand(hand, 'hero')
  assert.equal(preActionAvailability(raised).active, false, 'A completed raise leaves the aggressor out of the pending queue')
  assert.equal(controller.take(raised, false), null)
  assert.equal(controller.selection, null)
  act(hand, 'short', { kind: 'raise', to: 13 })
  const facingShortAllIn = roomFromHand(hand, 'hero')
  assert.equal(hand.toAct, 'other')
  assert.equal(preActionAvailability(facingShortAllIn).canSelect, true, 'A short all-in still creates a response decision')
  assert.equal(preActionAvailability(facingShortAllIn).canFold, true)
  assert.equal(preActionAvailability(facingShortAllIn).canCheck, false)
  controller.toggle(facingShortAllIn, 'fold')
  act(hand, 'other', { kind: 'call' })
  act(hand, 'first', { kind: 'call' })
  const own = roomFromHand(hand, 'hero')
  assert.equal(own.hand!.legal!.minRaiseTo, null, 'The short all-in does not reopen this player’s raise rights')
  assert.equal(controller.take(own, false)?.action.kind, 'fold', 'Response eligibility does not depend on reopened raise rights')
}
{
  const hand = startHand(['hero', 'short'], 0, 8, { stacks: { hero: 100, short: .5 }, deferRunout: true })
  const view = roomFromHand(hand, 'hero')
  assert.equal(hand.awaitingRunout, true)
  assert.deepEqual(view.hand!.pendingPlayerIds, [])
  assert.equal(preActionAvailability(view).active, false, 'Matching a short all-in blind does not invent another decision')
}
{
  const view = room(), controller = new BattlePreActionController()
  delete view.hand!.pendingPlayerIds
  assert.equal(preActionAvailability(view).canSelect, false, 'Legacy snapshots without a queue conservatively hide waiting preselection')
  controller.toggle(view, 'fold')
  assert.equal(controller.selection, null)
  const chosen = selected('check')
  ownTurn(chosen.view)
  delete chosen.view.hand!.pendingPlayerIds
  assert.equal(chosen.controller.take(chosen.view, false)?.action.kind, 'check', 'An actual legal own turn still consumes a previously selected action without the new field')
}

{
  const view = room(), controller = new BattlePreActionController()
  view.hand!.players[0].streetBet = 0
  assert.equal(preActionAvailability(view).canFold, true, 'Fold stays available while facing the blind')
  assert.equal(preActionAvailability(view).canCheck, false, 'A player owing the blind cannot preselect check')
  controller.toggle(view, 'check')
  assert.equal(controller.selection, null, 'A stale check click cannot queue an illegal choice')
  controller.toggle(view, 'fold')
  controller.toggle(view, 'check')
  assert.equal(controller.selection?.action, 'fold', 'An unavailable check cannot replace a valid fold choice')
}
{
  const view = room()
  view.hand!.bigBlindId = view.selfId
  assert.equal(preActionAvailability(view).canCheck, true, 'The big blind can preselect check when the blind is matched')
  view.hand!.history.push({ playerId: 'other', street: 'preflop', kind: 'raise', amount: 5 })
  view.hand!.players.forEach(player => { player.streetBet = 5 })
  assert.equal(preActionAvailability(view).canCheck, true, 'A previous raise does not forbid check once the current bet is matched')
}
for (const busy of [false, true]) {
  const { view, controller } = selected('check')
  view.hand!.players[1].streetBet = 9
  view.actionRevision++
  assert.equal(view.hand!.toAct, 'other')
  assert.equal(preActionAvailability(view).canCheck, false, 'A new bet hides check before the player’s turn')
  assert.equal(currentPreAction(controller.selection, view), null, 'The rendered selection clears immediately with the new bet')
  assert.equal(controller.take(view, busy), null, 'Facing a bet never submits check, call or fold')
  assert.equal(controller.selection, null, 'A check cancels while waiting, including during an unrelated pending command')
  view.hand!.street = 'flop'; view.hand!.board = [1, 2, 3]
  view.hand!.players.forEach(player => { player.streetBet = 0 })
  assert.equal(preActionAvailability(view).canCheck, true, 'A fresh unbet street offers check again')
  assert.equal(controller.take(view, false), null)
  ownTurn(view)
  assert.equal(controller.take(view, false), null, 'A cancelled selection never returns on the next street')
}
{
  const { view, controller } = selected('fold')
  view.hand!.players[1].streetBet = 9
  assert.equal(controller.take(view, false), null)
  assert.equal(controller.selection?.action, 'fold', 'New bets preserve a valid queued fold')
  ownTurn(view, false)
  assert.equal(controller.take(view, false)?.action.kind, 'fold')
}
for (const state of ['folded', 'allin'] as const) {
  const view = room()
  view.hand!.players[1].streetBet = 5
  view.hand!.players[1][state] = true
  assert.equal(preActionAvailability(view).canCheck, false, `${state} contributions still set the current maximum bet`)
}

for (const action of ['fold', 'check'] as const) {
  const { view, controller } = selected(action)
  assert.equal(controller.take(view, false), null, `${action} waits for the player's actual turn`)
  assert.equal(controller.selection?.action, action)
  ownTurn(view)
  assert.deepEqual(controller.take(view, false), { type: 'action', action: { kind: action }, handNumber: 8, revision: 15 })
  assert.equal(controller.selection, null, 'Selection clears before the async caller receives a command')
  assert.equal(controller.take(view, false), null, 'Identical room polls/effect reruns never replay the command')
  view.actionRevision++
  assert.equal(controller.take(view, false), null, 'Later revisions do not replay a consumed selection')
}

{
  const { view, controller } = selected()
  controller.toggle(view, 'fold')
  assert.equal(controller.selection, null, 'Clicking the selected option cancels it')
  controller.toggle(view, 'fold'); controller.toggle(view, 'check')
  assert.equal(controller.selection?.action, 'check', 'Selecting another option replaces the first')
  controller.cancel(); ownTurn(view)
  assert.equal(controller.take(view, false), null, 'Explicit cancellation prevents submission')
}
{
  const { view, controller } = selected('check')
  ownTurn(view, false)
  assert.equal(controller.take(view, false), null, 'A raise invalidates check; it does not call or fold')
  assert.equal(controller.selection, null)
}
{
  const { view, controller } = selected('fold')
  ownTurn(view, true, false)
  assert.equal(controller.take(view, false), null, 'Fold also respects the fresh legal actions')
  assert.equal(controller.selection, null)
}
{
  const { view, controller } = selected('check')
  view.hand!.street = 'flop'; view.hand!.board = [1, 2, 3]; view.actionRevision += 3
  view.hand!.players.forEach(player => { player.streetBet = 0 })
  assert.equal(controller.take(view, false), null)
  assert.equal(controller.selection?.action, 'check', 'A street change retains the next-decision selection')
  ownTurn(view)
  assert.equal(controller.take(view, false)?.revision, 18, 'Submission uses the current revision, not selection-time revision')
}
{
  const { view, controller } = selected()
  ownTurn(view)
  assert.equal(controller.take(view, true), null, 'An unrelated pending command prevents automatic submission')
  assert.equal(controller.selection?.action, 'fold')
  assert.equal(controller.take(view, false)?.action.kind, 'fold', 'The same fresh turn may execute once busy clears')
  assert.equal(controller.take(view, false), null)
}
{
  const { view, controller } = selected('check')
  ownTurn(view, false)
  assert.equal(controller.take(view, true), null)
  assert.equal(controller.selection, null, 'An illegal check cancels even while busy')
}
{
  const { view, controller } = selected()
  assert.equal(controller.take(view, true), null)
  controller.cancel()
  ownTurn(view)
  assert.equal(controller.take(view, false), null, 'Cancellation while busy prevents later submission')
}
{
  const { view, controller } = selected('check')
  ownTurn(view)
  assert.equal(controller.take(view, true), null)
  view.hand!.legal!.canCheck = false
  view.actionRevision++
  assert.equal(controller.take(view, false), null, 'Legality is checked again when an in-flight command completes')
  assert.equal(controller.selection, null)
}
{
  const { view, controller } = selected()
  ownTurn(view); view.hand!.legal = null
  assert.equal(controller.take(view, false), null, 'Incomplete own-turn snapshots cannot execute')
  ownTurn(view)
  assert.equal(controller.take(view, false)?.action.kind, 'fold')
}

const invalidations: Array<[string, (view: RoomView) => void]> = [
  ['new hand', view => { view.hand!.number++ }],
  ['new room instance', view => { view.instanceId = 'instance-b' }],
  ['different authenticated player', view => { view.selfId = 'other' }],
  ['finished hand', view => { view.hand!.finished = true }],
  ['folded player', view => { view.hand!.players[0].folded = true }],
  ['all-in player', view => { view.hand!.players[0].allin = true }],
  ['zero stack', view => { view.hand!.players[0].stack = 0 }],
  ['sitting out', view => { view.players[0].sittingOut = true }],
  ['away', view => { view.players[0].awayUntil = Date.now() + 60_000 }],
  ['expired away marker', view => { view.players[0].awayUntil = 1 }],
  ['leaving', view => { view.players[0].leaving = true }],
  ['standing', view => { view.players[0].seat = null }],
  ['spectator', view => { view.isSpectator = true }],
  ['absent participant', view => { view.hand!.players = [] }],
  ['absent room member', view => { view.players = [] }],
  ['awaiting runout', view => { view.hand!.awaitingRunout = true }],
  ['runout vote', view => { view.runoutVote = { handNumber: 8, eligibleIds: ['hero'], votes: {}, deadline: 100 } }],
  ['runout playback', view => { view.runoutPlayback = { boardIndex: 0, revealedCount: 3, phase: 'dealing', completedResults: [], nextRevealAt: 100 } }],
  ['settlement', view => { view.settlementAt = 100 }],
  ['no acting player', view => { view.hand!.toAct = null }],
  ['no pending street decision', view => { view.hand!.pendingPlayerIds = ['other'] }],
  ['missing pending queue while waiting', view => { delete view.hand!.pendingPlayerIds }],
  ['no hand', view => { view.hand = null }],
]
for (const [label, invalidate] of invalidations) {
  const { view, controller } = selected()
  invalidate(view)
  assert.equal(controller.take(view, false), null, `${label}: no command`)
  assert.equal(controller.selection, null, `${label}: selection is discarded`)
}
{
  const view = room(), controller = new BattlePreActionController()
  assert.equal(preActionAvailability(view).canSelect, true)
  ownTurn(view)
  assert.equal(preActionAvailability(view).canSelect, false)
  controller.toggle(view, 'fold')
  assert.equal(controller.selection, null, 'The pre-action UI cannot create a new selection during the actual turn')
}
{
  const { view, controller } = selected()
  ownTurn(view)
  let submissions = 0
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const dispatch = () => {
    const command = controller.take(view, false)
    if (!command) return
    submissions++
    assert.equal(controller.take(view, false), null, 'Even synchronous re-entry during dispatch sees consumed state')
    return pending
  }
  const first = dispatch()
  dispatch(); dispatch()
  assert.equal(submissions, 1, 'A pending async submission cannot execute again')
  release(); await first
  dispatch()
  assert.equal(submissions, 1, 'Completion cannot retry the action')
}

console.log('Battle pre-action checks passed: authoritative pending decisions, completed checks/calls/raises, unacted blinds, full raises/short all-in responses, street resets, legacy snapshots, scope and exactly-once consumption.')
