import { useMemo, useState } from 'react'
import {
  RANK_CHARS,
  SUIT_CHARS,
  SUIT_SYMBOLS,
  combosForHand,
  makeCard,
  type Card,
} from '../poker/cards'
import { computeEquity, type EquityResult, type PlayerSpec } from '../poker/equity'
import { parseRange } from '../poker/rangeParser'
import { CardFace } from './CardFace'

const SUIT_COLORS = ['#1b2330', '#d64545', '#3b78d6', '#3f9e5f']
// 左侧花色栏在深色背景上，黑桃用浅色
const GUTTER_SUIT_COLORS = ['#c9d2e0', '#d64545', '#3b78d6', '#3f9e5f']

const PRESETS: { label: string; range: string }[] = [
  { label: '超强牌 QQ+/AK', range: 'QQ+, AKs, AKo' },
  { label: '紧凶开局', range: '77+, ATs+, KTs+, QTs+, JTs, T9s, 98s, AJo+, KQo' },
  {
    label: '按钮位开局',
    range: '22+, A2s+, K7s+, Q8s+, J8s+, T8s+, 97s+, 87s, 76s, 65s, 54s, A5o+, KTo+, QTo+, JTo',
  },
]

type Mode = 'cards' | 'range'
type SlotRef = { who: 'p1' | 'p2' | 'board'; idx: number }

interface PlayerState {
  mode: Mode
  cards: (Card | null)[]
  range: string
}

function rangeInfo(src: string): { combos: number; error?: string } {
  if (!src.trim()) return { combos: 0, error: '请输入范围' }
  try {
    const parsed = parseRange(src)
    let n = 0
    for (const [h, w] of parsed) n += combosForHand(h).length * w
    return { combos: Math.round(n) }
  } catch (e) {
    return { combos: 0, error: (e as Error).message }
  }
}

