// 统计与弱点检测测试：npx tsx scripts/test-stats.ts
import type { HandRecord } from '../src/game/session'
import { computeStats } from '../src/stats/compute'
import { detectLeaks } from '../src/stats/leaks'

let failed = 0
function check(name: string, cond: boolean, detail = '') {
  if (!cond) {
    failed++
    console.error(`✗ ${name} ${detail}`)
  } else {
    console.log(`✓ ${name}`)
  }
}

// 合成：BB 面对 BTN 开局（GTO：弃 40% 跟 45% 3bet 15%）
function bbDefendHand(i: number, chosen: number): HandRecord {
  return {
    id: `h${i}`,
    ts: 1700000000000 + i * 60000,
    tableSize: 6,
    heroSeat: 5,
    heroPos: 'BB',
    heroCards: [0, 5],
    board: [],
    actions: [
      { street: 'preflop', seat: 3, pos: 'BTN', kind: 'raise', to: 2.5 },
      { street: 'preflop', seat: 5, pos: 'BB', kind: ['fold', 'call', 'raise'][chosen], to: chosen === 0 ? 0 : chosen === 1 ? 2.5 : 10 },
    ],
    decisions: [
      {
        street: 'preflop',
        pos: 'BB',
        labels: ['弃牌', '跟注', '3-bet 至 10bb'],
        kinds: ['fold', 'call', 'raise'],
        freqs: [0.4, 0.45, 0.15],
        evs: [0, 0.1, 0.05],
        chosen,
        evLoss: chosen === 0 ? 0.1 : 0,
        score: 100,
        verdict: chosen === 0 ? 'acceptable' : 'optimal',
      },
    ],
    result: {
      deltaBB: chosen === 0 ? -1 : 0,
      heroFolded: chosen === 0,
      wentToShowdown: false,
      multiwayCutoff: false,
      revealed: [],
    },
  }
}

// 场景 A：全部弃牌（过度弃牌）
const overfold: HandRecord[] = Array.from({ length: 40 }, (_, i) => bbDefendHand(i, 0))
const sA = computeStats(overfold)
check('过弃样本：BB 弃牌率 100%', Math.abs(sA.bbDefendFold.user - 1) < 1e-9)
check('过弃样本：GTO 基线约 40%', Math.abs(sA.bbDefendFold.gto - 0.4) < 0.01, `${sA.bbDefendFold.gto}`)
check('过弃样本：VPIP 0%', sA.vpip.user === 0)
const leaksA = detectLeaks(sA)
check('检测到 BB 防守不足', leaksA.some((l) => l.id === 'bb-overfold'), leaksA.map((l) => l.id).join(','))
check('检测到入池过紧', leaksA.some((l) => l.id === 'too-tight'))

// 场景 B：按 GTO 频率行动（16 弃 18 跟 6 3bet ≈ 40/45/15）
const faithful: HandRecord[] = []
for (let i = 0; i < 40; i++) {
  const chosen = i < 16 ? 0 : i < 34 ? 1 : 2
  faithful.push(bbDefendHand(i, chosen))
}
const sB = computeStats(faithful)
const leaksB = detectLeaks(sB)
check('贴合样本：BB 弃牌率 ≈ 40%', Math.abs(sB.bbDefendFold.user - 0.4) < 0.02, `${sB.bbDefendFold.user}`)
check('贴合样本：无 BB 防守弱点', !leaksB.some((l) => l.id === 'bb-overfold'), leaksB.map((l) => l.id).join(','))
check('贴合样本：3-bet 机会计数 40', sB.threeBet.n === 40)
check('盈亏累计正确', Math.abs(sB.netBB - -16) < 1e-9, `${sB.netBB}`)

// 小样本静默
const few = overfold.slice(0, 10)
check('样本不足时不出弱点', detectLeaks(computeStats(few)).length === 0)

// 旧版本把零策略记录为最优/零损失；缺失策略不能污染评分与 GTO 基线。
const legacyZero = bbDefendHand(100, 0)
Object.assign(legacyZero.decisions[0], { freqs: [0, 0, 0], evs: [0, 0, 0], verdict: 'optimal', evLoss: 0 })
legacyZero.result.deltaBB = 20
const noEv = bbDefendHand(101, 1)
Object.assign(noEv.decisions[0], { evs: null, evLoss: 0 })
const measured = bbDefendHand(102, 0)
const best = bbDefendHand(103, 1)
const partial = computeStats([legacyZero, noEv, measured, best])
check('缺失策略仍保留决策总数和真实盈亏', partial.decisions === 4 && partial.netBB === 19 && partial.settledHands === 4)
check('旧零策略不计最优率，频率有效但无 EV 仍可评估', partial.evaluatedDecisions === 3 && partial.optimalRate !== null && Math.abs(partial.optimalRate - 2 / 3) < 1e-9)
check('旧零策略不计 GTO 基线机会', partial.bbDefendFold.n === 3 && Math.abs(partial.bbDefendFold.gto - 0.4) < 1e-9 && Math.abs(partial.bbDefendFold.user - 1 / 3) < 1e-9)
check('缺失 EV 不稀释平均损失', partial.evDecisions === 2 && partial.evLossPerDecision !== null && Math.abs(partial.evLossPerDecision - 0.05) < 1e-9)
check('位置与街道 EV 平均数只用有效 EV 样本', partial.byPosition[0].evDecisions === 2 && partial.byPosition[0].evLoss === 0.05 && partial.byStreetEvLoss[0].evDecisions === 2 && partial.byStreetEvLoss[0].evLoss === 0.05)
const unavailable = computeStats([legacyZero])
check('全缺失样本返回未评估，而非 0% 或零 EV 损失', unavailable.optimalRate === null && unavailable.evLossPerDecision === null && unavailable.byPosition[0].evLoss === null && unavailable.byStreetEvLoss[0].evLoss === null)
check('全缺失样本没有 GTO 机会，但真实结果保留', unavailable.vpip.n === 0 && unavailable.threeBet.n === 0 && unavailable.netBB === 20)

const positionSamples: HandRecord[] = Array.from({ length: 60 }, (_, i) => {
  const hand = bbDefendHand(200 + i, 0)
  hand.heroPos = i < 30 ? 'BB' : 'BTN'
  hand.decisions[0].evs = [0, 0.2, 0.1]
  return hand
})
const manyMissingEv = Array.from({ length: 240 }, (_, i) => ({ ...noEv, id: `missing-${i}` }))
check('缺失 EV 不制造位置弱点', !detectLeaks(computeStats([...positionSamples, ...manyMissingEv])).some((leak) => leak.id.startsWith('pos-')))

if (failed > 0) {
  console.error(`\n${failed} 项未通过`)
  process.exit(1)
}
console.log('\n统计测试全部通过')
