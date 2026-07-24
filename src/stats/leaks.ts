import type { ProfileStats, Ratio } from './compute'

// 弱点检测器：对比玩家频率与同样本 GTO 基线，输出中文建议。
// severity 用「偏差 × 机会数」近似可归因损失排序。

export interface Leak {
  id: string
  title: string
  severity: number
  user: number
  gto: number
  n: number
  advice: string
}

const MIN_HANDS = 30
const MIN_OPP = 10

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`
}

interface Detector {
  id: string
  title: string
  minOpp: number
  eval(s: ProfileStats): { ratio: Ratio; diff: number; advice: string } | null
}

const detectors: Detector[] = [
  {
    id: 'too-loose',
    title: '翻前入池过松',
    minOpp: MIN_HANDS,
    eval(s) {
      const d = s.vpip.user - s.vpip.gto
      if (d <= 0.05) return null
      return {
        ratio: s.vpip,
        diff: d,
        advice: `你的入池率 ${pct(s.vpip.user)}，同样场景下均衡约 ${pct(s.vpip.gto)}。收紧边缘牌（弱 Ax 非同花、低沟通牌），尤其在前位。`,
      }
    },
  },
  {
    id: 'too-tight',
    title: '翻前入池过紧',
    minOpp: MIN_HANDS,
    eval(s) {
      const d = s.vpip.gto - s.vpip.user
      if (d <= 0.05) return null
      return {
        ratio: s.vpip,
        diff: d,
        advice: `你的入池率 ${pct(s.vpip.user)}，均衡约 ${pct(s.vpip.gto)}。错失有利可图的开局与防守，特别注意按钮位与大盲的宽范围。`,
      }
    },
  },
  {
    id: 'low-3bet',
    title: '3-bet 频率不足',
    minOpp: MIN_OPP,
    eval(s) {
      const d = s.threeBet.gto - s.threeBet.user
      if (d <= 0.03) return null
      return {
        ratio: s.threeBet,
        diff: d,
        advice: `面对开局加注你 3-bet ${pct(s.threeBet.user)}（均衡 ${pct(s.threeBet.gto)}）。增加价值 3-bet（TT+/AQ+）与阻断牌诈唬（A5s-A2s 类）。`,
      }
    },
  },
  {
    id: 'over-3bet',
    title: '3-bet 频率过高',
    minOpp: MIN_OPP,
    eval(s) {
      const d = s.threeBet.user - s.threeBet.gto
      if (d <= 0.04) return null
      return {
        ratio: s.threeBet,
        diff: d,
        advice: `你 3-bet ${pct(s.threeBet.user)}（均衡 ${pct(s.threeBet.gto)}），范围过宽会被 4-bet 与紧跟注惩罚。剔除无阻断的投机牌。`,
      }
    },
  },
  {
    id: 'fold-to-3bet',
    title: '面对 3-bet 过度弃牌',
    minOpp: MIN_OPP,
    eval(s) {
      const d = s.foldTo3Bet.user - s.foldTo3Bet.gto
      if (d <= 0.08) return null
      return {
        ratio: s.foldTo3Bet,
        diff: d,
        advice: `开局后面对 3-bet 你弃牌 ${pct(s.foldTo3Bet.user)}（均衡 ${pct(s.foldTo3Bet.gto)}），容易被高频 3-bet 剥削。用同花连子与中对增加防守跟注。`,
      }
    },
  },
  {
    id: 'btn-steal',
    title: '按钮位偷盲不足',
    minOpp: MIN_OPP,
    eval(s) {
      const d = s.btnSteal.gto - s.btnSteal.user
      if (d <= 0.06) return null
      return {
        ratio: s.btnSteal,
        diff: d,
        advice: `按钮位首入你只开 ${pct(s.btnSteal.user)}（均衡 ${pct(s.btnSteal.gto)}）。位置优势下几乎一半的牌都值得开局。`,
      }
    },
  },
  {
    id: 'bb-overfold',
    title: '大盲防守不足',
    minOpp: MIN_OPP,
    eval(s) {
      const d = s.bbDefendFold.user - s.bbDefendFold.gto
      if (d <= 0.07) return null
      return {
        ratio: s.bbDefendFold,
        diff: d,
        advice: `大盲面对开局你弃牌 ${pct(s.bbDefendFold.user)}（均衡 ${pct(s.bbDefendFold.gto)}）。已投入盲注、赔率优厚，同花与沟通牌都应防守。`,
      }
    },
  },
  {
    id: 'cbet-off',
    title: 'C-bet 频率失衡',
    minOpp: MIN_OPP,
    eval(s) {
      const d = Math.abs(s.cbet.user - s.cbet.gto)
      if (d <= 0.1) return null
      const dir = s.cbet.user > s.cbet.gto ? '过高' : '不足'
      return {
        ratio: s.cbet,
        diff: d,
        advice: `作为翻前进攻方你的持续下注率 ${pct(s.cbet.user)}（均衡 ${pct(s.cbet.gto)}），${dir}。按牌面结构区分：干燥面高频小注，湿润面收窄加大。`,
      }
    },
  },
  {
    id: 'river-call',
    title: '河牌跟注失衡',
    minOpp: MIN_OPP,
    eval(s) {
      const d = Math.abs(s.riverCallVsBet.user - s.riverCallVsBet.gto)
      if (d <= 0.1) return null
      const over = s.riverCallVsBet.user > s.riverCallVsBet.gto
      return {
        ratio: s.riverCallVsBet,
        diff: d,
        advice: over
          ? `河牌面对下注你跟注 ${pct(s.riverCallVsBet.user)}（均衡 ${pct(s.riverCallVsBet.gto)}）。剔除阻断对方诈唬的弱抓诈牌。`
          : `河牌面对下注你只跟 ${pct(s.riverCallVsBet.user)}（均衡 ${pct(s.riverCallVsBet.gto)}），弃牌过多会被诈唬剥削。按最小防守频率补足抓诈。`,
      }
    },
  },
]

export function detectLeaks(s: ProfileStats): Leak[] {
  if (s.hands < MIN_HANDS) return []
  const out: Leak[] = []
  for (const det of detectors) {
    const res = det.eval(s)
    if (!res) continue
    if (res.ratio.n < det.minOpp) continue
    out.push({
      id: det.id,
      title: det.title,
      severity: res.diff * res.ratio.n,
      user: res.ratio.user,
      gto: res.ratio.gto,
      n: res.ratio.n,
      advice: res.advice,
    })
  }
  // 位置泄漏
  const withEnough = s.byPosition.filter((p) => p.decisions >= MIN_OPP)
  if (withEnough.length >= 2) {
    const avg = s.decisions ? s.totalEvLoss / s.decisions : 0
    for (const p of withEnough) {
      if (avg > 0 && p.evLoss > 2 * avg && p.evLoss > 0.15) {
        out.push({
          id: `pos-${p.pos}`,
          title: `${p.pos} 位置决策质量偏低`,
          severity: (p.evLoss - avg) * p.decisions,
          user: p.evLoss,
          gto: avg,
          n: p.decisions,
          advice: `你在 ${p.pos} 的平均每决策 EV 损失 ${p.evLoss.toFixed(2)}bb，是整体均值（${avg.toFixed(2)}bb）的两倍以上。重点复习该位置的范围表。`,
        })
      }
    }
  }
  out.sort((a, b) => b.severity - a.severity)
  return out.slice(0, 5)
}
