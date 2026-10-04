import { useCallback, useEffect, useRef, useState } from 'react'
import { clearHands, countHands, isMemoryOnly, listHands } from '../db/handStore'
import { onHandRecord, type HandRecord } from '../game/session'
import { RANK_CHARS, SUIT_SYMBOLS, rankOf, suitOf, type Card } from '../poker/cards'
import { computeStats, type ProfileStats, type Ratio } from '../stats/compute'
import { detectLeaks, type Leak } from '../stats/leaks'
import { useLanguage } from '../battle/i18n'
import { BattleProfileDashboard } from './BattleStats'
import { ClearHistoryDialog, StatsHistoryToolbar } from './StatsHistoryControls'
import { positionName } from '../poker/presentation'
import { trainerAction, trainerError, trainerLeak, trainerLeakComparison, trainerNote, trainerStreet, trainerVerdict } from '../game/trainerPresentation'

const RANGES = [
  { key: 'today', label: '今天', en: 'Today', ms: () => Date.now() - new Date().setHours(0, 0, 0, 0) },
  { key: '7d', label: '7 天', en: '7 days', ms: () => 7 * 86400_000 },
  { key: '30d', label: '30 天', en: '30 days', ms: () => 30 * 86400_000 },
  { key: 'all', label: '全部', en: 'All time', ms: () => Date.now() },
] as const

function cardText(c: Card): string {
  return RANK_CHARS[rankOf(c)] + SUIT_SYMBOLS[suitOf(c)]
}

function StatCard({ title, ratio, suffix }: { title: string; ratio: Ratio; suffix?: string }) {
  const { t } = useLanguage()
  return (
    <div className="stat-card">
      <div className="stat-card-title">{title}</div>
      <div className="stat-card-value">{(ratio.user * 100).toFixed(0)}%</div>
      <div className="stat-card-sub">
        GTO {(ratio.gto * 100).toFixed(0)}% · {ratio.n} {t('次', ratio.n === 1 ? 'opportunity' : 'opportunities')}{suffix ?? ''}
      </div>
    </div>
  )
}

const VERDICT_COLORS: Record<string, string> = {
  optimal: '#1fa78e',
  acceptable: '#d9a441',
  wrong: '#e2574a',
}

export function StatsDashboard({ active = true }: { active?: boolean }) {
  const { t } = useLanguage()
  const [scope, setScope] = useState<'battle' | 'training'>('battle')
  return <div>
    <div className="stats-scope-tabs" role="group" aria-label={t('统计来源', 'Statistics source')}>
      <button className={`chip-btn ${scope === 'battle' ? 'chip-btn-active' : ''}`} aria-pressed={scope === 'battle'} onClick={() => setScope('battle')}>{t('好友对战', 'Private Table')}</button>
      <button className={`chip-btn ${scope === 'training' ? 'chip-btn-active' : ''}`} aria-pressed={scope === 'training'} onClick={() => setScope('training')}>{t('GTO 训练', 'GTO training')}</button>
    </div>
    <div hidden={scope !== 'battle'}><BattleProfileDashboard /></div>
    <div hidden={scope !== 'training'}><TrainingStatsDashboard active={active && scope === 'training'} /></div>
  </div>
}

