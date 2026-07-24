import { useEffect, useState } from 'react'
import { saveHand, requestPersistence } from './db/handStore'
import { onHandRecord } from './game/session'
import { EquityCalc } from './components/EquityCalc'
import { RangeViewer } from './components/RangeViewer'
import { SolverExplorer } from './components/SolverExplorer'
import { StatsDashboard } from './components/StatsDashboard'
import { Trainer } from './components/Trainer'

const TABS = [
  { id: 'trainer', label: '训练器' },
  { id: 'solver', label: '求解器' },
  { id: 'ranges', label: '范围表' },
  { id: 'equity', label: '权益计算' },
  { id: 'stats', label: '数据统计' },
] as const

type TabId = (typeof TABS)[number]['id']

export default function App() {
  const [tab, setTab] = useState<TabId>('trainer')

  useEffect(() => {
    requestPersistence()
    return onHandRecord((r) => {
      void saveHand(r)
    })
  }, [])

  return (
    <div className="app">
      <header className="app-header">
        <h1>
          <span className="logo-suit">♠</span> GTO 德州扑克训练器
        </h1>
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`tab ${tab === t.id ? 'tab-active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="app-main">
        {/* 全部保持挂载，切 tab 不丢状态 */}
        <div style={{ display: tab === 'trainer' ? undefined : 'none' }}>
          <Trainer active={tab === 'trainer'} />
        </div>
        <div style={{ display: tab === 'solver' ? undefined : 'none' }}>
          <SolverExplorer active={tab === 'solver'} />
        </div>
        <div style={{ display: tab === 'ranges' ? undefined : 'none' }}>
          <RangeViewer />
        </div>
        <div style={{ display: tab === 'equity' ? undefined : 'none' }}>
          <EquityCalc />
        </div>
        <div style={{ display: tab === 'stats' ? undefined : 'none' }}>
          <StatsDashboard active={tab === 'stats'} />
        </div>
      </main>
      <footer className="app-footer">
        双层 CFR 求解：翻前 169 手牌抽象 + 权益实现模型（2-9 人桌预解）；翻后单挑逐街 CFR+。
        近似解，仅供学习参考。
      </footer>
    </div>
  )
}
