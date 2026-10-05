import assert from 'node:assert/strict'
import { BattleRoom } from '../server/room'
import type { RoomSession, RoomView } from '../src/battle/types'

type Reply = { room?: RoomView; session?: RoomSession; receipt?: RoomSession; left?: boolean; error?: string }
const realNow = Date.now
let now = 1_800_000_000_000
Date.now = () => now

class RoomHarness {
  values = new Map<string, unknown>()
  ready: Promise<unknown> = Promise.resolve()
  room: BattleRoom
  constructor() {
    const storage = {
      get: async (key: string) => structuredClone(this.values.get(key)),
      put: async (key: string, value: unknown) => { this.values.set(key, structuredClone(value)) },
      setAlarm: async () => {}, deleteAlarm: async () => {},
      deleteAll: async () => { this.values.clear() },
      delete: async (key: string) => this.values.delete(key),
    }
    const ctx = { storage, blockConcurrencyWhile: (callback: () => Promise<unknown>) => {
      const pending = callback()
      this.ready = pending
      return pending
    } }
    this.room = new BattleRoom(ctx as never)
  }
  async call(operation: string, body?: object, session?: RoomSession, expected = 200): Promise<Reply> {
    await this.ready
    const response = await this.room.fetch(new Request(`https://room.internal/ABCDEFGH/${operation}`, {
      method: body ? 'POST' : 'GET',
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(session ? { Authorization: `Bearer ${session.token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }))
    const payload = await response.json() as Reply
    assert.equal(response.status, expected, `${operation}: ${JSON.stringify(payload)}`)
    return payload
  }
  async create(capacity = 3) {
    return this.call('create', { name: 'Alice', playerId: 'AAA', capacity, initialStack: 20 })
  }
  async join(id: string, name = id) { return this.call('join', { name, playerId: id }) }
  async command(session: RoomSession, body: object, expected = 200) { return this.call('command', body, session, expected) }
  async view(session: RoomSession) { return (await this.call('view', undefined, session)).room! }
  async settle(session: RoomSession) {
    const room = await this.view(session)
    if (room.hand?.finished && room.settlementAt) now = room.settlementAt
    return this.view(session)
  }
  async action(session: RoomSession, action: object) {
    const room = await this.view(session)
    return this.command(session, { type: 'action', handNumber: room.hand!.number, revision: room.actionRevision, action })
  }
}

let passed = 0
const failures: string[] = []
async function test(name: string, run: () => Promise<void>) {
  try { await run(); passed++; console.log(`PASS ${name}`) }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${(error as Error).message}`) }
}

await test('cash stacks and statistics survive normalized nickname rejoin; new nicknames begin fresh', async () => {
  const h = new RoomHarness(), alice = (await h.create(2)).session!, bob = (await h.join('BBB')).session!
  await h.command(bob, { type: 'sit', seat: 1 })
  await h.command(alice, { type: 'start' })
  await h.action(alice, { kind: 'fold' })
  await h.settle(alice)
  const settled = await h.view(alice)
  const before = settled.players.find(p => p.id === alice.playerId)!
  assert.equal(before.stack, 19.5)
  assert.equal(before.stats.hands, 1)
  assert.equal(before.stats.netBB, -0.5)
  await h.command(alice, { type: 'leave' })
  await h.call('view', undefined, alice, 401)
  const returned = await h.join('other-id', ' alice ')
  assert.notEqual(returned.session!.token, alice.token)
  const inherited = returned.room!.players.find(p => p.id === alice.playerId)!
  assert.equal(inherited.stack, before.stack)
  assert.deepEqual(inherited.stats, before.stats)
  assert.equal(inherited.seat, null)
  assert.equal(inherited.sittingOut, true)
  const newPlayer = await h.join('NEW')
  const fresh = newPlayer.room!.players.find(p => p.id === newPlayer.session!.playerId)!
  assert.equal(fresh.stack, 20)
  assert.equal(fresh.stats.hands, 0)
  await h.call('join', { name: 'bbb', playerId: 'other-id' }, undefined, 409)
})

await test('spectator cards require individual opt-in; standing participants remain opponents', async () => {
  const h = new RoomHarness(), alice = (await h.create(3)).session!, bob = (await h.join('BBB')).session!, observer = (await h.join('OBS')).session!
  await h.command(bob, { type: 'sit', seat: 1 })
  await h.command(alice, { type: 'start' })
  let watch = await h.view(observer)
  assert(watch.isSpectator)
  assert(watch.hand!.players.every(p => p.cards === null))
  await h.command(alice, { type: 'spectator-cards', show: true })
  watch = await h.view(observer)
  assert(watch.hand!.players.find(p => p.id === alice.playerId)!.cards?.every(card => card !== null))
  assert.equal(watch.hand!.players.find(p => p.id === bob.playerId)!.cards, null)
  const opponent = await h.view(bob)
  assert.equal(opponent.hand!.players.find(p => p.id === alice.playerId)!.cards, null)
  await h.command(bob, { type: 'spectator-cards', show: true })
  await h.action(alice, { kind: 'call' })
  await h.command(alice, { type: 'stand' })
  const standing = await h.view(alice)
  assert.equal(standing.isSpectator, false)
  assert.equal(standing.hand!.players.find(p => p.id === bob.playerId)!.cards, null)
  assert.equal(standing.hand!.legal, null)
})

await test('seat reservation replaces a bot only after the hand settles', async () => {
  const h = new RoomHarness(), alice = (await h.create(3)).session!, bob = (await h.join('BBB')).session!, guest = (await h.join('CCC')).session!
  await h.command(bob, { type: 'sit', seat: 1 })
  const added = (await h.command(alice, { type: 'add-bot', seat: 2 })).room!
  const botId = added.seats[2]!
  await h.command(alice, { type: 'start' })
  const reserved = (await h.command(guest, { type: 'sit', seat: 2 })).room!
  assert.equal(reserved.seats[2], botId)
  assert.equal(reserved.reservations[2], guest.playerId)
  assert(!reserved.hand!.players.some(p => p.id === guest.playerId))
  await h.action(alice, { kind: 'fold' })
  await h.settle(alice)
  await h.action(bob, { kind: 'fold' })
  await h.settle(bob)
  const settled = await h.view(guest)
  assert.equal(settled.seats[2], guest.playerId)
  assert.equal(settled.reservations[2], null)
  assert.equal(settled.players.find(p => p.id === botId)!.leaving, true)
  assert.equal(settled.players.find(p => p.id === botId)!.stats.hands, 1)
  assert.equal(settled.players.find(p => p.id === guest.playerId)!.stats.hands, 0)
})

await test('departed receipts cannot act and recover a final all-in result after room dissolution', async () => {
  const h = new RoomHarness(), alice = (await h.create(3)).session!, bob = (await h.join('BBB')).session!, carol = (await h.join('CCC')).session!
  await h.command(bob, { type: 'sit', seat: 1 })
  await h.command(carol, { type: 'sit', seat: 2 })
  await h.command(alice, { type: 'start' })
  await h.action(alice, { kind: 'raise', to: 20 })
  await h.action(bob, { kind: 'call' })
  await h.action(carol, { kind: 'call' })
  assert((await h.view(alice)).runoutVote)
  const leftA = await h.command(alice, { type: 'leave' })
  assert(leftA.receipt)
  assert.equal(leftA.room!.players.find(p => p.id === alice.playerId)!.stats.hands, 0)
  await h.command(leftA.receipt!, { type: 'chat', text: 'Cannot send' }, 401)
  const leftB = await h.command(bob, { type: 'leave' })
  assert(leftB.receipt)
  const leftC = await h.command(carol, { type: 'leave' })
  assert(leftC.left)
  assert.equal(leftC.room!.players.find(p => p.id === carol.playerId)!.stats.hands, 1)
  const receiptA = await h.view(leftA.receipt!)
  assert.equal(receiptA.players.find(p => p.id === alice.playerId)!.stats.hands, 1)
  assert.equal(receiptA.players.length, 1, 'Final delivery contains only the departing player')
  assert.equal(receiptA.hand, null, 'No hand or other players are retained after room dissolution')
  assert.deepEqual(receiptA.chat, [])
  assert.deepEqual(receiptA.revealed, {})
  const oldInstance = receiptA.instanceId
  const newRoom = await h.create(3)
  assert.notEqual(newRoom.room!.instanceId, oldInstance)
  assert.equal(newRoom.room!.players.find(p => p.id === newRoom.session!.playerId)!.stats.hands, 0)
  assert.equal((await h.view(leftB.receipt!)).instanceId, oldInstance, 'Old receipts must stay isolated from the new room')
  now += 120_001
  await h.call('view', undefined, leftA.receipt!, 401)
  assert.equal(Object.keys(h.values.get('receipts') as object).length, 0, 'Expired delivery data is removed')
})

await test('an inactive nickname can be reclaimed after grace without resetting cash or statistics', async () => {
  const h = new RoomHarness(), alice = (await h.create(2)).session!, bob = (await h.join('BBB')).session!
  await h.command(bob, { type: 'sit', seat: 1 })
  await h.command(alice, { type: 'start' })
  await h.action(alice, { kind: 'fold' })
  await h.settle(alice)
  const before = (await h.view(alice)).players.find(p => p.id === alice.playerId)!
  now += 61_000
  const current = await h.view(bob)
  const liveChips = current.players.find(p => p.id === alice.playerId)!.stack
  const reclaimed = await h.join('AAA', 'Alice')
  const player = reclaimed.room!.players.find(p => p.id === alice.playerId)!
  assert.equal(player.stats.hands, before.stats.hands)
  assert.equal(player.stack, liveChips, 'Any blind already posted to an active hand stays invested')
  assert.equal(player.seat, null)
  assert.equal(player.sittingOut, true)
  await h.call('view', undefined, alice, 401)
  assert.equal(reclaimed.room!.hand!.legal, null)
  assert.equal(reclaimed.room!.hand!.players.find(p => p.id === alice.playerId)!.cards, null, 'Reclaiming an ID cannot reveal the old in-progress hand')
})

await test('a reduced heads-up table admits its waiting player as the big blind', async () => {
  const h = new RoomHarness(), alice = (await h.create(3)).session!, bob = (await h.join('BBB')).session!, carol = (await h.join('CCC')).session!
  await h.command(bob, { type: 'sit', seat: 1 })
  await h.command(carol, { type: 'sit', seat: 2 })
  await h.command(alice, { type: 'start' })
  assert.equal((await h.view(alice)).hand!.bigBlindId, carol.playerId)
  await h.action(alice, { kind: 'fold' })
  await h.settle(alice)
  await h.action(bob, { kind: 'fold' })
  await h.settle(bob)
  await h.command(carol, { type: 'stand' })
  await h.command(bob, { type: 'stand' })
  const waiting = (await h.command(bob, { type: 'sit', seat: 1 })).room!
  assert.equal(waiting.players.find(p => p.id === alice.playerId)!.entryStatus, 'ready')
  assert.equal(waiting.players.find(p => p.id === bob.playerId)!.entryStatus, 'waiting')
  assert.equal(waiting.hand!.number, 1)
  // Normal clockwise movement from Carol's seat 2 would put Alice in the BB.
  // That cannot exclude Bob forever: restart heads-up with Bob posting his BB.
  now += 3_001
  const restarted = await h.view(alice)
  assert.equal(restarted.hand!.number, 2, 'The next hand starts automatically after the result window')
  assert.equal(restarted.hand!.finished, false)
  assert.equal(restarted.hand!.players.length, 2)
  assert.equal(restarted.hand!.bigBlindId, bob.playerId)
  assert.equal(restarted.hand!.smallBlindId, alice.playerId)
  assert.equal(restarted.players.find(p => p.id === bob.playerId)!.entryStatus, 'ready')
  assert.equal(restarted.hand!.history.find(action => action.kind === 'big-blind')!.amount, 1)
})

await test('all-waiting seats do not repeatedly schedule hands that cannot start', async () => {
  const h = new RoomHarness(), alice = (await h.create(2)).session!, bob = (await h.join('BBB')).session!
  await h.command(bob, { type: 'sit', seat: 1 })
  await h.command(alice, { type: 'start' })
  await h.action(alice, { kind: 'fold' })
  await h.settle(alice)
  await h.command(alice, { type: 'stand' })
  await h.command(alice, { type: 'sit', seat: 0 })
  await h.command(bob, { type: 'stand' })
  await h.command(bob, { type: 'sit', seat: 1 })
  now += 3_001
  let waiting = await h.view(alice)
  assert.equal(waiting.hand!.number, 1)
  assert.equal(waiting.nextHandAt, null, 'No failed-deal timer is rearmed while every seat is waiting')
  now += 3_001
  waiting = await h.view(bob)
  assert.equal(waiting.nextHandAt, null)
  assert.equal(waiting.hand!.number, 1)
})

await test('a reclaimed nickname cannot vote on the previous owner’s in-progress runout', async () => {
  const h = new RoomHarness(), alice = (await h.create(3)).session!, bob = (await h.join('BBB')).session!, carol = (await h.join('CCC')).session!
  await h.command(bob, { type: 'sit', seat: 1 })
  await h.command(carol, { type: 'sit', seat: 2 })
  await h.command(alice, { type: 'start' })
  await h.action(alice, { kind: 'raise', to: 20 })
  await h.command(bob, { type: 'time-card', handNumber: 1 })
  // Alice stops polling. Bob's valid extended turn delays the runout vote,
  // so the 60s identity grace expires while the 15s runout vote is still open.
  now += 50_000
  await h.action(bob, { kind: 'call' })
  const voting = (await h.action(carol, { kind: 'call' })).room!
  assert(voting.runoutVote)
  assert.equal(voting.runoutVote!.votes[alice.playerId], undefined)
  now += 11_000
  const reclaimed = await h.join('new-id', ' ALICE ')
  assert.equal(reclaimed.room!.isSpectator, true)
  assert.equal(reclaimed.room!.runoutVote!.votes[alice.playerId], 1, 'Reclaim defaults the old hand to one runout')
  await h.command(reclaimed.session!, { type: 'runouts', handNumber: 1, count: 3 }, 409)
  await h.command(bob, { type: 'runouts', handNumber: 1, count: 3 })
  let finished = (await h.command(carol, { type: 'runouts', handNumber: 1, count: 2 })).room!
  while (finished.runoutPlayback) {
    now = finished.runoutPlayback.nextRevealAt
    finished = await h.view(carol)
  }
  assert.equal(finished.hand!.finished, true)
  assert.equal(finished.hand!.runCount, 1, 'The old hand keeps the departing owner’s default, not the new spectator’s choice')
  assert.equal((await h.view(reclaimed.session!)).handHistory![0].myCards, undefined, 'Do not archive the previous owner cards under reclaimed credentials')
})

await test('host fills empty lobby seats once and cannot batch fill after starting', async () => {
  const h = new RoomHarness(), alice = (await h.create(5)).session!, bob = (await h.join('Bob')).session!
  await h.command(bob, { type: 'sit', seat: 1 })
  await h.command(bob, { type: 'fill-bots' }, 403)
  const filled = (await h.command(alice, { type: 'fill-bots' })).room!
  assert.equal(filled.seats[0], alice.playerId)
  assert.equal(filled.seats[1], bob.playerId)
  const bots = filled.players.filter(p => p.bot)
  assert.equal(bots.length, 3)
  assert.deepEqual(bots.map(p => p.seat), [2, 3, 4])
  assert.equal(new Set(bots.map(p => p.name)).size, 3)
  const again = (await h.command(alice, { type: 'fill-bots' })).room!
  assert.equal(again.players.filter(p => p.bot).length, 3, 'Repeated lobby commands are idempotent')
  await h.command(alice, { type: 'start' })
  await h.command(alice, { type: 'add-seat' })
  const before = await h.view(alice)
  const rejected = await h.command(alice, { type: 'fill-bots' }, 409)
  assert.match(rejected.error!, /开始对战前/)
  const after = await h.view(alice)
  assert.deepEqual(after.seats, before.seats, 'The empty seat stays empty after rejection')
  assert.deepEqual(after.hand, before.hand, 'Rejection does not change the active hand')
  assert.equal(after.players.filter(p => p.bot).length, 3)
})

await test('lobby fill seats all bots immediately and honors tournament registration closure', async () => {
  const h = new RoomHarness()
  const alice = (await h.call('create', { name: 'Alice', capacity: 6, initialStack: 100, mode: 'tournament', registrationRaises: 0 })).session!
  const filled = (await h.command(alice, { type: 'fill-bots' })).room!
  assert.equal(filled.players.filter(p => p.bot).length, 5)
  assert(filled.seats.every(Boolean))
  assert(filled.reservations.every(id => id === null))
  await h.command(alice, { type: 'start' })
  await h.command(alice, { type: 'fill-bots' }, 409)
})

await test('folded historical hole cards are owner-only and nickname reclaims cannot recover them', async () => {
  const h = new RoomHarness(), alice = (await h.create(2)).session!, bob = (await h.join('Bob')).session!, observer = (await h.join('Observer')).session!
  await h.command(bob, { type: 'sit', seat: 1 })
  await h.command(alice, { type: 'start' })
  const original = (await h.view(alice)).hand!.players.find(p => p.id === alice.playerId)!.cards
  const bobCards = (await h.view(bob)).hand!.players.find(p => p.id === bob.playerId)!.cards
  await h.action(alice, { kind: 'fold' })
  await h.settle(alice)
  const a = (await h.view(alice)).handHistory![0]
  const b = (await h.view(bob)).handHistory![0]
  assert.deepEqual(a.myCards, original)
  assert.equal(a.replay?.version, 1)
  assert.equal(a.replay?.mode, 'cash')
  assert.deepEqual(Object.values(a.replay!.startingStacks), [20, 20])
  assert.deepEqual(b.myCards, bobCards)
  const publicHand = (await h.view(observer)).handHistory![0]
  assert.equal(publicHand.myCards, undefined)
  assert(!JSON.stringify(a).includes('privateCards'))
  assert(!JSON.stringify(a).includes(alice.token))
  assert(a.players.every(p => !!p.position))
  await h.command(alice, { type: 'leave' })
  const reclaimed = await h.join('another-id', 'Alice')
  assert.equal(reclaimed.room!.handHistory![0].myCards, undefined)
})

Date.now = realNow
console.log(`Room review: ${passed} passed; ${failures.length} failed.`)
if (failures.length) process.exitCode = 1
