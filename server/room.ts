import { act, chooseBotAction, handView, legalActions, resolveRunouts, startHand, type BattleHand } from '../src/battle/game'
import { addStats, emptyStats, handStats } from '../src/battle/stats'
import { handPosition } from '../src/battle/presentation'
import type { ArchivedHandView, BattleAction, ChatMessage, PlayerStats, RoomMode, RoomView, RunoutPlayback, RunoutVote, TournamentView } from '../src/battle/types'
import { failure, HttpError, json, nicknameKey, playerName, readBody } from './http'
import { englishError } from './errors'

const TURN_MS = 30_000
const BOT_MS = 850
const RESUME_MS = 3_000
const resultDelay = (hand: Pick<BattleHand, 'showdown' | 'runCount'>) => !hand.showdown ? 3_000 : hand.runCount === 3 ? 10_000 : hand.runCount === 2 ? 7_000 : 5_000
const RUNOUT_CARD_MS = 900
const RUNOUT_RESULT_MS = 2_400
const SETTLEMENT_MS = 2_000
const AWAY_MS = 180_000
const HOUR_MS = 3_600_000
const ONLINE_MS = 20_000
const HOST_GRACE_MS = 60_000
const EXPIRY_MS = 24 * HOUR_MS
const TOURNAMENT_BIG_BLINDS = [1, 2, 3, 4, 6, 8, 12, 16, 20, 30, 40, 60, 80, 120, 160, 200, 300, 400, 600, 800, 1200, 1600, 2000, 3000, 4000, 6000, 8000, 12000, 16000]
const botNumber = (name: string): number | null => {
  const match = nicknameKey(name).match(/^(?:电脑|computer|bot)\s*(\d+)$/)
  return match ? Number(match[1]) : null
}
interface Member {
  buyIns: number; bustHand: number | null; bustStartingStack: number
  id: string; name: string; bot: boolean; score: number; token: string; seen: number; leaving: boolean
  seat: number | null; pendingSeat: number | null; stack: number; sittingOut: boolean
  timeCards: number; cardGrantAt: number; stats: PlayerStats; eligibleFromHand: number; lastChatAt: number
  shareWithSpectators: boolean
  entryStatus: 'ready' | 'waiting' | 'post'; receiptToken: string
  pendingRemoval: boolean
  awayUntil: number | null; timeoutCount: number
  awayFoldHand?: number; receiptHand?: number
  reservationEntryStatus?: Member['entryStatus']
}
interface PlaybackState extends RunoutPlayback { resolved: BattleHand; prefixLength: number }
interface SettlementState { resolved: BattleHand; dueAt: number }
interface TournamentState extends Omit<TournamentView, 'rankings'> {
  eliminated: Record<string, { place: number; forfeited: boolean; handNumber?: number; exitAt?: number }>
  pendingWithdrawals: string[]
}
interface StoredHand extends Omit<ArchivedHandView, 'myCards'> {
  // Never serialized directly to clients. A nickname alone cannot recover these cards.
  privateCards?: Record<string, { token: string; cards: [number, number] }>
}
interface RoomData {
  mode: RoomMode; actionSeconds: number; handActionSeconds: number | null; tournament: TournamentState | null
  version: 2; instanceId: string; code: string; capacity: number; initialStack: number; hostId: string
  revision: number; actionRevision: number; members: Member[]; hand: BattleHand | null
  handSeats: Record<string, number>; handNumber: number; lastDealerSeat: number; lastBigBlindSeat: number; started: boolean
  actionDeadline: number | null; nextHandAt: number | null; scoredHand: number; lastActivity: number
  revealed: Record<string, number[]>; runoutVote: RunoutVote | null; chat: ChatMessage[]
  seatRequests: string[]
  runoutPlayback: PlaybackState | null; handHistory: StoredHand[]
  settlement: SettlementState | null
  pendingSeatRemovals: number[]
}

