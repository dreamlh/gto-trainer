import { rankVal, RANK_CHARS } from './cards'

// 解析范围记法，返回 手牌名 -> 频率
// 支持：对子 "QQ" / "77+" / "TT-66"
//      同花/非同花 "AKs" / "A2s+"（低牌向上扩展到高牌-1）/ "QTs-Q8s"（同高牌）
//      同间距连子段 "T9s-54s"
//      频率后缀 "A5s:0.5"
const R = '[2-9TJQKA]'

function expandSpec(spec: string): string[] {
  let m: RegExpMatchArray | null

  if ((m = spec.match(new RegExp(`^(${R})\\1$`)))) return [spec]

  if ((m = spec.match(new RegExp(`^(${R})\\1\\+$`)))) {
    const from = rankVal(m[1])
    const out: string[] = []
    for (let r = from; r <= 12; r++) out.push(RANK_CHARS[r] + RANK_CHARS[r])
    return out
  }

  if ((m = spec.match(new RegExp(`^(${R})\\1-(${R})\\2$`)))) {
    const a = rankVal(m[1])
    const b = rankVal(m[2])
    const hi = Math.max(a, b)
    const lo = Math.min(a, b)
    const out: string[] = []
    for (let r = lo; r <= hi; r++) out.push(RANK_CHARS[r] + RANK_CHARS[r])
    return out
  }

  if ((m = spec.match(new RegExp(`^(${R})(${R})([so])$`)))) {
    if (rankVal(m[1]) <= rankVal(m[2])) throw new Error(`非法手牌: ${spec}`)
    return [spec]
  }

  if ((m = spec.match(new RegExp(`^(${R})(${R})([so])\\+$`)))) {
    const hi = rankVal(m[1])
    const lo = rankVal(m[2])
    if (hi <= lo) throw new Error(`非法记法: ${spec}`)
    const out: string[] = []
    for (let r = lo; r < hi; r++) out.push(RANK_CHARS[hi] + RANK_CHARS[r] + m[3])
    return out
  }

  if ((m = spec.match(new RegExp(`^(${R})(${R})([so])-(${R})(${R})([so])$`)))) {
    if (m[3] !== m[6]) throw new Error(`非法记法: ${spec}`)
    const h1 = rankVal(m[1])
    const l1 = rankVal(m[2])
    const h2 = rankVal(m[4])
    const l2 = rankVal(m[5])
    const out: string[] = []
    if (h1 === h2) {
      // 同高牌的低牌区间，如 QTs-Q8s
      const top = Math.max(l1, l2)
      const bot = Math.min(l1, l2)
      for (let r = bot; r <= top; r++) out.push(RANK_CHARS[h1] + RANK_CHARS[r] + m[3])
      return out
    }
    // 同间距段，如 T9s-54s
    if (h1 - l1 !== h2 - l2) throw new Error(`非法记法（间距不同）: ${spec}`)
    const gap = h1 - l1
    const top = Math.max(h1, h2)
    const bot = Math.min(h1, h2)
    for (let h = bot; h <= top; h++) out.push(RANK_CHARS[h] + RANK_CHARS[h - gap] + m[3])
    return out
  }

  throw new Error(`无法解析: ${spec}`)
}

export function parseRange(src: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const raw of src.split(',')) {
    const tok = raw.trim()
    if (!tok) continue
    let freq = 1
    let spec = tok
    const ci = tok.indexOf(':')
    if (ci >= 0) {
      spec = tok.slice(0, ci).trim()
      freq = parseFloat(tok.slice(ci + 1))
      if (!(freq > 0 && freq <= 1)) throw new Error(`非法频率: ${tok}`)
    }
    for (const h of expandSpec(spec)) out.set(h, freq)
  }
  return out
}
