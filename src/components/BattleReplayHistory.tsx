import { useEffect, useState } from 'react'
import { listReplays, subscribeReplays } from '../db/replayStore'
import type { OpenAnalysis } from '../analysis/types'
import { useLanguage } from '../battle/i18n'
import { ReplayButton } from './ReplayButton'
import { CardFace } from './CardFace'
import { historySections } from '../battle/history'
import { bettingActionName } from '../battle/presentation'

export function useReplayRecords() {
  const [value, setValue] = useState<Awaited<ReturnType<typeof listReplays>>>({ records: [], available: true, bytes: 0 })
  useEffect(() => {
    let alive = true, generation = 0
    const reload = () => { const g = ++generation; void listReplays().then(result => { if (alive && g === generation) setValue(result) }) }
    reload(); const unsubscribe = subscribeReplays(reload)
    return () => { alive = false; unsubscribe() }
  }, [])
  return value
}
export function BattleReplayHistory({ data, onOpenAnalysis }: { data: ReturnType<typeof useReplayRecords>; onOpenAnalysis?: OpenAnalysis }) {
  const { t, language } = useLanguage()
  const [limit, setLimit] = useState(20)
  return <section className="analysis-history-list">
    <h3>{t('本机复盘记录', 'Reviews on this device')}</h3>
    <p className="spot-desc">{data.records.length} / 1,000 {t('手', 'hands')} · {t('估算', 'Approximately')} {(data.bytes / 1024 / 1024).toFixed(2)} MB</p>
    <p className="spot-desc">{t('保存在当前浏览器，最多保留最近 1,000 手。清除网站数据会删除记录，设备之间不会自动同步。', 'Stored in this browser, up to the latest 1,000 hands. Clearing website data removes these records; devices do not sync automatically.')}</p>
    {!data.available && <p className="input-error">{t('本机存储不可用或写入失败，部分新增复盘仅保存在本页内存。', 'Local storage is unavailable or a write failed. Some new reviews are only held in this page’s memory.')}</p>}
    {data.records.length === 0 && <p className="spot-desc">{t('完成对战后，这里会保存可复盘的牌局。旧汇总统计无法还原完整牌局。', 'Completed Private Table hands appear here. Older aggregate statistics cannot reconstruct full hands.')}</p>}
    {data.records.slice(0, limit).map(record => <details key={record.id}>
      <summary>#{record.hand.number} · {new Date(record.hand.finishedAt).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-GB')} · {record.hand.players.length} {t('人', 'players')}</summary>
      <div className="slot-row">{record.hand.myCards?.map(c => <CardFace key={c} card={c} />)}</div>
      <ReplayButton battle={record} onOpenAnalysis={onOpenAnalysis} />
      {historySections(record.hand).map(section => <div key={section.street}>
        <strong>{t({ preflop: '翻前', flop: '翻牌', turn: '转牌', river: '河牌' }[section.street], { preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River' }[section.street])}</strong>
        {section.boards.map(board => <div className="slot-row" key={board.run}>{board.cards.map(c => <CardFace key={c} card={c} />)}</div>)}
        <ol>{section.actions.map(({ action, index }) => <li key={index}>{record.hand.players.find(p => p.id === action.playerId)?.name} · {bettingActionName(record.hand.history, index, t)} {action.amount > 0 ? `${action.amount} ${record.hand.replay?.mode === 'tournament' ? t('筹码', 'chips') : 'BB'}` : ''}</li>)}</ol>
      </div>)}
    </details>)}
    {limit < data.records.length && <button type="button" className="chip-btn" onClick={() => setLimit(v => v + 20)}>{t('显示更多', 'Show more')}</button>}
  </section>
}
