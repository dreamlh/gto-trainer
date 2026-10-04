// Default: deterministic HTTP/API tests with the real room implementation and a
// serialized DurableObject/storage harness. No local server or elapsed-hour wait.
// BATTLE_BASE_URL=http://127.0.0.1:8787 runs the public API checks against a live server.
// BATTLE_TEST_PERSISTENCE=1 additionally checks a real SQLite-backed worker restart.
import assert from 'node:assert/strict'
import worker, { BattleRoom } from '../server/index'
import { startHand } from '../src/battle/game'
import { fullDeck, parseCard, type Card } from '../src/poker/cards'
import type { BattleAction, RoomCommand, RoomSession, RoomView } from '../src/battle/types'

const external = process.env.BATTLE_BASE_URL
const baseUrl = (external ?? 'http://localhost').replace(/\/$/, '')
const sessions: RoomSession[] = []
let checks = 0
const realNow = Date.now
let now = realNow()
if (!external) Date.now = () => now

class TestStorage {
  values = new Map<string, unknown>()
  alarm: number | null = null
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.values.get(key)) as T | undefined }
  async put(key: string, value: unknown) { this.values.set(key, structuredClone(value)) }
  async setAlarm(value: number) { this.alarm = value }
  async deleteAlarm() { this.alarm = null }
  async deleteAll() { this.values.clear() }
}
class TestContext {
  storage = new TestStorage()
  queue: Promise<unknown> = Promise.resolve()
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    const result = this.queue.then(callback)
    this.queue = result.catch(() => {})
    return result
  }
}
const objects = new Map<string, { ctx: TestContext; object: BattleRoom }>()
const env = {
  ROOMS: {
    idFromName: (name: string) => name,
    get: (id: string) => ({ fetch: (request: Request) => {
      let room = objects.get(id)
      if (!room) {
        const ctx = new TestContext()
        room = { ctx, object: new BattleRoom(ctx as never) }
        objects.set(id, room)
      }
      return room.object.fetch(request)
    } }),
  },
  ASSETS: { fetch: () => new Response('No static assets in API tests', { status: 404 }) },
}
function check(condition: unknown, message: string): asserts condition {
  assert.ok(condition, message); checks++; console.log(`✓ ${message}`)
}
async function rawRequest(path: string, init: RequestInit = {}) {
  const response = external
    ? await fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(10_000) })
    : await worker.fetch(new Request(`${baseUrl}${path}`, init), env as never)
  const data = await response.json() as any
  return { status: response.status, data, headers: response.headers }
}
function request(path: string, method = 'GET', body?: unknown, token?: string) {
  return rawRequest(path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
function success(result: Awaited<ReturnType<typeof request>>, context: string) {
  assert.ok(result.status >= 200 && result.status < 300, `${context}: HTTP ${result.status}: ${JSON.stringify(result.data)}`)
  return result.data
}
async function reject(path: string, body: unknown, token: string | undefined, message: string, status?: number) {
  const result = await request(path, body === undefined ? 'GET' : 'POST', body, token)
  check(status === undefined ? result.status >= 400 && result.status < 500 : result.status === status, `${message} (HTTP ${result.status})`)
}
const roomPath = (s: RoomSession) => `/api/rooms/${s.code}`
const commandPath = (s: RoomSession) => `${roomPath(s)}/command`
async function create(name: string, capacity = 2, initialStack?: number, playerId?: string, settings: Record<string, unknown> = {}): Promise<RoomSession> {
  const data = success(await request('/api/rooms', 'POST', { name, capacity, initialStack, playerId, ...settings }), 'create')
  sessions.push(data.session); return data.session
}
async function join(host: RoomSession, name: string, playerId?: string): Promise<RoomSession> {
  const data = success(await request(`${roomPath(host)}/join`, 'POST', { name, playerId }), 'join')
  sessions.push(data.session); return data.session
}
async function read(session: RoomSession): Promise<RoomView> { return success(await request(roomPath(session), 'GET', undefined, session.token), 'read').room }
async function command(session: RoomSession, body: RoomCommand): Promise<RoomView> { return success(await request(commandPath(session), 'POST', body, session.token), body.type).room }
async function leave(session: RoomSession) { success(await request(commandPath(session), 'POST', { type: 'leave' }, session.token), 'leave') }
function action(room: RoomView, action: BattleAction): RoomCommand {
  assert.ok(room.hand); return { type: 'action', action, revision: room.actionRevision, handNumber: room.hand.number }
}
function player(room: RoomView, id: string) { return room.players.find(p => p.id === id)! }
function handPlayer(room: RoomView, id: string) { return room.hand!.players.find(p => p.id === id)! }
function noSecrets(room: RoomView) {
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!/^(deck|deckPosition|token|tokens|session|sessions|cardGrantAt)$/i.test(key), `public room leaks ${key}`)
      visit(child)
    }
  }
  visit(room)
  if (!room.hand) return
  for (const p of room.hand.players) {
    const member = player(room, p.id)
    const own = p.id === room.selfId && !room.isSpectator
    const automatic = (room.hand.finished && (member.bot || (room.hand.showdown && !p.folded))) || (!!room.runoutPlayback && !p.folded)
    const liveShare = !room.hand.finished && room.isSpectator && member.shareWithSpectators && !member.bot
    if (own || automatic || liveShare) assert.ok(p.cards?.every(card => card !== null), 'permitted cards visible')
    else if ((room.hand.finished || room.runoutPlayback) && room.revealed[p.id]?.length) {
      assert.deepEqual(p.cards?.map(card => card !== null), [0, 1].map(index => room.revealed[p.id].includes(index)))
    } else assert.equal(p.cards, null, 'unpermitted opponent cards hidden')
  }
}
function zeroSum(room: RoomView) {
  assert.ok(room.hand?.finished && room.hand.delta)
  assert.equal(Object.values(room.hand.delta).reduce((sum, delta) => sum + delta, 0), 0)
}
async function advance(ms: number) {
  if (external) await new Promise(resolve => setTimeout(resolve, ms))
  else now += ms
}
async function finishSettlement(session: RoomSession): Promise<RoomView> {
  const room = await read(session)
  if (room.hand?.finished && room.settlementAt) await advance(Math.max(0, room.settlementAt - Date.now()))
  return read(session)
}
async function finishPlayback(session: RoomSession): Promise<RoomView> {
  let room = await read(session)
  for (let step = 0; room.runoutPlayback && step < 30; step++) {
    await advance(Math.max(0, room.runoutPlayback.nextRevealAt - Date.now()))
    room = await read(session)
  }
  assert.equal(room.runoutPlayback, null)
  return finishSettlement(session)
}
async function restore(session: RoomSession, change?: (saved: any) => void) {
  assert.ok(!external)
  const item = objects.get(session.code)!
  await item.ctx.queue
  if (change) {
    const saved = await item.ctx.storage.get<any>('room')
    change(saved)
    await item.ctx.storage.put('room', saved)
  }
  item.object = new BattleRoom(item.ctx as never)
  await item.ctx.queue
}
async function passive(host: RoomSession, humans: RoomSession[], runCount: 1 | 2 | 3 = 1): Promise<RoomView> {
  for (let steps = 0; steps < 300; steps++) {
    const room = await read(host); noSecrets(room)
    assert.ok(room.hand)
    if (room.hand.finished) return finishSettlement(host)
    if (room.runoutVote) {
      for (const id of room.runoutVote.eligibleIds.filter(id => !room.runoutVote!.votes[id])) {
        const voter = humans.find(s => s.playerId === id)
        if (voter) await command(voter, { type: 'runouts', count: runCount, handNumber: room.hand.number })
      }
    } else {
      const actor = humans.find(s => s.playerId === room.hand!.toAct)
      if (actor) {
        const own = await read(actor)
        if (own.hand?.legal) await command(actor, action(own, { kind: own.hand.legal.canCheck ? 'check' : 'call' }))
      } else await advance(900)
    }
  }
  throw new Error('hand did not finish within 300 progression steps')
}
function fixtureDeck(ids: string[], holes: string[], board: string): Card[] {
  const parse = (text: string) => text.split(' ').map(c => { const card = parseCard(c); assert.notEqual(card, null); return card! })
  const hands = holes.map(parse), community = parse(board)
  const used = [...hands.flat(), ...community]
  assert.equal(new Set(used).size, used.length)
  const rest = fullDeck().filter(c => !used.includes(c)), deck: Card[] = []
  for (let round = 0; round < 2; round++) for (let offset = 1; offset <= ids.length; offset++) deck.push(hands[offset % ids.length][round])
  return [...deck, rest.shift()!, ...community.slice(0, 3), rest.shift()!, community[3], rest.shift()!, community[4], ...rest]
}

async function publicChecks() {
  const host = await create('API host', 2, 30, 'API-HOST')
  let room = await read(host)
  check(room.initialStack === 30 && player(room, host.playerId).stack === 30 && room.seats[0] === host.playerId, 'configured 30 BB bankroll and host seat are initialized')
  check(player(room, host.playerId).timeCards === 3 && !room.hand, 'new players receive three time cards in a lobby')
  noSecrets(room)
  await reject(roomPath(host), undefined, undefined, 'unauthenticated reads rejected', 401)
  await reject(commandPath(host), { type: 'add-bot' }, undefined, 'unauthenticated mutations rejected', 401)
  await reject(commandPath(host), { type: 'start' }, host.token, 'cannot start with one seated player')
  const beforeParsing = room.revision
  for (const [body, expected] of [['{', 400], ['[]', 400], ['null', 400], [JSON.stringify({ type: 'start', padding: 'x'.repeat(4096) }), 413]] as const) {
    const response = await rawRequest(commandPath(host), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` }, body })
    assert.equal(response.status, expected)
  }
  check((await read(host)).revision === beforeParsing, 'malformed, array, null and oversized JSON leave state unchanged')
  const badType = await rawRequest(commandPath(host), { method: 'POST', headers: { 'Content-Type': 'text/plain', Authorization: `Bearer ${host.token}` }, body: '{}' })
  check(badType.status === 415, 'non-JSON content type rejected')
  const badOrigin = await rawRequest(commandPath(host), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}`, Origin: 'https://untrusted.example' }, body: '{"type":"add-bot"}' })
  check(badOrigin.status === 403, 'cross-origin mutation rejected despite valid credentials')
  check((await request(roomPath(host), 'GET', undefined, host.token)).headers.get('cache-control') === 'no-store', 'private responses cannot be cached')
  for (const initialStack of [0, 19, 20.1, 1001]) await reject('/api/rooms', { name: 'Invalid', capacity: 2, initialStack }, undefined, `invalid initial stack ${initialStack} rejected`)
  const defaultHost = await create('Default host')
  check((await read(defaultHost)).initialStack === 100, 'omitted initial stack defaults to 100 BB')
  await reject(roomPath(host), undefined, defaultHost.token, 'foreign-room token cannot read the room', 401)
  const guest = await join(host, 'API guest', 'API-GUEST')
  room = await read(guest)
  check(room.isSpectator && player(room, guest.playerId).seat === null && player(room, guest.playerId).timeCards === 3, 'join enters spectator mode with a fresh bankroll and three time cards')
  await reject(commandPath(guest), { type: 'start' }, guest.token, 'only the host can start', 403)
  await reject(commandPath(guest), { type: 'add-bot' }, guest.token, 'only the host can add bots', 403)
  await command(guest, { type: 'sit', seat: 1 })
  const observer = await join(host, 'Observer')
  check((await read(observer)).isSpectator, 'a full table still accepts spectators')
  await reject(commandPath(observer), { type: 'sit', seat: 1 }, observer.token, 'cannot replace a human occupant', 409)
  room = await command(host, { type: 'start' })
  assert.ok(room.hand && room.actionDeadline)
  check(room.actionDeadline - Date.now() > 29_000 && room.actionDeadline - Date.now() <= 30_000, 'human action deadline is 30 seconds')
  check(room.hand.players.every(p => p.stack + p.invested === 30), 'first deal uses configured initial stacks')
  const actor = room.hand.toAct === host.playerId ? host : guest, other = actor === host ? guest : host
  let own = await read(actor)
  const deadline = own.actionDeadline!, revision = own.actionRevision
  await reject(commandPath(other), { type: 'time-card', handNumber: own.hand!.number }, other.token, 'time cards cannot be used out of turn')
  for (let count = 1; count <= 3; count++) {
    own = await command(actor, { type: 'time-card', handNumber: own.hand!.number })
    assert.equal(own.actionDeadline, deadline + count * 30_000)
    assert.equal(player(own, actor.playerId).timeCards, 3 - count)
  }
  check(own.actionRevision === revision, 'each time card adds exactly 30 seconds without invalidating the action revision')
  await reject(commandPath(actor), { type: 'time-card', handNumber: own.hand!.number }, actor.token, 'a fourth time card cannot be spent')
  const mid = await join(host, 'Midhand viewer')
  check((await read(mid)).hand?.number === room.hand.number && (await read(mid)).isSpectator, 'mid-hand joins immediately observe the active table')
  await command(host, { type: 'spectator-cards', show: true })
  check(handPlayer(await read(observer), host.playerId).cards?.length === 2, 'live card opt-in exposes human cards to spectators')
  check(handPlayer(await read(guest), host.playerId).cards === null, 'opting in never exposes live cards to an opponent')
  noSecrets(await read(observer)); noSecrets(await read(guest))
  own = await read(actor)
  const chat = '<img src=x onerror=alert(1)> & 你好'
  const chatRoom = await command(observer, { type: 'chat', text: chat })
  check(chatRoom.chat.at(-1)?.text === chat && chatRoom.actionRevision === own.actionRevision && chatRoom.revision > own.revision, 'spectator chat remains plain JSON text and does not stale a poker decision')
  await reject(commandPath(observer), { type: 'chat', text: 'too fast' }, observer.token, 'chat rate limit is enforced', 429)
  await reject(commandPath(mid), { type: 'chat', text: 'x'.repeat(301) }, mid.token, 'chat length limit enforced')
  await reject(commandPath(other), action(own, { kind: 'fold' }), other.token, 'out-of-turn action rejected')
  await reject(commandPath(actor), { ...action(own, { kind: 'fold' }), revision: own.actionRevision - 1 }, actor.token, 'stale poker revision rejected', 409)
  await reject(commandPath(actor), { ...action(own, { kind: 'fold' }), handNumber: own.hand!.number + 1 }, actor.token, 'wrong hand number rejected', 409)
  await reject(commandPath(actor), action(own, { kind: 'raise', to: 30.5 }), actor.token, 'over-stack raise rejected')
  const duplicates = await Promise.all([request(commandPath(actor), 'POST', action(own, { kind: 'fold' }), actor.token), request(commandPath(actor), 'POST', action(own, { kind: 'fold' }), actor.token)])
  check(duplicates.filter(r => r.status === 200).length === 1 && duplicates.some(r => r.status === 409), 'duplicate concurrent decisions are applied exactly once after chat updates')
  room = await finishSettlement(host); zeroSum(room)
  check(room.hand!.finished && room.nextHandAt! - Date.now() <= 3000 && room.nextHandAt! > Date.now(), 'hand completion schedules the next deal after a three-second reveal window')
  const completedNumber = room.hand!.number, stacks = new Map(room.players.map(p => [p.id, p.stack]))
  await command(actor, { type: 'show', handNumber: completedNumber, cards: [0] })
  let shown = handPlayer(await read(observer), actor.playerId).cards
  check(shown?.[0] !== null && shown?.[1] === null, 'voluntary single-card show keeps the second card hidden')
  await command(actor, { type: 'show', handNumber: completedNumber, cards: [1] })
  shown = handPlayer(await read(observer), actor.playerId).cards
  check(shown?.every(card => card !== null), 'second reveal adds the other card')
  noSecrets(await read(observer))
  await advance(3100)
  room = await read(host)
  check(room.hand!.number === completedNumber + 1 && !room.hand!.finished, 'next hand starts automatically without a host command')
  check(room.hand!.players.every(p => p.stack + p.invested === stacks.get(p.id)), 'remaining stacks carry into the next hand without resetting')
  await command(host, { type: 'spectator-cards', show: false })
  const result = await passive(host, [host, guest]); zeroSum(result)
  check(result.hand!.showdown && result.hand!.board.length === 5, 'passive human play reaches a five-card showdown')
  check(player(result, host.playerId).stats.hands === 2 && player(result, guest.playerId).stats.hands === 2, 'room statistics count completed hands once')
  const statsBefore = structuredClone(player(result, guest.playerId).stats), stackBefore = player(result, guest.playerId).stack
  await leave(guest)
  await reject(roomPath(guest), undefined, guest.token, 'leaving revokes the old token', 401)
  const returning = await join(host, ' API GUEST ', 'DIFFERENT-LEGACY-ID')
  room = await read(returning)
  assert.deepEqual(player(room, returning.playerId).stats, statsBefore)
  check(returning.playerId === guest.playerId && returning.token !== guest.token && player(room, returning.playerId).stack === stackBefore && room.isSpectator, 'returning normalized nickname inherits statistics and chips with a new token as a spectator')
  await reject(`${roomPath(host)}/join`, { name: 'api guest', playerId: 'ANOTHER-ID' }, undefined, 'an active nickname cannot be taken over with a different legacy ID', 409)
  const fresh = await join(host, 'Fresh stats', 'FRESH-ID')
  check(player(await read(fresh), fresh.playerId).stats.hands === 0, 'a new nickname starts with fresh statistics')
  await leave(host)
  check((await read(returning)).hostId !== host.playerId, 'departing host transfers ownership to a remaining human')

  const seatsHost = await create('Seats', 2), waiting = await join(seatsHost, 'Waiting')
  room = await command(seatsHost, { type: 'add-bot', seat: 1 })
  const bot = room.players.find(p => p.bot)!
  await command(seatsHost, { type: 'start' })
  await command(waiting, { type: 'sit', seat: 1 })
  room = await read(waiting)
  check(room.reservations[1] === waiting.playerId && room.seats[1] === bot.id && room.isSpectator, 'mid-hand bot replacement reserves a seat while the player observes')
  const racer = await join(seatsHost, 'Racer')
  await reject(commandPath(racer), { type: 'sit', seat: 1 }, racer.token, 'a reservation cannot be stolen', 409)
  await command(racer, { type: 'request-seat' })
  check((await read(seatsHost)).seatRequests.includes(racer.playerId), 'spectators can request another seat')
  await reject(commandPath(racer), { type: 'add-seat' }, racer.token, 'only host can expand table', 403)
  room = await command(seatsHost, { type: 'add-seat' })
  check(room.capacity === 3 && room.seatRequests.length === 0, 'host expands table and clears seat requests')
  const race2 = await join(seatsHost, 'Race two')
  const seatRaces = await Promise.all([racer, race2].map(s => request(commandPath(s), 'POST', { type: 'sit', seat: 2 }, s.token)))
  check(seatRaces.filter(r => r.status === 200).length === 1 && seatRaces.some(r => r.status === 409), 'concurrent seat reservations cannot overbook an empty seat')
  room = await read(seatsHost)
  noSecrets(await read(waiting))
  check(handPlayer(await read(waiting), bot.id).cards === null, 'bots keep their cards hidden while a hand is active')
  const finished = await passive(seatsHost, [seatsHost]); zeroSum(finished)
  check(finished.seats[1] === waiting.playerId && player(finished, bot.id).leaving, 'reserved human replaces the computer after settlement')
  check(handPlayer(finished, bot.id).cards?.every(card => card !== null), 'computer cards are shown automatically when the hand ends')
  for (let count = 3; count < 9; count++) await command(seatsHost, { type: 'add-seat' })
  await reject(commandPath(seatsHost), { type: 'add-seat' }, seatsHost.token, 'table cannot exceed nine seats')
  await reject(commandPath(racer), { type: 'request-seat' }, racer.token, 'seat request also respects nine-seat limit')

  const allHost = await create('Runout host', 2, 20), allGuest = await join(allHost, 'Runout guest')
  await command(allGuest, { type: 'sit', seat: 1 })
  room = await command(allHost, { type: 'start' })
  await command(allHost, action(room, { kind: 'raise', to: 20 }))
  room = await read(allGuest)
  room = await command(allGuest, action(room, { kind: 'call' }))
  check(room.hand!.awaitingRunout && room.runoutVote?.eligibleIds.length === 2 && room.actionDeadline === null, 'all-in pauses for both eligible humans to choose runouts')
  await command(allHost, { type: 'runouts', count: 3, handNumber: room.hand!.number })
  await reject(commandPath(allHost), { type: 'runouts', count: 1, handNumber: room.hand!.number }, allHost.token, 'submitted runout choice cannot be changed', 409)
  room = await command(allGuest, { type: 'runouts', count: 2, handNumber: room.hand!.number })
  check(!room.hand!.finished && room.hand!.boards.length === 1 && room.hand!.board.length === 0 && room.hand!.delta === null && room.nextHandAt === null, 'runout voting starts a concealed sequential reveal without settling chips')
  room = await finishPlayback(allHost)
  zeroSum(room)
  check(room.hand!.runCount === 2 && room.hand!.boards.length === 2, 'minimum human vote selects two complete boards')
  const allCards = [...room.hand!.boards.flat(), ...room.hand!.players.flatMap(p => p.cards!)]; assert.equal(new Set(allCards).size, allCards.length)
  check(true, 'multiple boards never reuse unexposed hole or community cards')
}

