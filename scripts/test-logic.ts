// 逻辑层自检：npx tsx scripts/test-logic.ts
import { parseRange } from '../src/poker/rangeParser'
import { evaluate } from '../src/poker/evaluator'
import { computeEquity } from '../src/poker/equity'
import { parseCard, combosForHand, comboCount, type Card } from '../src/poker/cards'
import { SPOTS } from '../src/poker/ranges'
import { buildPreflopTree, type PfNode } from '../src/solver/preflop/tree'
import { DEFAULT_LADDER, POSITIONS_BY_SIZE } from '../src/solver/config'

let failed = 0
function check(name: string, cond: boolean, detail = '') {
  if (!cond) {
    failed++
    console.error(`✗ ${name} ${detail}`)
  } else {
    console.log(`✓ ${name}`)
  }
}

// ---- 范围解析 ----
check('77+ 展开为 8 个对子', parseRange('77+').size === 8)
check('A2s+ 展开为 12 手', parseRange('A2s+').size === 12)
check('TT-66 展开为 5 手', parseRange('TT-66').size === 5)
check('QTs-Q8s 展开为 3 手', parseRange('QTs-Q8s').size === 3)
const run = parseRange('T9s-54s')
check('T9s-54s 展开为 6 手连子', run.size === 6 && run.has('87s') && run.has('54s'))
check('权重解析', parseRange('A5s:0.5').get('A5s') === 0.5)

// ---- 牌力评估 ----
function ev(str: string): number {
  const cards = str.split(' ').map((s) => parseCard(s)!) as Card[]
  return evaluate(cards)
}
check(
  '皇家同花顺 > 四条',
  ev('As Ks Qs Js Ts 2h 3d') > ev('Ah Ad Ac As Kh 2d 3c'),
)
check(
  '四条 > 葫芦',
  ev('Ah Ad Ac As Kh 2d 3c') > ev('Kh Kd Kc Ah Ad 2s 3s'),
)
check('葫芦 > 同花', ev('Kh Kd Kc Ah Ad 2s 3s') > ev('Ah Kh 9h 5h 2h Qd Jc'))
check('同花 > 顺子', ev('Ah Kh 9h 5h 2h Qd Jc') > ev('9h 8d 7c 6s 5h Ad Kc'))
check('顺子 > 三条', ev('9h 8d 7c 6s 5h Ad Kc') > ev('9h 9d 9c As Kh 2d 3c'))
check('轮子顺 A5432 成立', ev('Ah 2d 3c 4s 5h Kd 9c') >> 24 === 4)
check('轮子顺 < 65432 顺', ev('Ah 2d 3c 4s 5h Kd 9c') < ev('6h 2d 3c 4s 5h Kd 9c'))
check('两对踢脚比较', ev('Ah Ad Kh Kd Qc 2s 3s') > ev('Ah Ad Kh Kd Jc 2s 3s'))
check('同牌力平局', ev('Ah Kd Qc Js 9h 2d 3c') === ev('As Kc Qd Jh 9s 2c 3d'))
check('A 高同花 > K 高同花', ev('Ah Qh 9h 5h 2h Kd Jc') > ev('Kh Qh 9h 5h 3h Ad Jc'))

// ---- 权益计算（蒙特卡洛，允许 ±2% 误差）----
function handSpec(c1: string, c2: string) {
  return { type: 'cards' as const, cards: [parseCard(c1)!, parseCard(c2)!] as [Card, Card] }
}
const aakk = computeEquity(handSpec('Ah', 'Ad'), handSpec('Kh', 'Kd'), [], 40000)
check('AA vs KK ≈ 82%', Math.abs(aakk.win + aakk.tie / 2 - 0.82) < 0.02, `实测 ${(aakk.win + aakk.tie / 2).toFixed(3)}`)
const akqq = computeEquity(handSpec('As', 'Ks'), handSpec('Qh', 'Qd'), [], 40000)
check('AKs vs QQ ≈ 46%', Math.abs(akqq.win + akqq.tie / 2 - 0.46) < 0.02, `实测 ${(akqq.win + akqq.tie / 2).toFixed(3)}`)
// 确定性：完整公共牌
const det = computeEquity(
  handSpec('Ah', 'Kh'),
  handSpec('Qs', 'Qd'),
  ['2h', '7h', '9h', 'Jc', '3d'].map((s) => parseCard(s)!),
  1000,
)
check('完整公共牌确定性判定（同花胜）', det.win === 1 && det.iterations === 1)
// 范围 vs 手牌
const rangeCombos = [...parseRange('QQ+, AKs').entries()].flatMap(([h, w]) =>
  combosForHand(h).map((cards) => ({ cards, w })),
)
const rvh = computeEquity({ type: 'range', combos: rangeCombos }, handSpec('7h', '7d'), [], 40000)
check('范围 vs 77：范围应明显领先', rvh.win + rvh.tie / 2 > 0.6, `实测 ${(rvh.win + rvh.tie / 2).toFixed(3)}`)

