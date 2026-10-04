import { useEffect, useRef, useState } from 'react'
import { useLanguage } from '../battle/i18n'
import { clearBattleProfile, loadBattleProfile, subscribeBattleProfile } from '../battle/localStats'
import type { PlayerStats } from '../battle/types'
import { ClearHistoryDialog, StatsHistoryToolbar } from './StatsHistoryControls'
import '../battle/stats.css'

function percent(value: number, total: number): string {
  return total ? `${(value / total * 100).toFixed(1)}%` : '—'
}

export function BattleStats({ stats, compact = false, title, stack, stackUnit = 'BB' }: { stats: PlayerStats; compact?: boolean; title?: string; stack?: number; stackUnit?: string }) {
  const { t } = useLanguage()
  const measures = [
    { label: 'VPIP', value: percent(stats.vpip, stats.hands), count: `${stats.vpip} / ${stats.hands}`, help: t('翻前自愿跟注或加注的手数 / 发到牌的手数，不包含只交盲注。', 'Hands with a voluntary preflop call or raise / hands dealt. Posting blinds alone does not count.') },
    { label: 'PFR', value: percent(stats.pfr, stats.hands), count: `${stats.pfr} / ${stats.hands}`, help: t('翻前至少加注一次的手数 / 发到牌的手数。', 'Hands with at least one preflop raise / hands dealt.') },
    { label: '3-bet', value: percent(stats.threeBet, stats.threeBetOpportunities), count: `${stats.threeBet} / ${stats.threeBetOpportunities}`, help: t('面对翻前首次加注时再加注 / 面对首次加注的行动机会，每手最多一次。', 'Reraises facing the first preflop raise / decisions facing that raise, at most once per hand.') },
    { label: 'C-bet', value: percent(stats.cbet, stats.cbetOpportunities), count: `${stats.cbet} / ${stats.cbetOpportunities}`, help: t('翻前最后加注者在翻牌首次行动且无人下注时下注 / 此类机会；全下无行动时不计。', 'Flop bets by the last preflop raiser on their first flop decision with no prior flop bet / such opportunities. No decision means no opportunity.') },
    { label: 'WTSD', value: percent(stats.showdowns, stats.sawFlop), count: `${stats.showdowns} / ${stats.sawFlop}`, help: t('看过翻牌且未弃牌到摊牌的手数 / 看过翻牌的手数，全下发牌也计入。', 'Hands reaching showdown after seeing the flop / hands seeing the flop, including all-in runouts.') },
    { label: 'W$SD', value: percent(stats.showdownWins, stats.showdowns), count: `${stats.showdownWins} / ${stats.showdowns}`, help: t('摊牌获得任意底池份额的手数 / 摊牌手数，包括平分和边池；不要求整手盈利。', 'Showdowns receiving any pot share / showdowns. Ties and side pots count, even if the hand has a net loss.') },
    { label: 'AF', value: stats.calls ? (stats.betsRaises / stats.calls).toFixed(2) : stats.betsRaises ? '∞' : '—', count: `${stats.betsRaises} / ${stats.calls}`, help: t('翻后的下注与加注次数 / 翻后跟注次数。无跟注但有下注时为 ∞；两者均无为 —。', 'Postflop bets and raises / postflop calls. No calls with aggression is ∞; no actions is —.') },
    { label: 'BB / 100', value: stats.hands ? `${stats.netBB >= 0 ? '+' : ''}${(stats.netBB / stats.hands * 100).toFixed(1)}` : '—', count: 'BB/100', help: t('净盈亏 / 已结算手数 × 100；买入和补码不计为盈亏。', 'Net winnings / settled hands × 100. Buy-ins and rebuys are not winnings or losses.') },
  ]
  return (
    <section className={`battle-stats ${compact ? 'battle-stats-compact' : ''}`}>
      {title && <h3>{title}</h3>}
      <div className="battle-stats-summary">
        {stack !== undefined && <div className="battle-stats-stack"><span>{t('当前筹码', 'Current stack')}</span><strong>{Number(stack.toFixed(2)).toLocaleString('en-GB')} <small>{stackUnit}</small></strong></div>}
        <div><span>{t('净盈亏', 'Net winnings')}</span><strong className={stats.netBB >= 0 ? 'battle-stat-positive' : 'battle-stat-negative'}>{stats.netBB >= 0 ? '+' : ''}{stats.netBB.toFixed(1)} <small>BB</small></strong></div>
        <div><span>{t('已完成手数', 'Hands played')}</span><strong>{stats.hands}</strong></div>
      </div>
      <div className="battle-stat-grid">
        {measures.map(measure => <div className="battle-stat-card" key={measure.label} title={measure.help}>
          <span>{measure.label}</span><strong>{measure.value}</strong>
        </div>)}
      </div>
      <details className="battle-stats-definitions">
        <summary>{t('这些数据是什么意思？', 'What do these stats mean?')}</summary>
        <dl>{measures.map(measure => <div key={measure.label}><dt>{measure.label}<span>{measure.count}</span></dt><dd>{measure.help}</dd></div>)}</dl>
        <p>{t('一手多次发牌仍只计一手；— 表示没有统计机会。小样本仅作参考。', 'Multiple runouts still count as one hand. — means no opportunities. Small samples are not reliable.')}</p>
      </details>
    </section>
  )
}

export function BattleProfileDashboard() {
  const { t } = useLanguage()
  const [profile, setProfile] = useState(loadBattleProfile)
  const [confirmClear, setConfirmClear] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => subscribeBattleProfile(() => setProfile(loadBattleProfile())), [])
  return <div ref={panelRef} tabIndex={-1} aria-label={t('对战统计', 'Private Table statistics')} className="panel battle-profile">
    <StatsHistoryToolbar title={t('我的对战数据', 'Private Table statistics')} disabled={profile.stats.hands === 0} onClear={() => setConfirmClear(true)} />
    <p className={profile.storageAvailable ? 'spot-desc' : 'input-error'}>{profile.storageAvailable
      ? t('汇总本浏览器的对战记录。清除浏览器数据后记录将丢失。', 'Private Table history saved in this browser. Clearing browser data removes it.')
      : t('浏览器存储不可用，新增对战数据仅保留在本次页面内，刷新后可能丢失。', 'Browser storage is unavailable. New Private Table data is held only in this page and may be lost on reload.')}</p>
    {profile.stats.hands === 0 && <p className="spot-desc">{t('完成第一手对战后，这里会显示你的数据。', 'Your statistics appear here after your first completed Private Table hand.')}</p>}
    <BattleStats stats={profile.stats} />
    {confirmClear && <ClearHistoryDialog
      title={t('清空对战历史？', 'Clear Private Table history?')}
      description={t('清空本浏览器保存的个人对战数据，无法撤销。房间内的统计和训练器历史不受影响；之后完成的手牌将重新累计。', 'This permanently clears personal Private Table statistics saved in this browser. Room statistics and trainer history stay unchanged. New completed hands will count from zero.')}
      onConfirm={() => { clearBattleProfile(); setConfirmClear(false) }}
      onClose={() => setConfirmClear(false)}
      fallbackFocus={() => panelRef.current?.focus()}
    />}
  </div>
}
