import { PREFLOP_CFR, postflopOrder, realizationFactor, sharpenEquity } from '../config'
import { BASE_DIST, BETA, BETAEQ, matvec169, vecSum } from './leaf'
import type { PfDecisionNode, PfNode, PfTerminalNode, PfTree } from './tree'

// 向量 CFR+（regret-matching+，线性加权平均策略，交替更新）
// reach 向量以 q(h)=n_h/1326 初始化；阻断牌经 BETA 矩阵进入摊牌/翻牌叶子；
// 弃牌叶与已弃玩家用标量质量（阻断影响二阶，换 O(169) 求值）

export interface PreflopSolution {
  tree: PfTree
  avgStrategy: Map<number, Float32Array> // nodeId -> 169*A 归一化频率
  evByAction: Map<number, Float32Array> // nodeId -> 169*A 每手牌每动作 EV（bb，条件于到达）
  nodeReach: Map<number, number> // nodeId -> 公共序列到达质量（存储裁剪用）
  iterations: number
  exploitability?: number // 仅 HU（bb/手）
}

const EPS = 1e-12

export function solvePreflop(
  tree: PfTree,
  opts: { iterations?: number; onProgress?: (iter: number, total: number) => void } = {},
): PreflopSolution {
  const T = opts.iterations ?? PREFLOP_CFR.iterations
  const n = tree.n
  const pfIdx = postflopOrder(tree.positions)

  // 求解器状态
  const regrets = new Map<number, Float32Array>()
  const stratSum = new Map<number, Float32Array>()
  for (const node of tree.decisionNodes) {
    regrets.set(node.id, new Float32Array(169 * node.actions.length))
    stratSum.set(node.id, new Float32Array(169 * node.actions.length))
  }

  // 翻牌叶的实现系数（按 active 对齐）
  const flopR = new Map<number, number[]>()
  for (const t of tree.terminals) {
    if (t.kind === 'flop') {
      const idxs = t.active.map((s) => pfIdx[s])
      flopR.set(
        t.id,
        t.active.map((s) => {
          const spr = (tree.ladder.stack - t.invested[s]) / t.pot
          return realizationFactor(pfIdx[s], idxs, spr)
        }),
      )
    }
  }

  // 深度池：每层最多 3 个动作的 cfv 缓冲 + reach 修改缓冲 + σ 缓冲
  let maxDepth = 0
  ;(function depth(node: PfNode, d: number) {
    maxDepth = Math.max(maxDepth, d)
    if (node.type === 'decision') for (const c of node.children) depth(c, d + 1)
  })(tree.root, 0)
  const cfvPool: Float32Array[][] = []
  const reachPool: Float32Array[] = []
  const sigmaPool: Float32Array[] = []
  for (let d = 0; d <= maxDepth + 1; d++) {
    cfvPool.push([new Float32Array(169), new Float32Array(169), new Float32Array(169)])
    reachPool.push(new Float32Array(169))
    sigmaPool.push(new Float32Array(169 * 3))
  }

  // 终端求值 scratch
  const tmpEq = new Float32Array(169)
  const tmpM = new Float32Array(169)
  const upotP = new Float32Array(169)
  const upotK = new Float32Array(169)
  const massP = new Float32Array(169)

  const reaches: Float32Array[] = []
  for (let i = 0; i < n; i++) reaches.push(new Float32Array(169))

  // 当前策略：regret-matching+，写入 out（169*A），返回无
  function currentSigma(node: PfDecisionNode, out: Float32Array) {
    const A = node.actions.length
    const R = regrets.get(node.id)!
    for (let h = 0; h < 169; h++) {
      let s = 0
      for (let a = 0; a < A; a++) s += R[h * A + a]
      if (s <= EPS) {
        for (let a = 0; a < A; a++) out[h * A + a] = 1 / A
      } else {
        for (let a = 0; a < A; a++) out[h * A + a] = R[h * A + a] / s
      }
    }
  }

  // 终端 cfv（对更新玩家 p），写入 out
  function evalTerminal(t: PfTerminalNode, p: number, out: Float32Array) {
    out.fill(0)
    // 已弃牌玩家的标量质量乘积（不含 p）
    let mFold = 1
    for (let j = 0; j < n; j++) {
      if (j === p || t.active.includes(j)) continue
      mFold *= vecSum(reaches[j])
    }
    if (mFold < EPS) return

    const pIdx = t.active.indexOf(p)
    if (pIdx < 0) {
      // p 已弃牌：u = -inv_p × 所有其他人的标量质量
      let m = mFold
      for (const j of t.active) m *= vecSum(reaches[j])
      const u = -t.invested[p] * m
      out.fill(u)
      return
    }

    if (t.kind === 'foldwin') {
      const u = (t.pot - t.invested[p]) * mFold
      out.fill(u)
      return
    }

    const opps = t.active.filter((j) => j !== p)
    const R = t.kind === 'flop' ? flopR.get(t.id)![pIdx] : 1

    // 低到达质量早退（深层 4bet/5bet 线路大多可跳）
    let mActive = 1
    for (const j of opps) mActive *= vecSum(reaches[j])
    if (mActive * mFold < PREFLOP_CFR.pruneReachMass) return

    const isFlop = t.kind === 'flop'

    if (t.active.length === 2) {
      // 两人：成对权益；翻牌叶做权益锐化，全下摊牌用精确权益
      const o = opps[0]
      matvec169(BETAEQ, reaches[o], tmpEq)
      matvec169(BETA, reaches[o], tmpM)
      const pot = t.pot
      const inv = t.invested[p]
      if (isFlop) {
        for (let h = 0; h < 169; h++) {
          const m = tmpM[h]
          const share = m > EPS ? sharpenEquity(tmpEq[h] / m) : 0
          out[h] = (R * pot * share - inv) * m * mFold
        }
      } else {
        for (let h = 0; h < 169; h++) {
          out[h] = (R * pot * tmpEq[h] - inv * tmpM[h]) * mFold
        }
      }
      return
    }

    // 多人：两两权益乘积，份额 = 自己的乘积 / (自己的乘积 + 其他人乘积的范围均值之和)。
    // 逐手牌有界（<1），范围均值上仍近似零和。早先用 upot/Z（Z=全员均值之和）时强牌份额可 >1，
    // 三人 3bet 底池对强范围是「凭空造钱」，盲注冷跟分支一放开就被 CFR 榨到 UTG AA 开局 EV 32bb。
    const eqCache = new Map<number, Float32Array>()
    const mCache = new Map<number, Float32Array>()
    for (const j of t.active) {
      const e = new Float32Array(169)
      const m = new Float32Array(169)
      matvec169(BETAEQ, reaches[j], e)
      matvec169(BETA, reaches[j], m)
      eqCache.set(j, e)
      mCache.set(j, m)
    }
    const sharp = (e: number) => (isFlop ? sharpenEquity(e) : e)
    upotP.fill(1)
    massP.fill(1)
    for (const j of opps) {
      const e = eqCache.get(j)!
      const m = mCache.get(j)!
      for (let h = 0; h < 169; h++) {
        upotP[h] *= sharp(e[h] / Math.max(m[h], EPS))
        massP[h] *= m[h]
      }
    }
    let others = 0 // 其他人 upot 的范围均值之和
    for (const k of t.active) {
      if (k === p) continue
      let upotSum = 0
      let reachSum = 0
      upotK.fill(1)
      for (const j of t.active) {
        if (j === k) continue
        const e = eqCache.get(j)!
        const m = mCache.get(j)!
        for (let h = 0; h < 169; h++) upotK[h] *= sharp(e[h] / Math.max(m[h], EPS))
      }
      for (let h = 0; h < 169; h++) {
        upotSum += reaches[k][h] * upotK[h]
        reachSum += reaches[k][h]
      }
      others += upotSum / Math.max(reachSum, EPS)
    }
    others = Math.max(others, EPS)
    const pot = t.pot
    const inv = t.invested[p]
    for (let h = 0; h < 169; h++) {
      const share = upotP[h] / (upotP[h] + others)
      out[h] = (R * pot * share - inv) * massP[h] * mFold
    }
  }

  // 主遍历：返回 p 的 cfv（写入 out）
  function traverse(node: PfNode, p: number, depth: number, iterWeight: number, out: Float32Array) {
    if (node.type === 'terminal') {
      evalTerminal(node, p, out)
      return
    }
    const q = node.actor
    const A = node.actions.length
    const sigma = sigmaPool[depth]
    currentSigma(node, sigma)

    if (q !== p) {
      out.fill(0)
      const saved = reaches[q]
      const buf = reachPool[depth]
      const child = cfvPool[depth][0]
      for (let a = 0; a < A; a++) {
        for (let h = 0; h < 169; h++) {
          buf[h] = saved[h] * sigma[h * A + a]
        }
        // 注意：CFR 遍历不可按质量剪枝子树——零概率线路后的己方节点仍需
        // 累积平均策略，否则平均被冻结在早期状态、可被 BR 收割（翻后实测教训）。
        // 终端的零质量早退在 evalTerminal 内部处理（保住性能）。
        reaches[q] = buf
        traverse(node.children[a], p, depth + 1, iterWeight, child)
        reaches[q] = saved
        for (let h = 0; h < 169; h++) out[h] += child[h]
      }
      return
    }

    // p 自己的节点
    const saved = reaches[p]
    const buf = reachPool[depth]
    for (let a = 0; a < A; a++) {
      for (let h = 0; h < 169; h++) buf[h] = saved[h] * sigma[h * A + a]
      reaches[p] = buf
      traverse(node.children[a], p, depth + 1, iterWeight, cfvPool[depth][a])
      reaches[p] = saved
    }
    const R = regrets.get(node.id)!
    const S = stratSum.get(node.id)!
    for (let h = 0; h < 169; h++) {
      let v = 0
      for (let a = 0; a < A; a++) v += sigma[h * A + a] * cfvPool[depth][a][h]
      out[h] = v
      for (let a = 0; a < A; a++) {
        const r = R[h * A + a] + cfvPool[depth][a][h] - v
        R[h * A + a] = r > 0 ? r : 0
        S[h * A + a] += iterWeight * saved[h] * sigma[h * A + a]
      }
    }
  }

  // ============ 主循环 ============
  // 线性平均但跳过前 1/4 迭代：早期均匀策略会给「后来再也不走的线路」留下冻结的平均
  // （AA 冷跟开局再面对 squeeze 之类），延迟平均让这些手牌的 stratSum 归零，走下面的 EV 兜底。
  const avgDelay = Math.floor(T * PREFLOP_CFR.averagingDelayFrac)
  const rootBuf = new Float32Array(169)
  for (let t = 1; t <= T; t++) {
    const iterWeight = Math.max(0, t - avgDelay)
    for (let p = 0; p < n; p++) {
      for (let i = 0; i < n; i++) reaches[i].set(BASE_DIST)
      traverse(tree.root, p, 0, iterWeight, rootBuf)
    }
    if (opts.onProgress && t % 50 === 0) opts.onProgress(t, T)
  }

  // ============ 平均策略 ============
  // 从未到达的手牌（如 AA 冷跟开局后面对 squeeze——AA 根本不冷跟）没有累积过策略，
  // 先填均匀，EV 提取后再改成 EV 最优动作的 one-hot（它们 reach 为零，不影响他人 EV）。
  const avgStrategy = new Map<number, Float32Array>()
  const unreached = new Map<number, boolean[]>() // nodeId -> 每手牌是否从未到达
  for (const node of tree.decisionNodes) {
    const A = node.actions.length
    const S = stratSum.get(node.id)!
    const avg = new Float32Array(169 * A)
    const ur = new Array<boolean>(169).fill(false)
    for (let h = 0; h < 169; h++) {
      let s = 0
      for (let a = 0; a < A; a++) s += S[h * A + a]
      if (s <= EPS) {
        ur[h] = true
        for (let a = 0; a < A; a++) avg[h * A + a] = 1 / A
      } else {
        for (let a = 0; a < A; a++) avg[h * A + a] = S[h * A + a] / s
      }
    }
    avgStrategy.set(node.id, avg)
    unreached.set(node.id, ur)
  }

  // ============ EV 提取 + 公共到达质量（用平均策略各跑一遍）============
  const evByAction = new Map<number, Float32Array>()
  const nodeReach = new Map<number, number>()
  for (const node of tree.decisionNodes)
    evByAction.set(node.id, new Float32Array(169 * node.actions.length))

  function evalPass(node: PfNode, p: number, depth: number, out: Float32Array) {
    if (node.type === 'terminal') {
      evalTerminal(node, p, out)
      return
    }
    const q = node.actor
    const A = node.actions.length
    const sigma = avgStrategy.get(node.id)!
    if (q === p) {
      // 记录公共到达质量（所有玩家标量质量乘积）
      let m = 1
      for (let j = 0; j < n; j++) m *= vecSum(reaches[j])
      nodeReach.set(node.id, Math.max(nodeReach.get(node.id) ?? 0, m))
      // 归一化因子：对手标量质量乘积（对所有 h 相同，忽略阻断——动作间一致，不影响 EV 差值）
      let norm = 1
      for (let j = 0; j < n; j++) if (j !== p) norm *= vecSum(reaches[j])
      norm = Math.max(norm, EPS)
      const EV = evByAction.get(node.id)!
      const saved = reaches[p]
      const buf = reachPool[depth]
      for (let a = 0; a < A; a++) {
        for (let h = 0; h < 169; h++) buf[h] = saved[h] * sigma[h * A + a]
        reaches[p] = buf
        evalPass(node.children[a], p, depth + 1, cfvPool[depth][a])
        reaches[p] = saved
        for (let h = 0; h < 169; h++) EV[h * A + a] = cfvPool[depth][a][h] / norm
      }
      out.fill(0)
      for (let h = 0; h < 169; h++) {
        let v = 0
        for (let a = 0; a < A; a++) v += sigma[h * A + a] * cfvPool[depth][a][h]
        out[h] = v
      }
      return
    }
    out.fill(0)
    const saved = reaches[q]
    const buf = reachPool[depth]
    const child = cfvPool[depth][0]
    for (let a = 0; a < A; a++) {
      let mass = 0
      for (let h = 0; h < 169; h++) {
        buf[h] = saved[h] * sigma[h * A + a]
        mass += buf[h]
      }
      if (mass < PREFLOP_CFR.pruneReachMass) continue
      reaches[q] = buf
      evalPass(node.children[a], p, depth + 1, child)
      reaches[q] = saved
      for (let h = 0; h < 169; h++) out[h] += child[h]
    }
  }

  const selfValue: number[] = []
  for (let p = 0; p < n; p++) {
    for (let i = 0; i < n; i++) reaches[i].set(BASE_DIST)
    evalPass(tree.root, p, 0, rootBuf)
    let v = 0
    for (let h = 0; h < 169; h++) v += BASE_DIST[h] * rootBuf[h]
    selfValue.push(v)
  }
  // 未到达手牌：改成 EV 最优动作的 one-hot（见平均策略处注释）
  for (const node of tree.decisionNodes) {
    const A = node.actions.length
    const ur = unreached.get(node.id)!
    const avg = avgStrategy.get(node.id)!
    const EV = evByAction.get(node.id)!
    for (let h = 0; h < 169; h++) {
      if (!ur[h]) continue
      let best = 0
      for (let a = 1; a < A; a++) if (EV[h * A + a] > EV[h * A + best]) best = a
      for (let a = 0; a < A; a++) avg[h * A + a] = a === best ? 1 : 0
    }
  }

  // ============ HU 可利用度 ============
  let exploitability: number | undefined
  if (n === 2) {
    function brPass(node: PfNode, p: number, depth: number, out: Float32Array) {
      if (node.type === 'terminal') {
        evalTerminal(node, p, out)
        return
      }
      const q = node.actor
      const A = node.actions.length
      const sigma = avgStrategy.get(node.id)!
      if (q === p) {
        const saved = reaches[p]
        for (let a = 0; a < A; a++) {
          // BR 不需要 p 的 reach 演化（只取 max），保持 reach 不变即可
          brPass(node.children[a], p, depth + 1, cfvPool[depth][a])
        }
        void saved
        for (let h = 0; h < 169; h++) {
          let best = -Infinity
          for (let a = 0; a < A; a++) best = Math.max(best, cfvPool[depth][a][h])
          out[h] = best
        }
        return
      }
      out.fill(0)
      const saved = reaches[q]
      const buf = reachPool[depth]
      const child = cfvPool[depth][0]
      for (let a = 0; a < A; a++) {
        let mass = 0
        for (let h = 0; h < 169; h++) {
          buf[h] = saved[h] * sigma[h * A + a]
          mass += buf[h]
        }
        if (mass < EPS) continue
        reaches[q] = buf
        brPass(node.children[a], p, depth + 1, child)
        reaches[q] = saved
        for (let h = 0; h < 169; h++) out[h] += child[h]
      }
    }
    // 实现系数使博弈非严格零和，可利用度 = 平均 (BR_p − 自值_p)
    let total = 0
    for (let p = 0; p < 2; p++) {
      for (let i = 0; i < n; i++) reaches[i].set(BASE_DIST)
      brPass(tree.root, p, 0, rootBuf)
      let br = 0
      for (let h = 0; h < 169; h++) br += BASE_DIST[h] * rootBuf[h]
      total += br - selfValue[p]
    }
    exploitability = total / 2
  }

  return { tree, avgStrategy, evByAction, nodeReach, iterations: T, exploitability }
}
