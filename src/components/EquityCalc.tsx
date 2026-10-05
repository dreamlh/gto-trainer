import { useEffect, useMemo, useRef, useState } from 'react'
import { RANK_CHARS, SUIT_SYMBOLS, comboIndex, makeCard, type Card } from '../poker/cards'
import { computeEquity, type EquityResult, type PlayerSpec } from '../poker/equity'
import { compatibleRanges, maskRange, rangeSpec, SIMPLE_RANGES, textRange } from '../analysis/ranges'
import type { AnalysisContext, AnalysisRange } from '../analysis/types'
import { CardFace } from './CardFace'
import { RangeEditor } from './RangeEditor'
import { ScenarioPicker } from './ScenarioPicker'
import { AnalysisNotice } from './AnalysisNotice'
import { useLanguage } from '../battle/i18n'

interface Player { mode: 'cards' | 'range'; cards: (Card | null)[]; range: AnalysisRange; name?: string }
type Slot = { player: 0 | 1 | 'board'; index: number }
const COLORS = ['#c9d2e0', '#e77777', '#7fa6ee', '#7ec995']
const CARD_COLORS = ['#1b2330', '#b83434', '#265faf', '#287d41']

export function EquityCalc({ context }: { context?: AnalysisContext | null }) {
  const { t, language } = useLanguage()
  const [players, setPlayers] = useState<[Player, Player]>([
    { mode: 'cards', cards: [null, null], range: textRange(SIMPLE_RANGES[1].text) },
    { mode: 'range', cards: [null, null], range: textRange(SIMPLE_RANGES[2].text) },
  ])
  const [board, setBoard] = useState<(Card | null)[]>([null, null, null, null, null])
  const [active, setActive] = useState<Slot | null>({ player: 0, index: 0 })
  const [review, setReview] = useState<AnalysisContext | null>(null)
  const [result, setResult] = useState<EquityResult | null>(null)
  const [error, setError] = useState('')
  const [computing, setComputing] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const generation = useRef(0)
  function invalidate() {
    generation.current++; if (timer.current !== null) clearTimeout(timer.current)
    setResult(null); setError(''); setComputing(false)
  }
  useEffect(() => () => { generation.current++; if (timer.current !== null) clearTimeout(timer.current) }, [])
  useEffect(() => {
    if (!context) return
    invalidate(); setReview(context)
    const live = context.players.filter(p => !p.folded)
    const first = live.find(p => p.id === context.heroId) ?? live[0]
    const ids = context.selectedIds ?? [first?.id, live.find(p => p.id !== first?.id)?.id]
    const picked = ids.map(id => context.players.find(p => p.id === id))
    if (picked.some(p => !p)) return
    setPlayers(picked.map(p => ({ name: `${p!.name}${p!.position ? ` (${p!.position})` : ''}`, mode: p!.cards ? 'cards' : 'range', cards: p!.cards ? [...p!.cards] : [null, null], range: { ...p!.range, weights: p!.range.weights.slice() } })) as [Player, Player])
    setBoard(Array.from({ length: 5 }, (_, i) => context.board[i] ?? null)); setActive(null)
  }, [context])
  const used = useMemo(() => new Set([...board, ...players.flatMap(p => p.mode === 'cards' ? p.cards : [])].filter((c): c is Card => c !== null)), [players, board])
  const update = (index: number, patch: Partial<Player>) => {
    invalidate(); setPlayers(previous => previous.map((p, i) => i === index ? { ...p, ...patch } : p) as [Player, Player])
  }
  function slot(ref: Slot, card: Card | null) {
    invalidate()
    if (ref.player === 'board') setBoard(previous => previous.map((c, i) => i === ref.index ? card : c))
    else setPlayers(previous => previous.map((p, i) => i === ref.player ? { ...p, cards: p.cards.map((c, j) => j === ref.index ? card : c) } : p) as [Player, Player])
  }
  function pick(card: Card) {
    if (!active || used.has(card)) return
    slot(active, card)
    const slots: Slot[] = players.flatMap((p, i) => p.mode === 'cards' ? [0,1].map(index => ({ player: i as 0 | 1, index })) : [])
    slots.push(...board.map((_, index) => ({ player: 'board' as const, index })))
    const at = slots.findIndex(s => s.player === active.player && s.index === active.index)
    const next = [...slots.slice(at + 1), ...slots.slice(0, at)].find(s => (s.player === 'board' ? board[s.index] : players[s.player].cards[s.index]) === null)
    setActive(next ?? null)
  }
  function run() {
    invalidate()
    const cards = board.filter((c): c is Card => c !== null)
    if (![0,3,4,5].includes(cards.length)) return setError(t('公共牌请选择 0、3、4 或 5 张。', 'Select 0, 3, 4 or 5 board cards.'))
    const known = [...cards, ...players.flatMap(p => p.mode === 'cards' ? p.cards.filter((c): c is Card => c !== null) : [])]
    if (new Set(known).size !== known.length) return setError(t('已选牌存在重复。', 'Selected cards overlap.'))
    const specs: PlayerSpec[] = []
    const vectors: Float32Array[] = []
    for (const p of players) {
      if (p.mode === 'cards') {
        if (p.cards.some(c => c === null)) return setError(t('请为双方选择手牌或范围。', 'Choose a hand or range for each player.'))
        const pair = p.cards as [Card, Card]
        specs.push({ type: 'cards', cards: pair }); const v = new Float32Array(1326); v[comboIndex(...pair)] = 1; vectors.push(v)
      } else {
        specs.push(rangeSpec(p.range, known)); vectors.push(maskRange(p.range, known))
      }
    }
    if (!compatibleRanges(vectors[0], vectors[1])) return setError(t('没有互不冲突的有效组合，请选择或调整范围。', 'No compatible combinations remain. Select or adjust the ranges.'))
    const gen = generation.current
    setComputing(true)
    timer.current = setTimeout(() => {
      try { const computed = computeEquity(specs[0], specs[1], cards, 50000); if (generation.current === gen) setResult(computed) }
      catch { if (generation.current === gen) setError(t('计算失败，请调整范围后重试。', 'Calculation failed. Adjust the ranges and try again.')) }
      finally { if (generation.current === gen) setComputing(false) }
    }, 30)
  }
  const renderSlot = (ref: Slot, card: Card | null, label: string) => <button type="button" key={ref.index}
    className={`card-slot ${active?.player === ref.player && active.index === ref.index ? 'card-slot-active' : ''}`}
    aria-label={label} onClick={() => { if (card !== null) slot(ref, null); setActive(ref) }}>{card === null ? '?' : <CardFace card={card} />}</button>
  return <div className="panel">
    <p className="spot-desc">{t('权益：发到摊牌后平均能分到的底池份额，不直接代表应该怎样下注。', 'Equity is your average share at showdown; it does not directly prescribe a betting action.')}</p>
    {review && <AnalysisNotice context={review} onClear={() => { invalidate(); setReview(null) }} />}
    <ScenarioPicker onApply={scenario => {
      invalidate(); setPlayers(previous => previous.map((p, i) => ({ ...p, range: scenario.ranges[i], name: scenario.positions[i] })) as [Player, Player])
    }} />
    <div className="analysis-columns">{players.map((p, index) => {
      const name = p.name ?? t(`玩家 ${index + 1}`, `Player ${index + 1}`)
      return <div className="eq-player" key={index}><div className="eq-player-head"><strong>{name}</strong><div className="mode-toggle">
        <button type="button" className={`chip-btn ${p.mode === 'cards' ? 'chip-btn-active' : ''}`} onClick={() => {
          const unavailable = new Set([...board, ...players.flatMap((other, i) => i !== index && other.mode === 'cards' ? other.cards : [])])
          update(index, { mode: 'cards', cards: p.cards.map(c => unavailable.has(c) ? null : c) }); setActive({ player: index as 0 | 1, index: 0 })
        }}>{t('指定手牌', 'Exact hand')}</button>
        <button type="button" className={`chip-btn ${p.mode === 'range' ? 'chip-btn-active' : ''}`} onClick={() => { update(index, { mode: 'range' }); setActive(null) }}>{t('范围', 'Range')}</button>
      </div></div>
        {p.mode === 'cards' ? <div className="slot-row">{p.cards.map((c, i) => renderSlot({ player: index as 0 | 1, index: i }, c, `${name} ${t('手牌', 'card')} ${i + 1}`))}</div>
          : <RangeEditor label={`${name} ${t('范围', 'range')}`} value={p.range} dead={[...used]} onChange={range => update(index, { range })} />}
      </div>
    })}</div>
    <div className="eq-board"><strong>{t('公共牌（可选）', 'Board (optional)')}</strong><div className="slot-row">{board.map((c, i) => renderSlot({ player: 'board', index: i }, c, `${t('公共牌', 'Board')} ${i + 1}`))}</div></div>
    <div className="deck-grid">{SUIT_SYMBOLS.map((symbol, suit) => <div className="deck-row" key={suit}><span className="deck-suit" style={{ color: COLORS[suit] }}>{symbol}</span>{[...RANK_CHARS].reverse().map((rank, i) => {
      const card = makeCard(12 - i, suit)
      return <button type="button" key={card} aria-label={`${rank}${symbol}`} className={`deck-card ${used.has(card) ? 'deck-card-used' : ''}`} style={{ color: CARD_COLORS[suit] }} disabled={!active || used.has(card)} onClick={() => pick(card)}>{rank}</button>
    })}</div>)}</div>
    <div className="eq-run-row"><button className="primary-btn" disabled={computing} onClick={run}>{computing ? t('计算中…', 'Calculating…') : t('计算权益', 'Calculate equity')}</button>{error && <span className="input-error" role="alert">{error}</span>}</div>
    {result && result.iterations > 0 && <div className="eq-result"><div className="eq-headline">{t('玩家 1 权益', 'Player 1 equity')} <b>{((result.win + result.tie / 2) * 100).toFixed(1)}%</b><span className="eq-sub">{t('胜', 'Win')} {(result.win * 100).toFixed(1)}% / {t('平', 'Tie')} {(result.tie * 100).toFixed(1)}% / {t('负', 'Lose')} {(result.lose * 100).toFixed(1)}% · {result.iterations.toLocaleString(language === 'zh' ? 'zh-CN' : 'en-GB')} {t('次模拟', 'simulations')}</span></div>
      <div className="freq-bar"><div className="freq-seg" style={{ width: `${result.win * 100}%`, background: '#e2574a' }} /><div className="freq-seg" style={{ width: `${result.tie * 100}%`, background: '#a2aeaf' }} /><div className="freq-seg" style={{ width: `${result.lose * 100}%`, background: '#5c7cba' }} /></div></div>}
    {result?.iterations === 0 && <p className="input-error">{t('没有足够的有效抽样，请调整范围。', 'Not enough valid samples. Adjust the ranges.')}</p>}
  </div>
}
