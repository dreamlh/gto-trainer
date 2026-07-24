import { useMemo, useRef, useState } from 'react'
import {
  COMBO_A,
  COMBO_B,
  COMBO_CLASS,
} from '../solver/postflop/combos'
import {
  HAND_NAMES,
  RANK_CHARS,
  SUIT_CHARS,
  SUIT_SYMBOLS,
  combosForHand,
  comboIndex,
  makeCard,
  type Card,
} from '../poker/cards'
import { parseRange } from '../poker/rangeParser'
import type { Spot } from '../poker/ranges'
import { buildPostflopTree, type PostDecision, type PostNode } from '../solver/postflop/tree'
import { POSTFLOP_PRESETS } from '../solver/config'
import { solveInWorker, type WorkerNode, type WorkerSolution } from '../workers/workerClient'
import { CardFace } from './CardFace'
import { RangeChart } from './RangeChart'

// 求解器：任意翻后局面的单挑 CFR 求解与策略浏览

const SUIT_COLORS = ['#1b2330', '#d64545', '#3b78d6', '#3f9e5f']
const GUTTER_SUIT_COLORS = ['#c9d2e0', '#d64545', '#3b78d6', '#3f9e5f']

const DEFAULT_OOP = '99-22, A9s-A2s, KTs+, QTs+, JTs, T8s+, 98s, 87s, 76s, ATo+, KQo'
const DEFAULT_IP = '22+, ATs+, KTs+, QTs+, JTs, T9s, A5s-A2s, AQo+, KQo'

function rangeToVector(src: string, board: Card[]): Float32Array {
  const v = new Float32Array(1326)
  for (const [hand, w] of parseRange(src)) {
    for (const [a, b] of combosForHand(hand)) v[comboIndex(a, b)] = w
  }
  for (const c of board) {
    for (let i = 0; i < 1326; i++) {
      if (COMBO_A[i] === c || COMBO_B[i] === c) v[i] = 0
    }
  }
  return v
}

// 把节点组合级策略聚合成 169 类 Spot 给 RangeChart（附带范围权重与文案）
const AGG_KEYS = ['raise', 'threebet', 'fourbet', 'fivebet'] // 攻击性动作复用红色系 key
interface SpotView {
  spot: Spot
  weights: Map<string, number>
  labels: Record<string, string>
}
function nodeToSpot(
  node: WorkerNode,
  actorRange: Float32Array,
  title: string,
  situation: string,
): SpotView {
  const A = node.actions.length
  const strategy = new Map<string, Record<string, number>>()
  const keys: string[] = []
  let agg = 0
  for (const a of node.actions) {
    if (a.kind === 'fold') keys.push('fold')
    else if (a.kind === 'check' || a.kind === 'call') keys.push('call')
    else keys.push(AGG_KEYS[Math.min(agg++, AGG_KEYS.length - 1)])
  }
  const wSum = new Float32Array(169)
  const fSum = new Float32Array(169 * A)
  for (let c = 0; c < 1326; c++) {
    const w = actorRange[c]
    if (w <= 0) continue
    const h = COMBO_CLASS[c]
    wSum[h] += w
    for (let a = 0; a < A; a++) fSum[h * A + a] += w * node.strategy[c * A + a]
  }
  for (let h = 0; h < 169; h++) {
    if (wSum[h] <= 0) continue
    const entry: Record<string, number> = {}
    for (let a = 0; a < A; a++) {
      if (keys[a] === 'fold') continue
      const f = fSum[h * A + a] / wSum[h]
      if (f > 0.004) entry[keys[a]] = f
    }
    strategy.set(HAND_NAMES[h], entry)
  }
  const labels: Record<string, string> = { fold: '弃牌' }
  const actions = node.actions
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => a.kind !== 'fold')
    .map(({ a, i }) => {
      const label =
        a.kind === 'check'
          ? '过牌'
          : a.kind === 'call'
            ? '跟注'
            : a.kind === 'bet'
              ? `下注 ${a.amount}`
              : `加注到 ${a.amount}`
      labels[keys[i]] = label
      return { key: keys[i] as Spot['actions'][number]['key'], label }
    })
  const weights = new Map<string, number>()
  for (let h = 0; h < 169; h++) if (wSum[h] > 0) weights.set(HAND_NAMES[h], wSum[h])
  return {
    spot: {
      id: 'solver-node',
      category: 'rfi',
      hero: 'BTN',
      title,
      situation,
      actions,
      strategy,
    },
    weights,
    labels,
  }
}

