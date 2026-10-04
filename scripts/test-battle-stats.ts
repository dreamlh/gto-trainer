import assert from 'node:assert/strict'
import { addStats, emptyStats, handStats } from '../src/battle/stats'
import { clearBattleProfile, loadBattleProfile, saveBattleProfile } from '../src/battle/localStats'
import type { HandView, RoomView } from '../src/battle/types'

const action = (playerId: string, kind: string, street = 'preflop', amount = 0) => ({ playerId, kind, street, amount })
function completed(history: HandView['history'], overrides: Partial<HandView> = {}): HandView {
  return {
    number: 1, street: 'river', board: [0, 1, 2, 3, 4], boards: [[0, 1, 2, 3, 4]], pot: 10,
    dealerId: 'a', smallBlindId: 'a', bigBlindId: 'b', toAct: null, legal: null,
    players: ['a', 'b', 'c'].map(id => ({ id, cards: null, stack: 100, invested: 5, streetBet: 0, folded: false, allin: false })),
    finished: true, showdown: true, awaitingRunout: false, runCount: 1, delta: { a: 0, b: 0, c: 0 }, history,
    ...overrides,
  }
}

const blinds = [action('a', 'small-blind', 'preflop', 0.5), action('b', 'big-blind', 'preflop', 1)]
const blindOnly = handStats(completed([...blinds, action('b', 'check')]), 'b')
assert.equal(blindOnly.vpip, 0, 'Posting a blind and checking is not VPIP')
assert.equal(blindOnly.pfr, 0)
assert.equal(blindOnly.threeBetOpportunities, 0)
const entryBlindOnly = handStats(completed([...blinds, action('c', 'entry-blind', 'preflop', 1), action('c', 'check')]), 'c')
assert.equal(entryBlindOnly.vpip, 0, 'An entry big blind is forced money, not VPIP')
assert.equal(entryBlindOnly.pfr, 0, 'Posting to join a running table is not a raise')
assert.equal(entryBlindOnly.threeBetOpportunities, 0, 'Entry blinds do not create raise opportunities')

const squeeze = handStats(completed([action('a', 'raise'), action('b', 'call'), action('c', 'raise')]), 'c')
assert.equal(squeeze.threeBet, 1)
assert.equal(squeeze.threeBetOpportunities, 1, 'A squeeze faces one raise and is a 3-bet opportunity')
assert.equal(squeeze.vpip, 1)
assert.equal(squeeze.pfr, 1)
const fourBet = handStats(completed([action('a', 'raise'), action('b', 'raise'), action('a', 'raise')]), 'a')
assert.equal(fourBet.threeBet, 0)
assert.equal(fourBet.threeBetOpportunities, 0, 'An opener facing a 3-bet faces a 4-bet opportunity')
const limpRaise = handStats(completed([action('a', 'call'), action('b', 'raise'), action('a', 'raise')]), 'a')
assert.equal(limpRaise.threeBetOpportunities, 1)
assert.equal(limpRaise.threeBet, 1)
const coldCall = handStats(completed([action('a', 'raise'), action('b', 'call'), action('c', 'raise'), action('b', 'call')]), 'b')
assert.equal(coldCall.threeBetOpportunities, 1, 'Only the first-raise decision is counted')
assert.equal(coldCall.threeBet, 0)

const cbet = handStats(completed([action('a', 'raise'), action('b', 'call'), action('b', 'check', 'flop'), action('a', 'raise', 'flop'), action('a', 'call', 'turn')]), 'a')
assert.equal(cbet.cbetOpportunities, 1)
assert.equal(cbet.cbet, 1)
assert.equal(cbet.betsRaises, 1, 'AF excludes preflop raises')
assert.equal(cbet.calls, 1)
const donk = handStats(completed([action('a', 'raise'), action('b', 'call'), action('b', 'raise', 'flop'), action('a', 'raise', 'flop')]), 'a')
assert.equal(donk.cbetOpportunities, 0, 'Facing a donk bet removes the c-bet opportunity')
const delayed = handStats(completed([action('a', 'raise'), action('b', 'call'), action('a', 'check', 'flop'), action('b', 'raise', 'flop'), action('a', 'raise', 'flop')]), 'a')
assert.equal(delayed.cbetOpportunities, 1)
assert.equal(delayed.cbet, 0, 'A check-raise after declining the first c-bet is not a c-bet')

