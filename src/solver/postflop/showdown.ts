import type { Card } from '../../poker/cards'
import { evaluate } from '../../poker/evaluator'
import { COMBO_A, COMBO_B } from './combos'

// 河牌摊牌评估：排序牌力 + 单趟扫描（含阻断牌容斥），O(M) / 每次调用

const handBuf = new Int32Array(7)

// 5 张公共牌下所有组合的牌力；被公共牌阻断的组合 = -1
export function riverStrengths(board: Card[]): Int32Array {
  if (board.length !== 5) throw new Error('需要 5 张公共牌')
  const out = new Int32Array(1326).fill(-1)
  const onBoard = new Uint8Array(52)
  for (const c of board) onBoard[c] = 1
  for (let k = 0; k < 5; k++) handBuf[k + 2] = board[k]
  for (let i = 0; i < 1326; i++) {
    const a = COMBO_A[i]
    const b = COMBO_B[i]
    if (onBoard[a] || onBoard[b]) continue
    handBuf[0] = a
    handBuf[1] = b
    out[i] = evaluate(handBuf)
  }
  return out
}

// 按牌力升序排列的活组合索引（每次求解算一次）
export function sortedOrder(strengths: Int32Array): Int32Array {
  const live: number[] = []
  for (let i = 0; i < 1326; i++) if (strengths[i] >= 0) live.push(i)
  live.sort((x, y) => strengths[x] - strengths[y])
  return Int32Array.from(live)
}

export interface SweepResult {
  win: Float32Array // win[c] = 对手中比 c 弱的兼容质量 + 0.5×平局兼容质量
  mass: Float32Array // mass[c] = 对手全部兼容质量
}

const cumPerCard = new Float64Array(52)
const tiePerCard = new Float64Array(52)
const perCardTotal = new Float64Array(52)

// villain: 对手组合权重向量。结果写入 win/mass（1326，仅 order 中且未被排除的项有效）
// ex1/ex2：额外排除的牌（flop 求解按 runout 枚举时的转牌/河牌）
export function showdownSweep(
  order: Int32Array,
  strengths: Int32Array,
  villain: Float32Array,
  win: Float32Array,
  mass: Float32Array,
  ex1 = -1,
  ex2 = -1,
): void {
  cumPerCard.fill(0)
  perCardTotal.fill(0)
  let total = 0
  for (let k = 0; k < order.length; k++) {
    const c = order[k]
    const a = COMBO_A[c]
    const b = COMBO_B[c]
    if (a === ex1 || a === ex2 || b === ex1 || b === ex2) continue
    const w = villain[c]
    if (w > 0) {
      total += w
      perCardTotal[a] += w
      perCardTotal[b] += w
    }
  }

  let cumW = 0 // 严格更弱的总质量
  let k = 0
  while (k < order.length) {
    // 找同牌力组
    let end = k
    const s = strengths[order[k]]
    while (end < order.length && strengths[order[end]] === s) end++
    // 组内 per-card 和
    tiePerCard.fill(0)
    let tieTotal = 0
    for (let i = k; i < end; i++) {
      const c = order[i]
      const a = COMBO_A[c]
      const b = COMBO_B[c]
      if (a === ex1 || a === ex2 || b === ex1 || b === ex2) continue
      const w = villain[c]
      if (w > 0) {
        tieTotal += w
        tiePerCard[a] += w
        tiePerCard[b] += w
      }
    }
    for (let i = k; i < end; i++) {
      const c = order[i]
      const a = COMBO_A[c]
      const b = COMBO_B[c]
      if (a === ex1 || a === ex2 || b === ex1 || b === ex2) continue
      const weaker = cumW - cumPerCard[a] - cumPerCard[b]
      // 平局兼容：组内总量 - 含 a - 含 b + 自身（自身含两张，被减两次）
      const tie = tieTotal - tiePerCard[a] - tiePerCard[b] + villain[c]
      win[c] = weaker + 0.5 * tie
      mass[c] = total - perCardTotal[a] - perCardTotal[b] + villain[c]
    }
    // 推进累计
    for (let i = k; i < end; i++) {
      const c = order[i]
      const a = COMBO_A[c]
      const b = COMBO_B[c]
      if (a === ex1 || a === ex2 || b === ex1 || b === ex2) continue
      const w = villain[c]
      if (w > 0) {
        cumW += w
        cumPerCard[a] += w
        cumPerCard[b] += w
      }
    }
    k = end
  }
}