export function SolverExplorer({ active = true }: { active?: boolean }) {
  void active
  const [board, setBoard] = useState<Card[]>([])
  const [potStr, setPotStr] = useState('5.5')
  const [stackStr, setStackStr] = useState('97.5')
  const [oopStr, setOopStr] = useState(DEFAULT_OOP)
  const [ipStr, setIpStr] = useState(DEFAULT_IP)
  const [preset, setPreset] = useState<'explorer' | 'trainer'>('explorer')
  const [solving, setSolving] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')
  const [solution, setSolution] = useState<WorkerSolution | null>(null)
  const [solvedMeta, setSolvedMeta] = useState<{
    board: Card[]
    oop: Float32Array
    ip: Float32Array
    pot: number
    stack: number
  } | null>(null)
  const [path, setPath] = useState<number[]>([]) // 动作索引路径（本街内）
  const cancelRef = useRef<(() => void) | null>(null)

  const street = board.length === 3 ? 'flop' : board.length === 4 ? 'turn' : board.length === 5 ? 'river' : null

  const toggleCard = (c: Card) => {
    setError('')
    setBoard((b) => (b.includes(c) ? b.filter((x) => x !== c) : b.length >= 5 ? b : [...b, c]))
  }

  const solve = () => {
    setError('')
    if (!street) {
      setError('请选择 3（翻牌）/ 4（转牌）/ 5（河牌）张公共牌')
      return
    }
    const pot = parseFloat(potStr)
    const stack = parseFloat(stackStr)
    if (!(pot > 0) || !(stack >= 0)) {
      setError('底池与筹码需为正数')
      return
    }
    let oop: Float32Array
    let ip: Float32Array
    try {
      oop = rangeToVector(oopStr, board)
      ip = rangeToVector(ipStr, board)
    } catch (e) {
      setError(`范围解析失败：${(e as Error).message}`)
      return
    }
    if (oop.every((x) => x === 0) || ip.every((x) => x === 0)) {
      setError('范围与公共牌完全冲突')
      return
    }
    setSolving(true)
    setProgress(0)
    setSolution(null)
    setPath([])
    const handle = solveInWorker({
      street,
      board: board.slice(),
      pot,
      stack,
      preset,
      oop,
      ip,
      onProgress: (iter, total) => setProgress(iter / total),
    })
    cancelRef.current = handle.cancel
    handle.promise
      .then((sol) => {
        setSolution(sol)
        setSolvedMeta({ board: board.slice(), oop, ip, pot, stack })
        setSolving(false)
      })
      .catch((e) => {
        setError((e as Error).message === 'cancelled' ? '已取消' : `求解失败：${(e as Error).message}`)
        setSolving(false)
      })
  }

  // 沿动作路径导航（客户端重建树）
  const navigation = useMemo(() => {
    if (!solution || !solvedMeta) return null
    const st = solvedMeta.board.length === 3 ? 'flop' : solvedMeta.board.length === 4 ? 'turn' : 'river'
    const tree = buildPostflopTree({
      street: st,
      board: solvedMeta.board,
      pot: solvedMeta.pot,
      stack: solvedMeta.stack,
      preset: POSTFLOP_PRESETS[preset],
    })
    let node: PostNode = tree.root
    const crumbs: { label: string; upTo: number }[] = []
    // 条件化到当前节点的双方范围
    const oopNow = Float32Array.from(solvedMeta.oop)
    const ipNow = Float32Array.from(solvedMeta.ip)
    for (let i = 0; i < path.length; i++) {
      if (node.type !== 'decision') break
      const dn = node as PostDecision
      const a = dn.actions[path[i]]
      const wn = solution.nodes.find((x) => x.id === dn.id)
      if (wn) {
        const rng = dn.actor === 0 ? oopNow : ipNow
        const A = dn.actions.length
        for (let c = 0; c < 1326; c++) rng[c] *= wn.strategy[c * A + path[i]]
      }
      crumbs.push({
        label: `${dn.actor === 0 ? 'OOP' : 'IP'} ${a.kind === 'check' ? '过牌' : a.kind === 'call' ? '跟注' : a.kind === 'fold' ? '弃牌' : a.kind === 'bet' ? `下注${a.amount}` : `加注${a.amount}`}`,
        upTo: i,
      })
      node = dn.children[path[i]]
    }
    return { node, crumbs, oopNow, ipNow }
  }, [solution, solvedMeta, path, preset])

  const current = navigation?.node
  const currentDecision =
    current && current.type === 'decision' ? (current as PostDecision) : null
  const currentWorkerNode =
    currentDecision && solution ? solution.nodes.find((x) => x.id === currentDecision.id) : null

  const spotView =
    currentDecision && currentWorkerNode && navigation
      ? nodeToSpot(
          currentWorkerNode,
          currentDecision.actor === 0 ? navigation.oopNow : navigation.ipNow,
          `${currentDecision.actor === 0 ? 'OOP' : 'IP'} 策略`,
          '',
        )
      : null

  return (
    <div className="panel">
      <div className="viewer-group" style={{ marginBottom: 10 }}>
        <div className="viewer-group-label">公共牌（{street ? { flop: '翻牌', turn: '转牌', river: '河牌' }[street] : `已选 ${board.length}`}）</div>
        <div className="slot-row">
          {board.map((c) => (
            <button
              key={c}
              className="card-slot card-slot-active"
              onClick={() => toggleCard(c)}
              title="点击移除"
            >
              <CardFace card={c} />
            </button>
          ))}
          {board.length === 0 && <span className="spot-desc">点下方牌堆选择</span>}
        </div>
      </div>
      <div className="deck-grid">
        {SUIT_CHARS.map((_, s) => (
          <div key={s} className="deck-row">
            <span className="deck-suit" style={{ color: GUTTER_SUIT_COLORS[s] }}>
              {SUIT_SYMBOLS[s]}
            </span>
            {RANK_CHARS.map((_, r) => {
              const card = makeCard(12 - r, s)
              const used = board.includes(card)
              return (
                <button
                  key={r}
                  className={`deck-card ${used ? 'deck-card-picked' : ''}`}
                  style={{ color: SUIT_COLORS[s] }}
                  onClick={() => toggleCard(card)}
                >
                  {RANK_CHARS[12 - r]}
                </button>
              )
            })}
          </div>
        ))}
      </div>

      <div className="solver-inputs">
        <label>
          底池
          <input className="range-input num-input" value={potStr} onChange={(e) => setPotStr(e.target.value)} />
        </label>
        <label>
          有效筹码
          <input className="range-input num-input" value={stackStr} onChange={(e) => setStackStr(e.target.value)} />
        </label>
        <div className="mode-toggle">
          <button
            className={`chip-btn ${preset === 'explorer' ? 'chip-btn-active' : ''}`}
            onClick={() => setPreset('explorer')}
          >
            精细（慢）
          </button>
          <button
            className={`chip-btn ${preset === 'trainer' ? 'chip-btn-active' : ''}`}
            onClick={() => setPreset('trainer')}
          >
            快速
          </button>
        </div>
      </div>
      <label className="solver-range-label">
        OOP 范围
        <input className="range-input" value={oopStr} onChange={(e) => setOopStr(e.target.value)} />
      </label>
      <label className="solver-range-label">
        IP 范围
        <input className="range-input" value={ipStr} onChange={(e) => setIpStr(e.target.value)} />
      </label>

      <div className="eq-run-row">
        {!solving ? (
          <button className="primary-btn" onClick={solve}>
            求解
          </button>
        ) : (
          <>
            <button className="primary-btn" disabled>
              求解中 {(progress * 100).toFixed(0)}%
            </button>
            <button className="link-btn" onClick={() => cancelRef.current?.()}>
              取消
            </button>
          </>
        )}
        {street === 'turn' && preset === 'explorer' && !solving && (
          <span className="spot-desc">转牌精细求解约需 1 分钟</span>
        )}
        {error && <span className="input-error">{error}</span>}
      </div>

      {solution && navigation && (
        <div className="solver-result">
          <div className="stats-row">
            <span>
              可利用度 <b>{(solution.exploitability * 100).toFixed(2)}%</b> 底池
            </span>
            <span>
              迭代 <b>{solution.iterations}</b>
            </span>
          </div>
          <div className="viewer-group-buttons" style={{ marginBottom: 8 }}>
            <button className={`chip-btn ${path.length === 0 ? 'chip-btn-active' : ''}`} onClick={() => setPath([])}>
              根节点
            </button>
            {navigation.crumbs.map((c, i) => (
              <button key={i} className="chip-btn chip-btn-active" onClick={() => setPath(path.slice(0, c.upTo + 1))}>
                {c.label}
              </button>
            ))}
          </div>
          {currentDecision && spotView && (
            <>
              <p className="spot-desc">
                轮到 {currentDecision.actor === 0 ? 'OOP' : 'IP'}——点动作继续导航：
                {currentDecision.actions.map((a, i) => (
                  <button key={i} className="chip-btn" style={{ marginLeft: 6 }} onClick={() => setPath([...path, i])}>
                    {a.kind === 'check' ? '过牌' : a.kind === 'call' ? '跟注' : a.kind === 'fold' ? '弃牌' : a.kind === 'bet' ? `下注${a.amount}` : `加注${a.amount}`}
                  </button>
                ))}
              </p>
              <RangeChart spot={spotView.spot} weights={spotView.weights} actionLabels={spotView.labels} />
            </>
          )}
          {current && current.type === 'chance' && (
            <p className="spot-desc">本街行动结束进入下一街。要看后续策略，请把新街牌加入公共牌后重新求解。</p>
          )}
          {current && current.type === 'terminal' && (
            <p className="spot-desc">
              {current.kind === 'fold' ? '一方弃牌，牌局结束。' : current.kind === 'showdown' ? '摊牌。' : '本街结束（翻牌深度受限叶）——加一张转牌后重新求解看后续。'}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