async function controlledChecks() {
  if (external) return
  const host = await create('Clock host'), guest = await join(host, 'Clock guest')
  await command(guest, { type: 'sit', seat: 1 })
  let room = await command(host, { type: 'start' })
  const expiry = room.actionDeadline!
  await advance(29_999)
  check(!(await read(host)).hand!.finished, 'a 30-second turn remains active at 29,999 milliseconds')
  await advance(1)
  room = await read(guest)
  check(room.hand!.finished && room.hand!.history.some(a => a.playerId === host.playerId && a.kind === 'fold'), 'exact deadline automatically folds when a call is owed')
  const hourHost = await create('Hourly cards')
  const grant = (await read(hourHost)).nextTimeCardAt
  now = grant - 1
  check(player(await read(hourHost), hourHost.playerId).timeCards === 3, 'time cards are not granted before the hourly boundary')
  now = grant
  room = await read(hourHost)
  check(player(room, hourHost.playerId).timeCards === 4 && room.nextTimeCardAt === grant + 3_600_000, 'one extra card is granted exactly at one hour')
  now += 2 * 3_600_000 + 1500
  room = await read(hourHost)
  check(player(room, hourHost.playerId).timeCards === 6 && room.nextTimeCardAt === grant + 3 * 3_600_000, 'missed hourly grants catch up exactly once without drift')
  await restore(hourHost)
  check(player(await read(hourHost), hourHost.playerId).timeCards === 6, 'restarting storage does not duplicate hourly grants')

  const bustHost = await create('Bust host', 2, 30), bustGuest = await join(bustHost, 'Bust guest')
  await command(bustGuest, { type: 'sit', seat: 1 })
  await command(bustHost, { type: 'start' })
  await restore(bustHost, saved => {
    const ids = [bustHost.playerId, bustGuest.playerId]
    saved.hand = startHand(ids, 0, saved.handNumber, { stacks: { [ids[0]]: 30, [ids[1]]: 30 }, deck: fixtureDeck(ids, ['Ac Ad', 'Kc Kd'], '2s 4h 7d 9c Js'), deferRunout: true })
  })
  room = await read(bustHost)
  const initialHostView = structuredClone(room), initialGuestView = await read(bustGuest)
  await restore(bustHost)
  assert.deepEqual((await read(bustHost)).hand, initialHostView.hand)
  assert.deepEqual((await read(bustGuest)).hand, initialGuestView.hand)
  check((await read(bustHost)).actionDeadline === initialHostView.actionDeadline, 'restart preserves private cards, action revision, stack state and deadline')
  await command(bustHost, action(room, { kind: 'raise', to: 30 }))
  room = await command(bustGuest, action(await read(bustGuest), { kind: 'call' }))
  await command(bustHost, { type: 'runouts', count: 1, handNumber: room.hand!.number })
  room = await command(bustGuest, { type: 'runouts', count: 1, handNumber: room.hand!.number })
  room = await finishPlayback(bustHost)
  check(player(room, bustGuest.playerId).stack === 0 && player(room, bustGuest.playerId).sittingOut && room.seats[1] === bustGuest.playerId, 'busted human keeps their seat and spectates without automatic rebuy')
  const oldStats = structuredClone(player(room, bustGuest.playerId).stats)
  await advance(3100)
  check((await read(bustHost)).hand!.finished, 'table waits when fewer than two funded players remain')
  room = await command(bustGuest, { type: 'rebuy' })
  check(player(room, bustGuest.playerId).stack === 30 && !player(room, bustGuest.playerId).sittingOut, 'human rebuy restores precisely the configured initial stack')
  assert.deepEqual(player(room, bustGuest.playerId).stats, oldStats)
  await advance(3100)
  room = await read(bustHost)
  check(!room.hand!.finished && handPlayer(room, bustHost.playerId).stack + handPlayer(room, bustHost.playerId).invested === 60 && handPlayer(room, bustGuest.playerId).stack + handPlayer(room, bustGuest.playerId).invested === 30, 'rebuy restarts automatically while winner retains accumulated bankroll')
  await reject(commandPath(bustGuest), { type: 'rebuy' }, bustGuest.token, 'mid-hand rebuy rejected', 409)

  const botHost = await create('Bot bust', 2, 30)
  room = await command(botHost, { type: 'add-bot' })
  const botId = room.players.find(p => p.bot)!.id
  await command(botHost, { type: 'start' })
  await restore(botHost, saved => {
    const ids = [botHost.playerId, botId]
    saved.hand = startHand(ids, 0, saved.handNumber, { stacks: { [ids[0]]: 30, [ids[1]]: 30 }, deck: fixtureDeck(ids, ['Ac Ad', 'Kc Kd'], '2s 4h 7d 9c Js'), deferRunout: true })
  })
  room = await read(botHost)
  await command(botHost, action(room, { kind: 'raise', to: 30 }))
  // Advance only the bot's legal call through the engine fixture, then use the
  // public room deadline path for vote setup and settlement.
  await restore(botHost, saved => {
    saved.members.find((p: any) => p.id === botId).bot = false
    saved.members.find((p: any) => p.id === botId).token = 'fixture-bot-caller'
  })
  const botCaller = { code: botHost.code, playerId: botId, token: 'fixture-bot-caller' }
  room = await command(botCaller, action(await read(botCaller), { kind: 'call' }))
  await restore(botHost, saved => {
    saved.members.find((p: any) => p.id === botId).bot = true
    saved.members.find((p: any) => p.id === botId).token = ''
    saved.runoutVote.eligibleIds = [botHost.playerId]
  })
  room = await command(botHost, { type: 'runouts', count: 1, handNumber: room.hand!.number })
  room = await finishPlayback(botHost)
  check(handPlayer(room, botId).stack === 0 && player(room, botId).stack === 30 && !player(room, botId).sittingOut, 'busted computer automatically replenishes its configured stack after settlement')
  check(handPlayer(room, botId).cards?.every(card => card !== null), 'computer hand is automatically visible after losing')

  const foldedHost = await create('Fold privacy', 3), p2 = await join(foldedHost, 'Second'), p3 = await join(foldedHost, 'Third'), spectator = await join(foldedHost, 'Viewer')
  await command(p2, { type: 'sit', seat: 1 }); await command(p3, { type: 'sit', seat: 2 })
  room = await command(foldedHost, { type: 'start' })
  await command(p2, { type: 'spectator-cards', show: true })
  room = await command(foldedHost, action(room, { kind: 'fold' }))
  check(!room.isSpectator && handPlayer(room, p2.playerId).cards === null && handPlayer(await read(spectator), p2.playerId).cards?.length === 2, 'folded participants still cannot see live spectator-shared opponent cards')
  await command(foldedHost, { type: 'stand' })
  check(handPlayer(await read(foldedHost), p2.playerId).cards === null, 'standing mid-hand cannot bypass opponent-card privacy')

  const fast = await create('Fast bots', 3)
  await command(fast, { type: 'add-bot' }); await command(fast, { type: 'add-bot' })
  room = await command(fast, { type: 'start' })
  await reject(commandPath(fast), { type: 'fast-forward' }, fast.token, 'fast-forward blocked while human can participate')
  room = await command(fast, action(room, { kind: 'fold' }))
  check(room.canFastForward, 'folded human can accelerate a computer-only remainder')
  room = await command(fast, { type: 'fast-forward' }); room = await finishPlayback(fast); zeroSum(room)
  check(room.hand!.finished && room.hand!.players.filter(p => p.id !== fast.playerId).every(p => p.cards?.every(card => card !== null)), 'fast-forward completes legally and reveals all computer cards')

  const voteHost = await create('Vote timeout', 2, 20), voteGuest = await join(voteHost, 'Voter')
  await command(voteGuest, { type: 'sit', seat: 1 }); room = await command(voteHost, { type: 'start' })
  await command(voteHost, action(room, { kind: 'raise', to: 20 }))
  room = await command(voteGuest, action(await read(voteGuest), { kind: 'call' }))
  await command(voteHost, { type: 'runouts', count: 3, handNumber: room.hand!.number })
  await advance(15_000); room = await read(voteGuest)
  room = await finishPlayback(voteHost)
  check(room.hand!.finished && room.hand!.runCount === 1, 'missing runout vote defaults to one at the vote deadline')

  const blindHost = await create('Blind host', 4), blindP1 = await join(blindHost, 'Seat one'), blindP2 = await join(blindHost, 'Seat two')
  await command(blindP1, { type: 'sit', seat: 1 }); await command(blindP2, { type: 'sit', seat: 2 })
  room = await command(blindHost, { type: 'start' })
  assert.equal(room.hand!.bigBlindId, blindP2.playerId)
  await command(blindHost, action(room, { kind: 'fold' }))
  await command(blindP1, action(await read(blindP1), { kind: 'fold' }))
  await finishSettlement(blindHost)
  await leave(blindP1)
  const waitingBlind = await join(blindHost, 'Wait for BB')
  room = await command(waitingBlind, { type: 'sit', seat: 1 })
  check(player(room, waitingBlind.playerId).entryStatus === 'waiting', 'joining a running cash table waits for the natural big blind by default')
  await advance(3100); room = await read(blindHost)
  check(room.hand!.bigBlindId === blindHost.playerId && !room.hand!.players.some(p => p.id === waitingBlind.playerId), 'waiting seat is skipped until the big blind reaches its physical position')
  await command(blindP2, action(await read(blindP2), { kind: 'fold' }))
  await finishSettlement(blindHost)
  await advance(3100); room = await read(blindHost)
  check(room.hand!.bigBlindId === waitingBlind.playerId && player(room, waitingBlind.playerId).entryStatus === 'ready' && handPlayer(room, waitingBlind.playerId).invested === 1, 'natural big blind activates the waiting player and charges one blind')
  await passive(blindHost, [blindHost, waitingBlind, blindP2])
  const posted = await join(blindHost, 'Post blind')
  await reject(commandPath(posted), { type: 'post-blind' }, posted.token, 'cannot post an entry blind without a seat')
  await command(posted, { type: 'sit', seat: 3 })
  await command(posted, { type: 'post-blind' })
  await advance((await read(posted)).nextHandAt! - Date.now()); room = await read(posted)
  check(room.hand!.players.some(p => p.id === posted.playerId) && room.hand!.bigBlindId === blindP2.playerId && handPlayer(room, posted.playerId).invested === 1, 'voluntary live blind enters next hand before the natural big blind arrives')
  assert.equal(room.hand!.toAct, posted.playerId)
  check(room.hand!.legal?.canCheck && room.hand!.legal.callAmount === 0, 'posted entry blind counts as one BB of live preflop credit')
  await passive(blindHost, [blindHost, waitingBlind, blindP2, posted])
  room = await read(posted)
  check(player(room, posted.playerId).stats.hands === 1 && player(room, posted.playerId).stats.vpip === 0, 'entry blind alone does not inflate professional VPIP statistics')

  const receiptHost = await create('Receipt host', 2, 20), receiptGuest = await join(receiptHost, 'Receipt guest')
  await command(receiptGuest, { type: 'sit', seat: 1 }); room = await command(receiptHost, { type: 'start' })
  await command(receiptHost, action(room, { kind: 'raise', to: 20 }))
  const departure = success(await request(commandPath(receiptHost), 'POST', { type: 'leave' }, receiptHost.token), 'all-in departure')
  const receipt = departure.receipt as RoomSession
  assert.ok(receipt?.token)
  await reject(commandPath(receiptHost), { type: 'chat', text: 'old token' }, receiptHost.token, 'departed action token is revoked immediately', 401)
  await reject(commandPath(receipt), { type: 'chat', text: 'receipt token' }, receipt.token, 'settlement receipt cannot issue room commands', 401)
  room = await command(receiptGuest, action(await read(receiptGuest), { kind: 'call' }))
  if (room.runoutVote) room = await command(receiptGuest, { type: 'runouts', count: 3, handNumber: room.hand!.number })
  room = await finishPlayback(receiptGuest)
  const receiptRoom = await read(receipt)
  check(receiptRoom.hand!.finished && player(receiptRoom, receiptHost.playerId).stats.hands === 1 && room.hand!.runCount === 1, 'read-only receipt retrieves the final all-in result after departure; departed vote defaults to one')
  await leave(receiptGuest)
  const finalReceipt = await read(receipt)
  check(finalReceipt.players.length === 1 && finalReceipt.players[0].id === receiptHost.playerId && !finalReceipt.hand && finalReceipt.chat.length === 0, 'dissolved room briefly retains only the departing player statistics receipt')
  await reject(`${roomPath(receiptHost)}/join`, { name: 'Cannot revive' }, undefined, 'receipt retention cannot revive a dissolved room', 404)
  await advance(120_001)
  await reject(roomPath(receipt), undefined, receipt.token, 'final statistics receipt expires after two minutes', 404)

  const offlineHost = await create('Offline identity', 2), offlineGuest = await join(offlineHost, 'Offline guest', 'OFFLINE-ID')
  await advance(60_001); await read(offlineHost)
  const recovered = await join(offlineHost, ' ＯＦＦＬＩＮＥ　ＧＵＥＳＴ ', 'another-id')
  check(recovered.playerId === offlineGuest.playerId && recovered.token !== offlineGuest.token, 'disconnected nickname is reclaimable after grace with NFKC and case normalization')
  await reject(roomPath(offlineGuest), undefined, offlineGuest.token, 'offline recovery revokes the old device token', 401)

  const destroyed = await create('Destroyed')
  const code = destroyed.code
  await leave(destroyed)
  await reject(`${roomPath(destroyed)}/join`, { name: 'Late visitor', playerId: destroyed.playerId }, undefined, 'last human exit destroys room and prevents statistics inheritance', 404)
  assert.equal(objects.get(code)!.ctx.storage.values.size, 0)
  check(objects.get(code)!.ctx.storage.alarm === null, 'room destruction deletes all saved records and scheduled alarms')
  assert.ok(expiry > 0)
}

