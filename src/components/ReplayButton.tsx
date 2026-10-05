import { useEffect, useState } from 'react'
import type { HandRecord } from '../game/session'
import { battleContext, trainingContext, inferBattleRanges, solverBlock, BOARD_LENGTH, STREETS, type BattleReplayRecord, type ReviewStreet } from '../analysis/replay'
import type { AnalysisContext, OpenAnalysis } from '../analysis/types'
import { loadPreflop } from '../solver/preflop/api'
import { useLanguage } from '../battle/i18n'
import { PokerDialog } from './PokerDialog'
import { CardFace } from './CardFace'
import { AnalysisNotice, useSolverBlockLabel } from './AnalysisNotice'

export function ReplayButton({ training, battle, onOpenAnalysis }: { training?: HandRecord; battle?: BattleReplayRecord; onOpenAnalysis?: OpenAnalysis }) {
  const { t } = useLanguage()
  const [open, setOpen] = useState(false)
  const [street, setStreet] = useState<ReviewStreet>((training?.board.length ?? battle?.hand.board.length ?? 0) >= 3 ? 'flop' : 'preflop')
  const [run, setRun] = useState(0)
  const [context, setContext] = useState<AnalysisContext | null>(null)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<[string, string]>(['', ''])
  const label = useSolverBlockLabel()
  useEffect(() => {
    if (!open) return
    let alive = true
    const base = training ? trainingContext(training, street) : battleContext(battle!, street, run)
    const live = base.players.filter(p => !p.folded)
    const first = live.find(p => p.id === base.heroId) ?? live[0]
    setSelected([first?.id ?? '', live.find(p => p.id !== first?.id)?.id ?? ''])
    setContext(base)
    if (battle && base.board.length >= 3 && !base.missingState) {
      setLoading(true)
      loadPreflop(battle.hand.players.length).then(bundle => { if (alive) setContext(inferBattleRanges(base, battle, bundle)) })
        .catch(() => { /* Keep known information; range editors provide visible presets. */ })
        .finally(() => { if (alive) setLoading(false) })
    } else setLoading(false)
    return () => { alive = false }
  }, [open, training?.id, battle?.id, street, run])
  if (!onOpenAnalysis) return null
  const board = training?.board ?? battle!.hand.boards[run] ?? battle!.hand.board
  const blocked = context ? solverBlock(context) : 'missing'
  const live = context?.players.filter(p => !p.folded) ?? []
  const pairValid = selected[0] !== selected[1] && selected.every(id => live.some(p => p.id === id))
  return <div className="analysis-replay"><button type="button" className="chip-btn" onClick={() => setOpen(true)}>{t('复盘', 'Review hand')}</button>
    {open && <PokerDialog title={t('选择复盘局面', 'Choose a review spot')} onClose={() => setOpen(false)}>
      <div className="analysis-toolbar">
        <label>{t('轮次起点', 'Start of street')} <select aria-label={t('复盘轮次', 'Review street')} value={street} onChange={e => setStreet(e.target.value as ReviewStreet)}>{STREETS.filter(s => BOARD_LENGTH[s] <= board.length).map((s, i) => <option key={s} value={s}>{t(['翻前', '翻牌', '转牌', '河牌'][i], ['Preflop', 'Flop', 'Turn', 'River'][i])}</option>)}</select></label>
        {(battle?.hand.boards.length ?? 0) > 1 && <label>{t('发牌分支', 'Board run')} <select value={run} onChange={e => setRun(Number(e.target.value))}>{battle!.hand.boards.map((_, i) => <option value={i} key={i}>{i + 1}</option>)}</select></label>}
      </div>
      {context && <>
        <div className="slot-row">{context.board.map(c => <CardFace key={c} card={c} />)}</div>
        <p>{t('底池', 'Pot')}: {context.pot === null ? '—' : `${Number(context.pot.toFixed(2))} BB`}</p>
        <AnalysisNotice context={context} />
        <div className="analysis-toolbar">{[0, 1].map(index => <label key={index}>{t(`对比玩家 ${index + 1}`, `Compare player ${index + 1}`)} <select value={selected[index]} onChange={e => setSelected(previous => index === 0 ? [e.target.value, previous[1]] : [previous[0], e.target.value])}>{live.map(p => <option key={p.id} value={p.id}>{p.name} {p.position}</option>)}</select></label>)}</div>
        {loading && <p role="status">{t('正在匹配翻前范围…', 'Matching preflop ranges…')}</p>}
        {blocked && <p className="spot-desc">{label(blocked)}</p>}
        <div className="analysis-toolbar">
          <button className="primary-btn" disabled={!pairValid || loading} onClick={() => { onOpenAnalysis('equity', { ...context, selectedIds: selected }); setOpen(false) }}>{t('计算权益', 'Calculate equity')}</button>
          <button className="chip-btn" disabled={!!blocked || loading} onClick={() => { onOpenAnalysis('solver', context); setOpen(false) }}>{t('打开求解器', 'Open solver')}</button>
        </div>
      </>}
    </PokerDialog>}
  </div>
}
