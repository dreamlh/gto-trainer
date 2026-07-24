// 翻后 solver 测试：npx tsx scripts/test-postflop.ts

import { parseCard, type Card } from '../src/poker/cards'
import { parseRange } from '../src/poker/rangeParser'
import { combosForHand, comboIndex } from '../src/poker/cards'
import { COMBO_A, COMBO_B } from '../src/solver/postflop/combos'
import { riverStrengths, showdownSweep, sortedOrder } from '../src/solver/postflop/showdown'
import { buildPostflopTree } from '../src/solver/postflop/tree'
import { solvePostflop } from '../src/solver/postflop/cfr'
import type { PostflopPreset } from '../src/solver/config'

let failed = 0
function check(name: string, cond: boolean, detail = '') {
  if (!cond) {
    failed++
    console.error(`✗ ${name} ${detail}`)
  } else {
    console.log(`✓ ${name}`)
  }
}

function cards(s: string): Card[] {
  return s.split(' ').map((x) => parseCard(x)!)
}

function rangeVector(notation: string, dead: Card[]): Float32Array {
  const v = new Float32Array(1326)
  for (const [hand, w] of parseRange(notation)) {
    for (const [a, b] of combosForHand(hand)) v[comboIndex(a, b)] = w
  }
  for (const d of dead) {
    for (let i = 0; i < 1326; i++) {
      if (COMBO_A[i] === d || COMBO_B[i] === d) v[i] = 0
    }
  }
  return v
}

// ---- 排序扫描 vs 暴力对拍 ----
{
  const board = cards('Ks Qh 7d 4c 2s')
  const strengths = riverStrengths(board)
  const order = sortedOrder(strengths)
  const villain = rangeVector('22+, A2s+, K9o+, T9s, 76s, QJo, 55:0.35', board)
  const win = new Float32Array(1326)
  const mass = new Float32Array(1326)
  showdownSweep(order, strengths, villain, win, mass)

  let maxErr = 0
  for (let k = 0; k < order.length; k += 7) {
    const c = order[k]
    const a = COMBO_A[c]
    const b = COMBO_B[c]
    let bw = 0
    let bm = 0
    for (let j = 0; j < order.length; j++) {
      const d = order[j]
      if (d === c) continue
      if (COMBO_A[d] === a || COMBO_A[d] === b || COMBO_B[d] === a || COMBO_B[d] === b) continue
      bm += villain[d]
      if (strengths[d] < strengths[c]) bw += villain[d]
      else if (strengths[d] === strengths[c]) bw += villain[d] * 0.5
    }
    maxErr = Math.max(maxErr, Math.abs(bw - win[c]), Math.abs(bm - mass[c]))
  }
  check('排序扫描与暴力枚举一致', maxErr < 1e-4, `最大误差 ${maxErr.toExponential(2)}`)
}