function TrainingStatsDashboard({ active }: { active: boolean }) {
  const { language, t } = useLanguage()
  const [rangeKey, setRangeKey] = useState<(typeof RANGES)[number]['key']>('all')
  const [stats, setStats] = useState<ProfileStats | null>(null)
  const [totalHands, setTotalHands] = useState(0)
  const [leaks, setLeaks] = useState<Leak[]>([])
  const [recent, setRecent] = useState<HandRecord[]>([])
  const [reloadFlag, setReloadFlag] = useState(0)
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [clearError, setClearError] = useState('')
  const [loadError, setLoadError] = useState('')
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => onHandRecord(() => setReloadFlag((x) => x + 1)), [])

  const reload = useCallback(async () => {
    const r = RANGES.find((x) => x.key === rangeKey)!
    const from = rangeKey === 'all' ? 0 : Date.now() - r.ms()
    try {
      const [hands, total] = await Promise.all([listHands(from, Date.now()), countHands()])
      setTotalHands(total)
      const s = computeStats(hands)
      setStats(s)
      setLeaks(detectLeaks(s))
      setRecent(hands.slice(-30).reverse())
      setLoadError('')
    } catch (error) {
      setLoadError((error as Error).message)
    }
  }, [rangeKey])

  useEffect(() => {
    if (active) void reload()
  }, [active, reload, reloadFlag])

  const clearAll = async () => {
    setClearing(true)
    setClearError('')
    try {
      await clearHands()
      setStats(computeStats([]))
      setTotalHands(0)
      setLeaks([])
      setRecent([])
      await reload()
      setConfirmClear(false)
    } catch (error) {
      setClearError((error as Error).message)
    } finally {
      setClearing(false)
    }
  }

  if (!stats) return <div className="panel">{loadError ? <><p className="input-error">{t('无法加载训练历史', 'Could not load training history')}: {trainerError(loadError, language)}</p><button className="chip-btn" onClick={() => void reload()}>{t('重试', 'Retry')}</button></> : t('加载统计中…', 'Loading statistics…')}</div>

  return (
    <div ref={panelRef} tabIndex={-1} aria-label={t('训练统计', 'Training statistics')}>
      <div className="panel">
        <StatsHistoryToolbar title={t('我的训练数据', 'GTO training statistics')} disabled={totalHands === 0} onClear={() => { setClearError(''); setConfirmClear(true) }} />
        <div className="trainer-settings">
          {RANGES.map((r) => (
            <button
              key={r.key}
              className={`chip-btn ${r.key === rangeKey ? 'chip-btn-active' : ''}`}
              aria-pressed={r.key === rangeKey}
              onClick={() => setRangeKey(r.key)}
            >
              {t(r.label, r.en)}
            </button>
          ))}
        </div>
        {loadError && <p className="input-error">{t('无法加载训练历史', 'Could not load training history')}: {trainerError(loadError, language)}</p>}
        {isMemoryOnly() && (
          <p className="input-error">{t('浏览器存储不可用，本次数据仅保存在内存。', 'Browser storage is unavailable. These records are held in memory only.')}</p>
        )}

        <div className="stats-row">
          <span>
            {t('共', 'Total')} <b>{stats.hands}</b> {t('手', stats.hands === 1 ? 'hand' : 'hands')}
          </span>
          <span>
            {t('盈亏', 'Net')} <b>{stats.netBB >= 0 ? '+' : ''}{stats.netBB.toFixed(1)} BB</b> ({stats.settledHands} {t('手结算', stats.settledHands === 1 ? 'settled hand' : 'settled hands')})
          </span>
          <span>
            {t('决策', stats.decisions === 1 ? 'Decision' : 'Decisions')} <b>{stats.decisions}</b> · {t('最优率', 'Optimal')} <b>{(stats.optimalRate * 100).toFixed(0)}%</b>
          </span>
          <span>
            {t('平均每手 EV 损失', 'EV loss / hand')} <b>{stats.evLossPerHand.toFixed(2)} BB</b>
          </span>
        </div>

        {stats.hands === 0 ? (
          <p className="spot-desc">{t('还没有训练记录，完成训练后将在这里显示。', 'No training records yet. Completed trainer hands will appear here.')}</p>
        ) : (
          <>
            <div className="stat-grid">
              <StatCard title={t('入池率 VPIP', 'VPIP')} ratio={stats.vpip} />
              <StatCard title={t('翻前加注 PFR', 'Preflop raise · PFR')} ratio={stats.pfr} />
              <StatCard title="3-bet" ratio={stats.threeBet} />
              <StatCard title={t('弃牌于 3-bet', 'Fold to 3-bet')} ratio={stats.foldTo3Bet} />
              <StatCard title={t('持续下注 C-bet', 'Continuation bet')} ratio={stats.cbet} />
              <StatCard title={t('BB 弃牌 vs 开局', 'BB fold vs open')} ratio={stats.bbDefendFold} />
              <StatCard title={t('BTN 偷盲', 'BTN steal')} ratio={stats.btnSteal} />
              <StatCard title={t('河牌跟注 vs 下注', 'River call vs bet')} ratio={stats.riverCallVsBet} />
              <StatCard title={t('看牌到摊牌 WTSD', 'Went to showdown')} ratio={stats.wtsd} />
            </div>

            {stats.byPosition.length > 0 && (
              <div className="pos-table-wrap">
                <table className="pos-table">
                  <thead>
                    <tr>
                      <th>{t('位置', 'Position')}</th>
                      <th>{t('手数', 'Hands')}</th>
                      <th>VPIP</th>
                      <th>PFR</th>
                      <th>{t('EV损失/决策', 'EV loss / decision')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.byPosition.map((p) => (
                      <tr key={p.pos}>
                        <td>{positionName(p.pos, language)}</td>
                        <td>{p.hands}</td>
                        <td>{(p.vpip * 100).toFixed(0)}%</td>
                        <td>{(p.pfr * 100).toFixed(0)}%</td>
                        <td>{p.evLoss.toFixed(2)} BB</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      {stats.hands >= 30 && (
        <div className="panel" style={{ marginTop: 14 }}>
          <h2 className="spot-title">{t('弱点分析', 'Leak analysis')}</h2>
          {leaks.length === 0 ? (
            <p className="spot-desc">{t('未检测到显著弱点，扩大样本后可继续检查。', 'No significant leaks detected. Revisit this with a larger sample.')}</p>
          ) : (
            <div className="leak-list">
              {leaks.map((l) => (
                <div key={l.id} className="leak-item">
                  <div className="leak-head">
                    <b>{trainerLeak(l, language).title}</b>
                    <span className="verdict-score">
                      {trainerLeakComparison(l, language)}
                    </span>
                  </div>
                  <p className="leak-advice">{trainerLeak(l, language).advice}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {stats.hands > 0 && stats.hands < 30 && (
        <div className="panel" style={{ marginTop: 14 }}>
          <p className="spot-desc">{t('弱点分析需要至少 30 手样本', 'Leak analysis needs at least 30 hands')} ({stats.hands}/30).</p>
        </div>
      )}

      {recent.length > 0 && (
        <div className="panel" style={{ marginTop: 14 }}>
          <h2 className="spot-title">{t('最近牌局', 'Recent hands')}</h2>
          <div className="hand-list">
            {recent.map((r) => (
              <details key={r.id} className="hand-item">
                <summary>
                  <span className="hand-cards">{r.heroCards.map(cardText).join(' ')}</span>
                  <span className="verdict-score">
                    {r.tableSize} {t('人', 'players')} · {positionName(r.heroPos, language)}
                  </span>
                  <span
                    style={{
                      color:
                        r.result.deltaBB === null
                          ? '#d9a441'
                          : r.result.deltaBB >= 0
                            ? '#1fa78e'
                            : '#e2574a',
                      fontWeight: 600,
                    }}
                  >
                    {r.result.deltaBB === null
                      ? t('未结算', 'Unsettled')
                      : `${r.result.deltaBB >= 0 ? '+' : ''}${r.result.deltaBB.toFixed(1)} BB`}
                  </span>
                  <span className="verdict-score">
                    {new Date(r.ts).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-GB', {
                      month: 'numeric',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </summary>
                <div className="hand-detail">
                  {r.board.length > 0 && (
                    <div className="spot-desc">{t('公共牌', 'Board')}: {r.board.map(cardText).join(' ')}</div>
                  )}
                  {r.decisions.map((d, i) => (
                    <div key={i} className="decision-item">
                      <span className="decision-street">{trainerStreet(d.street, language)}</span>
                      <span style={{ color: VERDICT_COLORS[d.verdict], minWidth: 64 }} title={trainerVerdict(d.verdict, language)}>
                        {d.verdict === 'optimal' ? '✓' : d.verdict === 'acceptable' ? '~' : '✗'}{' '}
                        {trainerAction(d.labels[d.chosen], language)}
                      </span>
                      <span className="verdict-score">
                        GTO: {d.labels.map((l, j) => `${trainerAction(l, language)} ${(d.freqs[j] * 100).toFixed(0)}%`).join(' / ')}
                        {d.evs && d.evLoss > 0.001 && ` · ${t('EV损失', 'EV loss')} ${d.evLoss.toFixed(2)} BB`}
                      </span>
                    </div>
                  ))}
                  {r.result.note && <p className="spot-desc">{trainerNote(r.result.note, language)}</p>}
                </div>
              </details>
            ))}
          </div>
        </div>
      )}
      {confirmClear && <ClearHistoryDialog
        title={t('清空训练历史？', 'Clear training history?')}
        description={t('将清空全部训练记录，无法撤销。好友对战数据不受影响。', 'This permanently deletes all training records. Private Table statistics stay unchanged.')}
        busy={clearing}
        error={clearError ? `${t('清空失败', 'Could not clear history')}: ${trainerError(clearError, language)}` : undefined}
        onConfirm={() => void clearAll()}
        onClose={() => setConfirmClear(false)}
        fallbackFocus={() => panelRef.current?.focus()}
      />}
    </div>
  )
}
