import { useEffect, useState } from 'react'
import type { DecisionRecord, SessionSnapshot } from '../game/session'
import { normalizeDecisionRecord } from '../game/decisionQuality'
import { trainerAction, trainerHistoryActions, trainerNote, trainerStreet, trainerVerdict } from '../game/trainerPresentation'
import { useLanguage } from '../battle/i18n'
import { actionName } from '../poker/presentation'
import { ACTION_COLORS } from '../poker/ranges'

function actionColor(decision: DecisionRecord, index: number): string {
  const kind = decision.kinds?.[index] ?? actionName(decision.labels[index], 'en').toLowerCase().split(' ')[0]
  return kind === 'fold' ? '#5c7cba' : ['check', 'call'].includes(kind) ? ACTION_COLORS.call : ACTION_COLORS.raise
}

export function TrainerFeedback({ snap, tab }: { snap: SessionSnapshot; tab: 'feedback' | 'history' }) {
  const { language, t } = useLanguage()
  const [reviewIndex, setReviewIndex] = useState<number | null>(null)
  useEffect(() => { setReviewIndex(null) }, [snap.engine, snap.decisions.length])
  const selected = reviewIndex === null ? snap.lastDecision : snap.decisions[reviewIndex]
  const decision = selected ? normalizeDecisionRecord(selected) : null

  if (tab === 'history') return <div className="trainer-history">
    <div className="battle-sidebar-title"><h3>{t('本手行动', 'This hand’s actions')}</h3><span>{snap.engine?.history.length ?? 0}</span></div>
    <div className="trainer-panel-scroll battle-log">
      <p className="battle-record-legend">{t('加注显示本轮总额；跟注显示本次投入。', 'Raises show the street total; calls show chips added.')}</p>
      {snap.engine?.history.length ? ['preflop', 'flop', 'turn', 'river'].map(street => {
        const actions = trainerHistoryActions(snap.engine!).filter(action => action.street === street)
        if (!actions.length) return null
        return <section className={`battle-history-street is-${street}`} key={street}><header><h3>{trainerStreet(street, language)}</h3></header><ol>{actions.map((action, index) => <li key={index} className={action.seat === snap.heroSeat ? 'is-self' : ''}>
          <div className="battle-history-player"><strong>{action.seat === snap.heroSeat ? t('你', 'You') : t(`电脑 ${action.seat + 1}`, `Bot ${action.seat + 1}`)}</strong><small>{snap.engine!.positions[action.seat]}</small></div>
          <div className="battle-history-action"><span>{action.allin ? action.kind === 'call' ? t('全下跟注', 'Call all-in') : t('全下', 'All-in') : action.kind === 'raise' ? t('加注至', 'Raise to') : actionName(action.kind, language)}</span>{action.amount !== null && <strong>{Number(action.amount.toFixed(1))} <small>BB</small></strong>}</div>
        </li>)}</ol></section>
      }) : <p className="battle-empty-note">{t('行动后显示本手记录', 'Actions appear here as the hand progresses')}</p>}
    </div>
  </div>

  return <div className="trainer-feedback">
    <div className="battle-sidebar-title"><h3>{t('决策分析', 'Decision analysis')}</h3><span>{snap.decisions.length}{t(' 次决策', ' decisions')}</span></div>
    <div className="trainer-panel-scroll">
      {!decision ? <p className="battle-empty-note">{t('行动后显示策略频率与 EV 反馈', 'Strategy frequencies and EV feedback appear after your decision')}</p> : <section className={`trainer-decision-review tt-decision-feedback trainer-verdict-${decision.verdict}`} key={`${reviewIndex}:${snap.decisions.length}`}>
        <div className="trainer-verdict-row"><strong>{trainerVerdict(decision.verdict, language)}</strong><span>{trainerStreet(decision.street, language)}</span></div>
        <p className="trainer-chosen">{t('你的选择', 'Your choice')} · <strong>{trainerAction(decision.labels[decision.chosen], language)}</strong></p>
        <dl className="trainer-ev-loss"><dt>{t('EV 损失', 'EV loss')}</dt><dd>{decision.evLoss != null ? `${decision.evLoss.toFixed(2)} BB` : '—'}</dd></dl>
        {decision.verdict !== 'unavailable' && <div className="freq-bar freq-bar-slim" aria-label={t('GTO 策略频率', 'GTO strategy frequencies')}>{decision.freqs.map((frequency, index) => <div className="freq-seg" key={index} style={{ width: `${Math.max(0, frequency * 100)}%`, backgroundColor: actionColor(decision, index) }} />)}</div>}
        <div className="trainer-strategy-heading"><span>{t('动作', 'Action')}</span><span>{t('频率', 'Frequency')}</span><span>EV / BB</span></div>
        <ul className="trainer-strategy-list">{decision.labels.map((label, index) => <li key={index} className={index === decision.chosen ? 'is-chosen' : ''}>
          <span><i aria-hidden="true" style={{ backgroundColor: actionColor(decision, index) }} />{trainerAction(label, language)}{index === decision.chosen && <small aria-label={t('你的选择', 'Your choice')}>✓</small>}</span>
          <strong>{decision.verdict === 'unavailable' ? '—' : `${(decision.freqs[index] * 100).toFixed(0)}%`}</strong><strong>{decision.evs?.[index]?.toFixed(2) ?? '—'}</strong>
        </li>)}</ul>
        {decision.verdict === 'unavailable' ? <p className="trainer-feedback-note">{t('当前手牌或行动路线没有有效策略数据，本次不评分。', 'No valid strategy data is available for this hand or action line. This decision is not scored.')}</p>
          : !decision.evs && <p className="trainer-feedback-note">{t('此节点未保存 EV，仅展示策略频率。', 'EV is unavailable for this node. Strategy frequencies are shown.')}</p>}
      </section>}
      {snap.decisions.length > 0 && <section className="trainer-review-list"><div className="trainer-review-heading"><h3>{t('本手决策', 'Decisions in this hand')}</h3><span>{t('EV 损失', 'EV loss')}</span></div>{snap.decisions.map(normalizeDecisionRecord).map((item, index) => <button type="button" key={index} aria-pressed={reviewIndex === index || reviewIndex === null && index === snap.decisions.length - 1} onClick={() => setReviewIndex(index)}><span>{trainerStreet(item.street, language)} · {trainerAction(item.labels[item.chosen], language)}</span><strong className={`trainer-verdict-${item.verdict}`}>{item.verdict === 'unavailable' ? trainerVerdict(item.verdict, language) : item.evLoss != null ? `${item.evLoss.toFixed(2)} BB` : '—'}</strong></button>)}</section>}
      {snap.result?.note && <p className="trainer-feedback-note trainer-hand-note">{trainerNote(snap.result.note, language)}</p>}
      {snap.phase === 'hand-done' && !snap.decisions.length && !snap.result?.note && <p className="trainer-feedback-note">{t('本手没轮到你决策。', 'You had no decision in this hand.')}</p>}
    </div>
  </div>
}
