import type { Card } from '../poker/cards'
import type { Position } from '../poker/ranges'

export type RangeSource = 'scenario' | 'snapshot' | 'inferred' | 'custom' | 'unset'
export interface AnalysisRange {
  weights: Float32Array
  source: RangeSource
}
export interface StreetSnapshot {
  version: 1
  street: 'flop' | 'turn' | 'river'
  board: Card[]
  pot: number
  stack: number
  seats: [number, number]
  ranges: [Float32Array, Float32Array]
}
export interface AnalysisPlayer {
  id: string
  name: string
  position?: Position
  stack: number | null
  folded: boolean
  cards?: [Card, Card]
  range: AnalysisRange
}
export interface AnalysisContext {
  id: string
  title: string
  board: Card[]
  pot: number | null
  players: AnalysisPlayer[]
  heroId: string
  mode: 'cash' | 'tournament'
  rangeUnconditioned?: boolean
  missingState?: boolean
  selectedIds?: [string, string]
}
export type AnalysisTarget = 'equity' | 'solver'
export type OpenAnalysis = (target: AnalysisTarget, context: AnalysisContext) => void