async function nicknameAndBotChecks() {
  if (external) return
  const chinese = await create('  张三  ', 2, 30, 'IGNORED-ID')
  let room = await read(chinese)
  check(player(room, chinese.playerId).name === '张三' && chinese.playerId !== 'IGNORED-ID', 'Chinese nickname is the trimmed public identity and legacy playerId cannot choose its internal key')
  const alice = await join(chinese, ' Ａｌｉｃｅ ', 'LEGACY-A')
  check(player(await read(alice), alice.playerId).name === 'Alice', 'NFKC normalization stores a single display nickname')
  await reject(`${roomPath(chinese)}/join`, { name: '  alice ', playerId: 'LEGACY-B' }, undefined, 'case-normalized active nickname collision is rejected despite another ID', 409)
  await reject(`${roomPath(chinese)}/join`, { name: '张三', playerId: 'LEGACY-C' }, undefined, 'active Chinese nickname cannot be duplicated', 409)
  const bob = await join(chinese, 'Bob', 'LEGACY-A')
  check(bob.playerId !== alice.playerId, 'reusing a legacy playerId with another nickname creates an independent opaque identity')
  await leave(alice)
  const oldCount = (await read(chinese)).players.length
  const returned = await join(chinese, 'ＡＬＩＣＥ', 'TOTALLY-DIFFERENT')
  room = await read(returned)
  check(returned.playerId === alice.playerId && room.players.length === oldCount && returned.token !== alice.token, 'same normalized nickname restores its original record without adding duplicates')
  await reject(roomPath(alice), undefined, alice.token, 'nickname restoration invalidates the previous credentials', 401)

  const named = await create('电脑1', 2)
  room = await command(named, { type: 'add-bot', seat: 1 })
  const originalBot = room.players.find(p => p.bot)!
  check(originalBot.name === '电脑2', 'computer numbering skips a human using a computer-style nickname')
  for (const name of ['Computer2', ' computer ２ ', '电脑 2', 'Bot 2']) {
    await reject(`${roomPath(named)}/join`, { name }, undefined, `computer display alias ${name.trim()} cannot collide with an existing computer`, 409)
  }
  await command(named, { type: 'remove-bot', playerId: originalBot.id })
  room = await command(named, { type: 'add-bot', seat: 1 })
  check(room.players.find(p => p.bot && !p.leaving)!.name === '电脑3' && new Set(room.players.map(p => p.name)).size === room.players.length, 'deleted computer names remain reserved throughout room history')
  await join(named, 'Computer9')
  await command(named, { type: 'remove-bot', playerId: room.players.find(p => p.bot && !p.leaving)!.id })
  room = await command(named, { type: 'add-bot', seat: 1 })
  check(room.players.find(p => p.bot && !p.leaving)!.name === '电脑10', 'numbering also skips an English computer alias owned by a human')

  const manager = await create('Live bot manager', 4)
  await command(manager, { type: 'add-bot', seat: 1 })
  room = await command(manager, { type: 'add-bot', seat: 2 })
  const first = room.seats[1]!
  const guest = await join(manager, 'Bot replacement')
  room = await command(manager, { type: 'start' })
  const handBefore = structuredClone(room.hand), pokerRevision = room.actionRevision, deadlineBefore = room.actionDeadline
  room = await command(manager, { type: 'remove-bot', playerId: first })
  assert.deepEqual(room.hand, handBefore)
  check(player(room, first).pendingRemoval && !player(room, first).leaving && room.seats[1] === first && room.actionRevision === pokerRevision && room.actionDeadline === deadlineBefore, 'mid-hand removal only flags the computer; cards, bets, seat, deadline and poker revision stay unchanged')
  await command(guest, { type: 'sit', seat: 1 })
  await reject(commandPath(manager), { type: 'add-bot', seat: 1 }, manager.token, 'adding a computer cannot steal a human replacement reservation', 409)
  room = await command(manager, { type: 'add-bot', seat: 3 })
  const cancelled = room.reservations[3]!
  check(room.seats[3] === null && !room.hand!.players.some(p => p.id === cancelled), 'computer added to a specified empty seat waits outside the current hand')
  room = await command(manager, { type: 'remove-bot', playerId: cancelled })
  check(player(room, cancelled).leaving && room.reservations[3] === null && !player(room, cancelled).pendingRemoval, 'removing a computer waiting to enter cancels its reservation immediately')
  room = await command(manager, { type: 'add-bot', seat: 3 })
  const queued = room.reservations[3]!
  check(player(room, queued).name !== player(room, cancelled).name, 'cancelled pending computer names are never reused')
  room = await command(manager, action(room, { kind: 'fold' }))
  check(room.hand!.toAct === first && !handPlayer(room, first).folded && !player(room, first).leaving && room.actionDeadline! - Date.now() === 850, 'computer marked for removal still receives its normal active turn')
  room = await command(manager, { type: 'fast-forward' })
  if (room.runoutPlayback) room = await finishPlayback(manager)
  room = await finishSettlement(manager)
  check(room.hand!.finished && player(room, first).leaving && !player(room, first).pendingRemoval && player(room, first).stats.hands === 1, 'computer removal is applied after normal settlement and statistics recording')
  check(room.seats[1] === guest.playerId && !player(room, guest.playerId).leaving && room.seats[3] === queued, 'settlement removes the old bot while preserving the replacement human and queued computer')
  const lastHand = room.hand!.number
  const replacementDelay = room.hand!.showdown ? 5000 : 3000
  assert.equal(room.nextHandAt! - Date.now(), replacementDelay)
  await advance(replacementDelay - 1)
  check((await read(manager)).hand!.number === lastHand, 'replacement waits until the result-specific next-hand deadline')
  await advance(1); room = await read(manager)
  check(room.hand!.number === lastHand + 1 && !room.hand!.players.some(p => p.id === first) && room.hand!.players.some(p => p.id === queued), 'at the next-hand deadline, the deal excludes deleted bot and includes queued bot')

  const replacement = await create('Bot to bot', 2)
  room = await command(replacement, { type: 'add-bot', seat: 1 })
  const oldBot = room.seats[1]!
  await command(replacement, { type: 'start' })
  await command(replacement, { type: 'remove-bot', playerId: oldBot })
  room = await command(replacement, { type: 'add-bot', seat: 1 })
  const nextBot = room.reservations[1]!
  check(nextBot && room.seats[1] === oldBot, 'a new computer can queue for the same seat as a pending removal')
  room = await command(replacement, action(room, { kind: 'fold' }))
  room = await finishSettlement(replacement)
  check(room.seats[1] === nextBot && player(room, oldBot).leaving && !player(room, nextBot).leaving, 'same-seat bot replacement applies atomically after the old hand')

  const legacy = await create('Legacy owner', 3), legacyOther = await join(legacy, 'Legacy other'), aliasOwner = await join(legacy, 'Computer1')
  room = await command(legacy, { type: 'add-bot', seat: 1 })
  const legacyBotId = room.seats[1]!
  await restore(legacy, saved => {
    const owner = saved.members.find((p: any) => p.id === legacy.playerId)
    const other = saved.members.find((p: any) => p.id === legacyOther.playerId)
    owner.name = 'Ａｌｉｃｅ'; owner.seen = Date.now() - 10; owner.stats.hands = 4; owner.stack = 87
    other.name = 'alice'; other.seen = Date.now(); other.stats.hands = 9; other.stack = 114
    const oldBot = saved.members.find((p: any) => p.id === legacyBotId)
    oldBot.name = '电脑 1'; oldBot.leaving = true; oldBot.seat = null; oldBot.stats.hands = 12
    saved.members.push({ ...structuredClone(oldBot), id: 'LEGACY-DUPLICATE-BOT', name: '电脑1', stats: { ...oldBot.stats, hands: 7 } })
  })
  room = await read(legacy)
  check(player(room, legacyOther.playerId).name === 'alice' && player(room, legacy.playerId).name === 'Alice (2)', 'legacy human nickname collisions keep the latest active name and suffix the other record')
  check(player(room, legacy.playerId).stack === 87 && player(room, legacyOther.playerId).stack === 114 && player(room, legacy.playerId).stats.hands === 4 && player(room, legacyOther.playerId).stats.hands === 9, 'legacy nickname migration preserves each opaque ID, bankroll, statistics and credentials without merging')
  const bots = room.players.filter(p => p.bot)
  check(new Set(bots.map(p => p.name)).size === bots.length && bots.every(p => p.name !== '电脑1') && player(room, aliasOwner.playerId).name === 'Computer1', 'duplicate historical bot names are renumbered without colliding with human English aliases')
  check(player(room, legacyBotId).stats.hands === 12 && player(room, 'LEGACY-DUPLICATE-BOT').stats.hands === 7, 'renumbered computers keep separate historical statistics')
  const migratedNames = room.players.map(p => [p.id, p.name])
  await restore(legacy)
  assert.deepEqual((await read(legacy)).players.map(p => [p.id, p.name]), migratedNames)
  check(true, 'nickname migration remains stable across repeated storage restarts')
}

