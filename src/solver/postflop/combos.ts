import { COMBO_CARDS, handIndexOf, type Card } from '../../poker/cards'

// 1326 组合向量工具。组合索引：c1<c2, idx = c2*(c2-1)/2 + c1

// 每个组合的两张牌（预计算）
export const COMBO_A = new Int8Array(1326)
export const COMBO_B = new Int8Array(1326)
export const COMBO_CLASS = new Int16Array(1326) // 组合 -> 169 手牌类
for (let i = 0; i < 1326; i++) {
  COMBO_A[i] = COMBO_CARDS[i][0]
  COMBO_B[i] = COMBO_CARDS[i][1]
  COMBO_CLASS[i] = handIndexOf(COMBO_CARDS[i][0], COMBO_CARDS[i][1])
}

// 每张牌覆盖的 51 个组合索引（阻断牌用）
export const COMBOS_OF_CARD: Int16Array[] = (() => {
  const lists: number[][] = Array.from({ length: 52 }, () => [])
  for (let i = 0; i < 1326; i++) {
    lists[COMBO_A[i]].push(i)
    lists[COMBO_B[i]].push(i)
  }
  return lists.map((l) => Int16Array.from(l))
})()

// 169 类权重（每组合权重，不含组合数）→ 1326 向量，死牌置零
export function classWeightsToCombos(classW: Float32Array, dead: Card[]): Float32Array {
  const out = new Float32Array(1326)
  for (let i = 0; i < 1326; i++) out[i] = classW[COMBO_CLASS[i]]
  for (const c of dead) {
    const list = COMBOS_OF_CARD[c]
    for (let k = 0; k < list.length; k++) out[list[k]] = 0
  }
  return out
}

// 直接置零死牌
export function zeroDead(v: Float32Array, dead: Card[]): void {
  for (const c of dead) {
    const list = COMBOS_OF_CARD[c]
    for (let k = 0; k < list.length; k++) v[list[k]] = 0
  }
}
