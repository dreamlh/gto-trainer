import type { SessionSnapshot } from './session'
import { activeSeats, pot, settle, showdown } from './engine'
import { trainerHistoryActions } from './trainerPresentation'
import type { PokerTableEventView } from '../poker/tableEvents'
import type { EngineState } from './engine'

const ids = new WeakMap<EngineState, number>()
let nextId = 0

/** Copy mutable engine data before handing it to shared transition trackers.
 * Opponent cards stay private until the user explicitly chooses to show them. */
export function trainerTableEvents(snap: SessionSnapshot, revealAll: boolean): PokerTableEventView {
  const view: PokerTableEventView = { instanceId: 'trainer', selfId: 'hero', hand: null, settlementAt: null, runoutPlayback: null }
  const engine = snap.engine
  if (!engine) return view
  if (!ids.has(engine)) ids.set(engine, ++nextId)
  const id = (seat: number) => seat === snap.heroSeat ? 'hero' : `seat-${seat}`
  const finished = !!snap.result
  const result = snap.result
  const remaining = activeSeats(engine)
  const payouts = finished && result?.deltaBB !== null && (result?.wentToShowdown || remaining.length === 1)
    ? result?.wentToShowdown ? showdown(engine) : new Map([[remaining[0], pot(engine)]]) : new Map<number, number>()
  const deltas = payouts.size ? settle(engine, payouts) : new Map<number, number>()
  if (result?.deltaBB != null) deltas.set(snap.heroSeat, result.deltaBB)
  const history = trainerHistoryActions(engine)
  const dealer = engine.n === 2 ? 0 : engine.positions.indexOf('BTN')
  view.hand = {
    number: ids.get(engine)!, street: engine.street, board: [...engine.board], boards: [[...engine.board]], pot: pot(engine),
    dealerId: id(dealer), smallBlindId: id(engine.n === 2 ? 0 : engine.positions.indexOf('SB')), bigBlindId: id(engine.positions.indexOf('BB')),
    toAct: finished || snap.toActSeat < 0 ? null : id(snap.toActSeat), legal: null,
    finished, showdown: !!result?.wentToShowdown, awaitingRunout: false, runCount: 1,
    delta: finished ? Object.fromEntries([...deltas].map(([seat, value]) => [id(seat), value])) : null,
    // An early stop for feedback is not a settled pot: do not invent a winner.
    runResults: payouts.size ? [{ run: 1, board: [...engine.board], winners: [...payouts].filter(([, value]) => value > 0).map(([seat]) => id(seat)), payouts: Object.fromEntries([...payouts].map(([seat, value]) => [id(seat), value])) }] : [],
    players: engine.players.map(player => ({
      id: id(player.seat), seat: player.seat, cards: player.seat === snap.heroSeat || revealAll ? [...player.cards] : [null, null],
      stack: engine.stack - player.invested + (finished ? payouts.get(player.seat) ?? 0 : 0), invested: player.invested,
      streetBet: player.invested - player.streetBase, folded: player.folded, allin: player.allin,
    })),
    history: history.map(action => ({ playerId: id(action.seat), street: action.street, kind: action.kind, amount: action.amount ?? 0,
      allin: ['bet', 'raise', 'call'].includes(action.kind) && action.to >= engine.stack })),
  }
  return view
}
