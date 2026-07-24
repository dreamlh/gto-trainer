import type { Card } from '../poker/cards'
import type { EngineState } from '../game/engine'
import { pot } from '../game/engine'
import { CardFace } from './CardFace'

// 2-9 人参数化牌桌。英雄恒在底部，其余按行动顺序沿椭圆顺时针排布。

export interface TableViewProps {
  engine: EngineState
  heroSeat: number
  toActSeat: number
  revealed?: { seat: number; cards: [Card, Card] }[]
  solveProgress?: { street: string; iter: number; total: number } | null
  showdown?: boolean
}

const STREET_LABELS: Record<string, string> = {
  preflop: '翻前',
  flop: '翻牌',
  turn: '转牌',
  river: '河牌',
}

export function TableView({
  engine,
  heroSeat,
  toActSeat,
  revealed = [],
  solveProgress,
}: TableViewProps) {
  const n = engine.n
  const btnSeat = engine.n === 2 ? 0 : engine.positions.indexOf('BTN')
  const revealedMap = new Map(revealed.map((r) => [r.seat, r.cards]))

  return (
    <div className="table-wrap">
      <div className="table-felt">
        <div className="board-row">
          {engine.board.map((c, i) => (
            <CardFace key={i} card={c} size="md" />
          ))}
          {engine.board.length === 0 && (
            <span className="board-placeholder">{STREET_LABELS[engine.street]}</span>
          )}
        </div>
        <div className="table-center-text">
          底池 {pot(engine).toFixed(1)} bb
          {solveProgress && (
            <span className="solve-ring" title="GTO 求解中">
              ⟳ {STREET_LABELS[solveProgress.street] ?? ''}求解{' '}
              {solveProgress.total > 1
                ? `${Math.round((solveProgress.iter / solveProgress.total) * 100)}%`
                : '…'}
            </span>
          )}
        </div>
        {engine.players.map((p) => {
          // 椭圆布局：英雄在底（角度 90°），顺时针
          const rel = (p.seat - heroSeat + n) % n
          const angle = (Math.PI / 180) * (90 + (rel * 360) / n)
          const x = 50 + 42 * Math.cos(angle)
          const y = 47 + 41 * Math.sin(angle)
          const bx = 50 + 26 * Math.cos(angle)
          const by = 46 + 24 * Math.sin(angle)
          const isHero = p.seat === heroSeat
          const acting = p.seat === toActSeat && !p.folded
          const streetBet = p.invested - p.streetBase
          const cards = isHero ? p.cards : revealedMap.get(p.seat)
          return (
            <div key={p.seat}>
              <div
                className={`seat ${p.folded ? 'seat-folded' : ''} ${isHero ? 'seat-hero' : ''} ${acting ? 'seat-acting' : ''}`}
                style={{ left: `${x}%`, top: `${y}%` }}
              >
                {cards && (
                  <div className="seat-cards">
                    <CardFace card={cards[0]} size={isHero ? 'lg' : 'md'} />
                    <CardFace card={cards[1]} size={isHero ? 'lg' : 'md'} />
                  </div>
                )}
                <div className="seat-pos">
                  {engine.positions[p.seat]}
                  {p.seat === btnSeat && <span className="dealer-chip">D</span>}
                </div>
                <div className="seat-label">
                  {p.folded
                    ? '弃牌'
                    : p.allin
                      ? '全下'
                      : `${(engine.stack - p.invested).toFixed(1)}bb`}
                  {isHero && ' · 你'}
                </div>
              </div>
              {streetBet > 0.01 && !p.folded && (
                <div className="bet-chip" style={{ left: `${bx}%`, top: `${by}%` }}>
                  {streetBet % 1 === 0 ? streetBet : streetBet.toFixed(1)}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
