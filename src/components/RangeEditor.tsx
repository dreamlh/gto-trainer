import { useEffect, useRef, useState } from 'react'
import { HAND_NAMES, COMBO_CARDS, cardStr, type Card } from '../poker/cards'
import { CLASS_COMBOS, SIMPLE_RANGES, rangeSummary, setClass, textRange } from '../analysis/ranges'
import type { AnalysisRange } from '../analysis/types'
import { useLanguage } from '../battle/i18n'
import { translatePokerText } from '../poker/presentation'

export function RangeEditor({ label, value, dead = [], onChange }: {
  label: string; value: AnalysisRange; dead?: Card[]; onChange: (range: AnalysisRange) => void
}) {
  const { t, language } = useLanguage()
  const [weight, setWeight] = useState(1)
  const [focused, setFocused] = useState(0)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const paint = useRef<number | null>(null)
  const mouseClick = useRef(false)
  const current = useRef(value); current.current = value
  const summary = rangeSummary(value, dead)
  useEffect(() => {
    const stop = () => { paint.current = null }
    window.addEventListener('pointerup', stop); window.addEventListener('blur', stop)
    return () => { window.removeEventListener('pointerup', stop); window.removeEventListener('blur', stop) }
  }, [])
  const classWeight = (h: number) => CLASS_COMBOS[h].reduce((sum, i) => sum + value.weights[i], 0) / CLASS_COMBOS[h].length
  const change = (h: number, w: number) => {
    const next = setClass(current.current, h, w); current.current = next; onChange(next); setFocused(h)
  }
  const toggle = (h: number) => change(h, classWeight(h) > 0 ? 0 : weight)
  const sources = {
    scenario: t('100 BB 翻前预解', '100 BB preflop solution'),
    snapshot: t('训练时保存的范围', 'Saved training range'),
    inferred: t('按翻前行动推定', 'Inferred from preflop actions'),
    custom: t('自定义范围', 'Custom range'), unset: t('尚未设置范围', 'Range not set'),
  }
  return <section className="analysis-range" aria-label={label}>
    <strong>{label}</strong>
    <p className={value.source === 'unset' ? 'input-error' : 'spot-desc'}>{sources[value.source]}</p>
    <p className="analysis-range-summary">{summary.percent.toFixed(1)}% · {summary.combos.toFixed(1)} {t('有效加权组合', 'weighted live combos')} <small>({summary.count} {t('种组合', 'combos')})</small></p>
    <div className="analysis-preset-row">{SIMPLE_RANGES.map(p => <button type="button" className="chip-btn" key={p.en} onClick={() => onChange(textRange(p.text))}>{t(p.zh, p.en)}</button>)}</div>
    <details className="analysis-matrix-details">
      <summary>{t('点选手牌，微调范围', 'Edit hands in the range')}</summary>
      <p className="spot-desc">{t('对角线：对子 · 右上：同花 s · 左下：非同花 o。点击增删；鼠标可拖选。', 'Diagonal: pairs · Upper right: suited (s) · Lower left: offsuit (o). Click to toggle; drag with a mouse.')}</p>
      <div className="analysis-toolbar">
        <label>{t('加入权重', 'Paint weight')} <select value={weight} onChange={e => setWeight(Number(e.target.value))}>{[.25, .5, .75, 1].map(w => <option key={w} value={w}>{w * 100}%</option>)}</select></label>
        <button type="button" className="chip-btn" onClick={() => onChange({ weights: new Float32Array(1326).fill(weight), source: 'custom' })}>{t('全选', 'Select all')}</button>
        <button type="button" className="chip-btn" onClick={() => onChange({ weights: new Float32Array(1326), source: 'custom' })}>{t('清空', 'Clear')}</button>
      </div>
      <div className="analysis-hand-grid" role="group" aria-label={`${label} ${t('手牌矩阵', 'hand matrix')}`} onPointerLeave={() => { paint.current = null }}>
        {HAND_NAMES.map((hand, h) => {
          const w = classWeight(h)
          return <button type="button" key={hand} data-hand={h} tabIndex={h === focused ? 0 : -1} aria-pressed={w > 0}
            aria-label={`${hand} ${Math.round(w * 100)}%`} style={{ background: `linear-gradient(to right, #376b51 ${w * 100}%, #182c23 ${w * 100}%)` }}
            onFocus={() => setFocused(h)}
            onPointerDown={e => {
              mouseClick.current = e.pointerType === 'mouse'
              if (e.pointerType === 'mouse' && e.button === 0) { paint.current = w > 0 ? 0 : weight; change(h, paint.current) }
            }}
            onPointerEnter={e => { if (e.pointerType === 'mouse' && e.buttons === 1 && paint.current !== null) change(h, paint.current) }}
            onClick={e => { if (!mouseClick.current || e.detail === 0) toggle(h); mouseClick.current = false }}
            onKeyDown={e => {
              const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -13, ArrowDown: 13 }[e.key]
              if (offset === undefined && e.key !== 'Home' && e.key !== 'End') return
              e.preventDefault()
              const next = e.key === 'Home' ? 0 : e.key === 'End' ? 168 : Math.max(0, Math.min(168, h + offset!))
              e.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-hand="${next}"]`)?.focus()
            }}>{hand}</button>
        })}
      </div>
      <div className="analysis-hand-detail">
        <label>{HAND_NAMES[focused]} {t('权重', 'weight')} <input type="range" min="0" max="100" step="1" value={Math.round(classWeight(focused) * 100)} onChange={e => change(focused, Number(e.target.value) / 100)} /></label>
        <span>{CLASS_COMBOS[focused].map(i => `${COMBO_CARDS[i].map(cardStr).join('')}: ${Math.round(value.weights[i] * 100)}%`).join(' · ')}</span>
      </div>
    </details>
    <details className="analysis-text-import"><summary>{t('高级：导入范围文本', 'Advanced: import range text')}</summary>
      <p className="spot-desc">{t('导入会替换整个范围。支持手牌类别及具体花色组合（如 AsKs:0.5），后写的权重覆盖前面的设置。', 'Import replaces this entire range. Hand classes and specific suits (e.g. AsKs:0.5) are supported; later entries override earlier weights.')}</p>
      <textarea aria-label={`${label} ${t('范围文本', 'range text')}`} value={draft} onChange={e => { setDraft(e.target.value); setError('') }} placeholder="TT+, AQs+, AJo+, AsKs:0.5" />
      <button type="button" className="chip-btn" onClick={() => {
        try { const next = textRange(draft); if (!next.weights.some(w => w > 0)) throw new Error(t('请输入非空范围', 'Enter a nonempty range')); onChange(next); setError('') }
        catch (e) { setError(translatePokerText((e as Error).message, language)) }
      }}>{t('替换范围', 'Replace range')}</button>{error && <p className="input-error" role="alert">{error}</p>}
    </details>
  </section>
}
