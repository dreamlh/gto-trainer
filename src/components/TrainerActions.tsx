import type { CSSProperties } from 'react'
import type { SessionSnapshot } from '../game/session'
import { normalizeDecisionRecord } from '../game/decisionQuality'
import { describeTrainerSpot, trainerNote, trainerStreet, trainerVerdict } from '../game/trainerPresentation'
import { useLanguage } from '../battle/i18n'
import { ActionLabel, DecisionDock } from './PokerDecisionDock'

const bb = (value: number) => Number(value.toFixed(1)).toLocaleString('en-GB')

/** Every available solver action is committed directly, preserving its original index. */
export function TrainerActions({ snap, onAction, onNext, revealAll, onReveal, onFeedback }: {
  snap: SessionSnapshot
  onAction: (index: number) => void
  onNext: () => void
  revealAll: boolean
  onReveal: () => void
  onFeedback: () => void
}) {
  const { language, t } = useLanguage()
  const indexed = snap.heroActions.map((action, index) => ({ ...action, index }))
  const hero = snap.engine?.players[snap.heroSeat]
  const maxStreetBet = snap.engine ? Math.max(...snap.engine.players.map(player => player.invested - player.streetBase)) : 0
  const callAmount = hero && snap.engine ? Math.min(snap.engine.stack - hero.invested, Math.max(0, maxStreetBet - (hero.invested - hero.streetBase))) : 0
  const decision = snap.lastDecision ? normalizeDecisionRecord(snap.lastDecision) : null
  const feedback = decision && <button type="button" className={`trainer-feedback-link trainer-verdict-${decision.verdict}`} onClick={onFeedback} aria-label={`${t('打开策略反馈', 'Open strategy feedback')}: ${trainerVerdict(decision.verdict, language)}${decision.evLoss != null ? `, ${t('EV 损失', 'EV loss')} ${decision.evLoss.toFixed(2)} BB` : ''}`}>
    <span>{trainerVerdict(decision.verdict, language)}</span>{decision.evLoss != null && <span>· {t('EV 损失', 'EV loss')} {decision.evLoss.toFixed(2)} BB</span>}
  </button>

  if (snap.phase === 'hand-done' && snap.result) {
    const result = snap.result
    return <DecisionDock active={false} className="ba-result trainer-result" label={t('本手结果', 'Hand result')}>
      <div className="ba-result-top">
        <div className="ba-result-summary"><span>{t('本手结束', 'Hand complete')}</span>{result.deltaBB !== null
          ? <strong className={result.deltaBB >= 0 ? 'ba-win' : 'ba-loss'}>{result.deltaBB >= 0 ? '+' : ''}{bb(result.deltaBB)} <small>BB</small></strong>
          : <strong className="ba-settling">{t('仅评决策', 'Decisions scored')}</strong>}
        </div>
        <div className="ba-next-hand trainer-result-meta">{feedback}<span>{result.heroFolded ? t('你已弃牌', 'You folded') : result.wentToShowdown ? t('摊牌', 'Showdown') : ''}</span></div>
      </div>
      <div className="ba-dock-body trainer-result-body">
        {result.note && <p className="ba-note trainer-result-note">{trainerNote(result.note, language)}</p>}
        <div className="trainer-result-actions">
          <button type="button" className="ba-action ba-action-primary" onClick={onNext}><ActionLabel>{t('下一手', 'Next hand')}</ActionLabel></button>
          <button type="button" className="battle-button battle-button-subtle" disabled={revealAll} onClick={onReveal}>{revealAll ? t('已亮牌', 'Cards shown') : t('亮牌', 'Show cards')}</button>
        </div>
      </div>
    </DecisionDock>
  }

  if (snap.phase !== 'hero-turn' || !snap.engine) {
    const solving = snap.phase === 'solving'
    const progress = snap.solveProgress
    return <DecisionDock active={false} className="ba-idle" label={t('牌局状态', 'Hand status')}>
      <div className="ba-idle-head"><span className="ba-idle-label" role="status">{snap.error ? t('训练暂停', 'Training paused') : solving ? t('正在求解本街策略', 'Solving this street') : snap.engine ? t('对手思考中…', 'Opponent is thinking…') : t('正在加载翻前解…', 'Loading preflop solutions…')}</span>{feedback ?? (progress && progress.total > 1 && <span className="ba-idle-clock">{Math.round(progress.iter / progress.total * 100)}%</span>)}</div>
      <div className="ba-dock-body"><dl className="ba-waiting-facts">
        <div><dt>{t('剩余筹码', 'Your stack')}</dt><dd>{hero && snap.engine ? bb(Math.max(0, snap.engine.stack - hero.invested)) : '—'} <small>BB</small></dd></div>
        <div><dt>{solving ? t('求解街道', 'Solving street') : t('本轮投入', 'This round')}</dt><dd>{solving && progress ? trainerStreet(progress.street, language) : <>{hero ? bb(hero.invested - hero.streetBase) : '—'} <small>BB</small></>}</dd></div>
      </dl></div>
    </DecisionDock>
  }

  return <DecisionDock active className="ba-decision trainer-decision" label={t('轮到你行动', 'Your turn')}>
    <div className="ba-status-row"><strong className="ba-your-turn"><span aria-hidden="true" />{t('轮到你', 'Your turn')}</strong><span className="trainer-turn-spot" title={describeTrainerSpot(snap.engine, snap.heroSeat, language)}>{describeTrainerSpot(snap.engine, snap.heroSeat, language).replace(/^[^:]+:\s*/, '')}</span><span className="ba-idle-clock">{t('不限时', 'Unlimited')}</span></div>
    <div className="ba-actions trainer-direct-actions" style={{ '--trainer-action-count': indexed.length, '--trainer-mobile-columns': indexed.length <= 3 ? indexed.length : Math.ceil(indexed.length / 2) } as CSSProperties}>
      {indexed.map(action => {
        const passive = action.kind === 'call' || action.kind === 'check'
        const aggressive = !passive && action.kind !== 'fold'
        const allIn = aggressive && hero && action.amount >= snap.engine!.stack - hero.streetBase - .001
        const label = action.kind === 'fold' ? t('弃牌', 'Fold') : action.kind === 'check' ? t('过牌', 'Check')
          : action.kind === 'call' ? hero && snap.engine!.stack - hero.invested <= callAmount ? t('全下跟注', 'Call all-in') : t('跟注', 'Call')
          : allIn ? t('全下', 'All-in') : action.kind === 'bet' ? t('下注', 'Bet') : t('加注至', 'Raise to')
        return <button type="button" key={action.index} className={`ba-action ${action.kind === 'fold' ? 'ba-action-fold' : passive ? 'ba-action-call' : 'ba-action-primary'}`} title={`${t('快捷键', 'Shortcut')}: ${action.index + 1}`} onClick={() => onAction(action.index)}>
          <ActionLabel><span>{label}</span>{(aggressive || action.kind === 'call') && <strong>{bb(action.kind === 'call' ? callAmount : action.amount)} <small>BB</small></strong>}</ActionLabel>
        </button>
      })}
    </div>
  </DecisionDock>
}
