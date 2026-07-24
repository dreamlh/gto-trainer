import { useEffect, useMemo, useState } from 'react'
import { CATEGORY_LABELS, SPOTS, type Spot } from '../poker/ranges'
import { loadPreflop, type PreflopBundle } from '../solver/preflop/api'
import { RangeChart } from './RangeChart'

const CATEGORIES = ['rfi', 'vs-rfi', 'vs-3bet', 'vs-4bet'] as const
const TABLE_SIZES = [2, 3, 4, 5, 6, 7, 8, 9]

export function RangeViewer() {
  const [tableSize, setTableSize] = useState(6)
  const [bundle, setBundle] = useState<PreflopBundle | null>(null)
  const [error, setError] = useState('')
  const [spotId, setSpotId] = useState('')

  useEffect(() => {
    let alive = true
    setBundle(null)
    setError('')
    loadPreflop(tableSize)
      .then((b) => {
        if (!alive) return
        setBundle(b)
        setSpotId((prev) => (b.spots.some((s) => s.id === prev) ? prev : b.spots[0]?.id ?? ''))
      })
      .catch((e) => {
        if (!alive) return
        setError((e as Error).message)
      })
    return () => {
      alive = false
    }
  }, [tableSize])

  // 加载失败时退回 v1 手写范围（仅 6-max）
  const spots: Spot[] = useMemo(() => {
    if (bundle) return bundle.spots
    if (error && tableSize === 6) return SPOTS
    return []
  }, [bundle, error, tableSize])

  const spot = spots.find((s) => s.id === spotId) ?? spots[0]

  return (
    <div className="panel">
      <div className="viewer-controls">
        <div className="viewer-group">
          <div className="viewer-group-label">牌桌人数</div>
          <div className="viewer-group-buttons">
            {TABLE_SIZES.map((n) => (
              <button
                key={n}
                className={`chip-btn ${n === tableSize ? 'chip-btn-active' : ''}`}
                onClick={() => setTableSize(n)}
              >
                {n} 人
              </button>
            ))}
          </div>
        </div>
        {CATEGORIES.map((cat) => {
          const catSpots = spots.filter((s) => s.category === cat)
          if (catSpots.length === 0) return null
          return (
            <div key={cat} className="viewer-group">
              <div className="viewer-group-label">{CATEGORY_LABELS[cat]}</div>
              <div className="viewer-group-buttons">
                {catSpots.map((s) => (
                  <button
                    key={s.id}
                    className={`chip-btn ${spot && s.id === spot.id ? 'chip-btn-active' : ''}`}
                    onClick={() => setSpotId(s.id)}
                  >
                    {s.category === 'rfi'
                      ? s.hero
                      : s.category === 'vs-rfi'
                        ? `${s.hero} vs ${s.villain}`
                        : `${s.hero} vs ${s.villain}`}
                  </button>
                ))}
              </div>
            </div>
          )
        })}
      </div>
      {!bundle && !error && <p className="spot-desc">正在加载 {tableSize} 人桌翻前解…</p>}
      {error && tableSize !== 6 && <p className="input-error">加载失败：{error}</p>}
      {error && tableSize === 6 && (
        <p className="spot-desc">CFR 解加载失败，已退回手写近似范围。（{error}）</p>
      )}
      {spot && (
        <>
          <h2 className="spot-title">{spot.title}</h2>
          <p className="spot-desc">
            {spot.situation}
            {bundle && '（CFR 求解，含每动作 EV）'}
          </p>
          <RangeChart spot={spot} />
        </>
      )}
    </div>
  )
}
