import { COMBO_CARDS, HAND_NAMES, comboIndex, combosForHand, parseCard, type Card } from '../poker/cards'
import { parseRange } from '../poker/rangeParser'
import type { PlayerSpec } from '../poker/equity'
import type { AnalysisRange, RangeSource } from './types'

export const CLASS_COMBOS = HAND_NAMES.map(hand => combosForHand(hand).map(([a, b]) => comboIndex(a, b)))
export const emptyRange = (): AnalysisRange => ({ weights: new Float32Array(1326), source: 'unset' })
export function textRange(text: string, source: RangeSource = 'custom'): AnalysisRange {
  const weights = new Float32Array(1326)
  for (const token of text.split(',').map(t => t.trim()).filter(Boolean)) {
    const parts = token.split(':')
    const spec = parts[0].trim(), weight = parts.length === 1 ? 1 : Number(parts[1])
    if (parts.length > 2 || parts.length === 2 && !parts[1].trim() || !Number.isFinite(weight) || weight < 0 || weight > 1) throw new Error(`非法频率: ${token}`)
    if (/^[2-9TJQKA][shdc][2-9TJQKA][shdc]$/i.test(spec)) {
      const a = parseCard(spec.slice(0, 2))!, b = parseCard(spec.slice(2))!
      if (a === b) throw new Error(`非法手牌: ${spec}`)
      weights[comboIndex(a, b)] = weight
    } else for (const hand of parseRange(spec).keys()) for (const [a, b] of combosForHand(hand)) weights[comboIndex(a, b)] = weight
  }
  return { weights, source }
}
export function classRange(classes: ArrayLike<number>, source: RangeSource): AnalysisRange {
  const weights = new Float32Array(1326)
  CLASS_COMBOS.forEach((indices, h) => indices.forEach(i => { weights[i] = classes[h] }))
  return { weights, source }
}
export function maskRange(range: AnalysisRange, dead: Card[]): Float32Array {
  const blocked = new Set(dead)
  return Float32Array.from(range.weights, (w, i) => {
    const [a, b] = COMBO_CARDS[i]
    return blocked.has(a) || blocked.has(b) || !Number.isFinite(w) || w <= 0 ? 0 : Math.min(1, w)
  })
}
export function rangeSummary(range: AnalysisRange, dead: Card[]) {
  const live = maskRange(range, dead)
  return { percent: range.weights.reduce((s, w) => s + w, 0) / 1326 * 100,
    combos: live.reduce((s, w) => s + w, 0), count: live.reduce((s, w) => s + (w > 0 ? 1 : 0), 0) }
}
export function setClass(range: AnalysisRange, h: number, weight: number): AnalysisRange {
  const weights = range.weights.slice()
  for (const i of CLASS_COMBOS[h]) weights[i] = weight
  return { weights, source: 'custom' }
}
export function rangeSpec(range: AnalysisRange, dead: Card[]): PlayerSpec {
  return { type: 'range', combos: Array.from(maskRange(range, dead)).flatMap((w, i) => w > 0 ? [{ cards: COMBO_CARDS[i], w }] : []) }
}
export function compatibleRanges(a: Float32Array, b: Float32Array): boolean {
  const aIndices = Array.from(a).flatMap((w, i) => w > 0 ? [i] : [])
  const bIndices = Array.from(b).flatMap((w, i) => w > 0 ? [i] : [])
  for (const i of aIndices) {
    const [a1, a2] = COMBO_CARDS[i]
    for (const j of bIndices) {
      const [b1, b2] = COMBO_CARDS[j]
      if (a1 !== b1 && a1 !== b2 && a2 !== b1 && a2 !== b2) return true
    }
  }
  return false
}

export const SIMPLE_RANGES = [
  { zh: '超强牌 QQ+/AK', en: 'Premium QQ+/AK', text: 'QQ+, AKs, AKo' },
  { zh: '紧范围（示例）', en: 'Tight (example)', text: '77+, ATs+, KTs+, QTs+, JTs, T9s, 98s, AJo+, KQo' },
  { zh: '宽范围（示例）', en: 'Wide (example)', text: '22+, A2s+, K7s+, Q8s+, J8s+, T8s+, 97s+, 87s, 76s, 65s, 54s, A5o+, KTo+, QTo+, JTo' },
]
