import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  onHandRecord,
  trainerSession,
  type DecisionRecord,
  type HandRecord,
} from '../game/session'
import { pot, type EnginePlayer, type EngineState } from '../game/engine'
import { ACTION_COLORS } from '../poker/ranges'
import { TableView } from './TableView'

// 全牌局训练器：翻前多人 + 翻后单挑逐街 CFR 求解

const FOLD_BG = 'rgba(92, 124, 186, 0.35)'
const TABLE_SIZES = [2, 3, 4, 5, 6, 7, 8, 9]

const VERDICT_INFO = {
  optimal: { label: '✓ 最优', color: '#1fa78e' },
  acceptable: { label: '~ 可接受', color: '#d9a441' },
  wrong: { label: '✗ 错误', color: '#e2574a' },
} as const

const STREET_LABELS: Record<string, string> = {
  preflop: '翻前',
  flop: '翻牌',
  turn: '转牌',
  river: '河牌',
}

function actionColor(kind: string): string {
  if (kind === 'fold') return '#5c7cba'
  if (kind === 'check' || kind === 'call') return ACTION_COLORS.call
  return ACTION_COLORS.raise
}

function FreqBar({ d }: { d: DecisionRecord }) {
  return (
    <div className="freq-bar freq-bar-slim">
      {d.freqs.map((f, i) => (
        <div
          key={i}
          className="freq-seg"
          style={{
            width: `${Math.max(f * 100, 0)}%`,
            background: i === d.chosen ? undefined : undefined,
            backgroundColor: segColor(d, i),
            outline: i === d.chosen ? '2px solid #e8edf5' : 'none',
          }}
        >
          {f >= 0.14 && (
            <span>
              {d.labels[i]} {(f * 100).toFixed(0)}%
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

function segColor(d: DecisionRecord, i: number): string {
  const label = d.labels[i]
  if (label.includes('弃牌')) return FOLD_BG
  if (label.includes('过牌') || label.includes('跟注')) return ACTION_COLORS.call
  return ACTION_COLORS.raise
}

// 轮到英雄时的一行局面说明：位置 · 面对什么 · 底池 · 需跟注
function describeSpot(eng: EngineState, heroSeat: number): string {
  const hero = eng.players[heroSeat]
  const pos = eng.positions[heroSeat]
  const streetInv = (p: EnginePlayer) => p.invested - p.streetBase
  const maxBet = Math.max(...eng.players.map(streetInv))
  const toCall = Math.max(0, maxBet - streetInv(hero))
  const fmt = (x: number) => (x % 1 === 0 ? `${x}` : x.toFixed(1))
  const raises = eng.history.filter((h) => h.street === eng.street && h.kind !== 'fold' && h.kind !== 'check' && h.kind !== 'call').length
  let facing: string
  if (eng.street === 'preflop') {
    if (raises === 0) facing = '前面无人加注'
    else {
      const aggressor = [...eng.history].reverse().find((h) => h.street === 'preflop' && h.kind === 'raise')!
      const what = raises === 1 ? '开局加注' : raises === 2 ? '3-bet' : raises === 3 ? '4-bet' : '全下'
      facing = `面对 ${eng.positions[aggressor.seat]} ${what}到 ${fmt(maxBet)}bb`
    }
  } else {
    if (raises === 0) facing = toCall > 0 ? `面对下注 ${fmt(maxBet)}bb` : '对手过牌/轮你先动'
    else {
      const aggressor = [...eng.history].reverse().find((h) => h.street === eng.street && (h.kind === 'bet' || h.kind === 'raise'))!
      facing = `面对 ${eng.positions[aggressor.seat]} ${raises === 1 ? '下注' : '加注'}到 ${fmt(maxBet)}bb`
    }
  }
  const call = toCall > 0.001 ? ` · 需跟 ${fmt(toCall)}bb` : ''
  return `轮到你：${pos} · ${facing} · 底池 ${pot(eng).toFixed(1)}bb${call}`
}

// 会话内简单统计（完整统计在数据页）
interface Tally {
  hands: number
  decisions: number
  optimal: number
  wrong: number
  evLossSum: number
  net: number
  netHands: number
}

export function Trainer({ active = true }: { active?: boolean }) {
  const snap = useSyncExternalStore(trainerSession.subscribe, trainerSession.getSnapshot)
  const [tableSize, setTableSize] = useState(6)
  const [preflopOnly, setPreflopOnly] = useState(false)
  const [revealAll, setRevealAll] = useState(false)
  const [tally, setTally] = useState<Tally>({
    hands: 0,
    decisions: 0,
    optimal: 0,
    wrong: 0,
    evLossSum: 0,
    net: 0,
    netHands: 0,
  })
  const started = useRef(false)

  useEffect(() => {
    return onHandRecord((r: HandRecord) => {
      setTally((t) => ({
        hands: t.hands + 1,
        decisions: t.decisions + r.decisions.length,
        optimal: t.optimal + r.decisions.filter((d) => d.verdict === 'optimal').length,
        wrong: t.wrong + r.decisions.filter((d) => d.verdict === 'wrong').length,
        evLossSum: t.evLossSum + r.decisions.reduce((a, d) => a + d.evLoss, 0),
        net: t.net + (r.result.deltaBB ?? 0),
        netHands: t.netHands + (r.result.deltaBB !== null ? 1 : 0),
      }))
    })
  }, [])

  // 首次进入自动开一手
  useEffect(() => {
    if (active && !started.current) {
      started.current = true
      void trainerSession.startHand(tableSize, preflopOnly)
    }
  }, [active, tableSize, preflopOnly])

  // 新一手开始（结果清空）时自动关闭透视
  useEffect(() => {
    if (!snap.result) setRevealAll(false)
  }, [snap.result])

  const newHandClick = useCallback(() => {
    setRevealAll(false)
    void trainerSession.startHand(tableSize, preflopOnly)
  }, [tableSize, preflopOnly])

  // 键盘：数字选动作，回车下一手
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!active) return
      if (e.target instanceof HTMLInputElement) return
      if (snap.phase === 'hero-turn') {
        const idx = parseInt(e.key, 10) - 1
        if (idx >= 0 && idx < snap.heroActions.length) trainerSession.heroAct(idx)
      } else if (snap.phase === 'hand-done' && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault()
        newHandClick()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, snap.phase, snap.heroActions.length, newHandClick])

  const changeSize = (n: number) => {
    setTableSize(n)
    void trainerSession.startHand(n, preflopOnly)
  }
  const togglePreflopOnly = () => {
    const v = !preflopOnly
    setPreflopOnly(v)
    void trainerSession.startHand(tableSize, v)
  }

  const d = snap.lastDecision

  return (
    <div className="trainer">
      <div className="trainer-settings">
        {TABLE_SIZES.map((n) => (
          <button
            key={n}
            className={`chip-btn ${n === tableSize ? 'chip-btn-active' : ''}`}
            onClick={() => changeSize(n)}
          >
            {n}人
          </button>
        ))}
        <button
          className={`chip-btn ${preflopOnly ? 'chip-btn-active' : ''}`}
          onClick={togglePreflopOnly}
        >
          只练翻前
        </button>
        <button className="chip-btn" onClick={newHandClick}>
          ↻ 换一手
        </button>
      </div>

      <div className="stats-row">
        <span>
          本次已练 <b>{tally.hands}</b> 手
        </span>
        <span>
          最优率{' '}
          <b>{tally.decisions ? Math.round((tally.optimal / tally.decisions) * 100) : 0}%</b>
        </span>
        <span>
          平均 EV 损失{' '}
          <b>{tally.decisions ? (tally.evLossSum / tally.decisions).toFixed(2) : '0.00'}bb</b>
        </span>
        <span>
          盈亏 <b>{tally.net >= 0 ? '+' : ''}{tally.net.toFixed(1)}bb</b>（{tally.netHands} 手结算）
        </span>
      </div>

      <div className="panel">
        {snap.error && <p className="input-error">{snap.error}</p>}
        {snap.engine && (
          <TableView
            engine={snap.engine}
            heroSeat={snap.heroSeat}
            toActSeat={snap.toActSeat}
            revealed={
              revealAll && snap.engine
                ? snap.engine.players
                    .filter((p) => p.seat !== snap.heroSeat)
                    .map((p) => ({ seat: p.seat, cards: p.cards }))
                : (snap.result?.revealed ?? [])
            }
            solveProgress={snap.solveProgress}
          />
        )}
        {!snap.engine && !snap.error && <p className="spot-desc">正在加载翻前解…</p>}

        {/* 上一个决策的即时反馈 */}
        {d && snap.phase !== 'hand-done' && (
          <div className="inline-feedback">
            <span style={{ color: VERDICT_INFO[d.verdict].color, fontWeight: 700 }}>
              {VERDICT_INFO[d.verdict].label}
            </span>
            {d.evs && d.evLoss > 0.001 && (
              <span className="verdict-score">EV 损失 {d.evLoss.toFixed(2)}bb</span>
            )}
            <FreqBar d={d} />
          </div>
        )}

        {/* 行动区 */}
        {snap.phase === 'hero-turn' && snap.engine && (
          <p className="turn-hint">{describeSpot(snap.engine, snap.heroSeat)}</p>
        )}
        {snap.phase === 'hero-turn' && (
          <div className="action-row">
            {snap.heroActions.map((a, i) => (
              <button
                key={i}
                className="action-btn"
                style={{ borderColor: actionColor(a.kind) }}
                onClick={() => trainerSession.heroAct(i)}
              >
                <span className="action-key">{i + 1}</span>
                {a.label}
              </button>
            ))}
          </div>
        )}
        {snap.phase === 'bot-thinking' && <p className="phase-hint">对手思考中…</p>}
        {snap.phase === 'solving' && <p className="phase-hint">GTO 求解本街策略中…</p>}

        {/* 结算面板 */}
        {snap.phase === 'hand-done' && snap.result && (
          <div className="hand-summary">
            <div className="verdict">
              {snap.result.deltaBB !== null ? (
                <span style={{ color: snap.result.deltaBB >= 0 ? '#1fa78e' : '#e2574a' }}>
                  {snap.result.deltaBB >= 0 ? '+' : ''}
                  {snap.result.deltaBB.toFixed(1)} bb
                </span>
              ) : (
                <span style={{ color: '#d9a441' }}>本手不计盈亏</span>
              )}
              {snap.result.note && <span className="verdict-score">{snap.result.note}</span>}
              {snap.result.heroFolded && <span className="verdict-score">你已弃牌</span>}
              {snap.result.wentToShowdown && <span className="verdict-score">摊牌</span>}
            </div>
            {snap.decisions.length > 0 && (
              <div className="decision-list">
                {snap.decisions.map((dec, i) => (
                  <div key={i} className="decision-item">
                    <span className="decision-street">{STREET_LABELS[dec.street]}</span>
                    <span style={{ color: VERDICT_INFO[dec.verdict].color, minWidth: 72 }}>
                      {VERDICT_INFO[dec.verdict].label}
                    </span>
                    <span className="decision-chosen">{dec.labels[dec.chosen]}</span>
                    {dec.evs && dec.evLoss > 0.001 && (
                      <span className="verdict-score">-{dec.evLoss.toFixed(2)}bb</span>
                    )}
                    <FreqBar d={dec} />
                  </div>
                ))}
              </div>
            )}
            {snap.decisions.length === 0 && !snap.result.note && (
              <p className="spot-desc">本手没轮到你决策。</p>
            )}
            <div className="feedback-actions">
              <button className="primary-btn" onClick={newHandClick}>
                下一手（回车）
              </button>
              {!revealAll && (
                <button className="link-btn" onClick={() => setRevealAll(true)}>
                  查看对手底牌
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
