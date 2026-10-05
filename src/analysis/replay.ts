import type { ArchivedHandView } from '../battle/types'
import type { HandRecord } from '../game/session'
import type { Position } from '../poker/ranges'
import { POSITIONS_BY_SIZE, postflopOrder } from '../solver/config'
import type { PreflopBundle } from '../solver/preflop/api'
import type { PfNode } from '../solver/preflop/tree'
import { classRange, emptyRange } from './ranges'
import type { AnalysisContext, AnalysisPlayer } from './types'

export const STREETS = ['preflop', 'flop', 'turn', 'river'] as const
export type ReviewStreet = typeof STREETS[number]
export const BOARD_LENGTH = { preflop: 0, flop: 3, turn: 4, river: 5 }
export interface BattleReplayRecord {
  id: string; instanceId: string; heroId: string; savedAt: number; hand: ArchivedHandView
}
export function normalizePosition(position?: string | null): Position | undefined {
  const value = position?.replace(/\s/g, '').replace('BTN/SB', 'BTN').replace('UTG+1', 'UTG1').replace('UTG+2', 'UTG2')
  return Object.values(POSITIONS_BY_SIZE).some(positions => positions.includes(value as Position)) ? value as Position : undefined
}

export function trainingContext(record: HandRecord, street: ReviewStreet): AnalysisContext {
  const snapshot = record.replay?.find(s => s.street === street)
  const positions = POSITIONS_BY_SIZE[record.tableSize]
  const before = record.actions.filter(a => STREETS.indexOf(a.street) < STREETS.indexOf(street))
  const players: AnalysisPlayer[] = positions.map((position, seat) => {
    const snapshotIndex = snapshot?.seats.indexOf(seat) ?? -1
    return { id: String(seat), name: position, position, stack: snapshotIndex >= 0 ? snapshot!.stack : null,
      folded: before.some(a => a.seat === seat && a.kind === 'fold'),
      ...(seat === record.heroSeat ? { cards: record.heroCards } : {}),
      range: snapshotIndex >= 0 ? { weights: snapshot!.ranges[snapshotIndex].slice(), source: 'snapshot' } : emptyRange() }
  })
  return { id: `training:${record.id}:${street}`, title: `${record.heroPos} · ${street}`, board: record.board.slice(0, BOARD_LENGTH[street]),
    heroId: String(record.heroSeat), mode: 'cash', pot: snapshot?.pot ?? null, players, missingState: !snapshot }
}

/** Reconstruct only actions BEFORE this street; never use final stacks or future board cards. */
export function battleContext(record: BattleReplayRecord, street: ReviewStreet, run = 0): AnalysisContext {
  const { hand } = record
  const bb = hand.bigBlind
  const replay = hand.replay
  let missing = !replay || !(bb && bb > 0)
  const players: AnalysisPlayer[] = hand.players.map(p => {
    const starting = replay?.startingStacks[p.id]
    if (starting === undefined || !Number.isFinite(starting)) missing = true
    return { id: p.id, name: p.name, position: normalizePosition(p.position),
      stack: starting === undefined || !bb ? null : starting / bb, folded: false,
      ...(p.id === record.heroId && hand.myCards ? { cards: hand.myCards } : {}), range: emptyRange() }
  })
  let pot = 0
  let currentStreet = 'preflop'
  const invested = new Map<string, number>()
  for (const action of hand.history) {
    if (STREETS.indexOf(action.street as ReviewStreet) >= STREETS.indexOf(street)) continue
    if (!STREETS.includes(action.street as ReviewStreet)) { missing = true; continue }
    if (action.street !== currentStreet) { invested.clear(); currentStreet = action.street }
    const player = players.find(p => p.id === action.playerId)
    if (!player) { missing = true; continue }
    if (action.kind === 'fold') { player.folded = true; continue }
    if (action.kind === 'check') continue
    if (!bb) continue
    let amount = action.amount / bb
    if (['raise', 'bet'].includes(action.kind)) amount -= invested.get(player.id) ?? 0
    else if (action.kind === 'refund') amount = -amount
    else if (!['call', 'small-blind', 'big-blind', 'entry-blind'].includes(action.kind)) { missing = true; continue }
    pot += amount
    invested.set(player.id, (invested.get(player.id) ?? 0) + amount)
    if (player.stack !== null) { player.stack -= amount; if (player.stack < -1e-6) missing = true }
  }
  return { id: `battle:${record.id}:${street}:${run}`, title: `#${hand.number} · ${street}`, heroId: record.heroId,
    mode: replay?.mode ?? 'cash', board: (hand.boards[run] ?? hand.board).slice(0, BOARD_LENGTH[street]),
    pot: missing ? null : pot, players, missingState: missing, rangeUnconditioned: street === 'turn' || street === 'river' }
}