async function playbackHistoryAndReservationChecks() {
  if (external) return
  const host = await create('Playback host', 3, 20), guest = await join(host, 'Playback guest'), observer = await join(host, 'Playback viewer')
  await command(guest, { type: 'sit', seat: 1 })
  let room = await command(host, { type: 'start' })
  const originalEntry = player(room, host.playerId).entryStatus
  const originalStack = player(room, host.playerId).stack
  await command(host, { type: 'sit', seat: 2 })
  await command(host, { type: 'post-blind' })
  room = await command(host, { type: 'cancel-seat' })
  check(room.seats[0] === host.playerId && room.reservations.every(id => id === null) && player(room, host.playerId).entryStatus === originalEntry && player(room, host.playerId).stack === originalStack && !player(room, host.playerId).sittingOut, 'canceling a move preserves the current seat, stack, active state and original entry eligibility')
  await command(observer, { type: 'sit', seat: 2 })
  room = await command(observer, { type: 'cancel-seat' })
  check(player(room, observer.playerId).seat === null && player(room, observer.playerId).sittingOut && room.reservations[2] === null, 'spectator can cancel a reservation without affecting another seat')
  await reject(commandPath(observer), { type: 'cancel-seat' }, observer.token, 'cancel without a reservation is rejected', 400)
  await command(host, action(await read(host), { kind: 'raise', to: 20 }))
  room = await command(guest, action(await read(guest), { kind: 'call' }))
  await command(host, { type: 'runouts', count: 3, handNumber: room.hand!.number })
  room = await command(guest, { type: 'runouts', count: 3, handNumber: room.hand!.number })
  const statsBefore = room.players.map(p => [p.id, p.stats.hands, p.stats.netBB])
  check(room.hand!.board.length === 0 && room.hand!.boards.length === 1 && room.runoutPlayback?.completedResults.length === 0 && room.handHistory!.length === 0, 'initial playback contains no future board, winner, archived result or settlement')
  check(handPlayer(await read(observer), host.playerId).cards?.length === 2 && handPlayer(await read(observer), guest.playerId).cards?.length === 2, 'all-in live hands are tabled for every viewer once voting ends')
  await reject(commandPath(host), { type: 'fast-forward' }, host.token, 'fast-forward cannot skip an all-in presentation', 400)
  await reject(commandPath(host), action(room, { kind: 'check' }), host.token, 'further actions are rejected during playback', 409)
  for (let run = 0; run < 3; run++) {
    for (let revealed = 1; revealed <= 5; revealed++) {
      now = room.runoutPlayback!.nextRevealAt - 1
      const before = await read(host)
      assert.equal(before.hand!.board.length, revealed - 1)
      now++
      room = await read(host)
      assert.equal(room.hand!.board.length, revealed)
      assert.equal(room.hand!.boards.length, run + 1)
      assert.equal(room.runoutPlayback!.boardIndex, run)
      assert.equal(room.runoutPlayback!.completedResults.length, run)
      assert.equal(room.hand!.delta, null)
      assert.equal(room.nextHandAt, null)
      assert.deepEqual(room.players.map(p => [p.id, p.stats.hands, p.stats.netBB]), statsBefore)
      const beforeRestart = structuredClone(room)
      await restore(host)
      assert.deepEqual((await read(host)).hand, beforeRestart.hand)
      assert.deepEqual((await read(host)).runoutPlayback, beforeRestart.runoutPlayback)
      noSecrets(room)
    }
    assert.equal(room.runoutPlayback!.phase, 'settling')
    assert.equal(room.settlementAt, now + 2000)
    now = room.settlementAt! - 1
    room = await read(host)
    assert.equal(room.runoutPlayback!.completedResults.length, run)
    now++
    room = await read(host)
    assert.equal(room.runoutPlayback!.phase, 'result')
    const result = room.runoutPlayback!.completedResults[run]
    assert.equal(result.run, run + 1)
    assert.deepEqual(result.board, room.hand!.board)
    assert(result.winners.length > 0)
    assert.equal(Object.values(result.payouts).reduce((sum, amount) => sum + amount, 0), run === 0 || run === 1 ? 13.5 : 13)
    now = room.runoutPlayback!.nextRevealAt - 1
    assert.equal((await read(host)).runoutPlayback!.phase, 'result')
    now++
    room = await read(host)
    if (run < 2) assert.equal(room.hand!.board.length, 0)
  }
  check(room.hand!.finished && room.runoutPlayback === null && room.hand!.runResults?.length === 3 && room.nextHandAt! - now === 10000, 'three runouts reveal each card at its deadline, hold each winner for 2.4 seconds, survive every-step restarts, then begin the 10-second next-hand countdown')
  check(room.players.filter(p => p.id !== observer.playerId).every(p => p.stats.hands === 1) && room.handHistory!.length === 1, 'all runouts settle cumulative statistics and append history exactly once')
  const savedArchive = structuredClone(room.handHistory)
  assert.deepEqual(savedArchive![0].myCards, room.hand!.players.find(p => p.id === host.playerId)!.cards)
  noSecrets(room)
  assert.equal(savedArchive![0].players.length, 2)
  assert.equal(savedArchive![0].boards.length, 3)
  await restore(host)
  assert.deepEqual((await read(host)).handHistory, savedArchive)
  const publicArchive = savedArchive!.map(({ myCards, ...hand }) => hand)
  assert.deepEqual((await read(observer)).handHistory, publicArchive)
  await leave(guest)
  const returning = await join(host, 'Playback guest')
  assert.deepEqual((await read(returning)).handHistory, publicArchive)
  check(true, 'archived own cards survive credential-preserving restarts but stay hidden from spectators and nickname reclaims')
  await restore(host, saved => { delete saved.handHistory[0].privateCards })
  assert.equal((await read(host)).handHistory![0].myCards, undefined)
  check(true, 'legacy histories without private cards remain readable without inventing hole cards')

  const overbetHost = await create('Overbet host', 2, 100), shortGuest = await join(overbetHost, 'Short guest')
  await command(shortGuest, { type: 'sit', seat: 1 }); await command(overbetHost, { type: 'start' })
  await restore(overbetHost, saved => {
    const ids = [overbetHost.playerId, shortGuest.playerId]
    saved.members.find((member: any) => member.id === shortGuest.playerId).stack = 20
    saved.hand = startHand(ids, 0, saved.handNumber, { stacks: { [ids[0]]: 100, [ids[1]]: 20 }, deck: fixtureDeck(ids, ['Ac Ad', 'Kc Kd'], '2s 4h 7d 9c Js'), deferRunout: true })
  })
  await command(overbetHost, action(await read(overbetHost), { kind: 'raise', to: 100 }))
  room = await command(shortGuest, action(await read(shortGuest), { kind: 'call' }))
  assert.equal(room.hand!.pot, 120)
  await command(overbetHost, { type: 'runouts', count: 1, handNumber: room.hand!.number })
  room = await command(shortGuest, { type: 'runouts', count: 1, handNumber: room.hand!.number })
  const refunds = room.hand!.history.filter(action => action.kind === 'refund')
  check(room.hand!.pot === 40 && handPlayer(room, overbetHost.playerId).stack === 80 && player(room, overbetHost.playerId).stack === 80 && handPlayer(room, overbetHost.playerId).invested === 20 && handPlayer(room, overbetHost.playerId).streetBet === 20 && refunds.length === 1 && refunds[0].amount === 80 && refunds[0].street === 'preflop', '100 BB versus 20 BB returns 80 uncalled BB and exposes the correct 40 BB pot before playback starts')
  assert.equal(room.hand!.board.length, 0)
  assert.deepEqual(room.hand!.boards, [[]])
  assert.deepEqual(room.runoutPlayback!.completedResults, [])
  assert.equal(room.hand!.delta, null)
  assert.equal(player(room, overbetHost.playerId).stats.hands, 0)
  const normalizedPublicHand = structuredClone(room.hand)
  await restore(overbetHost)
  assert.deepEqual((await read(overbetHost)).hand, normalizedPublicHand)
  while (room.runoutPlayback) {
    assert.equal(room.hand!.pot, 40)
    assert.equal(handPlayer(room, overbetHost.playerId).stack, 80)
    assert.equal(handPlayer(room, shortGuest.playerId).stack, 0)
    assert.equal(room.hand!.players.reduce((sum, player) => sum + player.stack, 0) + room.hand!.pot, 120)
    if (room.runoutPlayback.phase === 'result') assert.equal(Object.values(room.runoutPlayback.completedResults[0].payouts).reduce((sum, amount) => sum + amount, 0), 40)
    now = room.runoutPlayback.nextRevealAt
    room = await read(overbetHost)
  }
  check(handPlayer(room, overbetHost.playerId).stack === 120 && handPlayer(room, shortGuest.playerId).stack === 0 && room.hand!.delta![overbetHost.playerId] === 20 && room.hand!.delta![shortGuest.playerId] === -20 && room.hand!.history.filter(action => action.kind === 'refund').length === 1, 'normalized overbet survives restart, conserves chips on every reveal and pays the 40 BB result once without duplicating the 80 BB refund')

  // A sleeping worker exposes at most one newly due card per tick, even if its
  // last alarm happened minutes ago. It cannot dump multiple boards on resume.
  const delayed = await create('Delayed playback', 2, 20), partner = await join(delayed, 'Delayed guest')
  await command(partner, { type: 'sit', seat: 1 }); room = await command(delayed, { type: 'start' })
  await command(delayed, action(room, { kind: 'raise', to: 20 }))
  room = await command(partner, action(await read(partner), { kind: 'call' }))
  await command(delayed, { type: 'runouts', count: 1, handNumber: room.hand!.number })
  await command(partner, { type: 'runouts', count: 1, handNumber: room.hand!.number })
  await advance(45_000)
  room = await read(delayed)
  check(room.hand!.board.length === 1 && room.runoutPlayback?.revealedCount === 1 && !room.hand!.finished, 'delayed alarm recovery reveals only one new card instead of jumping to all results')
  await finishPlayback(delayed)

  for (const prefixLength of [3, 4]) {
    const streetHost = await create(`Street ${prefixLength}`, 2, 20), streetGuest = await join(streetHost, `Guest ${prefixLength}`)
    await command(streetGuest, { type: 'sit', seat: 1 }); room = await command(streetHost, { type: 'start' })
    while (room.hand!.board.length < prefixLength) {
      const actor = room.hand!.toAct === streetHost.playerId ? streetHost : streetGuest
      const own = await read(actor)
      room = await command(actor, action(own, { kind: own.hand!.legal!.canCheck ? 'check' : 'call' }))
    }
    const prefix = [...room.hand!.board]
    const aggressor = room.hand!.toAct === streetHost.playerId ? streetHost : streetGuest
    const caller = aggressor === streetHost ? streetGuest : streetHost
    const own = await read(aggressor)
    await command(aggressor, action(own, { kind: 'raise', to: own.hand!.legal!.maxRaiseTo }))
    room = await command(caller, action(await read(caller), { kind: 'call' }))
    await command(streetHost, { type: 'runouts', count: 2, handNumber: room.hand!.number })
    room = await command(streetGuest, { type: 'runouts', count: 2, handNumber: room.hand!.number })
    assert.deepEqual(room.hand!.board, prefix)
    for (let run = 0; run < 2; run++) {
      for (let exposed = prefixLength + 1; exposed <= 5; exposed++) {
        now = room.runoutPlayback!.nextRevealAt
        room = await read(streetHost)
        assert.equal(room.hand!.board.length, exposed)
        assert.deepEqual(room.hand!.board.slice(0, prefixLength), prefix)
      }
      assert.equal(room.runoutPlayback!.phase, 'settling')
      now = room.runoutPlayback!.nextRevealAt
      room = await read(streetHost)
      assert.equal(room.runoutPlayback!.phase, 'result')
      now = room.runoutPlayback!.nextRevealAt
      room = await read(streetHost)
      if (run === 0) assert.deepEqual(room.hand!.board, prefix)
    }
    check(room.hand!.finished && room.hand!.boards.length === 2 && room.hand!.boards.every(board => prefix.every((card, i) => board[i] === card)), `all-in at ${prefixLength === 3 ? 'flop' : 'turn'} preserves the exposed prefix and deals only remaining cards separately for each run`)
  }

  // A room keeps only the newest 50 public records, even across storage reloads.
  const bounded = await create('Bounded archive', 2), other = await join(bounded, 'History guest')
  await command(other, { type: 'sit', seat: 1 })
  for (let hand = 1; hand <= 52; hand++) {
    room = await command(bounded, { type: 'start' })
    const actor = room.hand!.toAct === bounded.playerId ? bounded : other
    room = await command(actor, action(await read(actor), { kind: 'fold' }))
    room = await finishSettlement(bounded)
  }
  check(room.handHistory!.length === 50 && room.handHistory![0].number === 52 && room.handHistory![49].number === 3 && new Set(room.handHistory!.map(hand => hand.number)).size === 50, 'room history is newest-first, deduplicated and bounded to 50 completed hands')
}

async function unlimitedClockChecks() {
  if (external) return
  for (const mode of ['cash', 'tournament']) {
    const host = await create(`Free ${mode}`, 2, 50, undefined, { mode, actionSeconds: 0, registrationRaises: 0 })
    const guest = await join(host, `Guest ${mode}`)
    await command(guest, { type: 'sit', seat: 1 })
    let room = await command(host, { type: 'start' })
    assert.equal(room.hand!.toAct, host.playerId)
    check(room.actionSeconds === 0 && room.actionDeadline === null, `${mode} tables serialize unlimited action time without a deadline`)
    const revision = room.actionRevision, history = structuredClone(room.hand!.history)
    await advance(121_000)
    await objects.get(host.code)!.object.alarm()
    await read(guest)
    room = await read(host)
    assert.equal(room.hand!.toAct, host.playerId)
    assert.equal(room.hand!.finished, false)
    assert.deepEqual(room.hand!.history, history)
    assert.equal(room.actionRevision, revision)
    check(room.actionDeadline === null, `${mode} unlimited turns survive polling and alarms beyond every finite action limit`)
    await restore(host)
    room = await read(host)
    check(room.actionSeconds === 0 && room.actionDeadline === null && room.actionRevision === revision, `${mode} unlimited time survives a storage reload`)
    const cards = player(room, host.playerId).timeCards
    await reject(commandPath(host), { type: 'time-card', handNumber: room.hand!.number }, host.token, `${mode} unlimited tables reject unnecessary time cards`, 400)
    assert.equal(player(await read(host), host.playerId).timeCards, cards)
    room = await command(host, action(room, { kind: 'call' }))
    assert.equal(room.actionDeadline, null)
    room = await command(guest, action(await read(guest), { kind: 'check' }))
    assert.equal(room.hand!.street, 'flop')
    assert.equal(room.actionDeadline, null)
    await command(guest, action(room, { kind: 'check' }))
    room = await command(host, action(await read(host), { kind: 'fold' }))
    assert.equal(room.hand!.finished, true)
    room = await finishSettlement(host)
    assert.equal(room.nextHandAt, now + 3_000)
    await advance(3_000)
    room = await read(host)
    check(room.hand!.number === 2 && room.actionDeadline === null, `${mode} unlimited action time preserves automatic next-hand dealing`)
  }

  const runoutHost = await create('No clock runout', 2, 20, undefined, { actionSeconds: 0 })
  const runoutGuest = await join(runoutHost, 'Runout guest')
  await command(runoutGuest, { type: 'sit', seat: 1 })
  let room = await command(runoutHost, { type: 'start' })
  await command(runoutHost, action(room, { kind: 'raise', to: 20 }))
  room = await command(runoutGuest, action(await read(runoutGuest), { kind: 'call' }))
  assert.equal(room.runoutVote!.deadline, now + 15_000)
  assert.equal(room.actionDeadline, null)
  await advance(15_000)
  room = await read(runoutHost)
  check(room.runoutVote === null && !!room.runoutPlayback, 'Unlimited action time preserves the runout-vote timeout and board playback')
  room = await finishPlayback(runoutHost)
  check(room.hand!.finished && room.nextHandAt === now + 5_000, 'Unlimited tables settle a showdown and retain the result display delay')

  const botHost = await create('No clock bots', 2, 100, undefined, { actionSeconds: 0 })
  await command(botHost, { type: 'add-bot', seat: 1 })
  room = await command(botHost, { type: 'start' })
  room = await command(botHost, action(room, { kind: 'call' }))
  assert.equal(room.actionDeadline, now + 850)
  const beforeBotAction = room.hand!.history.length
  await advance(850)
  room = await read(botHost)
  check(room.hand!.history.length > beforeBotAction, 'Bots still act on schedule at unlimited-time tables')

  for (const type of ['stand', 'leave'] as const) {
    const host = await create(`No clock ${type}`, 2, 50, undefined, { actionSeconds: 0 })
    const guest = await join(host, `Guest ${type}`)
    await command(guest, { type: 'sit', seat: 1 })
    room = await command(host, { type: 'start' })
    assert.equal(room.actionDeadline, null)
    await command(host, { type })
    room = await read(guest)
    check(room.hand!.finished, `An unlimited table still progresses when the current actor chooses to ${type}`)
  }
}

async function tournamentChecks() {
  if (external) return
  for (const actionSeconds of [20, 60]) {
    const host = await create(`Clock ${actionSeconds}`, 2, 50, undefined, { actionSeconds }), guest = await join(host, `Guest ${actionSeconds}`)
    await command(guest, { type: 'sit', seat: 1 })
    let room = await command(host, { type: 'start' })
    assert.equal(room.actionSeconds, actionSeconds)
    assert.equal(room.actionDeadline! - now, actionSeconds * 1000)
    await advance(actionSeconds * 1000 - 1)
    assert.equal((await read(host)).hand!.finished, false)
    await advance(1)
    room = await read(host)
    check(room.hand!.finished && room.hand!.history.at(-2)?.kind === 'fold', `configured ${actionSeconds}-second turn expires exactly at its own deadline`)
  }
  for (const settings of [{ actionSeconds: -1 }, { actionSeconds: 0.5 }, { actionSeconds: '0' }, { actionSeconds: 10 }, { actionSeconds: 25 }, { actionSeconds: '30' }, { mode: 'other' }, { mode: 'tournament', registrationRaises: 0, blindIntervalMinutes: 0 }, { blindIntervalMinutes: 61 }, { blindIntervalMinutes: 1.5 }]) {
    await reject('/api/rooms', { name: 'Invalid settings', capacity: 2, ...settings }, undefined, `invalid room settings ${JSON.stringify(settings)} are rejected`, 400)
  }
  const legacy = await create('Legacy settings')
  await restore(legacy, saved => { delete saved.mode; delete saved.actionSeconds; delete saved.tournament })
  const migrated = await read(legacy)
  check(migrated.mode === 'cash' && migrated.actionSeconds === 30 && migrated.tournament === null, 'old stored rooms migrate to 30-second cash tables without changing legacy stack validation')

  const host = await create('Level host', 3, 100, undefined, { mode: 'tournament', registrationRaises: 0, actionSeconds: 60, blindIntervalMinutes: 1 })
  const guest = await join(host, 'Level guest')
  await command(guest, { type: 'sit', seat: 1 })
  let room = await read(host)
  check(room.tournament?.status === 'waiting' && room.tournament.level === 1 && room.tournament.nextLevelAt === null, 'tournament waiting room has no running blind clock')
  room = await command(host, { type: 'start' })
  const started = room.tournament!.startedAt!
  assert.deepEqual(room.tournament!.entrantIds, [host.playerId, guest.playerId])
  assert.equal(room.tournament!.nextLevelAt, started + 60_000)
  await reject(`${roomPath(host)}/join`, { name: 'Late viewer' }, undefined, 'closed tournaments reject spectator entry', 409)
  for (const [actor, body] of [[guest, { type: 'sit', seat: 2 }], [host, { type: 'stand' }], [host, { type: 'rebuy' }], [host, { type: 'post-blind' }], [host, { type: 'add-bot', seat: 2 }], [host, { type: 'remove-bot', playerId: 'any' }], [host, { type: 'add-seat' }], [host, { type: 'start' }]] as [RoomSession, RoomCommand][]) {
    await reject(commandPath(actor), body, actor.token, `running tournament rejects ${body.type}`, 409)
  }
  await command(guest, { type: 'chat', text: 'Playing the tournament' })
  await command(host, { type: 'time-card', handNumber: room.hand!.number })
  await advance(61_000)
  room = await read(host)
  check(room.hand!.bigBlind === 1 && room.tournament!.bigBlind === 1 && room.tournament!.level === 1 && room.hand!.pot === 1.5 && room.actionDeadline! === started + 90_000, 'level timer and the fixed 30-second time card never change current-hand blinds or chips')
  const beforeRestart = structuredClone(room)
  await restore(host)
  assert.deepEqual((await read(host)).hand, beforeRestart.hand)
  assert.deepEqual((await read(host)).tournament, beforeRestart.tournament)
  await command(host, action(await read(host), { kind: 'fold' }))
  await finishSettlement(host)
  await advance(3000)
  room = await read(guest)
  check(room.hand!.number === 2 && room.hand!.bigBlind === 2 && room.hand!.smallBlind === 1 && room.tournament!.level === 2 && room.tournament!.nextLevelAt === started + 120_000, 'first deal after an expired level uses 1/2 blinds across a storage restart')
  assert.equal(room.hand!.players.reduce((sum, player) => sum + player.stack + player.invested, 0), 200)
  assert.equal(room.hand!.legal!.minRaiseTo, 4)
  room = await command(guest, action(room, { kind: 'fold' }))
  room = await finishSettlement(guest)
  check(player(room, host.playerId).stats.netBB === 0 && player(room, host.playerId).netChips === 0.5 && room.handHistory![0].bigBlind === 2, 'tournament stats normalize each hand to its actual BB while net chips and archived blinds retain fixed units')

  const reconnect = await create('Recovery host', 2, 50, undefined, { mode: 'tournament', registrationRaises: 0, actionSeconds: 60 })
  const opponent = await join(reconnect, 'Recovery guest')
  await command(opponent, { type: 'sit', seat: 1 }); room = await command(reconnect, { type: 'start' })
  await command(reconnect, { type: 'time-card', handNumber: 1 })
  await advance(61_000); await read(opponent)
  const restored = await join(reconnect, 'Recovery host')
  room = await read(restored)
  check(restored.playerId === reconnect.playerId && room.seats[0] === restored.playerId && !player(room, restored.playerId).sittingOut && player(room, restored.playerId).stack === 49.5 && room.hand!.legal === null && handPlayer(room, restored.playerId).cards === null, 'nickname-only tournament recovery preserves seat and chips but cannot read or control the previous session’s current hand')
  await reject(commandPath(restored), action(room, { kind: 'call' }), restored.token, 'nickname-only recovery cannot act on the old current hand', 403)
  await reject(commandPath(restored), { type: 'time-card', handNumber: 1 }, restored.token, 'nickname-only recovery cannot extend the old current hand', 400)
  await reject(roomPath(reconnect), undefined, reconnect.token, 'restored tournament entrant revokes the old session', 401)
  await advance(50)
  room = await read(restored)
  check(room.hand!.finished && room.hand!.history.some(action => action.playerId === restored.playerId && action.kind === 'fold') && handPlayer(room, restored.playerId).cards === null, 'reclaimed current hand automatically folds when facing a bet without exposing private cards')
  await finishSettlement(restored)
  await advance(3000)
  room = await read(restored)
  check(room.hand!.number === 2 && room.hand!.players.some(player => player.id === restored.playerId) && handPlayer(room, restored.playerId).cards?.length === 2, 'nickname recovery resumes normal tournament hand eligibility on the next deal')
  await command(opponent, action(await read(opponent), { kind: 'fold' }))
  await leave(restored)
  room = await finishSettlement(opponent)
  check(room.tournament!.status === 'finished' && room.tournament!.winnerId === opponent.playerId && player(room, restored.playerId).tournamentStatus === 'forfeited' && player(room, restored.playerId).tournamentPlace === 2 && room.nextHandAt === null, 'explicit tournament departure forfeits the entry and crowns the remaining player after hand settlement')
  await reject(`${roomPath(opponent)}/join`, { name: 'Recovery host' }, undefined, 'a forfeited player cannot rejoin as a tournament spectator', 409)

  const knockout = await create('Knockout host', 2, 20, undefined, { mode: 'tournament', registrationRaises: 0, blindIntervalMinutes: 2 })
  room = await command(knockout, { type: 'add-bot', seat: 1 })
  const botId = room.seats[1]!
  await command(knockout, { type: 'start' })
  await restore(knockout, saved => {
    const ids = [knockout.playerId, botId]
    saved.hand = startHand(ids, 0, saved.handNumber, { stacks: { [ids[0]]: 20, [ids[1]]: 20 }, deck: fixtureDeck(ids, ['Ac Ad', 'Kc Kd'], '2s 4h 7d 9c Js'), deferRunout: true })
    const bot = saved.members.find((p: any) => p.id === botId)
    bot.bot = false; bot.token = 'tournament-fixture-caller'
  })
  await command(knockout, action(await read(knockout), { kind: 'raise', to: 20 }))
  const botCaller = { code: knockout.code, playerId: botId, token: 'tournament-fixture-caller' }
  room = await command(botCaller, action(await read(botCaller), { kind: 'call' }))
  await restore(knockout, saved => {
    const bot = saved.members.find((p: any) => p.id === botId)
    bot.bot = true; bot.token = ''
    saved.runoutVote.eligibleIds = [knockout.playerId]
  })
  await command(knockout, { type: 'runouts', count: 1, handNumber: 1 })
  room = await finishPlayback(knockout)
  check(room.tournament!.status === 'finished' && room.tournament!.winnerId === knockout.playerId && player(room, botId).stack === 0 && player(room, botId).tournamentStatus === 'eliminated' && player(room, botId).tournamentPlace === 2 && player(room, knockout.playerId).stack === 40 && room.nextHandAt === null, 'knockout settles exactly once, eliminates a busted bot without rebuy and records the champion')
  assert.deepEqual(room.tournament!.rankings.map(rank => [rank.playerId, rank.place, rank.chips]), [[knockout.playerId, 1, 40], [botId, 2, 0]])
  await restore(knockout); await advance(300_000)
  room = await read(knockout)
  check(room.hand!.number === 1 && room.hand!.finished && room.tournament!.nextLevelAt === null && room.nextHandAt === null && room.players.reduce((sum, player) => sum + player.stack, 0) === 40, 'finished tournament survives restart and elapsed levels without another deal or changed total chips')
  await reject(commandPath(knockout), { type: 'rebuy' }, knockout.token, 'championship cannot be restarted by rebuy', 409)
}

