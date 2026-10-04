import type { DecisionRecord } from './session'

/** Validate solver rows before scoring, including records saved by older builds. */
export function normalizeDecisionRecord(record: DecisionRecord): DecisionRecord {
  const count = record.labels.length
  const total = record.freqs.reduce((sum, frequency) => sum + frequency, 0)
  const hasStrategy = count > 0 && record.freqs.length === count
    && record.freqs.every(frequency => Number.isFinite(frequency) && frequency >= 0)
    && Math.abs(total - 1) <= 0.01
    && Number.isInteger(record.chosen) && record.chosen >= 0 && record.chosen < count
  if (!hasStrategy) {
    return { ...record, freqs: [], evs: null, evLoss: null, score: null, verdict: 'unavailable' }
  }

  // Only correct floating-point/serialization drift in a complete probability row.
  const freqs = record.freqs.map(frequency => frequency / total)
  const evs = record.evs?.length === count && record.evs.every(Number.isFinite) ? record.evs : null
  const evLoss = evs ? Math.max(...evs) - evs[record.chosen] : null
  const maxF = Math.max(...freqs)
  const frequency = freqs[record.chosen]
  const verdict = (evLoss !== null ? evLoss <= 0.05 : frequency >= maxF - 0.001)
    ? 'optimal'
    : frequency >= 0.1 || (evLoss !== null && evLoss <= 0.25) ? 'acceptable' : 'wrong'
  return { ...record, freqs, evs, evLoss, score: Math.round(frequency / maxF * 100), verdict }
}
