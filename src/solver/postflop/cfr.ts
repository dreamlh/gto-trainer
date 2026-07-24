import type { Card } from '../../poker/cards'
import { REALIZATION } from '../config'
import { COMBO_A, COMBO_B, COMBOS_OF_CARD, zeroDead } from './combos'
import { riverStrengths, showdownSweep, sortedOrder } from './showdown'
import type { PostDecision, PostNode, PostTerminal, PostTree } from './tree'

// 单挑翻后 CFR+（1326 组合向量，只遍历活组合），支持：
// - river：精确求解
// - turn：机会节点全枚举每张河牌（河牌子树用粗化 continuation）
// - flop：深度受限，本街结束叶 = 发完的热权益 × 实现系数（runout 可采样）

export interface PostflopSolution {
  tree: PostTree
  avgStrategy: Map<number, Float32Array> // nodeId -> 1326*A
  evByAction: Map<number, Float32Array> // nodeId -> 1326*A（bb）
  exploitability: number // 占底池比例
  iterations: number
}

export interface SolveOpts {
  iterations?: number
  onProgress?: (i: number, n: number) => void
  shouldStop?: () => boolean
  yieldEvery?: number // 每 N 迭代让出事件循环（worker 取消用）
}

const EPS = 1e-12

interface StrengthTable {
  strengths: Int32Array
  order: Int32Array
}