// ---- 范围数据合理性 ----
for (const spot of SPOTS) {
  let bad = ''
  for (const [hand, entry] of spot.strategy) {
    const sum = Object.values(entry).reduce((a, b) => a + b, 0)
    if (sum > 1.0001) bad = `${hand} 总频率 ${sum}`
  }
  check(`[${spot.id}] 频率总和 ≤ 1`, bad === '', bad)
}
// RFI 百分比在合理区间
function rangePct(spotId: string, keys: string[]): number {
  const spot = SPOTS.find((s) => s.id === spotId)!
  let weighted = 0
  for (const [hand, entry] of spot.strategy) {
    const f = keys.reduce((a, k) => a + (entry[k] ?? 0), 0)
    weighted += f * comboCount(hand)
  }
  return (weighted / 1326) * 100
}
const utgPct = rangePct('rfi-utg', ['raise'])
check('UTG RFI 约 16-20%', utgPct > 15 && utgPct < 21, `实测 ${utgPct.toFixed(1)}%`)
const btnPct = rangePct('rfi-btn', ['raise'])
check('BTN RFI 约 38-48%', btnPct > 37 && btnPct < 49, `实测 ${btnPct.toFixed(1)}%`)
const bbBtn3bet = rangePct('bb-vs-btn', ['threebet'])
check('BB vs BTN 3-bet 约 9-15%', bbBtn3bet > 8 && bbBtn3bet < 16, `实测 ${bbBtn3bet.toFixed(1)}%`)
const bbBtnCall = rangePct('bb-vs-btn', ['call'])
check('BB vs BTN 跟注 约 30-45%', bbBtnCall > 28 && bbBtnCall < 46, `实测 ${bbBtnCall.toFixed(1)}%`)

for (const spot of SPOTS) {
  const pct = rangePct(spot.id, spot.actions.map((a) => a.key))
  console.log(`  [${spot.id}] 非弃牌合计 ${pct.toFixed(1)}%`)
}

// ---- 牌局引擎 ----
{
  const { newHand, applyAction, advanceStreet, runOutBoard, showdown, settle, pot } = await import(
    '../src/poker/../game/engine'
  )
  const st = newHand(6)
  check('6 人盲注正确', st.players[4].invested === 0.5 && st.players[5].invested === 1)
  check('初始底池 1.5bb', Math.abs(pot(st) - 1.5) < 1e-9)
  const hu = newHand(2)
  check('HU 按钮兼小盲', hu.players[0].invested === 0.5 && hu.players[1].invested === 1)

  applyAction(st, 0, 'raise', 2.5)
  applyAction(st, 3, 'call', 2.5)
  for (const s of [1, 2, 4, 5]) applyAction(st, s, 'fold', 0)
  check('翻前动作后底池', Math.abs(pot(st) - 6.5) < 1e-9)
  advanceStreet(st)
  check('进翻牌发 3 张', st.street === 'flop' && st.board.length === 3)
  check('streetBase 更新', st.players[0].streetBase === 2.5)
  applyAction(st, 0, 'bet', 2.5 + 4)
  applyAction(st, 3, 'call', 2.5 + 4)
  advanceStreet(st)
  advanceStreet(st)
  check('到河牌 5 张', st.street === 'river' && st.board.length === 5)
  runOutBoard(st)
  const win = showdown(st)
  const settled = settle(st, win)
  let sum = 0
  for (const v of settled.values()) sum += v
  check('结算零和', Math.abs(sum) < 1e-9, `${sum}`)
  // 平分池：两家持相同牌力（公共牌成手）
  const st2 = newHand(2)
  st2.players[0].cards = [0, 1] // 2s2h
  st2.players[1].cards = [2, 3] // 2d2c
  st2.board = [
    // AKQJT 同花色外的杂牌顺：公共牌最大，双方平分
    12 * 4, 11 * 4 + 1, 10 * 4 + 2, 9 * 4 + 3, 8 * 4,
  ]
  st2.street = 'river'
  const win2 = showdown(st2)
  check('公共牌成手平分池', Math.abs(win2.get(0)! - win2.get(1)!) < 1e-9)
}

// ---- 翻前树：没有座位会被静默跳过 ----
// 树把「唯一动作=弃牌」的座位坍缩掉（未投入者面对 3bet/4bet），必须记进 forcedFolds，
// 否则训练器会在轮到英雄时凭空跳过他。
{
  for (const n of [2, 3, 4, 5, 6, 9]) {
    const tree = buildPreflopTree(n, DEFAULT_LADDER)
    const positions = POSITIONS_BY_SIZE[n]
    let leaks = 0
    let forcedSeen = 0
    function walk(node: PfNode, accounted: Set<number>) {
      const acc = new Set(accounted)
      for (const s of node.forcedFolds) {
        if (acc.has(s)) leaks++ // 同一座位被记两次
        acc.add(s)
        forcedSeen++
      }
      if (node.type === 'terminal') {
        for (let s = 0; s < n; s++) {
          if (!node.active.includes(s) && !acc.has(s)) leaks++
        }
        return
      }
      if (acc.has(node.actor)) leaks++ // 已弃牌的人还在行动
      for (let i = 0; i < node.actions.length; i++) {
        const nx = new Set(acc)
        if (node.actions[i].kind === 'fold') nx.add(node.actor)
        walk(node.children[i], nx)
      }
    }
    walk(tree.root, new Set())
    check(`${n} 人翻前树无静默跳过（${positions.length} 座）`, leaks === 0, `leaks=${leaks}`)
    // 盲注可冷跟后，强制弃牌只剩「非盲注、未投入、面对 3bet」的座位：≤4 人桌不存在，5 人起才有
    if (n <= 4) check(`${n} 人树无强制弃牌`, forcedSeen === 0, `forced=${forcedSeen}`)
    else check(`${n} 人树记录了强制弃牌`, forcedSeen > 0)
  }
}

if (failed > 0) {
  console.error(`\n${failed} 项未通过`)
  process.exit(1)
}
console.log('\n全部通过')
