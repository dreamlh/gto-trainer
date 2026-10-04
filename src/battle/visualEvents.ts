import type { PokerTableEventView } from '../poker/tableEvents'
import type { RunoutResult } from './types'

export interface BattleVisualAction { playerId: string; key: string; kind: string }
export interface BattleVisualAward { key: string; winnerIds: string[] }
export interface BattleVisualEvent {
  key: string; handKey: string; deal: boolean; boardKeys: string[]
  potChanged: boolean; holeKeys: string[]
  actions: BattleVisualAction[]; award: BattleVisualAward | null
}

interface VisualSnapshot {
  instance: string; self: string; hand: number | null; history: number; finished: boolean
  pot: number | null; holeCards: Record<string, (number | null)[]>
  boards: number[][]; completedRuns: number[]
}

function publicBoards(room: PokerTableEventView): number[][] {
  const hand = room.hand
  return hand ? (hand.boards.length ? hand.boards : [hand.board]).map(board => [...board]) : []
}

function results(room: PokerTableEventView): RunoutResult[] {
  return room.runoutPlayback?.completedResults ?? room.hand?.runResults ?? []
}

function snapshot(room: PokerTableEventView): VisualSnapshot {
  return {
    instance: room.instanceId, self: room.selfId, hand: room.hand?.number ?? null,
    history: room.hand?.history.length ?? 0, finished: !!room.hand?.finished && room.settlementAt == null,
    pot: room.hand?.pot ?? null,
    holeCards: Object.fromEntries(room.hand?.players.map(player => [player.id, player.cards ? [...player.cards] : [null, null]]) ?? []),
    boards: publicBoards(room), completedRuns: results(room).map(result => result.run),
  }
}

function winnerIds(result: RunoutResult): string[] {
  // A side-pot recipient may still lose chips overall. Neither net delta nor
  // the rank of the strongest hand describes every recipient of this board.
  return [...new Set([...result.winners, ...Object.keys(result.payouts).filter(id => result.payouts[id] > 0)])]
}

/** Observe server transitions independently of React mounts and review tabs. */
export class BattleVisualTracker {
  private previous: VisualSnapshot | null = null
  private skipNext = false

  resetContinuity(): void { this.skipNext = true }

  observe(room: PokerTableEventView | null, visible = true): BattleVisualEvent | null {
    if (!room) { this.previous = null; this.skipNext = false; return null }
    const next = snapshot(room), old = this.previous
    this.previous = next
    const skip = this.skipNext
    this.skipNext = !visible
    // Inactive pages still consume events. The first snapshot after a hidden
    // document or interrupted connection establishes a new baseline.
    if (!visible || skip || !old || old.instance !== next.instance || old.self !== next.self || !room.hand) return null

    const hand = room.hand
    const handKey = `${room.instanceId}:${hand.number}`
    const newHand = old.hand !== next.hand
    const deal = newHand && !hand.finished
    const potChanged = newHand || next.pot !== old.pot
    const holeKeys = newHand ? [] : hand.players.flatMap(player => {
      const previousCards = old.holeCards[player.id]
      if (player.id === room.selfId || !previousCards) return []
      return (player.cards ?? []).flatMap((card, index) => card !== null && previousCards[index] === null
        ? [`${player.id}:${index}:${card}`] : [])
    })
    const boardIndex = room.runoutPlayback?.boardIndex ?? Math.max(0, next.boards.length - 1)
    const board = next.boards[boardIndex] ?? hand.board
    const previousBoard = newHand ? [] : old.boards[boardIndex] ?? []
    let seenCards = previousBoard.length
    if (boardIndex > 0 && previousBoard.length === 0) {
      // Each run starts from the already public prefix. Only the suffix is
      // newly dealt, even when polling misses the initial prefix-only step.
      const firstBoard = next.boards[0] ?? []
      while (seenCards < board.length && board[seenCards] === firstBoard[seenCards]) seenCards++
    }
    const boardKeys = board.slice(seenCards).map((card, index) => `${boardIndex}:${seenCards + index}:${card}`)
    const actions = hand.history.slice(newHand ? 0 : old.history).flatMap((action, offset) => {
      if (!['fold', 'check', 'call', 'raise', 'bet'].includes(action.kind)) return []
      return [{ playerId: action.playerId, key: `${handKey}:action:${(newHand ? 0 : old.history) + offset}`, kind: action.kind }]
    })

    let award: BattleVisualAward | null = null
    const completed = results(room)
    const currentResult = completed.find(result => result.run === boardIndex + 1)
    if (room.settlementAt == null && currentResult && (newHand || !old.completedRuns.includes(currentResult.run))) {
      award = { key: `${handKey}:run:${currentResult.run}`, winnerIds: winnerIds(currentResult) }
    } else if (next.finished && (newHand || !old.finished) && completed.length === 0 && (newHand || old.completedRuns.length === 0)) {
      // Uncontested hands have no run results. Older showdown snapshots can
      // recover gross awards from returned stack delta plus committed chips.
      const winners = hand.showdown
        ? hand.players.filter(player => (hand.delta?.[player.id] ?? -player.invested) + player.invested > 0)
        : hand.players.filter(player => !player.folded)
      if (hand.showdown || winners.length === 1) award = { key: `${handKey}:settled`, winnerIds: winners.map(player => player.id) }
    }
    if (award?.winnerIds.length === 0) award = null
    if (!deal && !potChanged && holeKeys.length === 0 && boardKeys.length === 0 && actions.length === 0 && !award) return null
    return {
      key: `${handKey}:${hand.history.length}:${boardIndex}:${board.length}:${completed.length}:${Number(hand.finished)}:${hand.pot}:${holeKeys.join(',')}`,
      handKey, deal, potChanged, holeKeys, boardKeys, actions, award,
    }
  }
}
