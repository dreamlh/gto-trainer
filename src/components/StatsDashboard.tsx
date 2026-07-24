import { useCallback, useEffect, useState } from 'react'
import { clearHands, isMemoryOnly, listHands } from '../db/handStore'
import { onHandRecord, type HandRecord } from '../game/session'
import { RANK_CHARS, SUIT_SYMBOLS, rankOf, suitOf, type Card } from '../poker/cards'
import { computeStats, type ProfileStats, type Ratio } from '../stats/compute'
import { detectLeaks, type Leak } from '../stats/leaks'

const RANGES = [
  { key: 'today', label: '今天', ms: () => Date.now() - new Date().setHours(0, 0, 0, 0) },
  { key: '7d', label: '7 天', ms: () => 7 * 86400_000 },
  { key: '30d', label: '30 天', ms: () => 30 * 86400_000 },
  { key: 'all', label: '全部', ms: () => Date.now() },
] as const

function cardText(c: Card): string {
  return RANK_CHARS[rankOf(c)] + SUIT_SYMBOLS[suitOf(c)]
}

function StatCard({ title, ratio, suffix }: { title: string; ratio: Ratio; suffix?: string }) {
  return (
    <div className="stat-card">
      <div className="stat-card-title">{title}</div>
      <div className="stat-card-value">{(ratio.user * 100).toFixed(0)}%</div>
      <div className="stat-card-sub">
        GTO {(ratio.gto * 100).toFixed(0)}% · {ratio.n} 次{suffix ?? ''}
      </div>
    </div>
  )
}

const VERDICT_COLORS: Record<string, string> = {
  optimal: '#1fa78e',
  acceptable: '#d9a441',
  wrong: '#e2574a',
}

const STREET_LABELS: Record<string, string> = {
  preflop: '翻前',
  flop: '翻牌',
  turn: '转牌',
  river: '河牌',
}

