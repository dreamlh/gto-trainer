// Solver 慢速测试：npx tsx scripts/test-solver.ts
// 现场求解 HU 与 6-max，校验收敛质量、已知策略特征与 artifact 往返

import { HAND_NAMES, comboCount, handIndex } from '../src/poker/cards'
import { DEFAULT_LADDER, PREFLOP_CFR } from '../src/solver/config'
import { bundleFromArtifact } from '../src/solver/preflop/api'
import { solvePreflop, type PreflopSolution } from '../src/solver/preflop/cfr'
import { encodeSolution } from '../src/solver/preflop/serialize'
import { buildPreflopTree, type PfDecisionNode } from '../src/solver/preflop/tree'

let failed = 0
function check(name: string, cond: boolean, detail = '') {
  if (!cond) {
    failed++
    console.error(`✗ ${name} ${detail}`)
  } else {
    console.log(`✓ ${name}`)
  }
}

// ---- 树规模 ----
for (const n of [2, 6, 9]) {
  const t = buildPreflopTree(n, DEFAULT_LADDER)
  check(`${n} 人树节点数受限`, t.decisionNodes.length <= 30000, `${t.decisionNodes.length}`)
}

// ---- HU 求解 ----
console.log('求解 HU…')
const huTree = buildPreflopTree(2, DEFAULT_LADDER)
const huSol = solvePreflop(huTree, { iterations: 400 })
check(
  `HU 可利用度 < ${PREFLOP_CFR.huExploitabilityTarget}bb`,
  (huSol.exploitability ?? 1) < PREFLOP_CFR.huExploitabilityTarget,
  `实测 ${huSol.exploitability?.toFixed(5)}`,
)

// ---- 6-max 求解 ----
console.log('求解 6-max…')
const t6 = Date.now()
const tree6 = buildPreflopTree(6, DEFAULT_LADDER)
const sol6 = solvePreflop(tree6)
console.log(`6-max ${PREFLOP_CFR.iterations} 迭代耗时 ${((Date.now() - t6) / 1000) | 0}s`)

function rfiNode(sol: PreflopSolution, heroPos: string): PfDecisionNode {
  // 首入节点：raisesBefore===0 且 actor 为该位置
  const seat = sol.tree.positions.indexOf(heroPos as never)
  const nd = sol.tree.decisionNodes.find((d) => d.raisesBefore === 0 && d.actor === seat)
  if (!nd) throw new Error(`找不到 ${heroPos} RFI 节点`)
  return nd
}

function actionPct(sol: PreflopSolution, nd: PfDecisionNode, actionIdx: number): number {
  const f = sol.avgStrategy.get(nd.id)!
  const A = nd.actions.length
  let w = 0
  for (let h = 0; h < 169; h++) w += f[h * A + actionIdx] * comboCount(HAND_NAMES[h])
  return (w / 1326) * 100
}

function handFreq(sol: PreflopSolution, nd: PfDecisionNode, hand: string, actionIdx: number) {
  const f = sol.avgStrategy.get(nd.id)!
  return f[handIndex(hand) * nd.actions.length + actionIdx]
}

// RFI 频段与单调性
const rfiPcts: Record<string, number> = {}
for (const p of ['UTG', 'HJ', 'CO', 'BTN', 'SB']) {
  const nd = rfiNode(sol6, p)
  rfiPcts[p] = actionPct(sol6, nd, 1) // [fold, raise]
  console.log(`  ${p} RFI ${rfiPcts[p].toFixed(1)}%`)
}
check('UTG RFI 在 13-22%', rfiPcts.UTG > 13 && rfiPcts.UTG < 22, `${rfiPcts.UTG.toFixed(1)}%`)
check('BTN RFI 在 35-55%', rfiPcts.BTN > 35 && rfiPcts.BTN < 55, `${rfiPcts.BTN.toFixed(1)}%`)
check(
  'RFI 按位置单调不减（UTG≤HJ≤CO≤BTN）',
  rfiPcts.UTG <= rfiPcts.HJ + 1 && rfiPcts.HJ <= rfiPcts.CO + 1 && rfiPcts.CO <= rfiPcts.BTN + 1,
)