async function tournamentRecoveryAndWithdrawalChecks() {
  if (external) return
  const valid = await create('Token restore', 2, 50, undefined, { mode: 'tournament', registrationRaises: 0, actionSeconds: 60 }), validGuest = await join(valid, 'Token guest')
  await command(validGuest, { type: 'sit', seat: 1 }); await command(valid, { type: 'start' })
  await command(valid, { type: 'time-card', handNumber: 1 })
  await advance(61_000)
  let room = await read(valid)
  check(room.hand!.legal?.canFold && handPlayer(room, valid.playerId).cards?.length === 2 && room.seats[0] === valid.playerId, 'an original valid tournament token can reconnect and continue its private current hand')

  const checker = await create('Recovery check', 3, 50, undefined, { mode: 'tournament', registrationRaises: 0, actionSeconds: 60 })
  const checkSb = await join(checker, 'Recovery SB'), checkBb = await join(checker, 'Recovery BB')
  await command(checkSb, { type: 'sit', seat: 1 }); await command(checkBb, { type: 'sit', seat: 2 }); room = await command(checker, { type: 'start' })
  await command(checker, action(room, { kind: 'call' }))
  await command(checkSb, action(await read(checkSb), { kind: 'call' }))
  await command(checkBb, { type: 'time-card', handNumber: 1 })
  await advance(61_000); await read(checker)
  const recoveredBb = await join(checker, 'Recovery BB')
  await advance(50); room = await read(recoveredBb)
  check(room.hand!.street === 'flop' && !handPlayer(room, recoveredBb.playerId).folded && handPlayer(room, recoveredBb.playerId).cards === null && room.hand!.history.some(action => action.playerId === recoveredBb.playerId && action.kind === 'check'), 'nickname-reclaimed hand checks automatically when no call is owed and keeps its cards private')

  const recoveredAllIn = await create('Vote recovery', 3, 20, undefined, { mode: 'tournament', registrationRaises: 0, actionSeconds: 60 })
  const voteB = await join(recoveredAllIn, 'Vote second'), voteC = await join(recoveredAllIn, 'Vote third')
  await command(voteB, { type: 'sit', seat: 1 }); await command(voteC, { type: 'sit', seat: 2 }); room = await command(recoveredAllIn, { type: 'start' })
  await command(recoveredAllIn, action(room, { kind: 'raise', to: 20 }))
  await advance(50_000)
  await command(voteB, action(await read(voteB), { kind: 'call' }))
  room = await command(voteC, action(await read(voteC), { kind: 'call' }))
  await advance(11_000)
  const recoveredVoter = await join(recoveredAllIn, 'Vote recovery')
  room = await read(recoveredVoter)
  check(room.runoutVote?.votes[recoveredVoter.playerId] === 1 && handPlayer(room, recoveredVoter.playerId).cards === null && room.seats[0] === recoveredVoter.playerId, 'all-in nickname recovery preserves invested tournament chips and defaults its old runout vote to one without exposing cards')
  await reject(commandPath(recoveredVoter), { type: 'runouts', count: 3, handNumber: 1 }, recoveredVoter.token, 'nickname recovery cannot replace the prior session’s runout vote', 409)
  await command(voteB, { type: 'runouts', count: 3, handNumber: 1 }); await command(voteC, { type: 'runouts', count: 2, handNumber: 1 })
  room = await finishPlayback(voteB)
  check(room.hand!.runCount === 1 && room.hand!.players.reduce((sum, player) => sum + player.stack, 0) === 60 && room.players.every(player => player.stats.hands === 1), 'recovered all-in entry settles normally once with all tournament chips conserved')

  async function allInFixture(name: string, holes: string[]) {
    const host = await create(name, holes.length, 20, undefined, { mode: 'tournament', registrationRaises: 0 })
    const players = [host]
    for (let i = 1; i < holes.length; i++) {
      const guest = await join(host, `${name} ${i}`)
      players.push(guest); await command(guest, { type: 'sit', seat: i })
    }
    await command(host, { type: 'start' })
    await restore(host, saved => {
      const ids = players.map(player => player.playerId)
      saved.hand = startHand(ids, 0, saved.handNumber, { stacks: Object.fromEntries(ids.map(id => [id, 20])), deck: fixtureDeck(ids, holes, '2s 4h 7d 9c Js'), deferRunout: true })
    })
    await command(host, action(await read(host), { kind: 'raise', to: 20 }))
    for (const guest of players.slice(1)) await command(guest, action(await read(guest), { kind: 'call' }))
    return players
  }
  const [winner, loser] = await allInFixture('Exit winner', ['Ac Ad', 'Kc Kd'])
  await command(winner, { type: 'runouts', count: 1, handNumber: 1 }); room = await command(loser, { type: 'runouts', count: 1, handNumber: 1 })
  now = room.runoutPlayback!.nextRevealAt; room = await read(loser)
  now = room.runoutPlayback!.nextRevealAt; await read(loser)
  await leave(winner)
  room = await read(loser)
  check(room.tournament!.status === 'running' && room.tournament!.winnerId === null && room.hand!.board.length === 2 && player(room, winner.playerId).tournamentStatus === 'active', 'withdrawal during a long runout waits for the current hand result instead of prematurely naming a champion')
  await restore(loser)
  room = await finishPlayback(loser)
  check(room.tournament!.winnerId === winner.playerId && player(room, winner.playerId).stack === 40 && player(room, winner.playerId).tournamentStatus === 'winner' && player(room, loser.playerId).stack === 0 && player(room, loser.playerId).tournamentStatus === 'eliminated', 'departed all-in winner retains the genuine 40-chip championship; the zero-chip loser is never crowned')

  const [withdrawn, survivor, busted] = await allInFixture('Exit three', ['Ac Ad', 'Ah As', 'Kc Kd'])
  await leave(withdrawn)
  await command(survivor, { type: 'runouts', count: 1, handNumber: 1 }); await command(busted, { type: 'runouts', count: 1, handNumber: 1 })
  room = await finishPlayback(survivor)
  check(room.tournament!.winnerId === survivor.playerId && player(room, survivor.playerId).stack === 30 && player(room, withdrawn.playerId).stack === 30 && player(room, withdrawn.playerId).tournamentStatus === 'forfeited' && player(room, withdrawn.playerId).tournamentPlace === 2 && player(room, busted.playerId).tournamentPlace === 3, 'three-player hand first ranks its busted player, then applies a funded withdrawal and crowns only the funded remaining entrant')
  assert.equal(room.hand!.players.reduce((sum, player) => sum + player.stack, 0), 60)

  const [exitA, exitB, exitC] = await allInFixture('Exit all', ['Ac Ad', 'Ah As', 'Kc Kd'])
  await leave(exitA); await leave(exitB)
  const finalDeparture = success(await request(commandPath(exitC), 'POST', { type: 'leave' }, exitC.token), 'final tournament departure')
  const finalRoom = finalDeparture.room as RoomView
  check(finalRoom.tournament!.status === 'finished' && finalRoom.tournament!.winnerId === null && finalRoom.hand!.players.reduce((sum, player) => sum + player.stack, 0) === 60 && finalRoom.players.every(player => player.stats.hands === 1), 'when all entrants withdraw and the hand leaves several funded players, the room settles all chips without inventing a champion')
  await reject(roomPath(exitC), undefined, exitC.token, 'last tournament departure dissolves the completed room', 404)
}

