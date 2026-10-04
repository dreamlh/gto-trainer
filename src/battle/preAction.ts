import type { RoomCommand, RoomView } from './types'

export type BattlePreAction = 'fold' | 'check'
export type BattlePreActionCommand = Extract<RoomCommand, { type: 'action' }>
export interface BattlePreActionSelection {
  action: BattlePreAction
  instanceId: string
  handNumber: number
  playerId: string
}

/** A pre-action belongs to a player still able to make a live betting decision. */
export function preActionAvailability(room: RoomView): { active: boolean; myTurn: boolean; canSelect: boolean; canFold: boolean; canCheck: boolean } {
  const hand = room.hand
  const member = room.players.find(player => player.id === room.selfId)
  const player = hand?.players.find(entry => entry.id === room.selfId)
  // A matched bet alone does not tell us whether this street's decision is done.
  // Older snapshots without the public queue must not invent a future turn.
  const hasDecision = hand?.toAct === room.selfId || hand?.pendingPlayerIds?.includes(room.selfId) === true
  const active = !!hand && !hand.finished && !hand.awaitingRunout && hand.toAct !== null
    && !room.runoutVote && !room.runoutPlayback && room.settlementAt == null
    && !room.isSpectator && !!member && !member.bot && !member.leaving && !member.sittingOut && member.awayUntil == null
    && member.seat !== null && !!player && !player.folded && !player.allin && player.stack > 0 && hasDecision
  const myTurn = active && hand!.toAct === room.selfId
  const highestBet = hand?.players.reduce((maximum, entry) => Math.max(maximum, entry.streetBet), 0) ?? 0
  const canFold = active && (!myTurn || hand!.legal?.canFold !== false)
  const canCheck = active && player!.streetBet >= highestBet && (!myTurn || hand!.legal?.canCheck !== false)
  return { active, myTurn, canSelect: active && !myTurn, canFold, canCheck }
}

export function currentPreAction(selection: BattlePreActionSelection | null, room: RoomView): BattlePreActionSelection | null {
  if (!selection || selection.instanceId !== room.instanceId || selection.handNumber !== room.hand?.number
    || selection.playerId !== room.selfId) return null
  const available = preActionAvailability(room)
  return (selection.action === 'check' ? available.canCheck : available.canFold) ? selection : null
}

export function togglePreAction(selection: BattlePreActionSelection | null, room: RoomView, action: BattlePreAction): BattlePreActionSelection | null {
  const current = currentPreAction(selection, room)
  const available = preActionAvailability(room)
  if (!available.canSelect || !(action === 'check' ? available.canCheck : available.canFold)) return current
  return current?.action === action ? null : {
    action, instanceId: room.instanceId, handNumber: room.hand!.number, playerId: room.selfId,
  }
}

/** Consume only the next legal decision. A check never turns into a call or fold. */
export function consumePreAction(selection: BattlePreActionSelection | null, room: RoomView, busy: boolean): {
  selection: BattlePreActionSelection | null
  command: BattlePreActionCommand | null
} {
  const current = currentPreAction(selection, room)
  if (!current) return { selection: null, command: null }
  const { myTurn } = preActionAvailability(room)
  const legal = room.hand!.legal
  if (!myTurn || !legal) return { selection: current, command: null }
  if (current.action === 'check' ? !legal.canCheck : !legal.canFold) return { selection: null, command: null }
  if (busy) return { selection: current, command: null }
  return {
    selection: null,
    command: { type: 'action', action: { kind: current.action }, handNumber: room.hand!.number, revision: room.actionRevision },
  }
}

/** The consumed state is committed before the caller can submit an async command. */
export class BattlePreActionController {
  private value: BattlePreActionSelection | null = null

  get selection(): BattlePreActionSelection | null { return this.value }

  toggle(room: RoomView, action: BattlePreAction): void {
    this.value = togglePreAction(this.value, room, action)
  }

  cancel(): void { this.value = null }

  take(room: RoomView, busy: boolean): BattlePreActionCommand | null {
    const next = consumePreAction(this.value, room, busy)
    this.value = next.selection
    return next.command
  }
}
