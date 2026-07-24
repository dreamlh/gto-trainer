import { parseRange } from './rangeParser'

// 6-max 现金桌 100bb 近似 GTO 翻前频率（参考主流 solver 输出的简化）
// 开局加注 2.5bb（SB 3bb）；3-bet：IP 约 7.5bb / OOP 约 10-11bb

export type Position = 'UTG' | 'UTG1' | 'UTG2' | 'LJ' | 'HJ' | 'CO' | 'BTN' | 'SB' | 'BB'
export type ActionKey = 'raise' | 'threebet' | 'fourbet' | 'fivebet' | 'call' | 'fold'

export interface SpotAction {
  key: Exclude<ActionKey, 'fold'>
  label: string
}

export interface Spot {
  id: string
  category: 'rfi' | 'vs-rfi' | 'vs-3bet' | 'vs-4bet'
  hero: Position
  villain?: Position
  title: string
  situation: string
  actions: SpotAction[]
  // 手牌 -> 各动作频率（不含弃牌；弃牌 = 1 - 其余之和）
  strategy: Map<string, Record<string, number>>
}

export const ACTION_COLORS: Record<string, string> = {
  raise: '#e2574a',
  threebet: '#e2574a',
  fourbet: '#e2574a',
  fivebet: '#e2574a',
  call: '#1fa78e',
  fold: '#5c7cba',
}

export const ACTION_LABELS: Record<string, string> = {
  raise: '加注',
  threebet: '3-bet',
  fourbet: '4-bet',
  fivebet: '全下',
  call: '跟注',
  fold: '弃牌',
}

interface SpotDef {
  id: string
  category: Spot['category']
  hero: Position
  villain?: Position
  title: string
  situation: string
  // 按声明顺序解析；每手牌可用频率 = 1 - 已分配之和，实际取 min(请求值, 可用值)
  ranges: [Exclude<ActionKey, 'fold'>, string][]
}

function buildSpot(def: SpotDef): Spot {
  const strategy = new Map<string, Record<string, number>>()
  for (const [key, src] of def.ranges) {
    if (!src.trim()) continue
    const parsed = parseRange(src)
    for (const [hand, freq] of parsed) {
      const entry = strategy.get(hand) ?? {}
      const assigned = Object.values(entry).reduce((a, b) => a + b, 0)
      const grant = Math.min(freq, Math.max(0, 1 - assigned))
      if (grant > 0.001) {
        entry[key] = (entry[key] ?? 0) + grant
        strategy.set(hand, entry)
      }
    }
  }
  return {
    id: def.id,
    category: def.category,
    hero: def.hero,
    villain: def.villain,
    title: def.title,
    situation: def.situation,
    actions: def.ranges.map(([key]) => ({ key, label: ACTION_LABELS[key] })),
    strategy,
  }
}

