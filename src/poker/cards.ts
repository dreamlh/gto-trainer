// 牌的编码：card = rank * 4 + suit，rank 0..12 对应 2..A，suit 0..3 对应 s h d c
export type Card = number

export const RANK_CHARS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const
export const SUIT_CHARS = ['s', 'h', 'd', 'c'] as const
export const SUIT_SYMBOLS = ['♠', '♥', '♦', '♣'] as const

export function makeCard(rank: number, suit: number): Card {
  return rank * 4 + suit
}
export function rankOf(c: Card): number {
  return c >> 2
}
export function suitOf(c: Card): number {
  return c & 3
}

export function parseCard(s: string): Card | null {
  if (s.length !== 2) return null
  const r = RANK_CHARS.indexOf(s[0].toUpperCase() as (typeof RANK_CHARS)[number])
  const su = SUIT_CHARS.indexOf(s[1].toLowerCase() as (typeof SUIT_CHARS)[number])
  if (r < 0 || su < 0) return null
  return makeCard(r, su)
}

export function cardStr(c: Card): string {
  return RANK_CHARS[rankOf(c)] + SUIT_CHARS[suitOf(c)]
}

export function rankVal(ch: string): number {
  return RANK_CHARS.indexOf(ch as (typeof RANK_CHARS)[number])
}

// 169 手牌矩阵：行/列均按 A..2 降序，对角线为对子，右上区为同花
export const GRID_RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'] as const

export function gridHandName(row: number, col: number): string {
  if (row === col) return GRID_RANKS[row] + GRID_RANKS[col]
  const hi = Math.min(row, col)
  const lo = Math.max(row, col)
  return GRID_RANKS[hi] + GRID_RANKS[lo] + (row < col ? 's' : 'o')
}

// 两张具体牌 -> 规范手牌名（如 "AKs"、"T9o"、"QQ"）
export function handNameOf(c1: Card, c2: Card): string {
  const r1 = rankOf(c1)
  const r2 = rankOf(c2)
  const hi = Math.max(r1, r2)
  const lo = Math.min(r1, r2)
  if (hi === lo) return RANK_CHARS[hi] + RANK_CHARS[lo]
  return RANK_CHARS[hi] + RANK_CHARS[lo] + (suitOf(c1) === suitOf(c2) ? 's' : 'o')
}

// 手牌名 -> 所有具体组合
export function combosForHand(name: string): [Card, Card][] {
  const r1 = rankVal(name[0])
  const r2 = rankVal(name[1])
  const out: [Card, Card][] = []
  if (r1 === r2) {
    for (let a = 0; a < 4; a++)
      for (let b = a + 1; b < 4; b++) out.push([makeCard(r1, a), makeCard(r1, b)])
  } else if (name[2] === 's') {
    for (let s = 0; s < 4; s++) out.push([makeCard(r1, s), makeCard(r2, s)])
  } else {
    for (let a = 0; a < 4; a++)
      for (let b = 0; b < 4; b++) if (a !== b) out.push([makeCard(r1, a), makeCard(r2, b)])
  }
  return out
}

export function comboCount(name: string): number {
  if (name[0] === name[1]) return 6
  return name[2] === 's' ? 4 : 12
}

export function fullDeck(): Card[] {
  const d: Card[] = []
  for (let i = 0; i < 52; i++) d.push(i)
  return d
}

// ---- 169 手牌类的规范索引（行优先扫描 13×13 矩阵，与 UI 网格一致）----
export const HAND_NAMES: string[] = (() => {
  const out: string[] = []
  for (let r = 0; r < 13; r++) for (let c = 0; c < 13; c++) out.push(gridHandName(r, c))
  return out
})()

const HAND_INDEX = new Map(HAND_NAMES.map((n, i) => [n, i]))

export function handIndex(name: string): number {
  const i = HAND_INDEX.get(name)
  if (i === undefined) throw new Error(`未知手牌: ${name}`)
  return i
}

// 两张具体牌 -> 手牌类索引
export function handIndexOf(c1: Card, c2: Card): number {
  return handIndex(handNameOf(c1, c2))
}

// ---- 1326 组合的规范索引：c1 < c2，idx = c2*(c2-1)/2 + c1 ----
export function comboIndex(c1: Card, c2: Card): number {
  const lo = Math.min(c1, c2)
  const hi = Math.max(c1, c2)
  return (hi * (hi - 1)) / 2 + lo
}

export const COMBO_CARDS: [Card, Card][] = (() => {
  const out: [Card, Card][] = []
  for (let hi = 1; hi < 52; hi++) for (let lo = 0; lo < hi; lo++) out.push([lo, hi])
  return out
})()
