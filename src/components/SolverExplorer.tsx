import { useEffect, useMemo, useRef, useState } from 'react'
import {
  COMBO_CLASS,
} from '../solver/postflop/combos'
import {
  HAND_NAMES,
  RANK_CHARS,
  SUIT_CHARS,
  SUIT_SYMBOLS,
  makeCard,
  handNameOf,
  type Card,
} from '../poker/cards'
import type { Spot } from '../poker/ranges'
import { buildPostflopTree, type PostDecision, type PostNode } from '../solver/postflop/tree'
import { POSTFLOP_PRESETS } from '../solver/config'
import { solveInWorker, type WorkerNode, type WorkerSolution } from '../workers/workerClient'
import { CardFace } from './CardFace'
import { RangeChart } from './RangeChart'
import { useLanguage } from '../battle/i18n'
import { postflopActionName, translatePokerText } from '../poker/presentation'
import { compatibleRanges, emptyRange, maskRange } from '../analysis/ranges'
import { orderedPlayers, solverBlock } from '../analysis/replay'
import type { AnalysisContext } from '../analysis/types'
import { RangeEditor } from './RangeEditor'
import { ScenarioPicker } from './ScenarioPicker'
import { AnalysisNotice, useSolverBlockLabel } from './AnalysisNotice'

// 求解器：任意翻后局面的单挑 CFR 求解与策略浏览

const SUIT_COLORS = ['#1b2330', '#d64545', '#3b78d6', '#3f9e5f']
const GUTTER_SUIT_COLORS = ['#c9d2e0', '#d64545', '#3b78d6', '#3f9e5f']

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
      const label = postflopActionName(a, 'zh')
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

