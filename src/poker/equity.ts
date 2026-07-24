import { fullDeck, type Card } from './cards'
import { evaluate } from './evaluator'

export interface WeightedCombo {
  cards: [Card, Card]
  w: number
}

export type PlayerSpec =
  | { type: 'cards'; cards: [Card, Card] }
  | { type: 'range'; combos: WeightedCombo[] }

export interface EquityResult {
  win: number // 玩家1 获胜概率
  tie: number
  lose: number
  iterations: number
}

function conflicts(cards: [Card, Card], used: boolean[]): boolean {
  return used[cards[0]] || used[cards[1]]
}

// 蒙特卡洛权益计算（玩家1 视角）
export function computeEquity(
  p1: PlayerSpec,
  p2: PlayerSpec,
  board: Card[],
  iterations = 50000,
): EquityResult {
  const usedBase: boolean[] = new Array(52).fill(false)
  for (const c of board) usedBase[c] = true
  if (p1.type === 'cards') {
    usedBase[p1.cards[0]] = true
    usedBase[p1.cards[1]] = true
  }
  if (p2.type === 'cards') {
    usedBase[p2.cards[0]] = true
    usedBase[p2.cards[1]] = true
  }

  // 范围的累积权重表，用于加权抽样
  function cumTable(combos: WeightedCombo[]): { combos: WeightedCombo[]; cum: number[] } {
    const cum: number[] = []
    let acc = 0
    for (const c of combos) {
      acc += c.w
      cum.push(acc)
    }
    return { combos, cum }
  }
  const t1 = p1.type === 'range' ? cumTable(p1.combos) : null
  const t2 = p2.type === 'range' ? cumTable(p2.combos) : null

  function sampleRange(t: { combos: WeightedCombo[]; cum: number[] }): [Card, Card] {
    const total = t.cum[t.cum.length - 1]
    const x = Math.random() * total
    // 二分查找
    let lo = 0
    let hi = t.cum.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (t.cum[mid] < x) lo = mid + 1
      else hi = mid
    }
    return t.combos[lo].cards
  }

  // 确定性场景：双方牌固定且公共牌满 5 张
  const deterministic = p1.type === 'cards' && p2.type === 'cards' && board.length === 5
  const iters = deterministic ? 1 : iterations

  let win = 0
  let tie = 0
  let lose = 0
  const deck = fullDeck()

  for (let i = 0; i < iters; i++) {
    const used = usedBase.slice()

    let c1: [Card, Card]
    let c2: [Card, Card]
    if (p1.type === 'cards') c1 = p1.cards
    else {
      let tries = 0
      do {
        c1 = sampleRange(t1!)
        if (++tries > 1000) return { win: 0, tie: 0, lose: 0, iterations: 0 }
      } while (conflicts(c1, used))
      used[c1[0]] = true
      used[c1[1]] = true
    }
    if (p2.type === 'cards') c2 = p2.cards
    else {
      let tries = 0
      let ok = false
      c2 = [0, 0]
      do {
        c2 = sampleRange(t2!)
        ok = !conflicts(c2, used)
        if (++tries > 1000) break
      } while (!ok)
      if (!ok) continue // 该次抽样与已用牌全部冲突，跳过
      used[c2[0]] = true
      used[c2[1]] = true
    }

    // 补全公共牌
    const fullBoard = board.slice()
    while (fullBoard.length < 5) {
      const c = deck[(Math.random() * 52) | 0]
      if (!used[c]) {
        used[c] = true
        fullBoard.push(c)
      }
    }

    const s1 = evaluate([c1[0], c1[1], ...fullBoard])
    const s2 = evaluate([c2[0], c2[1], ...fullBoard])
    if (s1 > s2) win++
    else if (s1 === s2) tie++
    else lose++
  }

  const n = win + tie + lose
  if (n === 0) return { win: 0, tie: 0, lose: 0, iterations: 0 }
  return { win: win / n, tie: tie / n, lose: lose / n, iterations: n }
}