// AA 在所有已存节点永不弃牌
let aaFoldMax = 0
for (const nd of sol6.tree.decisionNodes) {
  if ((sol6.nodeReach.get(nd.id) ?? 0) < PREFLOP_CFR.storeReachThreshold) continue
  const foldIdx = nd.actions.findIndex((a) => a.kind === 'fold')
  if (foldIdx < 0) continue
  aaFoldMax = Math.max(aaFoldMax, handFreq(sol6, nd, 'AA', foldIdx))
}
check('AA 永不弃牌（≤2%）', aaFoldMax <= 0.02, `最大弃牌频率 ${(aaFoldMax * 100).toFixed(1)}%`)

// 72o 面对 UTG 开局弃牌 ≥99%（检查 BTN 位）
{
  const utgSeat = sol6.tree.positions.indexOf('UTG')
  const btnSeat = sol6.tree.positions.indexOf('BTN')
  const nd = sol6.tree.decisionNodes.find(
    (d) =>
      d.raisesBefore === 1 &&
      d.actor === btnSeat &&
      d.publicPath === `R${DEFAULT_LADDER.openSize}-F-F`,
  )
  check('找到 BTN vs UTG 开局节点', !!nd, 'publicPath 未匹配')
  if (nd) {
    const foldIdx = nd.actions.findIndex((a) => a.kind === 'fold')
    const f = handFreq(sol6, nd, '72o', foldIdx)
    check('72o 面对 UTG 开局弃牌 ≥99%', f >= 0.99, `${(f * 100).toFixed(1)}%`)
    void utgSeat
  }
}

// BB 防守 vs BTN
{
  const btnSeat = sol6.tree.positions.indexOf('BTN')
  const bbSeat = sol6.tree.positions.indexOf('BB')
  const nd = sol6.tree.decisionNodes.find(
    (d) =>
      d.raisesBefore === 1 &&
      d.actor === bbSeat &&
      d.publicPath === `F-F-F-R${DEFAULT_LADDER.openSize}-F`,
  )
  check('找到 BB vs BTN 节点', !!nd)
  if (nd) {
    const callIdx = nd.actions.findIndex((a) => a.kind === 'call')
    const raiseIdx = nd.actions.findIndex((a) => a.kind === 'raise')
    const callPct = actionPct(sol6, nd, callIdx)
    const threeBetPct = actionPct(sol6, nd, raiseIdx)
    console.log(`  BB vs BTN: 3bet ${threeBetPct.toFixed(1)}%, 跟注 ${callPct.toFixed(1)}%`)
    check('BB vs BTN 3-bet 在 6-18%', threeBetPct > 6 && threeBetPct < 18)
    check('BB vs BTN 跟注 在 25-50%', callPct > 25 && callPct < 50)
    void btnSeat
  }
}

// ---- artifact 往返 ----
{
  const raw = encodeSolution(sol6, PREFLOP_CFR.storeReachThreshold)
  const bundle = bundleFromArtifact(raw)
  const nd = rfiNode(sol6, 'UTG')
  const orig = sol6.avgStrategy.get(nd.id)!
  const dec = bundle.freq.get(nd.id)!
  let maxDiff = 0
  for (let i = 0; i < orig.length; i++) maxDiff = Math.max(maxDiff, Math.abs(orig[i] - dec[i]))
  check('artifact 往返频率误差 ≤ 1%', maxDiff <= 0.01, `最大 ${maxDiff.toFixed(4)}`)
  check(
    '派生场景数量合理（6-max ≥ 40）',
    bundle.spots.length >= 40,
    `${bundle.spots.length} 个`,
  )
  const utgSpot = bundle.spots.find((s) => s.id === '6p-rfi-utg')
  check(
    'UTG RFI Spot 存在且含策略',
    !!utgSpot && utgSpot.strategy.size > 30,
    `${utgSpot?.strategy.size ?? 0} 手非弃牌`,
  )
}

if (failed > 0) {
  console.error(`\n${failed} 项未通过`)
  process.exit(1)
}
console.log('\nsolver 测试全部通过')
