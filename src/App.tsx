import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { saveHand, requestPersistence } from './db/handStore'
import { onHandRecord } from './game/session'
import { EquityCalc } from './components/EquityCalc'
import { RangeViewer } from './components/RangeViewer'
import { SolverExplorer } from './components/SolverExplorer'
import { StatsDashboard } from './components/StatsDashboard'
import { Trainer } from './components/Trainer'
import { Battle } from './components/Battle'
import { useLanguage } from './battle/i18n'
import { GlobalAudio, BattleTurnNotice } from './components/GlobalAudio'
import type { RoomView } from './battle/types'
import { battleTurnState, type BattleTurnState } from './battle/audioEvents'
import type { AnalysisContext, OpenAnalysis } from './analysis/types'
import './theme.css'
import './components/app-header.css'
import './components/range-viewer.css'
import './components/analysis.css'

const TABS = [
  { id: 'trainer', label: '训练器', en: 'Trainer' },
  { id: 'solver', label: '求解器', en: 'Solver' },
  { id: 'ranges', label: '范围表', en: 'Ranges' },
  { id: 'equity', label: '权益计算', en: 'Equity' },
  { id: 'stats', label: '数据统计', en: 'Statistics' },
  { id: 'battle', label: '好友对战', en: 'Private Table' },
] as const

type TabId = (typeof TABS)[number]['id']
const COMPACT_NAV_HEIGHT = 740
const viewportHeight = () => Math.floor(Math.min(window.innerHeight, window.visualViewport?.height ?? window.innerHeight))

