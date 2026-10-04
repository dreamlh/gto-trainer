import { useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { Card } from '../poker/cards'
import type { EngineState } from '../game/engine'
import { pot } from '../game/engine'
import { trainerHistoryActions } from '../game/trainerPresentation'
import { actionName } from '../poker/presentation'
import { playerShowdownLabel } from '../battle/presentation'
import { winningCards } from '../battle/winningCards'
import type { PokerTableEventView } from '../poker/tableEvents'
import type { useBattleVisuals } from './useBattleVisuals'
import { PokerPayoutEffect } from './PokerPayoutEffect'
import '../battle/effects.css'
import '../battle/winning-cards.css'
import { useLanguage } from '../battle/i18n'
import { CardFace } from './CardFace'
import { PokerHoleCard } from './PokerHoleCard'
import { PokerSeatContent } from './PokerSeatContent'
import { holeCardOrder } from '../poker/holeCardOrder'
import { tableSeatLayout } from '../poker/tableLayout'
import { useBattleChipLayout } from './useBattleChipLayout'
import '../battle/battle.css'
import './trainer-table.css'

export interface TableViewProps {
  engine: EngineState
  eventView: PokerTableEventView
  visuals: ReturnType<typeof useBattleVisuals>
  heroSeat: number
  toActSeat: number
  revealed?: { seat: number; cards: [Card, Card] }[]
  showdown?: boolean
  winningSeats?: readonly number[]
  handNumber?: number
  preflopOnly?: boolean
  children?: ReactNode
}

const STREET_LABELS: Record<string, [string, string]> = {
  preflop: ['翻前', 'Preflop'], flop: ['翻牌', 'Flop'], turn: ['转牌', 'Turn'], river: ['河牌', 'River'],
}
const chips = (value: number) => Number(value.toFixed(1)).toLocaleString('en-GB')
/** The same table skin and chip lanes as Private Table, fed by the trainer engine. */
export function TableView({ engine, heroSeat, toActSeat, revealed = [], showdown, winningSeats = [], handNumber = 1, preflopOnly = false, eventView, visuals, children }: TableViewProps) {
  const { language, t } = useLanguage()
  const table = useRef<HTMLDivElement>(null)
  const id = eventView.hand!.number
  const handKey = `trainer:${id}`
  const [focusedWinner, setFocusedWinner] = useState<string | null>(null)
  const winning = winningCards(eventView)
  const highlightedHand = winning.hands.find(hand => hand.playerId === focusedWinner) ?? winning.hands[0]
  const highlightedCards = new Set(highlightedHand?.cards ?? [])
  useBattleChipLayout(table, `${id}:${engine.history.length}:${engine.street}:${revealed.length}:${winningSeats.join(',')}`)
  const n = engine.n
  const btnSeat = n === 2 ? 0 : engine.positions.indexOf('BTN')
  const revealedMap = new Map(revealed.map(player => [player.seat, player.cards]))
  const totalPot = pot(engine)
  const lastActions = new Map(trainerHistoryActions(engine).filter(action => action.street === engine.street).map(action => [action.seat, action]))
  return <section className="battle-table-panel tt-table" aria-label={t('训练牌桌', 'Training table')}>
    <header className="battle-hand-meta">
      <span>{t(`第 ${handNumber} 手`, `Hand ${handNumber}`)}<i />{t(...STREET_LABELS[engine.street])}{showdown ? t(' · 摊牌', ' · Showdown') : ''}</span>
      <span>{n}{t(' 人桌', ' players')}</span>
    </header>
    <div ref={table} className={`battle-table${n > 6 ? ' battle-table-full' : ''}${winningSeats.length ? ' tt-settled' : ''}`} data-players={n} key={id}>
      <div className="battle-felt" aria-hidden="true" />
      {children}
      <div className="battle-table-center">
        <div className="battle-pot"><span>{t('底池', 'Pot')}</span><strong><span className={visuals?.potValues.has(totalPot) ? 'battle-pot-motion' : undefined} key={`${id}:${totalPot}`}>{chips(totalPot)}</span> <small>BB</small></strong></div>
        <div className={`battle-board ${highlightedHand ? 'has-winning-hand' : ''}`} aria-label={t('公共牌', 'Board')}>
          {Array.from({ length: 5 }, (_, index) => engine.board[index] !== undefined
            ? <span className={`battle-board-motion ${highlightedCards.has(engine.board[index]) ? 'is-winning-card' : ''} ${visuals?.boardKeys.has(`0:${index}:${engine.board[index]}`) ? 'is-revealed' : ''}`} key={`${id}:${index}:${engine.board[index]}`} style={{ '--board-delay': `${index < 3 ? index * 65 : 0}ms` } as CSSProperties}><CardFace card={engine.board[index]} size="lg" /></span>
            : <span className="battle-board-empty" aria-hidden="true" key={`empty-${index}`} />)}
        </div>
      </div>
      <PokerPayoutEffect capacity={n} viewOrigin={heroSeat} players={eventView.hand!.players} award={visuals?.award ?? null} />
      {engine.players.map(player => {
        const relative = (player.seat - heroSeat + n) % n
        const layout = tableSeatLayout(n, relative)
        const { angle } = layout
        const isHero = player.seat === heroSeat
        const winner = winningSeats.includes(player.seat)
        const acting = player.seat === toActSeat && !player.folded && !player.allin
        const cards = isHero ? player.cards : revealedMap.get(player.seat)
        const streetBet = player.invested - player.streetBase
        const position = n === 2 && player.seat === btnSeat ? 'BTN / SB' : engine.positions[player.seat].replace(/^UTG(\d)$/, 'UTG+$1')
        const name = isHero ? t('你', 'You') : t(`电脑 ${player.seat + 1}`, `Bot ${player.seat + 1}`)
        const lastAction = lastActions.get(player.seat)
        const actionLabel = lastAction ? `${lastAction.allin ? lastAction.kind === 'call' ? t('全下跟注', 'Call all-in') : t('全下', 'All-in') : actionName(lastAction.kind, language)}${lastAction.amount !== null ? ` ${chips(lastAction.amount)}` : ''}` : ''
        const eventPlayer = eventView.hand!.players.find(member => member.seat === player.seat)!
        const handRank = playerShowdownLabel(eventView.hand, eventPlayer.id, showdown ? engine.board : null, t)
        const status = handRank ?? (player.folded ? t('已弃牌', 'Folded') : acting ? t('行动中', 'Acting') : actionLabel || (player.allin ? t('全下', 'All-in') : t('游戏中', 'In hand')))
        const actionMotion = visuals?.actions[eventPlayer.id]
        const settled = eventView.hand!.finished && eventView.hand!.delta !== null
        const wager = settled ? eventView.hand!.delta?.[eventPlayer.id] : streetBet
        const showWager = wager !== undefined && (settled ? wager !== 0 : wager > .01)
        const dealOrder = (player.seat - btnSeat - 1 + n) % n
        const style = { '--seat-x': `${layout.x}%`, '--seat-y': `${layout.y}%`, '--bet-x': `${layout.betX}%`, '--bet-y': `${layout.betY}%`, '--bet-from-x': `${Math.cos(angle) * 24}px`, '--bet-from-y': `${Math.sin(angle) * 24}px` } as CSSProperties
        return <div key={player.seat}>
          <div className={`battle-seat${isHero ? ' battle-seat-self' : ''}${player.folded ? ' battle-seat-folded' : ''}${acting ? ' battle-seat-acting' : ''}${winner ? ' battle-seat-winner' : ''}`} style={style} data-seat={player.seat + 1} onMouseEnter={() => setFocusedWinner(winner ? eventPlayer.id : null)} onMouseLeave={() => setFocusedWinner(null)} aria-label={`${name}, ${position}, ${chips(eventPlayer.stack)} BB, ${status}`}>
            <div className="battle-seat-target">
              <PokerSeatContent name={name} stack={chips(Math.max(0, eventPlayer.stack))} position={position} dealer={player.seat === btnSeat} winnerLabel={winner ? t('获胜', 'WIN') : undefined}
                cardsClassName={player.folded && !settled ? 'battle-cards-folded' : ''}
                cards={holeCardOrder(cards).map((index, displayIndex) => <span className={`battle-hole-motion ${visuals?.deal ? 'is-dealt' : ''}`} key={`${handKey}:${player.seat}:${index}`} style={{
                  '--deal-delay': `${(dealOrder + index * n) * 24}ms`,
                  '--deal-x': `${-Math.cos(angle) * 70}px`, '--deal-y': `${-Math.sin(angle) * 48}px`,
                } as CSSProperties}>
                  <PokerHoleCard card={cards?.[index] ?? null} index={displayIndex} publiclyShown={!!cards && !isHero} winning={highlightedHand?.playerId === eventPlayer.id && cards?.[index] != null && highlightedCards.has(cards[index])} back={<span className="battle-card-back" aria-label={t('未公开的底牌', 'Hidden hole card')}>♠</span>} />
                </span>)}
                statusClassName={`${acting ? 'is-acting' : ''} ${handRank ? 'is-hand-rank' : ''}`} statusTitle={status}
                status={<span className={actionMotion && !acting ? 'battle-action-motion' : undefined} data-kind={actionMotion?.kind} key={acting ? 'acting' : actionMotion?.key ?? 'status'}>{status}</span>}
              />
            </div>
          </div>
          {showWager && <span className={`battle-seat-bet ${settled ? wager! > 0 ? 'battle-positive' : 'battle-negative' : ''}`} style={style} data-seat={player.seat + 1} aria-label={`${name}: ${chips(wager!)} BB`}>
            <span key={`${handKey}:${engine.street}:${settled ? 'result' : wager}`} className={!settled && visuals?.betKeys.has(`${eventPlayer.id}:${engine.street}:${streetBet}`) ? 'battle-bet-motion' : undefined}><i className="battle-chip-icon" aria-hidden="true" />{settled && wager! > 0 ? '+' : ''}{chips(wager!)}</span>
          </span>}
        </div>
      })}
    </div>
    <footer className="battle-table-footer"><span className="battle-my-seat">{t('你的座位', 'Your seat')} · {engine.positions[heroSeat]}</span><span className="battle-table-format">{preflopOnly ? t('只练翻前', 'Preflop only') : t('全牌局', 'Full hands')} · {t('不限时', 'Unlimited')}</span></footer>
  </section>
}