const allin = handStats(completed([action('a', 'raise'), action('b', 'call')], { runCount: 3 }), 'a')
assert.equal(allin.hands, 1, 'Three runouts still count as one hand')
assert.equal(allin.sawFlop, 1)
assert.equal(allin.showdowns, 1)
assert.equal(allin.cbetOpportunities, 0, 'An all-in runout provides no flop action opportunity')
assert.equal(allin.showdownWins, 1, 'A split pot counts as won at showdown')
const sidePot = handStats(completed([], { delta: { a: -3 } }), 'a')
assert.equal(sidePot.showdownWins, 1, 'Any returned contested share counts even with negative net winnings')
assert.equal(handStats(completed([], { delta: { a: -5 } }), 'a').showdownWins, 0)
const tournamentLoss = handStats(completed([], { bigBlind: 10, delta: { a: -5 } }), 'a')
assert.equal(tournamentLoss.netBB, -0.5, 'Tournament net BB divides fixed chip winnings by that hand’s actual big blind')
assert.equal(tournamentLoss.showdownWins, 0, 'A scaled negative BB result cannot incorrectly count a lost showdown as won')
assert.equal(handStats(completed([], { bigBlind: 10, delta: { a: -3 } }), 'a').showdownWins, 1, 'Fixed-unit side-pot returns still count as showdown wins at higher blind levels')
assert.equal(handStats(completed([action('a', 'fold')]), 'a').sawFlop, 0)
assert.deepEqual(handStats(completed([], { finished: false }), 'a'), emptyStats())
assert.deepEqual(handStats(completed([]), 'spectator'), emptyStats())
assert.equal(addStats(cbet, allin).hands, 2)

// Browser storage is mocked at its public API; keep the profile logic real.
const storage = new Map<string, string>()
let failWrites = false
Object.defineProperty(globalThis, 'localStorage', { value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { if (failWrites) throw new Error('quota'); storage.set(key, value) },
  removeItem: (key: string) => storage.delete(key),
}, configurable: true })
function room(instanceId: string, selfId: string, hands: number, netBB = 0): RoomView {
  return {
    instanceId, selfId, players: [{ id: selfId, bot: false, stats: { ...emptyStats(), hands, vpip: hands, netBB } }],
  } as RoomView
}
clearBattleProfile()
saveBattleProfile(room('session-1', 'a', 4, -2))
saveBattleProfile(room('session-1', 'a', 4, -2))
saveBattleProfile(room('session-1', 'a', 2, 30))
assert.equal(loadBattleProfile().stats.hands, 4, 'Polling and stale snapshots do not double-count')
assert.equal(loadBattleProfile().stats.netBB, -2)
saveBattleProfile(room('session-1', 'a', 5, 7))
assert.equal(loadBattleProfile().stats.hands, 5)
assert.equal(loadBattleProfile().stats.netBB, 7, 'Cumulative snapshots replace previous totals')
saveBattleProfile(room('session-1', 'a', 5, 7))
assert.equal(loadBattleProfile().profiles, 1, 'Returning with the same ID inherits without duplicating')
saveBattleProfile(room('session-2', 'a', 2, 1))
saveBattleProfile(room('session-1', 'new-id', 1, -1))
assert.equal(loadBattleProfile().stats.hands, 8, 'New room instance and new ID preserve separate snapshots')
assert.equal(loadBattleProfile().stats.netBB, 7)
assert.equal(loadBattleProfile().profiles, 3)
assert.equal(JSON.parse(storage.values().next().value!).snapshots.length, 3, 'Snapshots are written to persistent storage')
failWrites = true
assert.equal(saveBattleProfile(room('session-2', 'a', 3, 2)), false)
assert.equal(loadBattleProfile().storageAvailable, false, 'Persistence failures are surfaced')
assert.equal(loadBattleProfile().stats.hands, 9, 'Memory fallback retains current page data')
failWrites = false
assert.equal(saveBattleProfile(room('session-2', 'a', 3, 2)), true, 'Unchanged snapshots retry after a write failure')
assert.equal(loadBattleProfile().stats.hands, 9, 'Retrying a failed write does not duplicate the snapshot')
assert.equal(JSON.parse(storage.values().next().value!).snapshots.length, 3)
console.log('Battle stats: opportunity definitions, showdown counts, snapshots, deduplication and storage fallback passed.')

const profileKey = 'gto.battle.profile.v1'
const beforeClear = storage.get(profileKey)!
clearBattleProfile()
assert.deepEqual(loadBattleProfile().stats, emptyStats(), 'Clearing resets all displayed metrics')
assert.equal(loadBattleProfile().profiles, 0, 'Cleared rooms are not counted as active history')
assert.equal(JSON.parse(storage.get(profileKey)!).snapshots.length, 3, 'Clear retains room/player tombstones')
saveBattleProfile(room('session-1', 'a', 5, 7))
saveBattleProfile(room('session-1', 'a', 5, 99))
saveBattleProfile(room('session-2', 'a', 2, 1))
assert.deepEqual(loadBattleProfile().stats, emptyStats(), 'Current, amended same-hand and older polls cannot restore cleared history')
saveBattleProfile(room('session-1', 'a', 6, 4))
assert.equal(loadBattleProfile().stats.hands, 1)
assert.equal(loadBattleProfile().stats.vpip, 1)
assert.equal(loadBattleProfile().stats.netBB, -3, 'Only winnings since the clear are included')
saveBattleProfile(room('session-3', 'a', 2, 6))
assert.equal(loadBattleProfile().stats.hands, 3, 'A new room instance begins normally')
assert.equal(loadBattleProfile().profiles, 2)