export default function App() {
  const { language, setLanguage, t } = useLanguage()
  const [battleTurn, setBattleTurn] = useState<BattleTurnState | null>(null)
  const [equityContext, setEquityContext] = useState<AnalysisContext | null>(null)
  const [solverContext, setSolverContext] = useState<AnalysisContext | null>(null)
  const onBattleRoomUpdate = useCallback((room: RoomView | null) => setBattleTurn(battleTurnState(room)), [])
  const [tab, setTab] = useState<TabId>(() => {
    const query = new URLSearchParams(window.location.search)
    return query.has('room') || query.get('battle') === '1' ? 'battle' : 'trainer'
  })
  const [availableHeight, setAvailableHeight] = useState(viewportHeight)
  const compactNavigation = availableHeight <= COMPACT_NAV_HEIGHT
  const [navigationOpen, setNavigationOpen] = useState(false)
  const navigationContainer = useRef<HTMLDivElement>(null)
  const navigation = useRef<HTMLElement>(null)
  const navigationTrigger = useRef<HTMLButtonElement>(null)
  const restoreNavigationFocus = useRef<'trigger' | 'current' | null>(null)
  const navigationId = useId()
  const currentPage = TABS.find(page => page.id === tab)!

  useEffect(() => {
    const resize = () => {
      const height = viewportHeight()
      if (height <= COMPACT_NAV_HEIGHT && navigation.current?.contains(document.activeElement)) restoreNavigationFocus.current = 'trigger'
      else if (height > COMPACT_NAV_HEIGHT && document.activeElement === navigationTrigger.current) restoreNavigationFocus.current = 'current'
      setAvailableHeight(height)
    }
    window.addEventListener('resize', resize)
    window.visualViewport?.addEventListener('resize', resize)
    return () => { window.removeEventListener('resize', resize); window.visualViewport?.removeEventListener('resize', resize) }
  }, [])

  useEffect(() => {
    setNavigationOpen(false)
    if (compactNavigation && restoreNavigationFocus.current === 'trigger') navigationTrigger.current?.focus()
    else if (!compactNavigation && restoreNavigationFocus.current === 'current') navigation.current?.querySelector<HTMLButtonElement>('[aria-current="page"]')?.focus()
    restoreNavigationFocus.current = null
  }, [compactNavigation])

  useEffect(() => {
    if (!compactNavigation || !navigationOpen) return
    navigation.current?.querySelector<HTMLButtonElement>('[aria-current="page"]')?.focus()
    const outside = (event: Event) => {
      if (!navigationContainer.current?.contains(event.target as Node)) setNavigationOpen(false)
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); setNavigationOpen(false); navigationTrigger.current?.focus()
      } else if (navigation.current?.contains(event.target as Node) && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        const buttons = [...navigation.current.querySelectorAll<HTMLButtonElement>('button')]
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        buttons[next]?.focus()
      }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    document.addEventListener('keydown', keydown)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
      document.removeEventListener('keydown', keydown)
    }
  }, [compactNavigation, navigationOpen])

  const selectPage = (id: TabId) => {
    setTab(id)
    if (compactNavigation) { setNavigationOpen(false); navigationTrigger.current?.focus() }
  }
  const openAnalysis: OpenAnalysis = (target, context) => {
    const imported = { ...context, id: `${context.id}:${Date.now()}` }
    if (target === 'equity') setEquityContext(imported)
    else setSolverContext(imported)
    selectPage(target)
  }

  useEffect(() => {
    requestPersistence()
    return onHandRecord((r) => {
      void saveHand(r)
    })
  }, [])

  return (
    <div className={`app ${tab === 'battle' ? 'app-battle' : tab === 'trainer' ? 'app-trainer' : ''} ${compactNavigation ? 'app-nav-compact' : ''}`} data-page={tab} style={{ '--app-viewport-height': `${availableHeight}px` } as CSSProperties}>
      <header className="app-header">
        <h1 className="app-brand"><span className="logo-suit" aria-hidden="true">♠</span><span className="app-brand-label">{t('GTO 德州扑克', 'GTO Hold’em')}</span></h1>
        <div className="app-navigation" ref={navigationContainer}>
          <button className="app-navigation-trigger" type="button" ref={navigationTrigger}
            aria-expanded={navigationOpen} aria-controls={navigationId}
            aria-label={navigationOpen ? t(`收起导航，当前页面：${currentPage.label}`, `Close navigation, current page: ${currentPage.en}`) : t(`打开导航，当前页面：${currentPage.label}`, `Open navigation, current page: ${currentPage.en}`)}
            onClick={() => setNavigationOpen(open => !open)}
            onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setNavigationOpen(true) } }}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            <span>{language === 'zh' ? currentPage.label : currentPage.en}</span>
            <svg className="app-navigation-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          <nav id={navigationId} ref={navigation} className="tabs" hidden={compactNavigation && !navigationOpen} aria-label={t('主要页面', 'Main navigation')}>
            {TABS.map((page) => (
              <button
                key={page.id}
                type="button"
                className={`tab ${page.id === 'battle' ? 'tab-battle' : ''} ${tab === page.id ? 'tab-active' : ''}`}
                aria-current={tab === page.id ? 'page' : undefined}
                onClick={() => selectPage(page.id)}
              >
                {language === 'zh' ? page.label : page.en}
              </button>
            ))}
          </nav>
        </div>
        <div className="app-header-utilities">
          <div className="app-language-switch" role="group" aria-label={t('语言', 'Language')}>
            <button type="button" lang="zh" onClick={() => setLanguage('zh')} aria-pressed={language === 'zh'}>中文</button>
            <button type="button" lang="en" aria-label="English" title="English" onClick={() => setLanguage('en')} aria-pressed={language === 'en'}>EN</button>
          </div>
          <GlobalAudio />
        </div>
        {tab !== 'battle' && <BattleTurnNotice turn={battleTurn} onReturn={() => setTab('battle')} />}
      </header>
      <main className="app-main">
        {/* 全部保持挂载，切 tab 不丢状态 */}
        <div style={{ display: tab === 'trainer' ? undefined : 'none' }}>
          <Trainer active={tab === 'trainer'} />
        </div>
        <div style={{ display: tab === 'battle' ? undefined : 'none' }}>
          <Battle active={tab === 'battle'} onRoomUpdate={onBattleRoomUpdate} onOpenAnalysis={openAnalysis} />
        </div>
        <div style={{ display: tab === 'solver' ? undefined : 'none' }}>
          <SolverExplorer active={tab === 'solver'} context={solverContext} />
        </div>
        <div style={{ display: tab === 'ranges' ? undefined : 'none' }}>
          <RangeViewer />
        </div>
        <div style={{ display: tab === 'equity' ? undefined : 'none' }}>
          <EquityCalc context={equityContext} />
        </div>
        <div style={{ display: tab === 'stats' ? undefined : 'none' }}>
          <StatsDashboard active={tab === 'stats'} onOpenAnalysis={openAnalysis} />
        </div>
      </main>
      {['trainer', 'solver', 'ranges', 'equity'].includes(tab) && <footer className="app-footer">
        <details className="app-model-note"><summary>{t('计算模型说明', 'About the models')}</summary>
          <p>{t('双层 CFR 求解：翻前 169 手牌抽象 + 权益实现模型（2–9 人桌预解）；翻后单挑逐街 CFR+。近似解，仅供学习参考。',
            'Two-stage CFR: preflop 169-hand abstraction and equity-realization model (2–9 seats); heads-up postflop CFR+. Approximate solutions for study.')}</p>
        </details>
      </footer>}
    </div>
  )
}
