import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  onHandRecord,
  trainerSession,
  type HandRecord,
} from '../game/session'
import { useLanguage } from '../battle/i18n'
import { trainerError } from '../game/trainerPresentation'
import { normalizeDecisionRecord } from '../game/decisionQuality'
import { trainerTableEvents } from '../game/trainerTableEvents'
import { useBattleVisuals } from './useBattleVisuals'
import { usePokerAudioEvents } from './usePokerAudioEvents'
import { PokerAllInEffect } from './PokerAllInEffect'
import { setBattleTensionMusic } from '../battle/audio'
import { battleTensionKey } from '../battle/tensionMusic'
import { TableView } from './TableView'
import { TrainerActions } from './TrainerActions'
import { TrainerFeedback } from './TrainerFeedback'
import { PokerDialog } from './PokerDialog'
import { usePokerTableViewport } from './usePokerTableViewport'
import { PokerSettingSwitch } from './PokerSettingSwitch'
import './trainer.css'

const TABLE_SIZES = [2, 3, 4, 5, 6, 7, 8, 9]

// 会话内简单统计（完整统计在数据页）
interface Tally {
  hands: number
  decisions: number
  evaluatedDecisions: number
  evDecisions: number
  optimal: number
  wrong: number
  evLossSum: number
  net: number
  netHands: number
}

const PREFS_KEY = 'gto-trainer-prefs'
function loadPrefs(): { tableSize: number; preflopOnly: boolean } {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (raw) {
      const p = JSON.parse(raw)
      if (TABLE_SIZES.includes(p.tableSize)) return { tableSize: p.tableSize, preflopOnly: !!p.preflopOnly }
    }
  } catch {
    /* 无存储环境 */
  }
  return { tableSize: 6, preflopOnly: false }
}
function savePrefs(p: { tableSize: number; preflopOnly: boolean }) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p))
  } catch {
    /* ignore */
  }
}