async function lateRegistrationChecks() {
  if (external) return
  for (const registrationRaises of [-1, 11, 1.5, '3']) await reject('/api/rooms', { name: 'Invalid cutoff', capacity: 2, mode: 'tournament', registrationRaises }, undefined, `invalid registration cutoff ${registrationRaises} is rejected`, 400)
  const defaultHost = await create('Default entry', 2, 20, undefined, { mode: 'tournament', blindIntervalMinutes: 1 })
  let room = await read(defaultHost)
  check(room.tournament!.registrationRaises === 3 && room.tournament!.registrationOpen && room.tournament!.registrationClosesAt === null, 'tournaments default to registration and rebuys through three blind increases')
  const defaultGuest = await join(defaultHost, 'Default guest')
  await command(defaultGuest, { type: 'sit', seat: 1 }); room = await command(defaultHost, { type: 'start' })
  check(room.tournament!.registrationClosesAt === room.tournament!.startedAt! + 180_000, 'registration deadline is measured from tournament start independently of hand count')

  const queueHost = await create('Queued entry', 4, 50, undefined, { mode: 'tournament', registrationRaises: 1, blindIntervalMinutes: 1, actionSeconds: 60 })
  const original = await join(queueHost, 'Original entry')
  await command(original, { type: 'sit', seat: 2 }); room = await command(queueHost, { type: 'start' })
  await command(queueHost, { type: 'time-card', handNumber: 1 })
  const accepted = await join(queueHost, 'Accepted entry')
  const cutoff = room.tournament!.registrationClosesAt!
  await command(queueHost, { type: 'add-seat' })
  room = await command(queueHost, { type: 'add-bot', seat: 4 })
  const queuedBot = room.reservations[4]!
  check(room.capacity === 5 && room.tournament!.entrantIds.includes(queuedBot) && !room.hand!.players.some(player => player.id === queuedBot), 'open registration permits extra empty chairs and queues a new bot as an accepted entrant')
  await reject(commandPath(queueHost), { type: 'remove-bot', playerId: queuedBot }, queueHost.token, 'accepted tournament bot cannot be removed even during registration', 409)
  now = cutoff - 1
  room = await command(accepted, { type: 'sit', seat: 1 })
  check(room.reservations[1] === accepted.playerId && room.tournament!.entrantIds.includes(accepted.playerId) && player(room, accepted.playerId).buyIns === 1 && player(room, accepted.playerId).entryStatus === 'ready', 'late seat reservation atomically registers its entrant one millisecond before cutoff without a cash-entry blind')
  await reject(commandPath(accepted), { type: 'cancel-seat' }, accepted.token, 'accepted tournament registration cannot be cancelled as a seat reservation', 409)
  await restore(queueHost)
  assert.equal((await read(accepted)).reservations[1], accepted.playerId)
  now = cutoff
  await objects.get(queueHost.code)!.object.alarm()
  const deadlineState = await objects.get(queueHost.code)!.ctx.storage.get<any>('room')
  check(deadlineState.tournament.registrationOpen === false && !deadlineState.hand.finished && deadlineState.hand.bigBlind === 1, 'independent cutoff alarm closes registration exactly on time without changing current-hand blinds')
  await reject(`${roomPath(queueHost)}/join`, { name: 'Tardy entry' }, undefined, 'new entry is rejected exactly at the registration deadline', 409)
  await reject(commandPath(queueHost), { type: 'add-seat' }, queueHost.token, 'new chairs cannot be added after registration closes', 409)
  await reject(commandPath(queueHost), { type: 'add-bot', seat: 3 }, queueHost.token, 'new bots cannot enter after registration closes', 409)
  room = await command(queueHost, action(await read(queueHost), { kind: 'fold' }))
  room = await finishSettlement(queueHost)
  assert.equal(room.seats[1], accepted.playerId)
  assert.equal(room.seats[4], queuedBot)
  await advance(3000)
  room = await read(accepted)
  check(room.hand!.players.some(player => player.id === accepted.playerId) && room.hand!.players.some(player => player.id === queuedBot) && room.hand!.bigBlindId !== accepted.playerId && room.hand!.bigBlind === 2 && !room.hand!.history.some(action => action.kind === 'entry-blind'), 'registration accepted before cutoff survives restart and seats both entrants in the next hand without waiting for their big blind')
  assert.equal(room.hand!.players.reduce((sum, player) => sum + player.stack + player.invested, 0), 200)

  async function createBustedTable(name: string, bot = false, registrationRaises = 1) {
    const host = await create(name, 2, 20, undefined, { mode: 'tournament', registrationRaises, blindIntervalMinutes: 1 })
    let guest: RoomSession
    if (bot) {
      const added = await command(host, { type: 'add-bot', seat: 1 })
      guest = { code: host.code, playerId: added.seats[1]!, token: `fixture-${name}` }
    } else {
      guest = await join(host, `${name} guest`)
      await command(guest, { type: 'sit', seat: 1 })
    }
    await command(host, { type: 'start' })
    await restore(host, saved => {
      const ids = [host.playerId, guest.playerId]
      saved.hand = startHand(ids, 0, saved.handNumber, { stacks: { [ids[0]]: 20, [ids[1]]: 20 }, deck: fixtureDeck(ids, ['Ac Ad', 'Kc Kd'], '2s 4h 7d 9c Js'), deferRunout: true })
      if (bot) {
        const member = saved.members.find((member: any) => member.id === guest.playerId)
        member.bot = false; member.token = guest.token
      }
    })
    await command(host, action(await read(host), { kind: 'raise', to: 20 }))
    await command(guest, action(await read(guest), { kind: 'call' }))
    if (bot) await restore(host, saved => {
      const member = saved.members.find((member: any) => member.id === guest.playerId)
      member.bot = true; member.token = ''; saved.runoutVote.eligibleIds = [host.playerId]
    })
    await command(host, { type: 'runouts', count: 1, handNumber: 1 })
    if (!bot) await command(guest, { type: 'runouts', count: 1, handNumber: 1 })
    return { host, guest }
  }
  const human = await createBustedTable('Rebuy')
  room = await finishPlayback(human.host)
  const humanCutoff = room.tournament!.registrationClosesAt!
  check(room.tournament!.status === 'running' && room.tournament!.winnerId === null && player(room, human.guest.playerId).tournamentStatus === 'rebuy' && room.nextHandAt === null && player(room, human.guest.playerId).buyIns === 1, 'open registration keeps a busted human seated for rebuy and does not crown the lone funded player')
  assert.equal(objects.get(human.host.code)!.ctx.storage.alarm, humanCutoff)
  const beforeRebuy = player(room, human.guest.playerId).netChips
  room = await command(human.guest, { type: 'rebuy' })
  check(player(room, human.guest.playerId).stack === 20 && player(room, human.guest.playerId).buyIns === 2 && player(room, human.guest.playerId).netChips === beforeRebuy && player(room, human.guest.playerId).tournamentStatus === 'active', 'human rebuy records its additional buy-in without treating injected chips as winnings')
  assert.equal(room.players.reduce((sum, player) => sum + player.stack, 0), room.players.reduce((sum, player) => sum + (player.buyIns ?? 0) * 20, 0))
  await reject(commandPath(human.guest), { type: 'rebuy' }, human.guest.token, 'a duplicate funded rebuy is rejected', 400)
  await restore(human.host)
  assert.equal(player(await read(human.host), human.guest.playerId).buyIns, 2)
  await advance(3000); room = await read(human.host)
  await restore(human.host, saved => {
    const ids = [human.host.playerId, human.guest.playerId]
    saved.hand = startHand(ids, 0, saved.handNumber, { stacks: { [ids[0]]: 40, [ids[1]]: 20 }, deck: fixtureDeck(ids, ['Ac Ad', 'Kc Kd'], '2s 4h 7d 9c Js'), deferRunout: true })
  })
  await command(human.host, action(await read(human.host), { kind: 'raise', to: 40 }))
  room = await command(human.guest, action(await read(human.guest), { kind: 'call' }))
  await command(human.host, { type: 'runouts', count: 1, handNumber: room.hand!.number }); await command(human.guest, { type: 'runouts', count: 1, handNumber: room.hand!.number })
  room = await finishPlayback(human.host)
  assert.equal(player(room, human.guest.playerId).buyIns, 2)
  assert.equal(player(room, human.guest.playerId).netChips, -40)
  room = await command(human.guest, { type: 'rebuy' })
  check(player(room, human.guest.playerId).buyIns === 3 && player(room, human.guest.playerId).netChips === -40 && room.players.reduce((sum, player) => sum + player.stack, 0) === 80, 'multiple buy-ins preserve net chip accounting and total funded chips through successive busts')

  const waiting = await createBustedTable('Wait')
  room = await finishPlayback(waiting.host)
  const waitCutoff = room.tournament!.registrationClosesAt!
  await restore(waiting.host)
  now = waitCutoff - 1
  room = await read(waiting.host)
  check(room.tournament!.registrationOpen && room.tournament!.status === 'running' && room.nextHandAt === null, 'with only one funded player the tournament waits until the exact registration cutoff')
  now = waitCutoff
  await objects.get(waiting.host.code)!.object.alarm()
  const closed = await objects.get(waiting.host.code)!.ctx.storage.get<any>('room')
  check(closed.tournament.status === 'finished' && closed.tournament.winnerId === waiting.host.playerId && closed.tournament.registrationOpen === false && closed.nextHandAt === null, 'deadline alarm independently eliminates unreplenished stacks and crowns the funded champion without a new hand or polling')
  await reject(commandPath(waiting.guest), { type: 'rebuy' }, waiting.guest.token, 'rebuy at the cutoff boundary is rejected', 409)

  const waitingDuringHand = await createBustedTable('Mid cutoff')
  room = await finishPlayback(waitingDuringHand.host)
  await command(waitingDuringHand.host, { type: 'add-seat' })
  const newRival = await join(waitingDuringHand.host, 'New rival')
  await command(newRival, { type: 'sit', seat: 2 })
  await advance(3000)
  room = await read(waitingDuringHand.host)
  assert(!room.hand!.players.some(player => player.id === waitingDuringHand.guest.playerId))
  const actor = room.hand!.toAct === waitingDuringHand.host.playerId ? waitingDuringHand.host : newRival
  await command(actor, { type: 'time-card', handNumber: room.hand!.number })
  now = room.tournament!.registrationClosesAt!
  await objects.get(waitingDuringHand.host.code)!.object.alarm()
  room = await read(actor)
  check(!room.hand!.finished && player(room, waitingDuringHand.guest.playerId).tournamentStatus === 'eliminated' && player(room, waitingDuringHand.guest.playerId).tournamentPlace === 3 && room.tournament!.winnerId === null, 'cutoff immediately eliminates a previous zero-stack entrant while an unrelated hand remains active, without prematurely choosing a champion')
  await restore(waitingDuringHand.host, saved => { saved.tournament.eliminated = {} })
  room = await read(actor)
  check(player(room, waitingDuringHand.guest.playerId).tournamentStatus === 'eliminated' && !room.hand!.finished, 'an already-closed stored registration state repairs a previously unranked zero-stack entrant on the next read')

  const bots = await createBustedTable('Bot buy', true)
  room = await finishPlayback(bots.host)
  check(player(room, bots.guest.playerId).stack === 20 && player(room, bots.guest.playerId).buyIns === 2 && player(room, bots.guest.playerId).netChips === -20 && room.tournament!.status === 'running', 'open tournament automatically rebuys a busted bot and records the new buy-in')
  const rebought = structuredClone(player(room, bots.guest.playerId))
  await restore(bots.host)
  assert.deepEqual(player(await read(bots.host), bots.guest.playerId), rebought)
  assert.deepEqual(player(await read(bots.host), bots.guest.playerId), rebought)
  check(true, 'repeated polling and storage restart cannot duplicate an automatic bot rebuy')

  const closedBot = await createBustedTable('Bot cutoff', true)
  room = await read(closedBot.host)
  now = room.tournament!.registrationClosesAt!
  room = await read(closedBot.host)
  assert.equal(room.tournament!.registrationOpen, false)
  assert.equal(room.hand!.finished, false)
  room = await finishPlayback(closedBot.host)
  check(player(room, closedBot.guest.playerId).stack === 0 && player(room, closedBot.guest.playerId).buyIns === 1 && room.tournament!.winnerId === closedBot.host.playerId, 'a bot busting in a runout that finishes after cutoff is eliminated rather than automatically rebought')

  const withdrawHost = await create('Open withdraw', 2, 20, undefined, { mode: 'tournament', registrationRaises: 1, blindIntervalMinutes: 1 })
  const staying = await join(withdrawHost, 'Staying entry')
  await command(staying, { type: 'sit', seat: 1 }); room = await command(withdrawHost, { type: 'start' })
  await command(withdrawHost, action(room, { kind: 'fold' })); await leave(withdrawHost)
  await finishSettlement(staying)
  room = await read(staying)
  check(room.tournament!.registrationOpen && room.tournament!.status === 'running' && player(room, withdrawHost.playerId).tournamentStatus === 'forfeited', 'an explicit withdrawal remains final while new registrations are still open')
  await reject(`${roomPath(staying)}/join`, { name: 'Open withdraw' }, undefined, 'withdrawn nickname cannot re-enter or spectate during open registration', 409)
  await reject(commandPath(withdrawHost), { type: 'rebuy' }, withdrawHost.token, 'withdrawn credentials cannot revive an entry with rebuy', 401)
  const newcomer = await join(staying, 'New entry')
  room = await command(newcomer, { type: 'sit', seat: 0 })
  check(room.tournament!.entrantIds.includes(newcomer.playerId) && room.seats[0] === newcomer.playerId && room.nextHandAt !== null, 'a different late entrant can register in a vacated empty chair and resume the waiting tournament')
}

async function roomSettingsAndSeatChecks() {
  if (external) return
  const host = await create('Settings host', 4, 50), guest = await join(host, 'Settings guest')
  await command(guest, { type: 'sit', seat: 2 })
  let room = await command(host, { type: 'start' })
  const deadline = room.actionDeadline, beforeHand = structuredClone(room.hand), revision = room.actionRevision
  await reject(commandPath(guest), { type: 'settings', actionSeconds: 0, initialStack: 200 }, guest.token, 'only the cash host can change future room settings', 403)
  room = await command(host, { type: 'settings', actionSeconds: 0, initialStack: 200 })
  assert.deepEqual(room.hand, beforeHand)
  check(room.actionDeadline === deadline && room.actionRevision === revision && room.actionSeconds === 0 && room.handActionSeconds === 30 && room.initialStack === 200, 'cash settings preserve the current hand timer snapshot, deadline and poker revision')
  room = await command(host, { type: 'time-card', handNumber: 1 })
  assert.equal(room.actionDeadline, deadline! + 30000, 'The current timed hand can extend despite the next hand becoming unlimited')
  room = await command(host, action(room, { kind: 'call' }))
  assert.equal(room.actionDeadline, now + 30000)
  room = await command(host, { type: 'settings', actionSeconds: 20, initialStack: 300 })
  assert.equal(room.actionDeadline, now + 30000)
  room = await command(guest, { type: 'time-card', handNumber: 1 })
  assert.equal(room.actionDeadline, now + 60000)
  room = await command(guest, action(await read(guest), { kind: 'check' }))
  check(room.actionDeadline === now + 30000 && room.hand!.street === 'flop', 'later streets retain the current hand timer despite multiple pending settings changes')
  const newcomer = await join(host, 'New buy-in')
  room = await read(newcomer)
  check(player(room, newcomer.playerId).stack === 300 && player(room, host.playerId).stack === 49, 'new entrants receive the updated buy-in without changing existing stacks')
  await restore(host, saved => { const member = saved.members.find((p: any) => p.id === newcomer.playerId); member.stack = 0 })
  room = await command(newcomer, { type: 'rebuy' })
  check(player(room, newcomer.playerId).stack === 300, 'future rebuys use the updated buy-in')
  for (const settings of [{ actionSeconds: 10, initialStack: 400 }, { actionSeconds: 30, initialStack: 19 }, { actionSeconds: 30, initialStack: 20.25 }]) {
    await reject(commandPath(host), { type: 'settings', ...settings }, host.token, 'invalid settings are rejected atomically', 400)
    assert.equal((await read(host)).initialStack, 300)
    assert.equal((await read(host)).actionSeconds, 20)
  }
  await restore(host)
  check((await read(host)).initialStack === 300 && (await read(host)).actionSeconds === 20, 'future room settings survive storage restart')
  await reject(commandPath(newcomer), { type: 'remove-seat', seat: 3, capacity: 4 }, newcomer.token, 'spectators cannot remove empty seats', 403)
  await reject(commandPath(host), { type: 'remove-seat', seat: 2, capacity: 4 }, host.token, 'occupied seats cannot be removed', 409)
  room = await command(host, { type: 'remove-seat', seat: 1, capacity: 4 })
  assert.deepEqual(room.pendingSeatRemovals, [1])
  assert.equal(room.capacity, 4)
  assert.equal(room.seats[2], guest.playerId)
  const pokerBefore = room.actionRevision
  await command(host, { type: 'remove-seat', seat: 1, capacity: 4 })
  await reject(commandPath(newcomer), { type: 'sit', seat: 1 }, newcomer.token, 'a pending empty-seat removal cannot be occupied', 409)
  await reject(commandPath(host), { type: 'add-bot', seat: 1 }, host.token, 'a bot cannot occupy a pending empty-seat removal', 409)
  await restore(host)
  room = await read(host)
  check(room.capacity === 4 && room.actionRevision === pokerBefore && room.pendingSeatRemovals?.[0] === 1, 'empty-seat removal waits safely through active hand and restart without changing decisions')
  room = await command(guest, action(await read(guest), { kind: 'fold' }))
  assert.equal(room.capacity, 4, 'The settlement pause retains the live seat layout')
  room = await finishSettlement(host)
  check(room.capacity === 3 && room.seats[1] === guest.playerId && handPlayer(room, guest.playerId).seat === 1 && room.pendingSeatRemovals!.length === 0, 'settlement atomically compacts member and displayed hand seat indices')
  await reject(commandPath(host), { type: 'remove-seat', seat: 1, capacity: 4 }, host.token, 'a retried removal with stale capacity cannot remove a different seat', 409)
  room = await command(host, { type: 'remove-seat', seat: 2, capacity: 3 })
  assert.equal(room.capacity, 2)
  await reject(commandPath(host), { type: 'remove-seat', seat: 1, capacity: 2 }, host.token, 'seat removal retains a minimum of two seats', 409)
  now = room.nextHandAt!
  room = await read(host)
  check(room.hand!.bigBlindId === host.playerId && room.hand!.players.every(p => p.seat! >= 0 && p.seat! < 2), 'blind rotation and hand seats remain valid after arbitrary middle and last-seat removals')
  check(room.handActionSeconds === 20 && room.actionDeadline === now + 20000, 'the latest pending timer setting applies when the next hand is dealt')
  const multi = await create('Remove multiple', 5), other = await join(multi, 'Remove partner')
  await command(other, { type: 'sit', seat: 4 })
  room = await command(multi, { type: 'start' })
  for (const seat of [1, 2, 3]) await command(multi, { type: 'remove-seat', seat, capacity: 5 })
  await restore(multi)
  await command(multi, action(await read(multi), { kind: 'fold' }))
  room = await finishSettlement(other)
  check(room.capacity === 2 && room.seats[1] === other.playerId && handPlayer(room, other.playerId).seat === 1 && room.pendingSeatRemovals!.length === 0, 'multiple queued middle-seat removals compact safely in descending order')
}

async function handTimerSettingsChecks() {
  if (external) return
  for (const [original, updated] of [[30, 0], [0, 20]]) {
    const host = await create(`Timer ${original}`, 2, 50, undefined, { actionSeconds: original }), guest = await join(host, `Guest ${original}`)
    await command(guest, { type: 'sit', seat: 1 })
    let room = await command(host, { type: 'start' })
    // Missing snapshots in existing saved rooms adopt their persisted setting;
    // this also verifies that an unlimited (zero) snapshot is not defaulted away.
    await restore(host, saved => { delete saved.handActionSeconds })
    room = await read(host)
    check(room.handActionSeconds === original, `legacy active ${original}-second rooms receive a compatible timer snapshot`)
    const deadline = room.actionDeadline
    room = await command(host, { type: 'settings', actionSeconds: updated, initialStack: 50 })
    await restore(host)
    room = await read(host)
    check(room.actionSeconds === updated && room.handActionSeconds === original && room.actionDeadline === deadline, `${original}→${updated} timer settings persist separately from the current hand and deadline`)
    room = await command(host, action(room, { kind: 'call' }))
    assert.equal(room.actionDeadline, original === 0 ? null : now + original * 1000)
    if (original === 0) await reject(commandPath(guest), { type: 'time-card', handNumber: 1 }, guest.token, 'an unlimited current hand cannot spend time cards while the next hand is configured with a timer', 400)
    room = await command(guest, action(await read(guest), { kind: 'check' }))
    assert.equal(room.hand!.street, 'flop')
    await command(guest, { type: 'away', away: true })
    room = await command(guest, { type: 'away', away: false })
    check(room.actionDeadline === (original === 0 ? null : now + original * 1000), `${original}→${updated} changes leave all current-hand turns and returning-from-away timers unchanged`)
    await command(guest, action(await read(guest), { kind: 'fold' }))
    room = await finishSettlement(host)
    await restore(host)
    now = room.nextHandAt!
    room = await read(guest)
    check(room.hand!.number === 2 && room.handActionSeconds === updated && room.actionDeadline === (updated === 0 ? null : now + updated * 1000), `${original}→${updated} timer takes effect from the next hand after settlement and restart`)
    await restore(host)
    room = await command(guest, action(await read(guest), { kind: 'call' }))
    check(room.handActionSeconds === updated && room.actionDeadline === (updated === 0 ? null : now + updated * 1000), `the new ${updated}-second hand snapshot survives another restart and turn advance`)
  }
  const lobby = await create('Lobby timer', 2, 50), guest = await join(lobby, 'Lobby guest')
  await command(guest, { type: 'sit', seat: 1 })
  let room = await command(lobby, { type: 'settings', actionSeconds: 0, initialStack: 50 })
  assert.equal(room.handActionSeconds, null)
  await restore(lobby)
  room = await command(lobby, { type: 'start' })
  check(room.handActionSeconds === 0 && room.actionDeadline === null, 'settings changed before any hand apply directly to the first deal')
}

