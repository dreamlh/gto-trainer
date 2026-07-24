import { useMemo, useState } from 'react'
import { comboCount, gridHandName } from '../poker/cards'
import { ACTION_COLORS, ACTION_LABELS, handFreqs, type Spot } from '../poker/ranges'

const FOLD_BG = 'rgba(92, 124, 186, 0.35)'

// weights：每手牌类的到达权重（翻后范围受限时用；无则视为全牌等权=组合数）
function weightOf(weights: Map<string, number> | undefined, hand: string): number {
  if (!weights) return comboCount(hand)
  return weights.get(hand) ?? 0
}

// 权重加权的各动作占比
function actionPercents(spot: Spot, weights?: Map<string, number>): { key: string; pct: number }[] {
  const sums: Record<string, number> = {}
  let total = 0
  for (let r = 0; r < 13; r++) {
    for (let c = 0; c < 13; c++) {
      const hand = gridHandName(r, c)
      const w = weightOf(weights, hand)
      if (w <= 0) continue
      total += w
      for (const { key, freq } of handFreqs(spot, hand)) {
        sums[key] = (sums[key] ?? 0) + freq * w
      }
    }
  }
  total = Math.max(total, 1e-9)
  const out: { key: string; pct: number }[] = spot.actions.map((a) => ({
    key: a.key,
    pct: ((sums[a.key] ?? 0) / total) * 100,
  }))
  out.push({ key: 'fold', pct: ((sums['fold'] ?? 0) / total) * 100 })
  return out
}

function cellBackground(spot: Spot, hand: string): string {
  const freqs = handFreqs(spot, hand)
  if (freqs.length === 1 && freqs[0].key === 'fold') return FOLD_BG
  const stops: string[] = []
  let acc = 0
  for (const { key, freq } of freqs) {
    const color = key === 'fold' ? FOLD_BG : ACTION_COLORS[key]
    stops.push(`${color} ${(acc * 100).toFixed(1)}% ${((acc + freq) * 100).toFixed(1)}%`)
    acc += freq
  }
  return `linear-gradient(to right, ${stops.join(', ')})`
}

interface Tooltip {
  hand: string
  x: number
  y: number
}

export function RangeChart({
  spot,
  highlight,
  compact = false,
  weights,
  actionLabels,
}: {
  spot: Spot
  highlight?: string
  compact?: boolean
  weights?: Map<string, number> // 手牌类到达权重；0/缺失 = 不在范围内（置灰）
  actionLabels?: Record<string, string> // 覆盖图例文案（如翻后的「过牌/下注」）
}) {
  const [tip, setTip] = useState<Tooltip | null>(null)
  const percents = useMemo(() => actionPercents(spot, weights), [spot, weights])
  const labelOf = (key: string) => actionLabels?.[key] ?? ACTION_LABELS[key]

  // 悬停只更新提示框，169 个格子不随之重渲染
  const cells = useMemo(
    () =>
      Array.from({ length: 13 }, (_, r) =>
        Array.from({ length: 13 }, (_, c) => {
          const hand = gridHandName(r, c)
          const isHi = hand === highlight
          const dead = weights !== undefined && weightOf(weights, hand) <= 0
          return (
            <div
              key={hand}
              className={`range-cell ${isHi ? 'range-cell-hi' : ''} ${dead ? 'range-cell-dead' : ''}`}
              style={dead ? undefined : { background: cellBackground(spot, hand) }}
              onMouseEnter={(e) => {
                const grid = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect()
                const rect = e.currentTarget.getBoundingClientRect()
                setTip({ hand, x: rect.left - grid.left + 20, y: rect.top - grid.top - 8 })
              }}
            >
              {hand}
            </div>
          )
        }),
      ),
    [spot, highlight, weights],
  )

  return (
    <div className={`range-chart ${compact ? 'range-compact' : ''}`}>
      <div className="range-legend">
        {percents.map(({ key, pct }) => (
          <span key={key} className="legend-item">
            <span
              className="legend-swatch"
              style={{ background: key === 'fold' ? FOLD_BG : ACTION_COLORS[key] }}
            />
            {labelOf(key)} {pct.toFixed(1)}%
          </span>
        ))}
        {weights && <span className="legend-item spot-desc">灰格 = 不在范围内</span>}
      </div>
      <div
        className="range-grid"
        onMouseLeave={() => setTip(null)}
        role="table"
        aria-label={`${spot.title} 范围矩阵`}
      >
        {cells}
        {tip && (
          <div className="range-tooltip" style={{ left: tip.x, top: tip.y }}>
            <div className="tooltip-hand">{tip.hand}</div>
            {weights !== undefined && weightOf(weights, tip.hand) <= 0 ? (
              <div className="tooltip-row">不在范围内</div>
            ) : (
              handFreqs(spot, tip.hand).map(({ key, freq }) => (
                <div key={key} className="tooltip-row">
                  <span
                    className="legend-swatch"
                    style={{ background: key === 'fold' ? FOLD_BG : ACTION_COLORS[key] }}
                  />
                  {labelOf(key)} {(freq * 100).toFixed(0)}%
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}