export function StatsDashboard({ active = true }: { active?: boolean }) {
  const [rangeKey, setRangeKey] = useState<(typeof RANGES)[number]['key']>('all')
  const [stats, setStats] = useState<ProfileStats | null>(null)
  const [leaks, setLeaks] = useState<Leak[]>([])
  const [recent, setRecent] = useState<HandRecord[]>([])
  const [reloadFlag, setReloadFlag] = useState(0)

  useEffect(() => onHandRecord(() => setReloadFlag((x) => x + 1)), [])

  const reload = useCallback(async () => {
    const r = RANGES.find((x) => x.key === rangeKey)!
    const from = rangeKey === 'all' ? 0 : Date.now() - r.ms()
    const hands = await listHands(from, Date.now())
    const s = computeStats(hands)
    setStats(s)
    setLeaks(detectLeaks(s))
    setRecent(hands.slice(-30).reverse())
  }, [rangeKey])

  useEffect(() => {
    if (active) void reload()
  }, [active, reload, reloadFlag])

  const clearAll = async () => {
    if (!confirm('确定清空全部训练历史？此操作不可恢复。')) return
    await clearHands()
    void reload()
  }

  if (!stats) return <div className="panel">加载统计中…</div>

  return (
    <div>
      <div className="trainer-settings">
        {RANGES.map((r) => (
          <button
            key={r.key}
            className={`chip-btn ${r.key === rangeKey ? 'chip-btn-active' : ''}`}
            onClick={() => setRangeKey(r.key)}
          >
            {r.label}
          </button>
        ))}
        {stats.hands > 0 && (
          <button className="link-btn" onClick={clearAll}>
            清空历史
          </button>
        )}
      </div>
      {isMemoryOnly() && (
        <p className="input-error">浏览器存储不可用（隐私模式？），本次数据仅保存在内存。</p>
      )}

      <div className="panel">
        <div className="stats-row">
          <span>
            共 <b>{stats.hands}</b> 手
          </span>
          <span>
            盈亏 <b>{stats.netBB >= 0 ? '+' : ''}{stats.netBB.toFixed(1)}bb</b>（{stats.settledHands} 手结算）
          </span>
          <span>
            决策 <b>{stats.decisions}</b> · 最优率 <b>{(stats.optimalRate * 100).toFixed(0)}%</b>
          </span>
          <span>
            平均每手 EV 损失 <b>{stats.evLossPerHand.toFixed(2)}bb</b>
          </span>
        </div>

        {stats.hands === 0 ? (
          <p className="spot-desc">还没有训练记录——去训练器打几手牌吧。</p>
        ) : (
          <>
            <div className="stat-grid">
              <StatCard title="入池率 VPIP" ratio={stats.vpip} />
              <StatCard title="翻前加注 PFR" ratio={stats.pfr} />
              <StatCard title="3-bet" ratio={stats.threeBet} />
              <StatCard title="弃牌于 3-bet" ratio={stats.foldTo3Bet} />
              <StatCard title="持续下注 C-bet" ratio={stats.cbet} />
              <StatCard title="BB 弃牌 vs 开局" ratio={stats.bbDefendFold} />
              <StatCard title="BTN 偷盲" ratio={stats.btnSteal} />
              <StatCard title="河牌跟注 vs 下注" ratio={stats.riverCallVsBet} />
              <StatCard title="看牌到摊牌 WTSD" ratio={stats.wtsd} />
            </div>

            {stats.byPosition.length > 0 && (
              <div className="pos-table-wrap">
                <table className="pos-table">
                  <thead>
                    <tr>
                      <th>位置</th>
                      <th>手数</th>
                      <th>VPIP</th>
                      <th>PFR</th>
                      <th>EV损失/决策</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.byPosition.map((p) => (
                      <tr key={p.pos}>
                        <td>{p.pos}</td>
                        <td>{p.hands}</td>
                        <td>{(p.vpip * 100).toFixed(0)}%</td>
                        <td>{(p.pfr * 100).toFixed(0)}%</td>
                        <td>{p.evLoss.toFixed(2)}bb</td>
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
          <h2 className="spot-title">弱点分析</h2>
          {leaks.length === 0 ? (
            <p className="spot-desc">未检测到显著弱点——继续保持，扩大样本后再看。</p>
          ) : (
            <div className="leak-list">
              {leaks.map((l) => (
                <div key={l.id} className="leak-item">
                  <div className="leak-head">
                    <b>{l.title}</b>
                    <span className="verdict-score">
                      你 {(l.user * 100).toFixed(0)}% · GTO {(l.gto * 100).toFixed(0)}% · {l.n} 次机会
                    </span>
                  </div>
                  <p className="leak-advice">{l.advice}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {stats.hands > 0 && stats.hands < 30 && (
        <div className="panel" style={{ marginTop: 14 }}>
          <p className="spot-desc">弱点分析需要至少 30 手样本（当前 {stats.hands} 手）。</p>
        </div>
      )}

      {recent.length > 0 && (
        <div className="panel" style={{ marginTop: 14 }}>
          <h2 className="spot-title">最近牌局</h2>
          <div className="hand-list">
            {recent.map((r) => (
              <details key={r.id} className="hand-item">
                <summary>
                  <span className="hand-cards">{r.heroCards.map(cardText).join(' ')}</span>
                  <span className="verdict-score">
                    {r.tableSize}人 · {r.heroPos}
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
                      ? '未结算'
                      : `${r.result.deltaBB >= 0 ? '+' : ''}${r.result.deltaBB.toFixed(1)}bb`}
                  </span>
                  <span className="verdict-score">
                    {new Date(r.ts).toLocaleString('zh-CN', {
                      month: 'numeric',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </summary>
                <div className="hand-detail">
                  {r.board.length > 0 && (
                    <div className="spot-desc">公共牌：{r.board.map(cardText).join(' ')}</div>
                  )}
                  {r.decisions.map((d, i) => (
                    <div key={i} className="decision-item">
                      <span className="decision-street">{STREET_LABELS[d.street]}</span>
                      <span style={{ color: VERDICT_COLORS[d.verdict], minWidth: 64 }}>
                        {d.verdict === 'optimal' ? '✓' : d.verdict === 'acceptable' ? '~' : '✗'}{' '}
                        {d.labels[d.chosen]}
                      </span>
                      <span className="verdict-score">
                        GTO：{d.labels.map((l, j) => `${l} ${(d.freqs[j] * 100).toFixed(0)}%`).join(' / ')}
                        {d.evs && d.evLoss > 0.001 && ` · EV损失 ${d.evLoss.toFixed(2)}bb`}
                      </span>
                    </div>
                  ))}
                  {r.result.note && <p className="spot-desc">{r.result.note}</p>}
                </div>
              </details>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