async function awayChecks() {
  if (external) return
  const host = await create('Away host', 2, 50, undefined, { actionSeconds: 0 }), guest = await join(host, 'Away guest')
  await command(guest, { type: 'sit', seat: 1 })
  let room = await command(host, { type: 'away', away: true })
  const awayUntil = now + 180000
  assert.equal(player(room, host.playerId).awayUntil, awayUntil)
  await advance(1000)
  room = await command(host, { type: 'away', away: true })
  assert.equal(player(room, host.playerId).awayUntil, awayUntil, 'Repeated away commands cannot extend the deadline')
  await restore(host)
  room = await command(host, { type: 'start' })
  check(room.hand!.players.some(p => p.id === host.playerId) && room.seats[0] === host.playerId && room.hand!.legal === null && room.actionDeadline === now + 50, 'away players keep their seat, post blinds and receive a hand while their turn auto-folds promptly')
  await reject(commandPath(host), action(room, { kind: 'call' }), host.token, 'away players must return before manual actions', 403)
  await advance(50)
  room = await read(guest)
  check(room.hand!.finished && room.hand!.history.some(a => a.playerId === host.playerId && a.kind === 'fold'), 'away auto-fold works even with unlimited action time')
  await finishSettlement(guest)
  room = await command(host, { type: 'away', away: false })
  assert.equal(player(room, host.playerId).awayUntil, null)
  now = room.nextHandAt!
  room = await read(host)
  await command(guest, action(await read(guest), { kind: 'call' }))
  room = await command(host, { type: 'away', away: true })
  room = await command(host, { type: 'away', away: false })
  check(room.hand!.toAct === host.playerId && room.hand!.legal?.canCheck && room.actionDeadline === null, 'returning before the automatic fold restores the current unlimited turn')
  room = await command(host, { type: 'away', away: true })
  await advance(50); room = await read(guest)
  check(room.hand!.history.some(a => a.playerId === host.playerId && a.kind === 'fold'), 'an away player folds even when checking would otherwise be free')

  const moving = await create('Away move', 3, 50, undefined, { actionSeconds: 0 }), movingGuest = await join(moving, 'Moving guest')
  await command(movingGuest, { type: 'sit', seat: 1 }); await command(moving, { type: 'start' })
  await command(moving, { type: 'sit', seat: 2 })
  room = await command(moving, { type: 'away', away: true })
  const movingAway = player(room, moving.playerId).awayUntil!
  await advance(50); await read(movingGuest)
  room = await finishSettlement(movingGuest)
  check(room.seats[2] === moving.playerId && player(room, moving.playerId).awayUntil === movingAway, 'fulfilling a queued seat move preserves a later away choice through settlement')
  now = room.nextHandAt!; await read(movingGuest)
  await command(movingGuest, action(await read(movingGuest), { kind: 'call' }))
  await advance(50); room = await read(movingGuest)
  check(room.hand!.history.some(a => a.playerId === moving.playerId && a.kind === 'fold'), 'an away player keeps auto-folding after their reserved seat move is applied')

  const idle = await create('Away boundary', 2, 50, undefined, { actionSeconds: 0 }), idleGuest = await join(idle, 'Boundary guest')
  await command(idleGuest, { type: 'sit', seat: 1 })
  room = await command(idle, { type: 'away', away: true })
  const expiry = player(room, idle.playerId).awayUntil!
  assert.equal(objects.get(idle.code)!.ctx.storage.alarm, expiry)
  now = expiry - 1; await restore(idle)
  assert.equal(player(await read(idleGuest), idle.playerId).seat, 0)
  now++
  await objects.get(idle.code)!.object.alarm()
  room = await read(idleGuest)
  check(player(room, idle.playerId).seat === null && player(room, idle.playerId).sittingOut && player(room, idle.playerId).awayUntil === null && room.seats[0] === null, 'cash away expires at exactly 180 seconds through an alarm and releases its seat')
  room = await command(idle, { type: 'away', away: false })
  assert.equal(player(room, idle.playerId).seat, null)
  await reject(commandPath(idle), { type: 'away', away: true }, idle.token, 'spectators cannot enter seated-away mode', 409)

  const live = await create('Away live expiry', 2, 50, undefined, { actionSeconds: 0 }), liveGuest = await join(live, 'Live guest'), replacement = await join(live, 'Replacement')
  await command(liveGuest, { type: 'sit', seat: 1 }); await command(live, { type: 'start' })
  room = await command(liveGuest, { type: 'away', away: true })
  now = player(room, liveGuest.playerId).awayUntil!
  room = await command(replacement, { type: 'sit', seat: 1 })
  assert.equal(room.seats[1], null)
  assert.equal(room.reservations[1], replacement.playerId)
  assert.equal(handPlayer(room, liveGuest.playerId).cards, null)
  await command(live, action(await read(live), { kind: 'call' }))
  await advance(50); room = await read(live)
  assert(room.hand!.history.some(a => a.playerId === liveGuest.playerId && a.kind === 'fold'))
  room = await finishSettlement(live)
  check(room.seats[1] === replacement.playerId && player(room, liveGuest.playerId).sittingOut && !room.hand!.players.some(p => p.id === replacement.playerId), 'midhand cash-away expiry releases the seat safely, folds the old participant and seats a replacement only after settlement')

  const timed = await create('Timeout host', 2, 50, undefined, { actionSeconds: 20 }), timedGuest = await join(timed, 'Timeout guest')
  await command(timedGuest, { type: 'sit', seat: 1 })
  room = await command(timed, { type: 'start' })
  now = room.actionDeadline!; room = await read(timedGuest)
  check(player(room, timed.playerId).timeoutCount === 1 && player(room, timed.playerId).awayUntil === null, 'one natural timeout records a strike without marking the player away')
  room = await finishSettlement(timedGuest); now = room.nextHandAt!
  room = await read(timedGuest)
  await command(timedGuest, action(room, { kind: 'call' }))
  room = await read(timed)
  room = await command(timed, action(room, { kind: 'check' }))
  check(player(room, timed.playerId).timeoutCount === 0, 'a successful manual poker action resets consecutive timeout strikes')
  room = await read(timed)
  now = room.actionDeadline!; room = await read(timedGuest)
  assert.equal(player(room, timed.playerId).timeoutCount, 1)
  await command(timedGuest, action(await read(timedGuest), { kind: 'check' }))
  room = await read(timed)
  now = room.actionDeadline!; room = await read(timedGuest)
  check(player(room, timed.playerId).timeoutCount === 2 && player(room, timed.playerId).awayUntil === now + 180000 && room.hand!.history.some(a => a.playerId === timed.playerId && a.kind === 'fold'), 'the second consecutive timeout automatically enters away mode and folds without another full action clock')
  const recordedAway = player(room, timed.playerId).awayUntil
  await restore(timed)
  assert.equal(player(await read(timedGuest), timed.playerId).awayUntil, recordedAway)

  const tournament = await create('Away tournament', 2, 50, undefined, { mode: 'tournament', actionSeconds: 0, registrationRaises: 0 })
  const opponent = await join(tournament, 'Tour away guest')
  room = await command(tournament, { type: 'away', away: true })
  const tournamentAway = player(room, tournament.playerId).awayUntil!
  now = tournamentAway + 1
  room = await read(opponent)
  check(room.seats[0] === tournament.playerId && player(room, tournament.playerId).awayUntil === tournamentAway && !player(room, tournament.playerId).sittingOut, 'tournament away never releases its seat after 180 seconds')
  room = await command(opponent, { type: 'start' })
  now = room.actionDeadline!; room = await read(opponent)
  check(room.hand!.finished && room.seats[0] === tournament.playerId, 'an expired tournament-away timer still auto-folds and preserves the registered seat')
}

async function tournamentAdmissionChecks() {
  if (external) return
  for (const operation of ['view', 'command']) {
    const legacy = await create(`Legacy ${operation}`, 2, 20, undefined, { mode: 'tournament' }), viewer = await join(legacy, 'Legacy spectator')
    await restore(legacy, saved => {
      const member = saved.members.find((p: any) => p.id === viewer.playerId)
      member.seat = null; member.sittingOut = true; member.stats.hands = 4
    })
    const result = await request(operation === 'view' ? roomPath(viewer) : commandPath(viewer), operation === 'view' ? 'GET' : 'POST', operation === 'view' ? undefined : { type: 'chat', text: 'Legacy spectator' }, viewer.token)
    assert.equal(result.status, 410)
    assert.equal(result.data.room.hand, null)
    assert.equal(result.data.room.players.length, 1)
    assert.equal(result.data.room.players[0].stats.hands, 4)
    const admitted = await join(legacy, 'Legacy spectator')
    check((await read(admitted)).seats[1] === admitted.playerId, `legacy tournament spectator ${operation} exits with final stats and can rejoin only through seat admission`)
  }
  const host = await create('Strict tour', 3, 20, undefined, { mode: 'tournament', registrationRaises: 0 })
  const b = await join(host, 'Tournament B'), c = await join(host, 'Tournament C')
  let room = await read(host)
  check(room.seats[1] === b.playerId && room.seats[2] === c.playerId && !player(room, b.playerId).sittingOut, 'tournament joins take available seats atomically even before the tournament starts')
  await reject(`${roomPath(host)}/join`, { name: 'Extra observer' }, undefined, 'full prestart tournaments reject spectator entry', 409)
  for (const commandBody of [{ type: 'stand' }, { type: 'cancel-seat' }, { type: 'spectator-cards', show: true }]) await reject(commandPath(b), commandBody, b.token, 'prestart tournament cannot be converted to spectator access', 409)
  await reject(commandPath(host), { type: 'settings', actionSeconds: 0, initialStack: 100 }, host.token, 'tournament room settings remain read-only', 409)
  await command(host, { type: 'start' })
  await restore(host, saved => {
    const ids = [host.playerId, b.playerId, c.playerId]
    saved.hand = startHand(ids, 0, saved.handNumber, { stacks: Object.fromEntries(ids.map(id => [id, 20])), deck: fixtureDeck(ids, ['Ac Ad', 'Ah As', 'Kc Kd'], '2s 4h 7d 9c Js'), deferRunout: true })
  })
  await command(host, action(await read(host), { kind: 'raise', to: 20 }))
  await command(b, action(await read(b), { kind: 'call' })); await command(c, action(await read(c), { kind: 'call' }))
  for (const actor of [host, b, c]) await command(actor, { type: 'runouts', count: 1, handNumber: 1 })
  room = await finishPlayback(host)
  assert.equal(player(room, c.playerId).tournamentStatus, 'eliminated')
  assert.equal(player(await read(c), c.playerId).stats.hands, 1)
  now = room.nextHandAt!
  room = await read(host)
  assert.equal(room.hand!.number, 2)
  const eliminated = await request(roomPath(c), 'GET', undefined, c.token)
  assert.equal(eliminated.status, 410)
  assert.equal(eliminated.data.room.hand, null)
  assert.deepEqual(eliminated.data.room.players.map((p: any) => p.id), [c.playerId])
  assert.equal(eliminated.data.room.players[0].stats.hands, 1)
  assert.equal(eliminated.data.room.players[0].tournamentPlace, 3)
  assert.deepEqual(eliminated.data.room.chat, [])
  check(eliminated.data.errorEn.includes('does not allow spectating'), 'eliminated entrants receive final own statistics and a localized terminal response without observing later hands')
  await restore(host)
  await reject(roomPath(c), undefined, c.token, 'eliminated observer exclusion persists across restart', 410)
  await reject(`${roomPath(host)}/join`, { name: 'Tournament C' }, undefined, 'an eliminated nickname cannot rejoin as an observer', 409)
  const leaving = success(await request(commandPath(b), 'POST', { type: 'leave' }, b.token), 'tournament departure')
  if (leaving.receipt) {
    await finishSettlement(host)
    const receipt = await read(leaving.receipt)
    check(receipt.hand === null && receipt.players.length === 1 && receipt.players[0].id === b.playerId, 'a departed tournament receipt is restricted to own final statistics after settlement')
  }
}