// ---- 千里眼玩具博弈 ----
// 底池 10，筹码 10（唯一下注 = 底池 = 全下）。OOP = 99（抓诈）；IP = AA（价值）+ 33（空气）
// 均衡：IP 下注全部 AA + 约一半 33（诈唬占下注 1/3）；OOP 跟注约 50%；OOP 不下注
{
  const board = cards('Ks Qh 7d 4c 2s')
  const preset: PostflopPreset = {
    betSizes: [1.0],
    raiseSizes: [],
    maxRaisesPerStreet: 0,
    iterations: { river: 1000, turn: 0, flop: 0 },
    contBetSizes: [1.0],
    runoutSample: 0,
  }
  const tree = buildPostflopTree({ street: 'river', board, pot: 10, stack: 10, preset })
  const oop = rangeVector('99', board)
  const ip = rangeVector('AA, 33', board)
  const sol = await solvePostflop(tree, oop, ip)

  const root = tree.root as { type: 'decision'; actions: { kind: string }[]; children: never[]; id: number; actor: number }
  // OOP 过牌频率
  const rootStrat = sol.avgStrategy.get(root.id)!
  const A0 = root.actions.length
  let oopCheck = 0
  let oopMass = 0
  for (let c = 0; c < 1326; c++) {
    if (oop[c] <= 0) continue
    oopMass += 1
    oopCheck += rootStrat[c * A0 + 0] // 动作 0 = check
  }
  oopCheck /= oopMass
  check('玩具博弈：OOP 过牌 ≥95%', oopCheck >= 0.95, `${(oopCheck * 100).toFixed(1)}%`)

  // 过牌后的 IP 节点
  const ipNode = (tree.root as never as { children: PostNode2[] }).children[0] as PostNode2
  interface PostNode2 {
    type: string
    id: number
    actor: number
    actions: { kind: string }[]
    children: PostNode2[]
  }
  check('IP 节点存在', ipNode.type === 'decision' && ipNode.actor === 1)
  const ipStrat = sol.avgStrategy.get(ipNode.id)!
  const A1 = ipNode.actions.length
  const betIdx = ipNode.actions.findIndex((a) => a.kind === 'bet')
  let aaBet = 0
  let aaN = 0
  let airBet = 0
  let airN = 0
  for (const [hand] of parseRange('AA')) {
    for (const [a, b] of combosForHand(hand)) {
      const c = comboIndex(a, b)
      if (ip[c] <= 0) continue
      aaBet += ipStrat[c * A1 + betIdx]
      aaN++
    }
  }
  for (const [hand] of parseRange('33')) {
    for (const [a, b] of combosForHand(hand)) {
      const c = comboIndex(a, b)
      if (ip[c] <= 0) continue
      airBet += ipStrat[c * A1 + betIdx]
      airN++
    }
  }
  aaBet /= aaN
  airBet /= airN
  check('玩具博弈：AA 下注 ≥96%', aaBet >= 0.96, `${(aaBet * 100).toFixed(1)}%`)
  check('玩具博弈：33 诈唬 50%±5pp', Math.abs(airBet - 0.5) <= 0.05, `${(airBet * 100).toFixed(1)}%`)

  // OOP 面对下注的跟注频率（下注后的节点）
  const facingNode = ipNode.children[betIdx] as PostNode2
  check('OOP 面对下注节点存在', facingNode.type === 'decision')
  const fStrat = sol.avgStrategy.get(facingNode.id)!
  const A2 = facingNode.actions.length
  const callIdx = facingNode.actions.findIndex((a) => a.kind === 'call')
  let call = 0
  let n99 = 0
  for (let c = 0; c < 1326; c++) {
    if (oop[c] <= 0) continue
    call += fStrat[c * A2 + callIdx]
    n99++
  }
  call /= n99
  check('玩具博弈：OOP 跟注 50%±5pp', Math.abs(call - 0.5) <= 0.05, `${(call * 100).toFixed(1)}%`)
  check(
    '玩具博弈：可利用度 <1% 底池',
    Math.abs(sol.exploitability) < 0.01,
    sol.exploitability.toExponential(2),
  )
}

// ---- 真实范围性能预算 ----
{
  const board = cards('Ks Qh 7d 4c 2s')
  const preset: PostflopPreset = {
    betSizes: [0.33, 0.75],
    raiseSizes: [0.6],
    maxRaisesPerStreet: 2,
    iterations: { river: 400, turn: 250, flop: 200 },
    contBetSizes: [0.75],
    runoutSample: 300,
  }
  const tree = buildPostflopTree({ street: 'river', board, pot: 12, stack: 94, preset })
  const oop = rangeVector('22+, A2s+, K5s+, Q8s+, J8s+, T7s+, 97s+, 86s+, 75s+, 65s, ATo+, KTo+, QTo+, JTo', board)
  const ip = rangeVector('22+, A2s+, K7s+, Q8s+, J8s+, T8s+, 97s+, 87s, 76s, A5o+, KTo+, QTo+, JTo', board)
  const t0 = Date.now()
  const sol = await solvePostflop(tree, oop, ip)
  const elapsed = Date.now() - t0
  console.log(`  河牌求解（explorer 预设，${tree.decisionNodes.length} 节点）耗时 ${elapsed}ms`)
  check('河牌求解 < 2s', elapsed < 2000, `${elapsed}ms`)
  check('河牌可利用度 < 1% 底池', Math.abs(sol.exploitability) < 0.01, sol.exploitability.toExponential(2))
}