export function SolverExplorer({ active = true, context }: { active?: boolean; context?: AnalysisContext | null }) {
  void active
  const { language, t } = useLanguage()
  const [board, setBoard] = useState<Card[]>([])
  const [potStr, setPotStr] = useState('5.5')
  const [stackStr, setStackStr] = useState('97.5')
  const [oopRange, setOopRange] = useState(emptyRange)
  const [ipRange, setIpRange] = useState(emptyRange)
  const [autoScenario, setAutoScenario] = useState(true)
  const [review, setReview] = useState<AnalysisContext | null>(null)
  const [positions, setPositions] = useState<[string, string]>(['BB', 'BTN'])
  const blockLabel = useSolverBlockLabel()
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
    preset: 'explorer' | 'trainer'
  } | null>(null)
  const [path, setPath] = useState<number[]>([]) // 动作索引路径（本街内）
  const cancelRef = useRef<(() => void) | null>(null)
  const generation = useRef(0)
  useEffect(() => {
    generation.current++; cancelRef.current?.(); cancelRef.current = null
    setSolution(null); setSolvedMeta(null); setPath([]); setSolving(false); setProgress(0); setError('')
  }, [board, potStr, stackStr, oopRange, ipRange, preset])
  useEffect(() => () => { generation.current++; cancelRef.current?.() }, [])
  useEffect(() => {
    if (!context) return
    generation.current++; cancelRef.current?.(); setReview(context)
    setBoard(context.board.slice()); setPotStr(context.pot === null ? '' : String(context.pot))
    const players = orderedPlayers(context)
    setOopRange(players[0]?.range ?? emptyRange()); setIpRange(players[1]?.range ?? emptyRange())
    setPositions([players[0]?.position ?? 'OOP', players[1]?.position ?? 'IP'])
    setStackStr(players.length === 2 && players.every(p => p.stack !== null) ? String(Math.min(...players.map(p => p.stack!))) : '')
  }, [context])

  const street = board.length === 3 ? 'flop' : board.length === 4 ? 'turn' : board.length === 5 ? 'river' : null

  const toggleCard = (c: Card) => {
    setError('')
    setBoard((b) => (b.includes(c) ? b.filter((x) => x !== c) : b.length >= 5 ? b : [...b, c]))
  }

  const solve = () => {
    setError('')
    const blocked = review && solverBlock(review)
    if (blocked) { setError(blockLabel(blocked)); return }
    if (!street) {
      setError('请选择 3（翻牌）/ 4（转牌）/ 5（河牌）张公共牌')
      return
    }
    const pot = Number(potStr)
    const stack = Number(stackStr)
    if (!Number.isFinite(pot) || !Number.isFinite(stack) || !(pot > 0) || !(stack > 0)) {
      setError('底池与筹码需为正数')
      return
    }
    let oop: Float32Array
    let ip: Float32Array
    try {
      oop = maskRange(oopRange, board)
      ip = maskRange(ipRange, board)
    } catch (e) {
      setError(`范围解析失败：${(e as Error).message}`)
      return
    }
    if (!compatibleRanges(oop, ip)) {
      setError(t('没有互不冲突的有效组合，请选择或调整双方范围。', 'No compatible combinations remain. Select or adjust both ranges.'))
      return
    }
    setSolving(true)
    setProgress(0)
    setSolution(null)
    setPath([])
    const gen = ++generation.current
    const handle = solveInWorker({
      street,
      board: board.slice(),
      pot,
      stack,
      preset,
      oop,
      ip,
      onProgress: (iter, total) => { if (gen === generation.current) setProgress(iter / total) },
    })
    cancelRef.current = handle.cancel
    handle.promise
      .then((sol) => {
        if (gen !== generation.current) return
        setSolution(sol)
        setSolvedMeta({ board: board.slice(), oop, ip, pot, stack, preset })
        setSolving(false)
        cancelRef.current = null
      })
      .catch((e) => {
        if (gen !== generation.current) return
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
      preset: POSTFLOP_PRESETS[solvedMeta.preset],
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
        label: `${dn.actor === 0 ? t('先行动 OOP', 'First to act · OOP') : t('后行动 IP', 'Last to act · IP')} ${postflopActionName(a, language)}`,
        upTo: i,
      })
      node = dn.children[path[i]]
    }
    return { node, crumbs, oopNow, ipNow }
  }, [solution, solvedMeta, path, language])

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
          `${currentDecision.actor === 0 ? t('先行动 OOP', 'First to act · OOP') : t('后行动 IP', 'Last to act · IP')} ${t('策略', 'strategy')}`,
          '',
        )
      : null

  return (
    <div className="panel">
      <p className="spot-desc">{t('求解器：根据双方范围、底池和有效筹码，计算各动作的近似策略频率。', 'The solver calculates approximate action frequencies from both ranges, the pot and effective stacks.')}</p>
      {review && <AnalysisNotice context={review} onClear={() => { setReview(null); setSolution(null) }} />}
      <ScenarioPicker autoApply={!context && autoScenario} onApply={scenario => {
        setReview(null); setOopRange(scenario.ranges[0]); setIpRange(scenario.ranges[1]); setPositions(scenario.positions)
        setPotStr(String(scenario.pot)); setStackStr(String(scenario.stack))
      }} />
      <div className="viewer-group" style={{ marginBottom: 10 }}>
        <div className="viewer-group-label">{t('公共牌', 'Board')} ({street ? { flop: t('翻牌', 'Flop'), turn: t('转牌', 'Turn'), river: t('河牌', 'River') }[street] : t(`已选 ${board.length}`, `${board.length} selected`)})</div>
        <div className="slot-row">
          {board.map((c) => (
            <button
              key={c}
              className="card-slot card-slot-active"
              onClick={() => toggleCard(c)}
              title={t('点击移除', 'Click to remove')}
            >
              <CardFace card={c} />
            </button>
          ))}
          {board.length === 0 && <span className="spot-desc">{t('点下方牌堆选择', 'Choose cards from the deck below')}</span>}
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
                  aria-label={`${RANK_CHARS[12 - r]}${SUIT_SYMBOLS[s]}`}
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
          {t('底池', 'Pot')} (BB)
          <input className="range-input num-input" value={potStr} onChange={(e) => { setAutoScenario(false); setPotStr(e.target.value) }} />
        </label>
        <label>
          {t('有效筹码', 'Effective stack')} (BB)
          <input className="range-input num-input" value={stackStr} onChange={(e) => { setAutoScenario(false); setStackStr(e.target.value) }} />
        </label>
        <div className="mode-toggle">
          <button
            className={`chip-btn ${preset === 'explorer' ? 'chip-btn-active' : ''}`}
            onClick={() => setPreset('explorer')}
          >
            {t('精细（慢）', 'Detailed (slower)')}
          </button>
          <button
            className={`chip-btn ${preset === 'trainer' ? 'chip-btn-active' : ''}`}
            onClick={() => setPreset('trainer')}
          >
            {t('快速', 'Quick')}
          </button>
        </div>
      </div>
      <div className="analysis-columns">
        <RangeEditor label={`${positions[0]} · ${t('先行动 OOP 范围', 'First to act · OOP range')}`} value={oopRange} dead={board} onChange={range => { setAutoScenario(false); setOopRange(range) }} />
        <RangeEditor label={`${positions[1]} · ${t('后行动 IP 范围', 'Last to act · IP range')}`} value={ipRange} dead={board} onChange={range => { setAutoScenario(false); setIpRange(range) }} />
      </div>

      <div className="eq-run-row">
        {!solving ? (
          <button className="primary-btn" onClick={solve}>
            {t('求解', 'Solve')}
          </button>
        ) : (
          <>
            <button className="primary-btn" disabled>
              {t('求解中', 'Solving')} {(progress * 100).toFixed(0)}%
            </button>
            <button className="link-btn" onClick={() => { generation.current++; cancelRef.current?.(); cancelRef.current = null; setSolving(false); setError(t('已取消', 'Cancelled')) }}>
              {t('取消', 'Cancel')}
            </button>
          </>
        )}
        {street === 'turn' && preset === 'explorer' && !solving && (
          <span className="spot-desc">{t('转牌精细求解约需 1 分钟', 'A detailed turn solve takes about 1 minute')}</span>
        )}
        {error && <span className="input-error">{translatePokerText(error, language)}</span>}
      </div>

      {solution && navigation && (
        <div className="solver-result">
          <div className="stats-row">
            <span>
              {t('可利用度', 'Exploitability')} <b>{(solution.exploitability * 100).toFixed(2)}%</b> {t('底池', 'of pot')}
            </span>
            <span>
              {t('迭代', 'Iterations')} <b>{solution.iterations}</b>
            </span>
          </div>
          <div className="viewer-group-buttons" style={{ marginBottom: 8 }}>
            <button className={`chip-btn ${path.length === 0 ? 'chip-btn-active' : ''}`} onClick={() => setPath([])}>
              {t('根节点', 'Root')}
            </button>
            {navigation.crumbs.map((c, i) => (
              <button key={i} className="chip-btn chip-btn-active" onClick={() => setPath(path.slice(0, c.upTo + 1))}>
                {translatePokerText(c.label, language)}
              </button>
            ))}
          </div>
          {currentDecision && spotView && (
            <>
              <p className="spot-desc">
                {t(`轮到${currentDecision.actor === 0 ? '先行动方 OOP' : '后行动方 IP'}，点动作继续导航：`, `${currentDecision.actor === 0 ? 'First to act · OOP' : 'Last to act · IP'}. Choose an action to explore:`)}
                {currentDecision.actions.map((a, i) => (
                  <button key={i} className="chip-btn" style={{ marginLeft: 6 }} onClick={() => setPath([...path, i])}>
                    {postflopActionName(a, language)}
                  </button>
                ))}
              </p>
              <RangeChart spot={spotView.spot} weights={spotView.weights} actionLabels={spotView.labels}
                highlight={review && orderedPlayers(review)[currentDecision.actor]?.id === review.heroId && orderedPlayers(review)[currentDecision.actor]?.cards
                  ? handNameOf(...orderedPlayers(review)[currentDecision.actor].cards!) : undefined} />
            </>
          )}
          {current && current.type === 'chance' && (
            <p className="spot-desc">{t('本街行动结束进入下一街。要看后续策略，请把新街牌加入公共牌后重新求解。', 'This betting round is complete. Add the next board card and solve again to explore the next street.')}</p>
          )}
          {current && current.type === 'terminal' && (
            <p className="spot-desc">
              {current.kind === 'fold' ? t('一方弃牌，牌局结束。', 'A player folded. The hand is over.') : current.kind === 'showdown' ? t('摊牌。', 'Showdown.') : t('本街结束（翻牌深度受限叶）——加一张转牌后重新求解看后续。', 'This is the end of the depth-limited flop tree. Add a turn card and solve again to continue.')}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