async function settlementChecks() {
  if (external) return
  const host = await create('Pause host', 3, 50), guest = await join(host, 'Pause guest'), observer = await join(host, 'Pause observer')
  await command(guest, { type: 'sit', seat: 1 })
  let room = await command(host, { type: 'start' })
  const ownCards = handPlayer(room, host.playerId).cards
  room = await command(host, action(room, { kind: 'fold' }))
  const deadline = now + 2000
  assert.equal(room.settlementAt, deadline)
  assert.equal(objects.get(host.code)!.ctx.storage.alarm, deadline)
  assert.equal(room.hand!.finished, true)
  assert.equal(room.hand!.delta, null)
  assert.deepEqual(room.hand!.runResults, [])
  assert.equal(room.nextHandAt, null)
  assert.equal(room.handHistory!.length, 0)
  assert(room.players.every(p => p.stats.hands === 0))
  assert.equal(room.hand!.players.reduce((sum, p) => sum + p.stack, 0) + room.hand!.pot, 100)
  assert.equal(player(room, guest.playerId).stack, handPlayer(room, guest.playerId).stack)
  check(player(room, guest.playerId).stack === 49.5, 'Fold completion exposes an exact two-second pause with the pot and before-award stacks intact')
  assert.equal(handPlayer(await read(observer), guest.playerId).cards, null, 'An uncontested human winner keeps its unshown cards private during the pause')
  await command(host, { type: 'show', handNumber: 1, cards: [0] })
  let watched = await read(observer)
  assert.deepEqual(handPlayer(watched, host.playerId).cards, [ownCards![0], null])
  noSecrets(watched)
  await reject(commandPath(observer), { type: 'show', handNumber: 1, cards: [0, 1] }, observer.token, 'spectators cannot reveal another hand during the settlement pause', 409)
  await reject(commandPath(host), { type: 'start' }, host.token, 'manual dealing cannot skip the settlement pause', 409)
  await reject(commandPath(host), { type: 'rebuy' }, host.token, 'rebuy cannot change a participating stack before settlement', 409)
  await reject(commandPath(host), action(room, { kind: 'check' }), host.token, 'a decided hand no longer accepts betting actions', 409)
  room = await command(host, { type: 'sit', seat: 2 })
  check(room.seats[0] === host.playerId && room.seats[2] === null && room.reservations[2] === host.playerId, 'seat moves wait until winnings are settled')
  now = deadline - 1
  await restore(host)
  room = await read(host)
  assert.equal(room.settlementAt, deadline)
  assert.equal(room.hand!.delta, null)
  assert.equal(room.nextHandAt, null)
  assert.equal(player(room, host.playerId).stats.hands, 0)
  assert.deepEqual(room.revealed[host.playerId], [0])
  now++
  room = await command(host, { type: 'show', handNumber: 1, cards: [1] })
  check(room.settlementAt === null && player(room, guest.playerId).stack === 50.5 && room.nextHandAt === now + 3000 && room.seats[2] === host.playerId, 'a reveal exactly at the settlement deadline succeeds while awards, statistics and seat changes commit once')
  assert.deepEqual(handPlayer(await read(observer), host.playerId).cards, ownCards)
  zeroSum(room)
  const settledPlayers = structuredClone(room.players)
  await restore(host)
  await command(host, { type: 'show', handNumber: 1, cards: [0, 1] })
  assert.deepEqual((await read(host)).players, settledPlayers)
  check((await read(host)).handHistory!.length === 1, 'settlement survives restart and repeated reveals without duplicate chips, statistics or history')
  now = room.nextHandAt!
  room = await command(host, { type: 'show', handNumber: 1, cards: [0, 1] })
  assert.equal(room.hand!.number, 2)
  assert.deepEqual(room.revealed, {})
  watched = await read(observer)
  assert(watched.hand!.players.every(p => p.cards === null))
  const newRevision = room.revision
  room = await command(host, { type: 'show', handNumber: 1, cards: [0] })
  check(room.revision === newRevision && Object.keys(room.revealed).length === 0, 'late reveal requests across the next-hand boundary are harmless and never reveal the new cards')
  await reject(commandPath(host), { type: 'show', handNumber: 1, cards: [2] }, host.token, 'stale reveal still validates card indices', 400)
  await reject(commandPath(host), { type: 'show', handNumber: 2, cards: [0] }, host.token, 'a reveal cannot expose an active betting hand', 409)
  await reject(commandPath(host), { type: 'show', handNumber: 3, cards: [0] }, host.token, 'future-hand reveals remain invalid', 409)

  const showdown = await create('Pause showdown', 2, 50, undefined, { mode: 'tournament', registrationRaises: 0 })
  const showdownGuest = await join(showdown, 'Showdown guest')
  await command(showdownGuest, { type: 'sit', seat: 1 })
  room = await command(showdown, { type: 'start' })
  while (!room.hand!.finished) {
    const actor = room.hand!.toAct === showdown.playerId ? showdown : showdownGuest
    const own = await read(actor)
    room = await command(actor, action(own, { kind: own.hand!.legal!.canCheck ? 'check' : 'call' }))
  }
  assert.equal(room.hand!.showdown, true)
  assert.equal(room.hand!.board.length, 5)
  assert.equal(room.hand!.delta, null)
  assert.deepEqual(room.hand!.runResults, [])
  assert(room.hand!.players.every(p => p.cards?.every(card => card !== null)))
  assert(room.tournament!.rankings.every(rank => rank.chips === 49))
  assert.equal(room.tournament!.status, 'running')
  const showdownDeadline = room.settlementAt!
  now = showdownDeadline - 1
  await restore(showdown)
  assert.equal((await read(showdown)).hand!.delta, null)
  now++
  await objects.get(showdown.code)!.object.alarm()
  room = await read(showdown)
  check(room.settlementAt === null && room.hand!.runResults!.length === 1 && room.nextHandAt === now + 5000, 'ordinary river showdowns expose cards immediately and publish winners two seconds later via the room alarm')
  zeroSum(room)

  const folded = await create('Run show host', 3, 20), runA = await join(folded, 'Run A'), runB = await join(folded, 'Run B')
  await command(runA, { type: 'sit', seat: 1 }); await command(runB, { type: 'sit', seat: 2 })
  room = await command(folded, { type: 'start' })
  const foldedCards = handPlayer(room, folded.playerId).cards
  await command(folded, action(room, { kind: 'fold' }))
  await command(runA, action(await read(runA), { kind: 'raise', to: 20 }))
  room = await command(runB, action(await read(runB), { kind: 'call' }))
  await command(runA, { type: 'runouts', count: 2, handNumber: 1 })
  room = await command(runB, { type: 'runouts', count: 2, handNumber: 1 })
  while (room.runoutPlayback!.phase === 'dealing') {
    now = room.runoutPlayback!.nextRevealAt
    room = await read(folded)
  }
  assert.equal(room.runoutPlayback!.phase, 'settling')
  assert.equal(room.hand!.finished, false)
  assert.equal(room.runoutPlayback!.completedResults.length, 0)
  await command(folded, { type: 'show', handNumber: 1, cards: [0] })
  watched = await read(runB)
  assert.deepEqual(handPlayer(watched, folded.playerId).cards, [foldedCards![0], null])
  noSecrets(watched)
  await restore(folded)
  room = await read(folded)
  now = room.settlementAt! - 1
  assert.equal((await read(runB)).runoutPlayback!.completedResults.length, 0)
  now++
  room = await read(folded)
  check(room.runoutPlayback!.phase === 'result' && room.settlementAt === null && room.runoutPlayback!.completedResults.length === 1, 'folded cards can be voluntarily revealed during an all-in pause without exposing the winner early')
  now = room.runoutPlayback!.nextRevealAt
  room = await command(folded, { type: 'show', handNumber: 1, cards: [1] })
  assert.equal(room.runoutPlayback!.phase, 'dealing')
  assert.equal(room.runoutPlayback!.boardIndex, 1)
  assert.deepEqual(handPlayer(await read(runB), folded.playerId).cards, foldedCards)
  check(room.hand!.number === 1 && room.hand!.board.length === 0 && room.runoutPlayback!.completedResults.length === 1, 'a reveal sent at a run-result boundary succeeds on the next board without leaking its result')
  while (room.runoutPlayback && !(room.runoutPlayback.phase === 'result' && room.runoutPlayback.boardIndex === 1)) {
    now = room.runoutPlayback.nextRevealAt
    room = await read(folded)
  }
  now = room.runoutPlayback!.nextRevealAt
  room = await read(folded)
  check(room.runoutPlayback === null && room.settlementAt === null && !!room.hand!.delta, 'the last run settles after its displayed result without a duplicate two-second pause')
}

async function resultDelayChecks() {
  if (external) return
  const folded = await create('Delay fold'), folder = await join(folded, 'Delay folder')
  await command(folder, { type: 'sit', seat: 1 })
  let room = await command(folded, { type: 'start' })
  assert.equal(room.hand!.number, 1)
  assert.equal(room.nextHandAt, null)
  room = await command(folded, action(room, { kind: 'fold' }))
  room = await finishSettlement(folded)
  assert.equal(room.nextHandAt, now + 3000)
  await command(folded, { type: 'show', cards: [0, 1], handNumber: 1 })
  await restore(folded)
  assert.equal((await read(folded)).nextHandAt, now + 3000)
  await advance(2999)
  assert.equal((await read(folded)).hand!.number, 1)
  await advance(1)
  check((await read(folded)).hand!.number === 2, 'a non-showdown hand waits exactly 3 seconds even when both cards are voluntarily shown')

  const normal = await create('Delay showdown'), normalGuest = await join(normal, 'Delay guest')
  await command(normalGuest, { type: 'sit', seat: 1 }); await command(normal, { type: 'start' })
  room = await passive(normal, [normal, normalGuest])
  assert.equal(room.hand!.showdown, true)
  assert.equal(room.runoutPlayback, null)
  const ordinaryDeadline = now + 5000
  assert.equal(room.nextHandAt, ordinaryDeadline)
  await restore(normal)
  assert.equal((await read(normal)).nextHandAt, ordinaryDeadline)
  await advance(4999)
  assert.equal((await read(normal)).hand!.number, 1)
  await advance(1)
  room = await read(normal)
  check(room.hand!.number === 2, 'an ordinary river showdown waits exactly 5 seconds and restart does not clamp the result window to 3 seconds')
  const manualActor = room.hand!.toAct === normal.playerId ? normal : normalGuest
  await command(manualActor, action(await read(manualActor), { kind: 'fold' }))
  await finishSettlement(normal)
  room = await command(normal, { type: 'start' })
  check(room.hand!.number === 3 && !room.hand!.finished && room.nextHandAt === null, 'an explicit start deals immediately without inheriting a prior result delay')

  function tiedRunoutDeck(count: number): Card[] {
    const parse = (text: string) => text.split(' ').map(card => parseCard(card)!)
    const holes = [parse('Ac Ad'), parse('Ah As')]
    const boards = ['2c 4h 7d 9s Js', '3c 5h 8d Ts Ks', '2d 4s 6h Qc Kd'].slice(0, count).map(parse)
    const known = [...holes.flat(), ...boards.flat()]
    assert.equal(new Set(known).size, known.length)
    const rest = fullDeck().filter(card => !known.includes(card))
    const deck = [holes[1][0], holes[0][0], holes[1][1], holes[0][1]]
    for (const board of boards) deck.push(rest.shift()!, ...board.slice(0, 3), rest.shift()!, board[3], rest.shift()!, board[4])
    return [...deck, ...rest]
  }
  for (const [count, delay] of [[1, 5000], [2, 7000], [3, 10000]] as [1 | 2 | 3, number][]) {
    const host = await create(`Delay run ${count}`, 2, 20), guest = await join(host, `Run guest ${count}`)
    await command(guest, { type: 'sit', seat: 1 }); await command(host, { type: 'start' })
    await restore(host, saved => {
      const ids = [host.playerId, guest.playerId]
      saved.hand = startHand(ids, 0, saved.handNumber, { stacks: Object.fromEntries(ids.map(id => [id, 20])), deck: tiedRunoutDeck(count), deferRunout: true })
    })
    await command(host, action(await read(host), { kind: 'raise', to: 20 }))
    await command(guest, action(await read(guest), { kind: 'call' }))
    const bettingEndedAt = now
    await command(host, { type: 'runouts', count, handNumber: 1 })
    room = await command(guest, { type: 'runouts', count, handNumber: 1 })
    while (room.runoutPlayback!.completedResults.length < count) {
      assert.equal(room.nextHandAt, null)
      now = room.runoutPlayback!.nextRevealAt
      room = await read(host)
    }
    assert.equal(room.runoutPlayback!.phase, 'result')
    now = room.runoutPlayback!.nextRevealAt - 1
    room = await read(host)
    assert.equal(room.hand!.finished, false)
    assert.equal(room.nextHandAt, null, 'Even the final winner display must finish before the next-hand clock starts')
    now++
    room = await read(host)
    assert.equal(room.runoutPlayback, null)
    assert.equal(room.hand!.finished, true)
    assert(now > bettingEndedAt)
    const nextDeadline = now + delay
    assert.equal(room.nextHandAt, nextDeadline)
    await restore(host)
    assert.equal((await read(host)).nextHandAt, nextDeadline)
    await advance(delay - 1)
    assert.equal((await read(host)).hand!.number, 1)
    await advance(1)
    room = await read(host)
    check(room.hand!.number === 2 && !room.hand!.finished, `${count}-run showdown waits exactly ${delay / 1000} seconds after final run presentation and settlement, preserving that deadline across restart`)
  }

  const paused = await create('Delay resume', 2, 20), busted = await join(paused, 'Resume guest')
  await command(busted, { type: 'sit', seat: 1 }); await command(paused, { type: 'start' })
  await restore(paused, saved => {
    const ids = [paused.playerId, busted.playerId]
    saved.hand = startHand(ids, 0, saved.handNumber, { stacks: Object.fromEntries(ids.map(id => [id, 20])), deck: fixtureDeck(ids, ['Ac Ad', 'Kc Kd'], '2s 4h 7d 9c Js'), deferRunout: true })
  })
  await command(paused, action(await read(paused), { kind: 'raise', to: 20 }))
  await command(busted, action(await read(busted), { kind: 'call' }))
  await command(paused, { type: 'runouts', count: 1, handNumber: 1 }); await command(busted, { type: 'runouts', count: 1, handNumber: 1 })
  room = await finishPlayback(paused)
  assert.equal(room.nextHandAt, now + 5000)
  await advance(5000)
  room = await read(paused)
  assert.equal(room.nextHandAt, null)
  assert.equal(room.hand!.number, 1)
  room = await command(busted, { type: 'rebuy' })
  assert.equal(room.nextHandAt, now + 3000)
  await advance(2999)
  assert.equal((await read(paused)).hand!.number, 1)
  await advance(1)
  check((await read(paused)).hand!.number === 2, 'rebuy resumes a paused table after its own 3-second countdown rather than reusing the old showdown window')
}

async function sqlitePersistence() {
  if (process.env.BATTLE_TEST_PERSISTENCE !== '1') return
  const [{ Miniflare, convertV4MiniflareOptions }, { build }, { mkdtemp, rm }, { tmpdir }, { join: joinPath }] = await Promise.all([
    import('miniflare'), import('esbuild'), import('node:fs/promises'), import('node:os'), import('node:path'),
  ])
  const directory = await mkdtemp(joinPath(tmpdir(), 'gto-battle-persistence-'))
  const bundle = await build({ entryPoints: ['server/index.ts'], bundle: true, format: 'esm', platform: 'browser', write: false })
  const options = convertV4MiniflareOptions({ name: 'gto-persistence-test', modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-07-01', resourcePersistencePath: directory, durableObjects: { ROOMS: { className: 'BattleRoom', useSQLite: true } } })
  let instance = new Miniflare(options)
  const call = async (path: string, body?: unknown, token?: string) => {
    const response = await instance.dispatchFetch(`http://localhost${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const data: any = await response.json(); assert.ok(response.ok, `SQLite HTTP ${response.status}: ${JSON.stringify(data)}`); return data
  }
  try {
    const host: RoomSession = (await call('/api/rooms', { name: 'SQLite host', capacity: 2, initialStack: 40 })).session
    const guest: RoomSession = (await call(`${roomPath(host)}/join`, { name: 'SQLite guest' })).session
    await call(commandPath(guest), { type: 'sit', seat: 1 }, guest.token)
    let room: RoomView = (await call(commandPath(host), { type: 'start' }, host.token)).room
    room = (await call(commandPath(host), action(room, { kind: 'fold' }), host.token)).room
    await new Promise(resolve => setTimeout(resolve, Math.max(0, room.settlementAt! - realNow())))
    await call(roomPath(host), undefined, host.token)
    await call(commandPath(host), { type: 'start' }, host.token)
    await call(commandPath(host), { type: 'settings', actionSeconds: 0, initialStack: 40 }, host.token)
    const before = (await call(roomPath(host), undefined, host.token)).room as RoomView
    const beforeGuest = (await call(roomPath(guest), undefined, guest.token)).room as RoomView
    await instance.dispose(); instance = new Miniflare(options)
    const after = (await call(roomPath(host), undefined, host.token)).room as RoomView
    const afterGuest = (await call(roomPath(guest), undefined, guest.token)).room as RoomView
    assert.deepEqual(after.hand, before.hand); assert.deepEqual(afterGuest.hand, beforeGuest.hand)
    assert.deepEqual(after.players.map(p => [p.id, p.stats, p.timeCards]), before.players.map(p => [p.id, p.stats, p.timeCards]))
    check(after.actionDeadline === before.actionDeadline && after.actionRevision === before.actionRevision && after.initialStack === 40, 'real SQLite worker restart retains exact private hands, cash stacks, statistics, time cards and deadlines')
    check(after.handActionSeconds === 30 && after.actionSeconds === 0, 'real SQLite restart preserves the current hand timer separately from the next-hand unlimited setting')
    noSecrets(after); noSecrets(afterGuest)
    const actor = after.hand!.toAct === host.playerId ? host : guest
    let finished = (await call(commandPath(actor), action(after, { kind: 'fold' }), actor.token)).room as RoomView
    await new Promise(resolve => setTimeout(resolve, Math.max(0, finished.settlementAt! - realNow())))
    finished = (await call(roomPath(actor), undefined, actor.token)).room as RoomView
    zeroSum(finished)
    check(finished.hand!.finished, 'restored SQLite hand accepts the next authenticated action and settles')
    room = (await call(commandPath(host), { type: 'start' }, host.token)).room
    assert.equal(room.handActionSeconds, 0); assert.equal(room.actionDeadline, null)
    await call(commandPath(host), { type: 'settings', actionSeconds: 20, initialStack: 40 }, host.token)
    await instance.dispose(); instance = new Miniflare(options)
    room = (await call(roomPath(host), undefined, host.token)).room
    assert.equal(room.actionSeconds, 20)
    assert.equal(room.handActionSeconds, 0)
    const nextActor = room.hand!.toAct === host.playerId ? host : guest
    room = (await call(commandPath(nextActor), action(room, { kind: 'call' }), nextActor.token)).room
    check(room.actionDeadline === null && room.handActionSeconds === 0, 'real SQLite restart and turn advance preserve an unlimited hand while the following hand is configured with a timer')
  } finally { await instance.dispose(); await rm(directory, { recursive: true, force: true }) }
}

async function fillBotLimitChecks() {
  if (external) return
  const host = await create('Fill limit', 6)
  await restore(host, saved => {
    const template = saved.members[0]
    for (let i = 1; i < 253; i++) saved.members.push({ ...structuredClone(template), id: `LEFT-${i}`, name: `Former ${i}`, leaving: true, seat: null, pendingSeat: null, token: '' })
  })
  await reject(commandPath(host), { type: 'fill-bots' }, host.token, 'batch fill validates member capacity before any bot is added', 409)
  const room = await read(host)
  check(room.players.length === 253 && room.players.every(p => !p.bot), 'failed batch fill leaves all seats and members unchanged')
}

try {
  await publicChecks()
  await fillBotLimitChecks()
  await controlledChecks()
  await nicknameAndBotChecks()
  await playbackHistoryAndReservationChecks()
  await unlimitedClockChecks()
  await tournamentChecks()
  await tournamentRecoveryAndWithdrawalChecks()
  await lateRegistrationChecks()
  await roomSettingsAndSeatChecks()
  await handTimerSettingsChecks()
  await awayChecks()
  await tournamentAdmissionChecks()
  await settlementChecks()
  await resultDelayChecks()
  await sqlitePersistence()
  console.log(`\nBattle API: ${checks} checks passed (${external ? baseUrl : 'isolated HTTP + controlled clock'})`)
} finally {
  await Promise.allSettled(sessions.map(s => request(commandPath(s), 'POST', { type: 'leave' }, s.token)))
  Date.now = realNow
}
