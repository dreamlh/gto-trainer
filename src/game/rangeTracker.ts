import { handIndexOf, type Card } from '../poker/cards'
import { classWeightsToCombos, zeroDead } from '../solver/postflop/combos'

// 沿动作历史条件化每个玩家的范围。
// 翻前：169 类权重（每组合权重，初始 1）；每次该玩家按策略行动，乘以对应动作频率。
// 进翻后：换算成 1326 组合向量（公共牌清零），之后按翻后节点策略逐动作条件化。

export class RangeTracker {
  class169: Float32Array[] // 每座位
  combo1326: (Float32Array | null)[] = []

  constructor(n: number) {
    this.class169 = Array.from({ length: n }, () => new Float32Array(169).fill(1))
    this.combo1326 = Array.from({ length: n }, () => null)
  }

  // 翻前：seat 在 freq 矩阵（169*A）下选择动作 a
  applyPreflop(seat: number, freq: Float32Array | undefined, A: number, a: number): void {
    const w = this.class169[seat]
    if (!freq) return // 低到达节点未存储：不更新（近似均匀）
    for (let h = 0; h < 169; h++) w[h] *= freq[h * A + a]
  }

  // 进翻后：转 1326 向量
  toCombos(seat: number, board: Card[]): Float32Array {
    const v = classWeightsToCombos(this.class169[seat], board)
    this.combo1326[seat] = v
    return v
  }

  // 翻后：seat 在节点策略（1326*A）下选择动作 a
  applyPostflop(seat: number, strategy: Float32Array, A: number, a: number): void {
    const v = this.combo1326[seat]
    if (!v) throw new Error('尚未转换为组合向量')
    for (let c = 0; c < 1326; c++) v[c] *= strategy[c * A + a]
  }

  // 新街开始：新公共牌清零死组合
  maskBoard(seat: number, newCards: Card[]): void {
    const v = this.combo1326[seat]
    if (!v) return
    zeroDead(v, newCards)
  }

  heroClassOf(cards: [Card, Card]): number {
    return handIndexOf(cards[0], cards[1])
  }
}