// Independent ES module instances model another tab and a browser reload.
const reloaded = await import('../src/battle/localStats.ts?profile-test=reload')
assert.equal(reloaded.loadBattleProfile().stats.hands, 3, 'Baselines survive a page reload')
reloaded.clearBattleProfile()
assert.equal(loadBattleProfile().stats.hands, 0, 'An old tab merges a clear performed by another tab')
saveBattleProfile(room('session-1', 'a', 6, 4))
assert.equal(reloaded.loadBattleProfile().stats.hands, 0, 'The old tab cannot overwrite the other tab’s tombstones')
saveBattleProfile(room('session-1', 'a', 7, 8))
assert.equal(reloaded.loadBattleProfile().stats.hands, 1)
assert.equal(reloaded.loadBattleProfile().stats.netBB, 4)

const eventTarget = new EventTarget()
Object.defineProperty(globalThis, 'window', { value: eventTarget, configurable: true })
let updates = 0
const unsubscribe = reloaded.subscribeBattleProfile(() => { updates += 1 })
const clearedWrite = storage.get(profileKey)!
// Simulate a stale cross-tab write racing with a clear, then its storage event.
storage.set(profileKey, beforeClear)
const storageEvent = new Event('storage')
Object.assign(storageEvent, { key: profileKey, newValue: clearedWrite })
eventTarget.dispatchEvent(storageEvent)
assert.equal(updates, 1, 'Cross-tab storage updates notify the dashboard')
assert.equal(reloaded.loadBattleProfile().stats.hands, 1, 'Delayed events repair a raced stale write without resurrecting history')
assert.equal(JSON.parse(storage.get(profileKey)!).snapshots.find((s: { instanceId: string; playerId: string }) => s.instanceId === 'session-1' && s.playerId === 'a').baseline.hands, 6)
unsubscribe()

failWrites = true
clearBattleProfile()
assert.equal(loadBattleProfile().stats.hands, 0, 'Failed clear persistence still clears this page')
assert.equal(loadBattleProfile().storageAvailable, false)
failWrites = false
saveBattleProfile(room('session-1', 'a', 7, 8))
assert.equal(loadBattleProfile().stats.hands, 0, 'A later successful poll persists the clear instead of restoring totals')
const afterRetry = await import('../src/battle/localStats.ts?profile-test=after-retry')
assert.equal(afterRetry.loadBattleProfile().stats.hands, 0)
saveBattleProfile(room('session-1', 'a', 8, 6))
assert.equal(afterRetry.loadBattleProfile().stats.netBB, -2)
console.log('Battle profile clearing: tombstones, post-clear deltas, same-hand polls, reloads, stale-tab races and failed-write recovery passed.')

saveBattleProfile({ ...room('corrected-room', 'a', 4, 10), revision: 12 })
clearBattleProfile()
saveBattleProfile({ ...room('corrected-room', 'a', 4, 12), revision: 14 })
saveBattleProfile({ ...room('corrected-room', 'a', 4, 10), revision: 12 })
assert.equal(loadBattleProfile().stats.hands, 0, 'A newer score for an already cleared hand remains cleared')
saveBattleProfile({ ...room('corrected-room', 'a', 5, 15), revision: 15 })
assert.equal(loadBattleProfile().stats.netBB, 3, 'The later hand excludes an old hand’s score correction')
assert.equal(loadBattleProfile().stats.hands, 1)

storage.set(profileKey, JSON.stringify({ version: 1, snapshots: [{ instanceId: 'legacy', playerId: 'a', stats: { ...emptyStats(), hands: 8, vpip: 3, netBB: -4 } }] }))
const migrated = await import('../src/battle/localStats.ts?profile-test=migration')
assert.equal(migrated.loadBattleProfile().stats.hands, 8, 'Version 1 history migrates without losing totals')
assert.equal(migrated.loadBattleProfile().stats.vpip, 3)
migrated.clearBattleProfile()
migrated.saveBattleProfile({ ...room('legacy', 'a', 9, -1), players: [{ id: 'a', bot: false, stats: { ...emptyStats(), hands: 9, vpip: 3, netBB: -1 } }] } as RoomView)
assert.equal(migrated.loadBattleProfile().stats.hands, 1)
assert.equal(migrated.loadBattleProfile().stats.vpip, 0, 'Counters subtract independently from their baseline')
assert.equal(migrated.loadBattleProfile().stats.netBB, 3)
console.log('Battle profile migration and revision-aware score corrections passed.')
