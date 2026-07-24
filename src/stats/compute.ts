import type { DecisionRecord, HandRecord } from '../game/session'
import type { Position } from '../poker/ranges'

// 玩家画像统计。所有「GTO 基线」都在与玩家完全相同的决策样本上，
// 用 solver 在该节点的动作频率累计得出（避免样本偏差）。

export interface Ratio {
  n: number // 机会数
  user: number // 玩家频率（0-1）
  gto: number // GTO 基线频率
}

export interface PositionRow {
  pos: Position
  hands: number
  vpip: number
  pfr: number
  evLoss: number // 平均每决策
  decisions: number
}

export interface ProfileStats {
  hands: number
  settledHands: number
  netBB: number
  decisions: number
  optimalRate: number
  totalEvLoss: number
  evLossPerHand: number
  vpip: Ratio
  pfr: Ratio
  threeBet: Ratio
  foldTo3Bet: Ratio
  cbet: Ratio
  bbDefendFold: Ratio // BB 面对单次开局加注的弃牌率
  btnSteal: Ratio // BTN 首入加注率
  riverCallVsBet: Ratio // 河牌面对下注的跟注率
  wtsd: Ratio // 看翻牌后到摊牌
  wsd: Ratio // 摊牌胜率（gto 无基线，gto 填 0.5 仅供参照）
  byPosition: PositionRow[]
  byStreetEvLoss: { street: string; evLoss: number; decisions: number }[]
}

function emptyRatio(): Ratio {
  return { n: 0, user: 0, gto: 0 }
}

function addRatio(r: Ratio, userTook: boolean, gtoFreq: number) {
  r.n++
  r.user += userTook ? 1 : 0
  r.gto += gtoFreq
}

function finishRatio(r: Ratio): Ratio {
  if (r.n === 0) return r
  return { n: r.n, user: r.user / r.n, gto: r.gto / r.n }
}

function sumFreq(d: DecisionRecord, pred: (kind: string) => boolean): number {
  let s = 0
  for (let i = 0; i < d.kinds.length; i++) if (pred(d.kinds[i])) s += d.freqs[i]
  return s
}

