import type { Card } from '../poker/cards'
export type Language = 'zh' | 'en'
export type RoomMode = 'cash' | 'tournament'
export interface TournamentView {
  registrationRaises: number; registrationClosesAt: number | null; registrationOpen: boolean
  status: 'waiting' | 'running' | 'finished'; level: number; smallBlind: number; bigBlind: number
  nextLevelAt: number | null; startedAt: number | null; winnerId: string | null; blindIntervalMinutes: number
  entrantIds: string[]
  rankings: { playerId: string; place: number; chips: number; eliminated: boolean; forfeited: boolean }[]
}
export type BattleAction = { kind: 'fold' | 'check' | 'call' } | { kind: 'raise'; to: number }
export interface LegalActions { canFold: boolean; canCheck: boolean; callAmount: number; minRaiseTo: number | null; maxRaiseTo: number }
export interface HandPlayerView {
  id: string; seat?: number; cards: [Card | null, Card | null] | null; stack: number; invested: number; streetBet: number; folded: boolean; allin: boolean
}
export interface RunoutResult {
  run: number; board: Card[]; winners: string[]; payouts: Record<string, number>
}
export interface RunoutPlayback {
  boardIndex: number; revealedCount: number; phase: 'dealing' | 'settling' | 'result'
  completedResults: RunoutResult[]; nextRevealAt: number
}
/** Public action log, with only the authenticated viewer's own hole cards. */
export interface ArchivedHandView {
  bigBlind?: number; smallBlind?: number
  number: number; finishedAt: number; board: Card[]; boards: Card[][]
  history: HandView['history']; players: { id: string; name: string; bot: boolean; position?: string | null }[]
  myCards?: [Card, Card]
  delta: Record<string, number>; showdown: boolean; runResults: RunoutResult[]
}
export interface HandView {
  bigBlind?: number; smallBlind?: number
  number: number; street: 'preflop' | 'flop' | 'turn' | 'river'; board: Card[]; boards: Card[][]; pot: number
  dealerId: string; smallBlindId: string; bigBlindId: string; toAct: string | null; players: HandPlayerView[]
  /** Players who still owe a decision in this betting round, including toAct. */
  pendingPlayerIds?: string[]
  legal: LegalActions | null; finished: boolean; showdown: boolean; awaitingRunout: boolean; runCount: number
  delta: Record<string, number> | null
  runResults?: RunoutResult[]
  history: { playerId: string; street: string; kind: string; amount: number; allin?: boolean }[]
}
export interface PlayerStats {
  hands: number; vpip: number; pfr: number; threeBet: number; threeBetOpportunities: number
  cbet: number; cbetOpportunities: number; sawFlop: number; showdowns: number; showdownWins: number
  betsRaises: number; calls: number; netBB: number
}
export interface RoomPlayer {
  tournamentStatus?: 'spectator' | 'active' | 'rebuy' | 'eliminated' | 'winner' | 'forfeited'
  buyIns?: number
  tournamentPlace?: number | null; netChips?: number
  id: string; name: string; bot: boolean; connected: boolean; leaving?: boolean; score: number
  seat: number | null; pendingSeat: number | null; stack: number; sittingOut: boolean; timeCards: number; stats: PlayerStats
  shareWithSpectators: boolean
  entryStatus: 'ready' | 'waiting' | 'post'
  pendingRemoval?: boolean
  /** Non-null while temporarily away; cash seats are released at this deadline. */
  awayUntil?: number | null
  timeoutCount?: number
}
export interface ChatMessage { id: string; playerId: string; name: string; text: string; ts: number }
export interface RunoutVote { handNumber: number; eligibleIds: string[]; votes: Record<string, 1 | 2 | 3>; deadline: number }
export interface RoomView {
  mode?: RoomMode; tournament?: TournamentView | null
  /** Configured time for the next hand; 0 means no human action time limit. */
  actionSeconds?: number
  /** Time captured when the displayed hand was dealt; null before any hand. */
  handActionSeconds?: number | null
  /** Cards may be shown now; winnings and statistics publish at this deadline. */
  settlementAt?: number | null
  code: string; instanceId: string; revision: number; actionRevision: number; hostId: string; selfId: string; capacity: number; initialStack: number
  players: RoomPlayer[]; hand: HandView | null; actionDeadline: number | null; nextHandAt: number | null; started: boolean
  seats: (string | null)[]; reservations: (string | null)[]; runoutVote: RunoutVote | null; chat: ChatMessage[]
  canFastForward: boolean; nextTimeCardAt: number
  revealed: Record<string, number[]>
  isSpectator: boolean; seatRequests: string[]
  runoutPlayback?: RunoutPlayback | null; handHistory?: ArchivedHandView[]
  pendingSeatRemovals?: number[]
}
export interface RoomSession { code: string; playerId: string; token: string }
export type RoomCommand =
  | { type: 'add-bot'; seat?: number }
  | { type: 'fill-bots' }
  | { type: 'remove-bot'; playerId: string }
  | { type: 'start' }
  | { type: 'action'; action: BattleAction; handNumber: number; revision: number }
  | { type: 'leave' }
  | { type: 'sit'; seat: number }
  | { type: 'stand' }
  | { type: 'away'; away: boolean }
  | { type: 'settings'; actionSeconds: number; initialStack: number }
  | { type: 'remove-seat'; seat: number; capacity: number }
  | { type: 'cancel-seat' }
  | { type: 'rebuy' }
  | { type: 'time-card'; handNumber: number }
  | { type: 'show'; cards: number[]; handNumber: number }
  | { type: 'runouts'; count: 1 | 2 | 3; handNumber: number }
  | { type: 'fast-forward' }
  | { type: 'chat'; text: string }
  | { type: 'spectator-cards'; show: boolean }
  | { type: 'request-seat' }
  | { type: 'add-seat' }
  | { type: 'post-blind' }
