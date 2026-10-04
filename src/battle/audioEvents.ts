import type { PokerTableEventView } from '../poker/tableEvents'
import type { BattleSound } from './audio'
import type { RoomView } from './types'

interface SoundSnapshot {
  instance: string; self: string; hand: number | null; history: number; finished: boolean; allin: Set<string>; actor: string | null
  boardIndex: number | null; boardCount: number; completedRuns: number
}

function snapshot(room: PokerTableEventView): SoundSnapshot {
  return {
    instance: room.instanceId, self: room.selfId, hand: room.hand?.number ?? null, history: room.hand?.history.length ?? 0,
    finished: !!room.hand?.finished && room.settlementAt == null, allin: new Set(room.hand?.players.filter(player => player.allin).map(player => player.id)),
    actor: room.hand?.toAct ?? null,
    boardIndex: room.runoutPlayback?.boardIndex ?? null,
    boardCount: room.hand?.board.length ?? 0,
    completedRuns: room.runoutPlayback?.completedResults.length ?? room.hand?.runResults?.length ?? 0,
  }
}

export interface BattleAudioEvent { sound: BattleSound | null; allinIds: string[]; key: string }

/** This tracker survives in-app navigation. UI visibility is not an audio boundary. */
export class BattleAudioTracker {
  private previous: SoundSnapshot | null = null
  private skipNext = false

  resetContinuity(): void { this.skipNext = true }

  observe(room: PokerTableEventView | null, documentVisible = true): BattleAudioEvent | null {
    if (!room) { this.previous = null; this.skipNext = false; return null }
    const next = snapshot(room), old = this.previous
    this.previous = next
    const skip = this.skipNext
    this.skipNext = !documentVisible
    if (!documentVisible || skip || !old || old.instance !== next.instance || old.self !== next.self || !room.hand) return null
    const hand = room.hand
    const newHand = old.hand !== next.hand
    const newlyAllin = hand.players.filter(player => player.allin && (newHand || !old.allin.has(player.id)))
    const completedRuns = room.runoutPlayback?.completedResults ?? []
    const newlyCompletedRun = !newHand && next.completedRuns > old.completedRuns
      ? completedRuns[completedRuns.length - 1] : undefined
    // Moving to another run's shared prefix is not another deal.
    const newlyDealtCard = !newHand && !hand.finished && next.boardCount > old.boardCount
      && (next.boardIndex === old.boardIndex || old.boardIndex === null && next.boardIndex === 0)
    const newlyFinished = next.finished && (!old.finished || newHand)
    const alreadyHeardLastRun = !newHand && old.completedRuns > 0 && next.completedRuns === old.completedRuns
    const settlementSound: BattleSound | null = newlyFinished && !alreadyHeardLastRun
      ? (hand.delta?.[room.selfId] ?? 0) > 0 ? 'win' : 'result' : null
    let sound: BattleSound | null = null
    if (newlyAllin.length) sound = 'allin'
    else if (newlyCompletedRun) sound = (newlyCompletedRun.payouts[room.selfId] ?? 0) > 0 ? 'win' : 'result'
    else if (newlyFinished) sound = settlementSound
    else if (next.actor === room.selfId && (newHand || old.actor !== room.selfId)) sound = 'turn'
    else if (newHand || newlyDealtCard) sound = 'deal'
    else if (next.history > old.history) {
      const actions = hand.history.slice(old.history).filter(action => ['fold', 'check', 'call', 'raise', 'bet'].includes(action.kind))
      const action = actions[actions.length - 1]
      if (action) sound = action.kind === 'bet' ? 'raise' : action.kind as BattleSound
    }
    // Fast-forward may include an all-in and settlement together. Only one sound
    // is emitted, and the final playback transition never repeats a result cue.
    if (settlementSound) sound = settlementSound
    if (!sound && newlyAllin.length === 0) return null
    return { sound, allinIds: newlyAllin.map(player => player.id), key: `${room.instanceId}-${hand.number}-${hand.history.length}` }
  }
}

export interface BattleTurnState { deadline: number | null }

/** An actionable unlimited turn has a null deadline, distinct from no turn. */
export function battleTurnState(room: RoomView | null): BattleTurnState | null {
  return room?.hand && !room.isSpectator && !room.hand.finished && room.hand.legal !== null
    && room.hand.toAct === room.selfId ? { deadline: room.actionDeadline } : null
}
