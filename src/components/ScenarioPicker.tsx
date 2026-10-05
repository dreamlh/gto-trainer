import { useEffect, useRef, useState } from 'react'
import { loadPreflop, type PreflopBundle } from '../solver/preflop/api'
import { POSITIONS_BY_SIZE } from '../solver/config'
import { DEFAULT_SCENARIO, scenarioFromBundle, type RangeScenario, type ScenarioSelection } from '../analysis/scenarios'
import { useLanguage } from '../battle/i18n'

export function ScenarioPicker({ onApply, autoApply = false }: { onApply: (scenario: RangeScenario) => void; autoApply?: boolean }) {
  const { t } = useLanguage()
  const [selection, setSelection] = useState<ScenarioSelection>(DEFAULT_SCENARIO)
  const [bundle, setBundle] = useState<PreflopBundle | null>(null)
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const applied = useRef(false)
  const apply = useRef(onApply); apply.current = onApply
  useEffect(() => {
    let alive = true
    setBundle(null); setFailed(false)
    loadPreflop(selection.n).then(b => { if (alive) setBundle(b) }).catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [selection.n, retry])
  useEffect(() => {
    if (bundle?.n !== selection.n || !autoApply || applied.current) return
    const scenario = scenarioFromBundle(bundle, selection)
    if (scenario) { applied.current = true; apply.current(scenario) }
  }, [bundle, selection, autoApply])
  const positions = POSITIONS_BY_SIZE[selection.n]
  const scenario = bundle?.n === selection.n ? scenarioFromBundle(bundle, selection) : null
  return <section className="analysis-scenario" aria-label={t('场景预设', 'Scenario preset')}>
    <strong>{t('场景预设', 'Scenario preset')}</strong>
    <div className="analysis-toolbar">
      <label>{t('人数', 'Players')} <select value={selection.n} onChange={e => { const n = Number(e.target.value); setSelection({ ...selection, n, opener: 'BTN', defender: 'BB' }) }}>{[2,3,4,5,6,7,8,9].map(n => <option key={n}>{n}</option>)}</select></label>
      <label>{t('开局位置', 'Opener')} <select value={selection.opener} onChange={e => { const opener = e.target.value as ScenarioSelection['opener']; setSelection({ ...selection, opener, defender: 'BB' }) }}>{positions.slice(0, -1).map(p => <option key={p}>{p}</option>)}</select></label>
      <label>{t('应对位置', 'Responder')} <select value={selection.defender} onChange={e => setSelection({ ...selection, defender: e.target.value as ScenarioSelection['defender'] })}>{positions.slice(positions.indexOf(selection.opener) + 1).map(p => <option key={p}>{p}</option>)}</select></label>
      <label>{t('翻前行动', 'Preflop actions')} <select value={selection.raises} onChange={e => setSelection({ ...selection, raises: Number(e.target.value) as 1 | 2 | 3 })}>
        <option value={1}>{t('开局 → 跟注', 'Open → Call')}</option><option value={2}>{t('开局 → 3bet → 跟注', 'Open → 3bet → Call')}</option><option value={3}>{t('开局 → 3bet → 4bet → 跟注', 'Open → 3bet → 4bet → Call')}</option>
      </select></label>
      <button type="button" className="chip-btn" disabled={!scenario} onClick={() => { applied.current = true; if (scenario) onApply(scenario) }}>{t('应用场景', 'Apply scenario')}</button>
    </div>
    <p className="spot-desc">{t('100 BB · 其余玩家弃牌 · 使用本项目翻前近似解。应用会替换双方范围和底池、筹码。', '100 BB · Other players fold · Uses this app’s approximate preflop solution. Applying replaces both ranges, pot and stacks.')}</p>
    {!bundle && !failed && <p role="status">{t('正在加载预设…', 'Loading presets…')}</p>}
    {failed && <p className="input-error">{t('预解加载失败，可以使用下方示例范围。', 'Could not load the solution. You can use the example ranges below.')} <button className="link-btn" onClick={() => setRetry(r => r + 1)}>{t('重试', 'Retry')}</button></p>}
    {bundle && !scenario && <p className="input-error">{t('此场景没有可用的单挑范围，请换一个场景。', 'No heads-up ranges are available for this scenario. Choose another scenario.')}</p>}
  </section>
}