export function EquityCalc() {
  const [p1, setP1] = useState<PlayerState>({ mode: 'cards', cards: [null, null], range: '' })
  const [p2, setP2] = useState<PlayerState>({
    mode: 'range',
    cards: [null, null],
    range: '22+, A2s+, K7s+, Q8s+, J8s+, T8s+, 97s+, 87s, 76s, 65s, 54s, A5o+, KTo+, QTo+, JTo',
  })
  const [board, setBoard] = useState<(Card | null)[]>([null, null, null, null, null])
  const [active, setActive] = useState<SlotRef | null>({ who: 'p1', idx: 0 })
  const [result, setResult] = useState<EquityResult | null>(null)
  const [computing, setComputing] = useState(false)
  const [error, setError] = useState('')

  const used = useMemo(() => {
    const s = new Set<Card>()
    for (const c of [...p1.cards, ...p2.cards, ...board]) if (c !== null) s.add(c)
    return s
  }, [p1.cards, p2.cards, board])

  function setSlot(ref: SlotRef, card: Card | null) {
    setResult(null)
    if (ref.who === 'board') {
      const b = board.slice()
      b[ref.idx] = card
      setBoard(b)
    } else {
      const st = ref.who === 'p1' ? p1 : p2
      const cards = st.cards.slice()
      cards[ref.idx] = card
      ;(ref.who === 'p1' ? setP1 : setP2)({ ...st, cards })
    }
  }

  // 依次找下一个空槽
  function advance(from: SlotRef) {
    const seq: SlotRef[] = []
    if (p1.mode === 'cards') seq.push({ who: 'p1', idx: 0 }, { who: 'p1', idx: 1 })
    if (p2.mode === 'cards') seq.push({ who: 'p2', idx: 0 }, { who: 'p2', idx: 1 })
    for (let i = 0; i < 5; i++) seq.push({ who: 'board', idx: i })
    const cur = seq.findIndex((s) => s.who === from.who && s.idx === from.idx)
    for (let i = 1; i <= seq.length; i++) {
      const s = seq[(cur + i) % seq.length]
      const filled =
        s.who === 'board'
          ? board[s.idx] !== null
          : (s.who === 'p1' ? p1 : p2).cards[s.idx] !== null
      if (!filled && !(s.who === from.who && s.idx === from.idx)) {
        setActive(s)
        return
      }
    }
    setActive(null)
  }

  function pickCard(card: Card) {
    if (!active || used.has(card)) return
    setSlot(active, card)
    advance(active)
  }

  function clearSlot(ref: SlotRef) {
    setSlot(ref, null)
    setActive(ref)
  }

  function buildSpec(st: PlayerState, label: string): PlayerSpec | string {
    if (st.mode === 'cards') {
      if (st.cards[0] === null || st.cards[1] === null) return `请为${label}选择两张牌`
      return { type: 'cards', cards: [st.cards[0], st.cards[1]] }
    }
    const info = rangeInfo(st.range)
    if (info.error) return `${label}范围有误：${info.error}`
    const combos = [...parseRange(st.range).entries()].flatMap(([h, w]) =>
      combosForHand(h).map((cards) => ({ cards, w })),
    )
    return { type: 'range', combos }
  }

  function run() {
    setError('')
    const s1 = buildSpec(p1, '玩家 1 ')
    const s2 = buildSpec(p2, '玩家 2 ')
    if (typeof s1 === 'string') return setError(s1)
    if (typeof s2 === 'string') return setError(s2)
    const b = board.filter((c): c is Card => c !== null)
    if (b.length === 1 || b.length === 2) return setError('公共牌请选 0、3、4 或 5 张（翻牌为 3 张）')
    setComputing(true)
    setResult(null)
    setTimeout(() => {
      setResult(computeEquity(s1, s2, b, 50000))
      setComputing(false)
    }, 30)
  }

  function renderPlayer(st: PlayerState, who: 'p1' | 'p2', title: string) {
    const setSt = who === 'p1' ? setP1 : setP2
    const info = st.mode === 'range' ? rangeInfo(st.range) : null
    return (
      <div className="eq-player">
        <div className="eq-player-head">
          <span className="eq-player-title">{title}</span>
          <div className="mode-toggle">
            <button
              className={`chip-btn ${st.mode === 'cards' ? 'chip-btn-active' : ''}`}
              onClick={() => {
                setSt({ ...st, mode: 'cards' })
                setResult(null)
                setActive({ who, idx: st.cards[0] === null ? 0 : 1 })
              }}
            >
              指定手牌
            </button>
            <button
              className={`chip-btn ${st.mode === 'range' ? 'chip-btn-active' : ''}`}
              onClick={() => {
                setSt({ ...st, mode: 'range' })
                setResult(null)
              }}
            >
              范围
            </button>
          </div>
        </div>
        {st.mode === 'cards' ? (
          <div className="slot-row">
            {[0, 1].map((i) => {
              const c = st.cards[i]
              const isActive = active?.who === who && active.idx === i
              return (
                <button
                  key={i}
                  className={`card-slot ${isActive ? 'card-slot-active' : ''}`}
                  onClick={() => (c !== null ? clearSlot({ who, idx: i }) : setActive({ who, idx: i }))}
                >
                  {c !== null ? <CardFace card={c} /> : '?'}
                </button>
              )
            })}
          </div>
        ) : (
          <div>
            <input
              className="range-input"
              value={st.range}
              onChange={(e) => {
                setSt({ ...st, range: e.target.value })
                setResult(null)
              }}
              placeholder="例：TT+, AQs+, AJo+, KQs, 76s:0.5"
            />
            <div className="range-input-info">
              {info?.error ? (
                <span className="input-error">{info.error}</span>
              ) : (
                <span>{info?.combos} 个组合</span>
              )}
              <span className="preset-row">
                {PRESETS.map((p) => (
                  <button
                    key={p.label}
                    className="link-btn"
                    onClick={() => {
                      setSt({ ...st, range: p.range })
                      setResult(null)
                    }}
                  >
                    {p.label}
                  </button>
                ))}
              </span>
            </div>
          </div>
        )}
      </div>
    )
  }

  const eq1 = result ? result.win + result.tie / 2 : 0

  return (
    <div className="panel">
      <div className="eq-players">
        {renderPlayer(p1, 'p1', '玩家 1')}
        {renderPlayer(p2, 'p2', '玩家 2')}
      </div>

      <div className="eq-board">
        <span className="eq-player-title">公共牌（可选）</span>
        <div className="slot-row">
          {board.map((c, i) => {
            const isActive = active?.who === 'board' && active.idx === i
            return (
              <button
                key={i}
                className={`card-slot ${isActive ? 'card-slot-active' : ''}`}
                onClick={() =>
                  c !== null ? clearSlot({ who: 'board', idx: i }) : setActive({ who: 'board', idx: i })
                }
              >
                {c !== null ? <CardFace card={c} /> : i < 3 ? '翻' : i === 3 ? '转' : '河'}
              </button>
            )
          })}
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
              const isUsed = used.has(card)
              return (
                <button
                  key={r}
                  className={`deck-card ${isUsed ? 'deck-card-used' : ''}`}
                  style={{ color: SUIT_COLORS[s] }}
                  disabled={isUsed}
                  onClick={() => pickCard(card)}
                >
                  {RANK_CHARS[12 - r]}
                </button>
              )
            })}
          </div>
        ))}
      </div>

      <div className="eq-run-row">
        <button className="primary-btn" onClick={run} disabled={computing}>
          {computing ? '计算中…' : '计算权益'}
        </button>
        {error && <span className="input-error">{error}</span>}
      </div>

      {result && result.iterations > 0 && (
        <div className="eq-result">
          <div className="eq-headline">
            玩家 1 权益 <b>{(eq1 * 100).toFixed(1)}%</b>
            <span className="eq-sub">
              （胜 {(result.win * 100).toFixed(1)}% / 平 {(result.tie * 100).toFixed(1)}% / 负{' '}
              {(result.lose * 100).toFixed(1)}%，{result.iterations.toLocaleString()} 次模拟）
            </span>
          </div>
          <div className="freq-bar">
            <div className="freq-seg" style={{ width: `${result.win * 100}%`, background: '#e2574a' }}>
              {result.win > 0.08 && <span>玩家1 {(result.win * 100).toFixed(0)}%</span>}
            </div>
            <div
              className="freq-seg"
              style={{ width: `${result.tie * 100}%`, background: 'rgba(151, 163, 184, 0.5)' }}
            >
              {result.tie > 0.08 && <span>平 {(result.tie * 100).toFixed(0)}%</span>}
            </div>
            <div className="freq-seg" style={{ width: `${result.lose * 100}%`, background: '#5c7cba' }}>
              {result.lose > 0.08 && <span>玩家2 {(result.lose * 100).toFixed(0)}%</span>}
            </div>
          </div>
        </div>
      )}
      {result && result.iterations === 0 && (
        <div className="input-error">范围与已选牌完全冲突，无法模拟</div>
      )}
    </div>
  )
}
