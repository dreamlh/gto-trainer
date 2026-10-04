import type { RoomCommand, RoomView } from './types'

/** Mirrors room eligibility; an ended hand may still be waiting for its payout. */
export function canRebuy(room: RoomView, now = Date.now()): boolean {
  const self = room.players.find(player => player.id === room.selfId)
  if (!self || self.bot || self.leaving || self.stack > 0) return false
  if (room.mode === 'tournament') {
    const tournament = room.tournament
    if (!tournament || tournament.status === 'finished' || !tournament.registrationOpen || self.tournamentStatus !== 'rebuy') return false
    if (tournament.registrationClosesAt !== null && now >= tournament.registrationClosesAt) return false
  }
  const hand = room.hand
  const awaitingPayout = !!hand && (!hand.finished || hand.delta === null || room.settlementAt != null)
  return !awaitingPayout || !hand!.players.some(player => player.id === self.id)
}

export function canPostBlind(room: RoomView): boolean {
  const self = room.players.find(player => player.id === room.selfId)
  return room.mode !== 'tournament' && !!self && !self.bot && !self.leaving && self.stack > 0
    && self.entryStatus === 'waiting' && (self.seat !== null || self.pendingSeat !== null)
}

/** Settlement/runout deadlines do not end the right to show the current hand. */
export function showCardsDeadline(room: RoomView): number | null {
  return room.nextHandAt
}

export function canShowCards(room: RoomView, now = Date.now()): boolean {
  const hand = room.hand
  const endOfRun = room.runoutPlayback?.phase === 'settling' || room.runoutPlayback?.phase === 'result'
  if (!hand || (!hand.finished && !endOfRun) || room.isSpectator) return false
  const self = hand.players.find(player => player.id === room.selfId)
  if (!self?.cards?.some(card => card !== null)) return false
  // Active showdown/runout cards are already tabled automatically.
  if (!self.folded && (hand.showdown || room.runoutPlayback)) return false
  if ([0, 1].every(index => room.revealed[room.selfId]?.includes(index))) return false
  const deadline = showCardsDeadline(room)
  return deadline === null || now < deadline
}

/** Recheck at click time so a stale DOM callback cannot reveal a newer hand. */
export function showCardsCommand(
  room: RoomView, instanceId: string, handNumber: number, cards: readonly number[], now = Date.now(),
): Extract<RoomCommand, { type: 'show' }> | null {
  if (room.instanceId !== instanceId || room.hand?.number !== handNumber || !canShowCards(room, now)) return null
  if (!cards.length || cards.some(index => index !== 0 && index !== 1)) return null
  const shown = room.revealed[room.selfId] ?? []
  const requested = [...new Set(cards)].filter(index => !shown.includes(index))
  return requested.length ? { type: 'show', cards: requested, handNumber } : null
}