/** Exact preflop matching only. Missing nodes and nonstandard sizes do not receive invented ranges. */
export function inferBattleRanges(context: AnalysisContext, record: BattleReplayRecord, bundle: PreflopBundle): AnalysisContext {
  const hand = record.hand, replay = hand.replay, bb = hand.bigBlind
  if (!replay || !bb || bundle.n !== hand.players.length || hand.smallBlind !== bb / 2 || context.board.length < 3) return context
  const ids = bundle.tree.positions.map(pos => hand.players.find(p => normalizePosition(p.position) === pos)?.id)
  if (ids.some(id => !id) || new Set(ids).size !== ids.length || ids.some(id => Math.abs(replay.startingStacks[id!] / bb - bundle.tree.ladder.stack) > 1e-6)) return context
  if (hand.history.some(a => a.street === 'preflop' && !['fold', 'raise', 'call', 'small-blind', 'big-blind'].includes(a.kind))) return context
  const actions = hand.history.filter(a => a.street === 'preflop' && !a.kind.includes('blind'))
  const totals = new Map(ids.map((id, seat) => [id!, bundle.tree.positions[seat] === 'BB' ? 1 : (bundle.tree.positions[seat] === 'SB' || (bundle.n === 2 && seat === 0)) ? .5 : 0]))
  const ranges = ids.map(() => new Float32Array(169).fill(1))
  let node: PfNode = bundle.tree.root
  let at = 0
  for (;;) {
    for (const seat of node.forcedFolds) {
      const action = actions[at++]
      if (!action || action.playerId !== ids[seat] || action.kind !== 'fold') return context
    }
    if (node.type === 'terminal') break
    const action = actions[at++]
    if (!action || action.playerId !== ids[node.actor]) return context
    const to = action.kind === 'call' ? totals.get(action.playerId)! + action.amount / bb : action.amount / bb
    const index = node.actions.findIndex(a => a.kind === action.kind && (a.kind === 'fold' || Math.abs(a.to - to) < 1e-6))
    if (index < 0) return context
    const frequency = bundle.freq.get(node.id)
    if (!frequency && context.players.some(p => p.id === action.playerId && !p.folded)) return context
    if (frequency) for (let h = 0; h < 169; h++) ranges[node.actor][h] *= frequency[h * node.actions.length + index]
    if (action.kind !== 'fold') totals.set(action.playerId, to)
    node = node.children[index]
  }
  if (at !== actions.length || !['flop', 'runout'].includes(node.kind)) return context
  return { ...context, players: context.players.map(player => {
    const seat = ids.indexOf(player.id)
    const range = classRange(ranges[seat], 'inferred')
    return { ...player, range: range.weights.some(w => w > 0) ? range : emptyRange() }
  }) }
}

export type SolverBlock = 'street' | 'missing' | 'multiway' | 'allin' | 'position'
export function solverBlock(context: AnalysisContext): SolverBlock | null {
  if (![3,4,5].includes(context.board.length)) return 'street'
  if (context.missingState || context.pot === null || !(context.pot > 0)) return 'missing'
  const live = context.players.filter(p => !p.folded)
  if (live.length !== 2) return 'multiway'
  if (live.some(p => p.stack === null)) return 'missing'
  if (live.some(p => !(p.stack! > 0))) return 'allin'
  if (live.some(p => !p.position) || live[0].position === live[1].position) return 'position'
  return null
}
export function orderedPlayers(context: AnalysisContext): AnalysisPlayer[] {
  const live = context.players.filter(p => !p.folded)
  const allPositions = context.players.map(p => p.position!)
  const order = postflopOrder(allPositions)
  return live.sort((a, b) => order[context.players.indexOf(a)] - order[context.players.indexOf(b)])
}