export function Trainer({ active = true }: { active?: boolean }) {
  const { language, t } = useLanguage()
  const snap = useSyncExternalStore(trainerSession.subscribe, trainerSession.getSnapshot)
  const [prefs] = useState(loadPrefs)
  const [tableSize, setTableSize] = useState(prefs.tableSize)
  const [preflopOnly, setPreflopOnly] = useState(prefs.preflopOnly)
  const [started, setStarted] = useState(false)
  const [revealAll, setRevealAll] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth > 920)
  const [panelTab, setPanelTab] = useState<'feedback' | 'history'>('feedback')
  const pageElement = useRef<HTMLElement>(null)
  const [draftTableSize, setDraftTableSize] = useState(tableSize)
  const [draftPreflopOnly, setDraftPreflopOnly] = useState(preflopOnly)
  const eventView = useMemo(() => trainerTableEvents(snap, revealAll), [snap, revealAll])
  const visuals = useBattleVisuals(eventView, active && started)
  const allin = usePokerAudioEvents(eventView, active && started)
  const tensionKey = active && started ? battleTensionKey({ ...eventView, nextHandAt: null, runoutVote: null }) : null
  useEffect(() => { setBattleTensionMusic(tensionKey, 'trainer') }, [tensionKey])
  useEffect(() => () => { setBattleTensionMusic(null, 'trainer') }, [])
  const winningSeats = eventView.hand?.runResults?.flatMap(run => run.winners.map(id => eventView.hand!.players.find(player => player.id === id)!.seat!)) ?? []
  usePokerTableViewport(pageElement, active && started, `${started}:${panelOpen}:${!!snap.engine}:${!!snap.error}`)
  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 920px)')
    const changed = () => setPanelOpen(!narrow.matches)
    narrow.addEventListener('change', changed)
    return () => narrow.removeEventListener('change', changed)
  }, [])
  const [tally, setTally] = useState<Tally>({
    hands: 0,
    decisions: 0,
    evaluatedDecisions: 0,
    evDecisions: 0,
    optimal: 0,
    wrong: 0,
    evLossSum: 0,
    net: 0,
    netHands: 0,
  })
  useEffect(() => {
    return onHandRecord((r: HandRecord) => {
      const decisions = r.decisions.map(normalizeDecisionRecord)
      setTally((t) => ({
        hands: t.hands + 1,
        decisions: t.decisions + decisions.length,
        evaluatedDecisions: t.evaluatedDecisions + decisions.filter((d) => d.verdict !== 'unavailable').length,
        evDecisions: t.evDecisions + decisions.filter((d) => d.evLoss !== null).length,
        optimal: t.optimal + decisions.filter((d) => d.verdict === 'optimal').length,
        wrong: t.wrong + decisions.filter((d) => d.verdict === 'wrong').length,
        evLossSum: t.evLossSum + decisions.reduce((a, d) => a + (d.evLoss ?? 0), 0),
        net: t.net + (r.result.deltaBB ?? 0),
        netHands: t.netHands + (r.result.deltaBB !== null ? 1 : 0),
      }))
    })
  }, [])

  // 配置变化时记住
  useEffect(() => {
    savePrefs({ tableSize, preflopOnly })
  }, [tableSize, preflopOnly])

  const startTraining = useCallback(() => {
    setStarted(true)
    void trainerSession.startHand(tableSize, preflopOnly)
  }, [tableSize, preflopOnly])

  const exitTraining = useCallback(() => {
    trainerSession.stop()
    setRevealAll(false)
    setShowSettings(false)
    setStarted(false)
  }, [])

  // 新一手开始（结果清空）时自动关闭透视
  useEffect(() => {
    if (!snap.result) setRevealAll(false)
  }, [snap.result])

  const newHandClick = useCallback(() => {
    setRevealAll(false)
    void trainerSession.startHand(tableSize, preflopOnly)
  }, [tableSize, preflopOnly])

  // 键盘：数字选动作，回车开始/下一手，Esc 退出训练。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!active || e.defaultPrevented || e.isComposing || e.keyCode === 229 || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
      if (showSettings) return
      if (started && e.key === 'Escape') {
        e.preventDefault()
        exitTraining()
        return
      }
      if (e.target instanceof Element && e.target.closest('button, input, select, textarea, summary, a, [contenteditable="true"], dialog, [role="dialog"]')) return
      if (!started) {
        if (e.key === 'Enter') { e.preventDefault(); startTraining() }
        return
      }
      if (snap.phase === 'hero-turn') {
        const idx = parseInt(e.key, 10) - 1
        if (idx >= 0 && idx < snap.heroActions.length) trainerSession.heroAct(idx)
      } else if (snap.phase === 'hand-done' && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault()
        newHandClick()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, started, showSettings, startTraining, exitTraining, snap.phase, snap.heroActions.length, newHandClick])

  const openSettings = () => {
    setDraftTableSize(tableSize)
    setDraftPreflopOnly(preflopOnly)
    setShowSettings(true)
  }
  const applySettings = () => {
    setTableSize(draftTableSize)
    setPreflopOnly(draftPreflopOnly)
    setShowSettings(false)
    if (draftTableSize !== tableSize || draftPreflopOnly !== preflopOnly) {
      setRevealAll(false)
      void trainerSession.startHand(draftTableSize, draftPreflopOnly)
    }
  }

  const setupFields = (size: number, onlyPreflop: boolean, onSize: (size: number) => void, onMode: (onlyPreflop: boolean) => void) => <>
    <label className="battle-field">{t('牌桌人数', 'Players')}<select value={size} onChange={event => onSize(Number(event.target.value))}>{TABLE_SIZES.map(n => <option key={n} value={n}>{n}{t(' 人桌', ' players')}</option>)}</select></label>
    <PokerSettingSwitch className="trainer-setup-switch" checked={onlyPreflop} onChange={onMode}>{t('只练翻前', 'Preflop only')}</PokerSettingSwitch>
    <p className="battle-fine-print trainer-setup-note">{onlyPreflop
      ? t('每手到翻牌为止，只评估翻前决策，节奏最快。', 'Hands stop before the flop. Only preflop decisions are scored, for faster practice.')
      : size === 2
        ? t('单挑：翻前按预解策略，翻后每街现场 CFR 求解。', 'Heads-up: precomputed preflop strategies, then live CFR solving on each postflop street.')
        : t('翻前多人按预解策略；单挑进翻后时逐街求解，多人进翻后只评翻前。', 'Precomputed multiplayer preflop strategies. Heads-up postflop pots are solved street by street; multiway pots receive preflop feedback only.')}</p>
  </>

  if (!started) return <section className="battle-page trainer-page">
    <div className="battle-setup">
      <div className="battle-setup-intro"><span className="battle-setup-suit" aria-hidden="true">♠</span><h2>{t('开始训练', 'Start training')}</h2><p>{t('无限注德州扑克 · GTO 决策训练', 'No-limit Hold’em · GTO decision training')}</p></div>
      <form className="battle-setup-card" onSubmit={event => { event.preventDefault(); startTraining() }}>
        {setupFields(tableSize, preflopOnly, setTableSize, setPreflopOnly)}
        <button className="battle-button battle-button-gold battle-connect" type="submit">{t('开始训练', 'Start training')}</button>
      </form>
    </div>
  </section>

  return <section ref={pageElement} className="battle-page battle-in-room trainer-page">
    <header className="battle-room-header">
      <div className="battle-room-identity"><span className="battle-live-dot" aria-hidden="true" /><h2>{t('GTO 训练', 'GTO Training')}</h2><span className="battle-room-count">{tableSize}{t(' 人桌', ' players')}</span></div>
      <div className="battle-header-actions">
        <button type="button" className="battle-button battle-button-subtle" onClick={newHandClick}>↻ {t('换一手', 'New hand')}</button>
        <button type="button" className="battle-button battle-danger" onClick={exitTraining} title={t('返回训练设置；未完成的手牌不计入统计。', 'Return to setup; unfinished hands are not recorded.')}>{t('退出训练', 'Exit training')}</button>
        <button type="button" className="battle-more" aria-label={t('训练设置', 'Training settings')} onClick={openSettings}>•••</button>
      </div>
    </header>
    {snap.error && <div className="battle-error" role="alert">{trainerError(snap.error, language)}</div>}
    <div className={`battle-room-grid ${panelOpen ? 'battle-panel-open' : ''}`}>
      <div className="battle-main-column">
        {snap.engine ? <TableView engine={snap.engine} heroSeat={snap.heroSeat} toActSeat={snap.result ? -1 : snap.toActSeat} showdown={snap.result?.wentToShowdown} winningSeats={winningSeats} handNumber={tally.hands + (snap.result ? 0 : 1)} preflopOnly={preflopOnly} eventView={eventView} visuals={visuals}
          revealed={revealAll ? snap.engine.players.filter(player => player.seat !== snap.heroSeat).map(player => ({ seat: player.seat, cards: player.cards })) : []}
        >
          {allin && <PokerAllInEffect eventKey={allin.key} name={allin.ids.length > 1 ? t(`${allin.ids.length} 人全下`, `${allin.ids.length} players`) : allin.ids[0] === 'hero' ? t('你', 'You') : t(`电脑 ${Number(allin.ids[0].replace('seat-', '')) + 1}`, `Bot ${Number(allin.ids[0].replace('seat-', '')) + 1}`)} />}
        </TableView> : <div className="battle-table-panel trainer-table-loading"><span role="status">{snap.error ? t('训练暂停，可换一手重试。', 'Training paused. Try a new hand.') : t('正在加载翻前解…', 'Loading preflop solutions…')}</span></div>}
        <TrainerActions snap={snap} onAction={index => trainerSession.heroAct(index)} onNext={newHandClick} revealAll={revealAll} onReveal={() => setRevealAll(true)} onFeedback={() => { setPanelTab('feedback'); setPanelOpen(true) }} />
      </div>
      {panelOpen && <aside id="trainer-panel" className="battle-sidebar"><div className="battle-sidebar-panel">
        <div className="battle-sidebar-tabs" role="tablist" aria-label={t('训练面板', 'Training panels')}>{(['feedback', 'history'] as const).map(tab => <button type="button" role="tab" aria-selected={panelTab === tab} aria-controls={`trainer-${tab}`} id={`trainer-tab-${tab}`} key={tab} className={panelTab === tab ? 'selected' : ''} onClick={() => setPanelTab(tab)}>{tab === 'feedback' ? t('策略反馈', 'Strategy') : t('记录', 'Records')}</button>)}<button type="button" className="battle-panel-close" aria-label={t('收起面板', 'Collapse panel')} onClick={() => setPanelOpen(false)}>×</button></div>
        <div className="battle-sidebar-content" role="tabpanel" id={`trainer-${panelTab}`} aria-labelledby={`trainer-tab-${panelTab}`}><TrainerFeedback snap={snap} tab={panelTab} /></div>
      </div></aside>}
    </div>
    <div className="trainer-session-stats" data-poker-chrome aria-label={t('本次训练统计', 'Session statistics')}>
      <span>{t('已练', 'Hands')} <b>{tally.hands}</b></span><span title={t(`${tally.evaluatedDecisions} / ${tally.decisions} 次决策有策略评估`, `${tally.evaluatedDecisions} / ${tally.decisions} decisions have strategy feedback`)}>{t('最优率', 'Optimal')} <b>{tally.evaluatedDecisions ? `${Math.round(tally.optimal / tally.evaluatedDecisions * 100)}%` : '—'}</b></span><span title={t(`${tally.evDecisions} 次决策有 EV 数据`, `${tally.evDecisions} decisions have EV data`)}>{t('平均 EV 损失', 'Avg. EV loss')} <b>{tally.evDecisions ? `${(tally.evLossSum / tally.evDecisions).toFixed(2)} BB` : '—'}</b></span><span>{t('盈亏', 'Net')} <b className={tally.net >= 0 ? 'battle-positive' : 'battle-negative'}>{tally.net >= 0 ? '+' : ''}{tally.net.toFixed(1)} BB</b><small> · {tally.netHands}{t(' 手结算', ' settled')}</small></span>
    </div>
    {!panelOpen && <nav className="battle-panel-bar" aria-label={t('打开训练面板', 'Open training panel')}>{(['feedback', 'history'] as const).map(tab => <button type="button" key={tab} aria-controls="trainer-panel" aria-expanded={false} onClick={() => { setPanelTab(tab); setPanelOpen(true) }}>{tab === 'feedback' ? t('策略反馈', 'Strategy') : t('记录', 'Records')}<span aria-hidden="true">⌃</span></button>)}</nav>}
    {showSettings && <PokerDialog title={t('训练设置', 'Training settings')} onClose={() => setShowSettings(false)}>
      {setupFields(draftTableSize, draftPreflopOnly, setDraftTableSize, setDraftPreflopOnly)}
      <p className="battle-fine-print">{t('修改配置后会开始新的一手，未完成的手牌不计入统计。', 'Changing the setup starts a new hand. Unfinished hands are not recorded.')}</p>
      <div className="battle-dialog-buttons"><button type="button" className="battle-button battle-button-subtle" onClick={() => setShowSettings(false)}>{t('取消', 'Cancel')}</button><button type="button" className="battle-button battle-button-gold" onClick={applySettings}>{t('应用设置', 'Apply settings')}</button></div>
    </PokerDialog>}
  </section>
}