export async function solvePostflop(
  tree: PostTree,
  oopRangeIn: Float32Array,
  ipRangeIn: Float32Array,
  opts: SolveOpts = {},
): Promise<PostflopSolution> {
  const spec = tree.spec
  const T =
    opts.iterations ??
    (spec.street === 'river'
      ? spec.preset.iterations.river
      : spec.street === 'turn'
        ? spec.preset.iterations.turn
        : spec.preset.iterations.flop)

  // 输入防御：公共牌阻断清零
  const oopRange = Float32Array.from(oopRangeIn)
  const ipRange = Float32Array.from(ipRangeIn)
  zeroDead(oopRange, spec.board)
  zeroDead(ipRange, spec.board)
  const ranges = [oopRange, ipRange]

  // 活组合列表（每个玩家）
  const live: [Int32Array, Int32Array] = [listLive(oopRange), listLive(ipRange)]
  function listLive(v: Float32Array): Int32Array {
    const out: number[] = []
    for (let c = 0; c < 1326; c++) if (v[c] > 0) out.push(c)
    return Int32Array.from(out)
  }

  // ---------- 牌力表 ----------
  const riverTables = new Map<number, StrengthTable>()
  let runouts: { t: Card; r: Card; table: StrengthTable }[] | null = null

  if (spec.street === 'river') {
    const strengths = riverStrengths(spec.board)
    riverTables.set(-1, { strengths, order: sortedOrder(strengths) })
  } else if (spec.street === 'turn') {
    const boardSet = new Uint8Array(52)
    for (const c of spec.board) boardSet[c] = 1
    for (let c = 0; c < 52; c++) {
      if (boardSet[c]) continue
      const strengths = riverStrengths([...spec.board, c])
      riverTables.set(c, { strengths, order: sortedOrder(strengths) })
    }
  } else {
    const boardSet = new Uint8Array(52)
    for (const c of spec.board) boardSet[c] = 1
    const rest: Card[] = []
    for (let c = 0; c < 52; c++) if (!boardSet[c]) rest.push(c)
    const pairs: [Card, Card][] = []
    for (let i = 0; i < rest.length; i++)
      for (let j = i + 1; j < rest.length; j++) pairs.push([rest[i], rest[j]])
    const sample = spec.preset.runoutSample
    if (sample > 0 && sample < pairs.length) {
      let seed = 0x9e3779b9
      const rand = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        return seed / 0x80000000
      }
      for (let i = pairs.length - 1; i > 0; i--) {
        const j = (rand() * (i + 1)) | 0
        const tmp = pairs[i]
        pairs[i] = pairs[j]
        pairs[j] = tmp
      }
      pairs.length = sample
    }
    runouts = pairs.map(([t, r]) => {
      const strengths = riverStrengths([...spec.board, t, r])
      return { t, r, table: { strengths, order: sortedOrder(strengths) } }
    })
  }

  let aliveCnt: Float32Array | null = null
  if (runouts) {
    aliveCnt = new Float32Array(1326).fill(runouts.length)
    for (const ro of runouts) {
      for (const c of COMBOS_OF_CARD[ro.t]) aliveCnt[c]--
      for (const c of COMBOS_OF_CARD[ro.r]) aliveCnt[c]--
      const both = ro.t < ro.r ? (ro.r * (ro.r - 1)) / 2 + ro.t : (ro.t * (ro.t - 1)) / 2 + ro.r
      aliveCnt[both]++
    }
  }

  // ---------- 求解器状态 ----------
  const regrets = new Map<number, Float32Array>()
  const stratSum = new Map<number, Float32Array>()
  for (const nd of tree.decisionNodes) {
    regrets.set(nd.id, new Float32Array(1326 * nd.actions.length))
    stratSum.set(nd.id, new Float32Array(1326 * nd.actions.length))
  }

  let maxDepth = 0
  ;(function depth(node: PostNode, d: number) {
    maxDepth = Math.max(maxDepth, d)
    if (node.type !== 'terminal') for (const c of node.children) depth(c, d + 1)
  })(tree.root, 0)
  const MAXA = Math.max(...tree.decisionNodes.map((n) => n.actions.length))
  const cfvPool: Float32Array[][] = []
  const reachPool: Float32Array[][] = []
  const sigmaPool: Float32Array[] = []
  const massPool: Float32Array[] = []
  for (let d = 0; d <= maxDepth + 1; d++) {
    cfvPool.push(Array.from({ length: MAXA }, () => new Float32Array(1326)))
    reachPool.push([new Float32Array(1326), new Float32Array(1326)])
    sigmaPool.push(new Float32Array(1326 * MAXA))
    massPool.push(new Float32Array(1326))
  }
  const winBuf = new Float32Array(1326)
  const massBuf = new Float32Array(1326)
  const perCardBuf = new Float64Array(52)
  const evAcc = new Float32Array(1326)

  const reach: [Float32Array, Float32Array] = [new Float32Array(1326), new Float32Array(1326)]

  function flopR(p: 0 | 1, t: PostTerminal): number {
    let r = p === 1 ? REALIZATION.lastToAct : REALIZATION.firstToAct
    const behind = spec.stack - t.invested[p]
    const spr = behind / t.pot
    if (spr < REALIZATION.sprNormalize) r = 1 + (r - 1) * (spr / REALIZATION.sprNormalize)
    return Math.min(REALIZATION.max, Math.max(REALIZATION.min, r))
  }

  function currentSigma(nd: PostDecision, out: Float32Array) {
    const A = nd.actions.length
    const R = regrets.get(nd.id)!
    const lv = live[nd.actor]
    for (let k = 0; k < lv.length; k++) {
      const c = lv[k]
      let s = 0
      for (let a = 0; a < A; a++) s += R[c * A + a]
      if (s <= EPS) {
        for (let a = 0; a < A; a++) out[c * A + a] = 1 / A
      } else {
        for (let a = 0; a < A; a++) out[c * A + a] = R[c * A + a] / s
      }
    }
  }

  // 对手兼容质量：只累计对手活组合，只输出 p 的活组合
  function compatMass(v: Float32Array, o: 0 | 1, p: 0 | 1, out: Float32Array) {
    perCardBuf.fill(0)
    let total = 0
    const lo = live[o]
    for (let k = 0; k < lo.length; k++) {
      const c = lo[k]
      const w = v[c]
      if (w > 0) {
        total += w
        perCardBuf[COMBO_A[c]] += w
        perCardBuf[COMBO_B[c]] += w
      }
    }
    const lp = live[p]
    for (let k = 0; k < lp.length; k++) {
      const c = lp[k]
      out[c] = total - perCardBuf[COMBO_A[c]] - perCardBuf[COMBO_B[c]] + v[c]
    }
  }

  function evalTerminal(t: PostTerminal, p: 0 | 1, out: Float32Array) {
    const o = (1 - p) as 0 | 1
    const v = reach[o]
    const lp = live[p]
    if (t.kind === 'fold') {
      compatMass(v, o, p, massBuf)
      const u = t.folder === p ? -t.invested[p] : t.pot - t.invested[p]
      for (let k = 0; k < lp.length; k++) {
        const c = lp[k]
        out[c] = u * massBuf[c]
      }
      return
    }
    const pot = t.pot
    const inv = t.invested[p]
    if (t.kind === 'showdown' && spec.street !== 'flop') {
      if (spec.street === 'turn' && t.riverCard === undefined) {
        // 转牌全下：对每张河牌平均（每个组合对活在 44 张河牌下）
        evAcc.fill(0)
        for (const [card, table] of riverTables) {
          showdownSweep(table.order, table.strengths, v, winBuf, massBuf)
          for (let k = 0; k < lp.length; k++) {
            const c = lp[k]
            if (COMBO_A[c] === card || COMBO_B[c] === card) continue
            evAcc[c] += pot * winBuf[c] - inv * massBuf[c]
          }
        }
        for (let k = 0; k < lp.length; k++) {
          const c = lp[k]
          out[c] = evAcc[c] / 44
        }
        return
      }
      const table = riverTables.get(t.riverCard ?? -1)!
      showdownSweep(table.order, table.strengths, v, winBuf, massBuf)
      for (let k = 0; k < lp.length; k++) {
        const c = lp[k]
        out[c] = pot * winBuf[c] - inv * massBuf[c]
      }
      return
    }
    // flop：全下摊牌（R=1）或深度受限叶（R 系数）
    const R = t.kind === 'showdown' ? 1 : flopR(p, t)
    evAcc.fill(0)
    for (const ro of runouts!) {
      showdownSweep(ro.table.order, ro.table.strengths, v, winBuf, massBuf)
      for (let k = 0; k < lp.length; k++) {
        const c = lp[k]
        if (COMBO_A[c] === ro.t || COMBO_B[c] === ro.t || COMBO_A[c] === ro.r || COMBO_B[c] === ro.r)
          continue
        evAcc[c] += R * pot * winBuf[c] - inv * massBuf[c]
      }
    }
    for (let k = 0; k < lp.length; k++) {
      const c = lp[k]
      out[c] = evAcc[c] / Math.max(aliveCnt![c], 1)
    }
  }

  // ---------- 遍历 ----------
  type Mode = 'cfr' | 'eval' | 'br'

  function walk(
    node: PostNode,
    p: 0 | 1,
    depth: number,
    iterWeight: number,
    out: Float32Array,
    mode: Mode,
    evMap?: Map<number, Float32Array>,
  ) {
    if (node.type === 'terminal') {
      evalTerminal(node, p, out)
      return
    }
    const lp = live[p]
    if (node.type === 'chance') {
      for (let k = 0; k < lp.length; k++) out[lp[k]] = 0
      const saved0 = reach[0]
      const saved1 = reach[1]
      // 机会节点必须用独立缓冲：与各分支池共享时会产生跨 48 个子树的
      // reach 污染（实测导致平均策略被 BR 收割 0.4 底池；访问频次低，分配成本可忽略）
      const buf0 = new Float32Array(1326)
      const buf1 = new Float32Array(1326)
      const child = cfvPool[depth][MAXA - 1]
      const w = 1 / 44
      for (let i = 0; i < node.cards.length; i++) {
        const card = node.cards[i]
        buf0.set(saved0)
        buf1.set(saved1)
        const list = COMBOS_OF_CARD[card]
        for (let k = 0; k < list.length; k++) {
          buf0[list[k]] = 0
          buf1[list[k]] = 0
        }
        reach[0] = buf0
        reach[1] = buf1
        walk(node.children[i], p, depth + 1, iterWeight, child, mode, evMap)
        reach[0] = saved0
        reach[1] = saved1
        // 含该发牌的英雄组合在此分支不存在，跳过（否则引入幽灵 EV）
        for (let k = 0; k < lp.length; k++) {
          const c = lp[k]
          if (COMBO_A[c] === card || COMBO_B[c] === card) continue
          out[c] += w * child[c]
        }
      }
      return
    }
    const q = node.actor
    const A = node.actions.length
    const lq = live[q]
    let sigma: Float32Array
    if (mode === 'cfr') {
      sigma = sigmaPool[depth]
      currentSigma(node, sigma)
    } else {
      sigma = avgStrategyRef!.get(node.id)!
    }

    if (q !== p) {
      for (let k = 0; k < lp.length; k++) out[lp[k]] = 0
      const saved = reach[q]
      const buf = reachPool[depth][1]
      const child = cfvPool[depth][MAXA - 1]
      for (let a = 0; a < A; a++) {
        let mass = 0
        for (let k = 0; k < lq.length; k++) {
          const c = lq[k]
          buf[c] = saved[c] * sigma[c * A + a]
          mass += buf[c]
        }
        // CFR 模式不可按质量剪枝：零概率线路后的己方节点仍需累积平均策略，
        // 否则这些节点的平均被冻结在早期状态，可被 BR 收割（实测教训）。
        if (mass < 1e-9 && mode !== 'cfr') continue
        reach[q] = buf
        walk(node.children[a], p, depth + 1, iterWeight, child, mode, evMap)
        reach[q] = saved
        for (let k = 0; k < lp.length; k++) out[lp[k]] += child[lp[k]]
      }
      return
    }

    // p 自己的节点
    if (mode === 'br') {
      for (let a = 0; a < A; a++) {
        walk(node.children[a], p, depth + 1, iterWeight, cfvPool[depth][a], mode, evMap)
      }
      for (let k = 0; k < lp.length; k++) {
        const c = lp[k]
        let best = -Infinity
        for (let a = 0; a < A; a++) best = Math.max(best, cfvPool[depth][a][c])
        out[c] = best
      }
      return
    }

    const saved = reach[p]
    let massSnap: Float32Array | null = null
    if (mode === 'eval' && evMap) {
      compatMass(reach[(1 - p) as 0 | 1], (1 - p) as 0 | 1, p, massBuf)
      massSnap = massPool[depth]
      massSnap.set(massBuf)
    }
    const buf = reachPool[depth][0]
    for (let a = 0; a < A; a++) {
      for (let k = 0; k < lp.length; k++) {
        const c = lp[k]
        buf[c] = saved[c] * sigma[c * A + a]
      }
      reach[p] = buf
      walk(node.children[a], p, depth + 1, iterWeight, cfvPool[depth][a], mode, evMap)
      reach[p] = saved
      if (mode === 'eval' && evMap && massSnap) {
        const EV = evMap.get(node.id)!
        for (let k = 0; k < lp.length; k++) {
          const c = lp[k]
          EV[c * A + a] = cfvPool[depth][a][c] / Math.max(massSnap[c], EPS)
        }
      }
    }
    if (mode === 'cfr') {
      const R = regrets.get(node.id)!
      const S = stratSum.get(node.id)!
      for (let k = 0; k < lp.length; k++) {
        const c = lp[k]
        let v = 0
        for (let a = 0; a < A; a++) v += sigma[c * A + a] * cfvPool[depth][a][c]
        out[c] = v
        for (let a = 0; a < A; a++) {
          const r = R[c * A + a] + cfvPool[depth][a][c] - v
          R[c * A + a] = r > 0 ? r : 0
          S[c * A + a] += iterWeight * saved[c] * sigma[c * A + a]
        }
      }
    } else {
      for (let k = 0; k < lp.length; k++) {
        const c = lp[k]
        let v = 0
        for (let a = 0; a < A; a++) v += sigma[c * A + a] * cfvPool[depth][a][c]
        out[c] = v
      }
    }
  }

  // ---------- 主循环 ----------
  const rootBuf = new Float32Array(1326)
  const yieldEvery = opts.yieldEvery ?? 10
  let done = T
  for (let t = 1; t <= T; t++) {
    for (let p = 0 as 0 | 1; p <= 1; p++) {
      reach[0].set(oopRange)
      reach[1].set(ipRange)
      walk(tree.root, p as 0 | 1, 0, t, rootBuf, 'cfr')
    }
    if (opts.onProgress && t % 10 === 0) opts.onProgress(t, T)
    if (t % yieldEvery === 0) {
      await new Promise((r) => setTimeout(r, 0))
      if (opts.shouldStop?.()) {
        done = t
        break
      }
    }
  }

  // ---------- 平均策略 ----------
  const avgStrategy = new Map<number, Float32Array>()
  for (const nd of tree.decisionNodes) {
    const A = nd.actions.length
    const S = stratSum.get(nd.id)!
    const avg = new Float32Array(1326 * A)
    const lv = live[nd.actor]
    for (let k = 0; k < lv.length; k++) {
      const c = lv[k]
      let s = 0
      for (let a = 0; a < A; a++) s += S[c * A + a]
      if (s <= EPS) {
        for (let a = 0; a < A; a++) avg[c * A + a] = 1 / A
      } else {
        for (let a = 0; a < A; a++) avg[c * A + a] = S[c * A + a] / s
      }
    }
    avgStrategy.set(nd.id, avg)
  }
  const avgStrategyRef = avgStrategy

  // ---------- EV 提取 + 自值 ----------
  const evByAction = new Map<number, Float32Array>()
  for (const nd of tree.decisionNodes)
    evByAction.set(nd.id, new Float32Array(1326 * nd.actions.length))
  const selfVal: number[] = []
  for (let p = 0 as 0 | 1; p <= 1; p++) {
    reach[0].set(oopRange)
    reach[1].set(ipRange)
    walk(tree.root, p as 0 | 1, 0, 0, rootBuf, 'eval', evByAction)
    let v = 0
    const lp = live[p]
    for (let k = 0; k < lp.length; k++) v += ranges[p][lp[k]] * rootBuf[lp[k]]
    selfVal.push(v)
  }

  // ---------- 可利用度 ----------
  let brSum = 0
  for (let p = 0 as 0 | 1; p <= 1; p++) {
    reach[0].set(oopRange)
    reach[1].set(ipRange)
    walk(tree.root, p as 0 | 1, 0, 0, rootBuf, 'br')
    let v = 0
    const lp = live[p]
    for (let k = 0; k < lp.length; k++) v += ranges[p][lp[k]] * rootBuf[lp[k]]
    brSum += v - selfVal[p]
  }
  let m0 = 0
  let m1 = 0
  for (let k = 0; k < live[0].length; k++) m0 += oopRange[live[0][k]]
  for (let k = 0; k < live[1].length; k++) m1 += ipRange[live[1][k]]
  const norm = Math.max(m0 * m1 * spec.pot, EPS)
  const exploitability = brSum / 2 / norm

  const solution: PostflopSolution = { tree, avgStrategy, evByAction, exploitability, iterations: done }
  // 调试口：暴露内部 regrets（不进入类型定义）
  ;(solution as unknown as { _regrets: Map<number, Float32Array> })._regrets = regrets
  return solution
}