export function computeStats(records: HandRecord[]): ProfileStats {
  const vpip = emptyRatio()
  const pfr = emptyRatio()
  const threeBet = emptyRatio()
  const foldTo3Bet = emptyRatio()
  const cbet = emptyRatio()
  const bbDefendFold = emptyRatio()
  const btnSteal = emptyRatio()
  const riverCallVsBet = emptyRatio()
  const wtsd = emptyRatio()
  const wsd = emptyRatio()
  let netBB = 0
  let settledHands = 0
  let decisions = 0
  let optimal = 0
  let totalEvLoss = 0
  const posMap = new Map<Position, PositionRow>()
  const streetMap = new Map<string, { evLoss: number; decisions: number }>()

  for (const r of records) {
    if (r.result.deltaBB !== null) {
      netBB += r.result.deltaBB
      settledHands++
    }
    const posRow = posMap.get(r.heroPos) ?? {
      pos: r.heroPos,
      hands: 0,
      vpip: 0,
      pfr: 0,
      evLoss: 0,
      decisions: 0,
    }
    posRow.hands++

    // 重放动作history，为每个英雄决策标注上下文
    let raisesBefore = 0
    let heroDecisionIdx = 0
    let heroVoluntary = false
    let heroRaisedPre = false
    let heroWasLastPreflopAggressor = false
    let lastAggressorSeat = -1
    let heroFirstDecision: DecisionRecord | null = null
    let heroFirstDecisionRaises = 0
    let flopCheckedToHero = true

    for (const a of r.actions) {
      const isHero = a.seat === r.heroSeat
      if (a.street === 'preflop') {
        if (isHero && heroDecisionIdx < r.decisions.length) {
          const d = r.decisions[heroDecisionIdx]
          if (d.street === 'preflop') {
            heroDecisionIdx++
            if (!heroFirstDecision) {
              heroFirstDecision = d
              heroFirstDecisionRaises = raisesBefore
            }
            // 3bet 机会：面对恰好一次加注
            if (raisesBefore === 1) {
              addRatio(
                threeBet,
                a.kind === 'raise',
                sumFreq(d, (k) => k === 'raise'),
              )
              if (r.heroPos === 'BB') {
                addRatio(bbDefendFold, a.kind === 'fold', sumFreq(d, (k) => k === 'fold'))
              }
            }
            // 怕 3bet：自己开局后面对 3bet
            if (raisesBefore === 2 && heroRaisedPre) {
              addRatio(foldTo3Bet, a.kind === 'fold', sumFreq(d, (k) => k === 'fold'))
            }
            // BTN 偷盲：首入
            if (raisesBefore === 0 && r.heroPos === 'BTN') {
              addRatio(btnSteal, a.kind === 'raise', sumFreq(d, (k) => k === 'raise'))
            }
          }
          if (a.kind === 'call' || a.kind === 'raise') heroVoluntary = true
          if (a.kind === 'raise') heroRaisedPre = true
        }
        if (a.kind === 'raise') {
          raisesBefore++
          lastAggressorSeat = a.seat
        }
      } else if (a.street === 'flop') {
        if (isHero && heroDecisionIdx < r.decisions.length) {
          const d = r.decisions[heroDecisionIdx]
          if (d.street === 'flop') {
            heroDecisionIdx++
            // c-bet 机会：英雄是翻前最后加注者，面前无人下注
            // （回放到翻牌时翻前动作已全部处理，lastAggressorSeat 已定）
            if (lastAggressorSeat === r.heroSeat && flopCheckedToHero && d.kinds.includes('bet')) {
              addRatio(cbet, a.kind === 'bet', sumFreq(d, (k) => k === 'bet'))
            }
          }
        }
        if (a.kind === 'bet' || a.kind === 'raise') flopCheckedToHero = false
      } else if (a.street === 'river') {
        if (isHero && heroDecisionIdx < r.decisions.length) {
          const d = r.decisions[heroDecisionIdx]
          if (d.street === 'river') {
            heroDecisionIdx++
            // 河牌面对下注
            if (d.kinds.includes('call') && d.kinds.includes('fold')) {
              addRatio(riverCallVsBet, a.kind === 'call', sumFreq(d, (k) => k === 'call'))
            }
          }
        }
      } else {
        if (isHero && heroDecisionIdx < r.decisions.length) {
          if (r.decisions[heroDecisionIdx].street === a.street) heroDecisionIdx++
        }
      }
      if (a.street === 'preflop') continue
    }
    void heroWasLastPreflopAggressor

    // VPIP / PFR（每手一次机会；GTO 基线取首个翻前决策的自愿频率）
    if (heroFirstDecision) {
      const d = heroFirstDecision
      const volFreq = sumFreq(d, (k) => k === 'call' || k === 'raise')
      // 首决策若已面对加注，自愿频率即该点参与频率；首入时同理
      void heroFirstDecisionRaises
      addRatio(vpip, heroVoluntary, volFreq)
      addRatio(pfr, heroRaisedPre, sumFreq(d, (k) => k === 'raise'))
    }

    // WTSD / W$SD
    const sawFlop = r.board.length >= 3 && !r.result.multiwayCutoff
    if (sawFlop && heroVoluntaryOrBB(r)) {
      addRatio(wtsd, r.result.wentToShowdown, 0)
      if (r.result.wentToShowdown) {
        addRatio(wsd, (r.result.deltaBB ?? 0) > 0, 0.5)
      }
    }

    // 决策与 EV
    for (const d of r.decisions) {
      decisions++
      posRow.decisions++
      if (d.verdict === 'optimal') optimal++
      totalEvLoss += d.evLoss
      posRow.evLoss += d.evLoss
      const sm = streetMap.get(d.street) ?? { evLoss: 0, decisions: 0 }
      sm.evLoss += d.evLoss
      sm.decisions++
      streetMap.set(d.street, sm)
    }
    if (heroVoluntary) posRow.vpip++
    if (heroRaisedPre) posRow.pfr++
    posMap.set(r.heroPos, posRow)
  }

  const byPosition = [...posMap.values()]
    .map((row) => ({
      ...row,
      vpip: row.hands ? row.vpip / row.hands : 0,
      pfr: row.hands ? row.pfr / row.hands : 0,
      evLoss: row.decisions ? row.evLoss / row.decisions : 0,
    }))
    .sort((a, b) => b.hands - a.hands)

  return {
    hands: records.length,
    settledHands,
    netBB,
    decisions,
    optimalRate: decisions ? optimal / decisions : 0,
    totalEvLoss,
    evLossPerHand: records.length ? totalEvLoss / records.length : 0,
    vpip: finishRatio(vpip),
    pfr: finishRatio(pfr),
    threeBet: finishRatio(threeBet),
    foldTo3Bet: finishRatio(foldTo3Bet),
    cbet: finishRatio(cbet),
    bbDefendFold: finishRatio(bbDefendFold),
    btnSteal: finishRatio(btnSteal),
    riverCallVsBet: finishRatio(riverCallVsBet),
    wtsd: finishRatio(wtsd),
    wsd: finishRatio(wsd),
    byPosition,
    byStreetEvLoss: [...streetMap.entries()].map(([street, v]) => ({
      street,
      evLoss: v.decisions ? v.evLoss / v.decisions : 0,
      decisions: v.decisions,
    })),
  }
}

function heroVoluntaryOrBB(r: HandRecord): boolean {
  return r.decisions.length > 0
}