const defs: SpotDef[] = [
  // ============ RFI（首入加注）============
  {
    id: 'rfi-utg',
    category: 'rfi',
    hero: 'UTG',
    title: 'UTG 首入（RFI）',
    situation: '你在 UTG（枪口位），轮到你第一个行动。加注 2.5bb 或弃牌？',
    ranges: [
      [
        'raise',
        '66+, A6s+, A5s, A4s, K9s:0.8, KTs+, QTs+, JTs, T9s, AJo+, KQo, 55:0.8, 44:0.55, 33:0.35, 22:0.35, A7s:0.8, A6s:0.6, A3s:0.6, A2s:0.35, Q9s:0.5, J9s:0.5, 98s:0.6, 87s:0.5, 76s:0.4, 65s:0.4, 54s:0.35, ATo:0.7, KJo:0.5, QJo:0.3',
      ],
    ],
  },
  {
    id: 'rfi-hj',
    category: 'rfi',
    hero: 'HJ',
    title: 'HJ 首入（RFI）',
    situation: 'UTG 弃牌，你在 HJ（劫机位）。加注 2.5bb 或弃牌？',
    ranges: [
      [
        'raise',
        '66+, A8s+, A5s-A2s, K9s+, Q9s+, J9s+, T9s, 98s, AJo+, KQo, 55:0.8, 44:0.55, 33:0.4, 22:0.4, A7s:0.8, A6s:0.7, K8s:0.4, Q8s:0.25, J8s:0.2, T8s:0.35, 87s:0.65, 76s:0.55, 65s:0.5, 54s:0.4, ATo:0.9, A9o:0.15, KJo:0.85, KTo:0.3, QJo:0.55, QTo:0.2, JTo:0.35',
      ],
    ],
  },
  {
    id: 'rfi-co',
    category: 'rfi',
    hero: 'CO',
    title: 'CO 首入（RFI）',
    situation: '前面全部弃牌，你在 CO（关煞位）。加注 2.5bb 或弃牌？',
    ranges: [
      [
        'raise',
        '22+, A2s+, K8s+, Q9s+, J9s+, T8s+, 97s+, 87s, 76s, 65s, ATo+, KJo+, QJo, K7s:0.6, K6s:0.5, K5s:0.5, Q8s:0.6, J8s:0.6, 86s:0.5, 75s:0.45, 64s:0.3, 54s:0.75, 53s:0.2, A9o:0.5, A8o:0.25, A5o:0.2, KTo:0.75, QTo:0.6, JTo:0.7, T9o:0.25, 98o:0.1',
      ],
    ],
  },
  {
    id: 'rfi-btn',
    category: 'rfi',
    hero: 'BTN',
    title: 'BTN 首入（RFI）',
    situation: '前面全部弃牌，你在按钮位。加注 2.5bb 或弃牌？',
    ranges: [
      [
        'raise',
        '22+, A2s+, K2s+, Q4s+, J6s+, T6s+, 96s+, 86s+, 75s+, 64s+, 54s, 53s, A2o+, K9o+, Q9o+, J9o+, T9o, Q3s:0.6, J5s:0.6, J4s:0.4, T5s:0.4, 95s:0.4, 85s:0.4, 74s:0.4, 63s:0.3, 43s:0.5, K8o:0.7, K7o:0.5, K6o:0.3, K5o:0.2, Q8o:0.5, J8o:0.6, T8o:0.6, 98o:0.6, 97o:0.3, 87o:0.4, 76o:0.25, 65o:0.15',
      ],
    ],
  },
  {
    id: 'rfi-sb',
    category: 'rfi',
    hero: 'SB',
    title: 'SB 首入（RFI）',
    situation: '前面全部弃牌，你在小盲位（采用加注或弃牌策略）。加注 3bb 或弃牌？',
    ranges: [
      [
        'raise',
        '22+, A2s+, K2s+, Q2s+, J4s+, T6s+, 96s+, 85s+, 75s+, 64s+, 54s, A2o+, K8o+, Q9o+, J9o+, T9o, J3s:0.5, T5s:0.5, T4s:0.3, 95s:0.5, 84s:0.3, 74s:0.4, 63s:0.35, 53s:0.5, 43s:0.4, K7o:0.6, K6o:0.4, K5o:0.3, Q8o:0.5, J8o:0.5, T8o:0.5, 98o:0.5, 97o:0.2, 87o:0.3, 76o:0.2',
      ],
    ],
  },

  // ============ 面对首入加注（防守）============
  {
    id: 'bb-vs-btn',
    category: 'vs-rfi',
    hero: 'BB',
    villain: 'BTN',
    title: 'BB 防守 vs BTN 开局',
    situation: 'BTN 加注至 2.5bb，SB 弃牌，轮到你在大盲位。',
    ranges: [
      [
        'threebet',
        'JJ+, AKo, AQs+, AJs:0.6, ATs:0.35, A5s:0.6, A4s:0.6, A3s:0.4, A2s:0.3, KQs:0.5, KJs:0.4, KTs:0.3, K9s:0.2, QJs:0.3, QTs:0.25, Q9s:0.15, JTs:0.3, J9s:0.15, T9s:0.3, T8s:0.15, 98s:0.3, 87s:0.3, 76s:0.3, 65s:0.35, 54s:0.35, 43s:0.15, TT:0.6, 99:0.35, 88:0.25, 77:0.15, AQo:0.65, AJo:0.45, ATo:0.2, A9o:0.15, A5o:0.15, KQo:0.45, KJo:0.2, KTo:0.1, QJo:0.15, JTo:0.1',
      ],
      [
        'call',
        '22+, A2s+, K2s+, Q2s+, J4s+, T6s+, 96s+, 86s+, 75s+, 64s+, 54s, 43s, J2s:0.5, J3s:0.5, T4s:0.5, T5s:0.5, 95s:0.5, 85s:0.5, 74s:0.5, 63s:0.5, 53s:0.6, 42s:0.3, 32s:0.2, A2o+, K9o+, K8o:0.7, K7o:0.5, K6o:0.4, K5o:0.3, Q9o+, Q8o:0.5, J9o+, J8o:0.5, T9o, T8o:0.6, 98o:0.7, 97o:0.4, 87o:0.5, 76o:0.4, 65o:0.3, 54o:0.2',
      ],
    ],
  },
  {
    id: 'bb-vs-co',
    category: 'vs-rfi',
    hero: 'BB',
    villain: 'CO',
    title: 'BB 防守 vs CO 开局',
    situation: 'CO 加注至 2.5bb，BTN 和 SB 弃牌，轮到你在大盲位。',
    ranges: [
      [
        'threebet',
        'JJ+, AKo, AQs+, TT:0.5, 99:0.25, 88:0.15, AJs:0.5, ATs:0.3, A5s:0.5, A4s:0.5, A3s:0.3, A2s:0.2, KQs:0.4, KJs:0.3, KTs:0.2, QJs:0.25, QTs:0.15, JTs:0.25, T9s:0.25, 98s:0.25, 87s:0.25, 76s:0.25, 65s:0.3, 54s:0.3, AQo:0.4, AJo:0.3, ATo:0.15, KQo:0.3',
      ],
      [
        'call',
        '22+, A2s+, K4s+, Q6s+, J7s+, T7s+, 96s+, 86s+, 75s+, 64s+, 54s, K3s:0.6, K2s:0.6, Q5s:0.5, Q4s:0.5, J6s:0.5, J5s:0.4, T6s:0.5, 95s:0.4, 85s:0.4, 74s:0.4, 63s:0.3, 53s:0.5, 43s:0.5, ATo+, A9o:0.5, A8o:0.4, A7o:0.3, A6o:0.25, A5o:0.5, A4o:0.35, A3o:0.3, A2o:0.2, KTo+, K9o:0.5, QTo+, Q9o:0.4, JTo, J9o:0.4, T9o:0.7, T8o:0.3, 98o:0.4, 87o:0.3, 76o:0.25, 65o:0.2',
      ],
    ],
  },
  {
    id: 'bb-vs-utg',
    category: 'vs-rfi',
    hero: 'BB',
    villain: 'UTG',
    title: 'BB 防守 vs UTG 开局',
    situation: 'UTG 加注至 2.5bb，其余全部弃牌，轮到你在大盲位。',
    ranges: [
      [
        'threebet',
        'QQ+, AKs, AKo:0.8, AQs:0.5, AJs:0.25, A5s:0.5, A4s:0.4, A3s:0.2, KQs:0.25, KJs:0.15, QJs:0.1, JTs:0.15, T9s:0.15, 76s:0.2, 65s:0.25, 54s:0.25, JJ:0.5, TT:0.25, 99:0.1, AQo:0.15',
      ],
      [
        'call',
        '22+, A2s+, K5s+, Q8s+, J8s+, T7s+, 97s+, 86s+, 75s+, 65s, 64s:0.5, 54s, 53s:0.4, 43s:0.3, K4s:0.5, K3s:0.4, K2s:0.3, Q7s:0.4, Q6s:0.4, J7s:0.4, T6s:0.4, 96s:0.4, 85s:0.4, AQo, AJo:0.8, ATo:0.5, A9o:0.2, A5o:0.2, KQo:0.7, KJo:0.4, KTo:0.2, QJo:0.4, QTo:0.15, JTo:0.5, T9o:0.25, 98o:0.15',
      ],
    ],
  },
  {
    id: 'bb-vs-sb',
    category: 'vs-rfi',
    hero: 'BB',
    villain: 'SB',
    title: 'BB 防守 vs SB 开局',
    situation: '前面全部弃牌，SB 加注至 3bb，轮到你在大盲位。',
    ranges: [
      [
        'threebet',
        '99+, ATs+, KTs+, QTs+, JTs, A5s:0.5, A4s:0.5, A9s:0.5, K9s:0.4, Q9s:0.3, J9s:0.35, T9s:0.4, 98s:0.35, 87s:0.35, 76s:0.35, 65s:0.35, 54s:0.3, 88:0.6, 77:0.4, 66:0.25, 55:0.2, AJo+, ATo:0.4, A5o:0.2, KQo:0.5, KJo:0.3, QJo:0.25',
      ],
      [
        'call',
        '22+, A2s+, K2s+, Q2s+, J2s+, T3s+, 95s+, 84s+, 74s+, 63s+, 53s+, 43s, T2s:0.5, 94s:0.5, 83s:0.5, 73s:0.5, 62s:0.4, 52s:0.5, 42s:0.4, 32s:0.3, A2o+, K5o+, K4o:0.5, K3o:0.4, K2o:0.3, Q7o+, Q6o:0.5, Q5o:0.4, Q4o:0.3, J7o+, J6o:0.3, T7o+, T6o:0.3, 97o+, 96o:0.3, 87o, 86o:0.5, 76o:0.8, 75o:0.4, 65o:0.6, 64o:0.25, 54o:0.4',
      ],
    ],
  },
  {
    id: 'sb-vs-btn',
    category: 'vs-rfi',
    hero: 'SB',
    villain: 'BTN',
    title: 'SB 防守 vs BTN 开局',
    situation: 'BTN 加注至 2.5bb，轮到你在小盲位（SB 采用 3-bet 或弃牌的常见简化策略，不平跟）。',
    ranges: [
      [
        'threebet',
        '77+, A7s+, A5s-A2s, K9s+, Q9s+, J9s+, T8s+, 98s, AJo+, ATo:0.7, 66:0.7, 55:0.5, 44:0.3, 33:0.2, 22:0.2, A6s:0.7, K8s:0.5, Q8s:0.3, 97s:0.3, 87s:0.7, 86s:0.3, 76s:0.6, 75s:0.25, 65s:0.6, 54s:0.5, KQo:0.8, KJo:0.4, QJo:0.3, JTo:0.2, A9o:0.4, A8o:0.2',
      ],
      ['call', ''],
    ],
  },
  {
    id: 'btn-vs-co',
    category: 'vs-rfi',
    hero: 'BTN',
    villain: 'CO',
    title: 'BTN 防守 vs CO 开局',
    situation: 'CO 加注至 2.5bb，轮到你在按钮位。',
    ranges: [
      [
        'threebet',
        'TT+, AKo, AJs+, A5s:0.5, A4s:0.4, ATs:0.4, KQs:0.6, KJs:0.35, KTs:0.2, QJs:0.3, QTs:0.2, JTs:0.3, T9s:0.25, 98s:0.2, 87s:0.2, 76s:0.2, 65s:0.25, 54s:0.25, 99:0.5, 88:0.3, 77:0.2, AQo:0.6, AJo:0.3, KQo:0.35, A5o:0.15',
      ],
      [
        'call',
        '22+, ATs, AJs, A9s:0.6, A8s:0.5, A5s, A4s, A3s:0.4, A2s:0.3, KQs, KJs, KTs, K9s:0.4, QJs, QTs, Q9s:0.3, JTs, J9s:0.3, T9s, T8s:0.4, 98s, 97s:0.3, 87s, 86s:0.3, 76s, 75s:0.3, 65s, 64s:0.2, 54s, AQo, AJo:0.5, ATo:0.3, KQo:0.5, KJo:0.25, QJo:0.25, JTo:0.2',
      ],
    ],
  },

  // ============ 面对 3-bet ============
  {
    id: 'btn-vs-sb-3bet',
    category: 'vs-3bet',
    hero: 'BTN',
    villain: 'SB',
    title: 'BTN 应对 SB 3-bet',
    situation: '你在 BTN 加注 2.5bb，SB 3-bet 至 10bb，BB 弃牌，轮到你。',
    ranges: [
      [
        'fourbet',
        'KK+, AKs, QQ:0.65, JJ:0.25, TT:0.1, AKo:0.55, A5s:0.4, A4s:0.25, AQs:0.15, KQs:0.1, A5o:0.1',
      ],
      [
        'call',
        'QQ, JJ, TT, 99, 88:0.75, 77:0.5, 66:0.35, 55:0.25, 44:0.15, 33:0.1, 22:0.1, AQs+, AJs, ATs:0.8, A9s:0.3, A8s:0.3, A5s, A4s, A3s:0.4, A2s:0.25, KQs, KJs:0.8, KTs:0.55, K9s:0.2, QJs:0.7, QTs:0.45, JTs:0.7, J9s:0.2, T9s:0.55, 98s:0.45, 87s:0.4, 76s:0.35, 65s:0.3, 54s:0.3, AKo, AQo:0.55, AJo:0.2, KQo:0.25',
      ],
    ],
  },
  {
    id: 'co-vs-btn-3bet',
    category: 'vs-3bet',
    hero: 'CO',
    villain: 'BTN',
    title: 'CO 应对 BTN 3-bet',
    situation: '你在 CO 加注 2.5bb，BTN 3-bet 至 7.5bb，盲注弃牌，轮到你。',
    ranges: [
      [
        'fourbet',
        'KK+, AKs, QQ:0.5, JJ:0.15, AKo:0.5, A5s:0.3, AQs:0.1',
      ],
      [
        'call',
        'QQ, JJ, TT, 99:0.7, 88:0.5, 77:0.35, 66:0.2, 55:0.15, AQs+, AJs, ATs:0.6, A9s:0.2, A5s, A4s:0.5, KQs, KJs:0.6, KTs:0.35, QJs:0.55, QTs:0.3, JTs:0.55, T9s:0.45, 98s:0.35, 87s:0.3, 76s:0.25, 65s:0.2, AKo, AQo:0.5, AJo:0.15, KQo:0.2',
      ],
    ],
  },
  {
    id: 'utg-vs-bb-3bet',
    category: 'vs-3bet',
    hero: 'UTG',
    villain: 'BB',
    title: 'UTG 应对 BB 3-bet',
    situation: '你在 UTG 加注 2.5bb，其余弃牌，BB 3-bet 至 11bb，轮到你。',
    ranges: [
      [
        'fourbet',
        'KK+, AKs, QQ:0.4, AKo:0.45, A5s:0.25, AQs:0.1',
      ],
      [
        'call',
        'QQ, JJ, TT:0.8, 99:0.5, 88:0.35, 77:0.2, 66:0.1, AQs+, AJs:0.6, ATs:0.35, A5s:0.5, A4s:0.3, KQs:0.7, KJs:0.4, KTs:0.2, QJs:0.35, QTs:0.15, JTs:0.4, T9s:0.35, 98s:0.25, 87s:0.2, 76s:0.15, AKo, AQo:0.4, AJo:0.1, KQo:0.1',
      ],
    ],
  },
]

export const SPOTS: Spot[] = defs.map(buildSpot)

export const CATEGORY_LABELS: Record<Spot['category'], string> = {
  rfi: '首入加注 (RFI)',
  'vs-rfi': '面对开局加注',
  'vs-3bet': '面对 3-bet',
  'vs-4bet': '面对 4-bet',
}

export function getSpot(id: string): Spot {
  const s = SPOTS.find((x) => x.id === id)
  if (!s) throw new Error(`未知场景: ${id}`)
  return s
}

// 一手牌在某场景下的完整频率（含弃牌）
export function handFreqs(spot: Spot, hand: string): { key: string; freq: number }[] {
  const entry = spot.strategy.get(hand) ?? {}
  const out: { key: string; freq: number }[] = []
  let sum = 0
  for (const a of spot.actions) {
    const f = entry[a.key] ?? 0
    if (f > 0.001) out.push({ key: a.key, freq: f })
    sum += f
  }
  if (1 - sum > 0.001) out.push({ key: 'fold', freq: 1 - sum })
  return out
}