// ---- 转牌求解：性能 + 收敛 ----
{
  const board = cards('Ks Qh 7d 4c')
  const preset: PostflopPreset = {
    betSizes: [0.33, 0.75],
    raiseSizes: [0.6],
    maxRaisesPerStreet: 2,
    iterations: { river: 400, turn: 400, flop: 200 },
    contBetSizes: [0.75],
    runoutSample: 300,
  }
  const tree = buildPostflopTree({ street: 'turn', board, pot: 12, stack: 94, preset })
  const oop = rangeVector('99-22, A9s-A2s, KTs, QTs+, JTs, T8s+, 98s, 87s, ATo, KQo:0.5', board)
  const ip = rangeVector('22+, ATs+, KTs+, QTs+, JTs, T9s, A5s-A2s, AQo+, KQo:0.5', board)
  const t0 = Date.now()
  const sol = await solvePostflop(tree, oop, ip)
  const elapsed = Date.now() - t0
  console.log(
    `  转牌求解（${tree.decisionNodes.length} 决策节点，${sol.iterations} 迭代）耗时 ${(elapsed / 1000).toFixed(1)}s`,
  )
  check('转牌求解 < 75s（explorer 完整精度）', elapsed < 75000, `${elapsed}ms`)
  check('转牌可利用度 < 2% 底池', Math.abs(sol.exploitability) < 0.02, sol.exploitability.toExponential(2))

  // trainer 预设：单一尺寸、粗 continuation，训练器逐街等待用
  const trainerPreset: PostflopPreset = {
    betSizes: [0.66],
    raiseSizes: [],
    maxRaisesPerStreet: 1,
    iterations: { river: 200, turn: 200, flop: 80 },
    contBetSizes: [0.66],
    runoutSample: 150,
  }
  const tree2 = buildPostflopTree({ street: 'turn', board, pot: 12, stack: 94, preset: trainerPreset })
  const t1 = Date.now()
  const sol2 = await solvePostflop(tree2, oop, ip)
  const e2 = Date.now() - t1
  console.log(`  转牌求解（trainer，${tree2.decisionNodes.length} 节点）耗时 ${(e2 / 1000).toFixed(1)}s`)
  check('转牌 trainer 预设 < 15s', e2 < 15000, `${e2}ms`)
  check('转牌 trainer 可利用度 < 3% 底池', Math.abs(sol2.exploitability) < 0.03, sol2.exploitability.toExponential(2))
}

// ---- 翻牌求解（深度受限）：性能 + 基本合理性 ----
{
  const board = cards('Ks Qh 7d')
  const explorer: PostflopPreset = {
    betSizes: [0.33, 0.75],
    raiseSizes: [0.6],
    maxRaisesPerStreet: 2,
    iterations: { river: 400, turn: 400, flop: 120 },
    contBetSizes: [0.75],
    runoutSample: 300,
  }
  const oop = rangeVector('99-22, A9s-A2s, KTs, QTs+, JTs, T8s+, 98s, 87s, ATo, KQo:0.5', board)
  const ip = rangeVector('22+, ATs+, KTs+, QTs+, JTs, T9s, A5s-A2s, AQo+, KQo:0.5', board)
  const t0 = Date.now()
  const tree = buildPostflopTree({ street: 'flop', board, pot: 5.5, stack: 97.5, preset: explorer })
  const sol = await solvePostflop(tree, oop, ip)
  const elapsed = Date.now() - t0
  console.log(`  翻牌求解（explorer，${tree.decisionNodes.length} 节点）耗时 ${(elapsed / 1000).toFixed(1)}s`)
  check('翻牌求解 < 30s', elapsed < 30000, `${elapsed}ms`)
  check('翻牌可利用度 < 3% 底池', Math.abs(sol.exploitability) < 0.03, sol.exploitability.toExponential(2))

  // trainer 预设更快
  const trainer: PostflopPreset = {
    betSizes: [0.66],
    raiseSizes: [],
    maxRaisesPerStreet: 1,
    iterations: { river: 200, turn: 200, flop: 80 },
    contBetSizes: [0.66],
    runoutSample: 150,
  }
  const t1 = Date.now()
  const tree2 = buildPostflopTree({ street: 'flop', board, pot: 5.5, stack: 97.5, preset: trainer })
  await solvePostflop(tree2, oop, ip)
  const e2 = Date.now() - t1
  console.log(`  翻牌求解（trainer）耗时 ${(e2 / 1000).toFixed(1)}s`)
  check('翻牌 trainer 预设 < 8s', e2 < 8000, `${e2}ms`)
}

if (failed > 0) {
  console.error(`\n${failed} 项未通过`)
  process.exit(1)
}
console.log('\n翻后测试全部通过')