/** One room owns all seats, chips, identities and deadlines. No client receives the deck. */
export class BattleRoom {
  private room: RoomData | null = null
  // Delivery receipts expire quickly and cannot restore or rejoin a dissolved room.
  private receipts: Record<string, { room: RoomView; expiresAt: number }> = {}
  private savedPresenceAt = 0
  constructor(private ctx: DurableObjectState) {
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<RoomData>('room')
      if (saved) this.room = this.migrate(saved)
      this.receipts = await ctx.storage.get<typeof this.receipts>('receipts') ?? {}
    })
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const [, code, operation] = new URL(request.url).pathname.split('/')
      const body = request.method === 'POST' ? await readBody(request) : {}
      return await this.ctx.blockConcurrencyWhile(async () => {
        try {
          await this.expire()
          if (operation === 'create') return await this.create(code, body)
          const token = request.headers.get('Authorization')?.replace(/^Bearer /, '')
          const finalReceipt = token && operation === 'view' ? this.receipts[token] : undefined
          if (finalReceipt && finalReceipt.expiresAt > Date.now()) return json({ room: finalReceipt.room })
          if (!this.room) throw new HttpError(404, '房间不存在或已过期，请重新创建或加入')
          if (operation === 'join') return await this.join(body)
          const receipt = operation === 'view' && this.room.members.find(p => p.leaving && p.receiptToken && p.receiptToken === token)
          if (receipt) {
            if (this.tick(Date.now())) await this.persist()
            if (this.room.tournament && (!this.activeHand() || this.room.handNumber !== (receipt.receiptHand ?? this.room.handNumber))) {
              return json({ room: this.finalTournamentView(receipt.id, receipt.receiptHand ?? this.room.handNumber) })
            }
            return json({ room: this.view(receipt.id) })
          }
          const member = this.room.members.find(p => !p.bot && !p.leaving && p.token === token && !!token)
          if (!member) throw new HttpError(401, '加入凭证已失效，请重新加入房间')
          if (this.room.tournament && member.seat === null && member.pendingSeat === null && !this.room.tournament.entrantIds.includes(member.id)) {
            const message = '锦标赛不开放观赛，请报名入座'
            member.leaving = true; member.token = ''; member.seen = 0
            this.transferAbsentHost(Date.now()); this.room.revision++
            const finalRoom = this.finalTournamentView(member.id, this.room.handNumber)
            await this.persist()
            return json({ error: message, errorEn: englishError(message), room: finalRoom }, 410)
          }
          const now = Date.now()
          member.seen = now
          this.room.lastActivity = now
          const changed = this.tick(now) || false
          const transferred = this.transferAbsentHost(now)
          const scheduled = this.scheduleNext()
          if (changed || transferred || scheduled) await this.persist()
          const elimination = this.room.tournament?.eliminated[member.id]
          if (elimination && (this.room.handNumber > (elimination.handNumber ?? this.room.handNumber) || now >= (elimination.exitAt ?? Infinity))) {
            const message = '已淘汰，本次锦标赛不开放观赛'
            return json({ error: message, errorEn: englishError(message), room: this.finalTournamentView(member.id, elimination.handNumber ?? this.room.handNumber) }, 410)
          }
          if (operation === 'command') return await this.command(member, body)
          if (now - this.savedPresenceAt > 10_000) await this.persist()
          return json({ room: this.view(member.id) })
        } catch (error) { return failure(error) }
      })
    } catch (error) { return failure(error) }
  }

  async alarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.expire()
      if (!this.room) return
      this.tick(Date.now())
      await this.persist()
    })
  }

  private migrate(saved: RoomData): RoomData {
    const now = Date.now()
    const old = saved as RoomData & { lastDealerId?: string }
    const wasV2 = old.version === 2
    const room: RoomData = {
      ...old, version: 2, instanceId: old.instanceId ?? crypto.randomUUID(), initialStack: old.initialStack ?? 100,
      mode: old.mode ?? 'cash', actionSeconds: old.actionSeconds ?? 30,
      handActionSeconds: old.hand ? old.handActionSeconds ?? old.actionSeconds ?? 30 : null,
      tournament: old.tournament ? { ...old.tournament, pendingWithdrawals: old.tournament.pendingWithdrawals ?? [],
        registrationRaises: old.tournament.registrationRaises ?? 0,
        registrationClosesAt: old.tournament.registrationClosesAt ?? (old.tournament.startedAt === null ? null : old.tournament.startedAt + (old.tournament.registrationRaises ?? 0) * old.tournament.blindIntervalMinutes * 60_000),
        registrationOpen: old.tournament.registrationOpen ?? old.tournament.status === 'waiting' } : null,
      actionRevision: old.actionRevision ?? old.revision, started: old.started ?? !!old.hand,
      lastDealerSeat: old.lastDealerSeat ?? -1, nextHandAt: old.nextHandAt ?? null,
      lastBigBlindSeat: old.lastBigBlindSeat ?? -1,
      handSeats: old.handSeats ?? {}, revealed: old.revealed ?? {}, runoutVote: old.runoutVote ?? null, chat: old.chat ?? [], seatRequests: old.seatRequests ?? [],
      runoutPlayback: old.runoutPlayback ?? null, handHistory: old.handHistory ?? [], settlement: old.settlement ?? null,
      pendingSeatRemovals: old.pendingSeatRemovals ?? [],
      members: old.members.map((p, index) => ({
        ...p, seat: p.seat === undefined ? (p.leaving ? null : index) : p.seat, pendingSeat: p.pendingSeat ?? null,
        buyIns: p.buyIns ?? (old.tournament && !old.tournament.entrantIds.includes(p.id) && p.seat === null ? 0 : 1),
        bustHand: p.bustHand ?? (p.stack === 0 ? old.handNumber : null), bustStartingStack: p.bustStartingStack ?? 0,
        stack: p.stack ?? old.hand?.players.find(hp => hp.id === p.id)?.stack ?? 100,
        sittingOut: p.sittingOut ?? p.leaving, timeCards: p.timeCards ?? 3, cardGrantAt: p.cardGrantAt ?? now,
        stats: p.stats ?? { ...emptyStats(), netBB: p.score }, eligibleFromHand: p.eligibleFromHand ?? 0, lastChatAt: p.lastChatAt ?? 0, shareWithSpectators: p.shareWithSpectators ?? false,
        entryStatus: p.entryStatus ?? 'ready', receiptToken: p.receiptToken ?? '', pendingRemoval: p.pendingRemoval ?? false,
        awayUntil: p.awayUntil ?? null, timeoutCount: p.timeoutCount ?? 0,
      })),
    }
    if (room.tournament) for (const [id, result] of Object.entries(room.tournament.eliminated)) {
      result.handNumber ??= room.members.find(p => p.id === id)?.bustHand ?? room.handNumber
      result.exitAt ??= now + (room.hand ? resultDelay(room.hand) : RESUME_MS)
    }
    // Legacy clients could give separate IDs the same nickname. Keep each
    // credential/result record, preserving the most recently active name and
    // suffixing the others instead of merging unrelated players' statistics.
    const reservedNames = new Set(room.members.map(p => nicknameKey(p.name)))
    const humanNames = new Set<string>()
    const humans = room.members.filter(p => !p.bot).sort((a, b) => Number(a.leaving) - Number(b.leaving) || b.seen - a.seen)
    for (const member of humans) {
      member.name = member.name.normalize('NFKC').trim()
      const original = member.name
      if (humanNames.has(nicknameKey(original))) {
        let n = 2
        do {
          const suffix = ` (${n++})`
          member.name = [...original].slice(0, 16 - suffix.length).join('') + suffix
        } while (reservedNames.has(nicknameKey(member.name)))
        reservedNames.add(nicknameKey(member.name))
      }
      humanNames.add(nicknameKey(member.name))
    }
    // Also repair old reused computer names without changing their IDs.
    const usedNames = new Set(room.members.filter(p => !p.bot).map(p => nicknameKey(p.name)))
    const usedBotNumbers = new Set(room.members.filter(p => !p.bot).map(p => botNumber(p.name)).filter(n => n !== null))
    for (const member of room.members.filter(p => p.bot)) {
      const number = botNumber(member.name)
      if (number !== null) member.name = `电脑${number}`
      if (usedNames.has(nicknameKey(member.name)) || (number !== null && usedBotNumbers.has(number))) member.name = this.nextBotName(room.members)
      usedNames.add(nicknameKey(member.name))
      const assigned = botNumber(member.name)
      if (assigned !== null) usedBotNumbers.add(assigned)
    }
    if (room.hand) {
      room.hand.deferRunout = true
      room.hand.awaitingRunout ??= false
      room.hand.boards ??= room.hand.finished && room.hand.showdown ? [[...room.hand.board]] : []
      room.hand.runCount ??= 1
      for (const p of room.hand.players) room.handSeats[p.id] ??= room.members.findIndex(m => m.id === p.id)
      if (!wasV2) {
        const dealer = room.hand.players[room.hand.dealerIndex].id
        room.lastDealerSeat = room.handSeats[dealer]
        room.lastBigBlindSeat = room.handSeats[room.hand.bigBlindId]
        if (room.hand.finished) room.nextHandAt = now + resultDelay(room.hand)
        else if (room.actionDeadline !== null) room.actionDeadline = Math.min(room.actionDeadline, now + TURN_MS)
      }
    }
    return room
  }

  private nextBotName(members: Member[]): string {
    const numbers = members.map(p => botNumber(p.name) ?? 0)
    let n = Math.max(0, ...numbers) + 1
    while (members.some(p => nicknameKey(p.name) === nicknameKey(`电脑${n}`))) n++
    return `电脑${n}`
  }
  private newMember(name: string, id: string, stack: number): Member {
    return { id, name, stack, buyIns: 1, bustHand: null, bustStartingStack: 0, token: crypto.randomUUID(), bot: false, score: 0, seen: Date.now(), leaving: false,
      seat: null, pendingSeat: null, sittingOut: true, timeCards: 3, cardGrantAt: Date.now(), stats: emptyStats(), eligibleFromHand: 0, lastChatAt: 0, shareWithSpectators: false, entryStatus: 'ready', receiptToken: '', pendingRemoval: false, awayUntil: null, timeoutCount: 0 }
  }
  private async create(code: string, body: Record<string, unknown>) {
    if (this.room) throw new HttpError(409, '房间已存在')
    const name = playerName(body.name), id = `P-${crypto.randomUUID()}`
    const capacity = body.capacity, stack = body.initialStack ?? 100
    const mode = body.mode ?? 'cash', actionSeconds = body.actionSeconds ?? 30, blindIntervalMinutes = body.blindIntervalMinutes ?? 10
    const registrationRaises = body.registrationRaises ?? 3
    if (mode !== 'cash' && mode !== 'tournament') throw new HttpError(400, '牌桌模式无效')
    if (typeof actionSeconds !== 'number' || ![0, 20, 30, 40, 50, 60].includes(actionSeconds)) throw new HttpError(400, '行动时间需为不限时或 20、30、40、50、60 秒')
    if (typeof blindIntervalMinutes !== 'number' || !Number.isInteger(blindIntervalMinutes) || blindIntervalMinutes < 1 || blindIntervalMinutes > 60) throw new HttpError(400, '升盲间隔需为 1–60 分钟')
    if (typeof registrationRaises !== 'number' || !Number.isInteger(registrationRaises) || registrationRaises < 0 || registrationRaises > 10) throw new HttpError(400, '报名与重购截止需为升盲 0–10 次后')
    if (typeof capacity !== 'number' || !Number.isInteger(capacity) || capacity < 2 || capacity > 9) throw new HttpError(400, '牌桌人数需为 2–9 人')
    if (typeof stack !== 'number' || !Number.isFinite(stack) || stack < 20 || stack > 1000 || !Number.isInteger(stack * 2)) throw new HttpError(400, '初始筹码需为 20–1000 BB，单位为 0.5 BB')
    const host = this.newMember(name, id, stack)
    host.seat = 0; host.sittingOut = false
    this.room = { version: 2, instanceId: crypto.randomUUID(), code, capacity, initialStack: stack, hostId: id, mode, actionSeconds, handActionSeconds: null,
      tournament: mode === 'tournament' ? { status: 'waiting', startedAt: null, winnerId: null, entrantIds: [], eliminated: {}, pendingWithdrawals: [],
        registrationRaises, registrationClosesAt: null, registrationOpen: true,
        level: 1, smallBlind: 0.5, bigBlind: 1, nextLevelAt: null, blindIntervalMinutes } : null,
      revision: 1, actionRevision: 1, members: [host], hand: null, handSeats: {}, handNumber: 0, lastDealerSeat: -1, lastBigBlindSeat: -1,
      actionDeadline: null, nextHandAt: null, scoredHand: 0, lastActivity: Date.now(), started: false, revealed: {}, runoutVote: null, chat: [], seatRequests: [], runoutPlayback: null, handHistory: [], settlement: null, pendingSeatRemovals: [] }
    await this.persist()
    return this.joined(host)
  }
  private async join(body: Record<string, unknown>) {
    const room = this.room!, name = playerName(body.name)
    if (this.closeRegistration(Date.now())) room.revision++
    const matches = room.members.filter(p => nicknameKey(p.name) === nicknameKey(name)
      || (p.bot && botNumber(p.name) !== null && botNumber(p.name) === botNumber(name)))
    if (matches.some(p => p.bot || (!p.leaving && Date.now() - p.seen <= HOST_GRACE_MS))) throw new HttpError(409, '此昵称正在使用，请更换昵称或恢复原标签页')
    const existing = matches[0]
    if ((!existing || existing.leaving) && room.members.filter(p => !p.bot && !p.leaving).length >= 64) throw new HttpError(409, '房间观战人数已满')
    if (!existing && room.members.length >= 256) throw new HttpError(409, '本桌玩家记录已满，请创建新房间')
    const tournament = room.tournament
    const restoringEntrant = !!existing && !existing.leaving && !!tournament
      && (tournament.entrantIds.includes(existing.id) || existing.seat !== null || existing.pendingSeat !== null)
    let tournamentSeat: number | undefined
    if (tournament) {
      if (existing && (tournament.eliminated[existing.id] || tournament.pendingWithdrawals.includes(existing.id)
        || existing.leaving && tournament.entrantIds.includes(existing.id))) throw new HttpError(409, '已退赛或淘汰，不能重新报名或观赛')
      if (!restoringEntrant) {
        if (!this.registrationOpen()) throw new HttpError(409, '锦标赛报名已截止，不开放观赛')
        tournamentSeat = Array.from({ length: room.capacity }, (_, seat) => seat).find(seat => !room.pendingSeatRemovals.includes(seat)
          && !room.members.some(p => !p.leaving && (p.seat === seat || p.pendingSeat === seat)))
        if (tournamentSeat === undefined) throw new HttpError(409, '锦标赛座位已满，不开放观赛')
      }
    }
    const member = existing ?? this.newMember(name, `P-${crypto.randomUUID()}`, room.initialStack)
    const entrantState = restoringEntrant ? { seat: member.seat, pendingSeat: member.pendingSeat, sittingOut: member.sittingOut,
      entryStatus: member.entryStatus } : {}
    Object.assign(member, { name, token: crypto.randomUUID(), leaving: false, seen: Date.now(), sittingOut: true,
      seat: null, pendingSeat: null, reservationEntryStatus: undefined, cardGrantAt: Date.now(), eligibleFromHand: room.handNumber + 1, shareWithSpectators: false, receiptToken: '', entryStatus: room.started && !room.tournament ? 'waiting' : 'ready', awayUntil: restoringEntrant ? member.awayUntil : null, timeoutCount: 0 })
    Object.assign(member, entrantState)
    if (!existing) room.members.push(member)
    if (tournamentSeat !== undefined) {
      member.buyIns ||= 1
      if (room.started) this.registerEntrant(member)
      if (this.activeHand()) member.pendingSeat = tournamentSeat
      else this.takeSeat(member, tournamentSeat)
    }
    if (restoringEntrant && this.activeHand() && room.hand!.toAct === member.id) room.actionDeadline = Date.now() + 50
    if (room.runoutVote?.eligibleIds.includes(member.id)) {
      room.runoutVote.votes[member.id] = 1
      this.finishVoting(false)
    }
    room.lastActivity = Date.now(); room.revision++
    this.transferAbsentHost(Date.now())
    this.scheduleNext()
    await this.persist()
    return this.joined(member)
  }
  private async command(member: Member, body: Record<string, unknown>) {
    const room = this.room!
    if (room.tournament && ['stand', 'cancel-seat', 'spectator-cards'].includes(String(body.type))) throw new HttpError(409, '锦标赛不开放观赛，不能站起或取消入座')
    if (body.type === 'sit' && body.seat === member.seat && !member.sittingOut) return json({ room: this.view(member.id) })
    if (body.type === 'sit' && body.seat === member.pendingSeat) return json({ room: this.view(member.id) })
    if (room.tournament && room.tournament.status !== 'waiting') {
      if (['stand', 'cancel-seat', 'post-blind', 'remove-bot', 'start'].includes(String(body.type))) {
        throw new HttpError(409, '已报名的锦标赛席位不能移动、取消或替换')
      }
      if (['sit', 'rebuy', 'add-bot', 'fill-bots', 'add-seat', 'request-seat'].includes(String(body.type)) && !this.registrationOpen()) {
        throw new HttpError(409, '锦标赛报名与重购已截止')
      }
      if (['sit', 'rebuy'].includes(String(body.type)) && (room.tournament.eliminated[member.id] || room.tournament.pendingWithdrawals.includes(member.id))) {
        throw new HttpError(409, '已退赛或淘汰，不能重新报名')
      }
      if (body.type === 'sit' && room.tournament.entrantIds.includes(member.id)) throw new HttpError(409, '已报名的锦标赛席位不能移动、取消或替换')
      if (body.type === 'rebuy' && !room.tournament.entrantIds.includes(member.id)) throw new HttpError(409, '请先报名入座')
    }
    if (body.type === 'leave') {
      if (room.tournament?.status === 'running' && room.tournament.entrantIds.includes(member.id) && !room.tournament.eliminated[member.id]) {
        if (!room.tournament.pendingWithdrawals.includes(member.id)) room.tournament.pendingWithdrawals.push(member.id)
      }
      member.leaving = true; member.token = ''; member.seen = 0; member.sittingOut = true; member.seat = null; member.pendingSeat = null; member.awayUntil = null
      member.shareWithSpectators = false; room.seatRequests = room.seatRequests.filter(id => id !== member.id)
      const humans = room.members.filter(p => !p.bot && !p.leaving)
      if (!humans.length) {
        let steps = 0
        while (this.activeHand() && steps++ < 2000) {
          if (room.settlement) this.completeSettlement()
          else if (room.runoutPlayback) this.completePlayback()
          else if (room.hand!.awaitingRunout) this.finishVoting(true)
          else this.automaticAction(room.members.find(p => p.id === room.hand!.toAct)!)
        }
        const finalRoom = this.view(member.id)
        const finalReceipts: typeof this.receipts = {}
        for (const departed of room.members.filter(p => p.leaving && p.receiptToken)) {
          const snapshot = this.view(departed.id)
          finalReceipts[departed.receiptToken] = { expiresAt: Date.now() + 120_000, room: {
            ...snapshot, players: snapshot.players.filter(p => p.id === departed.id), hand: null, handActionSeconds: null,
            hostId: departed.id, seats: [], reservations: [], chat: [], revealed: {}, seatRequests: [], runoutVote: null, runoutPlayback: null, handHistory: [], tournament: null,
          } }
        }
        await this.destroy(finalReceipts)
        return json({ left: true, room: finalRoom })
      }
      if (room.hostId === member.id) room.hostId = humans.sort((a, b) => b.seen - a.seen)[0].id
      if (room.hand?.toAct === member.id && !room.hand.finished) room.actionDeadline = Date.now()
      if (room.runoutVote?.eligibleIds.includes(member.id)) room.runoutVote.votes[member.id] = 1
      room.revision++; this.tick(Date.now()); this.finishVoting(false)
      this.updateTournament()
      member.receiptToken = crypto.randomUUID()
      member.receiptHand = room.handNumber
      await this.persist()
      return json({ left: true, room: this.view(member.id), receipt: { code: room.code, playerId: member.id, token: member.receiptToken } })
    }
    if (body.type === 'action') {
      this.requireHand(body.handNumber)
      if (body.revision !== room.actionRevision) throw new HttpError(409, '牌局已更新，请根据最新局面行动')
      if (member.sittingOut || member.eligibleFromHand > room.handNumber) throw new HttpError(403, '观战玩家不能行动')
      if (member.awayUntil !== null) throw new HttpError(403, '请先取消暂离再行动')
      const action = this.parseAction(body.action)
      try { act(room.hand!, member.id, action) } catch (error) { throw new HttpError(400, (error as Error).message) }
      member.timeoutCount = 0
      room.actionRevision++; this.afterAction()
    } else if (body.type === 'time-card') {
      this.requireHand(body.handNumber)
      if (room.actionDeadline === null) throw new HttpError(400, '不限时牌桌无需使用加时卡')
      if (room.hand!.toAct !== member.id || !room.actionDeadline || member.sittingOut || member.awayUntil !== null || member.eligibleFromHand > room.handNumber) throw new HttpError(400, '只能在自己的行动回合使用加时卡')
      this.grantCards(member, Date.now())
      if (member.timeCards < 1) throw new HttpError(400, '没有可用的加时卡')
      member.timeCards--; room.actionDeadline += TURN_MS
    } else if (body.type === 'sit') {
      const seat = this.validSeat(body.seat)
      if (room.pendingSeatRemovals.includes(seat)) throw new HttpError(409, '此空座将在本手结束后移除')
      if (member.stack <= 0) throw new HttpError(400, '筹码不足，请先补码再入座')
      const occupant = room.members.find(p => p.seat === seat && !p.leaving)
      if (room.tournament?.status === 'running' && occupant) throw new HttpError(409, '锦标赛只能报名空座，不能替换参赛玩家')
      if (occupant && !occupant.bot && occupant.id !== member.id) throw new HttpError(409, '这个座位已被真人占用')
      if (room.members.some(p => !p.leaving && p.pendingSeat === seat && p.id !== member.id)) throw new HttpError(409, '这个座位已被预约')
      if (this.activeHand() && member.pendingSeat === null) member.reservationEntryStatus = member.entryStatus
      member.entryStatus = room.started && !room.tournament ? 'waiting' : 'ready'
      if (room.tournament) {
        member.buyIns ||= 1
        if (room.started) this.registerEntrant(member)
      }
      if (this.activeHand()) member.pendingSeat = seat
      else this.takeSeat(member, seat)
    } else if (body.type === 'cancel-seat') {
      if (member.pendingSeat === null) throw new HttpError(400, '没有待取消的座位预约')
      member.pendingSeat = null
      member.entryStatus = member.reservationEntryStatus ?? (member.seat === null && room.started ? 'waiting' : 'ready')
      delete member.reservationEntryStatus
    } else if (body.type === 'post-blind') {
      if (member.seat === null && member.pendingSeat === null) throw new HttpError(400, '请先选择座位')
      if (member.stack <= 0) throw new HttpError(400, '筹码不足，请先补码再入座')
      if (member.entryStatus === 'ready') throw new HttpError(400, '你已经可以正常参与牌局')
      member.entryStatus = 'post'
    } else if (body.type === 'stand') {
      this.standMember(member)
      this.tick(Date.now()); this.finishVoting(false)
    } else if (body.type === 'away') {
      if (typeof body.away !== 'boolean') throw new HttpError(400, '暂离状态无效')
      if (body.away) {
        if (member.seat === null || member.sittingOut) throw new HttpError(409, '入座后才能暂离')
        if (member.awayUntil === null) member.awayUntil = Date.now() + AWAY_MS
        if (room.hand?.toAct === member.id && !room.hand.finished) room.actionDeadline = Date.now() + 50
        if (room.runoutVote?.eligibleIds.includes(member.id)) { room.runoutVote.votes[member.id] = 1; this.finishVoting(false) }
      } else {
        const wasAway = member.awayUntil !== null
        member.awayUntil = null; member.timeoutCount = 0
        if (wasAway && room.hand?.toAct === member.id && !room.hand.finished && !room.runoutPlayback) this.afterAction()
      }
    } else if (body.type === 'rebuy') {
      if (this.activeHand() && room.hand!.players.some(p => p.id === member.id)) throw new HttpError(409, '请等本手结束后补码')
      if (member.stack > 0) throw new HttpError(400, '只有输完筹码后才能补码')
      member.stack = room.initialStack; member.buyIns++; member.bustHand = null; member.bustStartingStack = 0
      if (room.tournament) { member.entryStatus = 'ready'; member.eligibleFromHand = room.handNumber + 1 }
      if (member.seat !== null) member.sittingOut = false
    } else if (body.type === 'show') {
      const cards = body.cards
      if (!Array.isArray(cards) || cards.length > 2 || cards.some(i => i !== 0 && i !== 1)) throw new HttpError(400, '请选择要展示的底牌')
      // A click from the result view can reach us after the automatic next deal.
      // Acknowledge the old hand without ever applying it to the new cards.
      if (typeof body.handNumber === 'number' && Number.isInteger(body.handNumber) && body.handNumber > 0 && room.hand && body.handNumber < room.hand.number) return json({ room: this.view(member.id) })
      // Betting has ended throughout runout playback. A reveal sent during a
      // result window remains valid if transit advances us to the next board.
      const mayReveal = room.hand?.finished || !!room.runoutPlayback
      if (!room.hand || !mayReveal || body.handNumber !== room.hand.number || !room.hand.players.some(p => p.id === member.id) || member.eligibleFromHand > room.handNumber) throw new HttpError(409, '只能展示刚结束的自己的手牌')
      room.revealed[member.id] = [...new Set([...(room.revealed[member.id] ?? []), ...cards])]
    } else if (body.type === 'runouts') {
      const vote = room.runoutVote
      if (!vote || body.handNumber !== vote.handNumber || !vote.eligibleIds.includes(member.id) || member.sittingOut || member.eligibleFromHand > vote.handNumber) throw new HttpError(409, '当前没有需要你选择的发牌次数')
      if (![1, 2, 3].includes(body.count as number)) throw new HttpError(400, '发牌次数必须为 1、2 或 3')
      if (vote.votes[member.id]) throw new HttpError(409, '已经提交发牌次数')
      vote.votes[member.id] = body.count as 1 | 2 | 3
      this.finishVoting(false)
    } else if (body.type === 'fast-forward') {
      if (!this.canFastForward()) throw new HttpError(400, '仍有真人参与行动，暂不能加速')
      let steps = 0
      while (this.activeHand() && !room.hand!.finished && !room.hand!.awaitingRunout && !room.runoutPlayback && steps++ < 2000) {
        const actor = room.members.find(p => p.id === room.hand!.toAct)!
        this.automaticAction(actor)
      }
      if (room.hand?.awaitingRunout) this.finishVoting(false)
    } else if (body.type === 'spectator-cards') {
      if (typeof body.show !== 'boolean') throw new HttpError(400, '底牌公开设置无效')
      member.shareWithSpectators = body.show
    } else if (body.type === 'request-seat') {
      if (room.capacity >= 9) throw new HttpError(400, '最多只能设置 9 个席位')
      if (!room.seatRequests.includes(member.id)) room.seatRequests.push(member.id)
    } else if (body.type === 'chat') {
      const message = typeof body.text === 'string' ? body.text.trim() : ''
      if (!message || [...message].length > 300 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(message)) throw new HttpError(400, '聊天消息需为 1–300 个字符')
      if (Date.now() - member.lastChatAt < 750) throw new HttpError(429, '消息发送太快，请稍后重试')
      member.lastChatAt = Date.now()
      room.chat.push({ id: crypto.randomUUID(), playerId: member.id, name: member.name, text: message, ts: Date.now() })
      room.chat = room.chat.slice(-100)
    } else {
      if (room.hostId !== member.id) throw new HttpError(403, '只有房主可以管理牌桌')
      if (body.type === 'settings') {
        if (room.tournament) throw new HttpError(409, '锦标赛创建后不能修改房间设置')
        if (typeof body.actionSeconds !== 'number' || ![0, 20, 30, 40, 50, 60].includes(body.actionSeconds)) throw new HttpError(400, '行动时间需为不限时或 20、30、40、50、60 秒')
        if (typeof body.initialStack !== 'number' || !Number.isFinite(body.initialStack) || body.initialStack < 20 || body.initialStack > 1000 || !Number.isInteger(body.initialStack * 2)) throw new HttpError(400, '初始筹码需为 20–1000 BB，单位为 0.5 BB')
        room.actionSeconds = body.actionSeconds; room.initialStack = body.initialStack
      } else if (body.type === 'remove-seat') {
        if (body.capacity !== room.capacity) throw new HttpError(409, '座位布局已更新，请重试')
        const seat = this.validSeat(body.seat)
        if (room.pendingSeatRemovals.includes(seat)) return json({ room: this.view(member.id) })
        if (room.capacity - room.pendingSeatRemovals.length <= 2) throw new HttpError(409, '牌桌至少保留两个座位')
        if (room.members.some(p => !p.leaving && (p.seat === seat || p.pendingSeat === seat))) throw new HttpError(409, '只能移除未占用且未预约的空座')
        if (this.activeHand()) room.pendingSeatRemovals.push(seat)
        else this.removeEmptySeat(seat)
      } else if (body.type === 'add-seat') {
        if (room.capacity >= 9) throw new HttpError(400, '最多只能设置 9 个席位')
        room.capacity++; room.seatRequests = []
      } else if (body.type === 'add-bot') {
        const unavailable = (seat: number) => room.pendingSeatRemovals.includes(seat) || room.members.some(p => !p.leaving && ((!p.pendingRemoval && p.seat === seat) || p.pendingSeat === seat))
        const seat = body.seat === undefined ? Array.from({ length: room.capacity }, (_, i) => i).find(i => !unavailable(i)) : this.validSeat(body.seat)
        if (seat === undefined || unavailable(seat)) throw new HttpError(409, '没有可用座位')
        if (room.members.length >= 256) throw new HttpError(409, '本桌玩家记录已满，请创建新房间')
        this.addBotAtSeat(seat)
      } else if (body.type === 'fill-bots') {
        if (room.started) throw new HttpError(409, '只能在开始对战前补齐电脑')
        const emptySeats = Array.from({ length: room.capacity }, (_, seat) => seat)
          .filter(seat => !room.pendingSeatRemovals.includes(seat) && !room.members.some(p => !p.leaving && (p.seat === seat || p.pendingSeat === seat)))
        if (room.members.length + emptySeats.length > 256) throw new HttpError(409, '本桌玩家记录已满，请创建新房间')
        for (const seat of emptySeats) this.addBotAtSeat(seat)
      } else if (body.type === 'remove-bot') {
        const bot = room.members.find(p => p.id === body.playerId && p.bot && !p.leaving)
        if (!bot) throw new HttpError(400, '找不到这位电脑玩家')
        if (this.activeHand() && room.hand!.players.some(p => p.id === bot.id)) bot.pendingRemoval = true
        else this.removeBot(bot)
      } else if (body.type === 'start') {
        if (this.activeHand()) throw new HttpError(409, '本手正在进行')
        if (this.eligibleSeats().length < 2) throw new HttpError(400, '至少需要两位有筹码的入座玩家')
        if (room.started && this.eligibleSeats().every(p => p.entryStatus === 'waiting')) throw new HttpError(400, '至少一位玩家需选择支付 1 BB 入场')
        if (room.tournament) {
          const entrantIds = this.eligibleSeats().map(player => player.id)
          room.tournament.status = 'running'; room.tournament.startedAt = Date.now()
          room.tournament.entrantIds = entrantIds
          room.tournament.nextLevelAt = Date.now() + room.tournament.blindIntervalMinutes * 60_000
          room.tournament.registrationClosesAt = Date.now() + room.tournament.registrationRaises * room.tournament.blindIntervalMinutes * 60_000
          room.tournament.registrationOpen = room.tournament.registrationRaises > 0
        }
        room.started = true; this.deal()
      } else throw new HttpError(400, '未知房间指令')
    }
    room.revision++
    this.scheduleNext()
    await this.persist()
    return json({ room: this.view(member.id) })
  }

  private requireHand(number: unknown) {
    if (!this.activeHand() || this.room!.hand!.finished || this.room!.hand!.awaitingRunout || this.room!.runoutPlayback || number !== this.room!.handNumber) throw new HttpError(409, '当前没有可操作的对应牌局')
  }
  private validSeat(value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= this.room!.capacity) throw new HttpError(400, '座位无效')
    return value
  }
  private standMember(member: Member) {
    const room = this.room!
    member.sittingOut = true; member.seat = null; member.pendingSeat = null; member.awayUntil = null; member.timeoutCount = 0
    delete member.reservationEntryStatus
    if (room.hand?.toAct === member.id && !room.hand.finished) room.actionDeadline = Date.now()
    if (room.runoutVote?.eligibleIds.includes(member.id)) room.runoutVote.votes[member.id] = 1
  }
  private removeEmptySeat(seat: number) {
    const room = this.room!
    const shifted = (value: number | null) => value === null ? null : value > seat ? value - 1 : value === seat ? null : value
    for (const member of room.members) { member.seat = shifted(member.seat); member.pendingSeat = shifted(member.pendingSeat) }
    for (const [id, oldSeat] of Object.entries(room.handSeats)) {
      const next = shifted(oldSeat)
      if (next === null) delete room.handSeats[id]
      else room.handSeats[id] = next
    }
    // A removed former blind seat leaves its clockwise boundary at the
    // predecessor, so the next seat still receives the next big blind.
    if (room.lastDealerSeat >= seat) room.lastDealerSeat--
    if (room.lastBigBlindSeat >= seat) room.lastBigBlindSeat--
    room.pendingSeatRemovals = room.pendingSeatRemovals.filter(value => value !== seat).map(value => value > seat ? value - 1 : value)
    room.capacity--
  }
  private applyEmptySeatRemovals() {
    const room = this.room!
    for (const seat of [...room.pendingSeatRemovals].sort((a, b) => b - a)) this.removeEmptySeat(seat)
  }
  private addBotAtSeat(seat: number) {
    const room = this.room!
    const bot = { ...this.newMember(this.nextBotName(room.members), `BOT-${crypto.randomUUID()}`, room.initialStack), bot: true, token: '' }
    room.members.push(bot)
    if (room.tournament && room.started) this.registerEntrant(bot)
    if (this.activeHand()) bot.pendingSeat = seat
    else this.takeSeat(bot, seat)
  }
  private activeHand() { return !!this.room?.hand && (!this.room.hand.finished || !!this.room.settlement) }
  private registrationOpen(now = Date.now()): boolean {
    const tournament = this.room!.tournament
    return !!tournament && (tournament.status === 'waiting' || (tournament.status === 'running' && tournament.registrationOpen
      && tournament.registrationClosesAt !== null && now < tournament.registrationClosesAt))
  }
  private closeRegistration(now: number): boolean {
    const tournament = this.room!.tournament
    if (!tournament || tournament.status !== 'running' || !tournament.registrationOpen
      || tournament.registrationClosesAt === null || now < tournament.registrationClosesAt) return false
    tournament.registrationOpen = false
    this.updateTournament()
    return true
  }
  private registerEntrant(member: Member) {
    const room = this.room!, tournament = room.tournament!
    if (tournament.entrantIds.includes(member.id)) return
    // A seat request is the atomic registration, including a seat reserved for
    // the following hand. Its acceptance survives the deadline and restarts.
    tournament.entrantIds.push(member.id)
    for (const result of Object.values(tournament.eliminated)) result.place++
    member.entryStatus = 'ready'; member.eligibleFromHand = room.handNumber + 1
  }
  private removeBot(bot: Member) {
    bot.leaving = true; bot.seat = null; bot.pendingSeat = null; bot.sittingOut = true; bot.pendingRemoval = false
  }
  private applyPendingRemovals() {
    for (const bot of this.room!.members) if (bot.bot && bot.pendingRemoval) this.removeBot(bot)
  }
  private eligibleSeats() {
    const room = this.room!
    return room.members.filter(p => !p.leaving && !p.sittingOut && p.seat !== null && p.stack > 0
      && (!room.tournament || room.tournament.status === 'waiting' || (room.tournament.entrantIds.includes(p.id) && !room.tournament.eliminated[p.id])))
      .sort((a, b) => a.seat! - b.seat!)
  }
  private takeSeat(member: Member, seat: number, preservePresence = false) {
    const occupant = this.room!.members.find(p => p.id !== member.id && p.seat === seat && !p.leaving)
    if (occupant) { occupant.seat = null; occupant.pendingSeat = null; occupant.sittingOut = true; if (occupant.bot) this.removeBot(occupant) }
    member.seat = seat; member.pendingSeat = null; member.sittingOut = false
    if (!preservePresence) { member.awayUntil = null; member.timeoutCount = 0 }
    delete member.reservationEntryStatus
    this.room!.seatRequests = this.room!.seatRequests.filter(id => id !== member.id)
  }
  private applyReservations() {
    for (const member of this.room!.members) {
      if (member.leaving || member.pendingSeat === null) continue
      if (member.stack <= 0) { member.pendingSeat = null; member.sittingOut = true; continue }
      const seat = member.pendingSeat
      const other = this.room!.members.find(p => p.id !== member.id && p.seat === seat && !p.leaving)
      // A queued move is not a new return action: the player may have gone
      // away after reserving it, and settlement must preserve that choice.
      if (!other || other.bot) this.takeSeat(member, seat, true)
      else member.pendingSeat = null
    }
  }
  private deal() {
    const room = this.room!
    if (room.tournament && room.tournament.status !== 'running') { room.nextHandAt = null; return }
    this.applyPendingRemovals()
    this.applyReservations()
    const candidates = this.eligibleSeats()
    if (candidates.length < 2) { room.nextHandAt = null; return }
    if (room.tournament) {
      const tournament = room.tournament
      const elapsedLevels = Math.max(0, Math.floor((Date.now() - tournament.startedAt!) / (tournament.blindIntervalMinutes * 60_000)))
      tournament.level = Math.min(TOURNAMENT_BIG_BLINDS.length, elapsedLevels + 1)
      tournament.bigBlind = TOURNAMENT_BIG_BLINDS[tournament.level - 1]
      tournament.smallBlind = tournament.bigBlind / 2
      tournament.nextLevelAt = tournament.level < TOURNAMENT_BIG_BLINDS.length
        ? tournament.startedAt! + tournament.level * tournament.blindIntervalMinutes * 60_000 : null
    }
    let nextBB = room.handNumber === 0 ? candidates[candidates.length === 2 ? 1 : 2]
      : candidates.find(p => p.seat! > room.lastBigBlindSeat) ?? candidates[0]
    let members = candidates.filter(p => p.entryStatus !== 'waiting' || p.id === nextBB.id)
    // When a table shrinks to one established player, form heads-up with the
    // next waiting entrant in the big blind instead of stalling the rotation.
    if (members.length < 2 && candidates.some(p => p.entryStatus !== 'waiting')) {
      const waiting = candidates.filter(p => p.entryStatus === 'waiting')
      nextBB = waiting.find(p => p.seat! > room.lastBigBlindSeat) ?? waiting[0]
      members = candidates.filter(p => p.entryStatus !== 'waiting' || p.id === nextBB.id)
    }
    if (members.length < 2) { room.nextHandAt = null; return }
    const bbIndex = members.findIndex(p => p.id === nextBB.id)
    const dealer = (bbIndex - (members.length === 2 ? 1 : 2) + members.length) % members.length
    const number = room.handNumber + 1
    room.hand = startHand(members.map(p => p.id), dealer, number, {
      stacks: Object.fromEntries(members.map(p => [p.id, p.stack])), deferRunout: true,
      bigBlind: room.tournament?.bigBlind ?? 1, smallBlind: room.tournament?.smallBlind ?? 0.5,
      postedBlinds: members.filter(p => p.entryStatus === 'post').map(p => p.id),
    })
    // Capture once per deal so room settings never change an ongoing hand's
    // later turns, even after a worker restart or an away cancellation.
    room.handActionSeconds = room.actionSeconds
    members.forEach(p => { p.entryStatus = 'ready' })
    room.handNumber = number; room.lastDealerSeat = members[dealer].seat!
    room.lastBigBlindSeat = nextBB.seat!
    room.handSeats = Object.fromEntries(members.map(p => [p.id, p.seat!]))
    room.nextHandAt = null; room.revealed = {}; room.runoutVote = null; room.runoutPlayback = null; room.settlement = null; room.actionRevision++
    this.afterAction()
  }
  private afterAction(paid = false) {
    const room = this.room!, hand = room.hand!
    if (hand.finished) {
      room.actionDeadline = null; room.runoutVote = null
      if (room.scoredHand !== hand.number) {
        if (!paid) {
          if (!room.settlement) {
            room.settlement = { resolved: structuredClone(hand), dueAt: Date.now() + SETTLEMENT_MS }
            // Expose the decided hand and optional reveals before paying its pot.
            // totalBet already excludes any uncalled refund from the engine.
            for (const player of hand.players) player.stack = player.startingStack - player.totalBet
            hand.delta = null; hand.runResults = []
            room.nextHandAt = null
          }
          return
        }
        const completed = handView(hand, '')
        for (const player of hand.players) {
          const member = room.members.find(p => p.id === player.id)!
          member.stack = player.stack
          member.stats = addStats(member.stats, handStats(completed, member.id))
          member.score = member.stats.netBB
          if (member.stack <= 0) {
            member.bustHand = hand.number; member.bustStartingStack = player.startingStack
            if ((!room.tournament || this.registrationOpen()) && member.bot && !member.leaving && !member.pendingRemoval) {
              member.stack = room.initialStack; member.buyIns++; member.bustHand = null; member.bustStartingStack = 0
            } else member.sittingOut = true
          }
        }
        room.scoredHand = hand.number
        room.handHistory.unshift({ number: hand.number, finishedAt: Date.now(), bigBlind: hand.bigBlind ?? 1, smallBlind: hand.smallBlind ?? 0.5, board: [...hand.board], boards: hand.boards.map(board => [...board]),
          history: hand.history.map(action => ({ ...action })), players: hand.players.map(player => {
            const member = room.members.find(p => p.id === player.id)!
            return { id: member.id, name: member.name, bot: member.bot, position: handPosition(completed, player.id) }
          }), privateCards: Object.fromEntries(hand.players.flatMap(player => {
            const member = room.members.find(p => p.id === player.id)!
            return !member.bot && member.token && member.eligibleFromHand <= hand.number
              ? [[player.id, { token: member.token, cards: [...player.cards] as [number, number] }]] : []
          })), delta: { ...hand.delta! }, showdown: hand.showdown, runResults: structuredClone(hand.runResults ?? []) })
        room.handHistory = room.handHistory.slice(0, 50)
        this.updateTournament()
        this.applyPendingRemovals()
        this.applyReservations()
        this.applyEmptySeatRemovals()
        room.nextHandAt = room.started && (!room.tournament || (room.tournament.status === 'running' && this.eligibleSeats().length >= 2)) ? Date.now() + resultDelay(hand) : null
      }
      return
    }
    if (hand.awaitingRunout) {
      room.actionDeadline = null
      if (!room.runoutVote) {
        const eligible = hand.players.filter(p => !p.folded).map(p => room.members.find(m => m.id === p.id)!).filter(p => !p.bot)
        room.runoutVote = { handNumber: hand.number, eligibleIds: eligible.map(p => p.id), votes: {}, deadline: Date.now() + 15_000 }
        for (const p of eligible) if (p.leaving || p.sittingOut || p.awayUntil !== null || p.eligibleFromHand > hand.number || Date.now() - p.seen > HOST_GRACE_MS) room.runoutVote.votes[p.id] = 1
      }
      this.finishVoting(false)
      return
    }
    const next = room.members.find(p => p.id === hand.toAct)!
    // Unlimited human decisions still allow bots and explicitly vacated seats
    // to progress. Runout voting and between-hand timers are independent.
    const actionSeconds = room.handActionSeconds ?? room.actionSeconds
    const delay = next.leaving || next.sittingOut || next.awayUntil !== null || next.eligibleFromHand > hand.number ? 50 : next.bot ? BOT_MS : actionSeconds === 0 ? null : actionSeconds * 1000
    room.actionDeadline = delay === null ? null : Date.now() + delay
  }
  private updateTournament() {
    const room = this.room!, tournament = room.tournament
    if (!tournament || tournament.status !== 'running') return
    const handActive = this.activeHand()
    const open = this.registrationOpen()
    if (handActive && open) return
    let remaining = tournament.entrantIds.filter(id => !tournament.eliminated[id])
    // Simultaneous eliminations rank larger starting stacks ahead. Equal stacks
    // share the same finishing place, independent of dealing order or seat.
    if (!open && remaining.length) {
      const busted = remaining.filter(id => room.members.find(member => member.id === id)!.stack <= 0)
        .sort((a, b) => {
          const pa = room.members.find(member => member.id === a)!, pb = room.members.find(member => member.id === b)!
          return (pa.bustHand ?? 0) - (pb.bustHand ?? 0) || pa.bustStartingStack - pb.bustStartingStack
        })
      while (busted.length) {
        const first = room.members.find(member => member.id === busted[0])!
        const group = busted.filter(id => {
          const member = room.members.find(member => member.id === id)!
          return member.bustHand === first.bustHand && member.bustStartingStack === first.bustStartingStack
        })
        const place = remaining.length - group.length + 1
        for (const id of group) {
          tournament.eliminated[id] = { place, forfeited: false, handNumber: room.members.find(p => p.id === id)!.bustHand ?? room.handNumber, exitAt: Date.now() + (room.hand ? resultDelay(room.hand) : RESUME_MS) }
          busted.splice(busted.indexOf(id), 1)
        }
        remaining = remaining.filter(id => !tournament.eliminated[id])
      }
    }
    // At cutoff, an entrant already waiting at zero from an earlier hand is
    // eliminated immediately. Unsettled current-hand chips and withdrawals
    // still wait for that hand's result; no champion is chosen mid-hand.
    if (handActive) return
    // A departure stops participation in future hands. Resolve every existing
    // all-in first: the last funded player wins that hand and the tournament,
    // even if they left while its cards were still being exposed.
    if (open || remaining.length > 1) {
      for (const id of tournament.pendingWithdrawals) {
        if (!remaining.includes(id)) continue
        tournament.eliminated[id] = { place: remaining.length, forfeited: true, handNumber: room.handNumber, exitAt: Date.now() + (room.hand ? resultDelay(room.hand) : RESUME_MS) }
        remaining = remaining.filter(playerId => playerId !== id)
      }
    }
    tournament.pendingWithdrawals = []
    if (!open && remaining.length <= 1) {
      tournament.status = 'finished'; tournament.winnerId = remaining[0] ?? null
      tournament.nextLevelAt = null; tournament.registrationOpen = false; room.nextHandAt = null
    }
  }
  private tournamentView(): TournamentView | null {
    const room = this.room!, tournament = room.tournament
    if (!tournament) return null
    const { eliminated, pendingWithdrawals: _pendingWithdrawals, ...metadata } = tournament
    const chipCount = (id: string) => this.activeHand() ? room.hand!.players.find(player => player.id === id)?.stack ?? room.members.find(member => member.id === id)!.stack : room.members.find(member => member.id === id)!.stack
    const active = tournament.entrantIds.filter(id => !eliminated[id]).sort((a, b) => chipCount(b) - chipCount(a))
    return { ...metadata, registrationOpen: this.registrationOpen(), entrantIds: [...metadata.entrantIds], rankings: tournament.entrantIds.map(playerId => ({
      playerId, place: eliminated[playerId]?.place ?? (tournament.winnerId === playerId ? 1 : active.indexOf(playerId) + 1),
      chips: chipCount(playerId), eliminated: !!eliminated[playerId], forfeited: eliminated[playerId]?.forfeited ?? false,
    })).sort((a, b) => a.place - b.place) }
  }
  private finishVoting(timedOut: boolean) {
    const room = this.room!, vote = room.runoutVote
    if (!vote || !room.hand?.awaitingRunout) return
    if (!timedOut && vote.eligibleIds.some(id => !vote.votes[id])) return
    const count = vote.eligibleIds.length ? Math.min(...vote.eligibleIds.map(id => vote.votes[id] ?? 1)) as 1 | 2 | 3 : 1
    // Return the unmatched top contribution before the first run is exposed.
    // This depends only on committed chips, never future boards or winners.
    // Resolving the normalized clone below then cannot refund these chips twice.
    const contributions = [...room.hand.players].sort((a, b) => b.totalBet - a.totalBet)
    const refund = contributions[0].totalBet - contributions[1].totalBet
    if (refund > 0) {
      const player = contributions[0]
      player.totalBet -= refund
      player.streetBet = Math.max(0, player.streetBet - refund)
      player.stack += refund
      room.hand.history.push({ playerId: player.id, street: room.hand.street, kind: 'refund', amount: refund })
    }
    const resolved = structuredClone(room.hand)
    resolveRunouts(resolved, count)
    room.runoutPlayback = { resolved, prefixLength: room.hand.board.length, boardIndex: 0,
      revealedCount: room.hand.board.length, phase: 'dealing', completedResults: [], nextRevealAt: Date.now() + RUNOUT_CARD_MS }
    room.hand.awaitingRunout = false; room.hand.runCount = count; room.hand.toAct = null; room.hand.showdown = true
    room.hand.runResults = []; room.actionDeadline = null; room.nextHandAt = null
    room.actionRevision++; room.revision++; room.runoutVote = null
  }
  private completePlayback() {
    const room = this.room!
    if (!room.runoutPlayback) return
    room.hand = room.runoutPlayback.resolved
    room.runoutPlayback = null
    room.actionRevision++
    // Every completed run already received its two-second pause before results.
    this.afterAction(true)
  }
  private completeSettlement() {
    const room = this.room!
    if (!room.settlement) return
    room.hand = room.settlement.resolved
    room.settlement = null
    room.actionRevision++
    this.afterAction(true)
  }
  private advancePlayback(now: number) {
    const room = this.room!, playback = room.runoutPlayback!, hand = room.hand!
    // Advance once per alarm/poll, never catch up by exposing several cards at
    // once after a sleepy worker resumes. All clients see the same public step.
    if (playback.phase === 'settling') {
      playback.phase = 'result'
      playback.completedResults.push(structuredClone(playback.resolved.runResults![playback.boardIndex]))
      hand.runResults = structuredClone(playback.completedResults)
      playback.nextRevealAt = now + RUNOUT_RESULT_MS
      return
    }
    if (playback.phase === 'result') {
      if (playback.boardIndex + 1 === playback.resolved.runCount) { this.completePlayback(); return }
      playback.boardIndex++
      playback.revealedCount = playback.prefixLength
      playback.phase = 'dealing'
      hand.board = playback.resolved.boards[playback.boardIndex].slice(0, playback.prefixLength)
      hand.boards = [...playback.completedResults.map(result => [...result.board]), [...hand.board]]
      hand.street = hand.board.length === 0 ? 'preflop' : hand.board.length <= 3 ? 'flop' : 'turn'
      playback.nextRevealAt = now + RUNOUT_CARD_MS
      return
    }
    playback.revealedCount++
    hand.board = playback.resolved.boards[playback.boardIndex].slice(0, playback.revealedCount)
    hand.boards = [...playback.completedResults.map(result => [...result.board]), [...hand.board]]
    hand.street = hand.board.length <= 3 ? 'flop' : hand.board.length === 4 ? 'turn' : 'river'
    if (playback.revealedCount === 5) {
      playback.phase = 'settling'
      playback.nextRevealAt = now + SETTLEMENT_MS
    } else playback.nextRevealAt = now + RUNOUT_CARD_MS
  }
  private automaticAction(actor: Member, naturalTimeout = false) {
    const room = this.room!, hand = room.hand!, legal = legalActions(hand, actor.id)!
    if (naturalTimeout && !actor.bot && !actor.leaving && !actor.sittingOut && actor.awayUntil === null && actor.eligibleFromHand <= hand.number) {
      actor.timeoutCount++
      if (actor.timeoutCount >= 2) actor.awayUntil = Date.now() + AWAY_MS
    }
    const action = actor.bot && !actor.leaving && !actor.sittingOut ? chooseBotAction(hand) : { kind: actor.awayUntil !== null || actor.awayFoldHand === hand.number ? 'fold' : legal.canCheck ? 'check' : 'fold' } as BattleAction
    act(hand, actor.id, action)
    room.actionRevision++; room.revision++; this.afterAction()
  }
  private canFastForward(): boolean {
    const room = this.room!, hand = room.hand
    return !!hand && !hand.finished && !hand.awaitingRunout && !room.runoutPlayback && hand.players.filter(p => !p.folded).every(p => {
      const member = room.members.find(m => m.id === p.id)!
      return member.bot || member.leaving || member.sittingOut || member.awayUntil !== null || member.eligibleFromHand > room.handNumber || p.stack === 0
    })
  }
  private grantCards(member: Member, now: number): boolean {
    if (member.bot || member.leaving) return false
    const hours = Math.floor((now - member.cardGrantAt) / HOUR_MS)
    if (hours <= 0) return false
    member.timeCards += hours; member.cardGrantAt += hours * HOUR_MS
    return true
  }
  private tick(now: number): boolean {
    const room = this.room!
    let changed = this.closeRegistration(now)
    if (room.tournament?.status === 'running' && !this.registrationOpen(now)) {
      const before = `${room.tournament.status}:${Object.keys(room.tournament.eliminated).length}:${room.tournament.pendingWithdrawals.length}`
      this.updateTournament()
      if (`${room.tournament.status}:${Object.keys(room.tournament.eliminated).length}:${room.tournament.pendingWithdrawals.length}` !== before) changed = true
    }
    for (const member of room.members) if (this.grantCards(member, now)) changed = true
    if (!room.tournament) for (const member of room.members) if (!member.leaving && member.awayUntil !== null && member.awayUntil <= now) {
      if (this.activeHand()) member.awayFoldHand = room.handNumber
      this.standMember(member); changed = true
    }
    if (room.settlement && room.settlement.dueAt <= now) { this.completeSettlement(); changed = true }
    else if (room.runoutPlayback && room.runoutPlayback.nextRevealAt <= now) { this.advancePlayback(now); changed = true }
    else if (room.runoutVote && room.runoutVote.deadline <= now) { this.finishVoting(true); changed = true }
    else if (this.activeHand() && room.actionDeadline !== null && room.actionDeadline <= now) {
      const actor = room.members.find(p => p.id === room.hand!.toAct)!
      this.automaticAction(actor, true); changed = true
    }
    if (!this.activeHand() && room.nextHandAt !== null && room.nextHandAt <= now) {
      if (room.members.some(p => !p.bot && !p.leaving && now - p.seen <= HOST_GRACE_MS)) this.deal()
      else room.nextHandAt = null
      changed = true
    }
    if (changed) room.revision++
    return changed
  }
  private scheduleNext(): boolean {
    const room = this.room!
    if (room.started && (!room.tournament || room.tournament.status === 'running') && !this.activeHand() && room.nextHandAt === null && this.eligibleSeats().length >= 2
      && this.eligibleSeats().some(p => p.entryStatus !== 'waiting')
      && room.members.some(p => !p.bot && !p.leaving && Date.now() - p.seen <= HOST_GRACE_MS)) {
      room.nextHandAt = Date.now() + RESUME_MS
      room.revision++
      return true
    }
    return false
  }
  private transferAbsentHost(now: number): boolean {
    const room = this.room!, host = room.members.find(p => p.id === room.hostId)
    if (host && !host.leaving && now - host.seen <= HOST_GRACE_MS) return false
    const successor = room.members.find(p => !p.bot && !p.leaving && now - p.seen < ONLINE_MS)
    if (!successor || successor.id === room.hostId) return false
    room.hostId = successor.id; room.revision++; return true
  }
  private parseAction(value: unknown): BattleAction {
    if (!value || typeof value !== 'object') throw new HttpError(400, '行动格式错误')
    const action = value as Record<string, unknown>
    if (action.kind === 'check' || action.kind === 'call' || action.kind === 'fold') return { kind: action.kind }
    if (action.kind === 'raise' && typeof action.to === 'number' && Number.isFinite(action.to)) return { kind: 'raise', to: action.to }
    throw new HttpError(400, '行动格式错误')
  }
  private joined(member: Member) { return json({ session: { code: this.room!.code, playerId: member.id, token: member.token }, room: this.view(member.id) }) }
  private view(selfId: string): RoomView {
    const room = this.room!, self = room.members.find(p => p.id === selfId)!
    const view = room.hand ? handView(room.hand, self.eligibleFromHand <= room.handNumber ? selfId : '', room.revealed, room.members.filter(p => p.bot).map(p => p.id)) : null
    // Folded/standing participants of this hand remain opponents until it ends.
    const isSpectator = !room.hand || !room.hand.players.some(p => p.id === selfId) || self.eligibleFromHand > room.handNumber
    // Non-folded hands are tabled once betting has ended. Folded cards retain
    // their owner-only visibility throughout the sequential board reveal.
    if (view && room.runoutPlayback) for (const player of view.players) {
      if (!player.folded) player.cards = [...room.hand!.players.find(p => p.id === player.id)!.cards]
      else if (room.revealed[player.id]?.length && player.id !== selfId) player.cards = room.hand!.players.find(p => p.id === player.id)!.cards.map((card, index) => room.revealed[player.id].includes(index) ? card : null) as [number | null, number | null]
    }
    if (view && !view.finished && isSpectator && !room.tournament) for (const p of view.players) {
      const member = room.members.find(m => m.id === p.id)!
      if (member.shareWithSpectators && !member.bot) p.cards = [...room.hand!.players.find(hp => hp.id === p.id)!.cards]
    }
    if (view) { view.players.forEach(p => { p.seat = room.handSeats[p.id] }); if (self.sittingOut || self.awayUntil !== null) view.legal = null }
    return { code: room.code, instanceId: room.instanceId, revision: room.revision, actionRevision: room.actionRevision, hostId: room.hostId, selfId, capacity: room.capacity, initialStack: room.initialStack,
      mode: room.mode, actionSeconds: room.actionSeconds, handActionSeconds: room.handActionSeconds, tournament: this.tournamentView(),
      settlementAt: room.settlement?.dueAt ?? (room.runoutPlayback?.phase === 'settling' ? room.runoutPlayback.nextRevealAt : null),
      players: room.members.map(p => ({ id: p.id, name: p.name, bot: p.bot, score: p.score, connected: !p.leaving && (p.bot || Date.now() - p.seen < ONLINE_MS), leaving: p.leaving,
        buyIns: p.buyIns,
        netChips: room.tournament ? (room.tournament.entrantIds.includes(p.id) ? p.stack - room.initialStack * p.buyIns : 0) : p.stats.netBB,
        tournamentStatus: !room.tournament ? undefined : !room.tournament.entrantIds.includes(p.id) ? 'spectator' : room.tournament.winnerId === p.id ? 'winner'
          : room.tournament.eliminated[p.id]?.forfeited ? 'forfeited' : room.tournament.eliminated[p.id] ? 'eliminated' : p.stack <= 0 && p.sittingOut && this.registrationOpen() ? 'rebuy' : 'active',
        tournamentPlace: room.tournament?.winnerId === p.id ? 1 : room.tournament?.eliminated[p.id]?.place ?? null,
        seat: p.seat, pendingSeat: p.pendingSeat, stack: this.activeHand() ? room.hand!.players.find(hp => hp.id === p.id)?.stack ?? p.stack : p.stack,
        sittingOut: p.sittingOut, timeCards: p.timeCards, stats: { ...p.stats }, shareWithSpectators: p.shareWithSpectators, entryStatus: p.entryStatus, pendingRemoval: p.pendingRemoval, awayUntil: p.awayUntil, timeoutCount: p.timeoutCount })),
      hand: view, actionDeadline: room.actionDeadline, nextHandAt: room.nextHandAt, started: room.started, runoutVote: room.runoutVote,
      seats: Array.from({ length: room.capacity }, (_, i) => room.members.find(p => !p.leaving && p.seat === i)?.id ?? null),
      reservations: Array.from({ length: room.capacity }, (_, i) => room.members.find(p => !p.leaving && p.pendingSeat === i)?.id ?? null),
      canFastForward: this.canFastForward(), nextTimeCardAt: self.cardGrantAt + HOUR_MS, chat: room.chat, revealed: room.revealed, isSpectator, seatRequests: room.seatRequests, pendingSeatRemovals: [...room.pendingSeatRemovals],
      handHistory: room.handHistory.map(({ privateCards, ...history }) => {
        const own = privateCards?.[selfId]
        return { ...structuredClone(history), ...(own?.token === self.token ? { myCards: [...own.cards] as [number, number] } : {}) }
      }), runoutPlayback: room.runoutPlayback ? {
        boardIndex: room.runoutPlayback.boardIndex, revealedCount: room.runoutPlayback.revealedCount, phase: room.runoutPlayback.phase,
        completedResults: structuredClone(room.runoutPlayback.completedResults), nextRevealAt: room.runoutPlayback.nextRevealAt,
      } : null }
  }
  private finalTournamentView(selfId: string, handNumber: number): RoomView {
    const view = this.view(selfId)
    return { ...view, hand: null, handActionSeconds: null, players: view.players.filter(p => p.id === selfId), hostId: selfId,
      seats: [], reservations: [], pendingSeatRemovals: [], seatRequests: [], chat: [], revealed: {},
      actionDeadline: null, nextHandAt: null, settlementAt: null, runoutVote: null, runoutPlayback: null, canFastForward: false,
      handHistory: view.handHistory?.filter(hand => hand.number <= handNumber),
      tournament: view.tournament ? { ...view.tournament, entrantIds: [selfId], rankings: view.tournament.rankings.filter(rank => rank.playerId === selfId), winnerId: view.tournament.winnerId === selfId ? selfId : null } : null }
  }
  private async persist() {
    const room = this.room!
    await this.ctx.storage.put('room', room)
    this.savedPresenceAt = Date.now()
    await this.ctx.storage.setAlarm(Math.min(room.actionDeadline ?? Infinity, room.nextHandAt ?? Infinity, room.settlement?.dueAt ?? Infinity, room.runoutVote?.deadline ?? Infinity, room.runoutPlayback?.nextRevealAt ?? Infinity,
      room.tournament?.registrationOpen ? room.tournament.registrationClosesAt ?? Infinity : Infinity, room.lastActivity + EXPIRY_MS,
      ...(!room.tournament ? room.members.filter(p => !p.leaving && p.awayUntil !== null).map(p => p.awayUntil!) : []),
      ...Object.values(this.receipts).map(r => r.expiresAt)))
  }
  private async expire() {
    if (this.room && Date.now() - this.room.lastActivity >= EXPIRY_MS) await this.destroy()
    const expired = Object.keys(this.receipts).filter(token => this.receipts[token].expiresAt <= Date.now())
    if (expired.length) {
      for (const token of expired) delete this.receipts[token]
      if (!this.room && !Object.keys(this.receipts).length) { await this.ctx.storage.deleteAll(); await this.ctx.storage.deleteAlarm() }
      else await this.ctx.storage.put('receipts', this.receipts)
    }
  }
  private async destroy(receipts: typeof this.receipts = {}) {
    this.room = null; this.receipts = receipts
    await this.ctx.storage.deleteAlarm(); await this.ctx.storage.deleteAll()
    if (Object.keys(receipts).length) {
      await this.ctx.storage.put('receipts', receipts)
      await this.ctx.storage.setAlarm(Math.min(...Object.values(receipts).map(r => r.expiresAt)))
    }
  }
}
