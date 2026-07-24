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

if (failed > 0) {
  console.error(`\n${failed} 项未通过`)
  process.exit(1)
}
console.log('\n统计测试全部通过')
