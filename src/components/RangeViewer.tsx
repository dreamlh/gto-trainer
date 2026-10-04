import { useEffect, useId, useMemo, useState } from 'react'
import { SPOTS, type Position, type Spot } from '../poker/ranges'
import { useLanguage } from '../battle/i18n'
import { categoryName, translatePokerText } from '../poker/presentation'
import { POSITIONS_BY_SIZE } from '../solver/config'
import { loadPreflop, type PreflopBundle } from '../solver/preflop/api'
import { RangeChart } from './RangeChart'

const CATEGORIES = ['rfi', 'vs-rfi', 'vs-3bet', 'cold-3bet', 'vs-4bet'] as const
const TABLE_SIZES = [2, 3, 4, 5, 6, 7, 8, 9]

export function RangeViewer() {
  const { language, t } = useLanguage()
  const [tableSize, setTableSize] = useState(9)
  const [bundle, setBundle] = useState<PreflopBundle | null>(null)
  const [error, setError] = useState('')
  const [spotId, setSpotId] = useState('')
  const [expandedCategory, setExpandedCategory] = useState<typeof CATEGORIES[number] | null>('rfi')
  const accordionId = useId()

  useEffect(() => {
    let alive = true
    setBundle(null)
    setError('')
    loadPreflop(tableSize)
      .then((b) => {
        if (!alive) return
        setBundle(b)
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

  const categorySpots = useMemo(() => {
    const order = (p?: Position) => p ? POSITIONS_BY_SIZE[tableSize]?.indexOf(p) ?? 99 : 99
    return Object.fromEntries(CATEGORIES.map(category => [category, spots.filter(s => s.category === category)
      .sort((a, b) => order(a.hero) - order(b.hero) || order(a.villain) - order(b.villain))])) as Record<typeof CATEGORIES[number], Spot[]>
  }, [spots, tableSize])
  const current = spots.find(s => s.id === spotId)
  const spot = current && (!expandedCategory || current.category === expandedCategory)
    ? current
    : (expandedCategory ? categorySpots[expandedCategory][0] : undefined) ?? categorySpots.rfi[0] ?? spots[0]

  // Persist the effective choice across closing the accordion and changing table size.
  useEffect(() => { if (spot && spot.id !== spotId) setSpotId(spot.id) }, [spot, spotId])

  return (
    <div className="panel range-viewer">
      <div className="viewer-controls">
        <div className="viewer-group">
          <div className="viewer-group-label">{t('牌桌人数', 'Table size')}</div>
          <div className="viewer-group-buttons">
            {TABLE_SIZES.map((n) => (
              <button
                key={n}
                className={`chip-btn ${n === tableSize ? 'chip-btn-active' : ''}`}
                aria-pressed={n === tableSize}
                onClick={() => setTableSize(n)}
              >
                {n} {t('人', 'players')}
              </button>
            ))}
          </div>
        </div>
        {CATEGORIES.map((cat) => {
          const catSpots = categorySpots[cat]
          if (catSpots.length === 0) return null
          const expanded = expandedCategory === cat
          return (
            <div key={cat} className={`viewer-category ${expanded ? 'viewer-category-open' : ''}`}>
              <button type="button" className="viewer-category-toggle" aria-expanded={expanded} aria-controls={`${accordionId}-${cat}`} onClick={() => {
                setExpandedCategory(expanded ? null : cat)
                if (!expanded && current?.category !== cat) setSpotId(catSpots[0].id)
              }}>
                <span>{categoryName(cat, language)}</span><span aria-hidden="true">{expanded ? '−' : '+'}</span>
              </button>
              <div id={`${accordionId}-${cat}`} className="viewer-group-buttons viewer-category-content" hidden={!expanded}>
                {catSpots.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    aria-pressed={spot?.id === s.id}
                    className={`chip-btn ${spot && s.id === spot.id ? 'chip-btn-active' : ''}`}
                    onClick={() => setSpotId(s.id)}
                  >
                    {s.chip ?? (s.category === 'rfi' ? s.hero : `${s.hero} vs ${s.villain}`)}
                  </button>
                ))}
              </div>
            </div>
          )
        })}
      </div>
      <div className="range-viewer-chart">
        {!bundle && !error && <p className="spot-desc">{t(`正在加载 ${tableSize} 人桌翻前解…`, `Loading the ${tableSize}-player preflop solution…`)}</p>}
        {error && tableSize !== 6 && <p className="input-error">{t('加载失败：', 'Load failed: ')}{translatePokerText(error, language)}</p>}
        {error && tableSize === 6 && (
          <p className="spot-desc">{t('CFR 解加载失败，已退回手写近似范围。', 'The CFR solution could not be loaded. Showing approximate ranges instead.')} ({translatePokerText(error, language)})</p>
        )}
        {spot && (
          <>
            <h2 className="spot-title">{translatePokerText(spot.title, language)}</h2>
            <p className="spot-desc">
              {translatePokerText(spot.situation, language)}
              {bundle && t('（CFR 求解，含每动作 EV）', ' (CFR solution with per-action EV)')}
            </p>
            <RangeChart spot={spot} />
          </>
        )}
      </div>
    </div>
  )
}
