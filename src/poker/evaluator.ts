import type { Card } from './cards'

// 评估 5~7 张牌的最佳 5 张牌力，返回可比较的分值（越大越强）
// 分值 = 牌型 << 24 | 决胜位编码（< 2^24）
// 热路径：模块级 scratch，零分配（JS 单线程安全；worker 各有独立模块实例）

const rankCounts = new Int8Array(13)
const suitCounts = new Int8Array(4)
const suitMasks = new Int32Array(4)

function straightHigh(mask: number): number {
  for (let hi = 12; hi >= 4; hi--) {
    const need = 0b11111 << (hi - 4)
    if ((mask & need) === need) return hi
  }
  // A5432（轮子）：A 的位是 12
  if ((mask & 0b1000000001111) === 0b1000000001111) return 3
  return -1
}

function topNMask(mask: number, n: number): number {
  let out = 0
  let count = 0
  for (let r = 12; r >= 0 && count < n; r--) {
    if (mask & (1 << r)) {
      out |= 1 << r
      count++
    }
  }
  return out
}

export function evaluate(cards: ArrayLike<Card>): number {
  rankCounts.fill(0)
  suitCounts.fill(0)
  suitMasks[0] = suitMasks[1] = suitMasks[2] = suitMasks[3] = 0
  let rankMask = 0
  for (let k = 0; k < cards.length; k++) {
    const c = cards[k]
    const r = c >> 2
    const s = c & 3
    rankCounts[r]++
    suitCounts[s]++
    suitMasks[s] |= 1 << r
    rankMask |= 1 << r
  }

  let flushSuit = -1
  for (let s = 0; s < 4; s++) if (suitCounts[s] >= 5) flushSuit = s
  if (flushSuit >= 0) {
    const sf = straightHigh(suitMasks[flushSuit])
    if (sf >= 0) return (8 << 24) | sf
  }

  let quad = -1
  let trip1 = -1
  let trip2 = -1
  let pair1 = -1
  let pair2 = -1
  for (let r = 12; r >= 0; r--) {
    const n = rankCounts[r]
    if (n === 4) quad = r
    else if (n === 3) {
      if (trip1 < 0) trip1 = r
      else if (trip2 < 0) trip2 = r
    } else if (n === 2) {
      if (pair1 < 0) pair1 = r
      else if (pair2 < 0) pair2 = r
    }
  }

  if (quad >= 0) {
    let k = -1
    for (let r = 12; r >= 0; r--) {
      if (r !== quad && rankCounts[r] > 0) {
        k = r
        break
      }
    }
    return (7 << 24) | (quad << 4) | (k < 0 ? 0 : k)
  }

  if (trip1 >= 0 && trip2 >= 0) return (6 << 24) | (trip1 << 4) | trip2
  if (trip1 >= 0 && pair1 >= 0) return (6 << 24) | (trip1 << 4) | pair1

  if (flushSuit >= 0) return (5 << 24) | topNMask(suitMasks[flushSuit], 5)

  const st = straightHigh(rankMask)
  if (st >= 0) return (4 << 24) | st

  if (trip1 >= 0) {
    const kickers = topNMask(rankMask & ~(1 << trip1), 2)
    return (3 << 24) | (trip1 << 13) | kickers
  }

  if (pair1 >= 0 && pair2 >= 0) {
    const rest = rankMask & ~(1 << pair1) & ~(1 << pair2)
    let k = 0
    for (let r = 12; r >= 0; r--) {
      if (rest & (1 << r)) {
        k = r
        break
      }
    }
    return (2 << 24) | (pair1 << 8) | (pair2 << 4) | k
  }

  if (pair1 >= 0) {
    const kickers = topNMask(rankMask & ~(1 << pair1), 3)
    return (1 << 24) | (pair1 << 13) | kickers
  }

  return topNMask(rankMask, 5)
}
